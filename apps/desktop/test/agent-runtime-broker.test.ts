import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spoolAgentRuntimeEvents,
  agentReceiptMarker,
  WorkspaceService,
  type AgentRuntimeEventV1,
  type Goal,
} from "../../../packages/core/src/index.js";
import { AgentRuntimeBroker } from "../electron/agent-runtime-broker.js";
import { ingestAgentHook } from "../../../cli/src/hook-ingest.js";
import { AgentHookManager } from "../electron/agent-hook-manager.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

const token = "runtime-secret", hash = createHash("sha256").update(token).digest("hex");

async function fixture(base = Date.now()) {
  const root = await mkdtemp(join(tmpdir(), "crewvane-runtime-broker-"));
  roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "回执目标",
      description: "验证 Stop 回执和恢复。",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "session.set",
    goalId: goal.id,
    reference: {
      session: "crewvane-test",
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:p2",
      agent: "owner-a",
    },
  });
  await service.execute({
    type: "agent.runtime.register",
    goalId: goal.id,
    attempt: {
      goalId: goal.id,
      attemptId: "attempt_broker",
      agent: "owner-a",
      adapter: "codex",
      startedAt: new Date(base).toISOString(),
    },
    hookTokenHash: hash,
    capabilities: [
      "session.started",
      "turn.started",
      "turn.settled",
      "agent.response",
    ],
  });
  return { root, service, goalId: goal.id };
}

function event(
  goalId: string,
  sequence: number,
  type: AgentRuntimeEventV1["type"],
  body: Partial<AgentRuntimeEventV1> = {},
): AgentRuntimeEventV1 {
  return {
    version: "v1",
    eventId: `event-${sequence}`,
    sequence,
    at: new Date(Date.now() + sequence * 100).toISOString(),
    source: "hook",
    agent: "owner-a",
    adapter: "codex",
    goalId,
    attemptId: "attempt_broker",
    type,
    ...body,
  };
}

function fakeTimers() {
  let now = Date.now();
  const scheduled: {
    callback: () => void;
    delay: number;
    fired: boolean;
    cleared: boolean;
    handle: any;
  }[] = [];
  const setTimer = (callback: () => void, delay: number) => {
    const entry: any = { callback, delay, fired: false, cleared: false };
    entry.handle = {
      unref() {},
      entry,
    };
    scheduled.push(entry);
    return entry.handle as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (handle: ReturnType<typeof setTimeout>) => {
    (handle as any).entry.cleared = true;
  };
  return {
    setTimer,
    clearTimer,
    scheduled,
    get now() { return now; },
    setNow(value: number) { now = value; },
    async fireFirstOpen() {
      const timer = scheduled.find(item => !item.fired && !item.cleared);
      assert.ok(timer, `expected a live timer; ${JSON.stringify(scheduled.map(item => ({
        delay: item.delay,
        fired: item.fired,
        cleared: item.cleared,
      })))}`);
      timer.fired = true;
      now += timer.delay;
      timer.callback();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

async function eventually(assertion: () => void | Promise<void>) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await assertion();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await assertion();
}

test("a settled turn reminds once, then hands protocol_missing to the concierge", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const clock = fakeTimers();
  clock.setNow(base);
  const reminders: string[] = [], concierge: string[] = [];
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 1, "turn.started", {
      at: new Date(base + 100).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 2, "turn.settled", {
      at: new Date(base + 200).toISOString(),
      turnId: "turn-1",
    }),
  });
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async (_goal, prompt) => { reminders.push(prompt); },
    notifyConcierge: async (_goal, detail) => { concierge.push(detail); },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await broker.recover();
  assert.equal(clock.scheduled.filter(item => !item.cleared).length, 1);
  assert.equal(clock.scheduled[0]!.delay, 5_200);

  await clock.fireFirstOpen();
  await eventually(async () => {
    const state = (await service.read()).goals[0]!;
    assert.equal(state.agentRuntime?.receipt?.status, "reminded");
  });
  assert.equal(reminders.length, 1);
  assert.match(reminders[0]!, /crewvane goal progress/);
  assert.match(reminders[0]!, /每个回合最多一次/);
  assert.equal(clock.scheduled.filter(item => !item.cleared && !item.fired).length, 1);
  assert.equal(clock.scheduled.at(-1)?.delay, 30_000);

  await clock.fireFirstOpen();
  await eventually(async () => {
    assert.equal(
      (await service.read()).goals[0]!.agentRuntime?.receipt?.status,
      "protocol_missing",
    );
  });
  let state = (await service.read()).goals[0]!;
  assert.equal(state.agentRuntime?.receipt?.status, "protocol_missing");
  assert.equal(state.status, "active");
  assert.equal(state.attention, null);
  assert.equal(concierge.length, 1);
  assert.equal(state.watchdog?.attemptedAt !== undefined, true);
  await broker.stop();
});

