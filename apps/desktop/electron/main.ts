import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray } from "electron";
import { watch, type FSWatcher } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, realpath, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  attentionGoals,
  attentionKind,
  attentionRequest,
  attachmentAbsolutePath,
  importAttachmentBytes,
  SkillRegistry,
  validateGoalAttachments,
  validatedScene,
  WorkspaceService,
  type CrewvaneCommand,
  type Goal,
  type GoalStatus,
  type HerdrReference,
  type LivePresence,
  type WatchdogReason,
  type WatchdogRequest,
  type WorkspaceState,
} from "../../../packages/core/src/index.js";
import {
  ConciergeBlockedError,
  HerdrClient,
  herdrRunner,
  quoteShell,
  startDetachedHerdrServer,
} from "./herdr.js";
import { refreshConciergeIfSafe } from "./concierge-lifecycle.js";
import { TerminalHost } from "./terminal-host.js";
import { parseAgentCommand } from "./agent-command.js";
import { Executables } from "./executables.js";
import { HerdrInstallation, type HerdrStatus } from "./herdr-install.js";
import { OrcaInstallation } from "./orca-install.js";
import {
  SessionControl,
  SessionError,
  SessionRuntime,
  SessionRecoveryChannel,
  detectOrcaApplication,
  localProcesses,
  localAdapter,
  type SwitchAuthority,
} from "../../../packages/sessions/src/index.js";
import { HerdrPlugin } from "./herdr-plugin.js";
import { deliverGoalUpdate } from "./goal-delivery.js";
import { reconcileSceneReply } from "./scene-reconciliation.js";
import { SessionPoller } from "./session-poller.js";
import { CoordinatorInbox, type CoordinatorInboxItem, type CoordinatorInboxStatus } from "./coordinator-inbox.js";
import { CoordinatorDispatcher, type CoordinatorExecutionResult } from "./coordinator-dispatcher.js";
import { writeCoordinatorScope } from "./coordinator-scope.js";
import { WebhookNotifier, type WebhookSaveInput } from "./webhook-notifications.js";
import { CrewvaneSkillInstaller } from "./skill-installer.js";
import { launchOwner, type HerdrCommandRunner } from "../../../cli/src/owner-launch.js";
import { clearManagedCaches, inspectManagedCaches } from "./cache-maintenance.js";
import {
  AgentHookManager,
  type ManagedAdapterId,
} from "./agent-hook-manager.js";
import { AgentRuntimeBroker } from "./agent-runtime-broker.js";
import { HerdrHostBridge } from "./herdr-host-bridge.js";
import {
  ExternalTerminalManager,
  type ExternalSceneLease,
  type SceneSettings,
} from "./external-terminal.js";
import {
  AutonomyScheduler,
  type AutonomyCandidate,
  type AutonomyDispatchResult,
} from "./autonomy-scheduler.js";
import {
  backendHandoffAdvanced,
  backendHandoffHasPersistedProof,
  captureBackendHandoffEvidence,
} from "./backend-handoff-proof.js";
import { prepareBackendHandoffCase } from "./backend-handoff-case.js";
import { SessionCommandHost } from "./session-command-host.js";
const exec = promisify(execFile);
let window: BrowserWindow, tray: Tray, root: string | undefined, service: WorkspaceService | undefined, syncing = false, quitting = false;
let stateWatcher: FSWatcher | undefined, stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const selections = new Set<string>();
const selectedSkillDirectories = new Set<string>();
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
let tools: Executables, herdrInstallation: HerdrInstallation, herdrPlugin: HerdrPlugin, webhookNotifier: WebhookNotifier, skillInstaller: CrewvaneSkillInstaller, agentHookManager: AgentHookManager, agentRuntimeBroker: AgentRuntimeBroker, externalTerminals: ExternalTerminalManager;
let coordinatorInbox: CoordinatorInbox | undefined, coordinatorDispatcher: CoordinatorDispatcher | undefined;
let herdrHostBridge: HerdrHostBridge | undefined;
let autonomyScheduler: AutonomyScheduler | undefined;
let sessionControl: SessionControl, orcaInstallation: OrcaInstallation;
let backendSwitchAbort: AbortController | undefined;
const sessionRuntimes = new Map<string, SessionRuntime>();
const sessionHosts = new Map<string, Promise<SessionCommandHost>>();
const sessionPoller = new SessionPoller();
async function ensureSessionCommandHost(workspace: string): Promise<SessionCommandHost> {
  let pending = sessionHosts.get(workspace);
  if (!pending) {
    pending = (async () => {
      const host = new SessionCommandHost({
        workspace, directory: sessionControl.directory,
        canDispatch: () => sessionControl.canDispatch(),
        runtime: context => new SessionRuntime({
          ...sessionRuntime(workspace).options, managedContext: context, hostExecution: true,
        }),
      });
      await host.start();
      return host;
    })();
    sessionHosts.set(workspace, pending);
    void pending.catch(() => { if (sessionHosts.get(workspace) === pending) sessionHosts.delete(workspace); });
  }
  return pending;
}
async function backendAdapter(backend: "herdr" | "orca", workspace: string) {
  const control = await sessionControl.status();
  const herdr = backend === "herdr" ? await herdrInstallation.ensure() : undefined;
  if (backend === "herdr" && !herdr?.executable)
    throw new Error(herdr?.detail || "Herdr 当前不可用。");
  return localAdapter({
    backend,
    workspace,
    control,
    directory: join(app.getPath("userData"), "session-control"),
    herdrExecutable: herdr?.executable,
    environment: process.env,
  });
}
function sessionRuntime(workspace = root) {
  if (!workspace) throw new Error("请先打开工作区");
  const existing = sessionRuntimes.get(workspace);
  if (existing) return existing;
  const runtime = new SessionRuntime({
    control: sessionControl,
    workspace,
    cliDirectory: join(app.getPath("userData"), "bin"),
    environment: process.env,
    prepareHost: async () => { await ensureSessionCommandHost(workspace); },
    adapter: backendAdapter,
  });
  sessionRuntimes.set(workspace, runtime);
  return runtime;
}
async function adoptVerifiedLegacyScenes(workspace: string) {
  const control = await sessionControl.status();
  if (control.selected !== "herdr") return { adopted: 0, cleared: 0, blocked: 0 };
  const target = new WorkspaceService(workspace), before = await target.read();
  let legacyGoals = before.goals.filter(goal =>
    (goal.legacyScene || goal.herdr) &&
    !["completed", "dropped", "backlog"].includes(goal.status));
  const verifyConcierge = before.concierge.legacyScene ||
    ("paneId" in before.concierge ? before.concierge.paneId : undefined);
  if (!legacyGoals.length && !verifyConcierge) return { adopted: 0, cleared: 0, blocked: 0 };
  const status = await herdrInstallation.ensure();
  if (!status.executable) throw new Error(status.detail ?? "旧 Herdr 现场需要 Herdr 才能重新核实。");
  const adapter = await backendAdapter("herdr", workspace);
  const detection = await adapter.detect();
  if (detection.status !== "compatible")
    throw new Error(detection.detail ?? "Herdr 版本无法核实旧现场。");
  const runtime = await adapter.connect({ installationId: control.installationId, cwd: workspace });
  const connection = client(status.executable, workspace);
  let adopted = 0, cleared = 0, blocked = 0;
  async function convert(reference: {
    session: string; workspaceId?: string; tabId?: string; paneId?: string;
    agent?: string; transport?: "pane"; processId?: number; launchPolicy?: "control-plane-v1";
  }, attemptId?: string) {
    const verified = await connection.inspectManagedReference(reference as HerdrReference).catch(() => undefined);
    if (!verified) {
      if (!reference.processId) {
        cleared++;
        return { kind: "stale" as const };
      }
      blocked++;
      return { kind: "blocked" as const };
    }
    const processIdentity = await localProcesses.identity(verified.reference.processId!);
    if (!processIdentity) {
      blocked++;
      return { kind: "blocked" as const };
    }
    adopted++;
    return {
      kind: "scene" as const,
      scene: {
        version: 1 as const,
        backend: "herdr" as const,
        installationId: control.installationId,
        runtimeId: runtime.id,
        runtimeGeneration: runtime.generation,
        bindingId: randomUUID(),
        attemptId: attemptId ?? randomUUID(),
        backendEpoch: control.epoch,
        process: processIdentity,
        locator: {
          kind: "herdr" as const,
          session: verified.reference.session,
          workspaceId: verified.reference.workspaceId!,
          tabId: verified.reference.tabId!,
          paneId: verified.reference.paneId!,
          ...(verified.reference.agent ? { agent: verified.reference.agent } : {}),
          ...(verified.reference.transport ? { transport: verified.reference.transport } : {}),
          ...(verified.reference.processId ? { processId: verified.reference.processId } : {}),
          ...(verified.reference.launchPolicy ? { launchPolicy: verified.reference.launchPolicy } : {}),
        },
      },
    };
  }
  if (before.concierge.legacyScene) {
    const converted = await convert(before.concierge.legacyScene.reference);
    if (converted.kind === "scene") await target.execute({
      type: "scene.bind", scene: converted.scene, role: "concierge",
    });
    else if (converted.kind === "stale") await target.execute({
      type: "scene.legacy.clear",
      reason: "旧管家进程已经不存在，切换到按目标记录恢复。",
    });
  }
  for (const goal of legacyGoals) {
    const legacy = goal.legacyScene ?? (goal.herdr ? {
      reference: goal.herdr,
    } : undefined);
    if (!legacy) continue;
    const converted = await convert(legacy.reference, goal.agentRuntime?.attempt.attemptId);
    if (converted.kind === "scene") await target.execute({
      type: "scene.bind", goalId: goal.id, scene: converted.scene, role: "owner",
    });
    else if (converted.kind === "stale") await target.execute({
      type: "scene.legacy.clear", goalId: goal.id,
      reason: "旧负责人进程已经不存在，切换到按目标记录恢复。",
    });
  }
  const after = await target.read();
  for (const goal of after.goals) {
    if (!goal.autonomy?.verificationSite?.legacyScene || goal.autonomy.verificationSite.scene) continue;
    const converted = await convert(goal.autonomy.verificationSite.legacyScene.reference);
    if (converted.kind === "scene") await target.execute({
      type: "scene.bind", goalId: goal.id, scene: converted.scene, role: "verifier",
    });
  }
  return { adopted, cleared, blocked };
}
type SceneOpenResult =
  | { mode: "external"; lease: ExternalSceneLease }
  | { mode: "embedded" }
  | { mode: "native"; app: "Orca" };
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
type AgentHookStatuses = Awaited<ReturnType<AgentHookManager["status"]>>;
function broadcastAgentRuntimeStatus(
  statuses: AgentHookStatuses | Promise<AgentHookStatuses> = agentHookManager?.status() ?? [],
) {
  void Promise.resolve(statuses).then(status => {
    if (window && !window.isDestroyed())
      window.webContents.send("crewvane:event", {
        type: "agent-runtime-status",
        status,
      });
  }).catch(() => {});
}
async function agentRuntimeStatus() {
  if (!agentHookManager) return [];
  return agentHookManager.status();
}
async function configureAgentRuntime(id: string, action: string) {
  if (!agentHookManager || !["codex", "claude-code", "cursor", "qoder", "omp"].includes(id))
    throw new Error("无效的 Agent Runtime Adapter");
  let result;
  if (action === "install") result = await agentHookManager.install(id as ManagedAdapterId);
  else if (action === "disable") result = await agentHookManager.disable(id as ManagedAdapterId);
  else if (action === "uninstall") result = await agentHookManager.uninstall(id as ManagedAdapterId);
  else if (action === "refresh") result = (await agentHookManager.autoInstallDetected())
    .find(item => item.id === id);
  else throw new Error("无效的 Agent 接入操作");
  await agentRuntimeBroker?.refresh();
  const statuses = await agentHookManager.status();
  broadcastAgentRuntimeStatus(statuses);
  return result ?? statuses.find(item => item.id === id);
}
async function installDetectedAgentHooks() {
  if (!agentHookManager) return [];
  const statuses = await agentHookManager.autoInstallDetected();
  broadcastAgentRuntimeStatus(statuses);
  return statuses;
}
async function remindRuntimeOwner(goal: Goal, prompt: string) {
  const target = activeService(), current = (await target.read()).goals.find(item => item.id === goal.id);
  if (!current?.scene) throw new Error("负责人现场暂不可达");
  const receipt = await sessionRuntime(target.root).send(
    current.scene,
    `receipt-reminder-${current.agentRuntime?.receipt?.turnId ?? randomUUID()}`,
    prompt,
  );
  if (receipt.status === "rejected") throw new Error(receipt.detail ?? "负责人现场拒绝本次提醒。");
  return {
    status: receipt.status === "unknown" ? "unconfirmed" as const : "sent" as const,
    ...(receipt.detail ? { detail: receipt.detail } : {}),
  };
}
async function notifyRuntimeConcierge(goal: Goal, detail: string) {
  const target = activeService(), state = await target.read();
  const current = state.goals.find(item => item.id === goal.id) ?? goal;
  const issue: WatchdogRequest = {
    goalId: goal.id,
    reason: "protocol_missing",
    basis: current.watchdog?.basis ??
      current.agentRuntime?.receipt?.missingAt ??
      current.updatedAt,
  };
  await enqueueWatchdog(target, issue, detail);
  await drainCoordinatorQueue(target);
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
const AGENT_COMMANDS = [
  "codex",
  "claude",
  "cursor",
  "cursor-agent",
  "qoder",
  "qodercli",
  "omp",
  "gemini",
  "aider",
] as const;
async function agentChoices() {
  // Agent detection belongs to the shared runtime layer. It must not probe or
  // even start Herdr while Orca is the selected backend.
  return Promise.all(AGENT_COMMANDS.map(async kind => ({
    kind, installed: Boolean(await executable(kind)),
  })));
}
let companionPreparation: {
  workspace: string;
  promise: Promise<Awaited<ReturnType<typeof prepareHerdrCompanionsNow>>>;
} | undefined;
function prepareHerdrCompanions(workspace = root) {
  const requestedWorkspace = workspace ?? "";
  if (companionPreparation?.workspace === requestedWorkspace)
    return companionPreparation.promise;
  const previous = companionPreparation?.promise.catch(() => undefined),
    promise = (previous ?? Promise.resolve()).then(() =>
      prepareHerdrCompanionsNow(requestedWorkspace),
    ).finally(() => {
      if (companionPreparation?.promise === promise)
        companionPreparation = undefined;
    });
  companionPreparation = { workspace: requestedWorkspace, promise };
  return promise;
}
async function prepareHerdrCompanionsNow(workspace = root) {
  try {
    await installCli(workspace);
    await installDetectedAgentHooks();
  } catch (error) {
    if (window && !window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `Crewvane CLI 或 Agent Hook 准备暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const control = await sessionControl.status();
  if (control.selected === "orca") {
    await orcaInstallation.refresh(control.orcaAppPath);
    return await orcaInstallation.status();
  }
  const status = await herdrInstallation.ensure();
  if (!status.executable) return status;
  const plugin = await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  if (plugin.phase === "error") throw new Error(plugin.detail);
  return status;
}
async function installHerdr() {
  try {
    await installCli();
    await installDetectedAgentHooks();
  } catch (error) {
    if (window && !window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `Crewvane CLI 或 Agent Hook 准备暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  }
  const status = await herdrInstallation.ensure(true);
  if (!status.executable) return status;
  await herdrPlugin.ensure(status.executable);
  broadcastHerdrStatus(status);
  return status;
}
async function checkHerdrUpdate() {
  const status = await herdrInstallation.check();
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
function methodRegistry() {
  const target = activeService();
  return {
    target,
    registry: new SkillRegistry(target.root, app.getVersion()),
  };
}
async function methodPacksStatus() {
  return methodRegistry().registry.list();
}
async function previewMethodPack() {
  methodRegistry();
  const picked = await dialog.showOpenDialog(window, {
    title: "选择本地能力包目录",
    buttonLabel: "检查能力包",
    properties: ["openDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return null;
  const path = await realpath(picked.filePaths[0]),
    { registry } = methodRegistry(),
    preview = await registry.validate(path);
  selectedSkillDirectories.add(path);
  return { path, ...preview };
}
async function installMethodPack(path: string, approveScripts: string[]) {
  if (typeof path !== "string" || !selectedSkillDirectories.has(path))
    throw new Error("请先通过目录选择器检查能力包");
  if (!Array.isArray(approveScripts) || approveScripts.length > 20 ||
    approveScripts.some(id => typeof id !== "string"))
    throw new Error("脚本授权参数无效");
  const { registry } = methodRegistry(),
    installed = await registry.install(path, { approveScripts });
  selectedSkillDirectories.delete(path);
  if (window && !window.isDestroyed())
    window.webContents.send("crewvane:event", {
      type: "method-packs-status",
      packs: await registry.list(),
    });
  return installed;
}
async function mutateMethodPack(
  packId: string,
  action: "approve" | "disable" | "enable" | "remove",
  scriptIds: string[] = [],
) {
  if (typeof packId !== "string") throw new Error("能力包 ID 无效");
  const { registry } = methodRegistry();
  if (action === "approve") {
    if (!Array.isArray(scriptIds) || !scriptIds.length)
      throw new Error("至少选择一个需要授权的脚本");
    await registry.approveScripts(packId, scriptIds);
  } else if (action === "disable") await registry.disable(packId, true);
  else if (action === "enable") await registry.disable(packId, false);
  else if (action === "remove") await registry.remove(packId);
  else throw new Error("无效的能力包操作");
  const packs = await registry.list();
  if (window && !window.isDestroyed())
    window.webContents.send("crewvane:event", {
      type: "method-packs-status",
      packs,
    });
  return packs;
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
  const controlDirectory = join(app.getPath("userData"), "session-control");
  await writeFile(launcher, `#!/bin/sh\n# Crewvane embedded CLI\n[ -n "\${CREWVANE_WORKSPACE:-}" ] || CREWVANE_WORKSPACE=${defaultRoot}\nexport CREWVANE_WORKSPACE\nCREWVANE_CONTROL_DIRECTORY=${quoteShell(controlDirectory)}\nCREWVANE_CLI_DIRECTORY=${quoteShell(status.directory)}\nexport CREWVANE_CONTROL_DIRECTORY CREWVANE_CLI_DIRECTORY\nELECTRON_RUN_AS_NODE=1 exec ${quoteShell(cliRuntime)} ${quoteShell(cliBundle)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  if (status.installed) await unlink(status.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(launcher, status.path);
  // On first launch there may be no workspace yet. Do not run status from
  // Finder's "/" working directory, which would look like a request to create
  // "/.crewvane-lock". A real workspace queues a second preparation pass and
  // then performs the full CLI check.
  const checked = workspace
    ? await exec(status.path, ["status", "--root", workspace], { timeout: 15_000 })
    : undefined;
  const installed = await cliStatus();
  if (window && !window.isDestroyed()) {
    window.webContents.send("crewvane:event", { type: "cli-status", status: installed });
  }
  return { ...installed, output: checked?.stdout.trim() ?? "" };
}
function client(path: string, workspace = root) {
  const session = sessionName(workspace);
  if (!workspace) throw new Error("请先选择工作区");
  return new HerdrClient(herdrRunner(path, session), session, workspace, async () => {
    await terminals.attach(path, session, workspace!);
    if (root === workspace) window.webContents.send("crewvane:event", { type: "terminal-available", session, title: "全局管家" });
  });
}
function externalClient(path: string, workspace = root) {
  const session = sessionName(workspace);
  if (!workspace) throw new Error("请先选择工作区");
  return new HerdrClient(herdrRunner(path, session), session, workspace, async () => {
    // External scenes must never depend on the embedded PTY succeeding. Start
    // the named server headlessly; the user's terminal performs the attach.
    startDetachedHerdrServer(path, session, workspace);
  });
}
async function closeEndedGoalSession(target: WorkspaceService, goalId: string, executable?: string) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item || !["completed", "dropped"].includes(item.status)) return false;
  if (item.scene) {
    await sessionRuntime(target.root).captureOwnerResume(goalId, item.scene).catch(() => undefined);
    await sessionRuntime(target.root).close(item.scene, goalId);
    return true;
  }
  if (!item.herdr) return false;
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
  // A previous close may have failed. Close only an identity-verified scene
  // before opening the new backend attempt.
  if (item.scene || item.herdr)
    await closeEndedGoalSession(target, item.id);
  const restarted = await target.execute({ type: "goal.restart", goalId, note }) as Goal;
  void agentRuntimeBroker?.refresh(goalId).catch(() => {});
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
const preparations = new Map<string, Promise<import("../../../packages/core/src/index.js").SceneReferenceV1>>();
const handoffs = new Map<string, Promise<void>>();
// A real Codex/OMP turn can legitimately spend more than 30 seconds creating
// an owner and recording its first structured proof. Backend switching waits
// for that turn to become idle before sending the next case instead of turning
// normal coordination latency into recovery_required.
const CONCIERGE_TURN_TIMEOUT_MS = 120_000;
const BACKEND_HANDOFF_STALL_PROBE_MS = 15_000;
const BACKEND_HANDOFF_IDLE_SETTLE_MS = 30_000;
const BACKEND_HANDOFF_PROOF_TIMEOUT_MS = 240_000;
function broadcastCoordinatorStatus(status: CoordinatorInboxStatus) {
  if (window && !window.isDestroyed())
    window.webContents.send("crewvane:event", { type: "coordinator-status", status });
}
function coordinatorPriority(kind: CoordinatorInboxItem["kind"], reason?: string) {
  if (kind === "feedback" || kind === "restart" || kind === "scene_reply") return "human" as const;
  if (kind === "follow_up") return "attention" as const;
  if (kind === "watchdog") return reason === "blocked" || reason === "missing"
    ? "attention" as const : "background" as const;
  if (kind === "reconcile") return "background" as const;
  return "normal" as const;
}
async function enqueueWatchdog(target: WorkspaceService, issue: WatchdogRequest, detail?: string) {
  if (root !== target.root) return;
  const { inbox } = await ensureCoordinatorInbox();
  await inbox.enqueue({
    goalId: issue.goalId,
    requestId: `watchdog-${issue.reason}-${issue.basis}`,
    kind: "watchdog",
    priority: coordinatorPriority("watchdog", issue.reason),
    watchdogReason: issue.reason,
    watchdogBasis: issue.basis,
    ...(detail ? { detail } : {}),
  });
}
function dispatchKind(goal: Goal): CoordinatorInboxItem["kind"] {
  switch (goal.dispatch?.kind) {
    case "follow_up": return "follow_up";
    case "scene_reply": return "scene_reply";
    case "restart": return "restart";
    case "verification":
    case "continuation":
    case "feedback":
    case "resume": return "feedback";
    default: return "goal";
  }
}
async function dispatchAutonomyCandidate(
  candidate: AutonomyCandidate,
): Promise<AutonomyDispatchResult> {
  const target = activeService();
  if (root !== target.root)
    return { status: "failed", detail: "工作区已切换，未发送自主续跑。" };
  let item = (await target.read()).goals.find(goal => goal.id === candidate.goalId);
  if (!item || ["completed", "dropped"].includes(item.status))
    return { status: "failed", detail: "自主目标已结束或不存在。" };
  if (item.autonomy?.paused)
    return { status: "failed", detail: "自主目标已暂停，未发送续跑。" };
  const kind = candidate.trigger === "verification"
    ? "verification" as const
    : "continuation" as const;
  const note = candidate.trigger === "verification"
    ? "独立复核到期。请安排未提交该交付、且不复用负责人现场的独立复核者，逐项核对完成条件、候选版本和真实证据；复核通过后调用 crewvane goal verify。不得由负责人自检代替复核。"
    : candidate.trigger === "checkpoint"
      ? "负责人已给出下一动作。请确认原负责人继续一个短回合，并在结束前写回 checkpoint、wait、boundary 或 delivery。"
      : candidate.trigger === "decision-resolved"
        ? "人的决定或边界变更已经解决。请让原负责人基于既有成果继续一个短回合。"
        : candidate.trigger === "wait-due"
          ? "外部等待或提醒已到期。请核对真实状态，再决定继续、重新等待或交回人。"
          : candidate.trigger === "dependency"
            ? "可信集成报告外部依赖已完成。请让原负责人核对结果并继续。"
            : "恢复预算内仍有新证据。请让原负责人针对新的失败证据继续一个短回合，不要重复相同尝试。";
  if (item.dispatch?.status !== "pending") {
    item = await target.execute({
      type: "goal.dispatch",
      goalId: item.id,
      status: "pending",
      kind,
      note,
    }) as Goal;
  }
  await dispatchGoal(target, item.id);
  const dispatched = (await target.read()).goals.find(goal => goal.id === candidate.goalId);
  if (!dispatched) return { status: "failed", detail: "自主目标在发送后消失。" };
  if (dispatched.dispatch?.status === "failed")
    return {
      status: "failed",
      detail: dispatched.dispatch.detail || "自主续跑未送达负责人。",
    };
  return { status: "accepted", detail: note };
}
async function ensureCoordinatorInbox() {
  if (!coordinatorInbox || !coordinatorDispatcher) throw new Error("管家收件箱尚未准备好");
  return { inbox: coordinatorInbox, dispatcher: coordinatorDispatcher };
}
async function executeCoordinatorItem(
  target: WorkspaceService,
  item: CoordinatorInboxItem,
): Promise<CoordinatorExecutionResult> {
  if (root !== target.root)
    return { status: "cancelled", detail: "工作区已切换，本次收件未发送。" };
  if (!await sessionControl.canDispatch())
    return { status: "deferred", detail: "现场交接或更新期间已保留通知，完成后继续派发。" };
  if (item.kind === "watchdog") {
    if (!item.watchdogReason || !item.watchdogBasis)
      return { status: "cancelled", detail: "巡检请求缺少原因或基准，已取消。" };
    if (!["blocked", "missing", "stale", "unassigned", "settled", "protocol_missing"].includes(
      item.watchdogReason,
    )) return { status: "cancelled", detail: "巡检请求包含未知原因，已取消。" };
    try {
      const current = (await target.read()).goals.find(goal => goal.id === item.goalId);
      if (!current) throw new Error("目标不存在或已删除。");
      if (current.watchdog?.basis !== item.watchdogBasis ||
        current.watchdog.reason !== item.watchdogReason || attentionRequest(current) ||
        ["completed", "dropped", "backlog"].includes(current.status))
        return { status: "cancelled", detail: "巡检依据已被新的现场或语义写回取代。" };
      const runtime = sessionRuntime(target.root);
      const concierge = await prepareConcierge(target);
      const site = (await runtime.inspect([concierge]))[0];
      if (site?.identity === "match" && ["working", "blocked"].includes(site.state))
        return { status: "deferred", detail: "管家正在处理上一回合，巡检通知仍保存在队列中。" };
      await writeCoordinatorScope(target.root, item.goalId, item.requestId);
      const result = await sessionRuntime(target.root).notifyGoal(
        current,
        `请核对巡检事项：${item.watchdogReason}。依据基准 ${item.watchdogBasis}。`,
        undefined,
        item.requestId,
      );
      if (result.receipt.status === "rejected") throw new Error(result.receipt.detail ?? "管家现场拒绝本次核对消息。");
      await target.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "contacted",
      });
      return { status: result.receipt.status === "unknown" ? "unconfirmed" : "sent", estimatedChars: 3_500 };
    } catch (error) {
      if (error instanceof SessionError && error.code === "backend_busy")
        return { status: "deferred", detail: error.message };
      const detail = error instanceof Error ? error.message : String(error);
      await target.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "failed",
        detail: detail.slice(0, 1000),
      }).catch(() => {});
      return {
        status: "failed",
        detail,
        pauseQueue: /blocked|等待交互输入/i.test(detail),
      };
    }
  }

  const before = (await target.read()).goals.find(goal => goal.id === item.goalId);
  if (!before || before.mode !== "concierge" ||
    ["completed", "dropped"].includes(before.status)) {
    return { status: "cancelled", detail: "目标已结束、已接管或不存在。" };
  }
  if (before.dispatch?.id !== item.requestId)
    return { status: "cancelled", detail: "已有更新请求，本次请求已合并。" };

  try {
    const runtime = sessionRuntime(target.root);
    const concierge = await prepareConcierge(target);
    const site = await runtime.inspect([concierge]);
    if (site[0]?.state === "working")
      return {
        status: "deferred",
        detail: "管家仍在处理上一案卷，本通知已保留并将在其空闲后继续。",
      };
    if (site[0]?.state === "blocked")
      return {
        status: "deferred",
        detail: "管家正在等待人处理现场输入，本通知已保留且不会插入终端。",
      };
    await writeCoordinatorScope(
      target.root,
      item.goalId,
      item.requestId,
      item.kind === "scene_reply" ? before.sceneReply : undefined,
    );
    await deliverGoalUpdate(target, item.goalId, async current => {
      const result = await runtime.notifyGoal(current, current.dispatch?.note);
      if (result.receipt.status === "rejected")
        throw new Error(result.receipt.detail ?? "管家现场拒绝本次消息。");
      return {
        status: result.receipt.status === "unknown" ? "unconfirmed" : "sent",
        ...(result.receipt.detail ? { detail: result.receipt.detail } : {}),
      };
    }, item.requestId);
    const latest = (await target.read()).goals.find(goal => goal.id === item.goalId);
    if (!latest?.dispatch || latest.dispatch.id !== item.requestId)
      return { status: "cancelled", detail: "发送期间目标状态已更新，本次请求不再覆盖新状态。" };
    const deliveryStatus = latest.dispatch.status;
    let pauseQueue = false;
    if (deliveryStatus === "unconfirmed") {
      const presence = await runtime.inspect([concierge])
        .then(site => site[0]?.state)
        .catch(() => undefined);
      pauseQueue = presence === "working";
    }
    return {
      status: deliveryStatus === "pending" ? "failed" : deliveryStatus,
      detail: latest.dispatch.detail ??
        (deliveryStatus === "sent" ? "管家已收到本次案卷通知。" : undefined),
      estimatedChars: Math.min(
        20_000,
        (latest.description.length + latest.next.length + JSON.stringify(
          latest.activities.slice(-8),
        ).length + 3_000),
      ),
      pauseQueue,
    };
  } catch (error) {
    if (error instanceof SessionError && error.code === "backend_busy")
      return { status: "deferred", detail: error.message };
    const detail = error instanceof Error ? error.message : String(error);
    const latest = (await target.read()).goals.find(goal => goal.id === item.goalId);
    if (latest?.dispatch?.id === item.requestId && latest.dispatch.status === "pending") {
      await target.execute({
        type: "goal.dispatch",
        goalId: item.goalId,
        status: "failed",
        requestId: item.requestId,
        detail: `联系管家失败：${detail.replace(/[。.!！]\s*$/, "")}。内容已保存，请重试联系管家。`,
      }).catch(() => {});
    }
    return {
      status: "failed",
      detail,
      pauseQueue: /blocked|等待交互输入/i.test(detail),
    };
  }
}
async function resetCoordinatorContextIfNeeded(target: WorkspaceService) {
  const { inbox } = await ensureCoordinatorInbox();
  const status = await inbox.status();
  if (!status.contextResetDue || status.queued || status.processing) return;
  const state = await target.read();
  if (state.concierge.status !== "ready" || !state.concierge.scene) return;
  const runtime = sessionRuntime(target.root);
  const site = (await runtime.inspect([state.concierge.scene]))[0];
  if (!site || !["idle"].includes(site.state)) return;
  await runtime.close(state.concierge.scene);
  await target.execute({
    type: "concierge.status",
    status: "not_ready",
    detail: "正在轮换管家上下文，已完成案卷仍保存在工作区。",
  });
  await prepareConcierge(target);
  await inbox.markContextReset();
  broadcastCoordinatorStatus(await inbox.status());
}
async function drainCoordinatorQueue(target: WorkspaceService) {
  if (root !== target.root) return;
  const { dispatcher } = await ensureCoordinatorInbox();
  await dispatcher.drain();
  if (root !== target.root) return;
  await resetCoordinatorContextIfNeeded(target).catch(error => {
    if (root === target.root && !window.isDestroyed()) {
      window.webContents.send("crewvane:event", {
        type: "diagnostic",
        message: `管家上下文轮换暂未完成：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
async function dispatchGoal(target: WorkspaceService, goalId: string): Promise<void> {
  if (root !== target.root) return;
  if (!await sessionControl.canDispatch()) return;
  const key = `${target.root}:${goalId}`;
  const pending = handoffs.get(key); if (pending) return pending;
  const work = (async () => {
    try {
      let current = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!current || current.mode !== "concierge" ||
        ["backlog", "completed", "dropped"].includes(current.status)) return;
      if (current?.dispatch?.kind === "restart" && !current.scene && !current.herdr) {
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
      current = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!current || current.mode !== "concierge" ||
        ["backlog", "completed", "dropped"].includes(current.status)) return;
      if (current.dispatch?.status !== "pending") {
        current = await target.execute({
          type: "goal.dispatch",
          goalId,
          status: "pending",
        }) as Goal;
      }
      if (!current.dispatch?.id) throw new Error("目标缺少可持久化的派发编号");
      const { inbox } = await ensureCoordinatorInbox();
      await inbox.enqueue({
        goalId,
        requestId: current.dispatch.id,
        kind: dispatchKind(current),
        priority: coordinatorPriority(dispatchKind(current)),
      });
      await drainCoordinatorQueue(target);
    } finally {
      if (root === target.root) broadcastSnapshot(await target.read(), target.root);
    }
  })();
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
  return sessionRuntime(target.root).launchOwner({
    goalId: goal.id,
    name: restartOwnerName(goal),
    task: restartOwnerTask(goal),
  });
}
async function prepareConcierge(target = activeService()) {
  const pending = preparations.get(target.root);
  if (pending) return pending;
  const preparing = doPrepareConcierge(target);
  preparations.set(target.root, preparing);
  try { return await preparing; } finally { preparations.delete(target.root); }
}
async function doPrepareConcierge(target: WorkspaceService) {
  await installCli(target.root);
  await installDetectedAgentHooks();
  const control = await sessionControl.status();
  if (control.selected === "herdr") {
    const status = await herdrInstallation.ensure();
    if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好，请在设置中重试");
    const plugin = await herdrPlugin.ensure(status.executable);
    broadcastHerdrStatus(status);
    if (plugin.phase === "error") throw new Error(plugin.detail);
  }
  const state = await target.read();
  if (!state.concierge.scene ||
    state.concierge.initializedAttemptId !== state.concierge.scene.attemptId)
    await target.execute({
      type: "scene.concierge.status",
      status: "not_ready",
      detail: "正在准备全局管家…",
    });
  try {
    const scene = await sessionRuntime(target.root).prepareConcierge();
    // The runtime owns initialization/readiness. Reusing a verified concierge
    // must not clear its presence or generate another identity handshake.
    return scene;
  } catch (error) {
    // Never pass an untrusted transport's arbitrarily long stderr to a Core
    // status field. Keep a useful, bounded first line and leave the original
    // delivery receipt available for recovery.
    const reported = (error instanceof Error ? error.message : String(error))
      .split(/\r?\n/).find(line => line.trim())?.trim() ?? "";
    const detail = reported.slice(0, 800) ||
      "管家初始化尚未确认；请打开原现场核对，Crewvane 不会重复创建或重发。";
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
async function openExternalScene(
  reference?: HerdrReference,
  goalId?: string,
): Promise<ExternalSceneLease> {
  const target = activeService(),
    session = sessionName(target.root),
    status = await herdrInstallation.ensure();
  if (!status.executable)
    throw new Error(status.detail || "Herdr 尚未准备好，请在设置中重试");
  const connection = externalClient(status.executable, target.root);
  await connection.ensureSession();
  if (reference?.tabId || reference?.agent) await connection.open(reference);
  else await connection.ensureWorkspace();
  if (goalId && reference?.agent && reference.agent !== "concierge")
    await target.execute({ type: "scene.visit", goalId });
  return externalTerminals.open({
    workspaceRoot: target.root,
    session,
    herdrExecutable: status.executable,
  });
}
async function openEmbeddedScene(target: WorkspaceService, goalId?: string) {
  const candidate = goalId ? (await target.read()).goals.find(goal => goal.id === goalId) : undefined;
  if (candidate?.mode === "manual" && !candidate.scene && !candidate.autonomy?.verificationSite?.scene) {
    // A recorded personal item opens the real workspace, not a model session.
    // A failed concierge initialization must not disable terminal viewing.
    if ((await sessionControl.status()).selected === "orca")
      throw new Error("这件个人事项没有 Orca 受管现场，请先交给管家；不会静默启动另一位管家。");
    const executable = await herdrInstallationStatusBinary();
    await (await backendAdapter("herdr", target.root)).connect({
      installationId: (await sessionControl.status()).installationId,
      cwd: target.root, startIfMissing: true,
    });
    await client(executable, target.root).ensureWorkspace();
    await terminals.attach(executable, sessionName(target.root), target.root);
    if (root === target.root) window.webContents.send("crewvane:event", {
      type: "terminal-open", session: sessionName(target.root), title: "工作现场", goalId,
    });
    return;
  }
  const scene = await sceneForGoal(target, goalId);
  if (scene.backend !== "herdr") throw new Error("Orca 模式使用原生工作现场，不提供内嵌终端。");
  await sessionRuntime(target.root).focus(scene);
  if (goalId) await target.execute({ type: "scene.visit", goalId });
  await terminals.attach(await herdrInstallationStatusBinary(), sessionName(target.root), target.root);
  if (root === target.root) window.webContents.send("crewvane:event", {
    type: "terminal-open", session: sessionName(target.root),
    title: goalId ? "工作现场" : "全局管家", goalId,
  });
}
async function openExternalSceneForGoal(target: WorkspaceService, goalId?: string) {
  const candidate = goalId ? (await target.read()).goals.find(goal => goal.id === goalId) : undefined;
  if (candidate?.mode === "manual" && !candidate.scene && !candidate.autonomy?.verificationSite?.scene) {
    if ((await sessionControl.status()).selected === "orca")
      throw new Error("这件个人事项没有 Orca 受管现场，请先交给管家；不会静默启动另一位管家。");
    const executable = await herdrInstallationStatusBinary();
    await (await backendAdapter("herdr", target.root)).connect({
      installationId: (await sessionControl.status()).installationId,
      cwd: target.root, startIfMissing: true,
    });
    await client(executable, target.root).ensureWorkspace();
    return externalTerminals.open({ workspaceRoot: target.root,
      session: sessionName(target.root), herdrExecutable: executable });
  }
  const scene = await sceneForGoal(target, goalId);
  if (scene.backend !== "herdr") throw new Error("Orca 模式使用原生工作现场。");
  await sessionRuntime(target.root).focus(scene);
  if (goalId) await target.execute({ type: "scene.visit", goalId });
  return externalTerminals.open({
    workspaceRoot: target.root,
    session: sessionName(target.root),
    herdrExecutable: await herdrInstallationStatusBinary(),
  });
}
async function openPreferredScene(
  target: WorkspaceService,
  goalId?: string,
  recover = false,
): Promise<SceneOpenResult> {
  if (recover) {
    if (!goalId) throw new Error("恢复现场需要目标 ID。");
    await sessionRuntime(target.root).recoverOwnerForConsultation(goalId);
  }
  const scene = await sceneForGoal(target, goalId);
  if (scene.backend === "orca") {
    await sessionRuntime(target.root).focus(scene);
    if (goalId) await target.execute({ type: "scene.visit", goalId });
    if (root === target.root) broadcastSnapshot(await target.read(), target.root);
    return { mode: "native", app: "Orca" };
  }
  const status = await externalTerminals.status();
  if (status.settings.openWith === "external") {
    return {
      mode: "external",
      lease: await openExternalSceneForGoal(target, goalId),
    };
  }
  await openEmbeddedScene(target, goalId);
  return { mode: "embedded" };
}
async function herdrInstallationStatusBinary() {
  const executable = (await herdrInstallation.status()).executable ?? process.env.CREWVANE_HERDR_BINARY;
  if (!executable) throw new Error("Herdr 当前不可用。");
  return executable;
}
async function sceneForGoal(target: WorkspaceService, goalId?: string) {
  const state = await target.read();
  if (!goalId) {
    return prepareConcierge(target);
  }
  const item = state.goals.find(goal => goal.id === goalId);
  if (!item) throw new Error("目标不存在");
  if (item.scene) {
    const observed = (await sessionRuntime(target.root).inspect([item.scene]))[0];
    if (observed?.identity === "match" && observed.state === "exited")
      throw new Error("原现场已结束，请在目标详情点击“恢复并进入现场”。未自动创建新负责人。");
    return item.scene;
  }
  if (item.autonomy?.verificationSite?.scene) return item.autonomy.verificationSite.scene;
  if (item.backendHandoff && item.mode === "concierge" &&
    !["completed", "dropped", "backlog"].includes(item.status)) {
    throw new Error("目标等待显式恢复，请在目标详情点击“恢复并进入现场”。");
  }
  return prepareConcierge(target);
}
async function backendControlStatus() {
  const control = await sessionControl.status();
  const [journal, workspaces, orca] = await Promise.all([
    sessionControl.journal(),
    sessionControl.registrations(),
    orcaInstallation.status(),
  ]);
  const states = await Promise.all(workspaces.map(workspace =>
    new WorkspaceService(workspace.root).read().catch(() => undefined)));
  const impact = states.reduce((result, state) => {
    if (!state) return result;
    result.goals += state.goals.filter(goal =>
      goal.mode === "concierge" && !["completed", "dropped", "backlog"].includes(goal.status)).length;
    result.scenes += (state.concierge.scene ? 1 : 0) +
      state.goals.filter(goal => goal.scene).length +
      state.goals.filter(goal => goal.autonomy?.verificationSite?.scene).length;
    return result;
  }, { goals: 0, scenes: 0 });
  return { control, journal, workspaces, orca, impact };
}
function backendSwitchHooks() {
  return {
    adapter: backendAdapter,
    busy: async (workspace: string) => {
      if (workspace !== root || !coordinatorInbox) return false;
      const status = await coordinatorInbox.status();
      return Boolean(status.processing) || status.queued > 0;
    },
    resume: async (input: {
      workspace: string;
      state: WorkspaceState;
      authority: SwitchAuthority;
      operationId: string;
    }) => {
      const target = new WorkspaceService(input.workspace);
      const channel: SessionRecoveryChannel = new SessionRecoveryChannel(sessionControl.directory, async (request): Promise<unknown> => {
        const state = await target.read(), context = request.context, binding = state.backendBinding;
        const scope = JSON.parse(await readFile(join(input.workspace, ".crewvane/coordinator-scope.json"), "utf8"));
        if (!binding || binding.status !== "resuming" || binding.operationId !== input.operationId ||
          context.role !== "concierge" || context.installationId !== binding.installationId ||
          context.backend !== binding.backend || context.epoch !== binding.epoch ||
          context.scopeGeneration !== binding.scopeGeneration || context.goalId !== scope.goalId ||
          context.attemptId !== state.concierge.scene?.attemptId)
          throw new Error("恢复操作不属于当前管家、代次或案卷。");
        const managed: SessionRuntime = new SessionRuntime({ ...runtime.options, managedContext: context });
        if (request.operation === "launch") {
          const value = request.input;
          if (value.goalId !== scope.goalId || typeof value.name !== "string" ||
            value.role && value.role !== "owner" && value.role !== "verifier" ||
            value.task !== undefined && typeof value.task !== "string" ||
            value.taskFile !== undefined && typeof value.taskFile !== "string")
            throw new Error("恢复启动参数无效。");
          return managed.launchOwner({
            goalId: scope.goalId, name: value.name,
            role: value.role as "owner" | "verifier" | undefined,
            task: value.task as string | undefined, taskFile: value.taskFile as string | undefined,
          }, input.authority);
        }
        if (typeof request.input.deliveryId !== "string" || typeof request.input.text !== "string" ||
          request.input.text.length > 100_000) throw new Error("恢复投递参数无效。");
        return managed.send(validatedScene(request.input.scene), request.input.deliveryId,
          request.input.text, input.authority);
      });
      const runtime: SessionRuntime = new SessionRuntime({
        ...sessionRuntime(input.workspace).options,
        environment: { ...process.env, ...channel.environment },
      });
      const quiet = async (scene: import("../../../packages/core/src/index.js").SceneReferenceV1) => {
        const deadline = Date.now() + CONCIERGE_TURN_TIMEOUT_MS;
        do {
          const site = (await runtime.inspect([scene]))[0];
          if (site?.identity === "match" && site.state === "idle") return true;
          if (site?.state === "blocked" || site?.state === "exited") return false;
          await new Promise(resolve => setTimeout(resolve, 500));
        } while (Date.now() < deadline);
        return false;
      };
      const hasBusinessProof = async (
        goalId: string,
        scene: import("../../../packages/core/src/index.js").SceneReferenceV1,
        before: ReturnType<typeof captureBackendHandoffEvidence>,
        timeout: number,
        expectedStarted: boolean,
      ) => {
        const startedAt = Date.now(), deadline = startedAt + timeout;
        let sawWorking = expectedStarted, idleSince: number | undefined;
        do {
          const current = (await target.read()).goals.find(goal => goal.id === goalId);
          if (current && backendHandoffAdvanced(before, current)) return true;
          const site = (await runtime.inspect([scene]))[0];
          if (site?.state === "blocked" || site?.state === "exited") return false;
          if (site?.state === "working") {
            sawWorking = true;
            idleSince = undefined;
          } else if (site?.state === "idle") {
            idleSince ??= Date.now();
            if (sawWorking && Date.now() - idleSince >= BACKEND_HANDOFF_IDLE_SETTLE_MS)
              return false;
            if (!sawWorking && Date.now() - startedAt >= BACKEND_HANDOFF_STALL_PROBE_MS)
              return false;
          } else {
            idleSince = undefined;
          }
          await new Promise(resolve => setTimeout(resolve, 1_000));
        } while (Date.now() < deadline);
        const current = (await target.read()).goals.find(goal => goal.id === goalId);
        return Boolean(current && backendHandoffAdvanced(before, current));
      };
      await channel.start();
      try {
        const concierge = await runtime.prepareConcierge(input.authority);
        if (!await quiet(concierge)) throw new Error("新管家尚未空闲，已保留交接记录，请核对原现场后恢复。");
        let deferRemaining = false;
        for (const id of input.state.goals.map(goal => goal.id)) {
          // Preparation is not a frozen business snapshot.
          const goal = (await target.read()).goals.find(goal => goal.id === id);
          const handoff = goal?.backendHandoff;
          if (!goal || !handoff || handoff.operationId !== input.operationId ||
            !["case-rehydrate", "native-resume"].includes(handoff.method)) continue;
          if (["accepted", "skipped"].includes(handoff.status)) continue;
          if (goal.scene) {
            const observation = (await runtime.inspect([goal.scene]))[0];
            if (observation?.identity !== "match" || !observation.reachable)
              throw new Error("恢复现场的身份或存活尚未核实；已保留原交接，不会重复派发。");
            await target.execute({
              type: "backend.handoff",
              goalId: id,
              operationId: input.operationId,
              patch: {
                status: "accepted",
                detail: "恢复后发现负责人现场已绑定，未重复派发。",
              },
            });
            continue;
          }
          if (["pending", "unconfirmed", "failed", "stopped"].includes(handoff.status) &&
            backendHandoffHasPersistedProof(handoff, goal)) {
            await target.execute({
              type: "backend.handoff",
              goalId: id,
              operationId: input.operationId,
              patch: {
                status: "accepted",
                receiptId: handoff.receiptId,
                detail: "重试时发现了超时之后才落盘的结构化协调证据；没有重放旧任务。",
              },
            });
            if (goal.dispatch?.kind === "resume" && handoff.receiptId)
              await target.execute({
                type: "goal.dispatch",
                goalId: id,
                status: "sent",
                requestId: handoff.receiptId,
              });
            continue;
          }
          if (["pending", "unconfirmed", "failed", "stopped"].includes(handoff.status))
            throw new Error(
              "已有后端交接的结果尚未确认；请先核对原现场，不能自动重放旧案卷。",
            );
          if (goal.status !== "active" || goal.mode !== "concierge" || goal.autonomy?.paused) {
            await target.execute({ type: "backend.handoff", goalId: id, operationId: input.operationId,
              patch: { method: "deferred", status: "skipped" } });
            continue;
          }
          if (attentionRequest(goal)) {
            // A decision belongs to its owner, not to a fresh implementation
            // task. Restore a read-only consultation scene and preserve the
            // exact attention ID. scene-reply will enqueue the concierge only
            // after a real user answer has been saved.
            const restored = await runtime.launchOwner({
              goalId: id,
              name: `owner-${id.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()}`,
              consultationOnly: true,
            }, input.authority);
            await target.execute({ type: "backend.handoff", goalId: id, operationId: input.operationId,
              patch: { status: restored.receipt?.status === "unknown" ? "unconfirmed" : "accepted",
                receiptId: restored.receipt?.deliveryId, detail: restored.receipt?.detail } });
            continue;
          }
          const note = "后端已交接。先核对最新案卷与磁盘已有成果，再创建独立负责人继续明确下一步；不得重复旧任务或外部动作。";
          if (deferRemaining) {
            if (goal.dispatch?.status !== "pending")
              await target.execute({ type: "goal.dispatch", goalId: id, status: "pending", kind: "resume", note });
            continue;
          }
          const queued = await prepareBackendHandoffCase({
            workspace: input.workspace, goalId: id, operationId: input.operationId,
            note, waitForIdle: () => quiet(concierge),
          });
          if (!queued) continue;
          const deliveryId = queued.dispatch?.id;
          if (!deliveryId) throw new Error("恢复交接缺少持久化派发编号。");
          const beforeProof = captureBackendHandoffEvidence(queued);
          let result;
          try {
            result = await runtime.notifyGoal(queued, note, input.authority, deliveryId);
          } catch (error) {
            if (!(error instanceof SessionError && error.code === "backend_busy") ||
              !await quiet(concierge)) throw error;
            result = await runtime.notifyGoal(queued, note, input.authority, deliveryId);
          }
          if (result.receipt.status === "rejected") throw new Error(result.receipt.detail ?? "管家未接受恢复案卷。");
          const proven = await hasBusinessProof(
            id,
            concierge,
            beforeProof,
            result.receipt.status === "started"
              ? BACKEND_HANDOFF_PROOF_TIMEOUT_MS
              : BACKEND_HANDOFF_STALL_PROBE_MS,
            result.receipt.status === "started",
          );
          if (!proven) {
            await target.execute({
              type: "backend.handoff",
              goalId: id,
              operationId: input.operationId,
              patch: {
                status: "unconfirmed",
                receiptId: result.receipt.deliveryId,
                detail: "终端已接受交接，但限定时间内没有结构化协调证据；目标已保留为待派发，不会重放旧业务任务。",
              },
            });
            deferRemaining = true;
            continue;
          }
          await target.execute({
            type: "backend.handoff",
            goalId: id,
            operationId: input.operationId,
            patch: {
              status: "accepted",
              receiptId: result.receipt.deliveryId,
              detail: result.receipt.detail ?? "已观察到新的结构化协调记录。",
            },
          });
          await target.execute({
            type: "goal.dispatch",
            goalId: id,
            status: "sent",
            requestId: deliveryId,
          });
        }
      } finally { await channel.stop(); }
    },
    onProgress: (journal: unknown) => {
      if (window && !window.isDestroyed())
        window.webContents.send("crewvane:event", { type: "backend-switch", journal });
    },
  };
}
async function finishBackendTransition(
  journal: Awaited<ReturnType<SessionControl["switchTo"]>>,
) {
  if (journal?.phase === "ready") {
    sessionRuntimes.clear();
    sessionPoller.reset();
  }
  if (root && journal?.phase === "ready") {
    await herdrHostBridge?.stop().catch(() => {});
    const control = await sessionControl.status();
    if (control.selected === "herdr") {
      herdrHostBridge = new HerdrHostBridge(
        root,
        sessionName(root),
        async () => {
          const status = await herdrInstallation.ensure();
          if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好");
          return status.executable;
        },
      );
      await herdrHostBridge.start();
    } else herdrHostBridge = undefined;
  }
  const status = await publishBackendControlStatus();
  return { journal, status };
}
async function publishBackendControlStatus() {
  const status = await backendControlStatus();
  if (window && !window.isDestroyed())
    window.webContents.send("crewvane:event", { type: "backend-control", status });
  return status;
}
async function switchSessionBackend(backend: "herdr" | "orca") {
  const current = await sessionControl.status();
  if (current.phase !== "ready") {
    throw new Error("当前现场交接尚未完成，请先重试或恢复。");
  }
  if (backend === "orca") {
    const detection = await orcaInstallation.refresh();
    if (detection.detection.status !== "compatible")
      throw new Error(detection.detection.detail ?? "Orca 尚未通过安装与兼容检测。");
  }
  if (current.selected === "herdr") {
    for (const workspace of await sessionControl.registrations()) {
      const migration = await adoptVerifiedLegacyScenes(workspace.root);
      if (migration.blocked)
        throw new Error("有旧 Herdr 现场仍无法核实进程身份。请先打开对应现场，确认后再次切换。");
    }
  }
  const hooks = backendSwitchHooks();
  backendSwitchAbort = new AbortController();
  try {
    const journal = await sessionControl.switchTo(backend, hooks, backendSwitchAbort.signal);
    return await finishBackendTransition(journal);
  } finally { backendSwitchAbort = undefined; }
}
async function retrySessionBackendSwitch() {
  const journal = await sessionControl.retrySwitch(backendSwitchHooks());
  return finishBackendTransition(journal);
}
async function orcaInstallAction(action: unknown) {
  if (action === "check") return orcaInstallation.check();
  if (action === "install") {
    const maintenanceId = await sessionControl.beginMaintenance("orca");
    await publishBackendControlStatus();
    try {
      const result = await orcaInstallation.install();
      if (maintenanceId && result.phase !== "awaiting_installation")
        await sessionControl.endMaintenance(maintenanceId);
      return result;
    } catch (error) {
      if (maintenanceId) await sessionControl.endMaintenance(maintenanceId);
      throw error;
    } finally { await publishBackendControlStatus(); }
  }
  if (action === "cancel") {
    orcaInstallation.cancel();
    const status = await orcaInstallation.status();
    if (!["downloading", "verifying"].includes(status.phase)) {
      const control = await sessionControl.status();
      if (control.maintenance) await sessionControl.endMaintenance(control.maintenance.id);
    }
    await publishBackendControlStatus();
    return status;
  }
  if (action === "refresh") {
    const status = await orcaInstallation.refresh();
    const control = await sessionControl.status();
    if (status.detection.status === "compatible" && control.maintenance)
      await sessionControl.endMaintenance(control.maintenance.id);
    await publishBackendControlStatus();
    return status;
  }
  throw new Error("无效的 Orca 安装操作。");
}
async function requestNeutralSceneReply(workspace: string, goal: Goal) {
  if (!goal.scene || !goal.sceneVisit) return false;
  const runtime = sessionRuntime(workspace);
  const observation = (await runtime.inspect([goal.scene]))[0];
  if (!observation || observation.identity !== "match" || !observation.reachable ||
    observation.state !== "idle") return false;
  const question = attentionRequest(goal)?.summary ?? "当前待处理事项";
  const receipt = await runtime.send(
    goal.scene,
    `scene-reconcile-${goal.sceneVisit.id}`,
    [
      `用户已查看当前现场。如果「${question}」已在现场由用户明确答复，`,
      `立即把这个明确事实与用户原话通过 crewvane goal scene-reply ${goal.id} 写回；`,
      "不要只回复“已回答”。如果尚未处理，继续当前工作或保持原状态；后续仍需按 Crewvane 语义命令写回。",
    ].join(""),
  );
  return receipt.status !== "rejected";
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
        await agentRuntimeBroker?.refresh();
        void autonomyScheduler?.tick();
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
  const backendControl = await sessionControl.registerWorkspace(canonical);
  await ensureSessionCommandHost(canonical);
  await herdrHostBridge?.stop().catch(() => {});
  if (backendControl.selected === "herdr") {
    herdrHostBridge = new HerdrHostBridge(
      canonical,
      sessionName(canonical),
      async () => {
        const status = await herdrInstallation.ensure();
        if (!status.executable) throw new Error(status.detail ?? "Herdr 尚未准备好");
        return status.executable;
      },
    );
    await herdrHostBridge.start();
  } else herdrHostBridge = undefined;
  await agentRuntimeBroker?.stop().catch(() => {});
  deliverGoalStatusChanges(opened, initialState, canonical);
  const inbox = await CoordinatorInbox.open(canonical);
  coordinatorInbox = inbox;
  coordinatorDispatcher = new CoordinatorDispatcher(inbox, {
    execute: item => executeCoordinatorItem(opened, item),
    onStatus: status => {
      if (root === canonical) broadcastCoordinatorStatus(status);
    },
  });
  root = canonical; service = opened;
  lastSnapshotSignature = undefined;
  const recovered = await inbox.recoverInterrupted();
  for (const { item, detail } of recovered) {
    if (item.kind === "watchdog" && item.watchdogBasis) {
      await opened.execute({
        type: "watchdog.report",
        goalId: item.goalId,
        at: new Date().toISOString(),
        basis: item.watchdogBasis,
        outcome: "failed",
        detail,
      }).catch(() => {});
      continue;
    }
    const goal = (await opened.read()).goals.find(candidate => candidate.id === item.goalId);
    if (goal?.dispatch?.id === item.requestId) {
      await opened.execute({
        type: "goal.dispatch",
        goalId: item.goalId,
        status: "unconfirmed",
        requestId: item.requestId,
        detail,
      }).catch(() => {});
    }
  }
  broadcastCoordinatorStatus(await inbox.status());
  watchWorkspaceState(opened);
  await agentRuntimeBroker.start().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `Agent Hook 本地网关暂未启动：${error instanceof Error ? error.message : String(error)}`,
    });
  });
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
  void coordinatorDispatcher?.drain().catch(error => {
    if (!window.isDestroyed()) window.webContents.send("crewvane:event", {
      type: "diagnostic",
      message: `管家收件箱恢复暂未完成：${error instanceof Error ? error.message : String(error)}`,
    });
  });
  void autonomyScheduler?.tick();
}
async function synchronize() {
  if (syncing || !service || !root) return;
  syncing = true;
  const target = service, workspace = root;
  try {
    let state = await target.read();
    if (await sessionControl.canDispatch()) await autonomyScheduler?.tick();
    state = await target.read();
    deliverGoalStatusChanges(target, state, workspace);
    await deliverAttentionNotifications(target, state, workspace);
    if (!await sessionControl.canDispatch()) {
      broadcastSnapshot(state, workspace);
      return;
    }
    for (const goal of state.goals.filter(goal =>
      ["completed", "dropped"].includes(goal.status) && (goal.scene || goal.herdr)))
      await closeEndedGoalSession(target, goal.id).catch(() => {});
    state = await target.read();
    for (const goal of state.goals.filter(goal => goal.mode === "concierge" && goal.dispatch?.status === "pending" &&
      !["completed", "dropped"].includes(goal.status))) {
      void dispatchGoal(target, goal.id).catch(() => {});
    }
    const tracked = state.goals.filter(goal => !["completed", "dropped"].includes(goal.status) &&
      (goal.scene || goal.autonomy?.verificationSite?.scene));
    const backendScenes = [
      ...(state.concierge.scene ? [state.concierge.scene] : []),
      ...tracked.flatMap(goal => [
        ...(goal.scene ? [goal.scene] : []),
        ...(goal.autonomy?.verificationSite?.scene ? [goal.autonomy.verificationSite.scene] : []),
      ]),
    ];
    if (backendScenes.length) {
      try {
        const observations = await sessionPoller.inspect(backendScenes,
          scenes => sessionRuntime(workspace).inspect(scenes));
        if (observations) await target.execute({
          type: "scene.observe",
          scenes: observations.map(observation => ({
            bindingId: observation.bindingId,
            presence: {
              state: observation.state === "unknown" ? "unknown" :
                observation.state === "exited" ? "unknown" : observation.state,
              reachable: observation.reachable,
              checkedAt: observation.observedAt,
            },
          })),
        });
      } catch (error) {
        const current = await target.read();
        if (current.concierge.status === "ready" && current.concierge.scene) {
          await target.execute({
            type: "concierge.status",
            status: "not_ready",
            live: {
              state: "unknown",
              checkedAt: new Date().toISOString(),
              reachable: false,
            },
            detail: `无法与 ${current.backendBinding?.backend === "orca" ? "Orca" : "Herdr"} 同步：${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
    }
    // This runs outside the coordinator queue: it talks only to the owner.
    for (const item of (await target.read()).goals.filter(goal => goal.sceneVisit?.status === "pending"))
      void reconcileSceneReply(target, item.id, {
        requestSceneReply: async goal => requestNeutralSceneReply(workspace, goal),
      }).catch(() => {});
    const requests = (await target.execute({ type: "watchdog.inspect", at: new Date().toISOString() }) as WatchdogRequest[]).slice(0, 10);
    state = await target.read();
    // An agent may write a decision or delivery while the concierge prompt is
    // in flight. That structured fact supersedes a quiet-terminal probe.
    const activeRequests = requests.filter(request => {
      const goal = state.goals.find(item => item.id === request.goalId);
      return goal?.watchdog?.basis === request.basis && !goal.attention;
    });
    if (activeRequests.length && root === workspace) {
      for (const request of activeRequests)
        await enqueueWatchdog(target, request);
    }
    if (root === workspace) await drainCoordinatorQueue(target);
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
  agentHookManager = new AgentHookManager({
    home: app.getPath("home"),
    userData: app.getPath("userData"),
    commandPath: command => tools.find(command),
  });
  agentRuntimeBroker = new AgentRuntimeBroker({
    service: () => service,
    workspace: () => root,
    hooks: agentHookManager,
    remindOwner: remindRuntimeOwner,
    notifyConcierge: notifyRuntimeConcierge,
    onChanged: () => {
      const target = service, workspace = root;
      if (target && workspace) void target.read().then(state => {
        if (root !== workspace) return;
        deliverGoalStatusChanges(target, state, workspace);
        broadcastSnapshot(state, workspace);
      }).catch(() => {});
      void agentRuntimeStatus().then(broadcastAgentRuntimeStatus);
    },
  });
  autonomyScheduler = new AutonomyScheduler({
    service: () => service,
    dispatch: dispatchAutonomyCandidate,
    onError: error => {
      if (window && !window.isDestroyed()) window.webContents.send("crewvane:event", {
        type: "diagnostic",
        message: `自主续跑调度暂未完成：${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });
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
  sessionControl = new SessionControl(join(app.getPath("userData"), "session-control"));
  const backendControl = await sessionControl.initialize({ recoverInterrupted: true });
  orcaInstallation = new OrcaInstallation(
    join(app.getPath("userData"), "runtime", "orca-installer"),
    status => {
      if (window && !window.isDestroyed())
        window.webContents.send("crewvane:event", { type: "orca-installation", status });
    },
  );
  if (backendControl.orcaAppPath)
    await orcaInstallation.refresh(backendControl.orcaAppPath);
  if (process.env.CREWVANE_TEST_ISOLATE_TOOLS === "1") herdrInstallation.disableBundledForTest();
  const integrationEnvironment = process.env.CREWVANE_TEST_HOME ? {
    ...process.env,
    HOME: app.getPath("home"),
    XDG_CONFIG_HOME: join(app.getPath("home"), ".config"),
    XDG_STATE_HOME: join(app.getPath("home"), ".local/state"),
  } : process.env;
  externalTerminals = new ExternalTerminalManager({
    userDataRoot: app.getPath("userData"),
    env: integrationEnvironment,
  });
  herdrPlugin = new HerdrPlugin(
    app.isPackaged ? join(process.resourcesPath, "herdr-plugin") : join(app.getAppPath(), "herdr-plugin"),
    join(app.getPath("userData"), "herdr-plugin"),
    app.getVersion(),
    integrationEnvironment,
  );
  skillInstaller = new CrewvaneSkillInstaller(
    app.isPackaged
      ? join(process.resourcesPath, "crewvane-skills")
      : join(here, "../../skills"),
    app.getPath("home"),
    app.getVersion(),
    ["crewvane", "crewvane-local-pack-author"],
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
      if (item && ["completed", "dropped"].includes(item.status) && (item.scene || item.herdr))
        await closeEndedGoalSession(target, item.id);
    }
    const result = await target.execute(command);
    void agentRuntimeBroker?.refresh(
      "goalId" in command && typeof command.goalId === "string"
        ? command.goalId
        : undefined,
    ).catch(() => {});
    if (command.type === "scene.visit" && command.retry) {
      void reconcileSceneReply(target, command.goalId, {
        requestSceneReply: goal => requestNeutralSceneReply(target.root, goal),
      }, { graceMs: 0 }).catch(() => {});
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
      const item = result as Goal;
      const shouldDispatch = command.type === "goal.update"
        ? item.status === "active"
        : !["completed", "dropped"].includes(item.status);
      if (shouldDispatch && item.mode === "concierge") {
        const current = (await target.read()).goals.find(goal => goal.id === item.id);
        if (current?.dispatch?.status !== "pending") {
          await target.execute({
            type: "goal.dispatch",
            goalId: item.id,
            status: "pending",
            kind: "feedback",
          });
        }
        void dispatchGoal(target, item.id).catch(error => {
          if (root === target.root) window.webContents.send("crewvane:event", {
            type: "diagnostic",
            message: error instanceof Error ? error.message : String(error),
          });
        });
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
  ipcMain.handle("crewvane:check-herdr-update", (event) => {
    sender(event);
    return checkHerdrUpdate();
  });
  ipcMain.handle("crewvane:orca-status", event => {
    sender(event);
    return orcaInstallation.status();
  });
  ipcMain.handle("crewvane:backend-status", event => {
    sender(event);
    return backendControlStatus();
  });
  ipcMain.handle("crewvane:backend-switch", (event, backend: unknown) => {
    sender(event);
    if (backend !== "herdr" && backend !== "orca") throw new Error("无效的会话后端。");
    return switchSessionBackend(backend);
  });
  ipcMain.handle("crewvane:backend-retry", event => {
    sender(event);
    return retrySessionBackendSwitch();
  });
  ipcMain.handle("crewvane:backend-cancel", event => {
    sender(event);
    backendSwitchAbort?.abort();
  });
  ipcMain.handle("crewvane:backend-restore", async event => {
    sender(event);
    return finishBackendTransition(await sessionControl.restoreOriginal(backendSwitchHooks()));
  });
  ipcMain.handle("crewvane:orca-action", (event, action: unknown) => {
    sender(event);
    return orcaInstallAction(action);
  });
  ipcMain.handle("crewvane:orca-select-application", async event => {
    sender(event);
    const picked = await dialog.showOpenDialog(window, {
      title: "选择已有 Orca 应用",
      defaultPath: "/Applications",
      properties: ["openFile"], filters: [{ name: "macOS Application", extensions: ["app"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return null;
    const path = await realpath(picked.filePaths[0]);
    const detected = await detectOrcaApplication(path);
    if (detected.status === "incompatible" || detected.status === "missing")
      throw new Error(detected.detail ?? "所选应用不是可验证的官方 Orca。");
    await sessionControl.setOrcaPath(path);
    return orcaInstallation.refresh(path);
  });
  ipcMain.handle("crewvane:cli-status", (event) => { sender(event); return cliStatus(); });
  ipcMain.handle("crewvane:install-cli", (event) => { sender(event); return installCli(); });
  ipcMain.handle("crewvane:skills-status", (event) => { sender(event); return skillsStatus(); });
  ipcMain.handle("crewvane:install-skills", (event) => { sender(event); return installSkills(); });
  ipcMain.handle("crewvane:method-packs-status", (event) => {
    sender(event);
    return methodPacksStatus();
  });
  ipcMain.handle("crewvane:method-pack-preview", (event) => {
    sender(event);
    return previewMethodPack();
  });
  ipcMain.handle("crewvane:method-pack-install", (event, path: unknown, scripts: unknown) => {
    sender(event);
    return installMethodPack(
      path as string,
      scripts as string[],
    );
  });
  ipcMain.handle("crewvane:method-pack-action", (
    event,
    packId: unknown,
    action: unknown,
    scriptIds: unknown,
  ) => {
    sender(event);
    return mutateMethodPack(
      packId as string,
      action as "approve" | "disable" | "enable" | "remove",
      (scriptIds as string[] | undefined) ?? [],
    );
  });
  ipcMain.handle("crewvane:agent-runtime-status", (event) => {
    sender(event);
    return agentRuntimeStatus();
  });
  ipcMain.handle("crewvane:agent-runtime-action", async (event, id: unknown, action: unknown) => {
    sender(event);
    if (typeof id !== "string" || typeof action !== "string")
      throw new Error("Agent 接入参数无效");
    return configureAgentRuntime(id, action);
  });
  ipcMain.handle("crewvane:clipboard-read", (event) => { sender(event); return clipboard.readText(); });
  ipcMain.handle("crewvane:clipboard-write", async (event, value: unknown) => {
    sender(event);
    if (typeof value !== "string" || value.length > 2_000_000) throw new Error("剪贴板文本无效");
    await clipboard.writeText(value);
  });
  ipcMain.handle("crewvane:clipboard-content", async (event) => {
    sender(event);
    const items = await clipboard.read();
    if (items.some(item => item.types.some(type => type.startsWith("image/"))))
      return { kind: "image" as const };
    const text = await clipboard.readText();
    return text ? { kind: "text" as const, text } : { kind: "empty" as const };
  });
  ipcMain.handle("crewvane:scene-settings", (event) => {
    sender(event);
    return externalTerminals.status();
  });
  ipcMain.handle("crewvane:scene-settings-save", (event, input: SceneSettings) => {
    sender(event);
    activeService();
    return externalTerminals.save(input);
  });
  ipcMain.handle("crewvane:scene-settings-test", async (event) => {
    sender(event);
    activeService();
    return openExternalScene();
  });
  ipcMain.handle("crewvane:prepare-concierge", (event) => {
    sender(event);
    sessionPoller.reset();
    return prepareConcierge();
  });
  ipcMain.handle("crewvane:coordinator-status", async event => {
    sender(event);
    return (await ensureCoordinatorInbox()).inbox.status();
  });
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
    await openEmbeddedScene(activeService(), goalId);
  });
  ipcMain.handle("crewvane:open-scene", async (event, goalId?: string, recover?: boolean) => {
    sender(event);
    if (recover !== undefined && typeof recover !== "boolean") throw new Error("无效的恢复参数。");
    return openPreferredScene(activeService(), goalId, recover);
  });
  ipcMain.handle("crewvane:open-scene-external", async (event, goalId?: string) => {
    sender(event);
    return openExternalSceneForGoal(activeService(), goalId);
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
  void agentRuntimeBroker?.stop().catch(() => {});
  for (const host of sessionHosts.values()) void host.then(value => value.stop()).catch(() => {});
  void herdrHostBridge?.stop().catch(() => {});
  terminals.dispose();
});
