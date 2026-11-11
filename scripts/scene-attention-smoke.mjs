// Opt-in real-model trial. No fake agent or direct resolution in the harness:
// the owner must write a receipt and the real concierge must record the answer.
import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";

const trial = await realpath(await mkdtemp("/tmp/cv-scene-"));
const home = join(trial, "home"), workspace = join(trial, "workspace"), project = join(trial, "project");
// macOS Unix-domain socket paths are short; keep this isolated session short.
const session = `cv-scene-${Date.now().toString(36)}`;
await mkdir(home); await mkdir(workspace); await mkdir(project);
await writeFile(join(workspace, "AGENTS.md"), `# 隔离验收
仅操作本隔离工作区，不访问真实用户项目，不发布、不提交、不发外部消息。
管家仅分发、协调与记录，实际任务必须交给独立负责人。
`);
const service = new WorkspaceService(workspace);
const projectEntry = await service.execute({ type: "project.add", name: "隔离执行项目", path: project });
const agent = process.env.CREWVANE_TRIAL_AGENT ||
  `omp --tools=read,bash,edit,write --approval-mode=yolo --no-skills --no-rules --no-extensions --session-dir ${join(trial, "agent-sessions")}`;
await service.execute({ type: "agents.configure", preferences: { concierge: agent, owner: agent } });
await service.execute({
  type: "workspace.autonomy.set",
  acceptance: "human-review",
  initialize: true,
  actor: "你",
});
const app = await electron.launch({
  executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
  env: { ...process.env, CREWVANE_TEST_HOME: home, CREWVANE_TEST_USER_DATA: join(trial, "userData"),
    CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: session,
    // The CLI uses its own existing authentication without copying credentials.
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp/agent") },
  timeout: 60_000,
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", error => errors.push(String(error)));
async function state() { return service.read(); }
async function herdr(args, timeout = 20_000) {
  return app.evaluate(async (_electron, { session, args, timeout }) => {
    const { execFile } = process.getBuiltinModule("node:child_process");
    return new Promise(resolve => execFile("herdr", ["--session", session, ...args],
      { timeout, maxBuffer: 512_000 }, (error, stdout, stderr) =>
        resolve({ error: error?.message, stdout, stderr })));
  }, { session, args, timeout });
}
let goal;
try {
  await expect.poll(async () => (await page.evaluate(() => window.crewvane.environment())).workspace).toBe(workspace);
  goal = await page.evaluate(projectId => window.crewvane.command({
    type: "goal.intake",
    handling: "later",
    projectId,
    text: "隔离验收：请安排独立负责人帮我确定下一步采用方案 A 还是方案 B。负责人先提出明确的选择问题，等我在负责人现场答复。确认后只记录我选的方案与下一步，本次不要写业务代码、不要结束目标、不要另提新问题。",
  }), projectEntry.id);
  assert.equal(goal.status, "backlog");
  assert.equal(goal.dispatch, undefined, "capturing must not start the real model");
  assert.equal((await state()).concierge.status, "not_ready");
  const firstHandoff = await page.evaluate(id => window.crewvane.command({ type: "goal.delegate", goalId: id }), goal.id);
  const repeatedHandoff = await page.evaluate(id => window.crewvane.command({ type: "goal.delegate", goalId: id }), goal.id);
  assert.equal(firstHandoff.dispatch.id, repeatedHandoff.dispatch.id, "repeated delegation must not create another request");
  console.log(JSON.stringify({ step: "captured-then-delegated", trial, session, goalId: goal.id }));
  await expect.poll(async () => {
    const current = await state();
    const item = current.goals.find(item => item.id === goal.id);
    if (item?.dispatch?.status === "failed" && !item.herdr)
      throw new Error(item.dispatch.detail || current.concierge.detail || "首次派发失败");
    return Boolean(item?.herdr?.agent && item.attention?.kind === "decision");
  }, { timeout: 240_000, intervals: [1000] }).toBe(true);
  const before = (await state()).goals.find(item => item.id === goal.id);
  await page.evaluate(id => window.crewvane.openHerdr(id), goal.id);
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  assert.equal((await state()).goals.find(item => item.id === goal.id).attention.id, before.attention.id,
    "merely opening the scene must keep the question");
  await page.screenshot({ path: join(trial, "before-scene-answer.png") });
  // Wait for the owner to be genuinely idle, then send ordinary human language.
  await expect.poll(async () => {
    const listed = await herdr(["agent", "list"]);
    const data = JSON.parse(listed.stdout);
    const entry = (data.result?.agents ?? data.agents).find(item => item.name === before.herdr.agent);
    return ["idle", "done"].includes(entry?.agent_status);
  }, { timeout: 90_000, intervals: [1000] }).toBe(true);
  const quote = "采用方案 A，先确认最小范围。这就是我对当前选择问题的决定。";
  const reply = await herdr(["agent", "prompt", before.herdr.agent, quote, "--wait", "--timeout", "120000"], 130_000);
  assert.ok(!reply.error || /agent_prompt_stalled/.test(reply.stderr), reply.stderr || reply.error);
  await expect.poll(async () => {
    const current = await state();
    return current.decisions.some(item => item.goalId === goal.id && item.quote === quote);
  }, { timeout: 180_000, intervals: [1000] }).toBe(true);
  const current = await state(), after = current.goals.find(item => item.id === goal.id);
  assert.equal(after.attention, null);
  assert.equal(after.sceneReply.quote, quote);
  assert.deepEqual(after.herdr, before.herdr, "reuse the original owner scene");
  assert.equal(current.decisions.find(item => item.goalId === goal.id).source, "Herdr 负责人现场");
  await page.getByRole("button", { name: "隐藏终端" }).click();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await expect(page.locator(".attention-card").filter({ hasText: goal.title })).toHaveCount(0);
  await page.screenshot({ path: join(trial, "after-scene-answer.png") });
  await writeFile(join(trial, "verified-state.json"), JSON.stringify(current, null, 2));
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(JSON.stringify({ result: "passed", trial, goalId: goal.id, owner: after.herdr.agent, quote }));
} catch (error) {
  await writeFile(join(trial, "failed-state.json"), JSON.stringify(await state(), null, 2));
  const listed = await herdr(["agent", "list"]);
  await writeFile(join(trial, "failed-agents.json"), JSON.stringify(listed, null, 2));
  try {
    const data = JSON.parse(listed.stdout);
    for (const entry of data.result?.agents ?? data.agents ?? [])
      await writeFile(join(trial, `failed-${entry.name || "agent"}.json`),
        JSON.stringify(await herdr(["agent", "read", entry.name, "--source", "recent-unwrapped", "--lines", "45"]), null, 2));
  } catch { /* The primary failure and persisted state remain available. */ }
  await page.screenshot({ path: join(trial, "failed.png") }).catch(() => {});
  console.error(JSON.stringify({ result: "failed", trial, error: String(error) }));
  throw error;
} finally {
  // Close only the isolated test session created by this script.
  await herdr(["server", "stop"], 10_000).catch(() => {});
  await app.close();
}
