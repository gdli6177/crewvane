// This script owns its explicit isolated server and never touches the user's
// focused/default Herdr session. All resource IDs come from real receipts.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { HerdrAdapter, createLaunchFiles, startDetachedHerdrServer } from "../packages/sessions/src/index.ts";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const root = await realpath(await mkdtemp("/tmp/cv-hc-"));
const cwd = join(root, "个人 事项"), zdotdir = join(root, "zsh");
await Promise.all([mkdir(cwd), mkdir(zdotdir)]);
const executable = process.env.CREWVANE_TEST_HERDR_BINARY;
assert(executable, "Pass CREWVANE_TEST_HERDR_BINARY pointing to the tested Herdr binary.");
const session = `cv-${randomUUID().slice(0, 8)}`;
const environment = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "c"), XDG_STATE_HOME: join(root, "s") };
const binary = join(root, "fixture.cjs"), inputFile = join(root, "input.bin"), factsFile = join(root, "facts.json");
await writeFile(binary, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(inputFile)}, "");
fs.writeFileSync(${JSON.stringify(factsFile)},JSON.stringify({
  cwd:process.cwd(),args:process.argv.slice(2),goal:process.env.CREWVANE_GOAL_ID,pane:process.env.HERDR_PANE_ID
}));
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write("Fixture ready\\r\\n");
process.stdin.on("data",b=>fs.appendFileSync(${JSON.stringify(inputFile)},b));
`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(zdotdir, ".zshrc"), `alias cursor-2=${quote(`${quote(process.execPath)} ${quote(binary)}`)}\n`);
const server = spawn(executable, ["server"], { env: { ...environment, HERDR_SESSION: session,
  HERDR_STARTUP_CWD: cwd, HERDR_MACOS_SERVER_CONTEXT: "user" }, cwd, stdio: "ignore" });
let scene;
const adapter = new HerdrAdapter({
  executable, session, directory: join(root, "control"), environment,
  shellEnvironment: { ZDOTDIR: zdotdir },
  run: async (args, timeout = 5_000) => {
    const { stdout } = await promisify(execFile)(executable, ["--session", session, ...args],
      { env: environment, timeout, maxBuffer: 2_000_000 });
    // Isolated fixture only; never record arbitrary terminal output.
    if (args[0] !== "--version" && args[0] !== "status")
      await writeFile(join(root, `${args[0]}-${args[1]}.json`), stdout);
    return stdout;
  },
});
try {
  let runtime;
  for (let i = 0; i < 40; i++) {
    try { runtime = await adapter.connect({ cwd, installationId: "contract-test" }); break; }
    catch { await delay(100); }
  }
  assert(runtime, "Isolated server must be reachable.");
  const requestId = randomUUID(), bindingId = randomUUID(), attemptId = randomUUID();
  const files = await createLaunchFiles(join(root, "control"), {
    requestId, bindingId, attemptId, installationId: "contract-test", backendEpoch: 0,
    cwd, executable: "cursor-2", args: ["test 中文"],
    environment: { CREWVANE_BACKEND: "herdr", CREWVANE_GOAL_ID: "test-goal" },
  });
  const request = { requestId, bindingId, attemptId, installationId: "contract-test", backendEpoch: 0,
    role: "owner", cwd, title: "Crewvane private contract", ...files };
  const created = await adapter.create(request);
  assert.equal(created.status, "created", created.detail);
  scene = created.scene;
  assert(scene?.backend === "herdr");
  for (let i = 0; i < 40; i++) {
    try { await readFile(factsFile); break; } catch { await delay(100); }
  }
  const facts = JSON.parse(await readFile(factsFile, "utf8"));
  assert.equal(facts.cwd, cwd);
  assert.deepEqual(facts.args, ["test 中文"]);
  assert.equal(facts.goal, "test-goal");
  assert.equal(facts.pane, scene.locator.paneId);
  assert.deepEqual(await adapter.focus(scene), { status: "focused", navigated: true });
  const text = "完整消息🚢 ABC ".repeat(2_000), deliveryId = randomUUID();
  const input = { scene, text, deliveryId, payloadSha256: createHash("sha256").update(text).digest("hex") };
  const receipt = await adapter.send(input);
  assert.equal(receipt.status, "accepted", receipt.detail);
  assert.deepEqual(await adapter.send(input), receipt);
  let received;
  for (let i = 0; i < 40; i++) {
    received = await readFile(inputFile);
    if (received.length >= Buffer.byteLength(text) + 1) break;
    await delay(100);
  }
  assert.deepEqual(received, Buffer.from(text + "\r"));
  const discovered = await adapter.discover({ installationId: "contract-test", runtimeId: runtime.id, requestId });
  assert.equal(discovered.length, 1);
  assert.deepEqual((await adapter.create(request)).scene, scene);
  assert.equal((await adapter.close(scene)).status, "stopped");
  const manifest = { test: "herdr-session-contract", passed: true, version: runtime.version,
    alias: true, unicode: true, exactBytes: received.length, exactlyOnce: true, stopped: true, evidence: root };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest));
} finally {
  console.log(JSON.stringify({ evidence: root }));
  if (scene) await adapter.close(scene).catch(() => {});
  server.kill("SIGTERM");
}

// Exercise the adapter's own no-server path, not just the fixture's startup.
// Both sides use this exact shared launcher in the packaged desktop and CLI.
const recoveredRoot = await mkdtemp("/tmp/cv-hc-start-"), recoveredHome = join(recoveredRoot, "home");
await mkdir(recoveredHome);
const recoveredSession = `cv-${randomUUID().slice(0, 8)}`;
const recoveredEnvironment = { ...process.env, HOME: recoveredHome,
  XDG_CONFIG_HOME: join(recoveredHome, ".config"), XDG_STATE_HOME: join(recoveredHome, ".local/state") };
const recovered = new HerdrAdapter({ executable, session: recoveredSession,
  directory: join(recoveredRoot, "control"), environment: recoveredEnvironment });
try {
  const first = await recovered.connect({ installationId: "start-contract", cwd: recoveredRoot, startIfMissing: true });
  assert.equal(first.backend, "herdr");
  const status = JSON.parse((await promisify(execFile)(executable,
    ["--session", recoveredSession, "status", "--json"], { env: recoveredEnvironment, timeout: 5_000 })).stdout);
  assert.equal(status.server.running, true);
  const second = await recovered.connect({ installationId: "start-contract", cwd: recoveredRoot, startIfMissing: true });
  assert.equal(second.generation, first.generation, "An existing server is never replaced.");
  await writeFile(join(recoveredRoot, "manifest.json"), JSON.stringify({
    test: "herdr-adapter-start", passed: true, session: recoveredSession,
    persistentServer: true, existingServerReused: true,
  }, null, 2));
  console.log(JSON.stringify({ test: "herdr-adapter-start", passed: true, evidence: recoveredRoot }));
} finally {
  // Cleanup uses the known-good shared path if an assertion failed mid-start.
  startDetachedHerdrServer(executable, recoveredSession, recoveredRoot, recoveredEnvironment);
  await delay(500);
  await promisify(execFile)(executable, ["--session", recoveredSession, "server", "stop"],
    { env: recoveredEnvironment, timeout: 10_000 }).catch(() => {});
}
