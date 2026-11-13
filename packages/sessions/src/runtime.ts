import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkspaceService, agentRuntimeCapabilities, agentRuntimeSocketPath,
  parseAgentCommand, SkillRegistry, ownerSceneReplyInstructions, resumeAgentArgs,
  type AgentRuntimeAdapterId, type Goal, type ManagedSessionContext, type OwnerResume,
  type SceneLaunchIntent,
  type SceneReferenceV1, type SessionBackendId,
} from "../../core/src/index.js";
import { SessionControl } from "./control/control.js";
import type { BackendControlV1, SwitchAuthority } from "./control/types.js";
import { SessionError, type SendReceipt, type SessionAdapter } from "./contracts.js";
import { createLaunchFiles, type LaunchFiles } from "./launcher.js";
import { atomicJSON, childPath, readJSON } from "./io.js";
import { caseTask, conciergeIdentityPrompt, goalNotificationPrompt } from "./prompts.js";
import { requestSessionRecovery } from "./recovery-channel.js";
import { requestWorkspaceSessionHost } from "./session-host.js";

function adapterId(executable: string): AgentRuntimeAdapterId {
  const name = executable.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^codex(?:$|-)/.test(name)) return "codex";
  if (/^claude(?:$|-)/.test(name)) return "claude-code";
  if (/^cursor(?:$|-)/.test(name)) return "cursor";
  if (/^qoder(?:cli)?$/.test(name)) return "qoder";
  if (/^omp$/.test(name)) return "omp";
  return "custom";
}
function environmentContext(control: BackendControlV1, role: ManagedSessionContext["role"], goalId?: string, attemptId?: string) {
  return {
    installationId: control.installationId, backend: control.selected, epoch: control.epoch,
    scopeGeneration: control.scopeGeneration, role, goalId, attemptId,
  } satisfies ManagedSessionContext;
}
export function managedSessionContext(environment: NodeJS.ProcessEnv): ManagedSessionContext | undefined {
  const raw = environment.CREWVANE_SESSION_CONTEXT;
  if (!raw) return;
  let value: ManagedSessionContext;
  try { value = JSON.parse(raw) as ManagedSessionContext; } catch { throw new Error("受管会话环境损坏。"); }
  if (!value.installationId || !value.scopeGeneration || !["herdr", "orca"].includes(value.backend) ||
    !Number.isSafeInteger(value.epoch) || !["owner", "concierge", "verifier"].includes(value.role))
    throw new Error("受管会话身份无效。");
  return value;
}
interface StoredLaunch {
  intent: SceneLaunchIntent;
  files: LaunchFiles;
  cwd: string;
  title: string;
  hookTokenHash: string;
  runtimeAdapter: AgentRuntimeAdapterId;
}
export interface SessionRuntimeOptions {
  control: SessionControl;
  workspace: string;
  adapter(backend: SessionBackendId, workspace: string): Promise<SessionAdapter>;
  cliDirectory: string;
  managedContext?: ManagedSessionContext;
  environment?: NodeJS.ProcessEnv;
  prepareHost?: () => Promise<void>;
  /** Only the desktop sets this; it is never inferred from Agent environment. */
  hostExecution?: boolean;
}
/** Desktop and standalone CLI use this exact launch/send implementation.
 * This layer coordinates transport receipts; core alone owns business facts. */
