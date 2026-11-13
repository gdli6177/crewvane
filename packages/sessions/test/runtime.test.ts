import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionControl, SessionRuntime, type SessionAdapter, type CreateSceneRequest, type SendSceneRequest } from "../src/index.js";
import { WorkspaceService, type Goal, type SceneReferenceV1 } from "../../core/src/index.js";

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cv-runtime-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const control = new SessionControl(join(root, "control"));
  const config = await control.initialize();
  await control.registerWorkspace(workspace);
  const service = new WorkspaceService(workspace);
  const goal = await service.execute({ type: "goal.intake", text: "只处理隔离目标" }) as Goal;
  await service.execute({ type: "agents.configure", preferences: { concierge: "cursor-2 --model '中文 model'" } });
  const created: CreateSceneRequest[] = [], sent: SendSceneRequest[] = [], stopped: string[] = [];
  let rejectSend = false;
  const adapter: SessionAdapter = {
    id: "herdr",
    detect: async () => ({ id: "herdr", status: "compatible",
      capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: true } }),
    connect: async () => ({ id: "runtime", generation: "generation", backend: "herdr", version: "fixture" }),
    create: async input => {
      created.push(input);
      const scene: SceneReferenceV1 = {
        version: 1, backend: "herdr", installationId: input.installationId, backendEpoch: input.backendEpoch,
        bindingId: input.bindingId, attemptId: input.attemptId, runtimeId: "runtime", runtimeGeneration: "generation",
        locator: { kind: "herdr", session: "test", workspaceId: "w1", tabId: `t${created.length}`, paneId: `p${created.length}` },
      };
      return { status: "created", requestId: input.requestId, scene, mayHaveCreated: true, recoveryId: input.requestId };
    },
    inspect: async scene => ({ bindingId: scene.bindingId, identity: "match", reachable: true,
      state: "idle", observedAt: new Date().toISOString(), source: "backend" }),
    inspectMany: async scenes => Promise.all(scenes.map(scene => adapter.inspect(scene))),
    send: async input => {
      sent.push(input);
      return { status: rejectSend ? "rejected" : "started", deliveryId: input.deliveryId, scene: input.scene,
        payloadSha256: input.payloadSha256, at: new Date().toISOString() };
    },
    focus: async () => ({ status: "focused", navigated: true }),
    close: async scene => { stopped.push(scene.bindingId); return {
      status: "stopped", bindingId: scene.bindingId, at: new Date().toISOString(), identityVerified: true,
    }; },
    discover: async () => [],
    captureResume: async () => ({ status: "supported", agent: "codex", kind: "id", value: "native-session-one" }),
  };
  const runtime = new SessionRuntime({ control, workspace, cliDirectory: join(root, "bin"), adapter: async () => adapter });
  return { runtime, control, service, workspace, config, goal, created, sent, stopped, adapter,
    rejectSend: () => { rejectSend = true; } };
}

test("one concierge is reused; configured command and native argv stay unchanged in the private launcher", async t => {
  const f = await fixture(t);
  const first = await f.runtime.prepareConcierge();
  assert.deepEqual(await f.runtime.prepareConcierge(), first);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0]!.cwd, f.workspace, "The global concierge runs in the workspace root.");
  const launcher = await readFile(f.created[0]!.launcherPath, "utf8");
  assert.match(launcher, /cursor-2 '--model' '中文 model'/);
  assert.doesNotMatch(launcher, /exec cursor-2|command cursor-2/);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0]!.text.length < 2_000, "Identity initialization stays a short native turn.");
  assert.doesNotMatch(f.sent[0]!.text, /\[CREWVANE_CASE_BEGIN\]/);
});

test("rechecking an initialized concierge restores readiness without erasing presence or sending identity again", async t => {
  const f = await fixture(t);
  const scene = await f.runtime.prepareConcierge();
  const live = { state: "idle" as const, reachable: true, checkedAt: new Date().toISOString() };
  await f.service.execute({
    type: "scene.concierge.status", status: "not_ready", live, detail: "正在准备全局管家…",
  });
  assert.deepEqual(await f.runtime.prepareConcierge(), scene);
  const current = (await f.service.read()).concierge;
  assert.equal(current.status, "ready");
  assert.equal(current.detail, undefined);
  assert.deepEqual(current.live, live);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
});

