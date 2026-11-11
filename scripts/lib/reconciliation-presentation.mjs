import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { join } from "node:path";

// Run against the installed application's real IPC/core/renderer. No model or
// real Herdr pane is launched by this isolated lifecycle replay.
export async function verifyReconciliationPresentation(page, screenshotDirectory, label) {
  const title = `已回报状态验收 ${label}`;
  const goalId = await page.evaluate(async title => {
    const command = input => window.crewvane.command(input);
    const goal = await command({ type: "goal.direct", text: title });
    const at = new Date().toISOString();
    await command({
      type: "agent.runtime.register", goalId: goal.id,
      attempt: { goalId: goal.id, attemptId: "attempt_reconciliation",
        agent: "owner-reconciliation", adapter: "codex", startedAt: at },
      hookTokenHash: "a".repeat(64), capabilities: ["turn.started", "turn.settled"],
    });
    for (const [sequence, type] of [[1, "turn.started"], [2, "turn.settled"]])
      await command({
        type: "agent.runtime.event",
        event: { version: "v1", eventId: `event-${sequence}`, sequence, type, at,
          source: "hook", adapter: "codex", agent: "owner-reconciliation",
          goalId: goal.id, attemptId: "attempt_reconciliation", turnId: "turn-a" },
      });
    await command({ type: "goal.progress", goalId: goal.id, actor: "owner-reconciliation",
      summary: "已核实两种接入方式并写回依据。", next: "按已确认的方案继续跟进。" });
    await command({ type: "live.sync", presences: { [goal.id]: {
      state: "idle", reachable: true, checkedAt: at,
    } } });
    return goal.id;
  }, title);
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: title }).click();
  const detail = page.locator(".goal-detail-modal");
  await expect(detail.getByText("本轮已回报", { exact: true }).first()).toBeVisible();
  await expect(detail).not.toContainText("结果尚未写回");
  await expect(detail).toContainText("按已确认的方案继续跟进");
  const originalTheme = await page.locator("html").getAttribute("data-theme");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
    await page.screenshot({
      path: join(screenshotDirectory, `${label}-written-idle-${theme}.png`),
      animations: "disabled",
    });
  }
  await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), originalTheme);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  // Register a reference only after checking the full detail: active goals with
  // a real reference open their scene directly, and use the same status facts.
  const requests = await page.evaluate(async goalId => {
    await window.crewvane.command({ type: "session.set", goalId,
      reference: { session: "cv-reconciliation-fixture", paneId: "w1:p42",
        agent: "owner-reconciliation" } });
    return window.crewvane.command({ type: "watchdog.inspect", at: new Date().toISOString() });
  }, goalId);
  assert.ok(!requests.some(request => request.goalId === goalId),
    "a written turn must not create a reconciliation request");
  const row = page.locator(".goal-row").filter({ hasText: title });
  await expect(row.getByText("本轮已回报", { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(screenshotDirectory, `${label}-written-idle-list.png`), animations: "disabled",
  });
  // A genuine human request still enters attention, regardless of idle and the
  // previous written receipt. Do not guess it from natural-language next steps.
  await page.evaluate(goalId => window.crewvane.command({
    type: "goal.decide", goalId, question: "请提供实际调用示例，以便继续验证。",
    actor: "owner-reconciliation",
  }), goalId);
  await expect(row.getByText("作出决定", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await expect(page.locator(".attention-card").filter({ hasText: title })).toBeVisible();
}
