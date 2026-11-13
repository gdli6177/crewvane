import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  WorkspaceService, attentionRequest, parseAgentCommand, resumeAgentArgs,
  type BackendHandoff, type Goal, type SceneReferenceV1, type SessionBackendId, type WorkspaceState,
} from "../../../core/src/index.js";
import { SessionError } from "../contracts.js";
import { atomicJSON, childPath, readJSON, record } from "../io.js";
import { localProcesses } from "../process.js";
import { withControlLock } from "./lock.js";
import type {
  BackendControlV1, OperationLease, SceneResource, SwitchAuthority, SwitchHooks,
  SwitchJournal, SwitchPhase, WorkspaceRegistration,
} from "./types.js";

function readyBinding(control: BackendControlV1) {
  return {
    installationId: control.installationId, backend: control.selected,
    epoch: control.epoch, scopeGeneration: control.scopeGeneration, status: "active" as const,
  };
}
function needsAutomaticResume(item: Goal) {
  return item.mode === "concierge" && item.status === "active" &&
    !attentionRequest(item) && !item.autonomy?.paused &&
    !!item.next.trim() &&
    item.activities.some(activity => activity.actor !== "系统" &&
      ["progress", "waiting", "decision", "delivery", "resolved"].includes(activity.kind));
}
function sceneResources(root: string, state: WorkspaceState): SceneResource[] {
  return [
    ...(state.concierge.scene ? [{ workspace: root, role: "concierge" as const, scene: state.concierge.scene }] : []),
    ...state.goals.flatMap(item => [
      ...(item.scene ? [{ workspace: root, role: "owner" as const, goalId: item.id, scene: item.scene }] : []),
      ...(item.autonomy?.verificationSite?.scene
        ? [{ workspace: root, role: "verifier" as const, goalId: item.id, scene: item.autonomy.verificationSite.scene }] : []),
    ]),
  ];
}
export class SessionControl {
  private readonly authority = new Map<symbol, {
    operationId: string; phase: SwitchPhase; resources: Set<string>; roots: Set<string>;
    goals: Map<string, Set<string>>;
  }>();
  constructor(readonly directory: string, private readonly options: { quiescenceTimeoutMs?: number } = {}) {}
  private get controlPath() { return join(this.directory, "backend.json"); }
  private get registryPath() { return join(this.directory, "workspaces.json"); }
  private journalPath(operationId: string) { return childPath(join(this.directory, "switch"), operationId); }
  private async load(): Promise<BackendControlV1> {
    const value = await readJSON(this.controlPath);
    if (!record(value) || value.version !== 1 || !["herdr", "orca"].includes(String(value.selected)) ||
      !Number.isSafeInteger(value.epoch) || typeof value.installationId !== "string" ||
      typeof value.scopeGeneration !== "string" || !["ready", "switching", "recovery_required"].includes(String(value.phase)))
      throw new SessionError("switch_recovery_required", "会话后端配置损坏；已阻止派发，不能默认回退 Herdr。");
    return value as unknown as BackendControlV1;
  }
  async initialize(options: { recoverInterrupted?: boolean } = {}) {
    return withControlLock(this.directory, async () => {
      let control: BackendControlV1;
      try { control = await this.load(); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        control = { version: 1, installationId: randomUUID(), selected: "herdr", epoch: 0, scopeGeneration: randomUUID(), phase: "ready" };
        await atomicJSON(this.controlPath, control);
      }
      if (control.phase === "switching" && options.recoverInterrupted) {
        // Even preflight may have outstanding leases. A restarted process
        // must inspect the journal; it never declares a switch ready by fiat.
        control.phase = "recovery_required";
        await atomicJSON(this.controlPath, control);
      }
      return control;
    });
  }
  async status() { return this.load(); }
  async registrations(): Promise<WorkspaceRegistration[]> {
    const value = await readJSON(this.registryPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    if (!Array.isArray(value) || value.some(item => !record(item) || typeof item.root !== "string" || typeof item.registeredAt !== "string"))
      throw new SessionError("switch_recovery_required", "工作区注册表损坏，无法确认所有受管资源。");
    return value as WorkspaceRegistration[];
  }
  async registerWorkspace(path: string) {
    const root = await realpath(path);
    return withControlLock(this.directory, async () => {
      const control = await this.load();
      const entries = await this.registrations();
      // Reopening an already registered workspace is read-only and must remain
      // possible while showing switch recovery UI. New roots stay frozen.
      if (control.phase !== "ready" || control.maintenance) {
        if (entries.some(entry => entry.root === root)) return control;
        throw new SessionError("backend_switch_in_progress", "交接期间暂不登记新工作区。");
      }
      if (!entries.some(entry => entry.root === root)) {
        entries.push({ root, registeredAt: new Date().toISOString() });
        await atomicJSON(this.registryPath, entries.sort((a, b) => a.root.localeCompare(b.root)));
      }
      await new WorkspaceService(root).execute({ type: "backend.register", binding: readyBinding(control) });
      return control;
    });
  }
  async setOrcaPath(appPath: string) {
    return withControlLock(this.directory, async () => {
      const control = await this.load();
      if (control.phase !== "ready") throw new SessionError("backend_switch_in_progress", "请先完成当前交接。");
      control.orcaAppPath = await realpath(appPath);
      await atomicJSON(this.controlPath, control);
      return control;
    });
  }
  private authorize(control: BackendControlV1, workspace: string, input: {
    kind: OperationLease["kind"]; bindingId?: string; goalId?: string; role?: OperationLease["role"]; authority?: SwitchAuthority;
  }) {
    if (control.phase === "ready" && !control.maintenance) return;
    const { authority, kind, bindingId } = input;
    const grant = authority && this.authority.get(authority.proof);
    if (!grant || grant.operationId !== control.switchOperationId || !grant.roots.has(workspace) ||
      (grant.phase === "quiescing" && (kind !== "close" || !bindingId || !grant.resources.has(bindingId))) ||
      (grant.phase === "resuming" &&
        (kind === "close" || (input.role !== "concierge" && (!input.goalId || !grant.goals.get(workspace)?.has(input.goalId))))) ||
      !["quiescing", "resuming"].includes(grant.phase))
      throw new SessionError("backend_switch_in_progress", "正在交接现场；内容仍会保存，现场操作稍后继续。");
  }
  async canDispatch() {
    const control = await this.load();
    return control.phase === "ready" && !control.maintenance;
  }
  async beginMaintenance(backend: SessionBackendId) {
    return withControlLock(this.directory, async () => {
      const control = await this.load();
      if (control.phase !== "ready" || control.maintenance)
        throw new SessionError("backend_busy", "请先完成当前现场交接或更新。");
      if (control.selected !== backend) return undefined;
      if ((await this.activeLeases()).length)
        throw new SessionError("backend_busy", "仍有启动或消息正在发送，请稍后更新。");
      const id = randomUUID();
      await atomicJSON(this.controlPath, { ...control, maintenance: {
        id, backend, startedAt: new Date().toISOString(),
      } });
      return id;
    });
  }
  async endMaintenance(id: string) {
    return withControlLock(this.directory, async () => {
      const control = await this.load();
      if (control.maintenance?.id !== id) return;
      delete control.maintenance;
      await atomicJSON(this.controlPath, control);
    });
  }
  async operation<T>(input: {
    workspace: string;
    requestId: string;
    kind: OperationLease["kind"];
    bindingId?: string;
    goalId?: string;
    role?: OperationLease["role"];
    authority?: SwitchAuthority;
    leaseMs?: number;
    /** Local state preparation under the same admission lock as the lease. */
    admit?(control: BackendControlV1): Promise<void>;
  }, perform: (control: BackendControlV1) => Promise<T>, commit?: (result: T, control: BackendControlV1) => Promise<void>) {
    const workspace = await realpath(input.workspace);
    const path = childPath(join(this.directory, "leases"), input.requestId);
    const initial = await withControlLock(this.directory, async () => {
      const control = await this.load();
      this.authorize(control, workspace, input);
      const previous = await readJSON(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      });
      if (previous)
        throw new SessionError("delivery_unconfirmed", "该请求已有执行记录，请核对原回执，不能重新执行。");
      const owner = await localProcesses.identity(process.pid);
      if (!owner) throw new Error("无法核实控制进程身份。");
      await input.admit?.(control);
      const lease: OperationLease = {
        id: randomUUID(), requestId: input.requestId, workspace, backend: control.selected,
        epoch: control.epoch, kind: input.kind, bindingId: input.bindingId,
        goalId: input.goalId, role: input.role, owner,
        startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (input.leaseMs ?? 40_000)).toISOString(), status: "running",
      };
      await atomicJSON(path, lease);
      return { control, lease };
    });
    let result: T;
    try { result = await perform(initial.control); }
    catch (error) {
      await withControlLock(this.directory, () => atomicJSON(path, { ...initial.lease, status: "unknown" }));
      throw error;
    }
    await withControlLock(this.directory, async () => {
      const control = await this.load();
      if (control.epoch !== initial.control.epoch || control.selected !== initial.control.selected) {
        await atomicJSON(path, { ...initial.lease, status: "unknown" });
        throw new SessionError("stale_backend_epoch", "现场操作返回时后端已经改变，未写入陈旧绑定。");
      }
      // A switch may be waiting for this admitted operation. Finishing it is
      // allowed during preflight; only NEW admission is frozen.
      await commit?.(result, control);
      await atomicJSON(path, { ...initial.lease, status: "finished" });
    });
    return result;
  }
  private async activeLeases() {
    const directory = join(this.directory, "leases");
    const files = await readdir(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const values = await Promise.all(files.filter(file => file.endsWith(".json")).map(async file => await readJSON(join(directory, file)) as OperationLease));
    return values.filter(value => value.status !== "finished");
  }
  async journal(operationId?: string): Promise<SwitchJournal | undefined> {
    const id = operationId ?? (await this.load()).switchOperationId;
    return id ? await readJSON(this.journalPath(id)) as SwitchJournal : undefined;
  }
  private async persist(journal: SwitchJournal, hooks: SwitchHooks) {
    journal.updatedAt = new Date().toISOString();
    await atomicJSON(this.journalPath(journal.operationId), journal);
    hooks.onProgress?.(structuredClone(journal));
    await hooks.afterPersist?.(journal.phase, structuredClone(journal));
  }
  private grant(journal: SwitchJournal): SwitchAuthority {
    const proof = Symbol("switch-authority");
    this.authority.set(proof, {
      operationId: journal.operationId, phase: journal.phase,
      resources: new Set(journal.resources.map(resource => resource.scene.bindingId)),
      roots: new Set(journal.workspaces.map(workspace => workspace.root)),
      goals: new Map(journal.workspaces.map(workspace => [
        workspace.root, new Set(Object.entries(workspace.handoffs)
          .filter(([, handoff]) => handoff.method !== "deferred").map(([id]) => id)),
      ])),
    });
    return Object.freeze({ operationId: journal.operationId, proof });
  }
  async switchTo(to: SessionBackendId, hooks: SwitchHooks, signal?: AbortSignal): Promise<SwitchJournal | undefined> {
    const admitted = await withControlLock(this.directory, async () => {
      const current = await this.load();
      if (current.maintenance)
        throw new SessionError("backend_busy", "正在更新后端，请先完成安装并重新检测，或结束更新。");
      if (current.phase !== "ready") return { journal: await this.journal(), execute: false };
      if (current.selected === to) return { journal: undefined, execute: false };
      const roots = (await this.registrations()).map(entry => entry.root).sort();
      if (!roots.length) throw new SessionError("backend_busy", "请先打开一个工作区。");
      const operationId = randomUUID();
      const journal: SwitchJournal = {
        version: 1, operationId, from: current.selected, to, fromEpoch: current.epoch,
        nextEpoch: current.epoch + 1, scopeGeneration: randomUUID(), phase: "preflight",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        workspaces: roots.map(root => ({ root, handoffs: {} })), resources: [], closed: [],
      };
      await atomicJSON(this.journalPath(operationId), journal);
      await atomicJSON(this.controlPath, { ...current, phase: "switching", switchOperationId: operationId });
      return { journal, execute: true };
    });
    if (!admitted.execute || !admitted.journal) return admitted.journal;
    try { if (hooks.afterAdmission) await hooks.afterAdmission(structuredClone(admitted.journal)); }
    catch (error) {
      // Admission is already durable. Treat a host/process failure here as an
      // interrupted transaction, not a cancellation followed by old-scene use.
      const journal = admitted.journal;
      journal.phase = "recovery_required";
      journal.resumePhase = "preflight";
      journal.detail = error instanceof Error ? error.message : String(error);
      await this.persist(journal, { ...hooks, afterPersist: undefined });
      await withControlLock(this.directory, async () => {
        const current = await this.load();
        await atomicJSON(this.controlPath, { ...current, phase: "recovery_required", switchOperationId: journal.operationId });
      });
      return journal;
    }
    return this.executeSwitch(admitted.journal, hooks, signal);
  }
  private async preflight(journal: SwitchJournal, hooks: SwitchHooks, signal?: AbortSignal) {
    const firstRoot = journal.workspaces[0]!.root;
    const target = await hooks.adapter(journal.to, firstRoot);
    const targetDetection = await target.detect();
    if (targetDetection.status !== "compatible")
      throw new SessionError(targetDetection.status === "missing" ? "backend_missing" :
        targetDetection.status === "unverified" ? "backend_unverified" : "backend_incompatible", targetDetection.detail ?? "目标后端尚未通过兼容验证。");
    await target.connect({ installationId: (await this.load()).installationId, cwd: firstRoot, startIfMissing: true });
    const deadline = Date.now() + (this.options.quiescenceTimeoutMs ?? 30_000);
    for (;;) {
      if (signal?.aborted) throw new Error("切换准备已取消。");
      const leases = await this.activeLeases();
      let busy = leases.length > 0;
      journal.resources = [];
      for (const workspace of journal.workspaces) {
        await stat(workspace.root); // Unreadable registered roots block; no disk scan.
        const state = await new WorkspaceService(workspace.root).read();
        const resources = sceneResources(workspace.root, state);
        const legacy = state.goals.some(goal =>
          !["completed", "dropped", "backlog"].includes(goal.status) &&
          (goal.herdr || goal.legacyScene && !goal.scene)) ||
          state.concierge.legacyScene && !state.concierge.scene &&
          (state.concierge.legacyScene.reference.agent || state.concierge.legacyScene.reference.paneId);
        if (legacy) throw new SessionError("scene_identity_mismatch", `工作区 ${state.name} 的旧现场需要先重新核实连接。`);
        busy ||= await hooks.busy?.(workspace.root) ?? false;
        const adapter = await hooks.adapter(journal.from, workspace.root);
        const nativeResume = new Set<string>();
        if (resources.length) {
          await adapter.connect({ installationId: (await this.load()).installationId, cwd: workspace.root });
          const observations = await adapter.inspectMany(resources.map(resource => resource.scene));
          for (const resource of resources) {
            const goal = resource.goalId && state.goals.find(item => item.id === resource.goalId);
            const observation = observations.find(item => item.bindingId === resource.scene.bindingId);
            if (!observation || observation.identity !== "match" ||
              !["idle", "exited"].includes(observation.state)) { busy = true; continue; }
            if (goal && goal.dispatch?.status === "unconfirmed")
              throw new SessionError("delivery_unconfirmed", "存在未确认投递；请先在原现场核对。");
            if (goal && goal.dispatch?.status !== "pending" && observation.state === "idle" && goal.status === "active" && !attentionRequest(goal) &&
              !(goal.agentRuntime?.lastSemanticWriteTurnId &&
                goal.agentRuntime.lastSemanticWriteTurnId === goal.agentRuntime.currentTurnId) &&
              !goal.activities.some(activity => activity.actor !== "系统" &&
                ["progress", "waiting", "decision", "delivery", "resolved"].includes(activity.kind) &&
                activity.at >= (goal.dispatch?.at ?? goal.createdAt)))
              throw new SessionError("delivery_unconfirmed", "负责人空闲但缺少语义回执；请先由管家核对后再切换。");
            if (goal && resource.role === "owner") {
              const resume = await adapter.captureResume(resource.scene)
                .catch(() => ({ status: "unknown" as const, detail: "原生会话身份采集失败。" }));
              if (resume.status === "supported") {
                const project = state.projects.find(item => item.id === goal.projectId);
                await new WorkspaceService(workspace.root).execute({
                  type: ["completed", "dropped"].includes(goal.status) ? "session.preserve" : "session.resume.capture",
                  goalId: goal.id,
                  resume: {
                    owner: goal.owner ||
                      (resource.scene.locator.kind === "herdr" ? resource.scene.locator.agent : undefined) ||
                      "owner",
                    ...(project?.path ? { cwd: project.path } : {}),
                    savedAt: new Date().toISOString(),
                    agentSession: {
                      source: `${resource.scene.backend}:${resume.agent}`,
                      agent: resume.agent,
                      kind: resume.kind,
                      value: resume.value,
                    },
                  },
                });
                const command = parseAgentCommand(state.agents?.owner || state.agents?.concierge || "codex", []);
                if (command.executable.split("/").at(-1) === resume.agent &&
                  resumeAgentArgs({ source: `${resource.scene.backend}:${resume.agent}`,
                    agent: resume.agent, kind: resume.kind, value: resume.value }))
                  nativeResume.add(goal.id);
              }
            }
          }
        }
        journal.resources.push(...resources);
        workspace.handoffs = Object.fromEntries(state.goals.map(goal => [goal.id, {
          operationId: journal.operationId, checkpointRevision: goal.revision ?? 1,
          checkpointActivityId: goal.activities.at(-1)?.id,
          sourceScene: goal.scene, sourceAttemptId: goal.agentRuntime?.attempt.attemptId,
          lastSemanticWriteAt: goal.agentRuntime?.lastSemanticWriteAt,
          originalDelivery: goal.dispatch?.status,
          method: needsAutomaticResume(goal)
            ? nativeResume.has(goal.id) ? "native-resume" : "case-rehydrate"
            : "deferred",
          status: needsAutomaticResume(goal) ? "prepared" : "skipped",
        } satisfies BackendHandoff]));
      }
      if (!busy) return;
      if (Date.now() >= deadline)
        throw new SessionError("backend_busy", "仍有工作、阻塞、未知现场或未结束租约；原后端保持不变。");
      await delay(250, undefined, { signal });
    }
  }
  private async executeSwitch(journal: SwitchJournal, hooks: SwitchHooks, signal?: AbortSignal): Promise<SwitchJournal> {
    let sideEffects = ["quiescing", "old_stopped", "committing", "resuming"].includes(journal.phase);
    let authority: SwitchAuthority | undefined;
    try {
      if (journal.phase === "preflight") {
        await this.persist(journal, hooks);
        await this.preflight(journal, hooks, signal);
        journal.phase = "prepared";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "prepared") {
        if (signal?.aborted) throw new Error("切换准备已取消。");
        journal.phase = "quiescing";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "quiescing") {
        sideEffects = true;
        journal.phase = "quiescing";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "quiescing") {
        for (const workspace of journal.workspaces) {
          const service = new WorkspaceService(workspace.root);
          const state = await service.read();
          await service.execute({ type: "backend.revoke", operationId: journal.operationId,
            expectedEpoch: journal.restoresOperationId ? state.backendEpoch : journal.fromEpoch });
        }
        authority = this.grant(journal);
        for (const resource of journal.resources) {
          if (journal.closed.some(receipt => receipt.bindingId === resource.scene.bindingId &&
            ["stopped", "already_stopped"].includes(receipt.status) && receipt.identityVerified)) continue;
          const adapter = await hooks.adapter(resource.scene.backend, resource.workspace);
          await adapter.connect({ installationId: resource.scene.installationId, cwd: resource.workspace });
          const receipt = await adapter.close(resource.scene);
          journal.closed = [...journal.closed.filter(item => item.bindingId !== receipt.bindingId), receipt];
          await this.persist(journal, hooks);
          if (!receipt.identityVerified || !["stopped", "already_stopped"].includes(receipt.status))
            throw new SessionError("switch_recovery_required", "旧现场停止结果未确认，已暂停交接。");
        }
        // Close receipts are identity-bound, and every resource has a verified
        // stopped verdict before any new-backend business Agent can start.
        if (journal.closed.length !== journal.resources.length)
          throw new SessionError("switch_recovery_required", "仍有旧现场未确认停止。");
        this.authority.delete(authority.proof);
        authority = undefined;
        journal.phase = "old_stopped";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "old_stopped") {
        journal.phase = "committing";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "committing") {
        for (const workspace of journal.workspaces) {
          const service = new WorkspaceService(workspace.root), state = await service.read();
          if (!(state.backendEpoch === journal.nextEpoch && state.backendBinding?.operationId === journal.operationId)) {
            await service.execute({
              type: "backend.commit",
              binding: {
                installationId: (await this.load()).installationId, backend: journal.to,
                epoch: journal.nextEpoch, scopeGeneration: journal.scopeGeneration,
                status: "resuming", operationId: journal.operationId,
              },
              handoffs: workspace.handoffs,
            });
          }
          workspace.committed = true;
          await this.persist(journal, hooks);
        }
        await withControlLock(this.directory, async () => {
          const control = await this.load();
          await atomicJSON(this.controlPath, { ...control, selected: journal.to, epoch: journal.nextEpoch,
            scopeGeneration: journal.scopeGeneration, phase: "switching", switchOperationId: journal.operationId });
        });
        journal.phase = "resuming";
        await this.persist(journal, hooks);
      }
      if (journal.phase === "resuming") {
        authority = this.grant(journal);
        for (const workspace of journal.workspaces) {
          if (workspace.resumed) continue;
          const service = new WorkspaceService(workspace.root);
          // The current snapshot, not prepared.handoffs, determines what
          // resumes after human edits during switching.
          await hooks.resume({ workspace: workspace.root, state: await service.read(), authority, operationId: journal.operationId });
          const current = await service.read();
          const unresolved = Object.keys(workspace.handoffs).filter(goalId => {
            const handoff = current.goals.find(goal => goal.id === goalId)?.backendHandoff;
            return !handoff || handoff.operationId !== journal.operationId ||
              !["accepted", "skipped"].includes(handoff.status);
          });
          if (unresolved.length)
            throw new SessionError(
              "switch_recovery_required",
              `仍有 ${unresolved.length} 个目标交接未确认；已停在恢复状态，不能进入新后端派发。`,
            );
          workspace.resumed = true;
          await this.persist(journal, hooks);
        }
        for (const workspace of journal.workspaces) {
          const service = new WorkspaceService(workspace.root);
          if ((await service.read()).backendBinding?.status === "resuming")
            await service.execute({ type: "backend.activate", operationId: journal.operationId });
        }
        this.authority.delete(authority.proof);
        authority = undefined;
        journal.phase = "ready";
        await this.persist(journal, hooks);
        await withControlLock(this.directory, async () => {
          const control = await this.load();
          await atomicJSON(this.controlPath, { ...control, phase: "ready", switchOperationId: undefined });
        });
      }
      return journal;
    } catch (error) {
      if (authority) this.authority.delete(authority.proof);
      const detail = error instanceof Error ? error.message : String(error);
      if (!sideEffects) {
        journal.phase = "cancelled";
        journal.detail = detail;
        await this.persist(journal, { ...hooks, afterPersist: undefined });
        await withControlLock(this.directory, async () => {
          const current = await this.load();
          await atomicJSON(this.controlPath, { ...current, phase: "ready", switchOperationId: undefined });
        });
      } else {
        journal.resumePhase = journal.phase === "ready" ? "resuming" :
          journal.phase as NonNullable<SwitchJournal["resumePhase"]>;
        journal.phase = "recovery_required";
        journal.detail = detail;
        await this.persist(journal, { ...hooks, afterPersist: undefined });
        await withControlLock(this.directory, async () => {
          const control = await this.load();
          await atomicJSON(this.controlPath, { ...control, phase: "recovery_required", switchOperationId: journal.operationId });
        });
      }
      return journal;
    }
  }
  async retrySwitch(hooks: SwitchHooks, signal?: AbortSignal) {
    const journal = await this.journal();
    if (!journal) throw new SessionError("switch_recovery_required", "未找到交接日志。");
    if (journal.phase === "recovery_required") journal.phase = journal.resumePhase ?? "preflight";
    return this.executeSwitch(journal, hooks, signal);
  }
  /** Returning to the source is another transaction, never a JSON rollback.
   * Every possibly surviving old/new scene must be quiet and identity checked. */
  async restoreOriginal(hooks: SwitchHooks) {
    const journal = await withControlLock(this.directory, async () => {
      const control = await this.load(), previous = await this.journal();
      if (control.phase !== "recovery_required" || !previous)
        throw new SessionError("switch_recovery_required", "当前没有需要恢复的交接。");
      const states = await Promise.all(previous.workspaces.map(async entry => ({
        root: entry.root, state: await new WorkspaceService(entry.root).read(),
      })));
      const resources = [...new Map([
        ...previous.resources.filter(resource => !previous.closed.some(receipt =>
          receipt.bindingId === resource.scene.bindingId && receipt.identityVerified &&
          ["stopped", "already_stopped"].includes(receipt.status))),
        ...states.flatMap(({ root, state }) => sceneResources(root, state)),
      ].map(resource => [resource.scene.bindingId, resource])).values()]
        .filter(resource => !previous.closed.some(receipt =>
          receipt.bindingId === resource.scene.bindingId && receipt.identityVerified &&
          ["stopped", "already_stopped"].includes(receipt.status)));
      return { control, previous, states, resources };
    });
    const target = await hooks.adapter(journal.previous.from, journal.states[0]!.root);
    if ((await target.detect()).status !== "compatible")
      throw new SessionError("backend_incompatible", "原后端尚不可用，未停止任何其他现场。");
    for (const resource of journal.resources) {
      const adapter = await hooks.adapter(resource.scene.backend, resource.workspace);
      await adapter.connect({ installationId: resource.scene.installationId, cwd: resource.workspace });
      const observed = await adapter.inspect(resource.scene);
      if (observed.identity !== "match" || !["idle", "exited"].includes(observed.state))
        throw new SessionError("backend_busy", "仍有现场无法确认静止；请先在原现场处理，再恢复原后端。");
    }
    const next: SwitchJournal = {
      version: 1, operationId: randomUUID(), from: journal.control.selected, to: journal.previous.from,
      fromEpoch: journal.control.epoch,
      nextEpoch: Math.max(journal.control.epoch, ...journal.states.map(({ state }) => state.backendEpoch)) + 1,
      scopeGeneration: randomUUID(), phase: "quiescing", restoresOperationId: journal.previous.operationId,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      resources: journal.resources, closed: [],
      workspaces: journal.states.map(({ root, state }) => ({ root, handoffs: Object.fromEntries(state.goals.map(goal => {
        const uncertain = goal.dispatch?.status === "unconfirmed" || goal.backendHandoff?.status === "unconfirmed";
        return [goal.id, {
          operationId: "", checkpointRevision: goal.revision ?? 1,
          sourceScene: goal.scene, sourceAttemptId: goal.agentRuntime?.attempt.attemptId,
          originalDelivery: goal.dispatch?.status,
          method: !uncertain && needsAutomaticResume(goal) ? "case-rehydrate" : "deferred",
          status: uncertain ? "unconfirmed" : needsAutomaticResume(goal) ? "prepared" : "skipped",
          ...(uncertain ? { detail: "原投递结果未确认，恢复后不会自动重放。" } : {}),
        } satisfies BackendHandoff];
      })) })),
    };
    for (const workspace of next.workspaces)
      for (const handoff of Object.values(workspace.handoffs)) handoff.operationId = next.operationId;
    await withControlLock(this.directory, async () => {
      const current = await this.load();
      if (current.switchOperationId !== journal.previous.operationId || current.phase !== "recovery_required")
        throw new SessionError("backend_busy", "交接已被其他操作更新，请重新检测。");
      await atomicJSON(this.journalPath(next.operationId), next);
      await atomicJSON(this.controlPath, { ...current, phase: "switching", switchOperationId: next.operationId });
    });
    return this.executeSwitch(next, hooks);
  }
}
