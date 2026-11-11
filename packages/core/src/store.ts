import { appendFile, mkdir, open, readFile, realpath, rename, lstat, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { nextSequence, withLock } from "./storage.js";
import type { WorkspaceRecoveryReason, WorkspaceState } from "./types.js";
import {
  defaultProjectAutonomy,
  defaultProjectPolicy,
  defaultWorkspaceAutonomy,
  initialState,
  newId,
} from "./model.js";
import { reconcileAutonomyDefaults } from "./autonomy.js";
import { decisionMarkdown } from "./governance.js";
import { normalizeExternalWaits } from "./waiting.js";
export { initialState, newId } from "./model.js";
const DEFAULT_EVENT_LOG_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_EVENT_TAIL_BYTES = 4 * 1024 * 1024;
const DEFAULT_RETAINED_EVENTS = 2_000;
class IncompatibleWorkspaceStateError extends Error {
  constructor(readonly reason: WorkspaceRecoveryReason, message: string) {
    super(message);
  }
}
function invalidState(message: string): never {
  throw new IncompatibleWorkspaceStateError("invalid-state", message);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}
function stateDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function compactEvent(record: Record<string, unknown>) {
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "type", "sequence", "created_at", "title", "source_task_id", "recovery"]) {
    if (record[key] !== undefined) compact[key] = record[key];
  }
  if (record.state !== undefined) {
    const state = JSON.stringify(record.state);
    compact.state_sha256 = stateDigest(state);
    compact.state_bytes = Buffer.byteLength(state);
  }
  compact.compacted = true;
  return compact;
}
async function readEventTail(path: string, maxBytes: number): Promise<Record<string, unknown>[]> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat(), offset = Math.max(0, info.size - maxBytes);
    const buffer = Buffer.alloc(info.size - offset);
    await handle.read(buffer, 0, buffer.length, offset);
    let raw = buffer.toString("utf8");
    if (offset > 0) {
      const firstNewline = raw.indexOf("\n");
      raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
    }
    const records: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value))
          records.push(value as Record<string, unknown>);
      } catch {
        // A tail read can begin in the middle of a UTF-8 code point. The
        // newline boundary above removes that partial record.
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}
export async function compactEventLogIfNeeded(
  directory: string,
  options: { maxBytes?: number; tailBytes?: number; keepEvents?: number } = {},
) {
  const path = join(directory, "events.jsonl"),
    maxBytes = options.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES,
    tailBytes = options.tailBytes ?? DEFAULT_EVENT_TAIL_BYTES,
    keepEvents = options.keepEvents ?? DEFAULT_RETAINED_EVENTS;
  let before: number;
  try {
    before = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { compacted: false, before: 0, after: 0 };
    throw error;
  }
  if (before <= maxBytes) return { compacted: false, before, after: before };
  const records = (await readEventTail(path, tailBytes)).slice(-keepEvents).map(compactEvent);
  if (!records.length) throw new Error("events.jsonl 超过上限，但尾部没有完整事件可安全保留");
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`,
    body = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
  return { compacted: true, before, after: Buffer.byteLength(body) };
}
function validateShape(value: unknown, version: 2 | 3): WorkspaceState {
  if (!record(value))
    throw new IncompatibleWorkspaceStateError(
      "invalid-state",
      "工作区快照不是有效对象。",
    );
  if (value.version !== version)
    throw new IncompatibleWorkspaceStateError(
      "unsupported-version",
      `工作区状态版本 ${String(value.version ?? "未知")} 与当前版本不兼容。`,
    );
  if (!nonEmptyString(value.name)) invalidState("工作区快照缺少名称。");
  if (!Array.isArray(value.projects)) invalidState("工作区快照缺少项目列表。");
  if (!Array.isArray(value.goals)) invalidState("工作区快照缺少目标列表。");
  if (!Array.isArray(value.workflows)) invalidState("工作区快照缺少工序列表。");
  if (!record(value.concierge) || !nonEmptyString(value.concierge.session) ||
    !["not_ready", "ready", "error"].includes(String(value.concierge.status)))
    invalidState("工作区快照中的管家状态无效。");
  if (value.decisions !== undefined && !Array.isArray(value.decisions))
    invalidState("工作区快照中的决定账本无效。");
  for (const project of value.projects)
    if (!record(project) || !nonEmptyString(project.id) || !nonEmptyString(project.name))
      invalidState("工作区快照包含无效项目。");
  for (const goal of value.goals) {
    if (!record(goal) || !nonEmptyString(goal.id) || !nonEmptyString(goal.projectId) ||
      !nonEmptyString(goal.title) || typeof goal.description !== "string" ||
      !["concierge", "manual"].includes(String(goal.mode)) ||
      !["backlog", "active", "waiting", "review", "completed", "dropped"].includes(String(goal.status)) ||
      typeof goal.next !== "string" || typeof goal.owner !== "string" ||
      !Array.isArray(goal.activities) || !nonEmptyString(goal.createdAt) ||
      !nonEmptyString(goal.updatedAt))
      invalidState("工作区快照包含结构不完整的目标。");
  }
  if (value.recovery !== undefined) {
    const recovery = value.recovery;
    if (!record(recovery) || !nonEmptyString(recovery.id) ||
      !nonEmptyString(recovery.detectedAt) || !nonEmptyString(recovery.archivedPath) ||
      !["unsupported-version", "invalid-state", "legacy-event-log"].includes(String(recovery.reason)) ||
      !nonEmptyString(recovery.detail))
      invalidState("工作区恢复提示信息无效。");
  }
  const state = value as unknown as WorkspaceState;
  state.decisions ??= [];
  for (const project of state.projects) project.policy ??= defaultProjectPolicy();
  normalizeExternalWaits(state);
  return state;
}
function migrateStateV2(value: unknown): WorkspaceState {
  const state = validateShape(value, 2);
  state.version = 3;
  state.autonomy = defaultWorkspaceAutonomy();
  state.bots = [];
  state.botRequests = [];
  for (const project of state.projects) {
    project.autonomy = defaultProjectAutonomy();
    project.releaseOnMerge = "unknown";
  }
  for (const goal of state.goals) {
    goal.kind = "delivery";
    goal.revision = 1;
    delete goal.autonomy;
    delete goal.brief;
    delete goal.release;
  }
  return state;
}
export function validateState(value: unknown): WorkspaceState {
  if (!record(value))
    throw new IncompatibleWorkspaceStateError(
      "invalid-state",
      "工作区快照不是有效对象。",
    );
  if (value.version === 2) return migrateStateV2(value);
  const state = validateShape(value, 3);
  if (state.autonomy !== undefined &&
    (!record(state.autonomy) ||
      !["human-review", "auto-with-verification"].includes(String(state.autonomy.acceptance)) ||
      typeof state.autonomy.paused !== "boolean" ||
      !Number.isSafeInteger(state.autonomy.maxRecoveryAttempts) ||
      !Number.isSafeInteger(state.autonomy.noProgressMinutes) ||
      !Number.isSafeInteger(state.autonomy.revision) ||
      !nonEmptyString(state.autonomy.updatedAt)))
    invalidState("工作区自主目标设置无效。");
  if (state.bots !== undefined && !Array.isArray(state.bots))
    invalidState("工作区 Bot 绑定列表无效。");
  if (state.botRequests !== undefined && !Array.isArray(state.botRequests))
    invalidState("工作区 Bot 请求回执列表无效。");
  reconcileAutonomyDefaults(state);
  return state;
}
async function writeAtomic(path: string, body: string) {
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}
export class WorkspaceStore {
  constructor(readonly root: string) {}
  private async directory() {
    const owner = await realpath(this.root), path = join(owner, ".crewvane");
    await mkdir(path, { recursive: true });
    if ((await lstat(path)).isSymbolicLink()) throw new Error("状态目录不能是符号链接");
    return path;
  }
  private async recoveryReason(directory: string): Promise<IncompatibleWorkspaceStateError | undefined> {
    try {
      validateState(JSON.parse(await readFile(join(directory, "state.json"), "utf8")));
      return undefined;
    } catch (error) {
      if (error instanceof IncompatibleWorkspaceStateError) return error;
      if (error instanceof SyntaxError)
        return new IncompatibleWorkspaceStateError(
          "invalid-state",
          "原 state.json 无法解析。",
        );
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        const events = await readFile(join(directory, "events.jsonl"), "utf8");
        if (events.trim())
          return new IncompatibleWorkspaceStateError(
            "legacy-event-log",
            "检测到没有 v2 快照的旧版或未完成事件日志。",
          );
      } catch (eventError) {
        if ((eventError as NodeJS.ErrnoException).code !== "ENOENT") throw eventError;
      }
      return undefined;
    }
  }
  private async readStateFile(directory: string): Promise<WorkspaceState> {
    const path = join(directory, "state.json"),
      raw = await readFile(path, "utf8"),
      parsed: unknown = JSON.parse(raw);
    if (!record(parsed) || parsed.version !== 2) return validateState(parsed);
    const migrated = migrateStateV2(parsed),
      backup = join(directory, "state.v2.backup.json");
    try {
      await lstat(backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(backup, raw, { mode: 0o600 });
    }
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`,
      serialized = `${JSON.stringify(migrated, null, 2)}\n`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, path);
    return migrated;
  }
  private async recover(incompatible: IncompatibleWorkspaceStateError): Promise<WorkspaceState> {
    const owner = await realpath(this.root);
    const directory = join(owner, ".crewvane"),
      current = await this.recoveryReason(directory);
    if (!current) {
      try {
        return await this.readStateFile(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
        throw error;
      }
    }
    const detectedAt = new Date(),
      stamp = detectedAt.toISOString().replace(/\D/g, "").slice(0, 14),
      archivedPath = join(owner, `.crewvane.backup-${stamp}-${randomUUID().slice(0, 8)}`),
      staging = join(owner, `.crewvane.recovery-${randomUUID().slice(0, 8)}`),
      recovery = {
        id: newId("recovery"),
        detectedAt: detectedAt.toISOString(),
        archivedPath,
        reason: current.reason,
        detail: current.message,
      },
      next = initialState(recovery);
    try {
      await mkdir(staging);
      const serialized = `${JSON.stringify(next, null, 2)}\n`;
      await writeAtomic(join(staging, "state.json"), serialized);
      await writeFile(join(staging, "events.jsonl"), `${JSON.stringify({
        id: newId("evt"),
        type: "workspace_recovered",
        sequence: 1,
        created_at: detectedAt.toISOString(),
        title: "工作区已自动恢复",
        source_task_id: "workspace",
        recovery,
        state_sha256: stateDigest(serialized),
        state_bytes: Buffer.byteLength(serialized),
      })}\n`, { mode: 0o600 });
      await writeFile(join(staging, "sequence"), "1", { mode: 0o600 });
      await Promise.all([
        writeAtomic(join(staging, "decisions.md"), decisionMarkdown(next.decisions, "approved")),
        writeAtomic(join(staging, "rejected.md"), decisionMarkdown(next.decisions, "rejected")),
      ]);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    try {
      await rename(directory, archivedPath);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    try {
      await rename(staging, directory);
    } catch (error) {
      await rename(archivedPath, directory).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return next;
  }
  /** Caller must hold the workspace-root lock. Recovery moves `.crewvane`
   * atomically, so its lock must live beside that directory. */
  private async readUnlocked(): Promise<WorkspaceState> {
    const directory = await this.directory();
    try {
      return await this.readStateFile(directory);
    } catch (error) {
      if (error instanceof IncompatibleWorkspaceStateError || error instanceof SyntaxError) {
        const incompatible = error instanceof SyntaxError
          ? new IncompatibleWorkspaceStateError("invalid-state", "原 state.json 无法解析。")
          : error;
        return this.recover(incompatible);
      }
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const incompatible = await this.recoveryReason(directory);
      return incompatible ? this.recover(incompatible) : initialState();
    }
  }
  async read(): Promise<WorkspaceState> {
    return withLock(await realpath(this.root), () => this.readUnlocked());
  }
  async update<T>(reason: string, action: (state: WorkspaceState) => T | Promise<T>): Promise<T> {
    const owner = await realpath(this.root), directory = join(owner, ".crewvane");
    return withLock(owner, async () => {
      const state = await this.readUnlocked(), before = JSON.stringify(state), result = await action(state);
      if (before === JSON.stringify(state)) return result;
      const temporary = join(directory, `.state-${process.pid}-${randomUUID()}.tmp`),
        serialized = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, join(directory, "state.json"));
      await Promise.all([
        writeAtomic(join(directory, "decisions.md"), decisionMarkdown(state.decisions, "approved")),
        writeAtomic(join(directory, "rejected.md"), decisionMarkdown(state.decisions, "rejected")),
      ]);
      await compactEventLogIfNeeded(directory);
      await appendFile(join(directory, "events.jsonl"), `${JSON.stringify({
        id: newId("evt"),
        type: "workspace_changed",
        sequence: await nextSequence(this.root),
        created_at: new Date().toISOString(),
        title: reason,
        source_task_id: "workspace",
        state_sha256: stateDigest(serialized),
        state_bytes: Buffer.byteLength(serialized),
      })}\n`, { mode: 0o600 });
      return result;
    });
  }
}
