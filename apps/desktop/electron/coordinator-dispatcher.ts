import {
  CoordinatorInbox,
  type CoordinatorInboxItem,
  type CoordinatorInboxStatus,
  type CoordinatorJobKind,
  type CoordinatorPriority,
} from "./coordinator-inbox.js";

export interface CoordinatorExecutionResult {
  status: "sent" | "unconfirmed" | "failed" | "cancelled" | "deferred";
  detail?: string;
  estimatedChars?: number;
  pauseQueue?: boolean;
}

export interface CoordinatorDispatcherHooks {
  execute(item: CoordinatorInboxItem): Promise<CoordinatorExecutionResult>;
  onStatus(status: CoordinatorInboxStatus): Promise<void> | void;
}

// The inbox is durable; this class only owns the in-process drain. A new
// enqueue wakes the same drain instead of allowing two concierge turns to
// interleave for one workspace.
export class CoordinatorDispatcher {
  private draining?: Promise<void>;
  private wakeRequested = false;

  constructor(
    readonly inbox: CoordinatorInbox,
    private readonly hooks: CoordinatorDispatcherHooks,
  ) {}

  async enqueue(input: {
    goalId: string;
    requestId: string;
    kind: CoordinatorJobKind;
    priority: CoordinatorPriority;
    detail?: string;
    watchdogReason?: string;
    watchdogBasis?: string;
  }) {
    const item = await this.inbox.enqueue(input);
    this.wakeRequested = true;
    await this.emitStatus();
    return item;
  }

  drain() {
    if (this.draining) return this.draining;
    const draining = this.drainOnce()
      .finally(async () => {
        if (this.draining === draining) this.draining = undefined;
        await this.emitStatus();
      });
    this.draining = draining;
    return draining;
  }

  private async drainOnce() {
    while (true) {
      this.wakeRequested = false;
      const item = await this.inbox.claimNext();
      if (!item) {
        if (this.wakeRequested) continue;
        return;
      }
      let result: CoordinatorExecutionResult;
      try {
        result = await this.hooks.execute(item);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.inbox.finish(item.id, "failed", detail.slice(0, 2000));
        await this.emitStatus();
        continue;
      }
      if (result.status === "deferred") {
        await this.inbox.defer(item.id, result.detail);
        await this.emitStatus();
        return;
      }
      await this.inbox.finish(
        item.id,
        result.status,
        result.detail,
        result.estimatedChars,
      );
      await this.emitStatus();
      if (result.pauseQueue) return;
    }
  }

  private emitStatus() {
    return this.inbox.status().then(status => this.hooks.onStatus(status));
  }
}