test("semantic progress cancels a pending reminder and a new turn clears the old timer", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const clock = fakeTimers();
  clock.setNow(base);
  let reminders = 0;
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => { reminders += 1; },
    notifyConcierge: async () => {},
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 1, "turn.started", {
      at: new Date(base + 100).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 2, "turn.settled", {
      at: new Date(base + 200).toISOString(),
      turnId: "turn-1",
    }),
  });
  await broker.recover();
  const firstTimer = clock.scheduled[0]!;
  await service.execute({
    type: "goal.progress",
    goalId,
    actor: "owner-a",
    summary: "实际写回已经完成。",
    next: "继续验收。",
  });
  await broker.refresh(goalId);
  assert.equal(firstTimer.cleared, true);
  assert.equal(clock.scheduled.filter(item => !item.cleared).length, 0);

  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 3, "turn.started", {
      at: new Date(base + 300).toISOString(),
      turnId: "turn-2",
    }),
  });
  await broker.refresh(goalId);
  assert.equal(clock.scheduled.filter(item => !item.cleared).length, 0);
  assert.equal(reminders, 0);
  await broker.stop();
});

test("a reminder turn arriving before delivery acknowledgement cannot create a duplicate reminder", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const clock = fakeTimers();
  clock.setNow(base);
  let reminders = 0;
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 1, "turn.started", {
      at: new Date(base + 100).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 2, "turn.settled", {
      at: new Date(base + 200).toISOString(),
      turnId: "turn-1",
    }),
  });
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => {
      reminders += 1;
      await service.execute({
        type: "agent.runtime.event",
        event: event(goalId, 3, "turn.started", {
          at: new Date(base + 6_000).toISOString(),
          turnId: "turn-2",
        }),
      });
    },
    notifyConcierge: async () => {},
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await broker.recover();
  await clock.fireFirstOpen();
  await eventually(async () => {
    const receipt = (await service.read()).goals[0]!.agentRuntime?.receipt;
    assert.equal(receipt, undefined);
  });
  assert.equal(reminders, 1);
  assert.equal(clock.scheduled.filter(item => !item.cleared && !item.fired).length, 0);
  await broker.stop();
});

test("a reminder transport failure still advances to protocol_missing once", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const clock = fakeTimers();
  clock.setNow(base);
  let concierge = 0;
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 1, "turn.started", {
      at: new Date(base + 100).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 2, "turn.settled", {
      at: new Date(base + 200).toISOString(),
      turnId: "turn-1",
    }),
  });
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => {
      throw new Error("owner pane unavailable");
    },
    notifyConcierge: async () => { concierge += 1; },
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await broker.recover();
  await clock.fireFirstOpen();
  await eventually(async () => {
    assert.equal(
      (await service.read()).goals[0]!.agentRuntime?.receipt?.status,
      "reminded",
    );
  });
  assert.match(
    (await service.read()).goals[0]!.agentRuntime?.receipt?.reminderError ?? "",
    /owner pane unavailable/,
  );
  await clock.fireFirstOpen();
  await eventually(async () => {
    assert.equal(concierge, 1);
    assert.equal(
      (await service.read()).goals[0]!.agentRuntime?.receipt?.status,
      "protocol_missing",
    );
  });
  await broker.stop();
});

