import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SceneReferenceV1 } from "../../../core/src/index.js";
import {
  type AgentResumeResult, type BackendDetection, type CloseReceipt,
  type CreateSceneRequest, type CreateSceneResult, type FocusResult,
  type OwnedSceneMatch, type OwnedSceneQuery, type RuntimeConnection, type RuntimeIdentity,
  type SceneObservation, type SendReceipt, type SendSceneRequest, type SessionAdapter, SessionError,
} from "../contracts.js";
import { atomicJSON, claimJSON, childPath, readJSON, record, string } from "../io.js";
import { launcherCommand, readLaunchReceipt, receiptProcess, type LaunchReceipt } from "../launcher.js";
import { localProcesses, type ProcessInspector } from "../process.js";
import { detectOrcaApplication } from "./detection.js";
import { orcaEnvelope, orcaPrograms, orcaTerminal, terminalPaneKey, OrcaCommandError, type OrcaEnvelope, type OrcaTerminal } from "./parser.js";

const exec = promisify(execFile);
const ORCA_START_TIMEOUT_MS = 45_000;
type OrcaScene = Extract<SceneReferenceV1, { backend: "orca" }>;
interface LaunchRecord { request: CreateSceneRequest; result?: CreateSceneResult }
export interface OrcaAdapterOptions {
  appPath: string;
  directory: string;
  run?: (args: string[], timeoutMs: number) => Promise<string>;
  detect?: () => Promise<BackendDetection>;
  open?: () => Promise<void>;
  launchApplication?: (profile?: string) => Promise<void>;
  processes?: ProcessInspector;
  environment?: NodeJS.ProcessEnv;
  shellEnvironment?: Record<string, string>;
  now?: () => Date;
  wait?: (ms: number) => Promise<void>;
}
export class OrcaAdapter implements SessionAdapter {
  readonly id = "orca" as const;
  private runtime?: RuntimeIdentity;
  private readonly processes: ProcessInspector;
  private detection?: { stamp: string; value: Promise<BackendDetection> };
  constructor(readonly options: OrcaAdapterOptions) {
    this.processes = options.processes ?? localProcesses;
  }
  private now() { return (this.options.now?.() ?? new Date()).toISOString(); }
  private async call(args: string[], timeoutMs = 5_000): Promise<OrcaEnvelope> {
    const command = [...args, "--environment", "local", "--json"];
    let raw: string;
    try {
      raw = this.options.run
        ? await this.options.run(command, timeoutMs)
        : (await exec(join(this.options.appPath, "Contents/Resources/bin/orca"), command, {
          timeout: timeoutMs, maxBuffer: 4_000_000, env: this.options.environment ?? process.env,
        })).stdout;
    } catch (error) {
      // Orca puts JSON failures on stdout, even with exit status 1.
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout === "string" && stdout.trim()) return orcaEnvelope(stdout);
      throw new OrcaCommandError("transport_unknown", "连接中断或超时；副作用未确认。", true);
    }
    return orcaEnvelope(raw);
  }
  async detect(): Promise<BackendDetection> {
    if (this.options.detect) return this.options.detect();
    const files = await Promise.all(["Info.plist", "Resources/bin/orca"].map(name =>
      stat(join(this.options.appPath, "Contents", name)).catch(() => undefined)));
    const stamp = files.map(file => file ? `${file.ino}:${file.size}:${file.mtimeMs}` : "missing").join("|");
    if (this.detection?.stamp === stamp) return this.detection.value;
    const value = detectOrcaApplication(this.options.appPath);
    this.detection = { stamp, value };
    return value;
  }
  private async status(): Promise<RuntimeIdentity> {
    const { result, runtimeId } = await this.call(["status"]);
    const runtime = record(result.runtime) ? result.runtime : {};
    const app = record(result.app) ? result.app : {};
    if (runtime.reachable !== true || !record(result.graph) || result.graph.state !== "ready" ||
      !runtimeId || runtimeId === "none" || runtime.runtimeId !== runtimeId)
      throw new SessionError("backend_unreachable", "Orca 本机运行时尚未就绪。");
    const capabilities = Array.isArray(runtime.capabilities) ? runtime.capabilities : [];
    for (const required of ["terminal.prompt-delivery.v1", "terminal.create-idempotency.v2", "workspace-selector.folder-match.v1"])
      if (!capabilities.includes(required))
        throw new SessionError("backend_incompatible", `Orca 缺少必要能力 ${required}。`);
    const process = Number.isSafeInteger(app.pid) ? await this.processes.identity(app.pid as number) : undefined;
    if (!process) throw new SessionError("backend_unverified", "无法核实本机 Orca 进程身份。");
    return {
      id: runtimeId, generation: `${runtimeId}:${process.bornAt}`, backend: "orca",
      version: string(runtime.appVersion, "Orca runtime version", 100), process,
    };
  }
  async connect(input: RuntimeConnection) {
    const detected = await this.detect();
    if (detected.status !== "compatible")
      throw new SessionError(detected.status === "missing" ? "backend_missing" :
        detected.status === "unverified" ? "backend_unverified" : "backend_incompatible", detected.detail ?? "Orca 尚未通过验证。");
    try { this.runtime = await this.status(); }
    catch (error) {
      if (!input.startIfMissing || !(error instanceof SessionError) || error.code !== "backend_unreachable") throw error;
      if (this.options.open) await this.options.open();
      else if (this.options.launchApplication)
        await this.options.launchApplication(this.options.environment?.ORCA_USER_DATA_PATH);
      else {
        const profile = this.options.environment?.ORCA_USER_DATA_PATH;
        // Launching the executable directly makes macOS route the request
        // through an already-running Orca instance. `open -n` creates the
        // requested instance while preserving its isolated user-data profile.
        await exec("/usr/bin/open", profile
          ? ["-na", this.options.appPath, "--args", `--user-data-dir=${profile}`]
          : ["-a", this.options.appPath], {
          timeout: 5_000,
          // LaunchServices carries this environment into the app. Keep the
          // app and subsequent CLI probes on the same explicit host HOME.
          env: this.options.environment ?? process.env,
        });
      }
      // The CLI probe can itself consume the 5 second command budget. A cold
      // Orca launch under load can take well over 15 seconds even though the
      // application has already written its runtime identity. Keep the same
      // verified readiness checks but allow enough time for several probes.
      const deadline = Date.now() + ORCA_START_TIMEOUT_MS;
      let lastError: unknown;
      do {
        try { this.runtime = await this.status(); break; }
        catch (error) {
          lastError = error;
          if (Date.now() >= deadline) {
            const reason = lastError instanceof Error ? lastError.message : String(lastError);
            throw new SessionError("backend_unreachable",
              `Orca 启动后 45 秒内仍不可达，请在 Orca 中完成首次启动或检查应用状态。最后状态：${reason}`);
          }
          await (this.options.wait ?? delay)(250);
        }
      } while (true);
    }
    if (this.runtime.version !== detected.version)
      throw new SessionError("backend_incompatible", "运行中的 Orca 与所选应用版本不同，请先完成更新并重新连接。");
    return this.runtime;
  }
  private current() {
    if (!this.runtime) throw new SessionError("backend_unreachable", "请先连接 Orca。");
    return this.runtime;
  }
  private assertScene(scene: SceneReferenceV1): asserts scene is OrcaScene {
    const runtime = this.current();
    if (scene.backend !== "orca" || scene.runtimeId !== runtime.id ||
      scene.runtimeGeneration !== runtime.generation)
      throw new SessionError("scene_identity_mismatch", "Orca 运行时或现场代次已经改变。");
  }
  private async matchingReceipt(input: CreateSceneRequest): Promise<LaunchReceipt | undefined> {
    const receipt = await readLaunchReceipt(input.receiptPath);
    if (!receipt) return;
    if (receipt.requestId !== input.requestId || receipt.installationId !== input.installationId ||
      receipt.bindingId !== input.bindingId || receipt.attemptId !== input.attemptId ||
      receipt.backendEpoch !== input.backendEpoch ||
      !await this.processes.alive(receiptProcess(receipt)))
      throw new SessionError("scene_identity_mismatch", "启动收据不属于当前请求或进程。");
    return receipt;
  }
  private async sceneFromReceipt(input: CreateSceneRequest): Promise<OrcaScene | undefined> {
    const receipt = await this.matchingReceipt(input);
    if (!receipt?.terminalHandle) return;
    const shown = await this.call(["terminal", "show", "--terminal", receipt.terminalHandle]);
    if (shown.runtimeId !== this.current().id) throw new SessionError("scene_identity_mismatch", "Orca 已在创建时重启。");
    const terminal = orcaTerminal(shown.result.terminal);
    // Orca marks a background terminal as orphaned when its renderer leaf is
    // not currently attached. The PTY, agent process and terminal handle stay
    // live, and the public send/focus commands deliberately reconnect that
    // leaf. Orphaned is therefore a presentation fact, not an identity or
    // reachability failure.
    if (!terminal.connected || terminal.executionHostId !== "local")
      throw new SessionError("scene_identity_mismatch", "终端执行身份不可核实。");
    const sep = terminal.worktreeId.indexOf("::");
    if (sep < 1 || terminal.worktreeId.slice(sep + 2) !== input.cwd)
      throw new SessionError("scene_identity_mismatch", "Orca 终端工作目录与启动请求不同。");
    return {
      version: 1, backend: "orca", installationId: input.installationId,
      runtimeId: this.current().id, runtimeGeneration: this.current().generation,
      bindingId: input.bindingId, attemptId: input.attemptId, backendEpoch: input.backendEpoch,
      process: receiptProcess(receipt),
      locator: {
        kind: "orca", repoId: terminal.worktreeId.slice(0, sep), worktreeId: terminal.worktreeId,
        terminalHandle: terminal.handle, executionHostId: terminal.executionHostId,
        incarnationId: terminal.incarnationId,
      },
    };
  }
  async create(input: CreateSceneRequest): Promise<CreateSceneResult> {
    this.current();
    const path = childPath(join(this.options.directory, "launches"), input.requestId);
    const existing = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as LaunchRecord | undefined;
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(input))
        throw new SessionError("scene_identity_mismatch", "启动请求 ID 的内容已经变化。");
      const found = await this.sceneFromReceipt(input).catch(() => undefined);
      if (found) return { status: "created", requestId: input.requestId, scene: found, recoveryId: input.requestId, mayHaveCreated: true };
      return existing.result ?? { status: "unknown", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true };
    }
    if (!await claimJSON(path, { request: input } satisfies LaunchRecord))
      return this.create(input);
    let attempted = false;
    try {
      let worktree: OrcaEnvelope;
      try { worktree = await this.call(["worktree", "show", "--worktree", `path:${input.cwd}`]); }
      catch (error) {
        if (!(error instanceof OrcaCommandError) || error.uncertain) throw error;
        if (!["not_found", "selector_not_found", "worktree_not_found", "no_current_worktree"].includes(error.code)) throw error;
        await this.call(["repo", "add", "--path", input.cwd, "--kind", "folder"]);
        worktree = await this.call(["worktree", "show", "--worktree", `path:${input.cwd}`]);
      }
      const data = worktree.result.worktree;
      if (!record(data) || data.path !== input.cwd) throw new SessionError("scene_identity_mismatch", "Orca 未找到精确的文件夹工作区。");
      const worktreeId = string(data.id, "worktree id");
      attempted = true;
      // This public CLI has no create retry ID. Persist intent first and never
      // replay after response loss. The launcher's own handle enables recovery.
      try {
        await this.call(["terminal", "create", "--worktree", worktreeId, "--title", input.title, "--command", launcherCommand(input.launcherPath, this.options.shellEnvironment)], 20_000);
      } catch (error) {
        if (!(error instanceof OrcaCommandError) || !error.uncertain) throw error;
      }
      const deadline = Date.now() + 5_000;
      let scene: OrcaScene | undefined;
      do {
        scene = await this.sceneFromReceipt(input);
        if (scene || Date.now() >= deadline) break;
        await (this.options.wait ?? delay)(100);
      } while (true);
      const result: CreateSceneResult = {
        status: scene ? "created" : "unknown", requestId: input.requestId,
        recoveryId: input.requestId, mayHaveCreated: true, ...(scene ? { scene } : { detail: "环境回执未确认，请核对已有现场；没有重复创建。" }),
      };
      await atomicJSON(path, { request: input, result } satisfies LaunchRecord);
      return result;
    } catch (error) {
      const uncertain = attempted && !(error instanceof OrcaCommandError && !error.uncertain);
      const result: CreateSceneResult = {
        status: uncertain ? "unknown" : "rejected", requestId: input.requestId, recoveryId: input.requestId,
        mayHaveCreated: uncertain, detail: error instanceof Error ? error.message : String(error),
      };
      await atomicJSON(path, { request: input, result } satisfies LaunchRecord);
      return result;
    }
  }
  private matches(scene: OrcaScene, terminal: OrcaTerminal) {
    return terminal.handle === scene.locator.terminalHandle && terminal.worktreeId === scene.locator.worktreeId &&
      terminal.incarnationId === scene.locator.incarnationId && terminal.executionHostId === scene.locator.executionHostId;
  }
  async inspectMany(scenes: SceneReferenceV1[]): Promise<SceneObservation[]> {
    if (!scenes.length) return [];
    const base = (scene: SceneReferenceV1): SceneObservation => ({
      bindingId: scene.bindingId, identity: "unverifiable", reachable: false,
      state: "unknown", observedAt: this.now(), source: "backend",
    });
    let runtime: RuntimeIdentity, terminals: OrcaTerminal[], programs: ReturnType<typeof orcaPrograms>, hostCovered = false;
    try {
      runtime = await this.status();
      const [listing, rows] = await Promise.all([this.call(["terminal", "list"]), this.call(["worktree", "ps"])]);
      if (listing.runtimeId !== runtime.id || rows.runtimeId !== runtime.id)
        throw new SessionError("scene_identity_mismatch", "Orca 采集期间发生重启。");
      if (!Array.isArray(listing.result.terminals)) throw new Error("终端列表缺失。");
      terminals = listing.result.terminals.map(orcaTerminal);
      const scope = listing.result.hostScope;
      hostCovered = record(scope) && Array.isArray(scope.hostIds) && scope.hostIds.includes("local") &&
        Array.isArray(scope.omittedHostIds) && !scope.omittedHostIds.includes("local") &&
        listing.result.truncated === false;
      programs = orcaPrograms(rows.result.worktrees);
      // Need pane keys only, never retain previews in the observation cache.
      for (let i = 0; i < terminals.length; i++)
        terminals[i]!.paneKey ??= terminalPaneKey(listing.result.terminals[i]);
    } catch (error) {
      return scenes.map(scene => ({ ...base(scene), detail: error instanceof Error ? error.message : String(error) }));
    }
    return Promise.all(scenes.map(async scene => {
      const observation = base(scene);
      if (scene.backend !== "orca" || scene.runtimeId !== runtime.id || scene.runtimeGeneration !== runtime.generation)
        return { ...observation, identity: "mismatch" as const };
      const terminal = terminals.find(candidate => candidate.handle === scene.locator.terminalHandle);
      if (!terminal)
        return { ...observation, identity: hostCovered ? "match" as const : "unverifiable" as const,
          state: hostCovered && scene.process && !await this.processes.alive(scene.process) ? "exited" as const : "unknown" as const };
      if (!this.matches(scene, terminal)) return { ...observation, identity: "mismatch" as const };
      const alive = scene.process && await this.processes.alive(scene.process);
      if (!alive) return { ...observation, identity: "match" as const, state: "exited" as const };
      const state = programs.find(program => program.paneKey === terminal.paneKey)?.state ?? "unknown";
      return {
        ...observation, identity: "match" as const,
        reachable: terminal.connected && terminal.writable, state,
      };
    }));
  }
  async inspect(scene: SceneReferenceV1) { return (await this.inspectMany([scene]))[0]!; }
  async send(input: SendSceneRequest): Promise<SendReceipt> {
    this.assertScene(input.scene);
    if (createHash("sha256").update(input.text).digest("hex") !== input.payloadSha256)
      throw new SessionError("scene_identity_mismatch", "投递正文摘要不匹配。");
    const path = childPath(join(this.options.directory, "deliveries"), input.deliveryId);
    const previous = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    if (previous) {
      if (previous.payloadSha256 !== input.payloadSha256 || previous.scene.bindingId !== input.scene.bindingId)
        throw new SessionError("scene_identity_mismatch", "投递 ID 不能更换正文或现场。");
      if (!input.retry) return previous;
      if (!previous.upstreamRequestId || input.retry.requestId !== previous.upstreamRequestId ||
        input.retry.payloadSha256 !== input.payloadSha256 ||
        input.retry.incarnationId !== input.scene.locator.incarnationId)
        throw new SessionError("scene_identity_mismatch", "安全重试必须使用原请求和进程代次。");
    } else if (input.retry) throw new SessionError("scene_identity_mismatch", "没有原投递记录，不能重试。");
    const receipt: SendReceipt = {
      status: "unknown", deliveryId: input.deliveryId, payloadSha256: input.payloadSha256, scene: input.scene, at: this.now(),
    };
    if (!previous && !await claimJSON(path, receipt)) return this.send(input);
    const observation = await this.inspect(input.scene);
    const processAlive = Boolean(input.scene.process && await this.processes.alive(input.scene.process));
    const processHasChild = processAlive && input.scene.process
      ? await this.processes.hasChild(input.scene.process)
      : false;
    if (observation.identity !== "match" || !observation.reachable || ["blocked", "working"].includes(observation.state) ||
      observation.state === "exited" || !processAlive || !processHasChild) {
      const reasons = [
        observation.identity !== "match" ? `现场身份=${observation.identity}` : "",
        !observation.reachable ? "终端不可达" : "",
        ["blocked", "working"].includes(observation.state) ? `Agent 状态=${observation.state}` : "",
        observation.state === "exited" ? "Agent 已退出" : "",
        !processAlive ? "启动进程不存在" : "",
        processAlive && !processHasChild ? "未发现前台 Agent 子进程" : "",
      ].filter(Boolean);
      receipt.status = "rejected";
      receipt.detail = `负责人现场暂不可投递：${reasons.join("；") || "运行时状态未确认"}。没有发送。`;
      await atomicJSON(path, receipt);
      return receipt;
    }
    await atomicJSON(path, receipt);
    try {
      const sent = await this.call(["terminal", "send", "--terminal", input.scene.locator.terminalHandle,
        "--text", input.text, "--enter", "--wait-submit", "5",
        ...(input.retry ? ["--retry-request", input.retry.requestId] : [])], 12_000);
      if (sent.runtimeId !== input.scene.runtimeId) throw new SessionError("scene_identity_mismatch", "投递期间 Orca 已重启。");
      const data = sent.result.send;
      if (!record(data) || data.handle !== input.scene.locator.terminalHandle || typeof data.accepted !== "boolean")
        throw new Error("投递回执无效。");
      const prompt = record(data.prompt) ? data.prompt : undefined;
      if (prompt?.processIncarnation && prompt.processIncarnation !== input.scene.locator.incarnationId)
        throw new SessionError("scene_identity_mismatch", "投递回执属于另一个进程代次。");
      receipt.status = data.accepted ? (Array.isArray(prompt?.stages) && prompt.stages.includes("turn_started") ? "started" : "accepted") : "rejected";
      if (typeof prompt?.requestId === "string") receipt.upstreamRequestId = prompt.requestId;
      // Orca's durable prompt observer supports only some CLIs. Its generic
      // lifecycle projection also supports OMP. An identity-bound idle→working
      // observation proves a turn started without retyping the accepted input.
      if (receipt.status === "accepted" && observation.state === "idle" && prompt?.observation === "unsupported") {
        const deadline = Date.now() + 5_000;
        do {
          const next = await this.inspect(input.scene);
          if (next.identity !== "match" || !next.reachable || next.state === "blocked") break;
          if (next.state === "working") { receipt.status = "started"; break; }
          if (Date.now() >= deadline) break;
          await (this.options.wait ?? delay)(200);
        } while (true);
      }
    } catch (error) {
      receipt.detail = error instanceof Error ? error.message : String(error);
      if (error instanceof OrcaCommandError && !error.uncertain) receipt.status = "rejected";
    }
    await atomicJSON(path, receipt);
    return receipt;
  }
  async focus(scene: SceneReferenceV1): Promise<FocusResult> {
    this.assertScene(scene);
    const deadline = Date.now() + 3_000;
    let lastDetail = "现场终端尚未连接。";
    for (;;) {
      try {
        const shown = await this.call(["terminal", "show", "--terminal", scene.locator.terminalHandle]);
        if (shown.runtimeId !== scene.runtimeId)
          return { status: "missing", navigated: false, detail: "聚焦期间 Orca 已重启；没有创建替代终端。" };
        const terminal = orcaTerminal(shown.result.terminal);
        if (!this.matches(scene, terminal))
          return { status: "missing", navigated: false, detail: "未能核实原现场；没有创建新终端。" };
        // "Writable" is required before typing, but a working Agent may still
        // be visible and focusable. Only the identity-bound terminal and its
        // connection are prerequisites for native navigation.
        if (!terminal.connected) {
          lastDetail = "现场终端仍在连接，正在重试聚焦。";
        } else {
          // A background leaf can be orphaned while its PTY remains live.
          // terminal switch reattaches that exact leaf, so orphaned must not
          // prevent the user from returning to the scene.
          const focused = await this.call(["terminal", "switch", "--terminal", scene.locator.terminalHandle]);
          if (focused.runtimeId !== scene.runtimeId)
            return { status: "missing", navigated: false, detail: "聚焦期间 Orca 已重启；没有创建替代终端。" };
          if (record(focused.result.focus) && focused.result.focus.navigated === true)
            return { status: "focused", navigated: true };
          lastDetail = "Orca 未确认精确导航。";
        }
      } catch (error) {
        if (error instanceof SessionError) throw error;
        lastDetail = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline)
        return { status: "missing", navigated: false, detail: `${lastDetail} 没有创建替代终端。` };
      await (this.options.wait ?? delay)(100);
    }
  }
  async close(scene: SceneReferenceV1): Promise<CloseReceipt> {
    this.assertScene(scene);
    const receipt: CloseReceipt = { status: "unknown", bindingId: scene.bindingId, at: this.now(), identityVerified: false };
    const observation = await this.inspect(scene);
    if (observation.identity !== "match") return { ...receipt, detail: "现场身份未确认，未关闭。" };
    receipt.identityVerified = true;
    if (observation.state === "exited" && scene.process && !await this.processes.alive(scene.process))
      return { ...receipt, status: "already_stopped" };
    try {
      const closed = await this.call(["terminal", "close", "--terminal", scene.locator.terminalHandle], 15_000);
      if (closed.runtimeId !== scene.runtimeId || !record(closed.result.close) || closed.result.close.ptyKilled !== true)
        return { ...receipt, detail: "Orca 未提供可确认的进程停止回执。" };
      await (this.options.wait ?? delay)(200);
      if (!scene.process || await this.processes.alive(scene.process))
        return { ...receipt, detail: "旧进程仍存活或无法确认，交接保持冻结。" };
      return { ...receipt, status: "stopped" };
    } catch (error) { return { ...receipt, detail: error instanceof Error ? error.message : String(error) }; }
  }
  async discover(query: OwnedSceneQuery): Promise<OwnedSceneMatch[]> {
    if (query.runtimeId !== this.current().id) return [];
    const directory = join(this.options.directory, "launches");
    const files = query.requestId ? [childPath(directory, query.requestId)] :
      (await readdir(directory).catch(() => [])).filter(file => file.endsWith(".json")).map(file => join(directory, file));
    const found: OwnedSceneMatch[] = [];
    for (const path of files) {
      const value = await readJSON(path) as LaunchRecord;
      if (value.request.installationId !== query.installationId ||
        query.bindingId && value.request.bindingId !== query.bindingId) continue;
      const scene = await this.sceneFromReceipt(value.request).catch(() => undefined);
      if (scene && (!value.result?.scene || (value.result.scene.backend === "orca" &&
        value.result.scene.locator.incarnationId === scene.locator.incarnationId)))
        found.push({ requestId: value.request.requestId, scene });
    }
    return found;
  }
  async captureResume(_scene: SceneReferenceV1): Promise<AgentResumeResult> {
    return { status: "unsupported", detail: "使用目标记录继续；尚未验证 Orca 终端原生 Agent 会话恢复。" };
  }
}
