import { createHash, timingSafeEqual } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type {
  AgentRuntimeEventV1,
  AgentRuntimeState,
  Goal,
  WorkspaceService,
} from "../../../packages/core/src/index.js";
import { agentReceiptMarker, agentRuntimeSocketPath } from "../../../packages/core/src/index.js";
import type { AgentHookManager, ManagedAdapterId } from "./agent-hook-manager.js";

const MAX_REQUEST_BYTES = 1_000_000;
const MAX_DIAGNOSTIC_BYTES = 1_000_000;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface AgentRuntimeBrokerOptions {
  service: () => WorkspaceService | undefined;
  workspace: () => string | undefined;
  hooks?: AgentHookManager;
  onChanged?: (goal?: Goal) => void;
  remindOwner: (goal: Goal, prompt: string) => Promise<
    { status?: "sent" | "unconfirmed"; detail?: string } | void
  >;
  notifyConcierge: (goal: Goal, detail: string) => Promise<void>;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}

interface HookRequest {
  token?: unknown;
  events?: unknown;
}

function receiptKey(goalId: string, turnId?: string) {
  return `${goalId}:${turnId ?? ""}`;
}

function safeHash(value: string) {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(token: string, expected: string) {
  const left = safeHash(token), right = Buffer.from(expected, "hex");
  return right.length === 32 && timingSafeEqual(left, right);
}

function runtimeReminder(goal: Goal, runtime: AgentRuntimeState) {
  // Agent TUI prompt submission is reliable for one logical line. Multi-line
  // reminders can remain visible in the input box without being submitted, so
  // keep the transport prompt compact and leave full protocol guidance in the
  // owner's persistent Crewvane instructions.
  return `${agentReceiptMarker(runtime.attempt.attemptId, runtime.receipt!.turnId)} Crewvane 未收到目标 ${goal.id} 本回合的结构化写回。请立即用 crewvane goal show ${goal.id} --json 核对实际结果，并按事实运行 crewvane goal progress/decide/wait/review 之一；不要只回复，也不要把这条系统提醒记成用户新目标。`;
}

export class AgentRuntimeBroker {
  private server: Server | undefined;
  private boundWorkspace: string | undefined;
  private readonly options: AgentRuntimeBrokerOptions;
  private readonly timers = new Map<string, TimerHandle>();
  private ready: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delay: number) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;

  constructor(options: AgentRuntimeBrokerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  socketPath(workspace = this.options.workspace()) {
    if (!workspace) throw new Error("尚未打开 Crewvane 工作区");
    return agentRuntimeSocketPath(workspace);
  }

  private spoolPath(workspace = this.options.workspace()) {
    if (!workspace) throw new Error("尚未打开 Crewvane 工作区");
    return join(workspace, ".crewvane", "runtime", "spool");
  }

  async start() {
    await this.stop();
    const workspace = this.options.workspace();
    if (!workspace) return;
    this.boundWorkspace = workspace;
    const path = this.socketPath(workspace),
      directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    // The client half-closes after the request. Keep our write side open
    // until the asynchronous transaction has actually been committed.
    this.server = createServer({ allowHalfOpen: true }, socket => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(path, 0o600);
    this.ready = this.drainSpool().then(() => this.recover());
    await this.ready;
  }

  async stop() {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
    const workspace = this.boundWorkspace;
    if (workspace)
      await unlink(this.socketPath(workspace)).catch(() => {});
    this.boundWorkspace = undefined;
  }

  private handleSocket(socket: Socket) {
    socket.on("error", () => {});
    socket.setTimeout(2_000, () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0, rejected = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_REQUEST_BYTES) {
        rejected = true;
        socket.end(`${JSON.stringify({ ok: false, error: "payload_too_large" })}\n`);
        return;
      }
      chunks.push(buffer);
    });
    socket.once("end", async () => {
      if (rejected) return;
      try {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookRequest;
        await this.ready;
        const accepted = await this.processRequest(request);
        socket.end(`${JSON.stringify({ ok: accepted })}\n`);
      } catch {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
      }
    });
  }

  private async processRequest(request: HookRequest) {
    const service = this.options.service();
    if (!service || typeof request.token !== "string" ||
      !Array.isArray(request.events) || !request.events.length)
      return false;
    for (const value of request.events) {
      const event = value as AgentRuntimeEventV1;
      if (!event || typeof event !== "object" ||
        typeof event.goalId !== "string" ||
        typeof event.attemptId !== "string") return false;
      const state = await service.read(),
        goal = state.goals.find(item => item.id === event.goalId),
        runtime = goal?.agentRuntime;
      if (!goal || !runtime) return false;
      if (runtime.attempt.attemptId !== event.attemptId) {
        await this.recordDiagnostic(event, "old_attempt");
        continue;
      }
      if (!tokenMatches(request.token, runtime.hookTokenHash)) return false;
      if (this.options.hooks &&
        !await this.options.hooks.isEnabled(event.adapter as ManagedAdapterId)) {
        await this.recordDiagnostic(event, "adapter_disabled");
        continue;
      }
      const result = await service.execute({
        type: "agent.runtime.event",
        event,
      }) as {
        accepted?: boolean;
        goal?: Goal;
        reason?: string;
      };
      if (result.accepted && result.goal) {
        await this.options.hooks?.markObserved(
          event.adapter as ManagedAdapterId,
          event.at,
        ).catch(() => {});
        this.schedule(result.goal);
        this.options.onChanged?.(result.goal);
      } else if (["late_event", "old_turn", "old_attempt", "goal_ended"].includes(result.reason ?? "")) {
        await this.recordDiagnostic(event, result.reason!);
      } else if (!["duplicate", "goal_ended", "runtime_missing"].includes(result.reason ?? "")) {
        return false;
      }
    }
    return true;
  }

  private clearGoalTimers(goalId: string) {
    for (const [candidate, timer] of this.timers) {
      if (!candidate.startsWith(`${goalId}:`)) continue;
      this.clearTimer(timer);
      this.timers.delete(candidate);
    }
  }

  private schedule(goal: Goal) {
    const runtime = goal.agentRuntime, receipt = runtime?.receipt;
    this.clearGoalTimers(goal.id);
    if (goal.mode !== "concierge" || goal.status !== "active" || !runtime || !receipt ||
      ["reminding", "written", "cancelled", "protocol_missing"].includes(receipt.status))
      return;
    const key = receiptKey(goal.id, receipt.turnId);
    const schedule = (at: string, action: () => Promise<void>) => {
      const previous = this.timers.get(key);
      if (previous) this.clearTimer(previous);
      const delay = Math.max(0, Date.parse(at) - this.now());
      const timer = this.setTimer(() => {
        this.timers.delete(key);
        void action().catch(() => {});
      }, delay);
      timer.unref?.();
      this.timers.set(key, timer);
    };
    if (receipt.status === "waiting")
      schedule(receipt.remindAt, () => this.remind(goal.id, receipt.turnId));
    else if (receipt.status === "reminded")
      schedule(receipt.inspectAt, () => this.markProtocolMissing(goal.id, receipt.turnId));
  }

  private async current(goalId: string, attemptId?: string, turnId?: string) {
    const service = this.options.service();
    if (!service) return;
    const goal = (await service.read()).goals.find(item => item.id === goalId),
      runtime = goal?.agentRuntime;
    if (!goal || !runtime || runtime.attempt.attemptId !== attemptId ||
      !runtime.receipt ||
      (runtime.currentTurnId !== turnId &&
        runtime.currentTurnId !== runtime.receipt.reminderTurnId) ||
      runtime.receipt.turnId !== turnId) return;
    if (this.options.hooks &&
      !await this.options.hooks.isEnabled(runtime.attempt.adapter as ManagedAdapterId))
      return;
    return { service, goal, runtime };
  }

  private async remind(goalId: string, turnId: string) {
    const initial = (await this.options.service()?.read())?.goals.find(goal => goal.id === goalId);
    if (!initial?.agentRuntime?.attempt.attemptId) return;
    let current = await this.current(goalId, initial.agentRuntime.attempt.attemptId, turnId);
    if (!current || !["waiting", "reminding"].includes(current.runtime.receipt?.status ?? "") ||
      current.runtime.lastSemanticWriteTurnId === turnId ||
      current.goal.status !== "active" || current.goal.mode !== "concierge") return;
    if (current.runtime.receipt?.status === "waiting") {
      const reserved = await current.service.execute({
        type: "agent.runtime.receipt",
        goalId,
        attemptId: current.runtime.attempt.attemptId,
        turnId,
        stage: "reminding",
        at: new Date(this.now()).toISOString(),
      }) as { updated?: boolean; goal?: Goal };
      if (!reserved.updated || !reserved.goal) return;
      current = {
        ...current,
        goal: reserved.goal,
        runtime: reserved.goal.agentRuntime!,
      };
      this.options.onChanged?.(reserved.goal);
    }
    let reminderError: string | undefined;
    try {
      const delivery = await this.options.remindOwner(
        current.goal,
        runtimeReminder(current.goal, current.runtime),
      );
      if (delivery?.status === "unconfirmed")
        reminderError = delivery.detail ||
          "Herdr 已接收提醒，但没有确认 Agent 开始处理；为避免重复，已交给管家核对。";
    } catch (error) {
      reminderError = (error instanceof Error ? error.message : String(error))
        .slice(0, 1000);
    }
    const updated = await current.service.execute({
      type: "agent.runtime.receipt",
      goalId,
      attemptId: current.runtime.attempt.attemptId,
      turnId,
      stage: "reminded",
      at: new Date(this.now()).toISOString(),
      ...(reminderError ? { detail: reminderError } : {}),
    }) as { updated?: boolean; goal?: Goal };
    if (updated.updated && updated.goal) {
      this.schedule(updated.goal);
      this.options.onChanged?.(updated.goal);
    }
  }

  private async markProtocolMissing(goalId: string, turnId: string) {
    const initial = (await this.options.service()?.read())?.goals.find(goal => goal.id === goalId);
    if (!initial?.agentRuntime?.attempt.attemptId) return;
    const current = await this.current(goalId, initial.agentRuntime.attempt.attemptId, turnId);
    if (!current || current.runtime.receipt?.status !== "reminded" ||
      current.runtime.lastSemanticWriteTurnId === turnId ||
      current.goal.status !== "active" || current.goal.mode !== "concierge") return;
    const result = await current.service.execute({
      type: "agent.runtime.receipt",
      goalId,
      attemptId: current.runtime.attempt.attemptId,
      turnId,
      stage: "protocol_missing",
      at: new Date(this.now()).toISOString(),
    }) as { updated?: boolean; goal?: Goal };
    if (!result.updated || !result.goal) return;
    this.options.onChanged?.(result.goal);
    const basis = [...result.goal.activities]
      .reverse()
      .find(activity => activity.kind !== "watchdog")?.at ??
      result.goal.createdAt;
    try {
      await this.options.notifyConcierge(
        result.goal,
        "负责人回合结束并收到一次回执提醒后，仍未提交 Crewvane 结构化结果。请先联系原负责人核对实际结果、真实等待或交付；不要根据终端文本或空闲状态猜测完成。",
      );
      await current.service.execute({
        type: "watchdog.report",
        goalId,
        at: new Date().toISOString(),
        basis,
        outcome: "contacted",
      }).catch(() => {});
    } catch (error) {
      await current.service.execute({
        type: "watchdog.report",
        goalId,
        at: new Date().toISOString(),
        basis,
        outcome: "failed",
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
      }).catch(() => {});
    }
  }

  async drainSpool() {
    const workspace = this.options.workspace();
    if (!workspace) return;
    const spool = this.spoolPath(workspace);
    const files = (await readdir(spool).catch(() => [] as string[]))
      .filter(name => /^\d{13}-[a-zA-Z0-9_-]+\.json$/.test(name))
      .sort().slice(0, 200);
    const queued: { path: string; request: HookRequest; index: number }[] = [];
    const remaining = new Map<string, { count: number; accepted: boolean }>();
    for (const name of files) {
      try {
        const path = join(spool, name);
        const info = await stat(path);
        if (this.now() - info.mtimeMs > 7 * 24 * 60 * 60_000 ||
          info.size > MAX_REQUEST_BYTES) {
          await unlink(path);
          continue;
        }
        const parsed = JSON.parse(await readFile(join(spool, name), "utf8")) as HookRequest | HookRequest[];
        const requests = Array.isArray(parsed) ? parsed : [parsed];
        if (!requests.length) continue;
        const flattened = requests.flatMap(request =>
          Array.isArray(request.events)
            ? request.events.map(event => ({ token: request.token, events: [event] }))
            : [request]);
        remaining.set(path, { count: flattened.length, accepted: true });
        for (const request of flattened)
          queued.push({ path, request, index: queued.length });
      } catch {
        const info = await stat(join(spool, name)).catch(() => undefined);
        if (info && this.now() - info.mtimeMs > 7 * 24 * 60 * 60_000)
          await unlink(join(spool, name)).catch(() => {});
      }
    }
    // File suffixes are random and not an ordering guarantee. Replay each
    // attempt by sequence, including multiple events from one native Hook.
    queued.sort((left, right) => {
      const a = (left.request.events as AgentRuntimeEventV1[] | undefined)?.[0],
        b = (right.request.events as AgentRuntimeEventV1[] | undefined)?.[0];
      return String(a?.attemptId ?? "").localeCompare(String(b?.attemptId ?? "")) ||
        (Number(a?.sequence) || 0) - (Number(b?.sequence) || 0) ||
        left.index - right.index;
    });
    for (const item of queued) {
      const result = remaining.get(item.path)!;
      result.accepted = await this.processRequest(item.request).catch(() => false) && result.accepted;
      result.count--;
      if (!result.count && result.accepted) await unlink(item.path).catch(() => {});
    }
  }

  async recover() {
    const service = this.options.service();
    if (!service) return;
    await this.refresh();
    const state = await service.read();
    for (const goal of state.goals) {
      const receipt = goal.agentRuntime?.receipt;
      if (receipt?.status === "reminding") {
        // A crash may happen after delivery but before acknowledgement. Reserve
        // once durably; an uncertain delivery must never send the turn twice.
        const recovered = await service.execute({
          type: "agent.runtime.receipt",
          goalId: goal.id,
          attemptId: goal.agentRuntime!.attempt.attemptId,
          turnId: receipt.turnId,
          stage: "reminded",
          at: new Date(this.now()).toISOString(),
          detail: "应用在发送回执提醒期间重启；送达结果未知，不重复发送，由管家核对。",
        }) as { updated?: boolean; goal?: Goal };
        if (recovered.updated && recovered.goal) this.schedule(recovered.goal);
      } else
        this.schedule(goal);
    }
  }

  async refresh(goalId?: string) {
    const service = this.options.service();
    if (!service) return;
    const state = await service.read();
    for (const goal of state.goals) {
      if (goalId && goal.id !== goalId) continue;
      const runtime = goal.agentRuntime;
      if (runtime && this.options.hooks &&
        !await this.options.hooks.isEnabled(runtime.attempt.adapter as ManagedAdapterId)) {
        this.clearGoalTimers(goal.id);
        if (runtime.receipt && ["waiting", "reminding", "reminded", "protocol_missing"]
          .includes(runtime.receipt.status))
          await service.execute({
            type: "agent.runtime.receipt", goalId: goal.id,
            attemptId: runtime.attempt.attemptId, turnId: runtime.receipt.turnId,
            stage: "cancelled", at: new Date(this.now()).toISOString(),
          });
        continue;
      }
      this.schedule(goal);
    }
  }

  private async recordDiagnostic(event: AgentRuntimeEventV1, reason: string) {
    const workspace = this.options.workspace();
    if (!workspace) return;
    const directory = join(workspace, ".crewvane", "runtime");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "diagnostics.jsonl");
    const info = await stat(path).catch(() => undefined);
    if (info && info.size >= MAX_DIAGNOSTIC_BYTES) {
      await unlink(`${path}.1`).catch(() => {});
      await rename(path, `${path}.1`).catch(() => {});
    }
    await appendFile(
      path,
      `${JSON.stringify({
        at: new Date().toISOString(),
        reason,
        eventId: event.eventId,
        sequence: event.sequence,
        goalId: event.goalId,
        attemptId: event.attemptId,
        turnId: event.turnId,
        adapter: event.adapter,
        type: event.type,
      })}\n`,
      { mode: 0o600 },
    ).catch(() => {});
  }
}
