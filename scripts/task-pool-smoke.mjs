import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";

// Exercise the real packaged app and isolated persisted workspace. No model,
// live user workspace, or external Herdr session is used by this test.
const home = await mkdtemp("/tmp/cv-pool-ui-"), workspace = join(home, "workspace");
await mkdir(workspace);
const service = new WorkspaceService(workspace);
await service.execute({ type: "agents.configure", preferences: { concierge: "/missing/cv-pool-test-agent" } });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64");
const errors = [];
async function launch() {
  const app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH || "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    args: [],
    env: {
      ...process.env, CREWVANE_TEST_USER_DATA: join(home, "userData"),
      CREWVANE_TEST_HOME: home, CREWVANE_TEST_WORKSPACE: workspace,
      CREWVANE_TEST_ISOLATE_TOOLS: "1", CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
      HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
      PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: "待办池", exact: true }).waitFor();
  return { app, page };
}
async function snapshot(page) {
  return page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
}
let app;
try {
  let page;
  ({ app, page } = await launch());
  await page.getByRole("button", { name: "待办池", exact: true }).click();
  await page.getByRole("button", { name: "记一件事", exact: true }).first().click();
  await page.getByLabel("记下这件事", { exact: true }).fill("以后研究新的作品集\n只留个想法，还没有授权开始。");
  await page.getByLabel("选择图片", { exact: true }).setInputFiles({ name: "idea.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "确认先记下" }).click();
  await expect(page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" })).toBeVisible();
  const captured = (await snapshot(page)).goals[0];
  assert.equal(captured.status, "backlog");
  assert.equal(captured.dispatch, undefined);
  assert.equal(captured.attachments.length, 1);
  assert.equal((await snapshot(page)).concierge.status, "not_ready");
  await page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" }).click();
  await page.getByRole("button", { name: "补充说明", exact: true }).click();
  await page.getByLabel("补充说明", { exact: true }).fill("先整理三张参考图，等周末再决定。");
  await page.getByRole("button", { name: "保存说明", exact: true }).click();
  await expect(page.getByLabel("补充说明", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.screenshot({ path: join(home, "pool-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await page.screenshot({ path: join(home, "pool-light.png"), animations: "disabled" });

  // A real application restart must restore the same record and attachment.
  await app.close();
  ({ app, page } = await launch());
  await page.getByRole("button", { name: "待办池", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" }).click();
  await page.getByText("idea.png", { exact: true }).waitFor();
  await page.getByText(/记录与补充/).click();
  await page.getByText("先整理三张参考图，等周末再决定。", { exact: true }).waitFor();
  assert.equal((await snapshot(page)).goals[0].id, captured.id);
  assert.equal((await snapshot(page)).goals[0].dispatch, undefined);
  await page.screenshot({ path: join(home, "captured-detail-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "我来做", exact: true }).click();
  await expect(page.getByRole("button", { name: "标记完成", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "提醒我", exact: true }).click();
  await page.getByLabel("提醒时间", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存提醒", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).goals[0].remindAt)
    .toBe(new Date("2030-01-01T09:30").toISOString());
  await page.getByRole("button", { name: "修改提醒", exact: true }).click();
  assert.equal(await page.getByLabel("提醒时间", { exact: true }).inputValue(), "2030-01-01T09:30");
  await page.getByRole("button", { name: "取消提醒", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).goals[0].remindAt).toBeUndefined();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: /我来做 1/ }).click();
  await page.locator(".goal-row").filter({ hasText: "以后研究新的作品集" }).click();
  await page.getByRole("button", { name: "标记完成", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  let completed = (await snapshot(page)).goals[0];
  assert.equal(completed.status, "completed");
  assert.equal(completed.delivery, undefined);
  assert.equal(completed.herdr, undefined);

  // Direct capture into "I will do it" stays visible in the selected section.
  await page.locator(".top-actions").getByRole("button", { name: "记一件事", exact: true }).click();
  await page.getByLabel("记下这件事", { exact: true }).fill("我去银行办手续");
  await page.getByRole("button", { name: "确认我来做" }).click();
  await expect(page.locator(".goal-row").filter({ hasText: "我去银行办手续" })).toBeVisible();
  const personal = (await snapshot(page)).goals.find(goal => goal.title === "我去银行办手续");
  assert.equal(personal.mode, "manual");
  assert.equal(personal.dispatch, undefined);

  // The reminder crosses its due time while the app is otherwise idle.
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await page.evaluate(async goalId => {
    await window.crewvane.command({ type: "goal.remind", goalId, at: new Date(Date.now() + 1000).toISOString() });
  }, personal.id);
  await expect(page.locator(".attention-card").filter({ hasText: "我去银行办手续" })).toBeVisible({ timeout: 6000 });
  await page.locator(".attention-card").filter({ hasText: "我去银行办手续" }).click();
  await page.getByText("到了你设定的提醒时间。", { exact: true }).waitFor();
  await page.screenshot({ path: join(home, "personal-due-light.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  assert.equal(await page.locator(".attention-card").filter({ hasText: "我去银行办手续" }).count(), 1);
  await page.locator(".attention-card").filter({ hasText: "我去银行办手续" }).click();
  await page.getByRole("button", { name: "1 小时后提醒", exact: true }).click();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator(".attention-card").filter({ hasText: "我去银行办手续" })).toHaveCount(0);
  assert.equal((await snapshot(page)).goals.find(goal => goal.id === personal.id).mode, "manual");
  assert.equal((await snapshot(page)).concierge.status, "not_ready");

  // Removing is reversible; neither operation starts a runtime.
  await page.getByRole("button", { name: "待办池", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "我去银行办手续" }).click();
  await page.getByRole("button", { name: "移出待办池", exact: true }).click();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.getByRole("button", { name: "已放弃", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "我去银行办手续" }).click();
  await page.getByRole("button", { name: "恢复到待办池", exact: true }).click();
  await page.getByRole("button", { name: "待办池", exact: true }).click();
  await page.getByRole("button", { name: /先记下 1/ }).click();
  await page.locator(".goal-row").filter({ hasText: "我去银行办手续" }).click();
  const restored = (await snapshot(page)).goals.find(goal => goal.id === personal.id);
  assert.equal(restored.status, "backlog");
  assert.equal(restored.remindAt, undefined);
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await expect(page.locator(".goal-detail-modal")).toBeVisible();
  const delegated = (await snapshot(page)).goals.find(goal => goal.id === personal.id);
  assert.equal(delegated.mode, "concierge");
  assert.equal(delegated.status, "active");
  assert.equal((await snapshot(page)).goals.filter(goal => goal.id === personal.id).length, 1);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await app.browserWindow(page).then(window => window.evaluate(window => window.setSize(960, 760)));
  await page.getByRole("button", { name: "待办池", exact: true }).click();
  await page.screenshot({ path: join(home, "pool-narrow-light.png"), animations: "disabled" });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2), false);
  assert.deepEqual(errors, []);
  await readFile(join(workspace, ".crewvane/state.json"), "utf8");
  console.log(`Task pool packaged-app trial passed. Evidence: ${home}`);
} finally {
  await app?.close();
}
