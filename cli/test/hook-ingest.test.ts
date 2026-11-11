import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_RUNTIME_TEXT_LIMIT,
  normalizeNativeHookEvent,
  type AgentRuntimeAdapterId,
  type AgentRuntimeEventV1,
} from "../../packages/core/src/index.js";
import { ingestAgentHook } from "../src/hook-ingest.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "crewvane-hook-ingest-"));
  roots.push(value);
  return value;
}

function environment(workspace: string): NodeJS.ProcessEnv {
  return {
    CREWVANE_GOAL_ID: "goal_hook",
    CREWVANE_ATTEMPT_ID: "attempt_hook",
    CREWVANE_HOOK_TOKEN: "token",
    CREWVANE_AGENT_NAME: "owner-a",
    CREWVANE_WORKSPACE: workspace,
    CREWVANE_HOOK_SPOOL: join(workspace, ".crewvane", "runtime", "spool"),
  };
}

test("official lifecycle fixtures normalize for Codex, Claude Code, Cursor, Qoder and OMP", () => {
  const cases: {
    adapter: AgentRuntimeAdapterId;
    input: Record<string, unknown>;
    types: string[];
    turnId?: string;
  }[] = [
    {
      adapter: "codex",
      input: {
        hook_event_name: "Stop",
        turn_id: "codex-turn",
        last_assistant_message: "Codex result",
        tool_input: { secret: "not persisted" },
        tool_response: "not persisted",
      },
      types: ["agent.response", "turn.settled"],
      turnId: "codex-turn",
    },
    {
      adapter: "claude-code",
      input: {
        hook_event_name: "Notification",
        hook_event_source: "permission",
        notification_type: "permission_request",
        message: "Approve command",
        tool_input: { secret: "not persisted" },
      },
      types: ["agent.blocked"],
    },
    {
      adapter: "cursor",
      input: {
        hook_event_name: "afterAgentResponse",
        generation_id: "cursor-turn",
        text: "Cursor result",
        tool_output: "not persisted",
      },
      types: ["agent.response"],
      turnId: "cursor-turn",
    },
    {
      adapter: "qoder",
      input: {
        hook_event_name: "UserPromptSubmit",
        prompt: "Qoder task",
        tool_args: ["not persisted"],
      },
      types: ["turn.started"],
    },
    {
      adapter: "omp",
      input: {
        hook_event_name: "TurnStart",
        session_id: "session-a",
        turn_index: 2,
        prompt: "OMP task",
        tool_results: ["not persisted"],
      },
      types: ["turn.started"],
      turnId: "session-a:2",
    },
  ];
  for (const fixture of cases) {
    const normalized = normalizeNativeHookEvent(fixture.adapter, fixture.input);
    assert.deepEqual(normalized.map(event => event.type), fixture.types);
    if (fixture.turnId)
      assert.equal(normalized[0]?.turnId, fixture.turnId);
    assert.equal(JSON.stringify(normalized).includes("not persisted"), false);
  }
});

test("a managed prompt without a native turn ID receives a stable turn fallback", async () => {
  const workspace = await root();
  let captured: AgentRuntimeEventV1[] = [];
  const result = await ingestAgentHook({
    adapter: "claude-code",
    environment: environment(workspace),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "实现即时事件",
    }),
    send: async events => {
      captured = events;
      return true;
    },
  });
  assert.deepEqual(result, { accepted: true });
  assert.equal(captured[0]?.type, "turn.started");
  assert.match(captured[0]?.turnId ?? "", /^turn-\d+$/);
  assert.equal(captured[0]?.content?.text, "实现即时事件");
});

test("identical native payloads on repeated turns receive distinct event IDs", async () => {
  const workspace = await root();
  const captured: AgentRuntimeEventV1[][] = [];
  for (let run = 0; run < 2; run += 1) {
    await ingestAgentHook({
      adapter: "claude-code",
      environment: environment(workspace),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      stdin: async () => JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        prompt: "继续检查",
      }),
      send: async events => {
        captured.push(events);
        return true;
      },
    });
  }
  assert.notEqual(captured[0]![0]!.eventId, captured[1]![0]!.eventId);
  assert.equal(captured[0]![0]!.sequence, 1);
  assert.equal(captured[1]![0]!.sequence, 2);
});