test("owners run in the selected project directory while the global concierge stays at the workspace root", async t => {
  const f = await fixture(t);
  const projectPath = join(f.workspace, "产品 项目");
  await mkdir(projectPath);
  const project = await f.service.execute({ type: "project.add", name: "产品项目", path: projectPath }) as { id: string };
  const createdGoal = await f.service.execute({
    type: "goal.create",
    input: {
      projectId: project.id,
      title: "项目目标",
      description: "只验证工作目录映射。",
      mode: "concierge",
    },
  }) as Goal;
  await f.runtime.prepareConcierge();
  await f.runtime.launchOwner({ goalId: createdGoal.id, name: "owner-project" });
  assert.equal(f.created[0]!.cwd, f.workspace);
  assert.equal(f.created[1]!.cwd, projectPath);
});

test("rediscovering a created concierge initializes its identity once before any case notification", async t => {
  const f = await fixture(t);
  const original = f.adapter.create;
  let result: Awaited<ReturnType<typeof original>>;
  f.adapter.create = async input => {
    result = await original(input);
    return { status: "unknown", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true };
  };
  f.adapter.discover = async () => [{ requestId: result.requestId, scene: result.scene! }];
  await assert.rejects(f.runtime.prepareConcierge(), /launch_unconfirmed/);
  assert.equal(f.sent.length, 0);
  const scene = await f.runtime.prepareConcierge();
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0]!.text, /这是 Crewvane 身份初始化/);
  const restartedRuntime = new SessionRuntime(f.runtime.options);
  await restartedRuntime.prepareConcierge();
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).concierge.initializedAttemptId, scene.attemptId);
});

test("unconfirmed identity delivery is preserved across retries and never marks the concierge initialized", async t => {
  const f = await fixture(t), original = f.adapter.send;
  f.adapter.send = async input => ({ ...await original(input), status: "unknown" });
  await assert.rejects(f.runtime.prepareConcierge(), /delivery_unconfirmed/);
  await assert.rejects(new SessionRuntime(f.runtime.options).prepareConcierge(), /delivery_unconfirmed/);
  assert.equal(f.created.length, 1);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).concierge.initializedAttemptId, undefined);
});
test("a custom CLI can accept the identity handshake without claiming that a business turn started", async t => {
  const f = await fixture(t), original = f.adapter.send;
  f.adapter.inspect = async scene => ({ bindingId: scene.bindingId, identity: "match", reachable: true,
    state: "unknown", observedAt: new Date().toISOString(), source: "backend" });
  f.adapter.send = async input => ({ ...await original(input), status: "accepted" });
  const scene = await f.runtime.prepareConcierge();
  assert.equal((await f.service.read()).concierge.initializedAttemptId, scene.attemptId);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.service.read()).goals[0]!.dispatch?.status, "pending");
});
test("an exited concierge is recreated once while an unverifiable occupant is preserved", async t => {
  const f = await fixture(t);
  const original = await f.runtime.prepareConcierge();
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async scene => scene.bindingId === original.bindingId
    ? { ...await inspect(scene), state: "exited", reachable: false } : inspect(scene);
  const replacement = await f.runtime.prepareConcierge();
  assert.notEqual(replacement.attemptId, original.attemptId);
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.stopped, []);
  f.adapter.inspect = async scene => ({ ...await inspect(scene), identity: "mismatch" });
  await assert.rejects(f.runtime.prepareConcierge(), /scene_identity_mismatch/);
  assert.equal(f.created.length, 2, "A replacement occupant is never closed or duplicated.");
});

test("a scoped concierge launches a separate owner and cannot launch for another case", async t => {
  const f = await fixture(t);
  await f.runtime.prepareConcierge();
  const managed = new SessionRuntime({ ...f.runtime.options, managedContext: {
    installationId: f.config.installationId, backend: "herdr", epoch: 0,
    scopeGeneration: f.config.scopeGeneration, role: "concierge", goalId: f.goal.id,
  } });
  const result = await managed.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  assert.equal(f.created.length, 2);
  assert.notEqual(result.scene.bindingId, (await f.service.read()).concierge.scene?.bindingId);
  assert.equal((await f.service.read()).goals[0]?.owner, "owner-test");
  await assert.rejects(managed.launchOwner({ goalId: "other", name: "owner-other" }), /不能启动|当前案卷/);
  const launcher = await readFile(f.created[1]!.launcherPath, "utf8");
  assert.match(launcher, /CREWVANE_GOAL_ID/);
  assert.doesNotMatch(launcher, /export CREWVANE_COORDINATOR=/);
});