test("spool drain accepts the valid token, leaves an invalid file, and rejects stale attempts", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const spool = join(root, ".crewvane", "runtime", "spool");
  const valid = event(goalId, 1, "turn.started", {
    at: new Date(base + 100).toISOString(),
    turnId: "turn-1",
  });
  const invalid = event(goalId, 2, "agent.response", {
    at: new Date(base + 200).toISOString(),
    turnId: "turn-1",
    eventId: "invalid-token-event",
  });
  const stale = event(goalId, 3, "agent.response", {
    at: new Date(base + 300).toISOString(),
    turnId: "turn-1",
    attemptId: "attempt_old",
    eventId: "stale-event",
  });
  await spoolAgentRuntimeEvents(spool, [{ token, events: [valid] }]);
  await spoolAgentRuntimeEvents(spool, [{ token: "wrong", events: [invalid] }]);
  await spoolAgentRuntimeEvents(spool, [{ token, events: [stale] }]);
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => {},
    notifyConcierge: async () => {},
  });
  try {
    await broker.start();
    await eventually(async () => {
      assert.equal(
        (await service.read()).goals[0]!.agentRuntime?.lastEventId,
        "event-1",
      );
    });
    const remaining = (await readdir(spool)).filter(name => name.endsWith(".json"));
    assert.equal(remaining.length, 1);
    const diagnostics = await import("node:fs/promises")
      .then(({ readFile }) =>
        readFile(join(root, ".crewvane", "runtime", "diagnostics.jsonl"), "utf8"));
    assert.match(diagnostics, /old_attempt/);
  } finally {
    await broker.stop();
  }
});

test("ended goals immediately discard recovered receipt timers", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 1, "turn.started", {
      at: new Date(base + 100).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: event(goalId, 2, "turn.settled", {
      at: new Date(base + 200).toISOString(),
      turnId: "turn-1",
    }),
  });
  await service.execute({
    type: "goal.complete",
    goalId,
    actor: "你",
    note: "提前结束。",
  });
  const clock = fakeTimers();
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => {},
    notifyConcierge: async () => {},
    now: () => clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await broker.recover();
  assert.equal(clock.scheduled.length, 0);
  await broker.stop();
});

test("the real socket acknowledges an asynchronously persisted event without spooling", async () => {
  const { root, service, goalId } = await fixture();
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async () => {},
    notifyConcierge: async () => {},
  });
  try {
    await broker.start();
    const result = await ingestAgentHook({
      adapter: "codex",
      environment: {
        CREWVANE_GOAL_ID: goalId,
        CREWVANE_ATTEMPT_ID: "attempt_broker",
        CREWVANE_HOOK_TOKEN: token,
        CREWVANE_AGENT_NAME: "owner-a",
        CREWVANE_WORKSPACE: root,
      },
      stdin: async () => JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        turn_id: "socket-turn",
        prompt: "真实 Socket 验证",
      }),
    });
    assert.deepEqual(result, { accepted: true });
    assert.equal(
      (await service.read()).goals[0]!.agentRuntime?.currentTurnId,
      "socket-turn",
    );
  } finally {
    await broker.stop();
  }
});

test("an automatic reminder's own Stop goes to the concierge without sending another reminder", async () => {
  const base = Date.now(), { root, service, goalId } = await fixture(base);
  const clock = fakeTimers();
  clock.setNow(base);
  let reminders = 0, concierge = 0;
  for (const item of [
    event(goalId, 1, "turn.started", { turnId: "turn-1", at: new Date(base).toISOString() }),
    event(goalId, 2, "turn.settled", { turnId: "turn-1", at: new Date(base).toISOString() }),
  ]) await service.execute({ type: "agent.runtime.event", event: item });
  const broker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    remindOwner: async (_goal, prompt) => {
      reminders++;
      assert.ok(prompt.startsWith(agentReceiptMarker("attempt_broker", "turn-1")));
      await service.execute({
        type: "agent.runtime.event",
        event: event(goalId, 3, "turn.started", {
          turnId: "auto-reminder",
          content: { text: prompt, sha256: "a".repeat(64), truncated: false },
        }),
      });
      await service.execute({
        type: "agent.runtime.event",
        event: event(goalId, 4, "turn.settled", { turnId: "auto-reminder" }),
      });
    },
    notifyConcierge: async () => { concierge++; },
    now: () => clock.now,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await broker.recover();
  await clock.fireFirstOpen();
  await eventually(async () => {
    assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "reminded");
  });
  await clock.fireFirstOpen();
  await eventually(() => assert.equal(concierge, 1));
  assert.equal(reminders, 1);
  assert.equal((await service.read()).goals[0]!.attention, null);
  await broker.stop();
});

