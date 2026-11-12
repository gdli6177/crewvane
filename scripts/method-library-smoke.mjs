import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { completeAutonomySetup } from "./lib/autonomy-setup.mjs";

const trial = await mkdtemp("/tmp/cv-methods-"),
  home = join(trial, "home"),
  userData = join(trial, "userData"),
  workspace = join(trial, "workspace"),
  sourceA = join(trial, "release-review"),
  sourceB = join(trial, "scripted-delivery"),
  errors = [];
let app;
let page;
let passed = false;

async function createPack(directory, options) {
  await mkdir(join(directory, "references"), { recursive: true });
  await mkdir(join(directory, "scripts"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `# ${options.name}\n\n${options.instructions}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "references", "checklist.md"),
    "# 检查清单\n\n- 核对真实输入、实际输出和可重复证据。\n",
    { mode: 0o600 },
  );
  let scripts = [];
  if (options.script) {
    const path = join(directory, "scripts", "summarize.sh");
    await writeFile(path, options.script, { mode: 0o700 });
    scripts = [{
      id: "summarize",
      path: "scripts/summarize.sh",
      sha256: createHash("sha256").update(options.script).digest("hex"),
      description: "生成交付摘要",
    }];
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: options.id,
    name: options.name,
    description: options.description,
    version: "1.0.0",
    minimumCrewvane: "0.10.0",
    kind: "process",
    roles: options.roles,
    entry: "SKILL.md",
    references: ["references/checklist.md"],
    scripts,
  }, null, 2)}\n`, { mode: 0o600 });
}

async function chooseDirectory(path) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, path);
}

