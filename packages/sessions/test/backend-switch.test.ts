import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SessionControl, type SessionAdapter, type SwitchHooks, type SwitchJournal, type SceneObservation,
} from "../src/index.js";
import { WorkspaceService, type Goal, type SceneReferenceV1 } from "../../core/src/index.js";

async function fixture(t: test.TestContext, workspaceCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "cv-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const control = new SessionControl(join(root, "control"), { quiescenceTimeoutMs: 0 });
  const configuration = await control.initialize();
  const services: WorkspaceService[] = [], goals: Goal[] = [], calls: string[] = [];
  const resources = new Map<string, { scene: SceneReferenceV1; state: SceneObservation["state"]; closed: boolean }>();
  for (let i = 0; i < workspaceCount; i++) {
    const path = join(root, `workspace-${i}`);
    await mkdir(path);
    await control.registerWorkspace(path);
    const service = new WorkspaceService(path);
    const goal = await service.execute({ type: "goal.intake", text: `目标 ${i}` }) as Goal;
    const scene: SceneReferenceV1 = {
      version: 1, backend: "herdr", installationId: configuration.installationId,
      runtimeId: `herdr-${i}`, runtimeGeneration: `generation-${i}`,
      bindingId: `binding-${i}`, attemptId: `attempt-${i}`, backendEpoch: 0,
      locator: { kind: "herdr", session: `test-${i}`, workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
    };
    await service.execute({ type: "scene.bind", goalId: goal.id, scene });
    await service.execute({ type: "goal.progress", goalId: goal.id, summary: "已核对现有成果。", next: "继续下一步", actor: "owner" });
    services.push(service); goals.push(goal);
    resources.set(scene.bindingId, { scene, state: "idle", closed: false });
  }
  let rejectClose = "", targetMissing = false;
  const adapter = (backend: "herdr" | "orca"): SessionAdapter => ({
    id: backend,
    detect: async () => ({
      id: backend, status: targetMissing && backend === "orca" ? "missing" : "compatible",
      capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false },
    }),
    connect: async () => ({ id: "runtime", generation: "generation", version: "fixture", backend }),
    create: async () => { calls.push(`business:create:${backend}`); throw new Error("Use resume fixture"); },
    inspect: async scene => ({
      bindingId: scene.bindingId, identity: "match", reachable: true,
      state: resources.get(scene.bindingId)?.state ?? "unknown", observedAt: new Date().toISOString(), source: "backend",
    }),
    inspectMany: async scenes => scenes.map(scene => ({
      bindingId: scene.bindingId, identity: "match", reachable: true,
      state: resources.get(scene.bindingId)?.closed ? "exited" : resources.get(scene.bindingId)?.state ?? "unknown",
      observedAt: new Date().toISOString(), source: "backend",
    })),
    send: async () => { throw new Error("No send before resume"); },
    focus: async () => ({ status: "focused", navigated: true }),
    close: async scene => {
      calls.push(`close:${scene.bindingId}`);
      const resource = resources.get(scene.bindingId)!;
      if (scene.bindingId === rejectClose)
        return { status: "unknown", bindingId: scene.bindingId, at: new Date().toISOString(), identityVerified: true };
      resource.closed = true;
      return { status: "stopped", bindingId: scene.bindingId, at: new Date().toISOString(), identityVerified: true };
    },
    discover: async () => [],
    captureResume: async () => ({ status: "unsupported" }),
  });
  const hooks: SwitchHooks = {
    adapter: async backend => adapter(backend),
    resume: async ({ state, workspace, operationId }) => {
      calls.push(`business:resume:${workspace}`);
      const currentGoals = (await new WorkspaceService(workspace).read()).goals;
      for (const goal of currentGoals.filter(goal => !["completed", "dropped"].includes(goal.status))) {
        // This fixture models the existing post-ready queue: handoff only
        // restores the case, it never replaces a pending message's identity.
        const current = (await new WorkspaceService(workspace).read()).goals.find(item => item.id === goal.id);
        if (current?.dispatch?.status === "pending") {
          calls.push(`deliver:${current.dispatch.id}`);
          await new WorkspaceService(workspace).execute({
            type: "goal.dispatch", goalId: goal.id, status: "sent", requestId: current.dispatch.id,
          });
        }
        await new WorkspaceService(workspace).execute({
          type: "backend.handoff", goalId: goal.id, operationId,
          patch: { status: ["completed", "dropped", "waiting", "review", "backlog"].includes(goal.status) ||
            goal.attention || goal.autonomy?.paused || goal.mode === "manual" ? "skipped" : "accepted" },
        });
      }
    },
  };
  return {
    root, control, configuration, services, goals, hooks, calls, resources,
    rejectClose: (id: string) => { rejectClose = id; },
    targetMissing: () => { targetMissing = true; },
  };
}
test("new installation defaults Herdr and private control files have owner-only permissions", async t => {
  const f = await fixture(t);
  assert.equal((await f.control.status()).selected, "herdr");
  assert.equal((await stat(join(f.root, "control/backend.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.root, "control"))).mode & 0o777, 0o700);
});
test("every old workspace stops before the first new business agent; new messages survive prepare", async t => {
  const f = await fixture(t, 2);
  const goalId = f.goals[0]!.id;
  const original = (await f.services[0]!.read()).goals[0]!;
  const result = await f.control.switchTo("orca", {
    ...f.hooks,
    resume: async ({ workspace, operationId }) => {
      f.calls.push(`business:resume:${workspace}`);
      const service = new WorkspaceService(workspace);
      for (const goal of (await service.read()).goals) {
        await service.execute({ type: "backend.handoff", goalId: goal.id, operationId,
          patch: { status: ["completed", "dropped"].includes(goal.status) ? "skipped" : "accepted" } });
      }
    },
    afterPersist: async phase => {
      if (phase === "prepared") {
        await f.services[0]!.execute({ type: "goal.message", goalId, text: "交接中的新消息" });
      }
    },
  });
  assert.equal(result?.phase, "ready", result?.detail);
  assert.equal((await f.control.status()).selected, "orca");
  const firstResume = f.calls.findIndex(call => call.startsWith("business:"));
  assert.equal(f.calls.slice(0, firstResume).filter(call => call.startsWith("close:")).length, 2);
  assert.equal(f.resources.size, 2);
  assert([...f.resources.values()].every(resource => resource.closed));
  const current = (await f.services[0]!.read()).goals[0]!;
  assert.equal(current.activities.filter(activity =>
    activity.kind === "message" && activity.text === "交接中的新消息").length, 1);
  assert.equal(current.backendHandoff?.status, "accepted");
  assert.equal((await f.services[0]!.read()).backendEpoch, 1);
});
test("missing target or cancelled preparation keeps old backend and never closes a resource", async t => {
  const f = await fixture(t);
  f.targetMissing();
  const result = await f.control.switchTo("orca", f.hooks);
  assert.equal(result?.phase, "cancelled");
  assert.equal((await f.control.status()).selected, "herdr");
  assert.equal(f.calls.length, 0);
});
test("working, blocked and unknown cannot be silently killed during a switch", async t => {
  for (const state of ["working", "blocked", "unknown"] as const) {
    const f = await fixture(t);
    f.resources.get("binding-0")!.state = state;
    const result = await f.control.switchTo("orca", f.hooks);
    assert.equal(result?.phase, "cancelled");
    assert.match(result?.detail ?? "", /backend_busy/);
    assert.deepEqual(f.calls, []);
  }
});
test("unconfirmed delivery is never converted into unsent or replayed", async t => {
  const f = await fixture(t);
  await f.services[0]!.execute({ type: "goal.dispatch", goalId: f.goals[0]!.id, status: "unconfirmed" });
  const result = await f.control.switchTo("orca", f.hooks);
  assert.equal(result?.phase, "cancelled");
  assert.match(result?.detail ?? "", /delivery_unconfirmed/);
  assert.equal((await f.services[0]!.read()).goals[0]?.dispatch?.status, "unconfirmed");
  assert.deepEqual(f.calls, []);
});
test("a resume with an unresolved automatic handoff can never become ready", async t => {
  const f = await fixture(t);
  const result = await f.control.switchTo("orca", {
    ...f.hooks,
    // Deliberately leave every handoff at prepared to simulate a delivery
    // whose result could not be proven.
    resume: async ({ workspace }) => { f.calls.push(`business:resume:${workspace}`); },
  });
  assert.equal(result?.phase, "recovery_required");
  assert.match(result?.detail ?? "", /交接未确认/);
  assert.equal((await f.control.status()).phase, "recovery_required");
  assert.equal((await f.services[0]!.read()).backendBinding?.status, "resuming");
  assert.equal((await f.services[0]!.read()).backendBinding?.operationId, result?.operationId);
});
test("partial close is recovery_required and a retry never repeats verified closes", async t => {
  const f = await fixture(t, 3);
  f.rejectClose("binding-1");
  const result = await f.control.switchTo("orca", f.hooks);
  assert.equal(result?.phase, "recovery_required");
  assert.equal((await f.control.status()).selected, "herdr");
  assert.deepEqual(f.calls, ["close:binding-0", "close:binding-1"]);
  await assert.rejects(f.control.operation({
    workspace: f.services[0]!.root, requestId: "blocked-launch", kind: "create",
  }, async () => {}), /backend_switch_in_progress/);
  f.rejectClose("");
  const recovered = await f.control.retrySwitch(f.hooks);
  assert.equal(recovered.phase, "ready", recovered.detail);
  assert.equal(f.calls.filter(call => call === "close:binding-0").length, 1);
  assert(f.calls.includes("close:binding-2"));
});
test("ordinary callers cannot manufacture switch authority; authorized recovery can launch and write before ready", async t => {
  const f = await fixture(t);
  const result = await f.control.switchTo("orca", {
    ...f.hooks,
    resume: async ({ workspace, authority, state }) => {
      await assert.rejects(f.control.operation({
        workspace, requestId: "forged", kind: "create",
        authority: { operationId: authority.operationId, proof: Symbol("forged") },
      }, async () => {}), /backend_switch_in_progress/);
      await assert.rejects(f.control.operation({
        workspace, requestId: "out-of-scope", kind: "create", authority, goalId: "not-in-recovery",
      }, async () => {}), /backend_switch_in_progress/);
      await f.control.operation({ workspace, requestId: "allowed-recovery", kind: "create", authority, role: "concierge" },
        async current => {
          assert.equal(current.phase, "switching");
          assert.equal(current.selected, "orca");
          assert.equal(state.backendBinding?.status, "resuming");
        });
      const service = new WorkspaceService(workspace);
      for (const goal of (await service.read()).goals)
        await service.execute({
          type: "backend.handoff",
          goalId: goal.id,
          operationId: authority.operationId,
          patch: { status: "accepted" },
        });
    },
  });
  assert.equal(result?.phase, "ready", result?.detail);
});
test("ending a goal after prepared is respected when resuming; its attention is not regenerated", async t => {
  const f = await fixture(t);
  const id = f.goals[0]!.id;
  const result = await f.control.switchTo("orca", {
    ...f.hooks,
    resume: async ({ workspace, operationId }) => {
      const service = new WorkspaceService(workspace);
      for (const goal of (await service.read()).goals) {
        await service.execute({ type: "backend.handoff", goalId: goal.id, operationId,
          patch: { status: ["completed", "dropped"].includes(goal.status) ? "skipped" : "accepted" } });
      }
    },
    afterPersist: async phase => {
      if (phase === "prepared") await f.services[0]!.execute({ type: "goal.drop", goalId: id, note: "用户结束" });
    },
  });
  assert.equal(result?.phase, "ready", result?.detail);
  const goal = (await f.services[0]!.read()).goals[0]!;
  assert.equal(goal.status, "dropped");
  assert.equal(goal.backendHandoff?.status, "skipped");
});
test("multiple switch clicks return one journal and do not run a second close/resume pipeline", async t => {
  const f = await fixture(t);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const first = f.control.switchTo("orca", {
    ...f.hooks,
    afterPersist: async phase => { if (phase === "prepared") { entered(); await waiting; } },
  });
  await enteredPromise;
  const second = await f.control.switchTo("orca", f.hooks);
  assert.equal(second?.phase, "prepared");
  assert.equal(f.calls.length, 0);
  release();
  const done = await first;
  assert.equal(done?.operationId, second?.operationId);
  assert.equal(f.calls.filter(call => call.startsWith("close:")).length, 1);
});
test("leases admitted before freeze can finish; a late result after epoch change cannot bind", async t => {
  const f = await fixture(t);
  let release!: () => void, admitted!: () => void;
  const start = new Promise<void>(resolve => { admitted = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const operation = f.control.operation({
    workspace: f.services[0]!.root, requestId: "lease-one", kind: "send",
  }, async () => { admitted(); await blocked; return "receipt"; });
  await start;
  const attempt = await f.control.switchTo("orca", f.hooks);
  assert.equal(attempt?.phase, "cancelled");
  assert.deepEqual(f.calls, []);
  release();
  assert.equal(await operation, "receipt");
  assert.equal((await f.control.switchTo("orca", f.hooks))?.phase, "ready");
});
test("Orca update freezes transport across CLI instances but semantic messages stay writable", async t => {
  const f = await fixture(t);
  await f.control.switchTo("orca", f.hooks);
  const id = await f.control.beginMaintenance("orca");
  assert(id);
  const second = new SessionControl(f.control.directory);
  assert.equal(await second.canDispatch(), false);
  await assert.rejects(second.operation({
    workspace: f.services[0]!.root, requestId: "update-launch", kind: "create",
  }, async () => {}), /backend_switch_in_progress/);
  await f.services[0]!.execute({ type: "goal.message", goalId: f.goals[0]!.id, text: "更新期间保存补充" });
  await assert.rejects(f.control.switchTo("herdr", f.hooks), /正在更新/);
  await f.control.endMaintenance(id);
  assert.equal(await second.canDispatch(), true);
});
test("partial shutdown can explicitly restore the source using a new epoch and new identities", async t => {
  const f = await fixture(t, 2);
  f.rejectClose("binding-1");
  assert.equal((await f.control.switchTo("orca", f.hooks))?.phase, "recovery_required");
  f.rejectClose("");
  const restored = await f.control.restoreOriginal(f.hooks);
  assert.equal(restored.phase, "ready", restored.detail);
  assert.equal(restored.to, "herdr");
  assert.equal((await f.control.status()).selected, "herdr");
  assert.equal((await f.control.status()).epoch, 1);
  assert(restored.restoresOperationId);
  assert.equal(f.calls.filter(call => call === "close:binding-0").length, 1);
});
test("cancel before closing any resource keeps the old epoch and releases the barrier", async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  const result = await f.control.switchTo("orca", f.hooks, controller.signal);
  assert.equal(result?.phase, "cancelled");
  assert.equal((await f.control.status()).epoch, 0);
  assert.equal(await f.control.canDispatch(), true);
  assert.deepEqual(f.calls, []);
});

test("a restart at every persisted transaction phase resumes without repeating verified side effects", async t => {
  for (const phase of ["preflight", "prepared", "quiescing", "old_stopped", "committing", "resuming"] as const) {
    const f = await fixture(t, 2);
    const first = await f.control.switchTo("orca", {
      ...f.hooks,
      afterAdmission: async () => { if (phase === "preflight") throw new Error("injected process death"); },
      afterPersist: async current => { if (current === phase) throw new Error("injected process death"); },
    });
    assert(first);
    assert.equal(first.phase, ["prepared", "quiescing"].includes(phase) ? "cancelled" : "recovery_required", `${phase}: ${first.detail}`);
    if (["prepared", "quiescing"].includes(phase)) {
      // The injected return from a durable marker happens before any close
      // side effect, so an in-process caller may safely cancel. Real process
      // loss still uses recovery_required and is covered below.
      assert.deepEqual(f.calls, []);
      await f.control.switchTo("herdr", f.hooks);
      continue;
    }
    const restarted = new SessionControl(f.control.directory);
    const configuration = await restarted.initialize({ recoverInterrupted: true });
    assert.equal(configuration.phase, "recovery_required", `${phase}: ${first.detail}`);
    for (const service of f.services)
      await assert.rejects(restarted.operation({ workspace: service.root,
        requestId: `frozen-${phase}`, kind: "create" }, async () => {}), /backend_switch_in_progress/);
    const recovered = await restarted.retrySwitch(f.hooks);
    assert.equal(recovered.phase, "ready", `${phase}: ${recovered.detail}`);
    assert.equal(f.calls.filter(call => call === "close:binding-0").length, 1, phase);
    assert.equal(f.calls.filter(call => call === "close:binding-1").length, 1, phase);
    for (const service of f.services) {
      const state = await service.read();
      assert.equal(state.backendEpoch, 1);
      assert.equal(state.backendBinding?.backend, "orca");
      assert.equal(state.backendBinding?.status, "active");
    }
    assert.equal(await restarted.canDispatch(), true);
  }
});

test("a durable preflight interruption recovers without touching a live old scene", async t => {
  const f = await fixture(t, 2);
  const interrupted = await f.control.switchTo("orca", {
    ...f.hooks,
    afterAdmission: () => { throw new Error("injected process loss after admission"); },
  });
  assert.equal(interrupted?.phase, "recovery_required");
  assert.equal(interrupted?.resumePhase, "preflight");
  assert.deepEqual(f.calls, []);
  const restarted = new SessionControl(f.control.directory);
  assert.equal((await restarted.initialize({ recoverInterrupted: true })).phase, "recovery_required");
  const recovered = await restarted.retrySwitch(f.hooks);
  assert.equal(recovered.phase, "ready", recovered.detail);
  for (const id of ["binding-0", "binding-1"])
    assert.equal(f.calls.filter(call => call === `close:${id}`).length, 1);
  assert.equal(await restarted.canDispatch(), true);
});

test("a message appended while the switch is draining keeps one identity through delivery", async t => {
  const f = await fixture(t);
  const item = f.goals[0]!;
  let allowPreflight = () => {};
  const gate = new Promise<void>(resolve => { allowPreflight = resolve; });
  const pending = f.control.switchTo("orca", {
    ...f.hooks,
    adapter: async (backend, workspace) => {
      if (backend === "herdr") await gate;
      return f.hooks.adapter(backend, workspace);
    },
  });
  const before = (await f.services[0]!.read()).goals[0]!;
  const updated = await f.services[0]!.execute({
    type: "goal.message", goalId: item.id, text: "切换尚未完成时补充的新要求",
  }) as Goal;
  assert.notEqual(updated.dispatch?.id, before.dispatch?.id);
  assert.equal(updated.dispatch?.status, "pending");
  const originalId = updated.dispatch?.id;
  allowPreflight();
  assert.equal((await pending)?.phase, "ready");
  const current = (await f.services[0]!.read()).goals[0]!;
  assert.equal(current.dispatch?.id, originalId);
  assert.equal(current.activities.filter(activity =>
    activity.kind === "message" && activity.text === "切换尚未完成时补充的新要求").length, 1);
  assert.equal(f.calls.filter(call => call === `deliver:${originalId}`).length, 1);
  assert.equal(current.dispatch?.status, "sent");
  assert.equal(current.scene, undefined, "switch fixture closes without fabricating a new owner");
  assert.equal(current.backendHandoff?.status, "accepted");
});

test("a failure after the first workspace commits cannot be resumed with a partially supplied workspace set", async t => {
  const f = await fixture(t, 2);
  let failed = false;
  const result = await f.control.switchTo("orca", {
    ...f.hooks,
    afterPersist: async (phase, journal) => {
      if (phase === "committing" && journal.workspaces[0]?.committed && !failed) {
        failed = true;
        throw new Error("injected host loss after first commit");
      }
    },
  });
  assert(result);
  assert.equal(result.phase, "recovery_required");
  const restarted = new SessionControl(f.control.directory);
  await restarted.initialize({ recoverInterrupted: true });
  const recovered = await restarted.retrySwitch({
    ...f.hooks,
    resume: async ({ workspace }) => {
      if (workspace.endsWith("workspace-1")) throw new Error("injected second workspace write failure");
    },
  });
  assert.equal(recovered.phase, "recovery_required");
  assert.equal(await restarted.canDispatch(), false);
  const final = await restarted.retrySwitch(f.hooks);
  assert.equal(final.phase, "ready", final.detail);
  for (const service of f.services)
    assert.equal((await service.read()).backendEpoch, 1);
});
