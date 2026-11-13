// Focused real OMP transport trial. Owns only its isolated backend resources.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { HerdrAdapter, OrcaAdapter, createLaunchFiles } from "../packages/sessions/src/index.ts";

const backend = process.env.CREWVANE_OMP_DELIVERY_BACKEND ?? "herdr";
assert(["herdr", "orca"].includes(backend));
const profile = process.env.CREWVANE_TEST_ORCA_PROFILE;
if (backend === "orca") assert(profile?.startsWith("/private/tmp/"), "Use an isolated Orca profile.");
const executable = resolve(process.env.CREWVANE_TEST_HERDR_BINARY ||
  "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/Resources/herdr");
const agent = process.env.CREWVANE_TRIAL_AGENT;
assert(agent?.startsWith("/"), "Choose a real installed OMP executable or wrapper.");
const root = await realpath(await mkdtemp("/tmp/cv-omp-transport-"));
const cwd = join(root, "工作 区");
await mkdir(cwd);
const session = `cv-omp-${randomUUID().slice(0, 8)}`;
const environment = {
  ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "config"),
  XDG_STATE_HOME: join(root, "state"), ...(profile ? { ORCA_USER_DATA_PATH: profile } : {}),
};
const server = backend === "herdr" ? spawn(executable, ["--session", session, "server"], {
  env: environment, stdio: "ignore",
}) : undefined;
const nativeAgentShapes = [];
const orca = "/Applications/Orca.app/Contents/Resources/bin/orca";
const adapter = backend === "orca" ? new OrcaAdapter({
  appPath: "/Applications/Orca.app", directory: join(root, "control"), environment,
  run: async (args, timeout) => {
    const { stdout } = await promisify(execFile)(orca, args, { env: environment, timeout, maxBuffer: 2_000_000 });
    if (args[0] === "worktree" && args[1] === "ps") {
      const data = JSON.parse(stdout);
      for (const item of (data.result?.worktrees ?? []).flatMap(item => item.agents ?? [])) {
        const shape = { keys: Object.keys(item), agent: item.agent, kind: item.kind,
          type: item.type, program: item.program, label: item.label };
        if (!nativeAgentShapes.some(value => JSON.stringify(value) === JSON.stringify(shape))) {
          nativeAgentShapes.push(shape);
          console.log(JSON.stringify({ nativeAgentShape: shape }));
        }
      }
    }
    return stdout;
  },
}) : new HerdrAdapter({
  executable, session, directory: join(root, "control"), environment,
  run: async (args, timeout = 5_000) => {
    const { stdout } = await promisify(execFile)(executable, ["--session", session, ...args],
      { env: environment, timeout, maxBuffer: 2_000_000 });
    if (args[0] === "agent" && args[1] === "list") {
      const data = JSON.parse(stdout);
      for (const item of data.result?.agents ?? data.agents ?? []) {
        const shape = {
          keys: Object.keys(item),
          agent: item.agent, agent_kind: item.agent_kind, kind: item.kind,
        };
        if (!nativeAgentShapes.some(value => JSON.stringify(value) === JSON.stringify(shape))) {
          nativeAgentShapes.push(shape);
          console.log(JSON.stringify({ nativeAgentShape: shape }));
        }
      }
    }
    return stdout;
  },
});
let scene;
try {
  let connected = false;
  for (let i = 0; i < 50; i++) {
    try {
      await adapter.connect({ cwd, installationId: "omp-transport-trial" });
      connected = true; break;
    } catch { await delay(100); }
  }
  assert(connected, "Isolated Herdr must become reachable.");
  const requestId = randomUUID(), bindingId = randomUUID(), attemptId = randomUUID();
  const files = await createLaunchFiles(join(root, "control"), {
    requestId, bindingId, attemptId, installationId: "omp-transport-trial", backendEpoch: 0,
    executable: agent, args: [], cwd, environment: { CREWVANE_BACKEND: backend },
  });
  const created = await adapter.create({
    requestId, bindingId, attemptId, installationId: "omp-transport-trial", backendEpoch: 0,
    role: "owner", cwd, title: "Crewvane OMP transport trial", ...files,
  });
  assert.equal(created.status, "created", created.detail);
  scene = created.scene;
  assert(scene);
  for (let i = 0; i < 100; i++) {
    const observation = await adapter.inspect(scene);
    if (observation.state === "idle" && nativeAgentShapes.length) break;
    await delay(100);
  }
  assert(nativeAgentShapes.length, "Real Herdr must recognize OMP before sending.");
  const proof = join(cwd, "proof.txt"), marker = randomUUID();
  const scenario = process.env.CREWVANE_OMP_DELIVERY_SCENARIO ?? "multiline";
  const background = scenario === "long"
    ? `背景：${"需要保留的单一案卷背景。".repeat(700)}`
    : Array.from({ length: 120 }, (_, index) =>
      `背景 ${index + 1}：保留当前案卷事实，不能把终端空闲解释为任务完成。`).join("\n");
  const text = [
    "这是隔离的 Crewvane 传输验收，只处理本次消息，不访问其他用户文件。",
    `先完整读取背景，再用文件工具把 ${JSON.stringify(marker)} 原样写入 ${JSON.stringify(proof)}，然后结束。`,
    "不得执行 Git、发布、通知或其他外部操作。",
    background,
    `最终校验值：${marker}`,
  ].join("\n");
  if (scenario === "long") assert(Buffer.byteLength(text) > 12_000);
  else {
    assert(Buffer.byteLength(text) < 12_000);
    assert(text.split("\n").length > 100);
  }
  const receipt = await adapter.send({
    scene, deliveryId: "omp-long-real", text,
    payloadSha256: createHash("sha256").update(text).digest("hex"),
  });
  console.log(JSON.stringify({ receipt: { status: receipt.status, detail: receipt.detail } }));
  assert.equal(receipt.status, "started", receipt.detail);
  let content;
  for (let i = 0; i < 120; i++) {
    content = await readFile(proof, "utf8").catch(() => "");
    if (content.includes(marker)) break;
    await delay(1000);
  }
  assert(content?.includes(marker), "Real OMP must read the exact long payload and produce its proof.");
  await writeFile(join(root, "manifest.json"), JSON.stringify({
    passed: true, backend, session, scenario, payloadBytes: Buffer.byteLength(text),
    payloadLines: text.split("\n").length, nativeAgentShapes,
    receiptStatus: receipt.status,
  }, null, 2));
  console.log(JSON.stringify({ passed: true, evidence: root }));
} finally {
  console.log(JSON.stringify({ evidence: root }));
  if (scene && backend === "orca") {
    const observed = await promisify(execFile)(orca, ["terminal", "read", "--terminal",
      scene.locator.terminalHandle, "--screen", "--limit", "100", "--environment", "local", "--json"],
    { env: environment, timeout: 10_000, maxBuffer: 200_000 }).catch(error => ({ stdout: String(error) }));
    await writeFile(join(root, "terminal-screen.json"), observed.stdout);
  }
  if (scene) await adapter.close(scene).catch(() => {});
  server?.kill("SIGTERM");
}