export class SessionRuntime {
  readonly service: WorkspaceService;
  private readonly adapters = new Map<string, Promise<{ adapter: SessionAdapter; control: BackendControlV1 }>>();
  constructor(readonly options: SessionRuntimeOptions) { this.service = new WorkspaceService(options.workspace); }
  private launchPath(id: string) { return childPath(join(this.options.control.directory, "runtime-launches"), id); }
  private async adapter(startIfMissing = false) {
    const control = await this.options.control.status();
    const key = `${control.selected}:${control.epoch}:${control.scopeGeneration}`;
    let pending = this.adapters.get(key);
    if (!pending) {
      pending = (async () => ({
        adapter: await this.options.adapter(control.selected, this.options.workspace),
        control,
      }))();
      this.adapters.set(key, pending);
    }
    const value = await pending;
    await value.adapter.connect({
      installationId: control.installationId,
      cwd: this.options.workspace,
      startIfMissing,
    });
    return { adapter: value.adapter, control };
  }
  private async prepareLaunch(input: {
    role: "concierge" | "owner" | "verifier"; goal?: Goal; name: string;
  }, control: BackendControlV1) {
    await this.options.prepareHost?.();
    const managed = this.options.managedContext;
    if (managed) {
      if (managed.role !== "concierge")
        throw new SessionError("scene_identity_mismatch", "只有受管管家可以启动负责人或复核者。");
      if (input.role === "concierge" || !input.goal || managed.goalId !== input.goal.id)
        throw new SessionError("scene_identity_mismatch", "只能为当前案卷启动负责人。");
      if (managed.backend !== control.selected || managed.epoch !== control.epoch ||
        managed.scopeGeneration !== control.scopeGeneration)
        throw new SessionError("stale_backend_epoch", "管家启动身份已撤销。");
    }
    const state = await this.service.read(), goal = input.goal;
    const intent: SceneLaunchIntent = {
      requestId: randomUUID(), bindingId: randomUUID(), attemptId: randomUUID(),
      backendEpoch: control.epoch, role: input.role, agent: input.name,
      status: "prepared", createdAt: new Date().toISOString(),
    };
    const configured = input.role === "concierge" ? state.agents?.concierge ?? "codex" :
      state.agents?.owner || state.agents?.concierge || "codex";
    const command = parseAgentCommand(configured, []);
    const resume = input.role === "owner" ? goal?.ownerResume?.agentSession : undefined;
    // Native session metadata must not replace a configured alias, wrapper,
    // model flags or credential environment with another executable.
    const nativeName = command.executable.split("/").at(-1);
    const restored = resume && nativeName === resume.agent ? resumeAgentArgs(resume) : undefined;
    if (restored) command.args = [...command.args, ...restored];
    const home = this.options.environment?.HOME ?? process.env.HOME ?? "";
    const executable = command.executable.startsWith("~/") ? join(home, command.executable.slice(2)) : command.executable;
    const project = goal && state.projects.find(item => item.id === goal.projectId);
    // Keep the global concierge in the workspace root. Orca registers every
    // exact terminal cwd as a visible folder project; using .crewvane here
    // created a second synthetic project beside each real workspace.
    const cwd = await realpath(project?.path || this.options.workspace);
    const context = environmentContext(control, input.role, goal?.id, intent.attemptId);
    const hookToken = randomBytes(32).toString("hex");
    const environment: Record<string, string> = {
      CREWVANE_WORKSPACE: this.options.workspace,
      CREWVANE_AGENT_NAME: input.name, CREWVANE_ROLE: input.role,
      CREWVANE_SESSION_CONTEXT: JSON.stringify(context),
      CREWVANE_BACKEND: control.selected, CREWVANE_BACKEND_EPOCH: String(control.epoch),
      CREWVANE_CONTROL_DIRECTORY: this.options.control.directory,
      CREWVANE_CLI_DIRECTORY: this.options.cliDirectory,
      PATH: this.options.cliDirectory,
      ...(input.role === "concierge" ? {
        CREWVANE_COORDINATOR: "1",
        CREWVANE_COORDINATOR_SCOPE_FILE: join(this.options.workspace, ".crewvane", "coordinator-scope.json"),
      } : {}),
      ...(goal ? {
        CREWVANE_GOAL_ID: goal.id, CREWVANE_ATTEMPT_ID: intent.attemptId,
        CREWVANE_HOOK_TOKEN: hookToken, CREWVANE_HOOK_SOCKET: agentRuntimeSocketPath(this.options.workspace),
        CREWVANE_HOOK_SPOOL: join(this.options.workspace, ".crewvane", "runtime", "spool"),
      } : {}),
    };
    // Keep test or explicit host configuration; never copy credentials or
    // inject CLI permission/model flags.
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CODEX_HOME", "CREWVANE_HOST_SOCKET", "CREWVANE_HOST_TOKEN"]) {
      const value = this.options.environment?.[key];
      if (value) environment[key] = value;
    }
    if (input.role === "concierge")
      for (const key of ["CREWVANE_RECOVERY_DIRECTORY", "CREWVANE_RECOVERY_TOKEN"]) {
        const value = this.options.environment?.[key];
        if (value) environment[key] = value;
      }
    if (control.selected === "herdr") {
      const binary = this.options.environment?.CREWVANE_HERDR_BINARY ??
        (await (await this.options.adapter("herdr", this.options.workspace)).detect()).path;
      if (binary) environment.CREWVANE_HERDR_BINARY = binary;
    }
    const files = await createLaunchFiles(this.options.control.directory, {
      ...intent, installationId: control.installationId, cwd, executable, args: command.args, environment,
    });
    const launch: StoredLaunch = {
      intent, files, cwd, title: input.role === "concierge" ? "Crewvane · 管家" : `Crewvane · ${goal!.title.slice(0, 60)}`,
      hookTokenHash: createHash("sha256").update(hookToken).digest("hex"), runtimeAdapter: adapterId(executable),
    };
    await atomicJSON(this.launchPath(intent.requestId), launch);
    return launch;
  }
  private async create(launch: StoredLaunch, adapter: SessionAdapter, control: BackendControlV1,
    goalId?: string, authority?: SwitchAuthority) {
    const request = {
      requestId: launch.intent.requestId, bindingId: launch.intent.bindingId, attemptId: launch.intent.attemptId,
      installationId: control.installationId, backendEpoch: control.epoch,
      role: launch.intent.role, goalId, cwd: launch.cwd, title: launch.title, ...launch.files,
    };
    const created = await this.options.control.operation({
      workspace: this.options.workspace, requestId: request.requestId, kind: "create", authority,
      role: launch.intent.role, goalId,
      admit: async () => {
        await this.service.execute({ type: "scene.prepare", goalId, intent: launch.intent });
        if (goalId && launch.intent.role === "owner") {
          await this.service.execute({
            type: "agent.runtime.register", goalId,
            attempt: { goalId, attemptId: launch.intent.attemptId, agent: launch.intent.agent,
              adapter: launch.runtimeAdapter, startedAt: launch.intent.createdAt },
            hookTokenHash: launch.hookTokenHash,
            capabilities: agentRuntimeCapabilities(launch.runtimeAdapter),
          });
        }
      },
    }, async () => adapter.create(request), async result => {
      if (result.scene) await this.service.execute({
        type: "scene.bind", goalId, scene: result.scene, role: launch.intent.role,
      });
      await this.service.execute({
        type: "scene.launch.result", goalId, role: launch.intent.role, requestId: request.requestId,
        status: result.status === "created" ? "created" : result.status === "rejected" ? "rejected" : "unconfirmed",
        detail: result.detail,
      });
    });
    if (!created.scene) throw new SessionError("launch_unconfirmed", created.detail ?? "启动结果未确认；请核对原请求，不重复创建。");
    // An environment receipt precedes the Agent child. Do not type a task into
    // the launcher's shell while the configured CLI is still starting.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const observation = await adapter.inspect(created.scene);
      if (observation.identity !== "match" || observation.state === "exited")
        throw new SessionError("launch_unconfirmed", "启动程序未保持存活；已保留原现场和请求，未重新创建。");
      if (observation.reachable && ["idle", "working", "blocked"].includes(observation.state)) break;
      // Arbitrary interactive CLIs may not expose a lifecycle state. The
      // launcher receipt and live foreground process still prove that a
      // terminal exists; allow its raw-input handshake to settle without
      // blocking every custom launch for the full 15 second uncertainty window.
      if (observation.reachable && observation.state === "unknown" &&
        Date.now() - Date.parse(launch.intent.createdAt) >= 1_800) break;
      if (Date.now() >= deadline) break; // An unknown custom CLI may have no lifecycle.
      await delay(250);
    }
    return created.scene;
  }
  private async recoverIntent(intent: SceneLaunchIntent, goalId?: string) {
    const { adapter, control } = await this.adapter();
    const discovered = await adapter.discover({ installationId: control.installationId,
      runtimeId: (await adapter.connect({ installationId: control.installationId, cwd: this.options.workspace })).id,
      requestId: intent.requestId });
    if (discovered.length === 1) {
      const scene = discovered[0]!.scene;
      await this.service.execute({ type: "scene.bind", goalId, role: intent.role, scene });
      return scene;
    }
    throw new SessionError("launch_unconfirmed", "原启动请求未确认；已保留记录，不能自动再建一个现场。");
  }
  private async initializeConcierge(scene: SceneReferenceV1, authority?: SwitchAuthority) {
    const state = await this.service.read();
    if (state.concierge.initializedAttemptId === scene.attemptId) {
      if (state.concierge.status !== "ready" || state.concierge.detail)
        await this.service.execute({
          type: "scene.concierge.status", status: "ready", initializedAttemptId: scene.attemptId,
        });
      return scene;
    }
    const { adapter } = await this.adapter();
    const waitIdle = async (allowUnknown = false) => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const observation = await adapter.inspect(scene);
        if (observation.identity !== "match" || observation.state === "exited")
          throw new SessionError("scene_identity_mismatch", "管家初始化时现场身份已改变。");
        if (observation.reachable && observation.state === "idle") return;
        if (allowUnknown && observation.reachable && observation.state === "unknown") return;
        if (observation.state === "blocked" || Date.now() >= deadline)
          throw new SessionError("delivery_unconfirmed", "管家尚未结束初始化或正在等待授权，请打开原现场核对；未重复发送。");
        await delay(250);
      }
    };
    const id = `identity-${scene.attemptId}`;
    const path = childPath(join(this.options.control.directory, "runtime-deliveries"), id);
    let receipt = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    if (!receipt) {
      await waitIdle(true);
      receipt = await this.send(scene, id, conciergeIdentityPrompt(this.options.workspace, state.agents), authority);
    }
    if (!["started", "accepted"].includes(receipt.status))
      throw new SessionError("delivery_unconfirmed", receipt.detail ?? "管家身份初始化尚未确认；请核对原现场，未重复发送。");
    await waitIdle(receipt.status === "accepted");
    await this.service.execute({ type: "scene.concierge.status", status: "ready", initializedAttemptId: scene.attemptId });
    return scene;
  }
  async prepareConcierge(authority?: SwitchAuthority) {
    const state = await this.service.read();
    if (state.concierge.scene) {
      const { adapter } = await this.adapter();
      const observation = await adapter.inspect(state.concierge.scene);
      if (observation.identity !== "match") throw new SessionError("scene_identity_mismatch", "管家运行时已改变，请重新核实现场。");
      if (observation.state !== "exited") return this.initializeConcierge(state.concierge.scene, authority);
      await this.service.execute({ type: "scene.release", bindingId: state.concierge.scene.bindingId });
    } else if (state.concierge.legacyScene?.reference.paneId)
      throw new SessionError("scene_identity_mismatch", "旧管家现场尚未核实；不能静默创建第二位管家。");
    if (state.concierge.launch && !state.concierge.scene && state.concierge.launch.status !== "rejected")
      return this.initializeConcierge(await this.recoverIntent(state.concierge.launch), authority);
    const { adapter, control } = await this.adapter(true);
    const launch = await this.prepareLaunch({ role: "concierge", name: "concierge" }, control);
    const scene = await this.create(launch, adapter, control, undefined, authority);
    return this.initializeConcierge(scene, authority);
  }
  async launchOwner(input: { goalId: string; name: string; role?: "owner" | "verifier"; task?: string; taskFile?: string;
    consultationOnly?: boolean }, authority?: SwitchAuthority) {
    if (!authority && this.options.managedContext && !this.options.hostExecution) {
      const environment = this.options.environment ?? process.env;
      if (environment.CREWVANE_RECOVERY_DIRECTORY && !await this.options.control.canDispatch())
        return await requestSessionRecovery(environment, {
          context: this.options.managedContext, operation: "launch", input,
        }) as { goalId: string; runtime: string; scene: SceneReferenceV1; receipt?: SendReceipt; warning?: string };
      const host = await requestWorkspaceSessionHost(this.options.workspace, {
        context: this.options.managedContext, operation: "launch", input,
      });
      if (host.handled) return host.result as {
        goalId: string; runtime: string; scene: SceneReferenceV1; receipt?: SendReceipt; warning?: string;
      };
    }
    if (!authority && this.options.managedContext && !await this.options.control.canDispatch())
      return await requestSessionRecovery(this.options.environment ?? process.env, {
        context: this.options.managedContext, operation: "launch", input,
      }) as { goalId: string; runtime: string; scene: SceneReferenceV1; receipt?: SendReceipt; warning?: string };
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name)) throw new Error("负责人名称只能包含小写英文字母、数字、下划线和短横线，以字母开头。");
    const state = await this.service.read(), goal = state.goals.find(item => item.id === input.goalId);
    if (!goal || goal.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(goal.status))
      throw new Error("当前事项不能启动负责人。");
    const role = input.role ?? "owner";
    if (role === "verifier" && (goal.status !== "review" || !goal.delivery || !goal.brief))
      throw new Error("独立复核需要待复核交付和委托摘要。");
    if (goal.scene && role === "owner") throw new Error("目标已有负责人现场；请使用 owner send 联系原负责人。");
    const candidateIntent = role === "owner" ? goal.sceneLaunch : goal.autonomy?.verificationLaunch;
    const existingIntent = candidateIntent?.status === "rejected" ? undefined : candidateIntent;
    if (existingIntent) {
      const scene = await this.recoverIntent(existingIntent, goal.id);
      return { goalId: goal.id, runtime: state.agents?.owner || state.agents?.concierge || "codex", scene,
        warning: "已核实原现场；原投递结果需另行核对，未重复发送任务。" };
    }
    const { adapter, control } = await this.adapter(true);
    const launch = await this.prepareLaunch({ role, goal, name: input.name }, control);
    const skills = await new SkillRegistry(this.options.workspace).resolve(goal, role, launch.intent.attemptId);
    await this.service.execute({ type: "goal.skill.resolve", goalId: goal.id, resolution: skills.resolution });
    let task = input.task;
    if (input.taskFile) {
      if (task) throw new Error("--task 与 --task-file 不能同时使用。");
      const path = await realpath(input.taskFile), base = await realpath(this.options.workspace);
      const pathInWorkspace = relative(base, path);
      if (!pathInWorkspace || pathInWorkspace.startsWith("..") || (await stat(path)).size > 100_000)
        throw new Error("任务文件必须位于当前工作区内，且不超过 100 KB。");
      task = await readFile(path, "utf8");
    }
    if (task && task.length > 100_000) throw new Error("任务说明超长。");
    const scene = await this.create(launch, adapter, control, goal.id, authority);
    const prompt = input.consultationOnly
      ? `${skills.text}\n当前目标处于决定、验收、等待或暂停。只读取 goal show ${goal.id} 的问题与已有证据，等待用户答复；不得开始实现、解掉注意力或变更状态。\n${ownerSceneReplyInstructions(goal.id)}`
      : `${skills.text}\n${task ?? caseTask(this.options.workspace, goal, role)}\n${role === "owner" ? ownerSceneReplyInstructions(goal.id) : ""}`;
    const receipt = await this.send(scene, `task-${launch.intent.requestId}`, prompt, authority);
    return { goalId: goal.id, runtime: state.agents?.owner || state.agents?.concierge || "codex", scene, receipt,
      ...(["accepted", "unknown"].includes(receipt.status) ? { warning: "任务送达后尚未观察到开始；已保留原现场，不自动重发。" } : {}) };
  }
  async send(scene: SceneReferenceV1, deliveryId: string, text: string, authority?: SwitchAuthority): Promise<SendReceipt> {
    if (!authority && this.options.managedContext && !this.options.hostExecution) {
      const environment = this.options.environment ?? process.env;
      if (environment.CREWVANE_RECOVERY_DIRECTORY && !await this.options.control.canDispatch())
        return await requestSessionRecovery(environment, {
          context: this.options.managedContext, operation: "send", input: { scene, deliveryId, text },
        }) as SendReceipt;
      const host = await requestWorkspaceSessionHost(this.options.workspace, {
        context: this.options.managedContext, operation: "send", input: { scene, deliveryId, text },
      });
      if (host.handled) return host.result as SendReceipt;
    }
    if (!authority && this.options.managedContext && !await this.options.control.canDispatch())
      return await requestSessionRecovery(this.options.environment ?? process.env, {
        context: this.options.managedContext, operation: "send", input: { scene, deliveryId, text },
      }) as SendReceipt;
    // Watchdog correlation IDs can include ISO timestamps. Keep a bounded,
    // stable encoding for filesystem and control-operation keys.
    if (!/^[a-zA-Z0-9_-]{1,140}$/.test(deliveryId))
      deliveryId = `delivery-${createHash("sha256").update(deliveryId).digest("hex")}`;
    const { adapter } = await this.adapter();
    const state = await this.service.read();
    const goal = state.goals.find(item => item.scene?.bindingId === scene.bindingId ||
      item.autonomy?.verificationSite?.scene?.bindingId === scene.bindingId);
    const role = state.concierge.scene?.bindingId === scene.bindingId ? "concierge" :
      goal?.scene?.bindingId === scene.bindingId ? "owner" :
        goal?.autonomy?.verificationSite?.scene?.bindingId === scene.bindingId ? "verifier" : undefined;
    if (!role)
      throw new SessionError("scene_identity_mismatch", "投递目标不属于当前工作区中已登记的真实现场。");
    const managed = this.options.managedContext;
    if (managed && (managed.role !== "concierge" || !goal || managed.goalId !== goal.id ||
      managed.backend !== scene.backend || managed.epoch !== scene.backendEpoch ||
      managed.scopeGeneration !== state.backendBinding?.scopeGeneration))
      throw new SessionError("scene_identity_mismatch", "只能向当前案卷负责人发送协调消息。");
    const receiptPath = childPath(join(this.options.control.directory, "runtime-deliveries"), deliveryId);
    const previous = await readJSON(receiptPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    const payloadSha256 = createHash("sha256").update(text).digest("hex");
    if (previous) {
      if (previous.payloadSha256 !== payloadSha256 || previous.scene.bindingId !== scene.bindingId)
        throw new SessionError("scene_identity_mismatch", "原投递不能更换正文或现场。");
      return previous;
    }
    const result = await this.options.control.operation({
      workspace: this.options.workspace, requestId: `delivery-${deliveryId}`, kind: "send",
      bindingId: scene.bindingId, authority, role, goalId: goal?.id,
    }, () => adapter.send({ scene, deliveryId, text, payloadSha256 }),
    async receipt => { await atomicJSON(receiptPath, receipt); });
    return result;
  }
  async notifyGoal(goal: Goal, note?: string, authority?: SwitchAuthority, deliveryId?: string) {
    const scene = await this.prepareConcierge(authority);
    const observation = (await this.inspect([scene]))[0];
    if (observation?.identity === "match" && ["working", "blocked"].includes(observation.state))
      throw new SessionError("backend_busy", "管家仍在处理上一回合或等待现场授权；通知保留在队列中，尚未发送。");
    const receipt = await this.send(scene, deliveryId ?? goal.dispatch?.id ?? randomUUID(),
      await goalNotificationPrompt(this.options.workspace, goal, note), authority);
    if (receipt.status === "rejected") throw new Error(receipt.detail ?? "管家未接受消息。");
    return { scene, receipt };
  }
  async focus(scene: SceneReferenceV1) {
    const { adapter } = await this.adapter();
    if (!await this.options.control.canDispatch()) throw new SessionError("backend_switch_in_progress", "请先完成现场交接。");
    const result = await adapter.focus(scene);
    if (result.status !== "focused" || !result.navigated) throw new SessionError("focus_failed", result.detail ?? "未能定位原现场。");
    return result;
  }
  /** Explicit user recovery only. A disconnected or replaced runtime is never
   * enough evidence to retire a possibly working scene. */
  async recoverOwnerForConsultation(goalId: string) {
    const state = await this.service.read(), goal = state.goals.find(item => item.id === goalId);
    if (!goal || goal.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(goal.status))
      throw new Error("该事项当前不能恢复现场。");
    if (goal.scene) {
      const { adapter } = await this.adapter();
      const observed = await adapter.inspect(goal.scene);
      if (observed.identity === "match" && observed.reachable && observed.state !== "exited")
        return { scene: goal.scene };
      if (observed.identity !== "match" || observed.state !== "exited")
        throw new SessionError("scene_identity_mismatch", "原现场尚未确认停止；未创建新负责人，请重新连接或核实原现场。");
      await this.service.execute({ type: "scene.retire", goalId,
        bindingId: goal.scene.bindingId, attemptId: goal.scene.attemptId });
    }
    return this.launchOwner({ goalId, name: `owner-${goalId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase()}`,
      consultationOnly: true });
  }
  async close(scene: SceneReferenceV1, goalId?: string) {
    const { adapter } = await this.adapter();
    const receipt = await this.options.control.operation({
      workspace: this.options.workspace, requestId: `close-${scene.bindingId}-${randomUUID()}`, kind: "close",
      bindingId: scene.bindingId,
    }, () => adapter.close(scene));
    if (!receipt.identityVerified || receipt.status === "unknown")
      throw new SessionError("scene_identity_mismatch", receipt.detail ?? "现场停止未确认。");
    await this.service.execute({ type: "scene.release", bindingId: scene.bindingId, goalId });
    return receipt;
  }
  async captureOwnerResume(goalId: string, scene: SceneReferenceV1): Promise<OwnerResume | undefined> {
    const { adapter } = await this.adapter();
    const result = await adapter.captureResume(scene);
    if (result.status !== "supported") return undefined;
    const state = await this.service.read();
    const goal = state.goals.find(item => item.id === goalId);
    if (!goal) throw new Error("目标不存在。");
    const project = state.projects.find(item => item.id === goal.projectId);
    const cwd = project?.path || this.options.workspace;
    const resume = {
      owner: goal.owner || scene.locator.kind === "herdr" && scene.locator.agent || "owner",
      cwd,
      savedAt: new Date().toISOString(),
      agentSession: {
        source: `${scene.backend}:${result.agent}`,
        agent: result.agent,
        kind: result.kind,
        value: result.value,
      },
    } satisfies OwnerResume;
    await this.service.execute({
      type: ["completed", "dropped"].includes(goal.status) ? "session.preserve" : "session.resume.capture",
      goalId,
      resume,
    });
    return resume;
  }
  async inspect(scenes: SceneReferenceV1[]) {
    const { adapter } = await this.adapter();
    return adapter.inspectMany(scenes);
  }
}
