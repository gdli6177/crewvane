import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { SceneReferenceV1 } from "../../../core/src/index.js";
import {
  SessionError, type AgentResumeResult, type BackendDetection, type CloseReceipt,
  type CreateSceneRequest, type CreateSceneResult, type FocusResult, type OwnedSceneMatch,
  type OwnedSceneQuery, type RuntimeConnection, type RuntimeIdentity, type SceneObservation,
  type SendReceipt, type SendSceneRequest, type SessionAdapter,
} from "../contracts.js";
import { atomicJSON, childPath, claimJSON, privateDirectory, readJSON, record, string } from "../io.js";
import { launcherCommand, readLaunchReceipt, receiptProcess } from "../launcher.js";
import { localProcesses, type ProcessInspector } from "../process.js";
import { withControlLock } from "../control/lock.js";
import { startDetachedHerdrServer } from "./server.js";

const exec = promisify(execFile);
type HerdrScene = Extract<SceneReferenceV1, { backend: "herdr" }>;
interface LaunchRecord { request: CreateSceneRequest; result?: CreateSceneResult }
export interface HerdrAdapterOptions {
  executable: string;
  session: string;
  directory: string;
  environment?: NodeJS.ProcessEnv;
  shellEnvironment?: Record<string, string>;
  run?(args: string[], timeout?: number): Promise<string>;
  start?(): Promise<void>;
  processes?: ProcessInspector;
  socketIdentity?(path: string): Promise<string>;
}
const capabilities = { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: true };
function result(raw: string) {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new Error("Herdr 未返回完整 JSON，结果未确认。"); }
  if (!record(data) || data.error) throw new Error("Herdr 返回未知或错误结果。");
  return record(data.result) ? data.result : data;
}
function list(value: unknown, name: string) {
  if (!Array.isArray(value) || !value.every(record)) throw new Error(`Herdr 缺少 ${name} 列表。`);
  return value;
}
function agentFamily(agent: Record<string, unknown>) {
  return String(agent.agent_kind ?? agent.agent ?? "").trim().toLowerCase();
}
function deliveryFailure(error: unknown) {
  const source = error instanceof Error ? error.message : String(error);
  // Herdr command errors can contain the complete argv, including the user's
  // prompt. Receipts are durable diagnostics, so keep only a bounded,
  // whitelisted interpretation and never copy the command text.
  if (/agent_prompt_stalled/i.test(source))
    return {
      status: "accepted" as const,
      detail: "agent_prompt_stalled: Herdr 已接受本次输入，但未及时观察到 working；不会自动重发。",
    };
  if (/agent_blocked|requires interactive|等待交互/i.test(source))
    return {
      status: "rejected" as const,
      detail: "agent_blocked: Agent 正在等待交互输入；本次输入未发送，请先到原现场处理。",
    };
  if (/agent_not_found|agent target .* not found/i.test(source))
    return {
      status: "rejected" as const,
      detail: "agent_not_found: 目标 Agent 已不可达；本次输入未发送。",
    };
  if (/timeout|timed out/i.test(source))
    return {
      status: "unknown" as const,
      detail: "timeout: Herdr 投递结果确认超时；已保留原请求，不会自动重发。",
    };
  return {
    status: "unknown" as const,
    detail: "delivery_unknown: Herdr 投递失败或结果未确认；已隐藏命令正文，不会自动重发。",
  };
}
export class HerdrAdapter implements SessionAdapter {
  readonly id = "herdr" as const;
  private runtime?: RuntimeIdentity;
  private readonly processes: ProcessInspector;
  constructor(readonly options: HerdrAdapterOptions) { this.processes = options.processes ?? localProcesses; }
  private now() { return new Date().toISOString(); }
  private async raw(args: string[], timeout = 5_000) {
    return this.options.run ? this.options.run(args, timeout) :
      (await exec(this.options.executable, ["--session", this.options.session, ...args], {
        timeout, maxBuffer: 2_000_000,
        env: { ...(this.options.environment ?? process.env), HERDR_SESSION: this.options.session },
      })).stdout;
  }
  private async call(args: string[], timeout?: number) { return result(await this.raw(args, timeout)); }
  async detect(): Promise<BackendDetection> {
    try {
      const text = await this.raw(["--version"]);
      const version = /^herdr\s+v?(\d+\.\d+\.\d+)/.exec(text.trim())?.[1];
      if (!version) throw new Error("无法核实 Herdr CLI 版本。");
      return { id: this.id, status: "compatible", version, path: this.options.executable, capabilities };
    } catch (error) {
      return { id: this.id, status: "missing", capabilities,
        detail: error instanceof Error ? error.message : String(error) };
    }
  }
  private async identity(): Promise<RuntimeIdentity> {
    const data = await this.call(["status", "--json"]);
    if (!record(data.server) || data.server.running !== true)
      throw new SessionError("backend_unreachable", "Herdr 当前 Session 未运行。");
    if (data.server.compatible !== true || data.server.session !== this.options.session)
      throw new SessionError("backend_incompatible", "Herdr Session 或协议版本不匹配。");
    const socket = string(data.server.socket, "Herdr socket");
    const identity = this.options.socketIdentity ? await this.options.socketIdentity(socket) : await lstat(socket).then(info => {
      if (!info.isSocket() || process.getuid && info.uid !== process.getuid())
        throw new Error("Herdr Socket 不属于当前用户或不是本机 Socket。");
      return `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    });
    return {
      backend: "herdr", id: socket, generation: `${socket}:${identity}`,
      version: string(data.server.version, "Herdr version", 100),
    };
  }
  async connect(input: RuntimeConnection) {
    try { this.runtime = await this.identity(); }
    catch (error) {
      if (!input.startIfMissing || !(error instanceof SessionError) || error.code !== "backend_unreachable") throw error;
      await withControlLock(join(this.options.directory, "server-start"), async () => {
        try { this.runtime = await this.identity(); return; }
        catch (current) {
          if (!(current instanceof SessionError) || current.code !== "backend_unreachable") throw current;
        }
        if (this.options.start) await this.options.start();
        else startDetachedHerdrServer(this.options.executable, this.options.session, input.cwd,
          this.options.environment ?? process.env);
      });
      const deadline = Date.now() + 15_000;
      for (;;) {
        try { this.runtime = await this.identity(); return this.runtime; }
        catch (current) {
          if (Date.now() >= deadline) throw current;
          await delay(100);
        }
      }
    }
    return this.runtime;
  }
  private current() {
    if (!this.runtime) throw new SessionError("backend_unreachable", "请先连接 Herdr。");
    return this.runtime;
  }
  private matchesRuntime(scene: SceneReferenceV1, runtime = this.current()): scene is HerdrScene {
    return scene.backend === "herdr" && scene.runtimeId === runtime.id && scene.runtimeGeneration === runtime.generation &&
      scene.locator.session === this.options.session;
  }
  private async fromReceipt(input: CreateSceneRequest): Promise<HerdrScene | undefined> {
    const receipt = await readLaunchReceipt(input.receiptPath);
    if (!receipt?.herdr) return;
    if (receipt.requestId !== input.requestId || receipt.bindingId !== input.bindingId ||
      receipt.installationId !== input.installationId || receipt.attemptId !== input.attemptId ||
      receipt.backendEpoch !== input.backendEpoch || receipt.herdr.session !== this.options.session ||
      !await this.processes.alive(receiptProcess(receipt))) throw new SessionError("scene_identity_mismatch", "Herdr 启动收据不匹配。");
    const runtime = await this.identity();
    if (runtime.generation !== this.current().generation) throw new SessionError("scene_identity_mismatch", "Herdr 启动时发生重启。");
    const panes = list((await this.call(["pane", "list", "--workspace", receipt.herdr.workspaceId])).panes, "Pane");
    const pane = panes.find(item => (item.pane_id ?? item.id) === receipt.herdr!.paneId);
    if (!pane || pane.tab_id !== receipt.herdr.tabId) throw new SessionError("scene_identity_mismatch", "Herdr 现场已改变。");
    const agent = list((await this.call(["agent", "list"])).agents, "Agent")
      .find(item => item.pane_id === receipt.herdr!.paneId);
    return {
      version: 1, backend: "herdr", installationId: input.installationId,
      runtimeId: runtime.id, runtimeGeneration: runtime.generation,
      bindingId: input.bindingId, attemptId: input.attemptId, backendEpoch: input.backendEpoch,
      process: receiptProcess(receipt), locator: {
        kind: "herdr", ...receipt.herdr, transport: "pane",
        ...(typeof agent?.name === "string" ? { agent: agent.name } : {}),
      },
    };
  }
  async create(input: CreateSceneRequest): Promise<CreateSceneResult> {
    this.current();
    const path = childPath(join(this.options.directory, "launches"), input.requestId);
    const previous = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as LaunchRecord | undefined;
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(input)) throw new SessionError("scene_identity_mismatch", "启动 ID 内容已变化。");
      const scene = await this.fromReceipt(input).catch(() => undefined);
      return scene ? { status: "created", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true, scene } :
        previous.result ?? { status: "unknown", requestId: input.requestId, recoveryId: input.requestId, mayHaveCreated: true };
    }
    if (!await claimJSON(path, { request: input })) return this.create(input);
    let attempted = false;
    try {
      const workspaces = list((await this.call(["workspace", "list"])).workspaces, "Workspace");
      attempted = true;
      const created = await this.call(workspaces.length
        ? ["tab", "create", "--workspace", string(workspaces[0]!.workspace_id ?? workspaces[0]!.id, "Workspace id"),
          "--cwd", input.cwd, "--label", input.title, "--no-focus",
          ...Object.entries(this.options.shellEnvironment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])]
        : ["workspace", "create", "--cwd", input.cwd, "--label", input.title, "--no-focus",
        ...Object.entries(this.options.shellEnvironment ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`])], 15_000);
      const pane = record(created.root_pane) ? created.root_pane : undefined;
      const paneId = string(pane?.pane_id, "Pane id");
      const command = launcherCommand(input.launcherPath);
      if (Buffer.byteLength(command) > 768) throw new Error("启动器路径过长，未发送命令。");
      // Herdr 0.9.5's input commands acknowledge through exit status and have
      // no stdout JSON. A successful write is still only acceptance.
      await this.raw(["pane", "run", paneId, command], 5_000);
      let scene: HerdrScene | undefined;
      const deadline = Date.now() + 8_000;
      do {
        scene = await this.fromReceipt(input);
        if (scene || Date.now() >= deadline) break;
        await delay(100);
      } while (true);
      const result: CreateSceneResult = {
        status: scene ? "created" : "unknown", requestId: input.requestId, recoveryId: input.requestId,
        mayHaveCreated: true, ...(scene ? { scene } : { detail: "启动环境未确认，请核对原现场；未重复创建。" }),
      };
      await atomicJSON(path, { request: input, result });
      return result;
    } catch (error) {
      const result: CreateSceneResult = {
        status: attempted ? "unknown" : "rejected", requestId: input.requestId, recoveryId: input.requestId,
        mayHaveCreated: attempted, detail: error instanceof Error ? error.message : String(error),
      };
      await atomicJSON(path, { request: input, result });
      return result;
    }
  }
  async inspectMany(scenes: SceneReferenceV1[]): Promise<SceneObservation[]> {
    if (!scenes.length) return [];
    const base = (scene: SceneReferenceV1): SceneObservation => ({
      bindingId: scene.bindingId, identity: "unverifiable", reachable: false, state: "unknown",
      observedAt: this.now(), source: "backend",
    });
    try {
      const runtime = await this.identity();
      const agents = list((await this.call(["agent", "list"])).agents, "Agent");
      const workspaceIds = [...new Set(scenes.flatMap(scene => scene.backend === "herdr" ? [scene.locator.workspaceId] : []))];
      const groups = await Promise.all(workspaceIds.map(async workspace => list((await this.call(["pane", "list", "--workspace", workspace])).panes, "Pane")));
      const panes = groups.flat();
      return Promise.all(scenes.map(async scene => {
        const observation = base(scene);
        if (!this.matchesRuntime(scene, runtime)) return { ...observation, identity: "mismatch" as const };
        const alive = scene.process && await this.processes.alive(scene.process);
        const pane = panes.find(item => item.pane_id === scene.locator.paneId);
        if (!alive) return { ...observation, identity: "match" as const, state: "exited" as const };
        if (!pane || pane.tab_id !== scene.locator.tabId) return { ...observation, identity: "mismatch" as const };
        const agent = agents.find(item => item.pane_id === scene.locator.paneId);
        const value = agent?.agent_status;
        const spinner = value === "idle" &&
          /[\u2800-\u28ff]/u.test(String(agent?.terminal_title_stripped ?? agent?.terminal_title ?? ""));
        const state = value === "blocked" ? "blocked" as const : value === "working" || spinner ? "working" as const :
          value === "idle" || value === "done" ? "idle" as const : "unknown" as const;
        return { ...observation, identity: "match" as const, reachable: true, state };
      }));
    } catch (error) {
      return scenes.map(scene => ({ ...base(scene), detail: error instanceof Error ? error.message : String(error) }));
    }
  }
  async inspect(scene: SceneReferenceV1) { return (await this.inspectMany([scene]))[0]!; }
  async send(input: SendSceneRequest): Promise<SendReceipt> {
    if (createHash("sha256").update(input.text).digest("hex") !== input.payloadSha256) throw new Error("投递摘要不匹配。");
    const path = childPath(join(this.options.directory, "deliveries"), input.deliveryId);
    const previous = await readJSON(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }) as SendReceipt | undefined;
    if (previous) {
      if (previous.payloadSha256 !== input.payloadSha256 || previous.scene.bindingId !== input.scene.bindingId)
        throw new SessionError("scene_identity_mismatch", "同一投递 ID 不得更换内容或现场。");
      return previous;
    }
    const receipt: SendReceipt = { status: "unknown", deliveryId: input.deliveryId, scene: input.scene, payloadSha256: input.payloadSha256, at: this.now() };
    if (!await claimJSON(path, receipt)) return this.send(input);
    const scene = input.scene, observation = await this.inspect(scene);
    if (!this.matchesRuntime(scene) || observation.identity !== "match" || !observation.reachable ||
      ["blocked", "working", "exited"].includes(observation.state) || !scene.process ||
      !await this.processes.hasChild(scene.process)) {
      receipt.status = "rejected"; receipt.detail = "现场身份、空闲或前台 Agent 无法确认，未发送。";
    } else {
      try {
        const agents = list((await this.call(["agent", "list"])).agents, "Agent");
        const agent = agents.find(item => item.pane_id === scene.locator.paneId);
        if (agent) {
          // OMP 18.15 can intercept marker-sized pastes (>10 lines or >1000
          // UTF-16 code units) with an attachment/menu flow. It is not a byte
          // threshold: a case below 12 KB can still be left as a draft. Do
          // not press Enter again or split one logical task into several
          // turns. Hand it a short, bounded reference to the exact private
          // payload instead; its original receipt still hashes the full text.
          let prompt = input.text;
          if (agentFamily(agent) === "omp" &&
            (input.text.length > 1_000 || input.text.split("\n").length > 10)) {
            const directory = await privateDirectory(join(this.options.directory, "payloads"));
            const path = `${childPath(directory, input.deliveryId)}.txt`;
            await writeFile(path, input.text, { mode: 0o600, flag: "wx" });
            prompt = `这是 Crewvane 的一次受管消息投递，不是 shell 命令。请先用文件读取工具完整读取 ${path}，再按其中的角色、案卷和 Crewvane CLI 协议执行。不要只回复已读。投递 ID：${input.deliveryId}；正文 SHA-256：${input.payloadSha256}。`;
          }
          await this.raw(["agent", "prompt", scene.locator.paneId, prompt, "--wait", "--until", "working", "--timeout", "10000"], 12_000);
          receipt.status = "started";
        } else {
          await this.raw(["pane", "run", scene.locator.paneId, input.text], 5_000);
          receipt.status = "accepted";
        }
      } catch (error) {
        const failure = deliveryFailure(error);
        receipt.status = failure.status;
        receipt.detail = failure.detail;
      }
    }
    await atomicJSON(path, receipt);
    return receipt;
  }
  async focus(scene: SceneReferenceV1): Promise<FocusResult> {
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" || !observation.reachable)
      return { status: "missing", navigated: false, detail: "未能核实原现场。" };
    try {
      await this.raw(["tab", "focus", scene.locator.tabId]);
      let panes = list((await this.call(["pane", "list", "--workspace", scene.locator.workspaceId])).panes, "Pane");
      if (!panes.some(pane => pane.pane_id === scene.locator.paneId && pane.focused === true)) {
        const agents = list((await this.call(["agent", "list"])).agents, "Agent");
        if (agents.some(agent => agent.pane_id === scene.locator.paneId)) {
          await this.raw(["agent", "focus", scene.locator.paneId]);
          panes = list((await this.call(["pane", "list", "--workspace", scene.locator.workspaceId])).panes, "Pane");
        }
      }
      const focused = panes.some(pane => pane.pane_id === scene.locator.paneId && pane.focused === true);
      return focused ? { status: "focused", navigated: true } :
        { status: "failed", navigated: false, detail: "Herdr 未确认聚焦目标 Pane。" };
    } catch (error) { return { status: "failed", navigated: false, detail: String(error) }; }
  }
  async close(scene: SceneReferenceV1): Promise<CloseReceipt> {
    const receipt: CloseReceipt = { status: "unknown", bindingId: scene.bindingId, at: this.now(), identityVerified: false };
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" || !scene.process) return receipt;
    receipt.identityVerified = true;
    if (observation.state === "exited" && !await this.processes.alive(scene.process)) return { ...receipt, status: "already_stopped" };
    try {
      // The user may have split another pane in this tab. Close only the
      // verified managed pane; Herdr owns empty-tab cleanup.
      await this.raw(["pane", "close", scene.locator.paneId], 10_000);
      const deadline = Date.now() + 3_000;
      while (await this.processes.alive(scene.process) && Date.now() < deadline) await delay(100);
      if (!await this.processes.alive(scene.process)) return { ...receipt, status: "stopped" };
    } catch (error) { receipt.detail = String(error); }
    return receipt;
  }
  async discover(query: OwnedSceneQuery): Promise<OwnedSceneMatch[]> {
    if (query.runtimeId !== this.current().id) return [];
    const directory = join(this.options.directory, "launches");
    const paths = query.requestId ? [childPath(directory, query.requestId)] :
      (await readdir(directory).catch(() => [])).filter(file => file.endsWith(".json")).map(file => join(directory, file));
    const matches: OwnedSceneMatch[] = [];
    for (const path of paths) {
      const value = await readJSON(path) as LaunchRecord;
      if (value.request.installationId !== query.installationId || query.bindingId && value.request.bindingId !== query.bindingId) continue;
      const scene = await this.fromReceipt(value.request).catch(() => undefined);
      if (scene) matches.push({ requestId: value.request.requestId, scene });
    }
    return matches;
  }
  async captureResume(scene: SceneReferenceV1): Promise<AgentResumeResult> {
    const observation = await this.inspect(scene);
    if (scene.backend !== "herdr" || observation.identity !== "match" || !observation.reachable)
      return { status: "unknown", detail: "未能核实原负责人现场，未捕获原生会话身份。" };
    const live = list((await this.call(["agent", "list"])).agents, "Agent")
      .find(item => item.pane_id === scene.locator.paneId);
    if (!live) return { status: "unsupported", detail: "原负责人不是可恢复的受管 Agent。" };
    const raw = live.agent_session;
    if (!record(raw)) return { status: "unsupported", detail: "Agent 未提供原生会话身份。" };
    const source = typeof raw.source === "string" ? raw.source : undefined;
    const agent = typeof raw.agent === "string" ? raw.agent : undefined;
    const value = typeof raw.value === "string" ? raw.value : undefined;
    const kind = raw.kind === "id" || raw.kind === "path" ? raw.kind : undefined;
    if (!source || !agent || !value || !kind || value.length > 4_096)
      return { status: "unknown", detail: "Agent 原生会话身份不完整，不能安全恢复。" };
    return { status: "supported", agent, kind, value };
  }
}
