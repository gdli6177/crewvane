import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionControl } from "../../packages/sessions/src/index.js";
import { WorkspaceService, type SceneReferenceV1 } from "../../packages/core/src/index.js";

test("the real scene focus CLI uses the shared runtime and rejects managed Agent invocation", async t => {
  const root = await mkdtemp(join(tmpdir(), "cv-scene-focus-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const socket = join(root, "fake-herdr.sock");
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(socket, resolve));
  t.after(() => new Promise<void>(resolve => listener.close(() => resolve())));
  const socketInfo = await lstat(socket);
  const workspace = join(root, "workspace"), directory = join(root, "control"), herdr = join(root, "herdr");
  await mkdir(workspace);
  const control = new SessionControl(directory);
  const configuration = await control.initialize();
  await control.registerWorkspace(workspace);
  const service = new WorkspaceService(workspace);
  const scene: SceneReferenceV1 = {
    version: 1, backend: "herdr", installationId: configuration.installationId,
    runtimeId: socket, runtimeGeneration: `${socket}:${socketInfo.dev}:${socketInfo.ino}:${socketInfo.birthtimeMs}`,
    bindingId: "binding-focus", attemptId: "attempt-focus", backendEpoch: 0,
    locator: { kind: "herdr", session: `focus-${Date.now()}`,
      workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
  };
  const { spawn } = await import("node:child_process");
  const shell = spawn("/bin/sh", ["-c", "while :; do sleep 60; done"], { stdio: "ignore" });
  assert(shell.pid);
  t.after(() => { shell.kill("SIGTERM"); });
  scene.process = { pid: shell.pid, bornAt: execFileSync("/bin/ps", ["-p", String(shell.pid), "-o", "lstart="], { encoding: "utf8" }).trim() };
  await service.execute({ type: "scene.prepare", intent: {
    requestId: "focus-launch", bindingId: scene.bindingId, attemptId: scene.attemptId,
    backendEpoch: 0, role: "concierge", agent: "concierge", status: "created",
    createdAt: new Date().toISOString(),
  } });
  await service.execute({ type: "scene.bind", scene, role: "concierge" });
  await writeFile(herdr, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(join(root, "calls"))}
case "$*" in
  *" status"*) printf '%s' '{"server":{"running":true,"compatible":true,"session":"${scene.locator.session}","socket":"${scene.runtimeId}","version":"0.9.5"}}' ;;
  *" agent list"*) printf '%s' '{"agents":[{"pane_id":"w1:p1","agent":"codex","agent_status":"idle"}]}' ;;
  *" pane list"*) printf '%s' '{"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1","focused":true}]}' ;;
esac
`, { mode: 0o700 });
  const environment = {
    PATH: `${join(root, "node_modules/.bin")}:${process.env.PATH}`,
    HOME: root,
    CREWVANE_CONTROL_DIRECTORY: directory,
    CREWVANE_CLI_DIRECTORY: join(root, "node_modules/.bin"),
    CREWVANE_HERDR_BINARY: herdr,
    CREWVANE_HERDR_SESSION: scene.locator.session,
    CREWVANE_WORKSPACE: workspace,
  };
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(join(root, "node_modules/.bin/tsx"), `#!/bin/sh\nexec ${process.execPath} ${join(process.cwd(), "node_modules/tsx/dist/cli.mjs")} "$@"`, { mode: 0o700 });
  const exec = promisify(execFile);
  const cli = fileURLToPath(import.meta.resolve("tsx/cli"));
  const entry = resolve(fileURLToPath(new URL(".", import.meta.url)), "../src/main.ts");
  const args = [cli, entry, "scene", "focus", "--root", workspace, "--json"];
  const { stdout } = await exec(process.execPath, args, {
    env: environment, timeout: 10_000,
  });
  assert.equal(JSON.parse(stdout).status, "focused");
  const calls = await readFile(join(root, "calls"), "utf8");
  assert.match(calls, /tab focus w1:t1/);
  assert.doesNotMatch(calls, /pane focus w1:p1/,
    "Herdr 0.9.5 pane focus requires a direction; an already focused Tab needs no extra command.");
  await assert.rejects(exec(process.execPath, args, {
    env: { ...environment, CREWVANE_AGENT_NAME: "concierge" }, timeout: 10_000,
  }), /只能由人/);
});
