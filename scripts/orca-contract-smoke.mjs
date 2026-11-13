// Run with tsx. Uses an explicitly isolated Orca profile that the test runner
// has started; it never scans or closes a user's normal Orca resources.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OrcaAdapter, createLaunchFiles } from "../packages/sessions/src/index.ts";

const profile = process.env.CREWVANE_TEST_ORCA_PROFILE;
assert(profile && profile.startsWith("/private/tmp/"), "Pass an isolated CREWVANE_TEST_ORCA_PROFILE, never a normal user profile.");
const root = await realpath(await mkdtemp(join(tmpdir(), "cv-orca-contract-")));
const cwd = join(root, "个人 事项");
const shell = join(root, "shell");
await Promise.all([mkdir(cwd), mkdir(shell)]);
const fixture = join(root, "fixture.cjs");
const inputPath = join(root, "received.bin"), factsPath = join(root, "agent.json");
await writeFile(fixture, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(inputPath)}, "");
fs.writeFileSync(${JSON.stringify(factsPath)}, JSON.stringify({
  cwd: process.cwd(), argv: process.argv.slice(2), pid: process.pid,
  goal: process.env.CREWVANE_GOAL_ID, attempt: process.env.CREWVANE_ATTEMPT_ID,
  handle: process.env.ORCA_TERMINAL_HANDLE, pathEntries: process.env.PATH.split(":").length,
}));
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write("Crewvane private fixture ready\\r\\n");
process.stdin.on("data", b => fs.appendFileSync(${JSON.stringify(inputPath)}, b));
`);
const quoted = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(shell, ".zshrc"), [
  `alias cursor-2=${quoted(`${quoted(process.execPath)} ${quoted(fixture)}`)}`,
  `export PATH=${quoted(Array.from({ length: 1_000 }, (_, i) => `/tmp/cv-long-path-${i}`).join(":"))}:$PATH`,
  "",
].join("\n"));
const appPath = process.env.CREWVANE_TEST_ORCA_APP ?? "/Applications/Orca.app";
const adapter = new OrcaAdapter({
  appPath, directory: join(root, "control"),
  environment: { ...process.env, ORCA_USER_DATA_PATH: profile },
  shellEnvironment: { ZDOTDIR: shell },
});
const detection = await adapter.detect();
assert.equal(detection.status, "compatible", detection.detail);
const runtime = await adapter.connect({ installationId: "cv-test-installation", cwd });
const requestId = randomUUID(), attemptId = randomUUID(), bindingId = randomUUID();
const files = await createLaunchFiles(join(root, "control"), {
  requestId, attemptId, bindingId, installationId: "cv-test-installation", backendEpoch: 0,
  cwd, executable: "cursor-2", args: ["--model", "test model 中文"],
  environment: {
    CREWVANE_GOAL_ID: "g0-test-goal", CREWVANE_ATTEMPT_ID: attemptId,
    CREWVANE_BACKEND: "orca", CREWVANE_BACKEND_EPOCH: "0", CREWVANE_WORKSPACE: cwd,
  },
});
const request = {
  requestId, attemptId, bindingId, installationId: "cv-test-installation", backendEpoch: 0,
  role: "owner", goalId: "g0-test-goal", cwd, title: "Crewvane contract fixture", ...files,
};
let scene;
try {
  const created = await adapter.create(request);
  assert.equal(created.status, "created", created.detail);
  scene = created.scene;
  assert(scene);
  assert.equal(scene.runtimeId, runtime.id);
  for (let i = 0; i < 30; i++) {
    try { await access(factsPath); break; } catch { await delay(100); }
  }
  const facts = JSON.parse(await readFile(factsPath, "utf8"));
  assert.equal(facts.cwd, cwd);
  assert.deepEqual(facts.argv, ["--model", "test model 中文"]);
  assert.equal(facts.goal, "g0-test-goal");
  assert.equal(facts.attempt, attemptId);
  assert(facts.pathEntries > 1_000);
  assert.equal(facts.handle, scene.locator.terminalHandle);
  const message = "完整上下文🚢 ABC ".repeat(2_000);
  const send = {
    deliveryId: randomUUID(), scene, text: message,
    payloadSha256: createHash("sha256").update(message).digest("hex"),
  };
  const receipt = await adapter.send(send);
  assert(["accepted", "started"].includes(receipt.status), receipt.detail);
  assert.deepEqual(await adapter.send(send), receipt);
  let received;
  for (let i = 0; i < 40; i++) {
    received = await readFile(inputPath);
    if (received.length >= Buffer.byteLength(message) + 1) break;
    await delay(100);
  }
  assert.deepEqual(received, Buffer.from(message + "\r"), "Payload must arrive exactly once, without Unicode corruption.");
  const discovered = await adapter.discover({ installationId: "cv-test-installation", runtimeId: runtime.id, requestId });
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0].scene, scene);
  assert.deepEqual((await adapter.create(request)).scene, scene, "Repeated create reuses the original receipt.");
  for (let i = 0; i < 20; i++) assert.equal((await adapter.focus(scene)).status, "focused");
  await assert.rejects(access(join(cwd, ".git")));
  const closed = await adapter.close(scene);
  assert.equal(closed.status, "stopped", closed.detail);
  const summary = {
    version: "v1", test: "orca-contract-smoke", appVersion: detection.version,
    runtime: runtime.id, passed: true, alias: true, unicodeCwd: true,
    longPATH: facts.pathEntries, receivedBytes: received.length, exactlyOnce: true,
    focused: 20, closed, nativeResume: await adapter.captureResume(scene),
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, evidence: root }));
} catch (error) {
  if (!scene) {
    const owned = await adapter.discover({ installationId: "cv-test-installation", runtimeId: runtime.id, requestId }).catch(() => []);
    for (const match of owned) await adapter.close(match.scene).catch(() => {});
  }
  if (scene) await adapter.close(scene).catch(() => {});
  console.error(`Orca evidence: ${root}`);
  throw error;
}