test("spool replay uses attempt sequence rather than random same-millisecond file names", async () => {
  const { root, service, goalId } = await fixture();
  const spool = join(root, ".crewvane", "runtime", "spool");
  await mkdir(spool, { recursive: true });
  const stamp = Date.now();
  for (const [name, item] of [
    ["z", event(goalId, 1, "turn.started", { turnId: "offline" })],
    ["a", event(goalId, 2, "agent.response", {
      turnId: "offline",
      content: { text: "离线回复", sha256: "a".repeat(64), truncated: false },
    })],
    ["b", event(goalId, 3, "turn.settled", { turnId: "offline" })],
  ] as const)
    await writeFile(join(spool, `${stamp}-${name}.json`),
      JSON.stringify([{ token, events: [item] }]));
  const broker = new AgentRuntimeBroker({
    service: () => service, workspace: () => root,
    remindOwner: async () => {}, notifyConcierge: async () => {},
  });
  await broker.drainSpool();
  const runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.lastSequence, 3);
  assert.equal(runtime.lastReply?.text, "离线回复");
  assert.equal(runtime.receipt?.turnId, "offline");
  assert.equal((await readdir(spool)).length, 0);
  await broker.stop();
});

test("restart after reserving a reminder does not resend an uncertain delivery", async () => {
  const { root, service, goalId } = await fixture();
  for (const item of [
    event(goalId, 1, "turn.started", { turnId: "crash" }),
    event(goalId, 2, "turn.settled", { turnId: "crash" }),
  ]) await service.execute({ type: "agent.runtime.event", event: item });
  await service.execute({
    type: "agent.runtime.receipt", goalId, attemptId: "attempt_broker",
    turnId: "crash", stage: "reminding", at: new Date().toISOString(),
  });
  const clock = fakeTimers();
  let reminders = 0, concierge = 0;
  const broker = new AgentRuntimeBroker({
    service: () => service, workspace: () => root,
    remindOwner: async () => { reminders++; },
    notifyConcierge: async () => { concierge++; },
    now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  await broker.recover();
  assert.equal(reminders, 0);
  assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "reminded");
  await clock.fireFirstOpen();
  await eventually(() => assert.equal(concierge, 1));
  assert.equal(reminders, 0);
  await broker.stop();
});

test("disabling an Adapter cancels receipts and ignores Hooks cached by an already running Agent", async () => {
  const { root, service, goalId } = await fixture();
  const home = join(root, "home");
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await writeFile(join(home, ".local/bin/crewvane"), "# fixture");
  const manager = new AgentHookManager({
    home, userData: join(root, "userData"),
    commandPath: async name => name === "codex" ? "/fixture/codex" : undefined,
    version: async () => "codex-cli fixture",
  });
  await manager.install("codex");
  for (const item of [
    event(goalId, 1, "turn.started", { turnId: "disabled" }),
    event(goalId, 2, "turn.settled", { turnId: "disabled" }),
  ]) await service.execute({ type: "agent.runtime.event", event: item });
  await manager.disable("codex");
  const broker = new AgentRuntimeBroker({
    service: () => service, workspace: () => root, hooks: manager,
    remindOwner: async () => { assert.fail("a disabled Adapter cannot remind"); },
    notifyConcierge: async () => { assert.fail("a disabled Adapter cannot escalate"); },
  });
  try {
    await broker.recover();
    assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "cancelled");
    const spool = join(root, ".crewvane/runtime/spool");
    await spoolAgentRuntimeEvents(spool, [{ token, events: [
      event(goalId, 3, "turn.started", { turnId: "cached-hook" }),
    ] }]);
    await broker.drainSpool();
    assert.equal((await service.read()).goals[0]!.agentRuntime?.currentTurnId, "disabled");
    assert.equal((await readdir(spool)).length, 0);
    await manager.install("codex");
    await spoolAgentRuntimeEvents(spool, [{ token, events: [
      event(goalId, 4, "turn.started", { turnId: "restored-hook" }),
    ] }]);
    await broker.drainSpool();
    assert.equal((await service.read()).goals[0]!.agentRuntime?.currentTurnId, "restored-hook");
  } finally {
    await broker.stop();
  }
});