test("idempotent sends reuse the same receipt and reject changed payload or unregistered scenes", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const receipt = await f.runtime.send(scene, "delivery-once", "补充信息");
  assert.deepEqual(await f.runtime.send(scene, "delivery-once", "补充信息"), receipt);
  assert.equal(f.sent.filter(input => input.deliveryId === "delivery-once").length, 1);
  await assert.rejects(f.runtime.send(scene, "delivery-once", "不同内容"), /更换正文/);
  await assert.rejects(f.runtime.send({ ...scene, bindingId: "foreign" }, "foreign-send", "内容"), /已登记/);
});

test("consultation restores a review scene while preserving the same attention and delivery", async t => {
  const f = await fixture(t);
  await f.service.execute({ type: "goal.review", goalId: f.goal.id, delivery: {
    summary: "已有可核对的文档结果", location: "/tmp/result.md",
    checks: [{ name: "核对", command: "test", result: "passed", note: "实际核对通过" }],
  }, actor: "owner" });
  const before = (await f.service.read()).goals[0]!;
  await f.control.operation({ workspace: f.workspace, requestId: "prepare-test-switch", kind: "create",
    authority: undefined }, async () => {});
  // Use a control instance that is still ready before committing the new
  // epoch. Real switches own an explicit authority for this operation.
  const changing = new SessionControl(join(f.control.directory, "..", "test-switch-control"));
  await changing.initialize();
  const switchControl = new SessionControl(f.control.directory);
  void switchControl;
  void changing;
  await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-consult", consultationOnly: true });
  const after = (await f.service.read()).goals[0]!;
  assert.equal(after.status, "review");
  assert.deepEqual(after.attention, before.attention);
  assert.deepEqual(after.delivery, before.delivery);
  assert.match(f.sent.at(-1)!.text, /等待用户答复；不得开始实现/);
});
test("explicit recovery retires only a confirmed exited owner and preserves the pending decision", async t => {
  const f = await fixture(t);
  const { scene: original } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-old" });
  await f.service.execute({ type: "goal.decide", goalId: f.goal.id, question: "选择下一步方案？", actor: "owner-old" });
  const before = (await f.service.read()).goals[0]!;
  const existing = await f.runtime.recoverOwnerForConsultation(f.goal.id);
  assert.equal(existing.scene.bindingId, original.bindingId);
  assert.equal(f.created.length, 1, "Opening a live consultation never creates a second owner.");
  const inspect = f.adapter.inspect;
  f.adapter.inspect = async scene => ({ ...await inspect(scene), identity: "mismatch" });
  await assert.rejects(f.runtime.recoverOwnerForConsultation(f.goal.id), /原现场尚未确认停止/);
  f.adapter.inspect = async scene => scene.bindingId === original.bindingId
    ? { ...await inspect(scene), state: "exited", reachable: false } : inspect(scene);
  const replacement = await f.runtime.recoverOwnerForConsultation(f.goal.id);
  const after = (await f.service.read()).goals[0]!;
  assert.notEqual(replacement.scene.attemptId, original.attemptId);
  assert.equal(after.status, before.status);
  assert.deepEqual(after.attention, before.attention);
  assert.equal(after.sceneHistory?.at(-1)?.bindingId, original.bindingId);
  assert.match(f.sent.at(-1)!.text, /等待用户答复；不得开始实现/);
  assert.deepEqual(f.stopped, []);
});

test("a pending decision restores a consultation-only owner after a backend handoff", async t => {
  const f = await fixture(t);
  const original = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-old" });
  await f.service.execute({ type: "goal.decide", goalId: f.goal.id,
    question: "采用 A 还是 B？", actor: "owner-old" });
  const before = (await f.service.read()).goals[0]!;
  await f.service.execute({ type: "backend.commit", binding: {
    installationId: f.config.installationId, backend: "orca", epoch: 1,
    scopeGeneration: "next-generation", status: "resuming", operationId: "switch-one",
  }, handoffs: { [f.goal.id]: {
    operationId: "switch-one", checkpointRevision: before.revision ?? 1,
    sourceScene: original.scene, method: "deferred", status: "skipped",
  } } });
  // The runtime fixture uses one adapter for both IDs. Advance only its
  // persisted control fixture; the real transition's epoch/authority tests
  // live in backend-switch.test.ts.
  const controlPath = join(f.control.directory, "backend.json");
  const control = JSON.parse(await readFile(controlPath, "utf8"));
  await writeFile(controlPath, JSON.stringify({ ...control, selected: "orca", epoch: 1, scopeGeneration: "next-generation" }), { mode: 0o600 });
  const orca: SessionAdapter = { ...f.adapter, id: "orca", create: async input => {
    const result = await f.adapter.create(input);
    if (!result.scene) throw new Error("Fixture must create a scene");
    return { ...result, scene: { ...result.scene, backend: "orca", locator: {
      kind: "orca", repoId: "repo", worktreeId: "worktree", terminalHandle: "terminal", executionHostId: "local",
      incarnationId: "incarnation",
    } } };
  } };
  const restored = await new SessionRuntime({ ...f.runtime.options, adapter: async () => orca }).launchOwner({ goalId: f.goal.id,
    name: "owner-consult-new", consultationOnly: true });
  const after = (await f.service.read()).goals[0]!;
  assert.notEqual(restored.scene.attemptId, original.scene.attemptId);
  assert.deepEqual(after.attention, before.attention);
  assert.equal(after.status, "active");
  assert.equal(after.owner, "owner-consult-new");
  assert.match(f.sent.at(-1)!.text, /只读取 goal show/);
  assert.match(f.sent.at(-1)!.text, /scene-reply/);
  assert.doesNotMatch(f.sent.at(-1)!.text, /执行目标 .*隔离目标/);
});

