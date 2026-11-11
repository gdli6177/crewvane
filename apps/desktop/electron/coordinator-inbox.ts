import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export type CoordinatorPriority = "human" | "attention" | "normal" | "background";
export type CoordinatorJobKind =
  | "goal"
  | "follow_up"
  | "scene_reply"
  | "restart"
  | "feedback"
  | "watchdog"
  | "reconcile";
export type CoordinatorItemStatus =
  | "queued"
  | "processing"
  | "sent"
  | "unconfirmed"
  | "failed"
  | "cancelled"
  | "coalesced";

export interface CoordinatorInboxItem {
  id: string;
  sequence: number;
  goalId: string;
  requestId: string;
  kind: CoordinatorJobKind;
  priority: CoordinatorPriority;
  status: CoordinatorItemStatus;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  detail?: string;
  watchdogReason?: string;
  watchdogBasis?: string;
}

interface StoredCoordinatorInbox {
  version: 1;
  sequence: number;
  items: CoordinatorInboxItem[];
  context: {
    epoch: number;
    startedAt: string;
    completedCases: number;
    estimatedChars: number;
    lastResetAt?: string;
  };
  createdAt: string;
  updatedAt: string;
  lastRecoveryAt?: string;
}

export interface CoordinatorInboxStatus {
  queued: number;
  processing?: {
    goalId: string;
    kind: CoordinatorJobKind;
    startedAt: string;
  };
  failed: number;
  unconfirmed: number;
  alerts: Array<{
    goalId: string;
    requestId: string;
    kind: CoordinatorJobKind;
    status: "failed" | "unconfirmed";
  }>;
  processed: number;
  oldestQueuedAt?: string;
  contextEpoch: number;
  contextCases: number;
  contextResetDue: boolean;
}

export interface CoordinatorInboxRecovery {
  item: CoordinatorInboxItem;
  detail: string;
}

const MAX_RETAINED_ITEMS = 240;
const MAX_CONTEXT_CASES = 40;
const MAX_CONTEXT_CHARS = 240_000;
const priorityRank: Record<CoordinatorPriority, number> = {
  human: 0,
  attention: 1,
  normal: 2,
  background: 3,
};

function nowIso() {
  return new Date().toISOString();
}

function atomicTextPath(root: string) {
  return join(root, ".crewvane", "coordinator-inbox.json");
}

function initialInbox(at = nowIso()): StoredCoordinatorInbox {
  return {
    version: 1,
    sequence: 0,
    items: [],
    context: {
      epoch: 1,
      startedAt: at,
      completedCases: 0,
      estimatedChars: 0,
    },
    createdAt: at,
    updatedAt: at,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validInbox(value: unknown): value is StoredCoordinatorInbox {
  if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.sequence) ||
    !Array.isArray(value.items) || !isRecord(value.context) ||
    typeof value.createdAt !== "string" || typeof value.updatedAt !== "string")
    return false;
  const context = value.context;
  if (!Number.isSafeInteger(context.epoch) || typeof context.startedAt !== "string" ||
    !Number.isSafeInteger(context.completedCases) || !Number.isSafeInteger(context.estimatedChars))
    return false;
  const statuses = new Set([
    "queued", "processing", "sent", "unconfirmed", "failed", "cancelled", "coalesced",
  ]);
  const kinds = new Set([
    "goal", "follow_up", "scene_reply", "restart", "feedback", "watchdog", "reconcile",
  ]);
  const priorities = new Set(["human", "attention", "normal", "background"]);
  return value.items.every(item =>
    isRecord(item) &&
    typeof item.id === "string" && Number.isSafeInteger(item.sequence) &&
    typeof item.goalId === "string" && typeof item.requestId === "string" &&
    typeof item.kind === "string" && kinds.has(item.kind) &&
    typeof item.priority === "string" && priorities.has(item.priority) &&
    typeof item.status === "string" && statuses.has(item.status) &&
    typeof item.enqueuedAt === "string" && Number.isSafeInteger(item.attempts));
}

