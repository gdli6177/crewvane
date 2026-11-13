import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import parseArgsStringToArgv from "string-argv";
import type { AgentRuntimeAdapterId } from "../../../packages/core/src/types.js";
import { withLock } from "../../../packages/core/src/storage.js";

const exec = promisify(execFile);
const manifestVersion = 1;
const managedRevision = 1;
const marker = "hook ingest --adapter";
const supported = ["codex", "claude-code", "cursor", "qoder", "omp"] as const;
export type ManagedAdapterId = typeof supported[number];

interface AdapterDefinition {
  id: ManagedAdapterId;
  label: string;
  commands: string[];
  events: string[];
}

const definitions: Record<ManagedAdapterId, AdapterDefinition> = {
  codex: {
    id: "codex", label: "Codex", commands: ["codex"],
    events: ["SessionStart", "UserPromptSubmit", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"],
  },
  "claude-code": {
    id: "claude-code", label: "Claude Code", commands: ["claude"],
    events: ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"],
  },
  cursor: {
    id: "cursor", label: "Cursor", commands: ["cursor-agent", "cursor"],
    events: ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"],
  },
  qoder: {
    id: "qoder", label: "Qoder", commands: ["qodercli", "qoder"],
    events: ["SessionStart", "UserPromptSubmit", "Notification", "PermissionRequest", "Stop", "SessionEnd"],
  },
  omp: {
    id: "omp", label: "OMP", commands: ["omp"],
    events: ["session.started", "turn.started", "agent.response", "agent.blocked", "turn.settled", "session.ended"],
  },
};

export type HookInstallStatus =
  | "not-installed"
  | "installed"
  | "waiting-trust"
  | "disabled"
  | "unsupported"
  | "conflict"
  | "error";

export interface AgentHookAdapterStatus {
  id: ManagedAdapterId;
  label: string;
  command?: string;
  version?: string;
  enabled: boolean;
  installed: boolean;
  status: HookInstallStatus;
  events: string[];
  configPath: string;
  detail?: string;
  lastEventAt?: string;
}

interface ManifestAdapter {
  enabled: boolean;
  installed: boolean;
  waitingTrust: boolean;
  version?: string;
  detail?: string;
  lastEventAt?: string;
  managedRevision?: number;
}

interface Manifest {
  version: 1;
  adapters: Partial<Record<ManagedAdapterId, ManifestAdapter>>;
}

export interface AgentHookManagerOptions {
  home?: string;
  userData: string;
  commandPath?: (command: string) => Promise<string | undefined>;
  version?: (path: string) => Promise<string>;
  now?: () => Date;
}

function jsonRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function parseConfig(body: string) {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Agent 配置根节点必须是 JSON 对象");
  return parsed as Record<string, any>;
}

function groupedHookSchemaProblem(
  config: Record<string, any>,
  definition: AdapterDefinition,
) {
  if (config.hooks === undefined) return;
  if (!config.hooks || typeof config.hooks !== "object" ||
    Array.isArray(config.hooks))
    return "hooks 必须是对象";
  for (const event of definition.events) {
    const groups = config.hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) return `${event} 必须是数组`;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group))
        return `${event} 包含无效条目`;
      if (group.hooks !== undefined && !Array.isArray(group.hooks))
        return `${event}.hooks 必须是数组`;
    }
  }
}

function cursorHookSchemaProblem(
  config: Record<string, any>,
  definition: AdapterDefinition,
) {
  if (config.version !== undefined &&
    String(config.version).trim() !== "1")
    return `配置版本 ${String(config.version)} 高于当前支持的 v1`;
  if (config.hooks === undefined) return;
  if (!config.hooks || typeof config.hooks !== "object" ||
    Array.isArray(config.hooks))
    return "hooks 必须是对象";
  for (const event of definition.events) {
    const handlers = config.hooks[event];
    if (handlers !== undefined && !Array.isArray(handlers))
      return `${event} 必须是数组`;
    if (Array.isArray(handlers) && handlers.some(handler =>
      !handler || typeof handler !== "object" || Array.isArray(handler)))
      return `${event} 包含无效条目`;
  }
}