test("OMP response capture ignores tool-result messages", () => {
  const [normalized] = normalizeNativeHookEvent("omp", {
    hook_event_name: "AgentEnd",
    session_id: "session-a",
    turn_index: 1,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "这是可见回复" }],
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "private tool output" }],
      },
    ],
  });
  assert.equal(normalized?.text?.text, "这是可见回复");
  assert.equal(JSON.stringify(normalized).includes("private tool output"), false);
});

test("events outside a managed Crewvane target are a no-op", async () => {
  const workspace = await root();
  let called = false;
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: { CREWVANE_WORKSPACE: workspace },
    stdin: async () => JSON.stringify({
      hook_event_name: "Stop",
      turn_id: "turn",
    }),
    send: async () => {
      called = true;
      return true;
    },
  });
  assert.deepEqual(result, { accepted: false, reason: "not_managed" });
  assert.equal(called, false);
});

test("socket failures and thrown transports spool the exact token and events", async () => {
  const workspace = await root();
  let spooled: { events: AgentRuntimeEventV1[]; token: string } | undefined;
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => JSON.stringify({
      hook_event_name: "Stop",
      turn_id: "turn-1",
      last_assistant_message: "完成",
    }),
    send: async () => {
      throw new Error("app offline");
    },
    spool: async (events, token) => {
      spooled = { events, token };
      return "spooled";
    },
  });
  assert.deepEqual(result, { accepted: true, reason: "spooled" });
  assert.equal(spooled?.token, "token");
  assert.deepEqual(spooled?.events.map(event => event.type), [
    "agent.response",
    "turn.settled",
  ]);
});

test("text is bounded to 12,000 Unicode characters with the original SHA-256", async () => {
  const workspace = await root(), prompt = "🧭".repeat(AGENT_RUNTIME_TEXT_LIMIT + 5);
  let captured: AgentRuntimeEventV1[] = [];
  const result = await ingestAgentHook({
    adapter: "qoder",
    environment: environment(workspace),
    stdin: async () => JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt,
      tool_input: { private: "not persisted" },
      tool_output: "not persisted",
    }),
    send: async events => {
      captured = events;
      return true;
    },
  });
  assert.equal(result.accepted, true);
  const content = captured[0]!.content!;
  assert.equal(Array.from(content.text).length, AGENT_RUNTIME_TEXT_LIMIT);
  assert.equal(content.truncated, true);
  assert.equal(
    content.sha256,
    createHash("sha256").update(prompt).digest("hex"),
  );
  assert.equal(JSON.stringify(captured).includes("not persisted"), false);
});

test("default spool files are private and readable as a complete offline event", async () => {
  const workspace = await root(), env = environment(workspace);
  const result = await ingestAgentHook({
    adapter: "codex",
    environment: env,
    stdin: async () => JSON.stringify({
      hook_event_name: "SessionStart",
    }),
    send: async () => false,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "spooled");
  const spool = env.CREWVANE_HOOK_SPOOL!;
  const info = await stat(spool);
  assert.equal(info.mode & 0o777, 0o700);
  const { readdir } = await import("node:fs/promises");
  const [name] = (await readdir(spool)).filter(value => value.endsWith(".json"));
  assert.ok(name);
  const payload = JSON.parse(await readFile(join(spool, name), "utf8"));
  assert.equal(payload[0].token, "token");
  assert.equal(payload[0].events[0].type, "session.started");
  assert.equal((await stat(join(spool, name))).mode & 0o777, 0o600);
});

test("malformed input and unavailable stdin fail open without throwing", async () => {
  const workspace = await root();
  assert.deepEqual(await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => "{",
  }), { accepted: false, reason: "invalid_json" });
  assert.deepEqual(await ingestAgentHook({
    adapter: "codex",
    environment: environment(workspace),
    stdin: async () => {
      throw new Error("stdin closed");
    },
  }), { accepted: false, reason: "stdin_unavailable" });
});

test("informational notifications do not manufacture a blocked Agent", () => {
  for (const adapter of ["claude-code", "qoder"] as const)
    for (const notification_type of ["auth_success", "idle_prompt", "elicitation_complete"])
      assert.deepEqual(normalizeNativeHookEvent(adapter, {
        hook_event_name: "Notification", notification_type,
      }), []);
});