test("completion captures native resume before closing only the goal's verified scene", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  await f.service.execute({ type: "goal.complete", goalId: f.goal.id, note: "用户确认已经完成" });
  await f.runtime.captureOwnerResume(f.goal.id, scene);
  await f.runtime.close(scene, f.goal.id);
  const goal = (await f.service.read()).goals[0]!;
  assert.equal(goal.status, "completed");
  assert.equal(goal.scene, undefined);
  assert.equal(goal.ownerResume?.agentSession?.value, "native-session-one");
  assert.deepEqual(f.stopped, [scene.bindingId]);
});

test("a watchdog notification uses its own stable delivery identity after normal dispatch", async t => {
  const f = await fixture(t);
  await f.runtime.notifyGoal(f.goal, "新任务", undefined, "original-dispatch");
  await f.runtime.notifyGoal(f.goal, "核对未写回的结果", undefined, "watchdog-one");
  assert.deepEqual(f.sent.slice(-2).map(item => item.deliveryId), ["original-dispatch", "watchdog-one"]);
});

test("a busy concierge defers a watchdog without consuming its delivery ID or changing the next case", async t => {
  const f = await fixture(t);
  await f.runtime.prepareConcierge();
  const inspect = f.adapter.inspect;
  for (const state of ["working", "blocked"] as const) {
    f.adapter.inspect = async scene => ({ ...await inspect(scene), state });
    await assert.rejects(f.runtime.notifyGoal(f.goal, "核对结果", undefined, "watchdog-deferred"),
      /backend_busy/);
    assert.equal(f.sent.length, 1, "Only the identity handshake was sent.");
  }
  f.adapter.inspect = inspect;
  const result = await f.runtime.notifyGoal(f.goal, "核对结果", undefined, "watchdog-deferred");
  assert.equal(result.receipt.status, "started");
  assert.equal(f.sent.filter(item => item.deliveryId === "watchdog-deferred").length, 1);
});

test("timestamp correlation IDs remain safe, stable and idempotent", async t => {
  const f = await fixture(t);
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const id = `watchdog:${f.goal.id}:2026-11-13T06:09:52.666Z`;
  const first = await f.runtime.send(scene, id, "核对实际进展");
  assert.deepEqual(await f.runtime.send(scene, id, "核对实际进展"), first);
  assert.match(first.deliveryId, /^delivery-[a-f0-9]{64}$/);
  assert.equal(f.sent.filter(item => item.deliveryId === first.deliveryId).length, 1);
});

test("native resume never replaces a wrapper and preserves configured argv", async t => {
  const f = await fixture(t);
  await f.service.execute({ type: "agents.configure", preferences: {
    concierge: "cursor-2 --model '中文 model'", owner: "/tmp/custom-wrapper --original",
  } });
  const { scene } = await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-first" });
  await f.service.execute({ type: "session.resume.capture", goalId: f.goal.id, resume: {
    owner: "old-owner", cwd: f.workspace, savedAt: new Date().toISOString(),
    agentSession: { source: "herdr:omp", agent: "omp", kind: "id", value: "old-session" },
  } });
  await f.service.execute({ type: "goal.complete", goalId: f.goal.id, note: "用户确认本阶段结束" });
  await f.runtime.close(scene, f.goal.id);
  await f.service.execute({ type: "goal.restart", goalId: f.goal.id, note: "用户要求续接原目标" });
  await f.runtime.launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const script = await readFile(f.created.at(-1)!.launcherPath, "utf8");
  assert.match(script, /custom-wrapper.*--original/);
  assert.doesNotMatch(script, /old-session/);
});
