import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";

// Real packaged app, isolated data and no model, network notification or user session.
const home = await mkdtemp("/tmp/cv-external-wait-ui-");
const workspace = join(home, "workspace");
await mkdir(workspace);
const service = new WorkspaceService(workspace);
await service.execute({ type: "agents.configure", preferences: { concierge: "/missing/cv-external-wait-agent" } });
await service.execute({
  type: "workspace.autonomy.set",
  acceptance: "human-review",
  initialize: true,
  actor: "你",
});
const human = await service.execute({ type: "goal.direct", text: "等我确认方案", handling: "concierge" });
const external = await service.execute({ type: "goal.direct", text: "等待供应商报价" });
await service.execute({ type: "goal.wait", goalId: external.id, reason: "对方尚未发来报价",
  owner: "供应商", remindAt: "2030-01-01T09:00:00Z" });
const state = await service.read();
// The missing CLI deliberately fails background dispatch; this regression is
// about external waiting, so keep that unrelated failure out of attention.
const externalState = state.goals.find(goal => goal.id === external.id);
if (externalState) externalState.dispatch = undefined;
// Seed a real historical snapshot, not a pre-normalized service response.
const historical = state.goals.find(goal => goal.id === human.id);
historical.status = "waiting"; historical.waitingFor = "你"; historical.owner = "你";
historical.next = "请确认先采用方案 A 还是方案 B";
await writeFile(join(workspace, ".crewvane/state.json"), JSON.stringify(state));

const errors = [];
let app;
async function launch() {
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH ||
      "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    args: [],
    env: {
      ...process.env, CREWVANE_TEST_USER_DATA: join(home, "userData"),
      CREWVANE_TEST_HOME: home, CREWVANE_TEST_WORKSPACE: workspace,
      CREWVANE_TEST_ISOLATE_TOOLS: "1", CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"), PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "注意力", exact: true }).waitFor();
  return page;
}
const snapshot = page => page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
try {
  let page = await launch();
  await expect(page.locator(".attention-card").filter({ hasText: "等我确认方案" })).toBeVisible();
  await expect(page.locator(".waiting-row")).toHaveCount(1);
  await expect(page.locator(".waiting-row")).toContainText("供应商");
  await expect(page.locator(".waiting-row")).not.toContainText("等我确认方案");
  await page.locator(".attention-card").filter({ hasText: "等我确认方案" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("请确认先采用方案 A 还是方案 B", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: join(home, "historical-human-action.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await page.locator(".waiting-row").click();
  await page.getByText("目标管理", { exact: true }).click();
  await page.getByRole("button", { name: "编辑目标", exact: true }).click();
  await expect(page.getByLabel("负责人", { exact: true })).toHaveValue("待分配负责人");
  await expect(page.getByLabel("外部等待对象", { exact: true })).toHaveValue("供应商");
  await page.getByLabel("外部等待对象", { exact: true }).fill("你");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("等待只用于具名的外部第三方");
  assert.equal((await snapshot(page)).goals.find(goal => goal.id === external.id).waitingFor, "供应商");
  await page.getByLabel("外部等待对象", { exact: true }).fill("YR");
  await page.getByRole("button", { name: "保存更新", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "编辑目标", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".waiting-row")).toContainText("YR");

  // A snooze must preserve external waiting, and a new user handoff must leave it.
  await page.locator(".waiting-row").click();
  await page.getByRole("button", { name: "1 小时后提醒", exact: true }).click();
  assert.equal((await snapshot(page)).goals.find(goal => goal.id === external.id).status, "waiting");
  await page.getByRole("button", { name: "告诉管家", exact: true }).click();
  await page.getByLabel("发给管家的消息", { exact: true }).fill("请帮我核对 YR 的最新进展");
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).goals.find(goal => goal.id === external.id).status).toBe("active");
  const handedOff = (await snapshot(page)).goals.find(goal => goal.id === external.id);
  assert.equal(handedOff.waitingFor, undefined);
  assert.equal(handedOff.remindAt, undefined);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".waiting-row")).toHaveCount(0);

  // A scheduled active-goal reminder remains actionable without fabricating a wait.
  const reminder = await page.evaluate(() => window.crewvane.command({
    type: "goal.direct", text: "活动目标定时提醒",
  }));
  await expect(page.locator(".attention-card").filter({ hasText: reminder.title })).toHaveCount(0);
  await page.evaluate(goalId => window.crewvane.command({
    type: "goal.remind", goalId, at: new Date(Date.now() + 1000).toISOString(),
  }), reminder.id);
  await expect(page.locator(".attention-card").filter({ hasText: reminder.title })).toBeVisible({ timeout: 6000 });
  assert.equal((await snapshot(page)).goals.find(goal => goal.id === reminder.id).status, "active");
  await page.screenshot({ path: join(home, "attention-without-external-wait.png"), animations: "disabled" });
  await app.close();
  page = await launch();
  assert.equal((await snapshot(page)).goals.find(goal => goal.id === human.id).status, "active");
  await expect(page.locator(".waiting-row")).toHaveCount(0);
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await page.screenshot({ path: join(home, "attention-light-restored.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  await readFile(join(workspace, ".crewvane/state.json"), "utf8");
  console.log(`External-wait packaged-app regression passed. Evidence: ${home}`);
} finally {
  await app?.close();
}
