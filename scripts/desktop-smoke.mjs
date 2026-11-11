import { _electron as electron, expect } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { WorkspaceService } from "../packages/core/src/index.ts";
import { ingestAgentHook } from "../cli/src/hook-ingest.ts";
import { verifyReconciliationPresentation } from "./lib/reconciliation-presentation.mjs";
const run = promisify(execFile);
const appVersion = JSON.parse(
  await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
).version;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAYCAYAAACbU/80AAAAVUlEQVR4nGPUMIr6z4AEAqKWInMZNiyLZqClPBPDAAOmEe8Axoqe///pGefo8kwMAwyYRrwDGEfLAYaR7gDG0XKAYaQ7gHG0HGAY6Q5gHC0HGEa6AwC58E1KmpVcaAAAAABJRU5ErkJggg==",
  "base64",
);
function auditRenderedUi() {
  const parse = color => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(",").map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = value => {
      value /= 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
  });
  const backgroundOf = element => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor);
      if (color && color.a > 0.001) layers.push(color);
    }
    let background = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    if (background.a < 1) background = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index -= 1)
      background = { ...blend(layers[index], background), a: 1 };
    return background;
  };
  const issues = [], seen = new Set();
  for (const element of document.querySelectorAll("body *")) {
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number.parseFloat(style.opacity) < 0.1) continue;
    const bounds = element.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) continue;
    const textNode = [...element.childNodes].find(node => node.nodeType === 3 && node.textContent.trim());
    if (textNode) {
      const foreground = parse(style.color);
      if (foreground) {
        const background = backgroundOf(element),
          rendered = foreground.a < 1 ? blend(foreground, background) : foreground,
          first = luminance(rendered), second = luminance(background),
          ratio = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
          fontSize = Number.parseFloat(style.fontSize),
          large = fontSize >= 18.66 || (fontSize >= 14 && Number.parseInt(style.fontWeight, 10) >= 700),
          required = large ? 3 : 4.5,
          text = textNode.textContent.trim().replace(/\s+/g, " ").slice(0, 42),
          key = `contrast|${text}|${Math.round(ratio * 100)}|${fontSize}`;
        if (ratio < required && !seen.has(key)) {
          seen.add(key);
          issues.push({ kind: "contrast", text, fontSize, ratio: Math.round(ratio * 100) / 100, required });
        }
        if (fontSize < 11 && !seen.has(`tiny|${text}|${fontSize}`)) {
          seen.add(`tiny|${text}|${fontSize}`);
          issues.push({ kind: "tiny-text", text, fontSize });
        }
      }
    }
    if (style.overflow === "hidden" && element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 0 && element.scrollHeight <= element.clientHeight + 2)
      issues.push({ kind: "clipped-x", text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 42) });
  }
  for (const button of document.querySelectorAll("button")) {
    const name = (button.getAttribute("aria-label") || button.textContent || "").trim(),
      bounds = button.getBoundingClientRect();
    if (bounds.width < 1) continue;
    if (!name) issues.push({ kind: "unnamed-button" });
    if (bounds.width < 24 || bounds.height < 24)
      issues.push({ kind: "small-target", text: name.slice(0, 30), size: `${Math.round(bounds.width)}x${Math.round(bounds.height)}` });
  }
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 2)
    issues.push({ kind: "horizontal-scroll", over: document.documentElement.scrollWidth - document.documentElement.clientWidth });
  return issues;
}
const home = await mkdtemp("/tmp/cv-desktop-"),
  workspace = join(home, "workspace");
await mkdir(workspace);
await mkdir(join(home, "userData"), { recursive: true });
await mkdir(join(home, ".local/bin"), { recursive: true });
const manualCacheFile = join(home, "userData/GPUCache/manual-cache.bin"),
  automaticTempFile = join(home, "userData/runtime/herdr.download");
