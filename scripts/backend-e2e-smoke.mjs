// Packaged-app, real-model trial. The concierge must create the owners itself.
// Only this isolated Crewvane installation and named Herdr session are owned.
import assert from "node:assert/strict";
import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, realpath, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { completeAutonomySetup } from "./lib/autonomy-setup.mjs";
import { cleanupBackendTrial } from "./lib/backend-trial-cleanup.mjs";
import { attentionRequest } from "../packages/core/src/model.ts";

const agent = process.env.CREWVANE_TRIAL_AGENT;
assert(agent, "Choose an installed, authenticated real Agent command explicitly.");
const trial = await realpath(await mkdtemp("/tmp/cv-backend-e2e-"));
const profile = join(trial, "orca-profile");
const workspace = join(trial, "工作 区"), home = join(trial, "home"), userData = join(trial, "userData");
await Promise.all([mkdir(workspace), mkdir(home)]);
await writeFile(join(workspace, "AGENTS.md"), `# 隔离产品验收
只处理本隔离工作区，不访问其他用户文件；不得提交、发布或发送外部消息。
管家必须使用 Crewvane CLI 创建独立负责人，不能代为创建工件或执行业务检查。
每个实际执行回合都写回 progress，不结束整个目标，不请求不必要的用户确认。
`);
const session = `cv-backend-${randomUUID().slice(0, 8)}`;
const executablePath = resolve(process.env.CREWVANE_APP_PATH ||
  "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane");
const env = { ...process.env, CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_TEST_HOME: home,
  CREWVANE_TEST_USER_DATA: userData, CREWVANE_HERDR_SESSION: session, ORCA_USER_DATA_PATH: profile,
  // ORCA_USER_DATA_PATH isolates Orca's profile. Orca still needs the real
  // macOS user HOME for LaunchServices and its local runtime handshake.
  CREWVANE_ORCA_HOST_HOME: process.env.HOME };
