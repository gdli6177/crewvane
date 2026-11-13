import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initialState, isSceneReference, sameScene, WorkspaceService, WorkspaceStore,
  type Goal, type SceneReferenceV1, type ManagedSessionContext,
} from "../src/index.js";

const scene = (attemptId = "attempt-one"): Extract<SceneReferenceV1, { backend: "orca" }> => ({
  version: 1, backend: "orca", installationId: "installation-one",
  runtimeId: "runtime-one", runtimeGeneration: "runtime-one:birth-one",
  bindingId: `binding-${attemptId}`, attemptId, backendEpoch: 1,
  locator: {
    kind: "orca", repoId: "repo-one", worktreeId: "repo-one::/tmp/个人 事项",
    terminalHandle: `term-${attemptId}`, executionHostId: "local", incarnationId: "incarnation-one",
  },
});
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-session-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new WorkspaceService(root);
  const item = await service.execute({ type: "goal.intake", text: "保留原始事项与决定。" }) as Goal;
  return { root, service, item };
}
async function activate(service: WorkspaceService, ids: string[]) {
  await service.execute({
    type: "backend.commit",
    binding: {
      installationId: "installation-one", backend: "orca", epoch: 1,
      scopeGeneration: "scope-one", status: "resuming", operationId: "switch-one",
    },
    handoffs: Object.fromEntries(ids.map(id => [id, {
      operationId: "switch-one", checkpointRevision: 1,
      method: "case-rehydrate", status: "pending",
    }])),
  });
}
test("v3 migration backs up bytes before v4 and never invents runtime identity", async t => {
  const { root, service, item } = await fixture(t);
  await service.execute({ type: "goal.decide", goalId: item.id, question: "确认方案？", actor: "owner" });
  const state = await service.read();
  const legacy = {
    ...state, version: 3,
    goals: state.goals.map(goal => ({
      ...goal, herdr: { session: "old", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    })),
  };
  const raw = JSON.stringify(legacy);
  await writeFile(join(root, ".crewvane/state.json"), raw);
  const migrated = await new WorkspaceStore(root).read();
  assert.equal(migrated.version, 4);
  assert.equal(migrated.backendEpoch, 0);
  assert.equal(migrated.goals[0]?.id, item.id);
  assert.deepEqual(migrated.goals[0]?.attention, state.goals[0]?.attention);
  assert.deepEqual(migrated.goals[0]?.activities, state.goals[0]?.activities);
  assert.equal(migrated.goals[0]?.scene, undefined);
  assert.equal(migrated.goals[0]?.legacyScene?.verification, "unverified");
  assert.equal(migrated.goals[0]?.legacyScene?.reference.paneId, "w1:p1");
  assert.equal(migrated.goals[0]?.herdr, undefined);
  assert.equal(await readFile(join(root, ".crewvane/state.v3.backup.json"), "utf8"), raw);
  assert.deepEqual(await service.read(), migrated);
});
test("backup conflict or unsafe backup stops migration without overwriting the snapshot", async t => {
  const { root, service } = await fixture(t);
  const raw = JSON.stringify({ ...await service.read(), version: 3 });
  const stateFile = join(root, ".crewvane/state.json");
  const backup = join(root, ".crewvane/state.v3.backup.json");
  await writeFile(stateFile, raw);
  await writeFile(backup, "{}");
  await assert.rejects(service.read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
  await rm(backup);
  await symlink(stateFile, backup);
  await assert.rejects(service.read(), /备份/);
  assert.equal(await readFile(stateFile, "utf8"), raw);
});
test("scene schema rejects a backend/locator mismatch and PID reuse is a different identity", () => {
  const current = scene();
  assert.equal(isSceneReference(current), true);
  assert.equal(isSceneReference({ ...current, backend: "herdr" }), false);
  assert.equal(isSceneReference({ ...current, locator: { ...current.locator, incarnationId: "" } }), false);
  assert.equal(sameScene(current, { ...current, runtimeGeneration: "restarted" }), false);
  assert.equal(sameScene(current, { ...current, locator: { ...current.locator, incarnationId: "new" } }), false);
});
test("backend commit preserves the latest messages, attention and lifecycle, and revokes old writes", async t => {
  const { root, service, item } = await fixture(t);
  await service.execute({ type: "goal.decide", goalId: item.id, question: "需要人的决定", actor: "owner" });
  await service.execute({ type: "goal.message", goalId: item.id, text: "准备交接后我补充的新消息。" });
  const before = (await service.read()).goals[0]!;
  await activate(service, [item.id]);
  const after = (await service.read()).goals[0]!;
  assert.deepEqual(after.activities, before.activities);
  assert.deepEqual(after.attention, before.attention);
  assert.equal(after.status, before.status);
  const oldContext: ManagedSessionContext = {
    installationId: "installation-one", backend: "herdr", epoch: 0,
    scopeGeneration: "old-scope", role: "owner", goalId: item.id, attemptId: "old-attempt",
  };
  await assert.rejects(new WorkspaceService(root, oldContext).execute({
    type: "goal.complete", goalId: item.id, note: "旧回合迟到结束",
  }), /stale_backend_epoch/);
  assert.deepEqual((await service.read()).goals[0], after);
});
test("current resuming owner can write its case but not another goal", async t => {
  const { root, service, item } = await fixture(t);
  await activate(service, [item.id]);
  await service.execute({
    type: "agent.runtime.register", goalId: item.id,
    attempt: { goalId: item.id, attemptId: "attempt-one", agent: "owner-one", adapter: "custom", startedAt: new Date().toISOString() },
    hookTokenHash: "a".repeat(64), capabilities: [],
  });
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  const context: ManagedSessionContext = {
    installationId: "installation-one", backend: "orca", epoch: 1,
    scopeGeneration: "scope-one", role: "owner", goalId: item.id, attemptId: "attempt-one",
  };
  const owner = new WorkspaceService(root, context);
  await owner.execute({ type: "goal.progress", goalId: item.id, summary: "核对磁盘后已回报。", actor: "owner-one" });
  await assert.rejects(owner.execute({ type: "goal.progress", goalId: "other", summary: "越界" }), /自己的目标/);
  await service.execute({ type: "backend.revoke", operationId: "switch-two", expectedEpoch: 1 });
  await assert.rejects(owner.execute({ type: "goal.progress", goalId: item.id, summary: "迟到" }), /stale_backend_epoch/);
});
test("repeated lifecycle observation does not add activities or change the business progress time", async t => {
  const { service, item } = await fixture(t);
  await activate(service, [item.id]);
  await service.execute({ type: "scene.bind", goalId: item.id, scene: scene() });
  const before = (await service.read()).goals[0]!;
  const observation = {
    type: "scene.observe" as const,
    scenes: [{ bindingId: scene().bindingId, presence: { state: "idle" as const, reachable: true, checkedAt: new Date().toISOString() } }],
  };
  await service.execute(observation);
  const once = (await service.read()).goals[0]!;
  for (let i = 0; i < 20; i++) await service.execute(observation);
  const after = (await service.read()).goals[0]!;
  assert.deepEqual(after, once);
  assert.equal(after.status, "active");
  assert.deepEqual(after.activities, before.activities);
  assert.equal(after.updatedAt, before.updatedAt);
});
test("legacy concierge status observations preserve the neutral scene and pending launch identity", async t => {
  const { service, item } = await fixture(t);
  await activate(service, [item.id]);
  await service.execute({ type: "scene.bind", scene: scene("concierge-one") });
  const before = (await service.read()).concierge;
  await service.execute({ type: "concierge.status", status: "not_ready", reference: before, detail: "准备中" });
  await service.execute({ type: "concierge.status", status: "ready",
    live: { state: "idle", reachable: true, checkedAt: new Date().toISOString() } });
  const after = (await service.read()).concierge;
  assert.deepEqual(after.scene, before.scene);
  assert.deepEqual(after.launch, before.launch);
});
test("neutral concierge initialization does not need a second legacy readiness write", async t => {
  const { service, item } = await fixture(t);
  await activate(service, [item.id]);
  await service.execute({ type: "scene.bind", scene: scene("concierge-one") });
  const attemptId = (await service.read()).concierge.scene!.attemptId;
  await service.execute({ type: "scene.concierge.status", status: "ready", initializedAttemptId: attemptId });
  const initialized = (await service.read()).concierge;
  assert.equal(initialized.initializedAttemptId, attemptId);
  assert.equal(initialized.scene?.backend, "orca");
  // Opening the scene only focuses it; it must not downgrade this receipt to
  // the legacy Herdr status channel. The packaged terminal smoke covers IPC.
  assert.deepEqual((await service.read()).concierge, initialized);
});
