import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestAgentHook } from "../src/hook-ingest.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server =>
    new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

function percentile(values: number[], target: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * target) - 1)]!;
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-hook-performance-"));
  roots.push(root);
  return root;
}

function environment(root: string, socket: string): NodeJS.ProcessEnv {
  return {
    CREWVANE_GOAL_ID: "goal-performance",
    CREWVANE_ATTEMPT_ID: "attempt-performance",
    CREWVANE_HOOK_TOKEN: "performance-token",
    CREWVANE_AGENT_NAME: "owner-performance",
    CREWVANE_WORKSPACE: root,
    CREWVANE_HOOK_SOCKET: socket,
    CREWVANE_HOOK_SPOOL: join(root, ".crewvane", "runtime", "spool"),
  };
}

async function collector(path: string) {
  const server = createServer(socket => {
    const chunks: Buffer[] = [];
    socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      socket.end(`${JSON.stringify({
        ok: Array.isArray(request.events) && request.events.length > 0,
      })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

test("local lifecycle Hook p95 stays below 250 ms", async () => {
  const root = await workspace(), socket = join(root, "broker.sock");
  await collector(socket);
  const timings: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now();
    const result = await ingestAgentHook({
      adapter: "codex",
      environment: environment(root, socket),
      stdin: async () => JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: `session-${index}`,
      }),
    });
    timings.push(performance.now() - started);
    assert.equal(result.accepted, true);
  }
  assert.ok(
    percentile(timings, 0.95) < 250,
    `Hook p95 was ${percentile(timings, 0.95).toFixed(1)} ms`,
  );
});

test("an unavailable app fails open in less than 500 ms", async () => {
  const root = await workspace(), socket = join(root, "not-running.sock");
  const started = performance.now();
  const result = await ingestAgentHook({
    adapter: "claude-code",
    environment: environment(root, socket),
    stdin: async () => JSON.stringify({
      hook_event_name: "SessionStart",
    }),
  });
  const elapsed = performance.now() - started;
  assert.deepEqual(result, { accepted: true, reason: "spooled" });
  assert.ok(elapsed < 500, `offline Hook took ${elapsed.toFixed(1)} ms`);
});
