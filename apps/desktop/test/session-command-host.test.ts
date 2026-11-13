import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WorkspaceService, type Goal, type ManagedSessionContext, type SceneReferenceV1 } from "../../../packages/core/src/index.js";
import { SessionControl, SessionRuntime } from "../../../packages/sessions/src/index.js";
import { SessionCommandHost } from "../electron/session-command-host.js";
import { writeCoordinatorScope } from "../electron/coordinator-scope.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-session-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const service = new WorkspaceService(workspace);
  const goal = await service.execute({ type: "goal.intake", text: "独立负责人" }) as Goal;
  const control = new SessionControl(join(root, "control"));
  const configuration = await control.initialize();
  await control.registerWorkspace(workspace);
  const concierge: SceneReferenceV1 = {
    version: 1, backend: "herdr", installationId: configuration.installationId,
    runtimeId: "runtime", runtimeGeneration: "generation", backendEpoch: 0,
    attemptId: "concierge-attempt", bindingId: "concierge-binding",
    locator: { kind: "herdr", session: "test", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
  };
  await service.execute({ type: "scene.bind", role: "concierge", scene: concierge });
  await writeCoordinatorScope(workspace, goal.id, "case-request");
  const context: ManagedSessionContext = {
    installationId: configuration.installationId, backend: "herdr", epoch: 0,
    scopeGeneration: configuration.scopeGeneration, role: "concierge",
    attemptId: concierge.attemptId, goalId: goal.id,
  };
  let calls = 0, dispatchable = true;
  const host = () => new SessionCommandHost({
    workspace, directory: control.directory, canDispatch: async () => dispatchable,
    runtime: supplied => {
      assert.deepEqual(supplied, context);
      return {
        launchOwner: async input => {
          calls++;
          assert.equal(input.goalId, goal.id);
          return { goalId: goal.id, runtime: "fixture", scene: concierge };
        },
        send: async (scene, deliveryId) => {
          calls++;
          return { status: "started", deliveryId, scene, payloadSha256: "a".repeat(64), at: new Date().toISOString() };
        },
      };
    },
  });
  const active = host();
  await active.start();
  t.after(() => active.stop());
  const client = (managedContext = context) => new SessionRuntime({
    workspace, control, managedContext, cliDirectory: join(root, "bin"),
    adapter: async () => { throw new Error("restricted Agent must not inspect processes or call a backend"); },
  });
  return { root, workspace, control, service, goal, context, client, active, host, calls: () => calls,
    block: () => { dispatchable = false; } };
}

test("managed launch and send execute in the desktop host without caller-side process admission", async t => {
  const f = await fixture(t);
  const result = await f.client().launchOwner({ goalId: f.goal.id, name: "owner-test" });
  const receipt = await f.client().send(result.scene, "message-one", "真实后续消息");
  assert.equal(receipt.status, "started");
  assert.equal(f.calls(), 2);
});

test("the real owner-launch CLI works when the Agent cannot execute ps", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  const exec = promisify(execFile);
  const policy = '(version 1)(allow default)(deny process-exec (literal "/bin/ps"))';
  await assert.rejects(exec("/usr/bin/sandbox-exec", ["-p", policy, "/bin/ps", "-p", String(process.pid)]),
    "the reproduction must actually prohibit caller-side process inspection");
  const result = await exec("/usr/bin/sandbox-exec", [
    "-p", policy, process.execPath, "--import", "tsx", "cli/src/main.ts",
    "owner", "launch", f.goal.id, "--name", "owner-sandbox", "--root", f.workspace, "--json",
  ], { cwd: new URL("../../../", import.meta.url), timeout: 10_000, env: {
    ...process.env, HOME: f.root, CREWVANE_WORKSPACE: f.workspace,
    CREWVANE_AGENT_NAME: "concierge", CREWVANE_COORDINATOR: "1",
    CREWVANE_SESSION_CONTEXT: JSON.stringify(f.context),
    CREWVANE_CONTROL_DIRECTORY: f.control.directory, CREWVANE_CLI_DIRECTORY: join(f.root, "bin"),
    CREWVANE_COORDINATOR_SCOPE_FILE: join(f.workspace, ".crewvane", "coordinator-scope.json"),
  } });
  assert.equal(JSON.parse(result.stdout).goalId, f.goal.id);
  assert.equal(f.calls(), 1);
});

test("host rejects stale attempts, epochs, roles, cross-case launch and switch-time requests", async t => {
  const f = await fixture(t);
  for (const context of [
    { ...f.context, attemptId: "old-attempt" },
    { ...f.context, epoch: 9 },
    { ...f.context, role: "owner" as const },
    { ...f.context, goalId: "another-goal" },
  ])
    await assert.rejects(f.client(context).launchOwner({ goalId: f.goal.id, name: "owner-test" }), /不属于/);
  await assert.rejects(f.client().launchOwner({ goalId: "another-goal", name: "owner-test" }), /参数无效/);
  f.block();
  await assert.rejects(f.client().launchOwner({ goalId: f.goal.id, name: "owner-test" }), /正在交接/);
  assert.equal(f.calls(), 0);
});

test("a surviving concierge discovers a restarted desktop without inheriting stale endpoint tokens", async t => {
  const f = await fixture(t);
  const client = f.client();
  await client.launchOwner({ goalId: f.goal.id, name: "owner-before" });
  await f.active.stop();
  const replacement = f.host();
  await replacement.start();
  t.after(() => replacement.stop());
  await client.launchOwner({ goalId: f.goal.id, name: "owner-after" });
  assert.equal(f.calls(), 2);
});