function trimItems(items: CoordinatorInboxItem[]) {
  const terminal = items
    .filter(item => !["queued", "processing"].includes(item.status))
    .sort((left, right) => right.sequence - left.sequence);
  const retained = new Set(terminal.slice(0, MAX_RETAINED_ITEMS).map(item => item.id));
  return items
    .filter(item => ["queued", "processing"].includes(item.status) || retained.has(item.id))
    .sort((left, right) => left.sequence - right.sequence);
}

export class CoordinatorInbox {
  private operationTail: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    private state: StoredCoordinatorInbox,
  ) {}

  static async open(root: string) {
    const path = atomicTextPath(root);
    let state = initialInbox();
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!validInbox(parsed))
        throw new Error("Coordinator inbox schema is invalid");
      state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${path}.invalid-${Date.now()}-${randomUUID().slice(0, 8)}`;
        await rename(path, backup).catch(() => {});
      }
    }
    const inbox = new CoordinatorInbox(root, state);
    await inbox.persist();
    return inbox;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.operationTail.catch(() => undefined).then(task);
    this.operationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist() {
    const path = atomicTextPath(this.root);
    const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
    this.state.items = trimItems(this.state.items);
    this.state.updatedAt = nowIso();
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  enqueue(input: {
    goalId: string;
    requestId: string;
    kind: CoordinatorJobKind;
    priority: CoordinatorPriority;
    detail?: string;
    watchdogReason?: string;
    watchdogBasis?: string;
  }): Promise<CoordinatorInboxItem> {
    return this.runExclusive(async () => {
      const at = nowIso();
      const duplicate = this.state.items.find(item =>
        item.goalId === input.goalId && item.requestId === input.requestId &&
        item.kind === input.kind && (
          ["queued", "processing", "sent", "unconfirmed"].includes(item.status) ||
          item.status === "failed" &&
            Date.now() - Date.parse(item.finishedAt ?? item.enqueuedAt) < 60_000
        ));
      if (duplicate) return structuredClone(duplicate);

      const queued = this.state.items.filter(item =>
        item.goalId === input.goalId && item.status === "queued");
      const higherPriority = queued.find(item =>
        priorityRank[item.priority] < priorityRank[input.priority]);
      if (higherPriority) {
        const item: CoordinatorInboxItem = {
          id: `coord_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
          sequence: ++this.state.sequence,
          goalId: input.goalId,
          requestId: input.requestId,
          kind: input.kind,
          priority: input.priority,
          status: "coalesced",
          enqueuedAt: at,
          finishedAt: at,
          attempts: 0,
          detail: `已合并到更高优先级请求 ${higherPriority.requestId}`,
        };
        this.state.items.push(item);
        await this.persist();
        return structuredClone(item);
      }
      for (const item of queued) {
        item.status = "coalesced";
        item.finishedAt = at;
        item.detail = `已合并到更新请求 ${input.requestId}`;
      }
      const item: CoordinatorInboxItem = {
        id: `coord_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        sequence: ++this.state.sequence,
        goalId: input.goalId,
        requestId: input.requestId,
        kind: input.kind,
        priority: input.priority,
        status: "queued",
        enqueuedAt: at,
        attempts: 0,
        ...(input.detail ? { detail: input.detail.slice(0, 2000) } : {}),
        ...(input.watchdogReason ? { watchdogReason: input.watchdogReason } : {}),
        ...(input.watchdogBasis ? { watchdogBasis: input.watchdogBasis } : {}),
      };
      this.state.items.push(item);
      await this.persist();
      return structuredClone(item);
    });
  }

  claimNext(): Promise<CoordinatorInboxItem | undefined> {
    return this.runExclusive(async () => {
      if (this.state.items.some(item => item.status === "processing")) return;
      const next = this.state.items
        .filter(item => item.status === "queued")
        .sort((left, right) =>
          priorityRank[left.priority] - priorityRank[right.priority] ||
          left.sequence - right.sequence)[0];
      if (!next) return;
      next.status = "processing";
      next.startedAt = nowIso();
      next.attempts += 1;
      await this.persist();
      return structuredClone(next);
    });
  }

  defer(id: string, detail?: string): Promise<CoordinatorInboxItem | undefined> {
    return this.runExclusive(async () => {
      const item = this.state.items.find(candidate => candidate.id === id);
      if (!item || item.status !== "processing") return item && structuredClone(item);
      item.status = "queued";
      item.attempts = Math.max(0, item.attempts - 1);
      delete item.startedAt;
      if (detail) item.detail = detail.slice(0, 2000);
      await this.persist();
      return structuredClone(item);
    });
  }

  finish(
    id: string,
    status: Extract<CoordinatorItemStatus, "sent" | "unconfirmed" | "failed" | "cancelled">,
    detail?: string,
    estimatedChars = 2_000,
  ): Promise<CoordinatorInboxItem | undefined> {
    return this.runExclusive(async () => {
      const item = this.state.items.find(candidate => candidate.id === id);
      if (!item || item.status !== "processing") return item && structuredClone(item);
      item.status = status;
      item.finishedAt = nowIso();
      if (detail) item.detail = detail.slice(0, 2000);
      if (status !== "cancelled") {
        this.state.context.completedCases += 1;
        this.state.context.estimatedChars += Math.min(
          20_000,
          Math.max(500, estimatedChars),
        );
      }
      await this.persist();
      return structuredClone(item);
    });
  }

  recoverInterrupted(): Promise<CoordinatorInboxRecovery[]> {
    return this.runExclusive(async () => {
      const at = nowIso();
      const recovered = this.state.items
        .filter(item => item.status === "processing")
        .map(item => {
          item.status = "unconfirmed";
          item.finishedAt = at;
          item.detail = "应用在处理过程中退出；为避免重复发送，已保留为待核对状态。";
          return { item: structuredClone(item), detail: item.detail! };
        });
      if (recovered.length) {
        this.state.lastRecoveryAt = at;
        await this.persist();
      }
      return recovered;
    });
  }

  shouldResetContext() {
    return this.state.context.completedCases >= MAX_CONTEXT_CASES ||
      this.state.context.estimatedChars >= MAX_CONTEXT_CHARS;
  }

  markContextReset() {
    return this.runExclusive(async () => {
      const at = nowIso();
      this.state.context.epoch += 1;
      this.state.context.startedAt = at;
      this.state.context.completedCases = 0;
      this.state.context.estimatedChars = 0;
      this.state.context.lastResetAt = at;
      await this.persist();
      return this.statusUnlocked();
    });
  }

  private statusUnlocked(): CoordinatorInboxStatus {
    const processing = [...this.state.items].reverse().find(item => item.status === "processing");
    const queued = this.state.items.filter(item => item.status === "queued");
    const latestByGoal = new Map<string, CoordinatorInboxItem>();
    for (const item of this.state.items) {
      const previous = latestByGoal.get(item.goalId);
      if (!previous || previous.sequence < item.sequence) latestByGoal.set(item.goalId, item);
    }
    const latest = [...latestByGoal.values()];
    const alerts = latest.flatMap(item =>
      item.status === "failed" || item.status === "unconfirmed"
        ? [{
            goalId: item.goalId,
            requestId: item.requestId,
            kind: item.kind,
            status: item.status,
          }]
        : []);
    return {
      queued: queued.length,
      ...(processing ? {
        processing: {
          goalId: processing.goalId,
          kind: processing.kind,
          startedAt: processing.startedAt ?? processing.enqueuedAt,
        },
      } : {}),
      failed: alerts.filter(item => item.status === "failed").length,
      unconfirmed: alerts.filter(item => item.status === "unconfirmed").length,
      alerts,
      processed: this.state.items.filter(item =>
        ["sent", "unconfirmed", "failed"].includes(item.status)).length,
      ...(queued.length ? {
        oldestQueuedAt: queued.sort((left, right) => left.sequence - right.sequence)[0]!.enqueuedAt,
      } : {}),
      contextEpoch: this.state.context.epoch,
      contextCases: this.state.context.completedCases,
      contextResetDue: this.shouldResetContext(),
    };
  }

  status() {
    return this.runExclusive(async () => this.statusUnlocked());
  }
}
