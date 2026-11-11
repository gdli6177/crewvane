import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const exec = promisify(execFile);
async function readSystemClipboard() {
  return (await exec("/usr/bin/pbpaste", [], {
    timeout: 5_000,
    maxBuffer: 2_000_000,
  })).stdout;
}
async function writeSystemClipboard(value) {
  await new Promise((resolveWrite, rejectWrite) => {
    const child = spawn("/usr/bin/pbcopy", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", rejectWrite);
    child.once("close", code => {
      if (code === 0) resolveWrite();
      else rejectWrite(new Error(`pbcopy exited with ${code}: ${stderr.trim()}`));
    });
    child.stdin.end(value);
  });
}
const originalClipboard = await readSystemClipboard().catch(() => undefined);
// Keep the isolated Herdr socket below macOS AF_UNIX's sun_path limit.
const home = await mkdtemp("/tmp/cv-terminal-");
const workspace = join(home, "workspace"), session = `crewvane-tty-${randomUUID().slice(0, 8)}`;
const herdrEnvironment = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"), XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache") };
await mkdir(workspace);
let app, herdrExecutable;
const errors = [];
try {
  app = await electron.launch({
    executablePath: resolve(process.env.CREWVANE_APP_PATH ||
      "apps/desktop/release/Crewvane-darwin-arm64/Crewvane.app/Contents/MacOS/Crewvane"),
    args: [],
    env: { ...process.env, CREWVANE_TEST_HOME: home, CREWVANE_TEST_USER_DATA: join(home, "userData"),
      CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: session,
      // Force Herdr's OSC 52 branch even on a local test machine. This covers
      // remote/SSH-like clients and terminals where the native branch is unavailable.
      SSH_CONNECTION: process.env.SSH_CONNECTION ?? "127.0.0.1 1 127.0.0.1 22" },
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.crewvane);
  await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
  herdrExecutable = (await page.evaluate(() => window.crewvane.herdrStatus())).executable;
  assert.ok(herdrExecutable);
  const goal = await page.evaluate(() => window.crewvane.command({
    type: "goal.create", input: { title: "隔离的真实终端测试", projectId: "personal", mode: "manual" },
  }));
  // A manually recorded goal opens the workspace TUI without starting a model.
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.getByRole("region", { name: `现场目标：${goal.title}` }).waitFor();
  await page.getByText("当前事项", { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".xterm-screen")?.clientWidth > 200);
  let connection = await page.evaluate(() => window.crewvane.terminalSnapshot());
  assert.equal(connection.session, session);
  assert.equal(connection.running, true);
  // A fresh Herdr Session renders its first-run welcome, then the optional
  // integrations panel. Continue and close those overlays before typing into
  // the focused shell; this exercises the same path as a first-time user.
  await page.evaluate((session) => window.crewvane.writeTerminal(session, "\r"), session);
  await new Promise(resolve => setTimeout(resolve, 500));
  await page.evaluate((session) => window.crewvane.writeTerminal(session, "\x1b"), session);
  await new Promise(resolve => setTimeout(resolve, 500));
  const marker = `tty_${randomUUID().replaceAll("-", "")}`;
  const resultFile = join(workspace, "terminal-result.txt");
  await page.evaluate(async ({ session, marker, resultFile }) => {
    const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
    await window.crewvane.writeTerminal(session,
      `/usr/bin/printf '%s' ${quote(marker)} > ${quote(resultFile)} && ` +
      `/usr/bin/printf '%s\\n' ${quote(marker)}\r`);
  }, { session, marker, resultFile });
  // TUI redraws can split or omit unchanged bytes in the PTY stream. Require an
  // actual shell-side effect rather than mistaking echoed input for execution.
  await expect.poll(() => readFile(resultFile, "utf8").catch(() => ""), { timeout: 30_000 }).toBe(marker);
  await page.locator(".xterm-accessibility").filter({ hasText: marker }).waitFor({ state: "attached" });
  const firstPid = await app.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.equal(firstPid.length, 1);
  const textarea = page.locator(".xterm-helper-textarea");
  await textarea.focus();
  const selectionRect = await page.evaluate((value) => {
    const tree = document.querySelector(".xterm-accessibility-tree");
    if (!tree) throw new Error("xterm accessibility tree is missing");
    const walker = document.createTreeWalker(tree, NodeFilter.SHOW_TEXT);
    const rects = [];
    let node;
    while ((node = walker.nextNode())) {
      let offset = node.data.indexOf(value);
      while (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + value.length);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0)
          rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        offset = node.data.indexOf(value, offset + value.length);
      }
    }
    const visible = rects.sort((left, right) =>
      Math.abs(left.y - right.y) > 1 ? right.y - left.y : right.x - left.x)[0];
    if (!visible) throw new Error("terminal marker was not found in the accessibility tree");
    return visible;
  }, marker);
  // Herdr's default copy_on_select captures a normal drag, shows "copied to
  // clipboard", and writes the selected text through the terminal's OSC 52
  // clipboard protocol. The embedded terminal must turn that protocol message
  // into a real macOS clipboard write.
  await expect(page.getByText("拖动文本自动复制", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制终端选区", exact: true })).toHaveCount(0);
  await writeSystemClipboard("before-herdr-copy-on-select");
  await page.mouse.move(selectionRect.x + 1, selectionRect.y + selectionRect.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    selectionRect.x + selectionRect.width - 1,
    selectionRect.y + selectionRect.height / 2,
    { steps: 15 },
  );
  await page.mouse.up();
  await expect.poll(readSystemClipboard, { timeout: 10_000 }).toBe(marker);
  await expect(page.getByRole("status")).toContainText("已复制");
  const terminalData = await page.evaluate(async () =>
    (await window.crewvane.terminalSnapshot())?.data ?? "");
  assert.ok(terminalData.includes("\x1b]52;c;"), "Herdr copy-on-select must exercise OSC 52");
  // Exercise the macOS shortcut, direct Control+V, a browser paste event and
  // the real Electron menu/Paste path. The last two protect against xterm,
  // Chromium or application-menu event ordering swallowing the shortcut.
  for (const [mode, shortcut] of [
    ["meta-shortcut", "Meta+V"],
    ["control-shortcut", "Control+V"],
    ["paste-event", undefined],
    ["native-menu-paste", undefined],
  ]) {
    const pasteMarker = `paste_${randomUUID().replaceAll("-", "")}`;
    const pasteFile = join(workspace, `terminal-paste-${pasteMarker}.txt`);
    const pasteCommand = `/usr/bin/printf '%s' '${pasteMarker}' > '${pasteFile}'`;
    await writeSystemClipboard(pasteCommand);
    await textarea.focus();
    if (mode === "paste-event") {
      await page.evaluate((value) => {
        const target = document.querySelector(".xterm-helper-textarea");
        if (!target) throw new Error("xterm paste target is missing");
        const transfer = new DataTransfer();
        transfer.setData("text/plain", value);
        target.dispatchEvent(new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }));
      }, pasteCommand);
    } else if (mode === "native-menu-paste") {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]?.webContents.paste());
    } else {
      await page.keyboard.press(shortcut);
    }
    await page.waitForFunction((value) =>
      document.querySelector(".xterm-accessibility-tree")?.textContent?.includes(value),
    pasteMarker, { timeout: 10_000 });
    await page.keyboard.press("Enter");
    await expect.poll(() => readFile(pasteFile, "utf8").catch(() => ""), { timeout: 30_000 }).toBe(pasteMarker);
  }
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  await page.locator(".top-actions").getByRole("button", { name: "新目标", exact: true }).click();
  await page.getByLabel("要交给管家的事情").fill("不能被终端抢走的草稿");
  // An arriving connection/open event must not dismiss a form or steal its focus.
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  assert.equal(await page.getByLabel("要交给管家的事情").inputValue(), "不能被终端抢走的草稿");
  await page.getByLabel("要交给管家的事情").type("，可以继续输入");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.getByRole("button", { name: "隐藏终端", exact: true }).click();
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  await page.locator(".terminal-panel").waitFor();
  await page.locator(".xterm-accessibility").filter({ hasText: marker }).waitFor({ state: "attached" });
  await page.getByRole("button", { name: "目标记录", exact: true }).click();
  await page.getByRole("dialog", { name: new RegExp(goal.title) }).waitFor();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("region", { name: "Herdr 工作现场" }).waitFor();
  await page.getByRole("button", { name: "回到注意力", exact: true }).click();
  assert.equal(await page.locator(".terminal-panel").isVisible(), false);
  await page.evaluate((id) => window.crewvane.openHerdr(id), goal.id);
  await page.locator(".xterm-accessibility").filter({ hasText: marker }).waitFor({ state: "attached" });
  const nextPid = await app.evaluate(({ app }) => app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.deepEqual(nextPid, firstPid);
  const panel = page.getByRole("region", { name: "Herdr 工作现场" });
  const beforeExpandPid = await app.evaluate(({ app }) =>
    app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  await page.getByRole("button", { name: "全屏显示现场", exact: true }).click();
  await expect(panel).toHaveClass(/expanded/);
  const expandedPid = await app.evaluate(({ app }) =>
    app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.deepEqual(expandedPid, beforeExpandPid);
  await page.getByRole("button", { name: "退出全屏现场", exact: true }).click();
  await expect(panel).not.toHaveClass(/expanded/);
  const collapsedPid = await app.evaluate(({ app }) =>
    app.getAppMetrics().filter(item => item.name === "Crewvane Herdr terminal").map(item => item.pid));
  assert.deepEqual(collapsedPid, beforeExpandPid);
  const herdr = async (args) => JSON.parse((await exec(herdrExecutable, ["--session", session, ...args], {
    timeout: 20_000,
    env: herdrEnvironment,
  })).stdout);
  const workspaceList = await herdr(["workspace", "list"]),
    workspaces = workspaceList.result?.workspaces ?? workspaceList.workspaces ?? workspaceList,
    workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces[0] ?? Object.values(workspaces)[0])
      ?.workspace_id ?? (Array.isArray(workspaces) ? workspaces[0] : Object.values(workspaces)[0])?.id;
  assert.ok(workspaceId);
  const tabCreated = await herdr(["tab", "create", "--workspace", workspaceId, "--cwd", workspace, "--label", "goal-close-trial", "--no-focus"]),
    tab = tabCreated.result?.tab ?? tabCreated.tab,
    rootPane = tabCreated.result?.root_pane ?? tabCreated.root_pane,
    tabId = tab?.tab_id ?? tab?.id,
    paneId = rootPane?.pane_id ?? rootPane?.id;
  assert.ok(tabId); assert.ok(paneId);
  await page.evaluate(({ id, reference }) => window.crewvane.command({
    type: "session.set", goalId: id, reference,
  }), {
    id: goal.id,
    reference: { session, workspaceId, tabId, paneId, agent: "closure-test-owner" },
  });
  await page.evaluate((id) => window.crewvane.command({
    type: "goal.drop", goalId: id, note: "验证结束目标自动关闭负责人 Tab", actor: "你",
  }), goal.id);
  await expect.poll(() => page.evaluate(async (id) => {
    const state = await window.crewvane.command({ type: "snapshot" });
    return state.goals.find(item => item.id === id)?.herdr;
  }, goal.id)).toBe(undefined);
  const tabs = await herdr(["tab", "list", "--workspace", workspaceId]),
    tabList = tabs.result?.tabs ?? tabs.tabs ?? tabs,
    stillOpen = (Array.isArray(tabList) ? tabList : Object.values(tabList)).some(item =>
      (item?.tab_id ?? item?.id) === tabId);
  assert.equal(stillOpen, false);
  await page.screenshot({ path: join(home, "embedded-dark.png") });
  await page.getByRole("button", { name: "浅色模式" }).click();
  await page.screenshot({ path: join(home, "embedded-light.png") });
  await page.evaluate(async () => {
    let rejected = false;
    try { await window.crewvane.writeTerminal("unrelated-session", "echo should-not-run\r"); } catch { rejected = true; }
    if (!rejected) throw new Error("Cross-workspace terminal input was accepted");
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, home, session, checks: [
    "real Herdr TUI in embedded PTY", "real shell input/output", "collapse/reopen reuses PID",
    "system clipboard paste through Meta+V, Control+V, browser paste and native Electron menu paste",
    "ordinary Herdr drag copies through OSC 52 to the macOS clipboard",
    "fullscreen toggle reuses the terminal process", "dark/light", "reject unrelated terminal input",
    "scene context opens goal record and returns to attention without losing the terminal",
    "terminal events preserve modal draft and input",
    "ended goal closes its real Herdr tab",
  ] }));
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: join(home, "failure.png") }).catch(() => {});
  console.error(JSON.stringify({ home, session, errors, error: String(error) }));
  throw error;
} finally {
  if (app) {
    // Stop only the uniquely named session created by this isolated integration.
    await app.evaluate(async (_electron, { session, herdrExecutable }) => {
      const { execFile } = process.getBuiltinModule("node:child_process");
      await new Promise((resolve) => execFile(herdrExecutable, ["--session", session, "server", "stop"], { timeout: 10_000 }, () => resolve()));
    }, { session, herdrExecutable }).catch(() => {});
    await app.close();
  }
  if (originalClipboard !== undefined)
    await writeSystemClipboard(originalClipboard).catch(() => {});
  if (process.env.CREWVANE_KEEP_TEST_ARTIFACTS !== "1") await rm(home, { recursive: true, force: true });
}