await mkdir(join(home, "userData/GPUCache"), { recursive: true });
await mkdir(join(home, "userData/runtime"), { recursive: true });
await writeFile(manualCacheFile, Buffer.alloc(2048));
await writeFile(automaticTempFile, "stale");
await writeFile(join(home, "userData/runtime/herdr"), `#!/bin/sh
case " $* " in
  *" --version "*) echo "herdr 999.0.0" ;;
  *" agent list "*) echo '{"result":{"agents":[]}}' ;;
  *" tab focus "*) echo '{"code":"tab_not_found","message":"test scene not found"}' >&2; exit 1 ;;
  *) echo '{"result":{}}' ;;
esac
`, { mode: 0o700 });
const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
await utimes(automaticTempFile, staleAt, staleAt);
const webhookEvents = [];
const webhookServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(Buffer.from(chunk)));
  request.on("end", () => {
    webhookEvents.push({
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(204).end();
  });
});
await new Promise((resolve, reject) => {
  webhookServer.once("error", reject);
  webhookServer.listen(0, "127.0.0.1", resolve);
});
const webhookAddress = webhookServer.address();
assert.ok(webhookAddress && typeof webhookAddress !== "string");
const webhookUrl = `http://127.0.0.1:${webhookAddress.port}/attention`;
const service = new WorkspaceService(workspace);
// UI regression tests never start the user's signed-in model or Herdr Session.
// Real transport and arbitrary CLI behavior are covered by onboarding-smoke.
await service.execute({ type: "agents.configure", preferences: { concierge: "/missing/crewvane-test-agent" } });
await service.execute({
  type: "workspace.autonomy.set",
  acceptance: "human-review",
  initialize: true,
  actor: "你",
});
const app = await electron.launch({
  executablePath: resolve(process.env.CREWVANE_APP_PATH ||
    "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
  args: [],
  env: {
    ...process.env,
    CREWVANE_TEST_USER_DATA: join(home, "userData"),
    CREWVANE_TEST_HOME: home,
    CREWVANE_TEST_WORKSPACE: workspace,
    CREWVANE_TEST_ISOLATE_TOOLS: "1",
    CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: "/usr/bin:/bin",
  },
  timeout: 60_000,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.screenshot({ path: join(home, "empty-dark.png") });
  await page.getByRole("button", { name: "浅色模式" }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "深色模式" }).click();
  assert.equal(await page.locator(".section-heading h2 span").count(), 0);
  const assertTopbarAligned = async (state) => {
    const alignment = await page.evaluate(() => {
      const status = document.querySelector(".live-status")?.getBoundingClientRect();
      const action = document.querySelector(".top-actions .ui-button")?.getBoundingClientRect();
      return status && action
        ? { statusCenter: status.y + status.height / 2, actionCenter: action.y + action.height / 2 }
        : null;
    });
    assert.ok(alignment, `topbar status and primary action must exist (${state})`);
    assert.ok(Math.abs(alignment.statusCenter - alignment.actionCenter) < 0.5,
      `topbar status and primary action must share a vertical center (${state}): ${JSON.stringify(alignment)}`);
  };
  await assertTopbarAligned("initial");
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  assert.ok(await page.locator(".app.collapsed").count());
  assert.equal(await page.getByRole("button", { name: "找管家" }).locator("svg").first().isVisible(), true);
  await page.screenshot({ path: join(home, "collapsed-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "展开侧边栏" }).click();
  await page.getByRole("button", { name: "我的工作台", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0, "workspace overview must not open a directory picker");
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  await page.setViewportSize({ width: 1024, height: 760 });
  await page.getByRole("button", { name: "添加项目", exact: true }).waitFor();
  await page.getByRole("button", { name: "添加项目", exact: true }).click();
  await page.getByRole("dialog", { name: "添加项目" }).waitFor();
  await page.getByLabel("项目名称").fill("界面测试项目");
  await page.getByRole("button", { name: "添加项目", exact: true }).last().click();
  const narrowProjectButton = page.getByRole("button", { name: "打开项目：界面测试项目", exact: true });
  await narrowProjectButton.waitFor();
  await narrowProjectButton.click();
  await page.locator(".topbar").getByText(/^界面测试项目/).waitFor();
  await page.screenshot({ path: join(home, "narrow-project-navigation.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1408, height: 880 });
  await page.getByRole("button", { name: "我的工作台", exact: true }).click();
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  assert.equal(await page.locator(".projects button.active").count(), 0);
  assert.equal(
    await page.getByRole("button", { name: "我的工作台", exact: true })
      .getAttribute("aria-current"),
    "page",
  );
  await page
    .locator(".top-actions")
    .getByRole("button", { name: "新目标" })
    .click();
  await page.getByLabel("要交给管家的事情").fill("桌面试用交付");
  await page.getByLabel("选择图片").setInputFiles({
    name: "selected.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page.getByText("selected.png", { exact: true }).waitFor();
  await page.getByLabel("要交给管家的事情").evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "dragged.png", { type: "image/png" }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, png.toString("base64"));
  await page.getByText("dragged.png", { exact: true }).waitFor();
  await page.getByLabel("要交给管家的事情").evaluate((element, base64) => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, png.toString("base64"));
  await page.getByText("pasted.png", { exact: true }).waitFor();
  await page.getByRole("button", { name: "移除图片 dragged.png" }).click();
  assert.equal(await page.getByText("dragged.png", { exact: true }).count(), 0);
  await page.screenshot({ path: join(home, "intake-with-images-dark.png"), animations: "disabled" });
  assert.equal(await page.locator('[role="dialog"] input:not([type="file"]), [role="dialog"] select').count(), 0);
  await page.getByRole("button", { name: "确认交给管家", exact: true }).click();
  await page.getByRole("dialog", { name: /桌面试用交付/ }).waitFor();
  await page.locator(".goal-attachments").getByText("selected.png", { exact: true }).waitFor();
  await page.locator(".goal-attachments").getByText("pasted.png", { exact: true }).waitFor();
  let state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" })),
    goalId = state.goals[0].id;
  assert.equal(state.goals[0].attachments.length, 2);
  for (const attachment of state.goals[0].attachments) {
    const attachmentPath = join(workspace, attachment.path);
    assert.ok((await stat(attachmentPath)).isFile());
    assert.equal((await stat(attachmentPath)).mode & 0o777, 0o600);
  }
  const attachmentPreview = await page.evaluate(async ({ goalId, attachmentId }) =>
    window.crewvane.attachmentPreview(goalId, attachmentId), {
    goalId: state.goals[0].id,
    attachmentId: state.goals[0].attachments[0].id,
  });
  assert.match(attachmentPreview, /^data:image\/png;base64,/);
  const persistedState = await readFile(join(workspace, ".crewvane", "state.json"), "utf8");
  assert.doesNotMatch(persistedState, /data:image|iVBORw0KGgo|base64/i);
  const removedAttachment = state.goals[0].attachments[0];
  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: `删除图片 ${removedAttachment.name}` }).click();
  await page.getByText(removedAttachment.name, { exact: true }).waitFor({ state: "detached" });
  await page.getByRole("dialog", { name: /桌面试用交付/ }).waitFor();
  await assert.rejects(stat(join(workspace, removedAttachment.path)), /ENOENT/);
  state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
  assert.equal(state.goals[0].attachments.length, 1);
  assert.ok(!state.goals[0].attachments.some(item => item.id === removedAttachment.id));
  await page
    .getByRole("button", { name: /^(给管家留言|先留言)$/ })
    .click();
  await page.getByLabel("发给管家的消息", { exact: true }).fill("请保留现有验收记录，不要扩大范围。");
  await page.getByLabel("选择回复图片", { exact: true }).setInputFiles({
    name: "reply.png",
    mimeType: "image/png",
    buffer: png,
  });
  await page.getByText("reply.png", { exact: true }).waitFor();
  // A background dispatch result can arrive while the person is composing.
  // Exercise both removal and replacement of the current attention request.
  await page.evaluate(id => window.crewvane.command({
    type: "goal.dispatch", goalId: id, status: "sent",
  }), goalId);
  await page.locator(".goal-focus").getByText("联系管家失败", { exact: true })
    .waitFor({ state: "detached" });
  await page.evaluate(id => window.crewvane.command({
    type: "goal.dispatch", goalId: id, status: "failed", detail: "后台确认管家不可达",
  }), goalId);
  await page.locator(".goal-focus").getByText("联系管家失败", { exact: true }).waitFor();
  await expect(page.getByLabel("发给管家的消息", { exact: true }))
    .toHaveValue("请保留现有验收记录，不要扩大范围。");
  await page.getByText("reply.png", { exact: true }).waitFor();
  await expect(page.getByRole("button", { name: "交给管家", exact: true })).toBeEnabled();
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(home, "goal-reply-dark.png"), animations: "disabled" });
  const nextBeforeFeedback = (await page.evaluate(() => window.crewvane.command({type:"snapshot"}))).goals[0].next;
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.getByText("请保留现有验收记录，不要扩大范围。", { exact: true }).waitFor();
  let feedbackSnapshot;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    feedbackSnapshot = (await service.read()).goals.find(goal => goal.id === goalId);
    if (feedbackSnapshot?.activities.some(activity =>
      activity.kind === "message" &&
      activity.text === "请保留现有验收记录，不要扩大范围。" &&
      activity.attachmentIds?.length === 1)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(feedbackSnapshot.next, nextBeforeFeedback);
  assert.ok(feedbackSnapshot.activities.some(activity =>
    activity.kind === "message" &&
    activity.text === "请保留现有验收记录，不要扩大范围。" &&
    activity.attachmentIds?.length === 1));
  for (let index = 1; index <= 5; index += 1) {
    await page.evaluate(({ id, index }) => window.crewvane.command({
      type: "goal.progress",
      goalId: id,
      summary: index === 5
        ? "负责人具体答复：旧接口仍可只读调用，但新界面应改用 /v2/items，并保留两轮兼容期。"
        : `负责人过程记录 ${index}`,
      actor: "负责人 alpha-owner",
    }), { id: goalId, index });
  }
  await page.locator(".conversation-feed").getByText(
    "负责人具体答复：旧接口仍可只读调用，但新界面应改用 /v2/items，并保留两轮兼容期。",
    { exact: true },
  ).waitFor();
  await page.locator(".goal-focus").getByText("联系管家失败", { exact: true }).waitFor();
  await page.locator(".goal-original").getByText(
    "桌面试用交付",
    { exact: true },
  ).waitFor();
  await page.getByRole("region", { name: "对话与交接" }).waitFor();
  const historyText = await page.locator(".conversation-entry p").allInnerTexts();
  assert.ok(
    historyText.findIndex(text => text === "负责人过程记录 4") <
      historyText.findIndex(text => text === "负责人过程记录 3"),
    "message and handoff history must put newer records before older records",
  );
  assert.equal(
    historyText.filter(text =>
      text === "负责人具体答复：旧接口仍可只读调用，但新界面应改用 /v2/items，并保留两轮兼容期。").length,
    1,
    "the latest owner answer must appear once in the conversation",
  );
  assert.equal(
    await page.locator(".conversation-feed").getByText("请保留现有验收记录，不要扩大范围。", { exact: true }).count(),
    1,
    "older conversation history must remain visible after more than four activity records",
  );
  state = await page.evaluate(() =>
      window.crewvane.command({ type: "snapshot" }),
    );
  const dispatchBeforeDirect = state.goals[0].dispatch?.id;
  await run("pnpm", [
    "--dir", "cli", "exec", "tsx", "src/main.ts", "direct",
    "外部 Herdr 终端追加下一步", "--goal", goalId, "--root", workspace, "--json",
  ], { cwd: resolve("."), timeout: 30_000 });
  await page.getByText("外部 Herdr 终端追加下一步", { exact: true }).waitFor();
  state = await page.evaluate(() => window.crewvane.command({ type: "snapshot" }));
  assert.equal(state.goals[0].dispatch?.id, dispatchBeforeDirect,
    "external terminal feedback must not create a duplicate handoff");
  assert.ok(state.goals[0].activities.some(activity =>
    activity.kind === "message" && /外部 Herdr 终端追加下一步/.test(activity.text)));
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.waitForFunction(async id => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    return snapshot.goals.find(goal => goal.id === id)?.mode === "manual";
  }, goalId);
  await page.screenshot({ path: join(home, "intake-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await service.execute({
    type: "goal.wait",
    goalId,
    reason: "等 YR 审批",
    owner: "YR",
    remindAt: "2030-01-01T00:00:00Z",
  });
  await page.waitForFunction(() =>
    document.body.innerText.includes("等 YR 审批"),
  );
  await page.screenshot({ path: join(home, "waiting-dark.png") });
  await service.execute({
    type: "goal.review",
    goalId,
    actor: "owner",
    delivery: {
      summary: "真实试用交付已完成",
      location: "试用工作区",
      checks: [
        {
          name: "真实读取",
          command: "crewvane goal show",
          result: "passed",
          note: "命令退出码 0",
        },
      ],
    },
  });
  await page.waitForFunction(async id => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    return snapshot.goals.find(goal => goal.id === id)?.status === "review";
  }, goalId);
  await page.reload();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "桌面试用交付" }).click();
  await page.locator(".goal-attention-modal").waitFor();
  assert.equal(await page.locator(".goal-detail-modal").count(), 0);
  await page.getByText("成果与证据", { exact: true }).waitFor();
  await page.screenshot({ path: join(home, "review-dark.png") });
  await page.getByRole("button", { name: "退回修改", exact: true }).click();
  await page.getByLabel("退回说明", { exact: true }).fill("请补充桌面端的实际验收说明");
  await page.getByRole("button", { name: "退回并交给管家", exact: true }).click();
  await page.locator(".goal-attention-modal").waitFor({ state: "detached" });
  await page.waitForFunction(async id => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    return snapshot.goals.find(goal => goal.id === id)?.status === "active";
  }, goalId);
  await service.execute({
    type: "goal.review",
    goalId,
    actor: "owner",
    delivery: {
      summary: "已补充桌面端验收说明",
      checks: [
        { name: "桌面交互", command: "Playwright 点击验收", result: "passed" },
      ],
    },
  });
  await page.waitForFunction(async id => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    return snapshot.goals.find(goal => goal.id === id)?.status === "review";
  }, goalId);
  await page.reload();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "桌面试用交付" }).click();
  await page.locator(".goal-attention-modal").waitFor();
  await page.getByRole("button", { name: "验收通过", exact: true }).click();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await page.getByText("现在，可以安心了。").waitFor();
  assert.equal(await page.getByRole("button", { name: "工序", exact: true }).count(), 0);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "只设置必要的。" }).waitFor();
  await page.getByRole("heading", { name: "缓存与本地维护", exact: true }).waitFor();
  await expect.poll(() => access(automaticTempFile).then(() => true).catch(() => false),
    { timeout: 10_000 }).toBe(false);
  const goalsBeforeCacheCleanup = (await service.read()).goals.length;
  await page.getByRole("button", { name: "清理缓存", exact: true }).click();
  await page.getByText(/已释放 .* 个缓存文件/).waitFor();
  await expect.poll(() => access(manualCacheFile).then(() => true).catch(() => false)).toBe(false);
  assert.equal((await service.read()).goals.length, goalsBeforeCacheCleanup,
    "cache cleanup must not remove goals");
  const personalPolicy = page.locator(".policy-row").filter({ hasText: "个人事项" });
  await personalPolicy.getByRole("button", { name: "配置", exact: true }).click();
  await personalPolicy.getByLabel("上线策略").selectOption("auto");
  await personalPolicy.getByLabel("外部审批人（可选）").fill("YR、平台组");
  await personalPolicy.getByRole("button", { name: "保存策略", exact: true }).click();
  await page.getByText("项目上线策略已更新。", { exact: true }).waitFor();
  const personalProject = (await service.read()).projects.find(project => project.id === "personal");
  assert.equal(personalProject.policy.shipPolicy, "auto");
  assert.deepEqual(personalProject.policy.approvers, ["YR", "平台组"]);
  await page.getByLabel("管家启动命令").fill("codex --model my-model");
  await page.getByLabel("负责人启动命令").fill("omp --model another-model");
  await page.getByLabel("工人启动命令").fill("");
  await page.getByRole("button", { name: "保存偏好", exact: true }).click();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await service.read()).agents?.owner === "omp --model another-model") break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual((await service.read()).agents, { concierge: "codex --model my-model", owner: "omp --model another-model" });
  await page.getByRole("button", { name: "配置 Webhook", exact: true }).click();
  await page.getByRole("dialog", { name: "Webhook 通知" }).waitFor();
  await page.getByLabel(/状态更新和需要你处理时发送/).check();
  await page.getByRole("dialog", { name: "Webhook 通知" }).getByLabel("已完成", { exact: true }).uncheck();
  await page.getByLabel("Webhook 地址").fill(webhookUrl);
  await page.getByLabel(/Bearer 令牌/).fill("desktop-smoke-token");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.getByText("Webhook 已保存，测试通知已送达。", { exact: true }).waitFor();
  await page.getByRole("button", { name: "管理 Webhook", exact: true }).click();
  await page.getByText(/5 种状态/).waitFor();
  await page.screenshot({ path: join(home, "webhook-dark.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByText(/herdr session attach crewvane-/).waitFor();
  const externalHerdr = page.getByRole("group", { name: "在外部终端打开同一 Herdr 会话" });
  const attachCommand = await externalHerdr.locator("code").filter({ hasText: "herdr session attach crewvane-" }).innerText();
  await externalHerdr.getByRole("button", { name: "复制外部终端 attach 命令", exact: true }).click();
  assert.equal(await page.evaluate(() => window.crewvane.readClipboardText()), attachCommand);
  await externalHerdr.getByRole("button", { name: "复制外部终端 attach 命令", exact: true }).getByText("已复制").waitFor();
  await page.getByRole("button", { name: "管理 Webhook", exact: true }).click();
  await page.getByRole("button", { name: "测试当前配置", exact: true }).click();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "notification.test" &&
      event.headers.authorization === "Bearer desktop-smoke-token")) break;
    await page.waitForTimeout(100);
  }
  assert.ok(
    webhookEvents.some(event =>
      event.body.event === "notification.test" &&
      event.headers.authorization === "Bearer desktop-smoke-token"),
    `the Webhook test button must send a real request; dialog text: ${await page.locator('[role="dialog"]').innerText()}`,
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const statusGoal = await service.execute({
    type: "goal.create",
    input: {
      title: "状态通知试用",
      description: "验证 CLI 侧状态变化会触发 Webhook。",
      projectId: "personal",
      mode: "concierge",
    },
  });
  await page.waitForTimeout(250);
  await service.execute({
    type: "goal.wait",
    goalId: statusGoal.id,
    reason: "等待法务审批合同",
    owner: "法务",
    actor: "负责人",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "goal.status_changed" &&
      event.body.goal?.id === statusGoal.id)) break;
    await page.waitForTimeout(100);
  }
  const statusEvent = webhookEvents.find(event =>
    event.body.event === "goal.status_changed" &&
    event.body.goal?.id === statusGoal.id);
  assert.ok(statusEvent, "a status written by another WorkspaceService must reach the configured webhook");
  assert.equal(statusEvent.body.goal.previousStatus, "active");
  assert.equal(statusEvent.body.goal.status, "waiting");
  assert.equal(statusEvent.body.goal.waitingFor, "法务");
  assert.equal(statusEvent.headers.authorization, "Bearer desktop-smoke-token");
  const deduplicatedReviewGoal = await service.execute({
    type: "goal.create",
    input: {
      title: "企业微信单次验收提醒",
      description: "验证目标进入待验收时只触发一次外部通知。",
      projectId: "personal",
      mode: "concierge",
    },
  });
  await page.waitForTimeout(250);
  await service.execute({
    type: "goal.review",
    goalId: deduplicatedReviewGoal.id,
    actor: "负责人",
    delivery: {
      summary: "待验收结果已提交",
      checks: [
        { name: "交付已生成", command: "test -f result.txt", result: "passed" },
      ],
    },
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "attention.required" &&
      event.body.goal?.id === deduplicatedReviewGoal.id)) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(800);
  const reviewNotifications = webhookEvents.filter(event =>
    event.body.goal?.id === deduplicatedReviewGoal.id &&
    (event.body.event === "goal.status_changed" ||
      event.body.event === "attention.required"));
  assert.deepEqual(
    reviewNotifications.map(event => event.body.event),
    ["attention.required"],
    "a goal entering review must send one attention notification, not a status notification as well",
  );
  assert.equal(
    reviewNotifications[0]?.headers["x-crewvane-delivery"],
    reviewNotifications[0]?.body.deliveryId,
  );
  await page.screenshot({ path: join(home, "settings-dark.png") });
  await page.evaluate(() => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = 0;
  });
  const mainBox = await page.locator("main").boundingBox();
  assert.ok(mainBox && mainBox.height > 500);
  assert.equal(
    await page
      .locator(".main")
      .evaluate((element) => getComputedStyle(element).overflowY),
    "hidden",
  );
  const topbarBeforeScroll = await page.locator(".topbar").boundingBox();
  await page.locator("main").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForFunction(() => {
    const content = document.querySelector(".main > main");
    return content && content.scrollTop > 0;
  });
  assert.deepEqual(
    await page.locator(".topbar").boundingBox(),
    topbarBeforeScroll,
    "scrolling long content must keep the application top bar fixed",
  );
  assert.equal(
    await page.locator("main").evaluate((element) => getComputedStyle(element).overflowY),
    "auto",
  );
  await page.screenshot({ path: join(home, "settings-scrolled-fixed-topbar-dark.png"), animations: "disabled" });
  await page.getByText(new RegExp(`Crewvane ${appVersion.replaceAll(".", "\\.")} · 一位管家`)).waitFor();
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  const riskGoal = await page.evaluate(() => window.crewvane.command({
    type: "goal.create",
    input: { title: "权限变更试用", projectId: "personal", mode: "manual" },
  }));
  await page.evaluate((goalId) => window.crewvane.command({
    type: "goal.progress", goalId, summary: "负责人已核对：只读权限可以完成验收，不需要增加管理员。",
    actor: "负责人",
  }), riskGoal.id);
  await page.evaluate((goalId) => window.crewvane.command({
    type: "goal.risk", goalId, category: "change-permissions",
    summary: "给生产环境增加一名管理员", actor: "管家",
  }), riskGoal.id);
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (webhookEvents.some(event =>
      event.body.event === "attention.required" &&
      event.body.goal?.id === riskGoal.id)) break;
    await page.waitForTimeout(100);
  }
  const attentionEvent = webhookEvents.find(event =>
    event.body.event === "attention.required" &&
    event.body.goal?.id === riskGoal.id);
  assert.ok(attentionEvent, "an attention transition must reach the configured webhook");
  assert.equal(attentionEvent.body.goal.title, "权限变更试用");
  assert.equal(attentionEvent.body.goal.kind, "decision");
  assert.equal(attentionEvent.headers.authorization, "Bearer desktop-smoke-token");
  const riskAttentionCard = page.locator(".goal-attention-modal");
  if (!await riskAttentionCard.count())
    await page.getByText("权限变更试用", { exact: true }).click();
  await page.locator(".goal-attention-modal").waitFor();
  assert.equal(await page.locator(".goal-detail-modal").count(), 0);
  await page.locator(".attention-evidence").getByText(/只读权限可以完成验收/).waitFor();
  await page.getByLabel("你的决定").fill("只允许只读权限，不增加管理员。");
  await page.getByRole("button", { name: "批准并继续", exact: true }).click();
  await page.getByText("已记入批准账本，正在通知管家", { exact: true }).waitFor();
  const ledger = await readFile(join(workspace, ".crewvane", "decisions.md"), "utf8");
  assert.match(ledger, /只允许只读权限/);
  assert.match(ledger, /change-permissions/);
  await page.locator(".goal-attention-modal").waitFor({ state: "detached" });
  // A persisted scene reply refreshes the UI without pretending it resolved
  // the decision. The separate concierge state command closes the old card.
  const sceneAnswer = await service.execute({ type: "goal.direct", text: "现场答复同步回归" });
  await service.execute({ type: "session.set", goalId: sceneAnswer.id,
    reference: { session: "cv-ui-scene", agent: "scene-owner", paneId: "w1:p9", tabId: "w1:t9" } });
  const sceneQuestion = await service.execute({
    type: "goal.decide", goalId: sceneAnswer.id, question: "先做核心范围？",
  });
  const sceneReceipt = await service.execute({
    type: "goal.scene-reply", goalId: sceneAnswer.id, attentionId: sceneQuestion.attention.id,
    quote: "先做核心范围，其他内容稍后再做。", summary: "已确认本轮范围，等管家记录后继续。", actor: "scene-owner",
  });
  await page.locator(".attention-card").filter({ hasText: "现场答复同步回归" }).click();
  await page.getByRole("region", { name: "现场答复同步" }).getByText("先做核心范围，其他内容稍后再做。", { exact: true }).waitFor();
  assert.equal((await service.read()).goals.find(item => item.id === sceneAnswer.id).attention.id, sceneQuestion.attention.id);
  await page.waitForFunction(() => {
    const card = document.querySelector(".goal-attention-modal");
    return card && getComputedStyle(card).opacity === "1" &&
      card.getAnimations().every(animation => animation.playState === "finished");
  });
  await page.screenshot({ path: join(home, "scene-reply-pending-light.png") });
  assert.equal(await page.getByLabel("你的决定", { exact: true }).count(), 0,
    "a saved scene answer should not ask the human to submit it again");
  await page.getByRole("button", { name: "直接处理", exact: true }).click();
  await page.getByLabel("你的决定", { exact: true }).waitFor();
  await service.execute({ type: "goal.resolve", goalId: sceneAnswer.id,
    attentionId: sceneReceipt.sceneReply.attentionId, sceneReplyId: sceneReceipt.sceneReply.id,
    note: sceneReceipt.sceneReply.quote, actor: "concierge", outcome: "approved" });
  await page.locator(".goal-attention-modal").waitFor({ state: "detached" });
  // Stop the artificial transport fixture from entering a real runtime.
  await service.execute({ type: "goal.takeover", goalId: sceneAnswer.id });
  await assertTopbarAligned("attention home");
  await page.screenshot({ path: join(home, "home-light.png") });
  // A personal item must be manageable without asking an Agent or using CLI.
  await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
  await page.getByLabel("要交给管家的事情").fill("个人事项界面闭环");
  await page.getByLabel("要交给管家的事情").press("Meta+Enter");
  await page.getByRole("dialog", { name: /个人事项界面闭环/ }).waitFor();
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "我来处理", exact: true }).click();
  await page.waitForFunction(async title => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(goal => goal.title === title)?.mode === "manual";
  }, "个人事项界面闭环");
  await page.getByRole("button", { name: "补充说明", exact: true }).click();
  await page.getByLabel("补充说明", { exact: true }).fill("审批已经通过，继续处理");
  const previousNext = (await service.read()).goals.find(item => item.title === "个人事项界面闭环").next;
  await page.getByRole("button", { name: "保存说明", exact: true }).click();
  await page.getByLabel("补充说明", { exact: true }).waitFor({ state: "detached" });
  let personal = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  assert.ok(personal.activities.some(activity =>
    activity.kind === "message" && activity.text === "审批已经通过，继续处理"));
  assert.equal(personal.next, previousNext, "messages must not silently change the next step");
  await page.getByRole("button", { name: "提醒我", exact: true }).click();
  await page.getByLabel("提醒时间", { exact: true }).fill("2030-01-01T09:30");
  await page.getByRole("button", { name: "保存提醒", exact: true }).click();
  await page.getByRole("button", { name: "修改提醒", exact: true }).waitFor();
  let manual = (await service.read()).goals.find(item => item.title === "个人事项界面闭环");
  assert.equal(manual.status, "active", "a personal reminder is not waiting for someone else");
  assert.equal(manual.remindAt, new Date("2030-01-01T09:30").toISOString());
  await page.getByRole("button", { name: "修改提醒", exact: true }).click();
  assert.equal(await page.getByLabel("提醒时间", { exact: true }).inputValue(), "2030-01-01T09:30");
  await page.getByRole("button", { name: "取消提醒", exact: true }).click();
  await page.getByRole("button", { name: "提醒我", exact: true }).waitFor();
  await page.getByRole("button", { name: "标记完成", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  state = await service.read();
  assert.equal(state.goals[0].status, "completed");
  assert.equal(state.goals.find(item => item.id === manual.id).status, "completed");
  assert.equal(state.goals.find(item => item.id === manual.id).delivery, undefined);
  assert.deepEqual(state.workflows, []);
  // This fixture is already delivered to the concierge. Personal tasks now
  // have a dedicated action surface and are covered by task-pool-smoke.
  const waiting = await service.execute({ type: "goal.direct", text: "等待审批操作" });
  await service.execute({ type: "goal.wait", goalId: waiting.id, reason: "等 YR 审批", owner: "YR", remindAt: "2030-01-01T00:00:00Z" });
  // FSEvents delivery is not guaranteed within Playwright's timeout on CI.
  // Reload after the external write so the renderer reads the persisted state.
  await page.reload();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "等待审批操作" }).click();
  await page.locator(".goal-quiet-row").getByText("等待外部", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("当前安排").count(), 0);
  await page.getByRole("button", { name: "1 小时后提醒", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return Date.parse(state.goals.find(goal => goal.id === goalId)?.remindAt ?? "") > Date.now();
  }, waiting.id);
  let waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.ok(Date.parse(waitingState.remindAt) > Date.now());
  assert.equal(waitingState.status, "waiting");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await service.execute({
    type: "goal.update", goalId: waiting.id,
    patch: { remindAt: new Date(Date.now() - 1_000).toISOString() },
  });
  await page.reload();
  await page.getByRole("button", { name: "注意力", exact: true }).click();
  await page.getByText("处理跟进", { exact: true }).click();
  await page.locator(".goal-attention-modal").waitFor();
  await page.getByText("当前下一步", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "补充情况", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "让管家跟进", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "有结果，继续推进", exact: true }).count(), 0);
  await page.screenshot({ path: join(home, "followup-chat.png"), animations: "disabled" });
  await page.getByLabel("发给管家的消息", { exact: true }).fill("审批通过了，请管家判断下一步并继续推进。");
  await page.getByRole("button", { name: "交给管家", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    const goal = state.goals.find(item => item.id === goalId);
    return goal?.status === "active" && goal.waitingFor === undefined &&
      goal.mode === "concierge" &&
      goal.remindAt === undefined &&
      goal.activities.some(activity => activity.text === "审批通过了，请管家判断下一步并继续推进。");
  }, waiting.id);
  await service.execute({
    type: "goal.progress",
    goalId: waiting.id,
    actor: "concierge",
    summary: "审批已通过，继续推进。",
    next: "由你继续核实验收",
  });
  await service.execute({ type: "goal.takeover", goalId: waiting.id });
  // The attention card can close from the state event before the renderer has
  // applied the same snapshot to the surrounding navigation. It can also switch
  // directly to an actionable dispatch-failure card because this test uses a
  // deliberately missing concierge. Reload after the persisted transition so
  // this assertion exercises the target flow rather than the delivery order.
  await page.reload();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "等待审批操作" }).click();
  await page.getByRole("dialog", { name: "等待审批操作", exact: true }).waitFor();
  waitingState = (await service.read()).goals.find(item => item.id === waiting.id);
  assert.equal(waitingState.status, "active");
  assert.equal(waitingState.mode, "manual");
  assert.equal(waitingState.owner, "你");
  assert.equal(waitingState.dispatch, undefined);
  await page.screenshot({ path: join(home, "personal-detail-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1050, height: 760 });
  const detailOverflow = await page.getByRole("dialog").evaluate(element =>
    element.scrollWidth > element.clientWidth + 1);
  assert.equal(detailOverflow, false, "personal detail must not overflow a narrow desktop viewport");
  await page.screenshot({ path: join(home, "personal-detail-narrow-light.png"), animations: "disabled" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "标记完成", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "等待审批操作" }).click();
  await page.getByRole("dialog", { name: "等待审批操作", exact: true }).waitFor();
  page.once("dialog", dialog => void dialog.accept());
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal((await service.read()).goals.some(item => item.id === waiting.id), false);
  const sceneGoal = await service.execute({
    type: "goal.create",
    input: { title: "现场入口验证", projectId: "personal", mode: "manual" },
  });
  await service.execute({
    type: "session.set",
    goalId: sceneGoal.id,
    reference: {
      session: "crewvane-ui-test",
      agent: "owner-ui-test",
      paneId: "w1:p2",
      tabId: "w1:t2",
    },
  });
  const sceneUpdate = await page.evaluate(goalId =>
    window.crewvane.command({
      type: "goal.update",
      goalId,
      patch: { next: "继续核实现场入口" },
    }), sceneGoal.id);
  assert.equal(sceneUpdate.herdr?.paneId, "w1:p2");
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  const sceneRow = page.locator(".goal-row").filter({ hasText: "现场入口验证" });
  await sceneRow.waitFor();
  await sceneRow.click();
  await page.locator(".error").getByText(/Herdr|管家|现场/).first().waitFor();
  assert.equal(await page.locator(".goal-detail-modal").count(), 0,
    "a live goal scene failure must stay out of the full-detail modal");
  await page.screenshot({ path: join(home, "goal-scene-entry.png"), animations: "disabled" });
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  const droppable = await service.execute({
    type: "goal.create",
    input: {
      title: "放弃交互验证",
      projectId: "personal",
      mode: "concierge",
    },
  });
  await page.locator(".goal-row").filter({ hasText: "放弃交互验证" }).click();
  await page.locator(".goal-detail-modal, .goal-attention-modal").waitFor();
  if (await page.locator(".goal-attention-modal").count())
    await page.getByRole("button", { name: "完整记录", exact: true }).click();
  await page.locator(".goal-detail-advanced").evaluate(element => { element.open = true; });
  await page.getByRole("button", { name: "放弃目标", exact: true }).click();
  await page.getByLabel("放弃原因", { exact: true }).fill("验证放弃操作不再依赖系统弹窗");
  await page.getByRole("button", { name: "确认放弃", exact: true }).click();
  await page.waitForFunction(async goalId => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(goal => goal.id === goalId)?.status === "dropped";
  }, droppable.id);
  await page.getByText("目标已放弃，记录仍可查看", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.locator(".goal-row").filter({ hasText: "放弃交互验证" }).click();
  await page.locator(".goal-detail-modal").waitFor();
  assert.equal(await page.locator(".goal-attention-modal").count(), 0,
    "an ended goal must open its history, not a live attention card");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const offline = await page.evaluate(() => window.crewvane.command({
    type: "goal.create",
    input: { title: "联系管家失败界面", projectId: "personal", mode: "concierge" },
  }));
  const offlineState = (await service.read()).goals.find(goal => goal.id === offline.id);
  await service.execute({
    type: "goal.dispatch",
    goalId: offline.id,
    status: "failed",
    requestId: offlineState.dispatch.id,
    detail: "测试环境无法连接管家",
  });
  await page.waitForFunction(async goalId => {
    const snapshot = await window.crewvane.command({ type: "snapshot" });
    const current = snapshot.goals.find(goal => goal.id === goalId);
    return current?.attention?.source === "dispatch" && current.dispatch?.status === "failed";
  }, offline.id);
  // This failure is written by the out-of-process service too. Reload from
  // the persisted snapshot so the row and action card cannot disagree when
  // FSEvents arrives after the direct state read.
  await page.reload();
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  const offlineRow = page.locator(".goal-row").filter({ hasText: "联系管家失败界面" });
  await offlineRow.getByText("恢复联系", { exact: true }).waitFor();
  await offlineRow.click();
  await page.locator(".goal-attention-modal").waitFor();
  await page.locator(".attention-action-focus").getByText("联系管家失败", { exact: true }).waitFor();
  await page.getByRole("button", { name: "重试联系管家", exact: true }).waitFor();
  assert.equal(await page.getByText("负责人现场需要你处理", { exact: true }).count(), 0);
  assert.equal(await page.locator(".goal-detail-modal").count(), 0);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(home, "dispatch-failure-light.png"), animations: "disabled" });
  const closeDispatchFailure = page.getByRole("button", { name: "关闭", exact: true });
  if (await closeDispatchFailure.count()) await closeDispatchFailure.click();
  const parallelPerformance = await page.evaluate(async () => {
    const longTasks = [];
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    observer.observe({ type: "longtask", buffered: true });
    const createdAt = performance.now();
    const goals = await Promise.all([1, 2, 3].map(index =>
      window.crewvane.command({
        type: "goal.create",
        input: {
          title: `并行性能测试 ${index}`,
          description: "验证三个目标同时进入共享状态时的响应。",
          projectId: "personal",
          mode: "manual",
        },
      })));
    const createMs = performance.now() - createdAt;
    const frameStartedAt = performance.now();
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));
    const frameMs = performance.now() - frameStartedAt;
    await Promise.all(goals.map(goal =>
      window.crewvane.command({ type: "goal.drop", goalId: goal.id, note: "性能测试清理" })));
    await Promise.all(goals.map(goal =>
      window.crewvane.command({ type: "goal.delete", goalId: goal.id })));
    await new Promise(resolve => setTimeout(resolve, 50));
    observer.disconnect();
    return { createMs, frameMs, maxLongTaskMs: Math.max(0, ...longTasks) };
  });
  assert.ok(parallelPerformance.createMs < 5_000,
    `three concurrent goals must remain responsive: ${JSON.stringify(parallelPerformance)}`);
  assert.ok(parallelPerformance.frameMs < 1_000,
    `the UI must paint after a three-goal burst: ${JSON.stringify(parallelPerformance)}`);
  assert.ok(parallelPerformance.maxLongTaskMs < 2_000,
    `a three-goal burst must not stall the renderer: ${JSON.stringify(parallelPerformance)}`);
  const auditDirectory = join(home, "ui-audit");
  await mkdir(auditDirectory);
  const auditReport = [];
  for (const size of [[1408, 880], [1280, 800], [1024, 700]]) {
    await page.setViewportSize({ width: size[0], height: size[1] });
    await page.waitForTimeout(180);
    for (const theme of ["dark", "light"]) {
      if (await page.locator("html").getAttribute("data-theme") !== theme)
        await page.getByRole("button", { name: theme === "light" ? "浅色模式" : "深色模式" }).click();
      await page.waitForTimeout(120);
      for (const screen of ["home", "tasks", "goals", "settings"]) {
        await page.getByRole("button", {
          name: screen === "home" ? "注意力" : screen === "tasks" ? "待办池" : screen === "goals" ? "全部目标" : "设置",
          exact: true,
        }).click();
        await page.waitForTimeout(120);
        const issues = await page.evaluate(auditRenderedUi);
        auditReport.push({ size: size.join("x"), theme, screen, issues });
        await page.screenshot({
          path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-${screen}.png`),
          animations: "disabled",
        });
        if (screen === "tasks") {
          for (const [section, name] of [["later", "先记下"], ["self", "我来做"]]) {
            await page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
            await page.waitForTimeout(80);
            const sectionIssues = await page.evaluate(auditRenderedUi);
            auditReport.push({ size: size.join("x"), theme, screen: `tasks-${section}`, issues: sectionIssues });
            await page.screenshot({
              path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-tasks-${section}.png`),
              animations: "disabled",
            });
          }
        }
        if (screen === "settings") {
          const main = page.locator(".main > main");
          await main.evaluate(element => { element.scrollTop = element.scrollHeight; });
          await page.waitForTimeout(100);
          const bottomIssues = await page.evaluate(auditRenderedUi);
          auditReport.push({ size: size.join("x"), theme, screen: "settings-bottom", issues: bottomIssues });
          await page.screenshot({
            path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-settings-bottom.png`),
            animations: "disabled",
          });
          await main.evaluate(element => { element.scrollTop = 0; });
        }
      }
      await page.getByRole("button", { name: "全部目标", exact: true }).click();
      await page.getByText("联系管家失败界面", { exact: true }).click();
      await page.getByRole("dialog").waitFor();
      const detailIssues = await page.evaluate(auditRenderedUi);
      auditReport.push({ size: size.join("x"), theme, screen: "goal-detail", issues: detailIssues });
      await page.screenshot({
        path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-goal-detail.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await page.locator(".top-actions").getByRole("button", { name: "新目标" }).click();
      await page.getByRole("dialog").waitFor();
      const intakeIssues = await page.evaluate(auditRenderedUi);
      auditReport.push({ size: size.join("x"), theme, screen: "intake", issues: intakeIssues });
      await page.screenshot({
        path: join(auditDirectory, `${size[0]}x${size[1]}-${theme}-intake.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForTimeout(120);
    }
  }
  const uiIssues = auditReport.flatMap(result =>
    result.issues.map(issue => ({ ...issue, size: result.size, theme: result.theme, screen: result.screen })));
  assert.deepEqual(uiIssues, [],
    `UI audit found contrast, clipping, accessibility, or target-size issues: ${JSON.stringify(uiIssues.slice(0, 20))}`);
  // Use a terminal-open UI fixture while the suite deliberately has no Herdr.
  // The event itself travels through the real Hook Socket and persistent Broker.
  const sceneFixture = await service.execute({
    type: "goal.direct", text: "Hook 更新不应关闭正在使用的现场",
  });
  const hookToken = "isolated-desktop-hook-token", attemptId = "attempt_live_scene";
  await service.execute({
    type: "agent.runtime.register", goalId: sceneFixture.id,
    attempt: { goalId: sceneFixture.id, attemptId, agent: "owner-live-scene",
      adapter: "codex", startedAt: new Date().toISOString() },
    hookTokenHash: createHash("sha256").update(hookToken).digest("hex"),
    capabilities: ["session.started"],
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("crewvane:event", {
      type: "terminal-open", session: "cv-live-scene-fixture", title: "隔离现场",
    }));
  await expect(page.locator(".terminal-panel")).toBeVisible();
  const ingested = await ingestAgentHook({
    adapter: "codex",
    environment: {
      CREWVANE_WORKSPACE: await realpath(workspace), CREWVANE_GOAL_ID: sceneFixture.id,
      CREWVANE_ATTEMPT_ID: attemptId, CREWVANE_AGENT_NAME: "owner-live-scene",
      CREWVANE_HOOK_TOKEN: hookToken,
    },
    stdin: async () => JSON.stringify({ hook_event_name: "SessionStart" }),
  });
  assert.equal(ingested.accepted, true);
  assert.equal(ingested.reason, undefined, "Hook must reach the live Broker instead of spooling");
  await expect.poll(async () => (await service.read()).goals
    .find(item => item.id === sceneFixture.id)?.agentRuntime?.lastSequence).toBe(1);
  await expect(page.locator(".terminal-panel")).toBeVisible();
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await verifyReconciliationPresentation(page, home, "desktop");
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  console.log(
    JSON.stringify({
      ok: true,
      home,
      checks: [
        "theme",
        "collapsible sidebar",
        "workspace overview navigation and project creation without a directory",
        "manual goal",
        "waiting",
        "review evidence",
        "rework",
        "accept",
        "settings",
        "private Webhook settings and real attention delivery",
        "automatic stale temp cleanup and manual packaged-app cache cleanup without touching goals",
        "Webhook status subscriptions, automatic delivery test, external state change delivery, and Feishu/WeCom response validation",
        "one review transition sends exactly one application-level Webhook request",
        "per-project ship policy from the desktop UI",
        "high-risk decision from the desktop UI and persisted ledger",
        "save Agent role preferences",
        "shared state",
        "renderer isolation",
        "personal notes/reminders/completion without agent delivery",
        "local reminder round trip",
        "single natural-language goal intake",
        "image paste, drag, file selection, preview, removal, and metadata-only persistence",
        "keyboard submission for goal intake",
        "goal.message preserves the next step without inferring approval or completion",
        "reply images are imported into the message activity",
        "background attention changes preserve an in-progress message and its reply images",
        "a live Hook event refreshes goal data without closing the visible terminal",
        "written idle turns use the same truthful status in goal rows and details; human requests still enter attention",
        "complete goal conversation and substantive owner answer remain visible",
        "external terminal feedback refreshes the app without replaying a handoff",
        "waiting chat handoff and snooze work without ambiguous state buttons",
        "light and narrow goal detail layouts have no horizontal overflow",
        "6 theme/size combinations across attention, both task-pool sections, goals, settings top/bottom, goal detail, and intake",
        "dispatch failure is presented as a retryable concierge connection failure",
        "permanent deletion for completed goals",
        "in-app goal abandonment with a recorded reason",
        "persistent owner scene entry is available from every active goal detail",
        "goal detail summarizes next action and latest agent reply while history opens newest-first",
        `three concurrent goals remain responsive (${Math.round(parallelPerformance.createMs)}ms, max long task ${Math.round(parallelPerformance.maxLongTaskMs)}ms)`,
      ],
      errors,
    }),
  );
} catch (error) {
  const page = await app.firstWindow();
  await page.screenshot({ path: join(home, "failure.png") });
  console.error(JSON.stringify({ home, error: String(error), errors }));
  throw error;
} finally {
  await app.close();
  await new Promise((resolve, reject) =>
    webhookServer.close(error => error ? reject(error) : resolve()));
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, { recursive: true, force: true });
}