// The packaged app applies CREWVANE_TEST_HOME after startup, but this smoke
// test also invokes the installed Crewvane CLI directly. Point both Crewvane's
// embedded CLI and Herdr at the same isolated home; CREWVANE_TEST_HOME alone is
// intentionally an application-only test hook.
const cliEnv = {
  ...env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"),
};
const errors = [], ids = [], timeline = [];
let app, page;
let failure, cleanupFailure, cleanupResult;
let completedManifest;
let cleanupPromise;
function cleanup() {
  return cleanupPromise ??= (async () => {
    if (app) await app.close().catch(() => {});
    try {
      return await cleanupBackendTrial(trial, executablePath, env);
    } finally {
      // This named server is created by the test and shares no user session.
      const herdr = join(dirnameOfApp(executablePath), "Resources/herdr");
      await promisify(execFile)(herdr, ["--session", session, "server", "stop"], {
        env: cliEnv, timeout: 10_000,
      }).catch(() => {});
    }
  })();
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    void cleanup().catch(error => {
      console.error(JSON.stringify({ cleanupWarning: String(error), evidence: trial }));
    }).finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
const snapshot = () => page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
async function evidence(label) {
  const state = await snapshot();
  await writeFile(join(trial, `${label}.json`), JSON.stringify(state, null, 2));
  await page.screenshot({ path: join(trial, `${label}.png`), animations: "disabled" });
  return state;
}
async function waitFor(check, label, timeout = 600_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await snapshot();
    if (await check(state)) return state;
    if (Date.now() - (timeline.at(-1)?.at ?? 0) >= 30_000) {
      const progress = { at: Date.now(), label,
        concierge: state.concierge.live, goals: state.goals.map(item => ({
          id: item.id, owner: item.owner, status: item.status, dispatch: item.dispatch?.status,
          backend: item.scene?.backend, next: item.next, attention: item.attention?.summary,
        })) };
      timeline.push(progress); console.log(JSON.stringify(progress));
      await evidence(`progress-${timeline.length}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out: ${label}`);
}
async function waitForCaseProgress(marker, phase, backend) {
  return waitFor(async state => {
    const item = state.goals.find(goal => goal.title.startsWith(`隔离测试 ${marker}`));
    const output = JSON.parse(await readFile(join(workspace, `${marker}.json`), "utf8"));
    return item?.scene?.backend === backend && output.phases.length >= phase &&
      item.activities.some(activity => activity.kind === "progress" &&
        activity.text.replace(/\s+/g, "").replace(/[=:：]/g, "").includes(`阶段${phase}`));
  }, `${marker} reaches verified phase ${phase} on ${backend}`);
}
async function switchTo(backend) {
  const before = await snapshot();
  const result = await page.evaluate(backend => window.crewvane.switchBackend(backend), backend);
  assert.equal(result.journal?.phase, "ready", result.journal?.detail);
  assert.equal(result.status.control.selected, backend);
  const after = await evidence(`switched-${backend}`);
  assert.equal(after.backendEpoch, before.backendEpoch + 1);
  assert.equal(after.concierge.scene?.backend, backend);
  for (const goal of after.goals.filter(item => ids.includes(item.id))) {
    if (goal.scene) {
      assert.equal(goal.scene.backend, backend);
      assert.notEqual(goal.scene.attemptId, before.goals.find(item => item.id === goal.id)?.scene?.attemptId);
    } else assert(goal.backendHandoff, "A deferred handoff remains durable after the 30s coordination observation.");
  }
  return after;
}
try {
  app = await electron.launch({ executablePath, env, timeout: 60_000 });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  await completeAutonomySetup(page);
  await page.evaluate(() => window.crewvane.saveSceneSettings({
    openWith: "embedded", terminal: "auto",
  }));
  await page.evaluate(command => window.crewvane.command({
    type: "agents.configure", preferences: { concierge: command, owner: command, worker: command },
  }), agent);
  for (const marker of ["ALPHA", "BETA"]) {
    const goal = await page.evaluate(({ marker, workspace }) => window.crewvane.command({
      type: "goal.intake",
      text: `隔离测试 ${marker}。由独立负责人处理。只操作 ${workspace}/${marker}.json。
读取已有结果，不存在时写 {"marker":"${marker}","phases":[1]}；
每次后端交接后的新回合只追加下一整数阶段，保留原数组，禁止重复数字。
实际运行 Node 读取断言 marker 和 phases 无重复、从1连续，并用 goal progress 写回结果与实际检查，
next 写“本阶段已通过，停止并等待下一次明确的后端交接任务”。
本回合到此停止；没有收到新的后端交接通知时不得主动追加阶段。
不要提交验收，不要等待用户决定，不要后台循环。`,
    }), { marker, workspace });
    ids.push(goal.id);
  }
  let state = await waitFor(state => ids.every(id => {
    const goal = state.goals.find(item => item.id === id);
    return goal?.scene?.backend === "herdr" &&
      goal.activities.some(item => item.kind === "progress" && item.actor !== "系统");
  }), "real concierge creates two independent owners");
  assert.equal(new Set(state.goals.filter(item => ids.includes(item.id)).map(item => item.scene.bindingId)).size, 2);
  // The third goal proves that attention, its identity and its scene answer
  // survive both directions. It is delegated by the real concierge as well.
  const consultation = await page.evaluate(() => window.crewvane.command({
    type: "goal.intake",
    text: "隔离咨询：请独立负责人只写回一个决定问题“本轮采用选项 A 还是 B？”，不要实现、不要验收。收到答复后用 scene-reply 绑定当前 attention 保存人的原话，等待管家核对。",
  }));
  ids.push(consultation.id);
  state = await waitFor(state => {
    const item = state.goals.find(goal => goal.id === consultation.id);
    return item?.attention?.summary?.includes("选项 A") && item.scene?.backend === "herdr";
  }, "real owner decision reaches application attention");
  const firstAttentionId = attentionRequest(state.goals.find(goal => goal.id === consultation.id)).id;
  assert(firstAttentionId);
  await evidence("herdr-phase-one");
  await waitFor(state => state.concierge.live?.state === "idle" &&
    state.goals.filter(item => ids.includes(item.id)).every(item => item.live?.state === "idle"),
    "initial owners and concierge idle");
  await switchTo("orca");
  const restoredOrca = await page.evaluate(id => window.crewvane.openScene(id, true), consultation.id);
  assert.equal(restoredOrca.mode, "native", "Orca consultation opens its native UI.");
  const orcaConsultation = (await snapshot()).goals.find(goal => goal.id === consultation.id);
  assert.equal(attentionRequest(orcaConsultation)?.id, firstAttentionId);
  assert.equal(orcaConsultation.scene.backend, "orca");
  await page.evaluate(id => window.crewvane.openScene(id, true), consultation.id);
  assert.equal((await snapshot()).goals.find(goal => goal.id === consultation.id).scene.bindingId,
    orcaConsultation.scene.bindingId, "Repeated recovery only focuses the existing consultation.");
  await Promise.all(["ALPHA", "BETA"].map(marker => waitForCaseProgress(marker, 2, "orca")));
  await waitFor(state => state.concierge.live?.state === "idle" &&
    state.goals.filter(item => ids.includes(item.id) && item.scene).every(item => item.live?.state === "idle"),
  "Orca owners finish their assigned phase before switching back");
  await switchTo("herdr");
  const handedBackAttention = (await snapshot()).goals.find(goal => goal.id === consultation.id);
  assert(attentionRequest(handedBackAttention)?.id === firstAttentionId,
  "switching backends never regenerates or dismisses the pending decision");
  await Promise.all(["ALPHA", "BETA"].map(marker => waitForCaseProgress(marker, 3, "herdr")));
  await page.evaluate(id => window.crewvane.openScene(id, true), consultation.id);
  await waitFor(state => state.goals.find(goal => goal.id === consultation.id)?.live?.state === "idle",
    "explicitly restored consultation is ready for a real scene answer", 120_000);
  state = await snapshot();
  for (const marker of ["ALPHA", "BETA"]) {
    const output = JSON.parse(await readFile(join(workspace, `${marker}.json`), "utf8"));
    assert.deepEqual(output.phases, [1, 2, 3]);
  }
  const currentConsultation = state.goals.find(goal => goal.id === consultation.id);
  assert(currentConsultation?.scene);
  const cli = join(userData, "bin/crewvane");
  await promisify(execFile)(cli, [
    "owner", "send", consultation.id, "--root", workspace,
    "--text", `采用选项 A，其他保持不变。请按现场回复协议保存我这句话，关联当前待答复事项 ${firstAttentionId}，交给管家核对，不要重复提问或开始实现。`,
  ], { env: cliEnv, timeout: 30_000 });
  state = await waitFor(state => !attentionRequest(state.goals.find(goal => goal.id === consultation.id)) &&
    state.goals.find(goal => goal.id === consultation.id)?.activities.some(activity =>
      activity.kind === "resolved" && activity.text.includes("采用选项 A")),
  "scene answer reaches concierge and resolves only its matching attention");
  const receipt = state.goals.find(goal => goal.id === consultation.id);
  assert.equal(receipt.sceneReply.attentionId, firstAttentionId);
  assert.match(receipt.sceneReply.quote, /采用选项 A/);
  await assert.rejects(promisify(execFile)(cli, [
    "goal", "resolve", consultation.id, "--root", workspace,
    "--attention-id", firstAttentionId, "--scene-reply-id", receipt.sceneReply.id,
    "--note", "采用选项 A，其他保持不变。", "--actor", "concierge",
  ], { env: cliEnv, timeout: 30_000 }), /待处理事项已经变化|现场回复已经更新|没有待处理/);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("button", { name: "检查更新", exact: true })).toHaveCount(2);
  await evidence("settings-update-controls");
  for (const id of ids) await page.evaluate(id => window.crewvane.command({
    type: "goal.complete", goalId: id, note: "用户确认隔离测试目标结束", actor: "你",
  }), id);
  await waitFor(state => state.goals.filter(item => ids.includes(item.id)).every(item => !item.scene), "only ended owners close");
  await evidence("completed");
  assert.deepEqual(errors, []);
  completedManifest = {
    test: "packaged-backend-e2e", passed: true, session, agent, ids, timeline,
    checks: ["real concierge delegation", "two independent owners", "Herdr→Orca→Herdr",
      "stage artifacts exactly once", "owner decision to application attention",
      "attention identity preserved across backends", "explicit read-only consultation recovery",
      "real Agent scene answer and concierge write-back",
      "late attention receipt rejected", "settings update controls", "ended owner closure"],
  };
} catch (error) {
  if (page) await evidence("failure").catch(() => {});
  const state = page ? await snapshot().catch(() => undefined) : undefined;
  const owned = [
    ["concierge", state?.concierge.scene],
    ...(state?.goals ?? []).map(goal => [goal.id, goal.scene]),
  ];
  for (const [name, scene] of owned) {
    if (scene?.backend !== "orca") continue;
    const result = await promisify(execFile)("/Applications/Orca.app/Contents/Resources/bin/orca",
      ["terminal", "read", "--terminal", scene.locator.terminalHandle,
        "--screen", "--limit", "100", "--environment", "local", "--json"],
      { env, timeout: 10_000, maxBuffer: 200_000 }).catch(error => ({ stdout: String(error) }));
    await writeFile(join(trial, `failure-terminal-${name}.json`), result.stdout);
  }
  console.error(JSON.stringify({ evidence: trial, error: String(error), errors }));
  failure = error;
} finally {
  cleanupResult = await cleanup().catch(error => {
    cleanupFailure = error;
    console.error(JSON.stringify({ cleanupWarning: String(error), evidence: trial }));
  });
}
if (failure && cleanupFailure)
  throw new AggregateError([failure, cleanupFailure], `Backend E2E and cleanup both failed. Evidence: ${trial}`);
if (failure) throw failure;
if (cleanupFailure) throw cleanupFailure;
if (!cleanupResult || cleanupResult.residualProcesses !== 0)
  throw new Error(`Backend E2E cleanup was not verified. Evidence: ${trial}`);
await writeFile(join(trial, "manifest.json"), JSON.stringify({
  ...completedManifest, cleanup: cleanupResult,
}, null, 2));
console.log(JSON.stringify({ passed: true, cleanup: cleanupResult, evidence: trial }));
function dirnameOfApp(executable) { return resolve(executable, "../../"); }
