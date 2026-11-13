// Opt-in real Codex trial through the packaged app, its CLI and an isolated
// Herdr server. Authentication is referenced by a symlink, never copied/logged.
import { _electron as electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceService } from "../packages/core/src/index.ts";

const exec = promisify(execFile);
const { version: appVersion } = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
);
const trial = await realpath(await mkdtemp("/tmp/cv-hooks-"));
const home = join(trial, "home"), workspace = join(trial, "workspace");
const userData = join(trial, "userData"), codexHome = join(home, ".codex");
const session = `cv-hooks-${Date.now().toString(36)}`;
const appPath = resolve(process.env.CREWVANE_APP_PATH ||
  "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane");
const codex = process.env.CREWVANE_TRIAL_CODEX ||
  (await exec("which", ["codex"])).stdout.trim();
for (const directory of [workspace, codexHome, join(home, ".local/bin")])
  await mkdir(directory, { recursive: true });
await symlink(codex, join(home, ".local/bin/codex"));
const sourceCodexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
await symlink(join(sourceCodexHome, "auth.json"), join(codexHome, "auth.json"));
// Keep only provider/model routing; never inherit notifications, MCP servers,
// project rules, user Hooks or the user's active app-server connection.
const providerConfig = (await readFile(join(sourceCodexHome, "config.toml"), "utf8"))
  .split(/^\[/m)[0].split("\n").filter(line =>
    /^(model|model_catalog_json|openai_base_url|service_tier)\s*=/.test(line));
await writeFile(join(codexHome, "config.toml"),
  `${providerConfig.join("\n")}\nmodel_reasoning_effort = "low"\n[features]\nhooks = true\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
  { mode: 0o600 });
await writeFile(join(workspace, "AGENTS.md"),
  "# 隔离 Hook 验收\n只处理当前临时目录；不读用户项目、不提交、不发布、不发送外部消息。\n");
const conciergeLog = join(trial, "concierge-input.jsonl");
const concierge = join(home, "local-concierge");
await writeFile(concierge, `#!${process.execPath}
const fs = require("node:fs"), readline = require("node:readline");
console.log("LOCAL_CONCIERGE_READY");
readline.createInterface({input:process.stdin}).on("line", line => {
  fs.appendFileSync(${JSON.stringify(conciergeLog)}, JSON.stringify({line})+"\\n");
});
`, { mode: 0o700 });
const service = new WorkspaceService(workspace);
await service.execute({
  type: "agents.configure",
  preferences: {
    concierge,
    // Explicit one-off trust applies ONLY to this freshly created, vetted
    // test HOME. Product launchers never add this flag to user commands.
    // Installation must still report waiting-trust until an event arrives.
    owner: "codex --no-daemon --no-alt-screen --dangerously-bypass-hook-trust",
  },
});
await service.execute({
  type: "workspace.autonomy.set",
  acceptance: "human-review",
  initialize: true,
  actor: "你",
});
const environment = {
  ...process.env, HOME: home, CODEX_HOME: codexHome,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
  CREWVANE_TEST_HOME: home, CREWVANE_TEST_USER_DATA: userData,
  CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: session,
  PATH: `${join(home, ".local/bin")}:${process.env.PATH || "/usr/bin:/bin"}`,
};
let app, page, herdrBinary, goalId;
const errors = [];
const trace = step => console.log(JSON.stringify({ step, trial, at: new Date().toISOString() }));
async function launchApp() {
  app = await electron.launch({ executablePath: appPath, env: environment, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.evaluate(() => window.crewvane.saveSceneSettings({
    openWith: "embedded", terminal: "auto",
  }));
  await expect.poll(async () => (await page.evaluate(() =>
    window.crewvane.herdrStatus())).installed, { timeout: 90_000 }).toBe(true);
  herdrBinary = (await page.evaluate(() => window.crewvane.herdrStatus())).executable;
}
async function herdr(args, timeout = 30_000) {
  const { stdout } = await exec(herdrBinary, ["--session", session, ...args],
    { env: environment, timeout, maxBuffer: 1_000_000 });
  return JSON.parse(stdout);
}
async function goal() { return (await service.read()).goals.find(item => item.id === goalId); }
try {
  await launchApp();
  await page.evaluate(() => window.crewvane.installCli());
  await page.evaluate(() => window.crewvane.configureAgentRuntime("codex", "install"));
  const status = (await page.evaluate(() => window.crewvane.agentRuntimeStatus()))
    .find(item => item.id === "codex");
  assert.equal(status.status, "waiting-trust");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "Agent 接入", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(trial, "agent-access-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await page.screenshot({ path: join(trial, "agent-access-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.evaluate(() => window.crewvane.prepareConcierge());
  const created = await service.execute({
    type: "goal.create",
    input: { title: "真实 Codex Hook 验收", projectId: "personal", mode: "concierge",
      description: "故障注入：先遗漏一次回执，再由自动提醒补交真实结果。" },
  });
  goalId = created.id;
  const cli = join(home, ".local/bin/crewvane");
  const taskPath = join(workspace, "hook-trial-task.txt");
  await writeFile(taskPath, [
    "这是隔离的 Hook 故障注入验收。本次故意模拟 Agent 忘记写回。",
    "这一回合只输出 CV_HOOK_FIRST_STOP，不运行任何工具，也不执行后文现场回写协议。",
    "等收到以 [CREWVANE_RECEIPT: 开头的系统提醒后，再运行真实命令补交结果：",
    `${cli} goal progress ${goalId} --root ${workspace} --summary "真实 Codex 已收到一次回执提醒，并成功写回结构化结果" --next "等待验收"`,
    "这条系统提醒不是用户新任务，不要用 direct 把它存成人的原话。",
  ].join("\n"));
  const launch = JSON.parse((await exec(cli, [
    "owner", "launch", goalId, "--name", "owner-hooks", "--task-file", taskPath, "--json",
  ], { env: { ...environment, HERDR_ENV: "1", HERDR_SESSION: session,
    CREWVANE_WORKSPACE: workspace, CREWVANE_HERDR_BINARY: herdrBinary },
  timeout: 190_000, maxBuffer: 1_000_000 })).stdout);
  assert.ok(launch.scene?.locator?.paneId || launch.result?.scene?.locator?.paneId);
  trace("owner-launched");
  await expect.poll(async () => (await goal())?.agentRuntime?.lastPrompt?.text,
    { timeout: 180_000, intervals: [500] }).toContain("故意模拟");
  await expect.poll(async () => (await goal())?.activities.filter(item =>
    item.kind === "session" && item.text.includes("已发送一次结构化回执提醒")).length,
  { timeout: 180_000, intervals: [500] }).toBe(1);
  trace("real-stop-reminded-once");
  await expect.poll(async () => (await goal())?.agentRuntime?.receipt?.status,
    { timeout: 180_000, intervals: [500] }).toBe("written");
  assert.ok((await goal()).activities.some(item =>
    item.kind === "progress" && item.text.includes("真实 Codex")));
  assert.equal((await goal()).attention, null);
  assert.equal((await goal()).status, "active");
  const attempt = (await goal()).agentRuntime.attempt.attemptId;
  const ownerPane = (await goal()).scene.locator.paneId;
  assert(ownerPane);
  const adapterStatus = (await page.evaluate(() => window.crewvane.agentRuntimeStatus()))
    .find(item => item.id === "codex");
  assert.equal(adapterStatus.status, "installed");
  assert.equal((await readdir(join(workspace, ".crewvane/runtime/spool"))
    .catch(() => [])).filter(name => name.endsWith(".json")).length, 0);
  trace("semantic-write-verified");
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.getByText("真实 Codex Hook 验收", { exact: true }).click();
  try {
    await expect(page.locator(".terminal-panel")).toBeVisible({ timeout: 8_000 });
  } catch (error) {
    const opened = await page.evaluate(id => window.crewvane.openScene(id), goalId);
    throw new Error(`Goal-row scene did not open; explicit IPC result: ${JSON.stringify(opened)}; ${error}`);
  }
  await page.getByRole("button", { name: "目标记录", exact: true }).click();
  await page.getByRole("region", { name: "Agent 运行状态" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(trial, "runtime-dark.png"), animations: "disabled" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.screenshot({ path: join(trial, "runtime-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await herdr(["agent", "wait", ownerPane, "--timeout", "120000"], 130_000);
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await expect(page.locator(".goal-row").filter({ hasText: "真实 Codex Hook 验收" })
    .getByText("本轮已回报", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: join(trial, "real-written-idle-list.png"), animations: "disabled" });
  await app.close(); app = undefined;
  await herdr(["agent", "prompt", ownerPane,
    `现场补充验收：仅运行 ${cli} goal progress ${goalId} --root ${workspace} --summary "应用关闭期间已真实写回" --next "恢复应用检查离线事件"，然后回复 CV_HOOK_OFFLINE_DONE。`,
    "--wait", "--timeout", "120000"], 130_000);
  const spool = join(workspace, ".crewvane/runtime/spool");
  await expect.poll(async () => (await readdir(spool).catch(() => []))
    .filter(name => name.endsWith(".json")).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await launchApp();
  await expect.poll(async () => (await readdir(spool).catch(() => []))
    .filter(name => name.endsWith(".json")).length, { timeout: 30_000 }).toBe(0);
  assert.equal((await goal()).agentRuntime.attempt.attemptId, attempt);
  assert.equal((await goal()).agentRuntime.receipt?.status, "written");
  assert.ok((await goal()).agentRuntime.lastReply?.text.includes("CV_HOOK_OFFLINE_DONE"));
  // Measure the shipped CLI process, Socket and real persistent Broker together,
  // rather than measuring an in-process mock transport.
  const benchmark = await service.execute({
    type: "goal.create",
    input: { title: "Hook 传输性能夹具", projectId: "personal", mode: "manual" },
  });
  const benchmarkToken = randomBytes(32).toString("hex");
  const benchmarkAttempt = `attempt_perf_${Date.now()}`;
  await service.execute({
    type: "agent.runtime.register", goalId: benchmark.id,
    attempt: { goalId: benchmark.id, attemptId: benchmarkAttempt,
      agent: "owner-performance", adapter: "codex", startedAt: new Date().toISOString() },
    hookTokenHash: createHash("sha256").update(benchmarkToken).digest("hex"),
    capabilities: ["session.started"],
  });
  const benchmarkEnvironment = {
    ...environment, CREWVANE_WORKSPACE: workspace,
    CREWVANE_GOAL_ID: benchmark.id, CREWVANE_ATTEMPT_ID: benchmarkAttempt,
    CREWVANE_AGENT_NAME: "owner-performance", CREWVANE_HOOK_TOKEN: benchmarkToken,
  };
  async function invokeHook(extra = {}) {
    const began = performance.now();
    await new Promise((resolve, reject) => {
      const child = execFile(cli, ["hook", "ingest", "--adapter", "codex"],
        { env: { ...benchmarkEnvironment, ...extra }, timeout: 5_000 },
        error => error ? reject(error) : resolve());
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart" }));
    });
    return performance.now() - began;
  }
  const hookTimings = [];
  await page.evaluate(() => window.crewvane.openTerminal());
  await expect(page.locator(".terminal-panel")).toBeVisible();
  for (let sample = 0; sample < 25; sample++) hookTimings.push(await invokeHook());
  await expect(page.locator(".terminal-panel")).toBeVisible();
  const hookP95 = hookTimings.sort((a, b) => a - b)[Math.ceil(hookTimings.length * .95) - 1];
  const offlineHookMs = await invokeHook({ CREWVANE_HOOK_SOCKET: join(trial, "offline.sock") });
  assert.ok(hookP95 < 250, `packaged Hook p95 ${hookP95.toFixed(1)} ms`);
  assert.ok(offlineHookMs < 500, `packaged offline Hook ${offlineHookMs.toFixed(1)} ms`);
  await service.execute({ type: "goal.complete", goalId: benchmark.id, note: "性能夹具已验证" });
  assert.deepEqual(errors, []);
  await writeFile(join(trial, "verified-summary.json"), JSON.stringify({
    version: appVersion, goalId, attempt, adapterStatus: adapterStatus.status,
    reminders: (await goal()).activities.filter(item => item.kind === "session" &&
      item.text.includes("已发送一次结构化回执提醒")).length,
    receipt: (await goal()).agentRuntime.receipt?.status,
    offlineRecovered: true,
    hookP95Ms: hookP95, offlineHookMs,
  }, null, 2));
  trace("passed");
} catch (error) {
  if (page) await page.screenshot({ path: join(trial, "failure.png") }).catch(() => {});
  const current = goalId ? await goal().catch(() => undefined) : undefined;
  const pane = current?.scene?.locator?.paneId;
  if (pane && herdrBinary) {
    const result = await exec(herdrBinary, ["--session", session, "pane", "read", pane,
      "--source", "recent-unwrapped", "--lines", "100"], {
      env: environment, timeout: 10_000, maxBuffer: 100_000,
    }).catch(error => ({ stdout: String(error) }));
    await writeFile(join(trial, "failure-terminal.txt"), result.stdout);
  }
  if (goalId) await writeFile(join(trial, "failure-goal.json"),
    JSON.stringify(await goal(), null, 2));
  console.error(JSON.stringify({ result: "failed", trial, error: String(error) }));
  throw error;
} finally {
  if (herdrBinary)
    await herdr(["server", "stop"], 10_000).catch(() => {});
  await app?.close().catch(() => {});
  // Only the temporary reference to auth is removed; the user's file is untouched.
  await rm(join(codexHome, "auth.json"), { force: true });
}
