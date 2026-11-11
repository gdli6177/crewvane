import type {
  ContinuationTrigger,
  CrewvaneCommand,
} from "../../../packages/core/src/index.js";

export interface AutonomyCandidate {
  goalId: string;
  continuationId: string;
  trigger: ContinuationTrigger;
  dueAt: string;
  attempt: number;
  basisRevision: string;
  status: "active" | "waiting" | "review";
}
export interface AutonomyClaim {
  claimed: true;
  goalId: string;
  continuation: {
    id: string;
    attempt: number;
    leaseId?: string;
  };
}
export interface AutonomySchedulerService {
  execute(command: CrewvaneCommand): Promise<unknown>;
}
export type AutonomyDispatchResult =
  | { status: "accepted"; detail?: string }
  | { status: "failed"; detail: string };

export class AutonomyScheduler {
  private running = false;

  constructor(private readonly options: {
    service: () => AutonomySchedulerService | undefined;
    dispatch: (
      candidate: AutonomyCandidate,
      leaseId: string | undefined,
    ) => Promise<AutonomyDispatchResult>;
    now?: () => Date;
    onError?: (error: unknown) => void;
  }) {}

  async tick() {
    if (this.running) return 0;
    const service = this.options.service();
    if (!service) return 0;
    this.running = true;
    let processed = 0;
    const now = this.options.now ?? (() => new Date());
    try {
      const at = now().toISOString(),
        candidates = await service.execute({
          type: "autonomy.inspect",
          at,
        }) as AutonomyCandidate[];
      for (const candidate of candidates) {
        const claim = await service.execute({
          type: "autonomy.claim",
          goalId: candidate.goalId,
          continuationId: candidate.continuationId,
          at: now().toISOString(),
        }) as AutonomyClaim | { claimed: false };
        if (!claim.claimed) continue;
        let outcome: AutonomyDispatchResult;
        try {
          outcome = await this.options.dispatch(candidate, claim.continuation.leaseId);
        } catch (error) {
          outcome = {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        await service.execute({
          type: "autonomy.report",
          goalId: candidate.goalId,
          continuationId: claim.continuation.id,
          outcome: outcome.status === "accepted" ? "sent" : "failed",
          ...(claim.continuation.leaseId
            ? { leaseId: claim.continuation.leaseId }
            : {}),
          ...(outcome.detail ? { detail: outcome.detail.slice(0, 1_000) } : {}),
          at: now().toISOString(),
        });
        processed += 1;
      }
      return processed;
    } catch (error) {
      this.options.onError?.(error);
      return processed;
    } finally {
      this.running = false;
    }
  }
}