async function openGoalRecord() {
  const row = page.locator(".goal-row").filter({ hasText: "方法库目标" });
  await row.click();
  const fullRecord = page.getByRole("button", { name: /完整记录/ });
  const openedAttention = await fullRecord.waitFor({ timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (openedAttention) await fullRecord.click();
  await page.getByRole("dialog").getByText("工作方法", { exact: true }).waitFor();
}

try {
  await mkdir(home, { recursive: true });
  await mkdir(userData, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  await createPack(sourceA, {
    id: "acme.release-review",
    name: "发布复核",
    description: "准备发布时核对候选、证据和真实下载物。",
    roles: ["owner", "verifier"],
    instructions: "先核对候选版本，再检查真实产物和回滚路径。",
  });
  await createPack(sourceB, {
    id: "acme.scripted-delivery",
    name: "脚本化交付",
    description: "需要确定性交付摘要时使用。",
    roles: ["owner"],
    instructions: "在执行完成后运行已授权的摘要脚本。",
    script: "#!/bin/sh\nprintf 'verified delivery summary\\n'\n",
  });

  app = await electron.launch({
    executablePath: resolve(
      process.env.CREWVANE_APP_PATH ||
        "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane",
    ),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_STATE_HOME: join(home, ".local/state"),
      CREWVANE_TEST_HOME: home,
      CREWVANE_TEST_USER_DATA: userData,
      CREWVANE_TEST_WORKSPACE: workspace,
      CREWVANE_TEST_ISOLATE_TOOLS: "1",
      CREWVANE_TEST_SKIP_HERDR_SETUP: "1",
      PATH: "/usr/bin:/bin",
    },
    timeout: 60_000,
  });
  page = await app.firstWindow();
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  await completeAutonomySetup(page);
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "工作方法", exact: true }).waitFor();
  await page.getByText("还没有本地工作方法", { exact: true }).waitFor();

  await chooseDirectory(sourceA);
  await page.getByRole("button", { name: "从文件夹安装", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "检查本地工作方法" });
  await dialog.waitFor();
  await dialog.getByText("发布复核", { exact: true }).waitFor();
  await dialog.getByText("3 个文件", { exact: true }).waitFor();
  await dialog.getByText("references/checklist.md", { exact: true }).click();
  await dialog.getByText(/核对真实输入/).waitFor();
  await dialog.getByRole("button", { name: "仅安装说明", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  let releaseCard = page.locator(".method-pack-card").filter({
    hasText: "acme.release-review",
  });
  await releaseCard.getByText("可用", { exact: true }).waitFor();
  assert.equal(
    await access(
      join(workspace, ".crewvane", "skills", "acme.release-review", "SKILL.md"),
    ).then(() => true),
    true,
  );

  await chooseDirectory(sourceB);
  await page.getByRole("button", { name: "从文件夹安装", exact: true }).last().click();
  dialog = page.getByRole("dialog", { name: "检查本地工作方法" });
  await dialog.getByText("脚本化交付", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "仅安装说明", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });

  let scriptedCard = page.locator(".method-pack-card").filter({
    hasText: "acme.scripted-delivery",
  });
  await scriptedCard.getByText("有脚本待授权", { exact: true }).waitFor();
  await scriptedCard.getByRole("button", { name: "授权当前版本", exact: true }).click();
  await scriptedCard.getByText("可用", { exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.crewvane.methodPacksStatus()))
      .find(pack => pack.id === "acme.scripted-delivery")?.scripts[0]?.approved,
    true,
  );

  const goal = await page.evaluate(() => window.crewvane.command({
    type: "goal.create",
    input: {
      title: "方法库目标",
      description: "验证方法可从目标详情挂载，并在失效时明确提示。",
      projectId: "personal",
      mode: "concierge",
      next: "检查工作方法挂载",
    },
  }));
  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  const goalRow = page.locator(".goal-row").filter({ hasText: "方法库目标" });
  await goalRow.waitFor();
  await openGoalRecord();

  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  await dialog.locator(".goal-method-picker button").filter({
    hasText: "发布复核",
  }).click();
  const methodChip = dialog.locator(".goal-method-chip").filter({
    hasText: "发布复核",
  });
  await methodChip.waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "浅色模式", exact: true }).click();
  await openGoalRecord();
  await page.screenshot({
    path: join(trial, "goal-method-light.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "深色模式", exact: true }).click();
  await openGoalRecord();
  await page.screenshot({
    path: join(trial, "goal-method-dark.png"),
    animations: "disabled",
  });

  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  releaseCard = page.locator(".method-pack-card").filter({
    hasText: "acme.release-review",
  });
  await releaseCard.getByRole("button", { name: "停用", exact: true }).click();
  await releaseCard.getByText("已停用", { exact: true }).waitFor();
  await releaseCard.getByRole("button", { name: "启用", exact: true }).click();
  await releaseCard.getByText("可用", { exact: true }).waitFor();

  page.once("dialog", confirmation => confirmation.accept());
  await releaseCard.getByRole("button", { name: "移除", exact: true }).click();
  await releaseCard.waitFor({ state: "detached" });

  await page.getByRole("button", { name: "全部目标", exact: true }).click();
  await openGoalRecord();
  dialog = page.getByRole("dialog");
  await dialog.locator(".goal-method-chip").filter({
    hasText: "acme.release-review",
  }).waitFor();
  await dialog.getByText("需重新挂载", { exact: true }).waitFor();
  await page.screenshot({
    path: join(trial, "goal-method-missing-dark.png"),
    animations: "disabled",
  });

  assert.deepEqual(errors, []);
  passed = true;
  console.log(JSON.stringify({
    result: "method-library-passed",
    goalId: goal.id,
    screenshots: [
      "goal-method-light.png",
      "goal-method-dark.png",
      "goal-method-missing-dark.png",
    ],
    evidence: trial,
  }));
} finally {
  await app?.close().catch(() => {});
  const keep = process.env.CREWVANE_KEEP_TEST_ARTIFACTS === "1" || !passed;
  if (!keep) await rm(trial, { recursive: true, force: true });
  else console.log(`Method-library evidence: ${trial}`);
}
