import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  attentionGoals,
  attentionKind,
  attentionRequest,
  attachmentAbsolutePath,
  importAttachmentBytes,
  validateGoalAttachments,
  WorkspaceService,
  type CrewvaneCommand,
  type Goal,
  type GoalStatus,
  type HerdrReference,
  type LivePresence,
  type WatchdogRequest,
  type WorkspaceState,
} from "../../../packages/core/src/index.js";
import { ConciergeBlockedError, HerdrClient, herdrRunner, quoteShell } from "./herdr.js";
import { refreshConciergeIfSafe } from "./concierge-lifecycle.js";
import { TerminalHost } from "./terminal-host.js";
import { parseAgentCommand } from "./agent-command.js";
import { Executables } from "./executables.js";
import { HerdrInstallation, type HerdrStatus } from "./herdr-install.js";
import { HerdrPlugin } from "./herdr-plugin.js";
import { deliverGoalUpdate } from "./goal-delivery.js";
import { reconcileSceneReply } from "./scene-reconciliation.js";
import { CoordinatorQueue } from "./coordinator-queue.js";
import { writeCoordinatorScope } from "./coordinator-scope.js";
import { WebhookNotifier, type WebhookSaveInput } from "./webhook-notifications.js";
import { CrewvaneSkillInstaller } from "./skill-installer.js";
import { launchOwner, type HerdrCommandRunner } from "../../../cli/src/owner-launch.js";
import { clearManagedCaches, inspectManagedCaches } from "./cache-maintenance.js";
const exec = promisify(execFile);
let window: BrowserWindow, tray: Tray, root: string | undefined, service: WorkspaceService | undefined, syncing = false, quitting = false;
let stateWatcher: FSWatcher | undefined, stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const selections = new Set<string>();
const knownGoalStatuses = new Map<string, GoalStatus>();
let knownGoalStatusWorkspace: string | undefined;
let lastSnapshotSignature: string | undefined;
let automaticCacheCleanupStarted = false;
let cacheMaintenanceQueue: Promise<unknown> = Promise.resolve();
const here = __dirname;
// Native window chrome needs a startup color before renderer CSS is available.
// Keep this synchronized with the dark `--bg` design token and DESIGN.md.
const WINDOW_BACKGROUND = "#111520";
const terminals = new TerminalHost((event) => {
  if (window && !window.isDestroyed()) window.webContents.send("crewvane:event", event);
}, process.env);
const rendererURL = pathToFileURL(join(here, "renderer/index.html")).href;
let tools: Executables, herdrInstallation: HerdrInstallation, herdrPlugin: HerdrPlugin, webhookNotifier: WebhookNotifier, skillInstaller: CrewvaneSkillInstaller;
function sessionName(path = root) { return process.env.CREWVANE_HERDR_SESSION ?? `crewvane-${createHash("sha256").update(path ?? "").digest("hex").slice(0, 10)}`; }
function sender(event: Electron.IpcMainInvokeEvent) { if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error("不受信任的界面请求"); }
function activeService() { if (!service) throw new Error("请先打开工作区"); return service; }
async function snapshot() { return activeService().read(); }
function cacheMaintenancePaths() {
  return {
    userDataRoot: app.getPath("userData"),
    cacheRoot: app.getPath("sessionData"),
    logsRoot: app.getPath("logs"),
    workspaceRoot: root,
  };
}
function queueCacheMaintenance<T>(task: () => Promise<T>): Promise<T> {
  const queued = cacheMaintenanceQueue.catch(() => undefined).then(task);
  cacheMaintenanceQueue = queued.then(() => undefined, () => undefined);
  return queued;
}
async function runAutomaticCacheCleanup() {
  if (automaticCacheCleanupStarted) return;
  automaticCacheCleanupStarted = true;
  const marker = join(app.getPath("userData"), "cache-maintenance.json");
  try {
    const previous = JSON.parse(await readFile(marker, "utf8")) as { lastAutomaticRunAt?: string };
    if (previous.lastAutomaticRunAt &&
      Date.now() - Date.parse(previous.lastAutomaticRunAt) < 24 * 60 * 60 * 1000) return;
  } catch {
    // Missing or malformed bookkeeping only means it is time for one safe pass.
  }
  await queueCacheMaintenance(() => clearManagedCaches(cacheMaintenancePaths(), {
    mode: "automatic",
  }));
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(marker, `${JSON.stringify({
    lastAutomaticRunAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
}
function broadcastSnapshot(state: WorkspaceState, workspace: string) {
  if (root !== workspace || !window || window.isDestroyed()) return;
  const signature = JSON.stringify(state);
  if (signature === lastSnapshotSignature) return;
  lastSnapshotSignature = signature;
  window.webContents.send("crewvane:event", { type: "snapshot", state, workspace });
}
async function validatedAttachment(goalId: string, attachmentId: string) {
  if (typeof goalId !== "string" || typeof attachmentId !== "string")
    throw new Error("附件参数无效");
  const target = activeService(), state = await target.read(),
    item = state.goals.find(goal => goal.id === goalId),
    attachment = item?.attachments?.find(candidate => candidate.id === attachmentId);
  if (!attachment) throw new Error("找不到这个附件");
  const [validated] = await validateGoalAttachments(target.root, [attachment]);
  return { target, attachment: validated!, path: attachmentAbsolutePath(target.root, validated!) };
}
function broadcastHerdrStatus(status: HerdrStatus) {
  if (!window || window.isDestroyed()) return;
  window.webContents.send("crewvane:event", {
    type: "herdr-status",
    status: {
      ...status,
      session: sessionName(),
      plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
    },
  });
}
async function executable(command: string, cwd?: string) {
  return tools.find(command, cwd);
}
async function herdrStatus() {
  return {
    ...await herdrInstallation.status(),
    session: sessionName(),
    plugin: herdrPlugin?.status() ?? { phase: "idle", installed: false },
  };
}
async function agentChoices() {
  const status = await herdrStatus();
  if (!status.executable) return [];
  const help = (await exec(status.executable, ["agent", "start", "--help"], { timeout: 10_000 })).stdout;
  const kinds = /\[possible values:\s*([^\]]+)\]/.exec(help)?.[1]?.split(",").map(value => value.trim()) ?? [];
  return Promise.all(kinds.filter(kind => /^[a-z][a-z0-9_-]{0,31}$/.test(kind)).map(async kind => ({
    kind, installed: Boolean(await executable(kind)),
  })));
}
let companionPreparation: Promise<Awaited<ReturnType<typeof prepareHerdrCompanionsNow>>> | undefined;
function prepareHerdrCompanions(workspace = root) {
  companionPreparation ??= prepareHerdrCompanionsNow(workspace).finally(() => {
    companionPreparation = undefined;
  });
  return companionPreparation;
}
async function prepareHerdrCompanionsNow(workspace = root) {
  const status = await herdrInstallation.ensure();
  if (!status.executable) return status;
  try {
    await installCli(workspace);
  } catch (error) {
    herdrPlugin.fail(`Crewvane CLI 准备失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  return status;
}
async function installHerdr() {
  const status = await herdrInstallation.ensure(true);
  if (!status.executable) return status;
  try {
    await installCli();
  } catch (error) {
    herdrPlugin.fail(`Crewvane CLI 准备失败：${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  return status;
}
async function cliStatus() {
  const bundled = join(here, "cli/crewvane.cjs"), path = join(app.getPath("home"), ".local/bin/crewvane"), directory = join(app.getPath("userData"), "bin");
  return { bundled: Boolean(await access(bundled).then(() => true).catch(() => false)), installed: Boolean(await lstat(path).then(() => true).catch(() => false)), path, directory };
}
function skillsStatus() {
  return skillInstaller.status();
}
function installSkills() {
  return skillInstaller.install();
}
let cliInstallQueue: Promise<{ output: string }> = Promise.resolve({ output: "" });
function installCli(workspace = root) {
  const installing = cliInstallQueue.catch(() => undefined).then(() => installCliNow(workspace));
  cliInstallQueue = installing;
  return installing;
}
async function installCliNow(workspace = root) {
  const status = await cliStatus(); if (!status.bundled) throw new Error("安装包缺少内置 CLI");
  await mkdir(status.directory, { recursive: true });
  await mkdir(join(app.getPath("home"), ".local/bin"), { recursive: true });
  if (status.installed) {
    const existing = await readFile(status.path, "utf8").catch(() => "");
    const linked = await realpath(status.path).catch(() => "");
    const target = await readlink(status.path).catch(() => "");
    if (!existing.startsWith("#!/bin/sh\n# Crewvane embedded CLI\n") &&
      linked !== join(status.directory, "crewvane") && target !== join(status.directory, "crewvane"))
      throw new Error(`${status.path} 已存在，且不是 Crewvane 安装的 CLI。请手动处理后重试。`);
  }
  const cliRuntime = app.isPackaged ? join(process.resourcesPath, "cli-node") : process.execPath;
  const cliBundle = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked/dist/cli/crewvane.cjs") : join(here, "cli/crewvane.cjs");
  const launcher = join(status.directory, "crewvane");
  const defaultRoot = workspace ? quoteShell(workspace) : '""';
  await writeFile(launcher, `#!/bin/sh\n# Crewvane embedded CLI\n[ -n "\${CREWVANE_WORKSPACE:-}" ] || CREWVANE_WORKSPACE=${defaultRoot}\nexport CREWVANE_WORKSPACE\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(cliRuntime)} ${quoteShell(cliBundle)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  if (status.installed) await unlink(status.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(launcher, status.path);
  const checked = await exec(status.path, ["status", ...(workspace ? ["--root", workspace] : [])], { timeout: 15_000 });
  const installed = await cliStatus();
  if (window && !window.isDestroyed()) {
    window.webContents.send("crewvane:event", { type: "cli-status", status: installed });
  }
  return { ...installed, output: checked.stdout.trim() };
}
function client(path: string, workspace = root) {
  const session = sessionName(workspace);
  if (!workspace) throw new Error("请先选择工作区");
  return new HerdrClient(herdrRunner(path, session), session, workspace, async () => {
    await terminals.attach(path, session, workspace!);
    if (root === workspace) window.webContents.send("crewvane:event", { type: "terminal-available", session, title: "全局管家" });
  });
}
async function closeEndedGoalSession(target: WorkspaceService, goalId: string, executable?: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item || !["completed", "dropped"].includes(item.status) || !item.herdr) return false;
  const herdrExecutable = executable ?? (await herdrStatus()).executable;
  if (!herdrExecutable) throw new Error("Herdr 当前不可用，负责人现场将在恢复后自动关闭");
  const connection = client(herdrExecutable, target.root);
  const resume = await connection.captureOwnerResume(item.herdr).catch(() => undefined);
  if (resume)
    await target.execute({ type: "session.preserve", goalId, resume });
  await connection.closeGoal(item.herdr);
  await target.execute({ type: "session.release", goalId });
  return true;
}
async function restartEndedGoal(target: WorkspaceService, goalId: string, note: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item) throw new Error("找不到目标");
  if (!["completed", "dropped"].includes(item.status))
    throw new Error("只有已完成或已放弃的目标可以重启");
  if (item.mode !== "concierge")
    throw new Error("个人事项请恢复到待办池，不需要重启 Agent");
  // A previous close may have failed. Preserve the resumable identity before
  // removing its stale tab so restart cannot orphan the old owner.
  if (item.herdr)
    await closeEndedGoalSession(target, item.id);
  const restarted = await target.execute({ type: "goal.restart", goalId, note }) as Goal;
  void dispatchGoal(target, goalId).catch(error => {
    if (root === target.root && !window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `目标已重新打开，负责人恢复暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  if (root === target.root) {
    const state = await target.read();
    deliverGoalStatusChanges(target, state, target.root);
    broadcastSnapshot(state, target.root);
  }
  return restarted;
}
const preparations = new Map<string, Promise<HerdrReference>>();
const refreshedConcierges = new Map<string, string>();
function conciergeIdentity(reference: HerdrReference) {
  return JSON.stringify([reference.session, reference.paneId, reference.agent, reference.processId]);
}
const handoffs = new Map<string, Promise<void>>();
const coordinatorQueue = new CoordinatorQueue();
function coordinate<T>(target: WorkspaceService, task: () => Promise<T>): Promise<T> {
  return coordinatorQueue.run(target.root, task);
}
async function dispatchGoal(target: WorkspaceService, goalId: string): Promise<void> {
  const key = `${target.root}:${goalId}`;
  const pending = handoffs.get(key); if (pending) return pending;
  const work = coordinate(target, async () => {
    try {
      const current = (await target.read()).goals.find(goal => goal.id === goalId);
      if (current?.dispatch?.kind === "restart" && !current.herdr) {
        try {
          await restartOwnerSession(target, current);
        } catch (error) {
          const detail = (error instanceof Error ? error.message : String(error))
            .replace(/[。.!！]\s*$/, "");
          await target.execute({
            type: "goal.dispatch",
            goalId,
            status: "failed",
            requestId: current.dispatch.id,
            detail: `原负责人重启失败：${detail}`,
          });
          throw error;
        }
      }
      await deliverGoalUpdate(target, goalId, async item => {
        const reference = await prepareConcierge(target);
        const latest = (await target.read()).goals.find(goal => goal.id === goalId);
        if (!latest || latest.mode !== "concierge" || ["completed", "dropped"].includes(latest.status) ||
          latest.dispatch?.id !== item.dispatch?.id) return;
        const status = await herdrStatus();
        if (!status.executable) throw new Error("Herdr 尚未准备好");
        const herdrExecutable = status.executable;
        const messenger = client(herdrExecutable, target.root);
        await writeCoordinatorScope(target.root, item.id, item.dispatch?.id,
          item.dispatch?.kind === "scene_reply" ? item.sceneReply : undefined);
        if (item.dispatch?.kind === "follow_up")
          return messenger.notifyFollowUp(reference, item.id, item.dispatch.note || "", item, target.root);
        return messenger.notifyGoal(reference, item.id, item.title, item, target.root);
      });
    } finally {
      if (root === target.root) broadcastSnapshot(await target.read(), target.root);
    }
  });
  handoffs.set(key, work);
  try { await work; } finally { handoffs.delete(key); }
}
function restartOwnerName(goal: Goal) {
  const candidate = goal.ownerResume?.owner?.trim();
  return candidate && /^[a-z][a-z0-9_-]{0,31}$/.test(candidate)
    ? candidate
    : `owner-${goal.id.slice(-8)}`;
}
function restartOwnerTask(goal: Goal) {
  return [
    `目标「${goal.title}」已由用户从 Crewvane 重新启动。`,
    `目标 ID：${goal.id}`,
    "这是续接原目标，不是新任务。先运行 crewvane goal show " + goal.id +
      " --json 核对当前记录、上次成果和原会话上下文；不要重复已经完成的工作。",
    "用户的新消息会由管家在下一条通知中交给你。现在只恢复状态并等待管家转交，不要自行扩大范围或直接结束目标。",
  ].join("\n\n");
}
async function restartOwnerSession(target: WorkspaceService, goal: Goal) {
  const status = await herdrStatus();
  if (!status.executable) throw new Error(status.detail || "Herdr 尚未准备好");
  const session = sessionName(target.root);
  const run: HerdrCommandRunner = async args => {
    const { stdout } = await exec(status.executable!, ["--session", session, ...args], {
      timeout: 190_000,
      maxBuffer: 1_000_000,
      env: { ...process.env, HERDR_SESSION: session },
    });
    return stdout;
  };
  return launchOwner(
    target,
    {
      goalId: goal.id,
      name: restartOwnerName(goal),
      task: restartOwnerTask(goal),
      ...(goal.ownerResume ? { resume: goal.ownerResume } : {}),
    },
    {
      environment: {
        ...process.env,
        HERDR_ENV: "1",
        HERDR_SESSION: session,
        CREWVANE_HERDR_BINARY: status.executable,
        HOME: app.getPath("home"),
      },
      run,
    },
  );
}
async function prepareConcierge(target = activeService()) {
  const pending = preparations.get(target.root);
  if (pending) return pending;
  const preparing = doPrepareConcierge(target);
  preparations.set(target.root, preparing);
  try { return await preparing; } finally { preparations.delete(target.root); }
}
async function doPrepareConcierge(target: WorkspaceService) {
  const status = await herdrInstallation.ensure();
  if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好，请在设置中重试");
  await installCli(target.root);
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  const state = await target.read();
  await target.execute({
    type: "concierge.status",
    status: "not_ready",
    reference: state.concierge,
    live: null,
    detail: "正在准备全局管家…",
  });
  try {
    const connection = client(status.executable, target.root);
    const site = await connection.inspectConcierge(state.concierge);
    if (site) {
      const existing = site.reference;
      const identity = conciergeIdentity(existing);
      const refreshResult = await refreshConciergeIfSafe({
        reference: existing,
        live: site.live,
        alreadyRefreshed: refreshedConcierges.get(target.root) === identity,
        refresh: candidate => connection.refreshConcierge(candidate, target.root, state.agents),
      });
      if (refreshResult === "refreshed")
        refreshedConcierges.set(target.root, identity);
      const live: LivePresence = refreshResult === "blocked"
        ? { state: "blocked", checkedAt: new Date().toISOString(), reachable: true }
        : site.live;
      await target.execute({
        type: "concierge.status",
        status: "ready",
        reference: existing,
        live,
        ...(live.state === "blocked"
          ? { detail: "管家正在等待交互输入；已保留现有现场。" }
          : {}),
      });
      return existing;
    }
    const home = app.getPath("home");
    const preferences = state.agents ?? { concierge: "codex" };
    const command = parseAgentCommand(preferences.concierge, (await agentChoices()).map(option => option.kind));
    const agentExecutable = await executable(command.executable, target.root);
    if (!agentExecutable) throw new Error(`未找到 ${command.executable} CLI，请先安装，或在设置中修改管家启动命令。`);
    const reference = await connection.prepareConcierge(
      target.root,
      state.concierge,
      command.kind ?? "",
      join(home, ".local/bin"),
      `${dirname(status.executable)}:${join(home, ".local/bin")}`,
      dirname(agentExecutable),
      async (reference) => {
        await target.execute({ type: "concierge.status", status: "not_ready", reference, detail: "正在启动管家…" });
      },
      preferences,
      command.args,
      agentExecutable,
      (await cliStatus()).directory,
    );
    refreshedConcierges.set(target.root, conciergeIdentity(reference));
    await target.execute({
      type: "concierge.status",
      status: "ready",
      reference,
      live: { state: "unknown", checkedAt: new Date().toISOString(), reachable: true },
    });
    return reference;
  } catch (error) {
    if (error instanceof ConciergeBlockedError) {
      const reference = (await target.read()).concierge;
      await target.execute({
        type: "concierge.status",
        status: "ready",
        reference,
        live: { state: "blocked", checkedAt: new Date().toISOString(), reachable: true },
        detail: "管家正在等待交互输入；已保留现有现场。",
      });
      return reference;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await target.execute({ type: "concierge.status", status: "error", reference: (await target.read()).concierge, detail });
    throw new Error(`管家尚未准备好：${detail}`);
  }
}
async function openHerdr(reference?: HerdrReference, goalId?: string) {
  const target = activeService(), session = sessionName(target.root);
  const status = await herdrInstallation.ensure(); if (!status.executable) throw new Error("Herdr 尚未准备好，请在设置中重试");
  const connection = client(status.executable, target.root);
  await connection.ensureSession();
  if (reference?.tabId || reference?.agent) await connection.open(reference);
  else await connection.ensureWorkspace();
  if (goalId && reference?.agent && reference.agent !== "concierge") {
    await target.execute({ type: "scene.visit", goalId });
  }
  await terminals.attach(status.executable, session, target.root);
  if (root === target.root) window.webContents.send("crewvane:event", {
    type: "terminal-open", session, title: reference?.agent === "concierge" ? "全局管家" : "工作现场", goalId,
  });
}
async function openConcierge(target = activeService(), goalId?: string) {
  // A stored tab is only a locator. It may still be open while the concierge
  // process has exited or been replaced by a manually started agent.
  const reference = await prepareConcierge(target);
  await openHerdr(reference, goalId);
  const latest = (await target.read()).concierge;
  if (latest.status !== "ready" || latest.detail) {
    await target.execute({
      type: "concierge.status",
      status: "ready",
      reference: latest,
      live: latest.live ?? null,
    });
  }
  if (root === target.root) broadcastSnapshot(await target.read(), target.root);
  return reference;
}
async function reconcileConcierge(target: WorkspaceService, executable: string) {
  if (preparations.has(target.root)) return;
  const state = await target.read();
  if (!state.concierge.agent && !state.concierge.paneId) return;
  const connection = client(executable, target.root);
  const site = await connection.inspectConcierge(state.concierge);
  if (!site) {
    if (state.concierge.status !== "ready" && state.concierge.live?.reachable === false)
      return;
    await target.execute({
      type: "concierge.status",
      status: "not_ready",
      reference: state.concierge,
      live: {
        state: "unknown",
        checkedAt: new Date().toISOString(),
        reachable: false,
      },
      detail: "管家现场已关闭或不可达，请恢复管家。",
    });
    return;
  }
  const previousCheckedAt = Date.parse(state.concierge.live?.checkedAt ?? "");
  const identityChanged = site.reference.paneId !== state.concierge.paneId ||
    site.reference.tabId !== state.concierge.tabId ||
    site.reference.agent !== state.concierge.agent ||
    site.reference.processId !== state.concierge.processId;
  const presenceChanged = state.concierge.status !== "ready" ||
    site.live.state !== state.concierge.live?.state ||
    site.live.reachable !== state.concierge.live?.reachable;
  if (!identityChanged && !presenceChanged && Number.isFinite(previousCheckedAt) &&
    Date.now() - previousCheckedAt < 60_000)
    return;
  await target.execute({
    type: "concierge.status",
    status: "ready",
    reference: site.reference,
    live: site.live,
  });
}
function watchWorkspaceState(target: WorkspaceService) {
  stateWatcher?.close();
  if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
  stateWatcher = watch(join(target.root, ".crewvane"), { persistent: false }, (_event, filename) => {
    const name = filename?.toString();
    if (name && name !== "state.json" && name !== "events.jsonl") return;
    if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
    stateRefreshTimer = setTimeout(async () => {
      if (root !== target.root || service !== target) return;
      try {
        const state = await target.read();
        deliverGoalStatusChanges(target, state, target.root);
        broadcastSnapshot(state, target.root);
      } catch (error) {
        if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
          type: "diagnostic",
          message: `工作区更新暂未同步：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }, 80);
  });
}
function deliverGoalStatusChanges(target: WorkspaceService, state: WorkspaceState, workspace: string) {
  if (knownGoalStatusWorkspace !== workspace) {
    knownGoalStatusWorkspace = workspace;
    knownGoalStatuses.clear();
    for (const goal of state.goals) knownGoalStatuses.set(goal.id, goal.status);
    return;
  }
  const current = new Set(state.goals.map(goal => goal.id));
  for (const id of knownGoalStatuses.keys())
    if (!current.has(id)) knownGoalStatuses.delete(id);
  for (const goal of state.goals) {
    const previousStatus = knownGoalStatuses.get(goal.id);
    knownGoalStatuses.set(goal.id, goal.status);
    if (!previousStatus || previousStatus === goal.status) continue;
    void webhookNotifier.deliverStatusChange({
      workspace: { name: state.name },
      goal,
      previousStatus,
    }).catch(() => {});
  }
}
async function deliverAttentionNotifications(target: WorkspaceService, state: Awaited<ReturnType<WorkspaceService["read"]>>, workspace: string) {
  for (const goal of attentionGoals(state.goals)) {
    if (root !== workspace) break;
    const kind = attentionKind(goal)!;
    if (!goal.attention?.notifiedAt && Notification.isSupported()) {
      try {
        const notification = new Notification({ title: kind === "review" ? "有一份成果等你验收" : kind === "follow_up" ? "到了该跟进的时候" : "Crewvane · 需要你处理", body: `${goal.title}\n${goal.attention?.summary ?? goal.next}`.slice(0, 220) });
        notification.on("click", () => { window.show(); window.webContents.send("crewvane:event", { type: "open-goal", goalId: goal.id }); });
        notification.show();
        await target.execute({ type: "notification.sent", goalId: goal.id, kind,
          attentionId: attentionRequest(goal)?.id, at: new Date().toISOString() });
      } catch {
        // The external channel and inbox remain available if system notification persistence fails.
      }
    }
    void webhookNotifier.deliver({ workspace: { name: state.name }, goal, kind }).catch(() => {});
  }
}
async function openWorkspace(path: string) {
  const canonical = await realpath(path); if (!(await stat(canonical)).isDirectory()) throw new Error("工作区必须是目录");
  const opened = new WorkspaceService(canonical), initialState = await opened.read();
  deliverGoalStatusChanges(opened, initialState, canonical);
  root = canonical; service = opened;
  lastSnapshotSignature = undefined;
  watchWorkspaceState(opened);
  void opened.execute({ type: "attachments.cleanup", retentionDays: 30 }).catch(error => {
    if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `附件清理暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  void runAutomaticCacheCleanup().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `缓存自动清理暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  await mkdir(app.getPath("userData"), { recursive: true }); await writeFile(join(app.getPath("userData"), "workspaces.json"), JSON.stringify({ selected: root }), { mode: 0o600 });
  window.webContents.send("crewvane:event", { type: "refresh", workspace: root });
  if (process.env.CREWVANE_TEST_SKIP_HERDR_SETUP !== "1")
    void prepareHerdrCompanions(canonical).catch(error => {
      if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
        type: "diagnostic", message: error instanceof Error ? error.message : String(error),
      });
    });
}
async function synchronize() {
  if (syncing || !service || !root) return;
  syncing = true;
  const target = service, workspace = root;
  try {
    let state = await target.read();
    deliverGoalStatusChanges(target, state, workspace);
    await deliverAttentionNotifications(target, state, workspace);
    let status = await herdrStatus();
    if (status.executable) {
      try {
        await reconcileConcierge(target, status.executable);
      } catch (error) {
        const current = await target.read();
        if (current.concierge.status === "ready") {
          await target.execute({
            type: "concierge.status",
            status: "not_ready",
            reference: current.concierge,
            live: {
              state: "unknown",
              checkedAt: new Date().toISOString(),
              reachable: false,
            },
            detail: `无法与 Herdr 同步：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      state = await target.read();
      for (const goal of state.goals.filter(goal =>
        ["completed", "dropped"].includes(goal.status) && goal.herdr)) {
        await closeEndedGoalSession(target, goal.id, status.executable).catch(() => {});
      }
      state = await target.read();
    }
    for (const goal of state.goals.filter(goal => goal.mode === "concierge" && goal.dispatch?.status === "pending" &&
      !["completed", "dropped"].includes(goal.status))) {
      void dispatchGoal(target, goal.id).catch(() => {});
    }
    const tracked = state.goals.filter(goal => !["completed", "dropped"].includes(goal.status) &&
      (goal.herdr?.agent || goal.herdr?.transport === "pane"));
    if (status.executable && tracked.length) {
      try {
        const all = await client(status.executable, workspace).presences(tracked);
        const presences = Object.fromEntries(Object.entries(all).filter(([id, presence]) => {
          const previous = tracked.find(goal => goal.id === id)?.live;
          return previous?.state !== presence.state || previous?.reachable !== presence.reachable;
        }));
        if (Object.keys(presences).length) await target.execute({ type: "live.sync", presences });
      } catch {
        const presences = Object.fromEntries(tracked.filter(goal => goal.live?.reachable !== false)
          .map(goal => [goal.id, { state: "unknown" as const, reachable: false, checkedAt: new Date().toISOString() }]));
        if (Object.keys(presences).length) await target.execute({ type: "live.sync", presences });
      }
    }
    if (status.executable) {
      const connection = client(status.executable, workspace);
      // This runs outside the coordinator queue: it talks only to the owner.
      for (const item of (await target.read()).goals.filter(goal => goal.sceneVisit?.status === "pending"))
        void reconcileSceneReply(target, item.id, connection).catch(() => {});
    }
    const requests = (await target.execute({ type: "watchdog.inspect", at: new Date().toISOString() }) as WatchdogRequest[]).slice(0, 10);
    state = await target.read();
    // An agent may write a decision or delivery while the concierge prompt is
    // in flight. That structured fact supersedes a quiet-terminal probe.
    const activeRequests = requests.filter(request => {
      const goal = state.goals.find(item => item.id === request.goalId);
      return goal?.watchdog?.basis === request.basis && !goal.attention;
    });
    if (activeRequests.length && root === workspace) {
      let failure: string | undefined;
      try {
        if (!status.executable || state.concierge.status !== "ready") throw new Error("管家尚未连接，请点击「找管家」恢复");
        const coordinator = client(status.executable, workspace);
        await coordinate(target, async () => {
          for (const request of activeRequests) {
            await writeCoordinatorScope(target.root, request.goalId, `watchdog-${Date.parse(request.basis)}`);
            await coordinator.notifyWatchdog(state.concierge, [request]);
          }
        });
      } catch (error) { failure = error instanceof Error ? error.message : String(error); }
      for (const request of requests) await target.execute({
        type: "watchdog.report", goalId: request.goalId, at: new Date().toISOString(), basis: request.basis,
        outcome: failure ? "failed" : "contacted", ...(failure ? { detail: failure.slice(0, 1000) } : {}),
      });
    }
    state = await target.read();
    await deliverAttentionNotifications(target, state, workspace);
    broadcastSnapshot(state, workspace);
  } catch (error) {
    if (root === workspace && !window.isDestroyed()) window.webContents.send("crewvane:event", { type: "diagnostic", message: `后台同步暂未成功：${error instanceof Error ? error.message : String(error)}` });
  } finally { syncing = false; }
}
const singleInstance = process.env.CREWVANE_TEST_USER_DATA ? true : app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  if (process.env.CREWVANE_TEST_USER_DATA) app.setPath("userData", process.env.CREWVANE_TEST_USER_DATA);
  if (process.env.CREWVANE_TEST_HOME) app.setPath("home", process.env.CREWVANE_TEST_HOME);
  if (process.env.CREWVANE_TEST_HOME) {
    // Every Herdr child must address the same session, including the PTY and
    // CLI diagnostics. Changing Electron's home alone leaves HOME unchanged.
    process.env.HOME = app.getPath("home");
    process.env.XDG_CONFIG_HOME = join(app.getPath("home"), ".config");
    process.env.XDG_STATE_HOME = join(app.getPath("home"), ".local/state");
  }
  terminals.setEnvironment(process.env);
  webhookNotifier = new WebhookNotifier(app.getPath("userData"), app.getVersion());
  const managedBin = join(app.getPath("userData"), "runtime");
  tools = new Executables(app.getPath("home"), managedBin, process.env,
    !!process.env.CREWVANE_TEST_HOME && process.env.CREWVANE_TEST_ISOLATE_TOOLS === "1");
  herdrInstallation = new HerdrInstallation(
    tools,
    join(managedBin, "herdr"),
    broadcastHerdrStatus,
    fetch,
    process.platform,
    process.arch,
    app.isPackaged ? join(process.resourcesPath, "herdr") : undefined,
    process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || undefined,
  );
  if (process.env.CREWVANE_TEST_ISOLATE_TOOLS === "1") herdrInstallation.disableBundledForTest();
  const integrationEnvironment = process.env.CREWVANE_TEST_HOME ? {
    ...process.env,
    HOME: app.getPath("home"),
    XDG_CONFIG_HOME: join(app.getPath("home"), ".config"),
    XDG_STATE_HOME: join(app.getPath("home"), ".local/state"),
  } : process.env;
  herdrPlugin = new HerdrPlugin(
    app.isPackaged ? join(process.resourcesPath, "herdr-plugin") : join(app.getAppPath(), "herdr-plugin"),
    join(app.getPath("userData"), "herdr-plugin"),
    app.getVersion(),
    integrationEnvironment,
  );
  skillInstaller = new CrewvaneSkillInstaller(
    app.isPackaged
      ? join(process.resourcesPath, "crewvane-skill")
      : join(here, "../../skills/crewvane"),
    app.getPath("home"),
    app.getVersion(),
  );
  app.setName("Crewvane");
  // BrowserWindow.icon is ignored by the macOS Dock in development.
  // Packaged builds embed the same artwork as their CFBundleIconFile.
  app.dock?.setIcon(nativeImage.createFromPath(join(here, "assets/crewvane-icon.png")));
  process.env.PATH = (await tools.paths()).join(":");
  const width = Number(process.env.CREWVANE_TEST_WINDOW_WIDTH), height = Number(process.env.CREWVANE_TEST_WINDOW_HEIGHT);
  window = new BrowserWindow({ width: Number.isFinite(width) && width >= 900 ? width : 1440, height: Number.isFinite(height) && height >= 700 ? height : 960, minWidth: 900, minHeight: 700, title: "Crewvane · 协航", titleBarStyle: "hiddenInset", backgroundColor: WINDOW_BACKGROUND, icon: join(here, "assets/crewvane-icon.png"), webPreferences: { preload: join(here, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" })); window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.on("close", (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  ipcMain.handle("crewvane:environment", (event) => { sender(event); return { workspace: root, version: app.getVersion() }; });
  ipcMain.handle("crewvane:import-attachments", async (event, inputs: { name: string; bytes: ArrayBuffer }[]) => {
    sender(event);
    const target = activeService();
    if (!Array.isArray(inputs) || inputs.length > 8) throw new Error("附件列表无效");
    return importAttachmentBytes(target.root, inputs.map(input => ({ name: input?.name, bytes: input?.bytes })));
  });
  ipcMain.handle("crewvane:attachment-preview", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { attachment, path } = await validatedAttachment(goalId, attachmentId),
      image = nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error(`无法读取图片：${attachment.name}`);
    const size = image.getSize(), scale = Math.min(1, 360 / size.width, 240 / size.height);
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: "best",
    }).toDataURL();
  });
  ipcMain.handle("crewvane:open-attachment", async (event, goalId: string, attachmentId: string) => {
    sender(event);
    const { path } = await validatedAttachment(goalId, attachmentId),
      error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  ipcMain.handle("crewvane:workspace", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择 Crewvane 工作区", properties: ["openDirectory", "createDirectory"] }); if (picked.canceled || !picked.filePaths[0]) return null; await openWorkspace(picked.filePaths[0]); return root; });
  ipcMain.handle("crewvane:project", async (event) => { sender(event); const picked = await dialog.showOpenDialog(window, { title: "选择项目目录", properties: ["openDirectory"] }); const path = picked.filePaths[0]; if (!path) return null; const real = await realpath(path); selections.add(real); return real; });
  ipcMain.handle("crewvane:command", async (event, command: CrewvaneCommand) => {
    sender(event); if (!command || JSON.stringify(command).length > 256_000) throw new Error("无效的命令");
    if (command.type === "project.add" && command.path && !selections.has(command.path)) throw new Error("请通过文件选择器选择项目目录");
    if (command.type === "agents.configure") {
      const kinds = (await agentChoices()).map(option => option.kind);
      for (const value of Object.values(command.preferences)) if (value?.trim()) parseAgentCommand(value, kinds);
    }
    const target = activeService();
    if (command.type === "goal.delete") {
      const item = (await target.read()).goals.find(goal => goal.id === command.goalId);
      if (item && ["completed", "dropped"].includes(item.status) && item.herdr)
        await closeEndedGoalSession(target, item.id);
    }
    const result = await target.execute(command);
    if (command.type === "scene.visit" && command.retry) {
      const status = await herdrStatus();
      if (status.executable) void reconcileSceneReply(target, command.goalId, client(status.executable, target.root)).catch(() => {});
    }
    if (command.type === "goal.intake" || command.type === "goal.message" || (command.type === "goal.create" && command.input.mode === "concierge") ||
      command.type === "goal.followup" || command.type === "goal.delegate" || (command.type === "goal.resume" && command.mode === "concierge") ||
      command.type === "goal.resolve" ||
      (command.type === "goal.progress" && command.actor === "你" && (result as import("../../../packages/core/src/index.js").Goal).mode === "concierge")) {
      const item = result as import("../../../packages/core/src/index.js").Goal;
      if (item.dispatch?.status === "pending") void dispatchGoal(target, item.id).catch((error) => {
        if (root === target.root) window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) });
      });
    }
    if (["goal.accept", "goal.complete", "goal.drop"].includes(command.type)) {
      const item = result as import("../../../packages/core/src/index.js").Goal;
      await closeEndedGoalSession(target, item.id).catch((error) => {
        if (root === target.root) window.webContents.send("crewvane:event", {
          type: "diagnostic",
          message: `目标已结束，负责人现场暂未关闭，将自动重试：${error instanceof Error ? error.message : String(error)}`,
        });
      });
    }
    if (["goal.rework", "goal.resolve", "goal.update"].includes(command.type)) {
      const item = result as import("../../../packages/core/src/index.js").Goal, current = await target.read();
      if (item.mode === "concierge" && current.concierge.status === "ready" && item.dispatch?.status !== "pending") {
        const status = await herdrStatus();
        if (status.executable) {
          const herdrExecutable = status.executable;
          try { await coordinate(target, async () => {
            await writeCoordinatorScope(target.root, item.id, `event-${Date.now()}`);
            await client(herdrExecutable, target.root).notifyGoal(current.concierge, item.id, item.title, item, target.root);
          }); }
          catch (error) { window.webContents.send("crewvane:event", { type: "diagnostic", message: error instanceof Error ? error.message : String(error) }); }
        }
      }
    }
    if (root === target.root) {
      const state = await target.read();
      deliverGoalStatusChanges(target, state, target.root);
      broadcastSnapshot(state, target.root);
    }
    return result;
  });
  ipcMain.handle("crewvane:herdr-status", (event) => { sender(event); return herdrStatus(); });
  ipcMain.handle("crewvane:cache-status", (event) => {
    sender(event);
    activeService();
    return queueCacheMaintenance(() => inspectManagedCaches(cacheMaintenancePaths()));
  });
  ipcMain.handle("crewvane:cache-clean", (event) => {
    sender(event);
    activeService();
    return queueCacheMaintenance(() => clearManagedCaches(cacheMaintenancePaths(), {
      mode: "manual",
      clearBrowserRuntime: () => session.defaultSession.clearCache(),
    }));
  });
  ipcMain.handle("crewvane:agent-choices", (event) => { sender(event); return agentChoices(); });
  ipcMain.handle("crewvane:webhook-settings", (event) => { sender(event); return webhookNotifier.status(); });
  ipcMain.handle("crewvane:webhook-save", (event, input: WebhookSaveInput) => {
    sender(event);
    return webhookNotifier.save(input);
  });
  ipcMain.handle("crewvane:webhook-test", async (event) => {
    sender(event);
    return webhookNotifier.test((await activeService().read()).name);
  });
  ipcMain.handle("crewvane:install-herdr", (event) => { sender(event); return installHerdr(); });
  ipcMain.handle("crewvane:cli-status", (event) => { sender(event); return cliStatus(); });
  ipcMain.handle("crewvane:install-cli", (event) => { sender(event); return installCli(); });
  ipcMain.handle("crewvane:skills-status", (event) => { sender(event); return skillsStatus(); });
  ipcMain.handle("crewvane:install-skills", (event) => { sender(event); return installSkills(); });
  ipcMain.handle("crewvane:clipboard-read", (event) => { sender(event); return clipboard.readText(); });
  ipcMain.handle("crewvane:clipboard-write", (event, value: unknown) => {
    sender(event);
    if (typeof value !== "string" || value.length > 2_000_000) throw new Error("剪贴板文本无效");
    clipboard.writeText(value);
  });
  ipcMain.handle("crewvane:prepare-concierge", (event) => { sender(event); return prepareConcierge(); });
  ipcMain.handle("crewvane:dispatch-goal", (event, goalId: string) => { sender(event); return dispatchGoal(activeService(), goalId); });
  ipcMain.handle("crewvane:restart-goal", (event, goalId: string, note: string) => {
    sender(event);
    if (typeof goalId !== "string" || typeof note !== "string")
      throw new Error("重启参数无效");
    return restartEndedGoal(activeService(), goalId, note);
  });
  ipcMain.handle("crewvane:open-terminal", async event => { sender(event); await openHerdr(); });
  ipcMain.handle("crewvane:open-herdr", async (event, goalId?: string) => {
    sender(event);
    const target = activeService(), state = await target.read();
    if (!goalId) {
      await openConcierge(target);
      return;
    }
    const item = goalId ? state.goals.find((goal) => goal.id === goalId) : undefined;
    if (goalId && !item) throw new Error("目标不存在");
    if (item?.mode === "concierge" && !item.herdr) {
      await openConcierge(target, goalId);
      return;
    }
    await openHerdr(item?.herdr, goalId);
  });
  ipcMain.handle("crewvane:terminal-snapshot", (event) => { sender(event); activeService(); return terminals.snapshot(sessionName()); });
  ipcMain.handle("crewvane:terminal-write", (event, session: string, data: string) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.write(session, data);
  });
  ipcMain.handle("crewvane:terminal-resize", (event, session: string, cols: number, rows: number) => {
    sender(event); activeService(); if (session !== sessionName()) throw new Error("终端不属于当前工作区"); terminals.resize(session, cols, rows);
  });
  ipcMain.handle("crewvane:open-url", async (event, url: string) => { sender(event); if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("只允许打开 HTTPS 链接"); await shell.openExternal(url); });
  ipcMain.handle("crewvane:open-recovery-backup", async (event) => {
    sender(event);
    const target = activeService(), recovery = (await target.read()).recovery;
    if (!recovery) throw new Error("当前工作区没有待查看的旧版备份");
    const owner = await realpath(target.root),
      archived = await realpath(recovery.archivedPath).catch(() => "");
    if (!archived || dirname(archived) !== owner || !basename(archived).startsWith(".crewvane.backup-"))
      throw new Error("旧版备份路径已失效或不属于当前工作区");
    const failure = await shell.openPath(archived);
    if (failure) throw new Error(`无法打开旧版备份：${failure}`);
  });
  ipcMain.handle("crewvane:show-cli", async (event) => { sender(event); shell.showItemInFolder((await cliStatus()).path); });
  // Use the approved application artwork, with a Retina representation.
  const traySource = nativeImage.createFromPath(join(here, "assets/crewvane-icon.png"));
  const trayIcon = traySource.resize({ width: 18, height: 18, quality: "best" });
  trayIcon.addRepresentation({ scaleFactor: 2, buffer: traySource.resize({ width: 36, height: 36, quality: "best" }).toPNG() });
  trayIcon.setTemplateImage(false);
  tray = new Tray(trayIcon); tray.setToolTip("Crewvane · 协航"); tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 Crewvane", click: () => { window.show(); window.focus(); } }, { type: "separator" }, { label: "退出", click: () => app.quit() }])); tray.on("click", () => { window.show(); window.focus(); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Crewvane", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "quit" }] }, { role: "editMenu" }, { role: "viewMenu" }]));
  await window.loadURL(rendererURL);
  if (process.env.CREWVANE_TEST_SKIP_HERDR_SETUP !== "1")
    void prepareHerdrCompanions().catch(() => { /* persistent readiness error is shown by the renderer */ });
  const saved = await readFile(join(app.getPath("userData"), "workspaces.json"), "utf8").then(JSON.parse).catch(() => null), workspace = process.env.CREWVANE_TEST_WORKSPACE ?? saved?.selected;
  if (workspace) await openWorkspace(workspace).catch((error) => window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) }));
  if (process.env.CREWVANE_TEST_PREPARE_CONCIERGE === "1") {
    void prepareConcierge().catch((error) => window.webContents.send("crewvane:event", { type: "diagnostic", message: String(error) }));
  }
  setInterval(() => void synchronize(), 10_000); void synchronize();
});
app.on("activate", () => window?.show());
app.on("before-quit", () => {
  quitting = true;
  stateWatcher?.close();
  if (stateRefreshTimer) clearTimeout(stateRefreshTimer);
  terminals.dispose();
});
