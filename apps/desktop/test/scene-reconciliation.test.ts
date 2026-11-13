import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { WorkspaceService, attentionGoals, type Goal } from "../../../packages/core/src/index.js";
import { reconcileSceneReply } from "../electron/scene-reconciliation.js";
import { HerdrClient } from "../electron/herdr.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp("/tmp/cv-scene-check-"); roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.intake", text: "核对现场同步" }) as Goal;
  await service.execute({ type: "session.set", goalId: goal.id,
    reference: { session: "cv-test", agent: "owner-a", paneId: "w1:p2", tabId: "w1:t2" } });
  await service.execute({ type: "goal.decide", goalId: goal.id, question: "先交付核心功能？" });
  return { root, service, id: goal.id };
}
async function live(service: WorkspaceService, id: string, state: "working" | "done") {
  await service.execute({ type: "live.event", target: { paneId: "w1:p2" },
    presence: { state, reachable: true, checkedAt: new Date().toISOString() } });
}
test("viewing a scene alone never queues a reconciliation; a real work cycle does, once across restarts", async () => {
  const { root, service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "done");
  let calls = 0;
  const connection = { async requestSceneReply() { calls++; return true; } };
  await reconcileSceneReply(service, id, connection, { graceMs: 0 });
  assert.equal(calls, 0);
  await live(service, id, "working");
  await live(service, id, "done");
  await Promise.all([
    reconcileSceneReply(service, id, connection, { graceMs: 0 }),
    reconcileSceneReply(new WorkspaceService(root), id, connection, { graceMs: 0 }),
  ]);
  assert.equal(calls, 1);
  // Its own reconciliation round must not create an endless work/check loop.
  await live(service, id, "working");
  await live(service, id, "done");
  await reconcileSceneReply(service, id, connection, { graceMs: 0 });
  assert.equal(calls, 1);
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
});
test("legacy scene reconciliation waits through a user-interaction grace period", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  const visit = (await service.read()).goals[0]!.sceneVisit!;
  assert.ok(visit.pendingAt);
  let calls = 0;
  const connection = { async requestSceneReply() { calls++; return true; } };
  await reconcileSceneReply(service, id, connection, {
    now: () => new Date(Date.parse(visit.pendingAt!) + 59_999),
  });
  assert.equal(calls, 0);
  await reconcileSceneReply(service, id, connection, {
    now: () => new Date(Date.parse(visit.pendingAt!) + 60_000),
  });
  assert.equal(calls, 1);
});
test("hook-capable owners skip scene reconciliation and a real turn cancels the fallback", async () => {
  const { service, id } = await fixture();
  const at = new Date().toISOString();
  await service.execute({
    type: "agent.runtime.register",
    goalId: id,
    attempt: {
      goalId: id, attemptId: "attempt-hook-owner", agent: "owner-a",
      adapter: "omp", startedAt: at,
    },
    hookTokenHash: "a".repeat(64),
    capabilities: ["turn.started", "turn.settled"],
  });
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  let calls = 0;
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { calls++; return true; },
  }, {
    now: () => new Date(Date.now() + 60_000),
  });
  assert.equal(calls, 0);
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "pending");
  await service.execute({
    type: "agent.runtime.event",
    event: {
      version: "v1", eventId: "event-user-turn", sequence: 1,
      at: new Date(Date.now() + 60_001).toISOString(),
      source: "hook", agent: "owner-a", adapter: "omp", goalId: id,
      attemptId: "attempt-hook-owner", type: "turn.started", turnId: "turn-user",
      content: { text: "用户在现场提出的真实问题", sha256: "b".repeat(64), truncated: false },
    },
  });
  assert.equal((await service.read()).goals[0]!.sceneVisit, undefined);
});
test("a human message from the app cancels fallback reconciliation without resolving attention", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working");
  await live(service, id, "done");
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "pending");
  await service.execute({ type: "goal.message", goalId: id, text: "补充一个边界条件" });
  const current = (await service.read()).goals[0]!;
  assert.equal(current.sceneVisit, undefined);
  assert.ok(current.attention);
});
test("an owner's semantic receipt skips reconciliation, and failed synchronization can be explicitly retried", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "scene.visit", goalId: id });
  await live(service, id, "working"); await live(service, id, "done");
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { throw new Error("连接中断"); },
  }, { graceMs: 0 });
  assert.equal((await service.read()).goals[0]!.sceneVisit?.status, "failed");
  await service.execute({ type: "scene.visit", goalId: id, retry: true });
  await reconcileSceneReply(service, id, { async requestSceneReply(goal) {
    await service.execute({ type: "goal.scene-reply", goalId: id,
      attentionId: goal.attention!.id!, quote: "先交付核心功能。", summary: "已确认范围。", actor: "owner-a" });
    return true;
  } }, { graceMs: 0 });
  let calls = 0;
  await reconcileSceneReply(service, id, {
    async requestSceneReply() { calls++; return true; },
  }, { graceMs: 0 });
  assert.equal(calls, 0);
  assert.equal((await service.read()).goals[0]!.sceneReply?.quote, "先交付核心功能。");
});
test("safe owner reconciliation never prompts a working, blocked, unknown or replaced CLI", async () => {
  const { service } = await fixture();
  const goal = (await service.read()).goals[0]!;
  for (const state of ["working", "blocked", "unknown", "idle", "done"]) {
    for (const replaced of [false, true]) {
      const calls: string[][] = [];
      const client = new HerdrClient({ async run(args) {
        calls.push(args);
        if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: [{
          name: "owner-a", pane_id: replaced ? "w1:p99" : "w1:p2", agent_status: state,
        }] } });
        return "{}";
      } }, "cv-test");
      const expected = !replaced && ["idle", "done"].includes(state);
      assert.equal(await client.requestSceneReply(goal), expected);
      const prompt = calls.find(args => args[1] === "prompt");
      assert.equal(!!prompt, expected);
      if (prompt) {
        assert.match(prompt[3]!, /不是用户的新回复/);
        assert.match(prompt[3]!, /scene-reply/);
        assert.match(prompt[3]!, new RegExp(goal.attention!.id!));
      }
    }
  }
});
