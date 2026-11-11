// Real packaged-app regression: Finder PATH, native picker boundary, official
// Herdr download and a real interactive custom CLI (no model credentials).
import { _electron as electron, expect } from "@playwright/test";
import { access, mkdtemp, mkdir, writeFile, readFile, realpath, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { completeAutonomySetup } from "./lib/autonomy-setup.mjs";
const exec = promisify(execFile);
// macOS AF_UNIX has a short socket path limit. Keep isolated HOME/session short.
const home = await mkdtemp("/tmp/cv-onboarding-");
const session = `cv-${randomUUID().slice(0, 8)}`;
const userData = join(home, "userData");
const rootA = join(home, "所有事项"), rootB = join(home, "另一个工作区");
const legacy = join(home, "legacy");
const log = join(home, "custom-cli.jsonl"), customCli = join(home, "my custom agent");
const testEnvironment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"),
  PATH: "/usr/bin:/bin", CREWVANE_TEST_HOME: home,
  CREWVANE_TEST_USER_DATA: userData, CREWVANE_TEST_WORKSPACE: "",
  CREWVANE_TEST_ISOLATE_TOOLS: "1", CREWVANE_TEST_SKIP_HERDR_SETUP: "",
  CREWVANE_HERDR_SESSION: session };
await mkdir(rootA); await mkdir(rootB);
await mkdir(join(legacy, ".crewvane"), {recursive:true});
await writeFile(join(legacy, ".crewvane/state.json"), '{"version":1}');
await writeFile(customCli, `#!${process.execPath}
const fs = require("node:fs");
const readline = require("node:readline");
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({kind:"start", args:process.argv.slice(2),pid:process.pid})+"\\n");
console.log("CUSTOM_CLI_READY");
readline.createInterface({input:process.stdin}).on("line", text => {
 fs.appendFileSync(log, JSON.stringify({kind:"input",text})+"\\n");
 if (text === "STOP") process.exit(0);
});
`, { mode: 0o700 });
let app, installed, installedExecutable;
const errors = [];
async function picker(path, canceled = false) {
  await app.evaluate(({ dialog }, { path, canceled }) => {
    dialog.showOpenDialog = async () => ({ canceled, filePaths: canceled ? [] : [path] });
  }, { path, canceled });
}
try {
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env: testEnvironment,
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  // Keep the timed-out gate diagnosable without exposing environment or secrets.
  const trace = (step) => console.log(JSON.stringify({onboarding:step,at:new Date().toISOString()}));
  await page.getByRole("button", { name: "选择存储位置并开始" }).waitFor();
  trace("first-launch");
  // The app must install Herdr itself, with no Homebrew and no system Herdr.
  const installDeadline = Date.now() + 180_000;
  do {
    installed = await page.evaluate(() => window.crewvane.herdrStatus());
    if (installed.phase === "error")
      throw new Error(`Herdr 自动安装失败：${installed.detail ?? JSON.stringify(installed)}`);
    if (installed.installed && installed.phase === "ready" && installed.latestVersion) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < installDeadline);
  assert.ok(installed?.installed && installed.phase === "ready" && installed.latestVersion,
    `Herdr 自动安装超时：${JSON.stringify(installed)}`);
  assert.equal(installed.phase, "ready", JSON.stringify(installed));
  assert.ok(installed.executable, JSON.stringify(installed));
  assert.equal(installed.version, installed.latestVersion);
  installedExecutable = installed.executable;
  const { stdout } = await exec(installedExecutable, ["--version"]); assert.ok(stdout.includes(installed.version));
  await picker(rootA);
  await page.getByRole("button", { name: "选择存储位置并开始" }).click();
  await page.getByText("已打开工作区：所有事项", { exact: true }).waitFor();
  await completeAutonomySetup(page);
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  assert.equal((await page.evaluate(() => window.crewvane.environment())).workspace, await realpath(rootA));
  await expect.poll(async () => {
    const plugin = (await page.evaluate(() => window.crewvane.herdrStatus())).plugin;
    return plugin?.phase === "ready" && plugin.installed;
  }, { timeout: 60_000 }).toBe(true);
  const pluginStatus = await page.evaluate(() => window.crewvane.herdrStatus());
  assert.equal(pluginStatus.plugin.installed, true, JSON.stringify(pluginStatus));
  assert.equal(pluginStatus.plugin.path, join(userData, "herdr-plugin"));
  const pluginList = JSON.parse((await exec(installedExecutable,
    ["plugin", "list", "--plugin", "dev.crewvane", "--json"], { env: testEnvironment })).stdout);
  const plugin = pluginList.result.plugins[0];
  assert.equal(plugin.enabled, true);
  const pluginActions = plugin.actions.map(action => `${plugin.plugin_id}.${action.id}`);
  assert.ok(pluginActions.includes("dev.crewvane.attention"));
  assert.ok(pluginActions.includes("dev.crewvane.new-goal"));
  assert.ok(pluginActions.includes("dev.crewvane.concierge"));
  await page.getByRole("button", { name: "我的工作台", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0, "workspace overview is navigation, not a directory picker");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText("让外部 Agent 会使用 Crewvane", { exact: true }).waitFor();
  await page.getByRole("button", { name: "安装 / 更新 Skills", exact: true }).click();
  await expect.poll(() => access(join(home, ".agents/skills/crewvane/SKILL.md"))
    .then(() => true).catch(() => false)).toBe(true);
  assert.match(await readFile(join(home, ".agents/skills/crewvane/SKILL.md"), "utf8"), /crewvane ask/);
  await page.evaluate(async () => {
    await window.crewvane.writeClipboardText("Crewvane clipboard round trip");
  });
  assert.equal(await page.evaluate(() => window.crewvane.readClipboardText()), "Crewvane clipboard round trip");
  await page.getByRole("button", { name: "更换工作区", exact: true }).click();
  await page.getByRole("dialog").getByText("当前工作区", { exact: true }).waitFor();
  await page.getByRole("dialog").getByText(await realpath(rootA), { exact: true }).waitFor();
  // Re-selecting the same directory must acknowledge it.
  await page.getByRole("dialog").getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await page.getByText("你已在这个工作区。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  // Cancel preserves the workspace and keeps a meaningful selection surface.
  await picker(rootB, true);
  await page.getByRole("button", { name: "更换工作区", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "选择其他工作区文件夹" }).click();
  assert.equal((await page.evaluate(() => window.crewvane.environment())).workspace, await realpath(rootA));
  assert.equal(await page.getByRole("dialog").isVisible(), true);
  await picker(legacy);
  await page.getByRole("dialog").getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.crewvane.environment())).workspace
  ).toBe(await realpath(legacy));
  await completeAutonomySetup(page);
  await page.getByText("旧版工作区已自动保护", { exact: true }).waitFor();
  await page.screenshot({ path: join(home, "legacy-recovered-dark.png"), animations:"disabled" });
  const recovered = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
  assert.equal(recovered.recovery.reason, "unsupported-version");
  assert.equal(JSON.parse(await readFile(join(legacy, ".crewvane/state.json"), "utf8")).version, 3);
  assert.equal((await stat(recovered.recovery.archivedPath)).isDirectory(), true);
  assert.equal(
    JSON.parse(await readFile(join(recovered.recovery.archivedPath, "state.json"), "utf8")).version,
    1,
  );
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await page.screenshot({ path: join(home, "legacy-recovered-light.png"), animations:"disabled" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await page.getByRole("button", { name: "关闭恢复提示", exact: true }).click();
  await page.getByText("旧版数据继续保留在备份目录中。", { exact: true }).waitFor();
  assert.equal(await page.getByText("旧版工作区已自动保护", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "更换工作区", exact: true }).click();
  await picker(rootB);
  await page.getByRole("dialog").getByRole("button", { name: "选择其他工作区文件夹" }).click();
  await expect.poll(async () =>
    (await page.evaluate(() => window.crewvane.environment())).workspace
  ).toBe(await realpath(rootB));
  await completeAutonomySetup(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const command = `"${customCli}" --model "local test model"`;
  await page.getByLabel("管家启动命令").fill(command);
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  await page.getByText("Agent 偏好已保存，将用于新启动的会话。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "准备管家", exact: true }).click();
  trace("custom-cli-concierge");
  await expect.poll(async () => (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).concierge.status, {timeout:90_000}).toBe("ready");
  let state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
  assert.equal(state.concierge.transport, "pane");
  const firstReference = state.concierge;
  await exec(installedExecutable, [
    "--session", session, "tab", "focus", firstReference.tabId,
  ], { env: testEnvironment, timeout: 10_000 });
  const conciergeAction = JSON.parse((await exec(installedExecutable, [
    "--session", session, "plugin", "action", "invoke", "dev.crewvane.concierge",
  ], { env: testEnvironment, timeout: 30_000 })).stdout);
  assert.equal(conciergeAction.result.action.action_id, "concierge");
  const action = JSON.parse((await exec(installedExecutable, [
    "--session", session, "plugin", "action", "invoke", "dev.crewvane.attention",
  ], { env: testEnvironment, timeout: 30_000 })).stdout);
  assert.equal(action.result.action.action_id, "attention");
  let pluginPaneId;
  await expect.poll(async () => {
    const panes = JSON.parse((await exec(installedExecutable, [
      "--session", session, "pane", "list", "--workspace", firstReference.workspaceId,
    ], { env: testEnvironment })).stdout).result.panes;
    pluginPaneId = panes.find(pane => pane.label === "Crewvane 注意力")?.pane_id;
    return pluginPaneId ?? null;
  }, { timeout: 20_000 }).not.toBeNull();
  assert.match(pluginPaneId, new RegExp(`^${firstReference.workspaceId}:p\\d+$`));
  await exec(installedExecutable, [
    "--session", session, "pane", "wait-output", pluginPaneId,
    "--match", "CREWVANE", "--timeout", "10000",
  ], { env: testEnvironment, timeout: 20_000 });
  const boardOutput = (await exec(installedExecutable, [
    "--session", session, "pane", "read", pluginPaneId,
    "--source", "recent-unwrapped", "--lines", "100",
  ], { env: testEnvironment })).stdout;
  assert.match(boardOutput, /注意力控制台/);
  await exec(installedExecutable, [
    "--session", session, "pane", "close", pluginPaneId,
  ], { env: testEnvironment, timeout: 10_000 });
  const newGoalAction = JSON.parse((await exec(installedExecutable, [
    "--session", session, "plugin", "action", "invoke", "dev.crewvane.new-goal",
  ], { env: testEnvironment, timeout: 30_000 })).stdout);
  assert.equal(newGoalAction.result.action.action_id, "new-goal");
  let newGoalPaneId;
  await expect.poll(async () => {
    const panes = JSON.parse((await exec(installedExecutable, [
      "--session", session, "pane", "list", "--workspace", firstReference.workspaceId,
    ], { env: testEnvironment })).stdout).result.panes;
    newGoalPaneId = panes.find(pane => pane.label === "Crewvane 新目标")?.pane_id;
    return newGoalPaneId ?? null;
  }, { timeout: 20_000 }).not.toBeNull();
  await new Promise(resolve => setTimeout(resolve, 1_000));
  const newGoalPrompt = (await exec(installedExecutable, [
    "--session", session, "pane", "read", newGoalPaneId,
    "--source", "recent-unwrapped", "--lines", "80",
  ], { env: testEnvironment, timeout: 10_000 })).stdout;
  assert.match(newGoalPrompt, /要处理什么/);
  await exec(installedExecutable, [
    "--session", session, "pane", "run", newGoalPaneId,
    "Herdr 插件新建目标真实验收",
  ], { env: testEnvironment, timeout: 10_000 });
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return current.goals.some(goal => goal.title === "Herdr 插件新建目标真实验收");
  }, { timeout: 20_000 }).toBe(true);
  const eventPane = JSON.parse((await exec(installedExecutable, [
    "--session", session, "pane", "split", "--pane", firstReference.paneId,
    "--direction", "down", "--cwd", rootB, "--no-focus",
  ], { env: testEnvironment, timeout: 10_000 })).stdout).result.pane.pane_id;
  const eventGoal = await page.evaluate(() => window.crewvane.command({ type:"goal.create", input:{
    title:"Herdr 插件事件验收", projectId:"personal", mode:"manual",
  }}));
  await page.evaluate(({ goalId, reference }) => window.crewvane.command({
    type:"session.set", goalId, reference,
  }), {
    goalId: eventGoal.id,
    reference: {
      session, workspaceId: firstReference.workspaceId,
      paneId: eventPane, agent: "event-pane",
    },
  });
  await exec(installedExecutable, [
    "--session", session, "pane", "close", eventPane,
  ], { env: testEnvironment, timeout: 10_000 });
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return current.goals.find(goal => goal.id === eventGoal.id)?.live;
  }, { timeout: 20_000 }).toMatchObject({ state:"unknown", reachable:false });
  // A foreground PID proves process creation, not that its JS startup has
  // already opened the log. Wait for the fixture's actual readiness evidence.
  await expect.poll(() => readFile(log, "utf8").catch(() => ""), {timeout:10_000}).toContain('"kind":"start"');
  const started = JSON.parse((await readFile(log, "utf8")).split("\n")[0]);
  assert.deepEqual(started.args, ["--model", "local test model"]);
  assert.equal(started.pid, state.concierge.processId);
  await page.evaluate(() => window.crewvane.prepareConcierge());
  assert.equal((await readFile(log, "utf8")).split("\n").filter(line => line.includes('"kind":"start"')).length, 1);
  const longGoalRequest =
    `${"请保留全部约束并完成端到端验收。".repeat(14)}完整正文末尾标记-${randomUUID()}`;
  const longGoalTitle = Array.from(longGoalRequest).slice(0, 80).join("");
  assert.ok(Array.from(longGoalRequest).length > 160);
  trace("long-intake");
  page.setDefaultTimeout(90_000);
  // Onboarding installs tools, launches a CLI and performs many real IPC writes;
  // CI hosts occasionally need longer than the Playwright interaction default.
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await page.locator(".top-actions").getByRole("button", { name:"新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill(longGoalRequest);
  await page.getByRole("button", { name:"确认交给管家", exact:true }).click();
  await expect.poll(async () => {
    const current = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return current.goals.some(goal => goal.title === longGoalTitle);
  }, {timeout:10_000}).toBe(true);
  const created = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals
    .find(goal => goal.title === longGoalTitle);
  assert.equal(created.description, longGoalRequest);
  assert.deepEqual(created.steps, []);
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === created.id)?.dispatch?.status;
  }, {timeout:60_000}).toBe("sent");
  await expect.poll(() => readFile(log, "utf8"), {timeout:10_000}).toContain(created.id);
  const messages = await readFile(log, "utf8");
  assert.ok(messages.includes(created.id), "actual custom CLI stdin must receive the goal ID");
  const roleInputs = messages.trim().split("\n").map(line => JSON.parse(line))
    .filter(entry => entry.kind === "input" && entry.text.includes("不亲自执行目标"));
  assert.ok(roleInputs.length >= 2, "initial identity and new goal must both carry the no-execution boundary into real stdin");
  assert.ok(messages.includes("整理后交给本目标独立负责人"));
  assert.ok(messages.includes(longGoalRequest), "the full one-box intake must reach the real CLI");
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name:"给管家留言", exact:true }).click();
  await page.getByLabel("发给管家的消息", { exact:true }).fill("补充约束：不要改变交付范围");
  await page.getByRole("button", { name:"交给管家", exact:true }).click();
  await expect.poll(() => readFile(log,"utf8"), {timeout:10_000}).toContain("补充约束：不要改变交付范围");
  assert.ok((await readFile(log,"utf8")).includes("[CREWVANE_CASE_BEGIN]"),
    "goal feedback must use the single-case envelope with the real CLI");
  const feedbackGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals.find(goal => goal.id === created.id);
  assert.equal(feedbackGoal.next, "管家正在理解原文并整理目标。");
  assert.ok(feedbackGoal.activities.some(activity => activity.kind === "message" && activity.text === "补充约束：不要改变交付范围"));
  await page.getByRole("button", { name:"关闭", exact:true }).click();
  const waiting = await page.evaluate(() => window.crewvane.command({ type:"goal.create", input:{
    title:"等待审批后继续",projectId:"personal",mode:"concierge",
  }}));
  await page.evaluate(id => window.crewvane.command({ type:"goal.wait", goalId:id, reason:"等 YR 审批", owner:"YR", remindAt:"2030-01-01T00:00:00Z" }), waiting.id);
  trace("waiting-reply");
  await page.getByRole("button", { name:"全部目标", exact:true }).click();
  await page.getByText("等待审批后继续", { exact:true }).click();
  await page.getByRole("button", { name:"告诉管家", exact:true }).click();
  await page.getByLabel("发给管家的消息", { exact:true }).fill("YR 已批准，按原方案继续开发");
  await page.getByRole("button", { name:"交给管家", exact:true }).click();
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === waiting.id)?.dispatch?.status;
  }, {timeout:60_000}).toBe("sent");
  await expect.poll(() => readFile(log,"utf8"), {timeout:10_000}).toContain("YR 已批准，按原方案继续开发");
  let waitingGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals.find(goal => goal.id === waiting.id);
  assert.equal(waitingGoal.status,"active", "an external wait handed back to an Agent returns to active coordination");
  assert.equal(waitingGoal.waitingFor, undefined);
  assert.ok(waitingGoal.activities.some(activity => activity.text === "YR 已批准，按原方案继续开发"));
  await page.evaluate(id => window.crewvane.command({
    type:"goal.progress", goalId:id, actor:"concierge",
    summary:"YR 已批准，按原方案继续开发", next:"开始实现",
  }), waiting.id);
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === waiting.id)?.status;
  }, {timeout:20_000}).toBe("active");
  await page.evaluate(id => window.crewvane.command({ type:"goal.wait", goalId:id, reason:"继续等 YR 审批", owner:"YR", remindAt:"2030-01-01T00:00:00Z" }), waiting.id);
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === waiting.id)?.status;
  }, {timeout:20_000}).toBe("waiting");
  await page.getByRole("button", { name:"1 小时后提醒", exact:true }).click();
  waitingGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals.find(goal => goal.id === waiting.id);
  assert.ok(Date.parse(waitingGoal.remindAt) > Date.now());
  await page.evaluate(id => window.crewvane.command({
    type:"goal.progress", goalId:id, actor:"concierge",
    summary:"审批已确认", next:"由你继续收尾",
  }), waiting.id);
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === waiting.id)?.status;
  }, {timeout:20_000}).toBe("active");
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name:"我来处理", exact:true }).click();
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === waiting.id)?.mode;
  }, {timeout:10_000}).toBe("manual");
  waitingGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals.find(goal => goal.id === waiting.id);
  assert.equal(waitingGoal.mode,"manual"); assert.equal(waitingGoal.status,"active");
  assert.equal(waitingGoal.dispatch,undefined);
  await page.getByRole("button", { name:"关闭", exact:true }).click();
  // A decision written by the standalone CLI must wake the running desktop's
  // pending-dispatch loop and reach the same real concierge stdin.
  const externalDecision = await page.evaluate(() => window.crewvane.command({ type:"goal.create", input:{
    title:"外部 CLI 决定回传", projectId:"personal", mode:"concierge",
  }}));
  await page.evaluate(id => window.crewvane.command({
    type:"goal.wait", goalId:id, reason:"等 YR 审批", owner:"YR",
  }), externalDecision.id);
  await page.evaluate(id => window.crewvane.command({
    type:"goal.risk", goalId:id, category:"change-permissions",
    summary:"给生产环境增加一名管理员", actor:"管家",
  }), externalDecision.id);
  let externalGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"})))
    .goals.find(goal => goal.id === externalDecision.id);
  assert.equal(externalGoal.status, "active");
  assert.equal(externalGoal.waitingFor, undefined);
  trace("external-cli-decision");
  await exec(join(home, ".local/bin/crewvane"), [
    "goal", "resolve", externalDecision.id,
    "--note", "外部 CLI 已批准只读权限",
    "--outcome", "approved", "--actor", "你", "--root", rootB, "--json",
  ], { env: testEnvironment, timeout: 20_000 });
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === externalDecision.id)?.dispatch?.status;
  }, { timeout: 60_000 }).toBe("sent");
  await expect.poll(() => readFile(log, "utf8"), { timeout: 10_000 })
    .toContain("外部 CLI 已批准只读权限");
  externalGoal = (await page.evaluate(() => window.crewvane.command({type:"snapshot"})))
    .goals.find(goal => goal.id === externalDecision.id);
  assert.equal(externalGoal.status, "active");
  assert.equal(externalGoal.waitingFor, undefined);
  assert.equal(externalGoal.remindAt, undefined);
  await page.getByRole("button", { name:"设置", exact:true }).click();
  await page.getByRole("button", { name: "打开 Herdr", exact: true }).click();
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  const panel = page.getByRole("region", { name: "Herdr 工作现场" });
  const beforeResize = await panel.boundingBox();
  const resize = await page.getByLabel("拖动调整现场大小").boundingBox();
  assert.ok(beforeResize && resize);
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + 90, resize.y + 60);
  await page.mouse.up();
  const afterResize = await panel.boundingBox();
  assert.ok(afterResize && afterResize.width > beforeResize.width && afterResize.height > beforeResize.height);
  await page.getByRole("button", { name: "全屏显示现场", exact: true }).click();
  await expect(panel).toHaveClass(/expanded/);
  await page.getByRole("button", { name: "退出全屏现场", exact: true }).click();
  await expect(panel).not.toHaveClass(/expanded/);
  await page.screenshot({ path: join(home, "onboarding-dark.png"), animations:"disabled" });
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "更换工作区", exact: true }).click();
  await page.screenshot({ path: join(home, "workspace-light.png"), animations:"disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const beforeRestart = (await stat(installedExecutable)).mtimeMs;
  await app.close();
  const restoredEnvironment = { ...testEnvironment };
  // The empty first-run override deliberately suppresses saved selection.
  // Remove it when testing a normal restart and persisted workspace recovery.
  delete restoredEnvironment.CREWVANE_TEST_WORKSPACE;
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    env:restoredEnvironment, timeout:60_000,
  });
  const restored = await app.firstWindow();
  restored.on("pageerror", error => errors.push(String(error)));
  await expect.poll(async () => (await restored.evaluate(() => window.crewvane.environment())).workspace).toBe(await realpath(rootB));
  await restored.evaluate(() => window.crewvane.prepareConcierge());
  assert.equal((await restored.evaluate(() => window.crewvane.command({type:"snapshot"}))).concierge.processId, firstReference.processId);
  assert.equal((await stat(installedExecutable)).mtimeMs, beforeRestart, "bundled or installed binary must be reused without replacing it");
  assert.equal((await readFile(log, "utf8")).split("\n").filter(line => line.includes('"kind":"start"')).length, 1);
  // Let the real custom CLI exit, then occupy the old pane with a manually
  // started process. Recovery must leave that process alone and open a new site.
  process.kill(firstReference.processId, "SIGTERM");
  await expect.poll(async () => (await restored.evaluate(() => window.crewvane.command({type:"snapshot"})))
    .concierge.status, { timeout: 20_000 }).toBe("not_ready");
  await exec(installedExecutable, [
    "--session", session, "pane", "run", firstReference.paneId, command,
  ], { env: testEnvironment, timeout: 10_000 });
  await expect.poll(() => readFile(log, "utf8").then(value =>
    value.split("\n").filter(line => line.includes('"kind":"start"')).length),
  { timeout: 10_000 }).toBe(2);
  await restored.getByRole("button", { name: "找管家", exact: true }).click();
  await expect.poll(async () => (await restored.evaluate(() => window.crewvane.command({type:"snapshot"})))
    .concierge.status, { timeout: 90_000 }).toBe("ready");
  const recoveredConcierge = (await restored.evaluate(() => window.crewvane.command({type:"snapshot"}))).concierge;
  assert.notEqual(recoveredConcierge.paneId, firstReference.paneId);
  assert.notEqual(recoveredConcierge.processId, firstReference.processId);
  await expect.poll(() => readFile(log, "utf8").then(value =>
    value.split("\n").filter(line => line.includes('"kind":"start"')).length),
  { timeout: 10_000 }).toBe(3);
  // A pending goal created after recovery reaches the replacement, not the
  // manually occupied pane.
  const recoveredGoal = await restored.evaluate(() => window.crewvane.command({type:"goal.create", input:{
    title:"恢复后仍能送达",projectId:"personal",mode:"concierge",
  }}));
  await expect.poll(async () => {
    const state = await restored.evaluate(() => window.crewvane.command({type:"snapshot"}));
    return state.goals.find(goal => goal.id === recoveredGoal.id)?.dispatch?.status;
  }, {timeout:60_000}).toBe("sent");
  await expect.poll(() => readFile(log, "utf8"), {timeout:10_000}).toContain(recoveredGoal.id);
  // The old reference must still reject messages even though its pane now holds
  // a manual process.
  const exitedGoal = await restored.evaluate(() => window.crewvane.command({type:"goal.create", input:{
    title:"退出后的任务",projectId:"personal",mode:"manual",
  }}));
  const { HerdrClient } = await import("../apps/desktop/electron/herdr.ts");
  const runner = { async run(args) {
    return (await exec(installedExecutable, args, {env:{...testEnvironment, HERDR_SESSION:session},timeout:10_000})).stdout;
  } };
  await assert.rejects(new HerdrClient(runner, session).notifyGoal(firstReference, exitedGoal.id, "不得发给 shell"), /已退出/);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, home, version: installed.version, checks: [
    "official verified auto-install without Homebrew or system PATH", "first workspace selection feedback",
    "bundled Herdr plugin auto-linked", "real Herdr plugin pane renders Crewvane attention",
    "real Herdr plugin action creates a one-line goal",
    "real Herdr pane close event reaches the matching goal",
    "same directory feedback", "cancel preserves state", "legacy workspace is archived and automatically recovered",
    "workspace switching",
    "packaged Crewvane skill installs into detected agent directories", "system clipboard round trip",
    "arbitrary CLI saves and starts", "native argv preserved", "reuse custom concierge",
    "real goal and delegation-only role delivered to CLI stdin", "raw Herdr opens independently", "restart reuses installed latest and running CLI",
    "visible goal feedback reaches CLI without replacing the next step",
    "external-wait feedback reaches CLI and resumes active coordination", "concierge decision writes the next state", "snooze and manual takeover",
    "external CLI decision wakes desktop pending dispatch and reaches the concierge",
    "terminal panel resizes and toggles fullscreen", "closed concierge reconciles offline",
    "manual process in old pane is preserved while concierge recovery uses a new site",
    "pending goal reaches the recovered concierge", "exited CLI rejects dispatch",
  ] }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({path:join(home,"failure.png")}).catch(() => {});
  const artifactDir = process.env.CREWVANE_ONBOARDING_ARTIFACTS;
  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
    await exec("cp", ["-R", `${home}/.`, artifactDir]).catch(() => {});
  }
  console.error(JSON.stringify({ home, error: String(error), errors }));
  throw error;
} finally {
  if (installedExecutable) await exec(installedExecutable, ["--session", session, "server", "stop"], { env:testEnvironment, timeout: 10_000 }).catch(() => {});
  await app?.close();
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, {recursive:true,force:true});
}