function hookSchemaProblem(
  config: Record<string, any>,
  definition: AdapterDefinition,
) {
  return definition.id === "cursor"
    ? cursorHookSchemaProblem(config, definition)
    : groupedHookSchemaProblem(config, definition);
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function managedCommand(cli: string, id: ManagedAdapterId) {
  return `${shellQuote(cli)} hook ingest --adapter ${id}`;
}

function isManagedHandler(value: unknown, id: ManagedAdapterId) {
  const command = jsonRecord(value).command;
  if (typeof command !== "string" || !command.includes(marker)) return false;
  const argv = parseArgsStringToArgv(command);
  return argv.length === 5 && basename(argv[0] ?? "") === "crewvane" &&
    argv.slice(1).join(" ") === `hook ingest --adapter ${id}`;
}

function hasManagedHooks(config: Record<string, any>, id: ManagedAdapterId) {
  return Object.values(jsonRecord(config.hooks)).some(groups =>
    Array.isArray(groups) && groups.some(group => {
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [group];
      return handlers.some((handler: unknown) => isManagedHandler(handler, id));
    }));
}

function mergeHookEvents(
  config: Record<string, any>,
  definition: AdapterDefinition,
  command: string,
  remove: boolean,
) {
  const next = structuredClone(config),
    hooks = jsonRecord(next.hooks);
  next.hooks = hooks;
  for (const event of definition.events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    let removed = false;
    const cleaned = current
      .map(group => {
        const copy = jsonRecord(group);
        if (Array.isArray(copy.hooks)) {
          const kept = copy.hooks.filter(handler =>
            !isManagedHandler(handler, definition.id));
          if (kept.length !== copy.hooks.length) {
            removed = true;
            copy.hooks = kept;
            if (!kept.length) return undefined;
          }
        }
        if (isManagedHandler(copy, definition.id)) {
          removed = true;
          return undefined;
        }
        return copy;
      })
      .filter(Boolean);
    if (remove && !removed) continue;
    hooks[event] = remove
      ? cleaned
      : [...cleaned, {
          hooks: [{
            type: "command",
            command,
            timeout: 2,
            async: true,
          }],
        }];
    if (remove && !hooks[event].length) delete hooks[event];
  }
  if (remove && !Object.keys(hooks).length) delete next.hooks;
  return next;
}

function mergeCursorConfig(
  config: Record<string, any>,
  definition: AdapterDefinition,
  command: string,
  remove: boolean,
) {
  const next = structuredClone(config),
    hooks = jsonRecord(next.hooks);
  next.version ??= 1;
  next.hooks = hooks;
  for (const event of definition.events) {
    const current = Array.isArray(hooks[event]) ? hooks[event] : [];
    const cleaned = current
      .filter(handler => !isManagedHandler(handler, definition.id));
    if (remove && cleaned.length === current.length) continue;
    hooks[event] = remove
      ? cleaned
      : [...cleaned, { command, timeout: 2 }];
    if (remove && !hooks[event].length) delete hooks[event];
  }
  if (remove && !Object.keys(hooks).length) delete next.hooks;
  return next;
}

async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readOwnedConfig(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() ||
      (process.getuid && info.uid !== process.getuid()) || info.size > 2_000_000)
      throw new Error("Agent 配置必须是当前用户拥有的真实文件；原文件未修改");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Serialize Crewvane writers and detect edits by other installers before commit. */
async function updateOwnedConfig(
  path: string,
  merge: (body: string | undefined) => string | undefined,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return withLock(dirname(path), async () => {
    const before = await readOwnedConfig(path);
    const next = merge(before);
    if (next === undefined || next === before) return;
    await backupOnce(path);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
      if (await readOwnedConfig(path) !== before)
        throw new Error("Agent 配置已被其他程序更新；Crewvane 已停止写入，请重新检测后重试");
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }, 2_000);
}

async function backupOnce(path: string) {
  const backup = `${path}.crewvane-backup`;
  const exists = await stat(path).then(() => true).catch(() => false);
  if (!exists) return;
  const backupExists = await stat(backup).then(() => true).catch(() => false);
  if (!backupExists) {
    await copyFile(path, backup);
    await chmod(backup, 0o600);
  }
}

export class AgentHookManager {
  readonly home: string;
  readonly cliPath: string;
  private readonly manifestPath: string;
  private readonly commandPath: (command: string) => Promise<string | undefined>;
  private readonly versionRunner: (path: string) => Promise<string>;
  private readonly now: () => Date;
  private manifest: Manifest = { version: 1, adapters: {} };
  private loading: Promise<void> | undefined;
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly detections = new Map<
    ManagedAdapterId,
    Promise<{ command: string; version?: string } | undefined>
  >();

  constructor(options: AgentHookManagerOptions) {
    this.home = options.home ?? homedir();
    this.cliPath = join(this.home, ".local", "bin", "crewvane");
    this.manifestPath = join(options.userData, "agent-hooks.json");
    this.commandPath = options.commandPath ?? (async command => {
      try {
        return (await exec("which", [command], { timeout: 2_000 })).stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    });
    this.versionRunner = options.version ?? (async path =>
      (await exec(path, ["--version"], { timeout: 5_000, maxBuffer: 64_000 })).stdout.trim());
    this.now = options.now ?? (() => new Date());
  }

  private load() {
    return this.loading ??= this.loadNow();
  }

  private async loadNow() {
    try {
      const parsed = jsonRecord(JSON.parse(await readFile(this.manifestPath, "utf8")));
      if (parsed.version === manifestVersion)
        this.manifest = {
          version: 1,
          adapters: jsonRecord(parsed.adapters) as Manifest["adapters"],
        };
    } catch {
      // Missing or malformed bookkeeping is rebuilt from the managed markers.
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action, action);
    this.mutation = result.catch(() => {});
    return result;
  }

  private async save() {
    await mkdir(dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    await atomicJson(this.manifestPath, this.manifest);
  }

  async isEnabled(id: ManagedAdapterId) {
    await this.load();
    return supported.includes(id) && this.manifest.adapters[id]?.enabled !== false;
  }

  private configPath(id: ManagedAdapterId) {
    if (id === "codex") return join(this.home, ".codex", "hooks.json");
    if (id === "claude-code") return join(this.home, ".claude", "settings.json");
    if (id === "cursor") return join(this.home, ".cursor", "hooks.json");
    if (id === "qoder") return join(this.home, ".qoder", "settings.json");
    return join(this.home, ".omp", "agent", "extensions", "crewvane.js");
  }

  private async detect(definition: AdapterDefinition) {
    let detection = this.detections.get(definition.id);
    if (!detection) {
      detection = this.detectNow(definition);
      this.detections.set(definition.id, detection);
    }
    return detection;
  }

  private async detectNow(definition: AdapterDefinition) {
    for (const command of definition.commands) {
      const path = await this.commandPath(command).catch(() => undefined);
      if (path) {
        let version: string | undefined;
        try { version = (await this.versionRunner(path)).split("\n")[0]?.trim(); }
        catch { /* A CLI may not expose --version. The official config still detects it. */ }
        return { command: path, version };
      }
    }
    return;
  }

  private async jsonStatus(
    definition: AdapterDefinition,
    detected: { command: string; version?: string } | undefined,
  ) {
    const path = this.configPath(definition.id);
    let config: Record<string, any> | undefined;
    try {
      config = parseConfig(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return {
          configPath: path,
          installed: false,
          conflict: true,
          unsupported: false,
          detail: "Agent 配置不是有效 JSON，Crewvane 未修改原文件。",
        };
    }
    const schemaProblem = config ? hookSchemaProblem(config, definition) : undefined;
    if (schemaProblem)
      return {
        configPath: path,
        installed: false,
        conflict: false,
        unsupported: true,
        detail: `版本不支持：${definition.label} 配置格式已变化（${schemaProblem}），Crewvane 未修改原文件。`,
      };
    const installed = config ? hasManagedHooks(config, definition.id) : false;
    return {
      configPath: path,
      installed,
      conflict: false,
      unsupported: false,
      detail: detected?.version,
    };
  }

  async status(): Promise<AgentHookAdapterStatus[]> {
    await this.load();
    return Promise.all(supported.map(async id => {
      const definition = definitions[id],
        detected = await this.detect(definition),
        saved = this.manifest.adapters[id],
        json = id === "omp"
          ? {
              configPath: this.configPath(id),
              installed: false,
              conflict: false,
              unsupported: false,
              detail: detected?.version,
            }
          : await this.jsonStatus(definition, detected),
        configPath = this.configPath(id);
      let installed = json.installed;
      if (id === "omp") {
        const body = await readFile(configPath, "utf8").catch(() => "");
        installed = body.startsWith("// Crewvane managed OMP extension\n");
      }
      let status: HookInstallStatus = "not-installed";
      if (!detected) status = "not-installed";
      else if (json.unsupported) status = "unsupported";
      else if (saved?.enabled === false) status = "disabled";
      else if (json.conflict) status = "conflict";
      else if (saved?.waitingTrust && installed) status = "waiting-trust";
      else if (saved?.detail?.startsWith("冲突：")) status = "conflict";
      else if (saved?.detail?.startsWith("安装失败")) status = "error";
      else if (installed) status = "installed";
      return {
        id,
        label: definition.label,
        enabled: saved?.enabled !== false,
        installed,
        status,
        events: definition.events,
        configPath,
        ...(detected?.command ? { command: detected.command } : {}),
        ...((detected?.version ?? saved?.version)
          ? { version: detected?.version ?? saved?.version }
          : {}),
        ...(saved?.lastEventAt ? { lastEventAt: saved.lastEventAt } : {}),
        ...(json.conflict || json.unsupported
          ? { detail: json.detail }
          : saved?.detail || json.detail
            ? { detail: saved?.detail || json.detail }
            : {}),
      };
    }));
  }

  private ompExtension() {
    return `// Crewvane managed OMP extension
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

let currentSessionId =
  process.env.CREWVANE_ATTEMPT_ID || "omp-session";
let latestPrompt;
let latestTurnId;

function textFrom(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const result = textFrom(item, depth + 1);
      if (result) return result;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  if (typeof value.role === "string" && value.role !== "assistant")
    return undefined;
  if (value.role === "assistant") {
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) {
      const text = value.content
        .filter(item =>
          item && ["text", "output_text"].includes(String(item.type || "")))
        .map(item => item.text)
        .filter(item => typeof item === "string")
        .join("");
      if (text) return text;
    }
  }
  if (!value.role && typeof value.text === "string") return value.text;
  for (const key of ["message", "messages", "events", "data"]) {
    const result = textFrom(value[key], depth + 1);
    if (result) return result;
  }
  return undefined;
}

function sessionId(ctx) {
  try {
    const value = ctx?.sessionManager?.getSessionId?.();
    if (typeof value === "string" && value) return value;
  } catch {}
  return currentSessionId;
}

function turnId(event, ctx) {
  const index = event?.turnIndex ?? event?.turn_index;
  if (Number.isSafeInteger(index) && index >= 0)
    return sessionId(ctx) + ":" + index;
  return latestTurnId || sessionId(ctx) + ":turn";
}

function report(pi, event, details = {}) {
  if (!process.env.CREWVANE_GOAL_ID ||
      !process.env.CREWVANE_ATTEMPT_ID ||
      !process.env.CREWVANE_HOOK_TOKEN) return;
  try {
    const executable = process.env.CREWVANE_CLI_BIN || "crewvane";
    const child = spawn(executable, ["hook", "ingest", "--adapter", "omp"], {
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => {});
    child.stdin.end(JSON.stringify({ hook_event_name: event, ...details }));
    child.unref();
  } catch {
    // Observation is fail-open. Never interfere with the OMP turn.
  }
}

export default function crewvaneExtension(pi) {
  pi.on("session_start", (_event, ctx) => {
    currentSessionId = sessionId(ctx);
    report(pi, "SessionStart");
  });
  pi.on("input", (event, ctx) => {
    latestPrompt = typeof event?.text === "string" ? event.text : undefined;
    latestTurnId = sessionId(ctx) + ":" + randomUUID();
    report(pi, "TurnStart", {
      prompt: latestPrompt,
      turn_id: latestTurnId,
      session_id: sessionId(ctx),
    });
  });
  pi.on("turn_start", (event, ctx) => {
    // OMP model/tool iterations are not separate user turns. Keep one ID
    // through tool calls so an earlier semantic write remains attributable.
    if (latestTurnId) return;
    latestTurnId = sessionId(ctx) + ":" + randomUUID();
    report(pi, "TurnStart", {
      prompt: latestPrompt,
      turn_id: latestTurnId,
      session_id: sessionId(ctx),
    });
    latestPrompt = undefined;
  });
  pi.on("turn_end", (event, ctx) => report(pi, "TurnEnd", {
    text: textFrom(event?.message),
    turn_id: latestTurnId || turnId(event, ctx),
    session_id: sessionId(ctx),
  }));
  pi.on("agent_end", (event, ctx) => {
    if (event?.willContinue || event?.awaitingAsyncWork) return;
    report(pi, "AgentEnd", {
      text: textFrom(event?.messages),
      turn_id: latestTurnId || turnId(event, ctx),
      session_id: sessionId(ctx),
    });
  });
  pi.on("tool_approval_requested", event => report(pi, "ToolApprovalRequested", {
    reason: event?.reason || event?.toolName,
  }));
  pi.on("tool_approval_resolved", () => report(pi, "AgentResponse"));
  pi.on("session_shutdown", () => report(pi, "SessionEnd"));
}
`;
  }

  private async installJson(definition: AdapterDefinition) {
    const path = this.configPath(definition.id);
    await updateOwnedConfig(path, body => {
      let config: Record<string, any>;
      try { config = body === undefined ? {} : parseConfig(body); }
      catch { throw new Error("Agent 配置不是有效 JSON，Crewvane 未修改原文件"); }
      const schemaProblem = hookSchemaProblem(config, definition);
      if (schemaProblem)
        throw new Error(`版本不支持：${definition.label} 配置格式已变化（${schemaProblem}）`);
      const command = managedCommand(this.cliPath, definition.id);
      const next = definition.id === "cursor"
        ? mergeCursorConfig(config, definition, command, false)
        : mergeHookEvents(config, definition, command, false);
      if (JSON.stringify(next) === JSON.stringify(config)) return;
      return `${JSON.stringify(next, null, 2)}\n`;
    });
  }

  private async removeManaged(definition: AdapterDefinition) {
    const path = this.configPath(definition.id);
    if (definition.id === "omp") {
      await withLock(dirname(path), async () => {
        const body = await readOwnedConfig(path);
        if (body?.startsWith("// Crewvane managed OMP extension\n"))
          await unlink(path);
      }, 2_000);
      return;
    }
    await updateOwnedConfig(path, body => {
      if (body === undefined) return;
      let config: Record<string, any>;
      try { config = parseConfig(body); } catch { return; }
      const schemaProblem = hookSchemaProblem(config, definition);
      if (schemaProblem)
        throw new Error(`版本不支持：${definition.label} 配置格式已变化（${schemaProblem}），原文件未修改`);
      if (!hasManagedHooks(config, definition.id)) return;
      const command = managedCommand(this.cliPath, definition.id);
      const next = definition.id === "cursor"
        ? mergeCursorConfig(config, definition, command, true)
        : mergeHookEvents(config, definition, command, true);
      if (JSON.stringify(next) === JSON.stringify(config)) return;
      return `${JSON.stringify(next, null, 2)}\n`;
    });
  }

  install(id: ManagedAdapterId) {
    return this.enqueue(() => this.installNow(id));
  }

  private async installNow(id: ManagedAdapterId) {
    await this.load();
    const definition = definitions[id],
      detected = await this.detect(definition);
    if (!detected)
      throw new Error(`${definition.label} 尚未安装，检测到命令后会自动接入`);
    await stat(this.cliPath).catch(() => {
      throw new Error("请先安装 Crewvane CLI，再接入 Agent Hook");
    });
    const previous = this.manifest.adapters[id];
    try {
      if (id === "omp") {
        const path = this.configPath(id);
        await updateOwnedConfig(path, existing => {
          if (existing !== undefined &&
            !existing.startsWith("// Crewvane managed OMP extension\n"))
            throw new Error("OMP 扩展目录中已有同名文件，Crewvane 已保护原文件");
          return this.ompExtension();
        });
      } else {
        await this.installJson(definition);
      }
      this.manifest.adapters[id] = {
        enabled: true,
        installed: true,
        waitingTrust: id === "codex" && !previous?.lastEventAt,
        managedRevision,
        ...(detected.version ? { version: detected.version } : {}),
        ...(previous?.lastEventAt ? { lastEventAt: previous.lastEventAt } : {}),
      };
      await this.save();
    } catch (error) {
      this.manifest.adapters[id] = {
        enabled: previous?.enabled !== false,
        installed: previous?.installed ?? false,
        waitingTrust: false,
        ...(detected.version ? { version: detected.version } : {}),
        detail: `${String(error instanceof Error ? error.message : error).includes("同名文件")
          ? "冲突" : "安装失败"}：${error instanceof Error ? error.message : String(error)}`,
      };
      await this.save();
      throw error;
    }
    return (await this.status()).find(item => item.id === id)!;
  }

  disable(id: ManagedAdapterId) {
    return this.enqueue(() => this.disableNow(id));
  }

  private async disableNow(id: ManagedAdapterId) {
    await this.load();
    await this.removeManaged(definitions[id]);
    this.manifest.adapters[id] = {
      ...this.manifest.adapters[id],
      enabled: false,
      installed: false,
      waitingTrust: false,
      detail: "已停用，目标继续使用当前会话后端与巡检状态。",
    };
    await this.save();
    return (await this.status()).find(item => item.id === id)!;
  }

  uninstall(id: ManagedAdapterId) {
    return this.enqueue(() => this.uninstallNow(id));
  }

  private async uninstallNow(id: ManagedAdapterId) {
    await this.load();
    await this.removeManaged(definitions[id]);
    const previous = this.manifest.adapters[id];
    this.manifest.adapters[id] = {
      enabled: false,
      installed: false,
      waitingTrust: false,
      detail: "已卸载 Crewvane Hook；其他 Agent Hook 保持不变。",
      ...(previous?.version ? { version: previous.version } : {}),
      ...(previous?.lastEventAt ? { lastEventAt: previous.lastEventAt } : {}),
    };
    await this.save();
    return (await this.status()).find(item => item.id === id)!;
  }

  autoInstallDetected() {
    return this.enqueue(() => this.autoInstallNow());
  }

  private async autoInstallNow() {
    await this.load();
    this.detections.clear();
    if (!await stat(this.cliPath).then(() => true).catch(() => false))
      return this.status();
    for (const id of supported) {
      const saved = this.manifest.adapters[id];
      if (saved?.enabled === false) continue;
      const detected = await this.detect(definitions[id]);
      if (!detected) continue;
      if (saved?.installed) {
        const current = id === "omp"
          ? (await readFile(this.configPath(id), "utf8").catch(() => ""))
              .startsWith("// Crewvane managed OMP extension\n")
          : (await this.jsonStatus(definitions[id], detected)).installed;
        if (current && saved.managedRevision === managedRevision) continue;
      }
      try { await this.installNow(id); }
      catch { /* Status keeps the specific compatibility or conflict reason. */ }
    }
    return this.status();
  }

  markObserved(id: ManagedAdapterId, at = this.now().toISOString()) {
    return this.enqueue(() => this.markObservedNow(id, at));
  }

  private async markObservedNow(id: ManagedAdapterId, at: string) {
    await this.load();
    const previous = this.manifest.adapters[id];
    this.manifest.adapters[id] = {
      enabled: previous?.enabled !== false,
      installed: true,
      waitingTrust: false,
      lastEventAt: at,
      ...(previous?.version ? { version: previous.version } : {}),
      ...(previous?.managedRevision ? { managedRevision: previous.managedRevision } : {}),
    };
    await this.save();
  }
}
