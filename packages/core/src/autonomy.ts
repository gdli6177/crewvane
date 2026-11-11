import { createHash } from "node:crypto";
import {
  defaultProjectAutonomy,
  defaultWorkspaceAutonomy,
  goalKind,
  goalRevision,
} from "./model.js";
import type {
  AcceptanceMode,
  Continuation,
  ContinuationTrigger,
  Delivery,
  EvidenceKind,
  Goal,
  GoalBrief,
  GoalBriefInput,
  Project,
  ReleaseOnMerge,
  ReleaseTarget,
  Verification,
  WorkspaceState,
} from "./types.js";

export const ACCEPTANCE_MODES = ["human-review", "auto-with-verification"] as const;
export const RELEASE_ON_MERGE = ["never", "production", "unknown"] as const;
export const EVIDENCE_KINDS = ["command", "artifact", "url", "attachment", "inspection"] as const;
const DEFAULT_LEASE_MS = 10 * 60_000;

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim()) && !value.includes("\0");
const iso = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const list = (value: unknown, limit = 50): string[] => {
  if (!Array.isArray(value) || value.length > limit) throw new Error("自主目标列表字段无效");
  return value.map(item => {
    if (!nonEmpty(item)) throw new Error("自主目标列表包含空值");
    return item.trim();
  });
};
const positiveInt = (value: unknown, label: string, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new Error(`${label}必须是 1 到 ${max} 的整数`);
  return Number(value);
};

export function isAcceptanceMode(value: unknown): value is AcceptanceMode {
  return ACCEPTANCE_MODES.includes(value as AcceptanceMode);
}
export function isReleaseOnMerge(value: unknown): value is ReleaseOnMerge {
  return RELEASE_ON_MERGE.includes(value as ReleaseOnMerge);
}
export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return EVIDENCE_KINDS.includes(value as EvidenceKind);
}

export function projectAutonomy(project: Project) {
  return project.autonomy ?? defaultProjectAutonomy();
}
export function workspaceAutonomy(state: WorkspaceState) {
  return state.autonomy ?? defaultWorkspaceAutonomy();
}

export function resolveAcceptance(
  state: WorkspaceState,
  goal: Goal,
): { mode: AcceptanceMode; source: "goal" | "project" | "workspace" } {
  const goalOverride = goal.autonomy?.override;
  if (isAcceptanceMode(goalOverride)) return { mode: goalOverride, source: "goal" };
  const project = state.projects.find(item => item.id === goal.projectId);
  const projectMode = project ? projectAutonomy(project).acceptance : "inherit";
  if (isAcceptanceMode(projectMode)) return { mode: projectMode, source: "project" };
  return { mode: workspaceAutonomy(state).acceptance, source: "workspace" };
}
export function acceptanceMandateRevision(state: WorkspaceState, goal: Goal) {
  if (goal.autonomy?.override) return goal.revision ?? 1;
  const project = state.projects.find(item => item.id === goal.projectId);
  return project && isAcceptanceMode(projectAutonomy(project).acceptance)
    ? projectAutonomy(project).revision
    : workspaceAutonomy(state).revision;
}

export function parseGoalBrief(
  input: GoalBriefInput,
  options: { revision?: number; setBy: string; setAt: string },
): GoalBrief {
  if (!isRecord(input)) throw new Error("委托摘要必须是对象");
  if (!nonEmpty(input.outcome)) throw new Error("委托摘要缺少期望结果");
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > 50)
    throw new Error("委托摘要至少需要一个完成条件");
  const ids = new Set<string>();
  const criteria = input.criteria.map((criterion, index) => {
    if (!isRecord(criterion) || !nonEmpty(criterion.id) || !/^[A-Za-z0-9_-]{1,100}$/.test(criterion.id))
      throw new Error(`第 ${index + 1} 个完成条件 ID 无效`);
    if (ids.has(criterion.id)) throw new Error("完成条件 ID 不能重复");
    ids.add(criterion.id);
    if (!nonEmpty(criterion.statement) || typeof criterion.required !== "boolean")
      throw new Error(`完成条件 ${criterion.id} 无效`);
    if (!isRecord(criterion.provenance) ||
      !["user-message", "project-rule", "verification-method"].includes(String(criterion.provenance.kind)))
      throw new Error(`完成条件 ${criterion.id} 缺少有效来源`);
    const provenance = criterion.provenance;
    if (provenance.kind === "user-message" && !nonEmpty(provenance.activityId))
      throw new Error(`完成条件 ${criterion.id} 必须绑定人的原话`);
    if (provenance.kind === "project-rule" && !nonEmpty(provenance.ref))
      throw new Error(`完成条件 ${criterion.id} 必须绑定项目规则`);
    if (provenance.kind === "verification-method" && !nonEmpty(provenance.rationale))
      throw new Error(`完成条件 ${criterion.id} 必须说明验证方法`);
    return {
      id: criterion.id,
      statement: criterion.statement.trim(),
      required: criterion.required,
      provenance:
        provenance.kind === "user-message"
          ? { kind: "user-message" as const, activityId: provenance.activityId.trim() }
          : provenance.kind === "project-rule"
            ? { kind: "project-rule" as const, ref: provenance.ref.trim() }
            : { kind: "verification-method" as const, rationale: provenance.rationale.trim() },
    };
  });
  if (!criteria.some(criterion => criterion.required))
    throw new Error("委托摘要至少需要一个必选完成条件");
  if (!isRecord(input.verificationPlan) ||
    input.verificationPlan.independentReviewer !== true ||
    !Array.isArray(input.verificationPlan.requiredEvidenceKinds) ||
    input.verificationPlan.requiredEvidenceKinds.length < 1 ||
    input.verificationPlan.requiredEvidenceKinds.some(kind => !isEvidenceKind(kind)))
    throw new Error("委托摘要必须声明独立复核和证据类型");
  if (!isRecord(input.attemptBudget))
    throw new Error("委托摘要缺少尝试预算");
  if (!isRecord(input.source))
    throw new Error("委托摘要缺少来源");
  return {
    revision: options.revision ?? 1,
    outcome: input.outcome.trim(),
    inScope: list(input.inScope),
    outOfScope: list(input.outOfScope),
    criteria,
    constraints: list(input.constraints),
    externalEffects: list(input.externalEffects),
    verificationPlan: {
      requiredEvidenceKinds: [...new Set(input.verificationPlan.requiredEvidenceKinds)],
      independentReviewer: true,
    },
    attemptBudget: {
      maxRecoveryAttempts: positiveInt(
        input.attemptBudget.maxRecoveryAttempts,
        "尝试预算",
        20,
      ),
    },
    source: {
      activityIds: list(input.source.activityIds, 100),
      ruleRefs: list(input.source.ruleRefs, 100),
    },
    setBy: options.setBy,
    setAt: options.setAt,
  };
}

export function briefProblems(brief: GoalBrief | undefined, goal: Goal): string[] {
  if (!brief) return ["缺少委托摘要"];
  const problems: string[] = [];
  if (!brief.outcome.trim()) problems.push("委托摘要没有期望结果");
  if (!brief.criteria.some(criterion => criterion.required))
    problems.push("委托摘要没有必选完成条件");
  if (brief.verificationPlan.independentReviewer !== true)
    problems.push("委托摘要未要求独立复核");
  if (!brief.source.activityIds.length && !brief.source.ruleRefs.length)
    problems.push("委托摘要没有人的原话或项目规则来源");
  const activityIds = new Set(goal.activities.map(activity => activity.id));
  for (const activityId of brief.source.activityIds)
    if (!activityIds.has(activityId))
      problems.push(`委托摘要引用了不存在的人的原话：${activityId}`);
  for (const criterion of brief.criteria) {
    if (criterion.provenance.kind === "user-message" &&
      !activityIds.has(criterion.provenance.activityId))
      problems.push(`完成条件 ${criterion.id} 引用了不存在的活动`);
    if (criterion.provenance.kind === "project-rule" &&
      !brief.source.ruleRefs.includes(criterion.provenance.ref))
      problems.push(`完成条件 ${criterion.id} 的项目规则未列入来源`);
    if (criterion.provenance.kind === "verification-method" &&
      criterion.required &&
      !/验证|检查|测试|复现|观察|对比|基准|review|test|verify|inspect|compare/i.test(
        criterion.provenance.rationale,
      ))
      problems.push(`完成条件 ${criterion.id} 不能只用验证方法决定结果取舍`);
  }
  return problems;
}

export function goalBasisRevision(goal: Goal) {
  return `${goalRevision(goal)}:${goal.updatedAt}`;
}

export function scheduleContinuation(
  goal: Goal,
  trigger: ContinuationTrigger,
  options: {
    at: string;
    dueAt?: string;
    idempotencyKey?: string;
    attempt?: number;
  },
): Continuation {
  const dueAt = options.dueAt ?? options.at;
  if (!iso(options.at) || !iso(dueAt)) throw new Error("续跑时间无效");
  const at = new Date(options.at).toISOString();
  const current = goal.autonomy?.continuation;
  if (current?.status === "claimed" &&
    (!current.leaseUntil || Date.parse(current.leaseUntil) > Date.parse(at)))
    throw new Error("当前续跑仍由其他调度器持有，lease 到期前不能抢占");
  if (current) {
    if (current.status === "sent") {
      current.status = "settled";
      current.settledAt = at;
    } else if (["scheduled", "claimed"].includes(current.status)) {
      current.status = current.status === "scheduled" ? "cancelled" : "settled";
      current.settledAt = at;
    }
  }
  return {
    id: `continuation_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    trigger,
    status: "scheduled",
    dueAt: new Date(dueAt).toISOString(),
    attempt: options.attempt ?? Math.max(1, (goal.autonomy?.attempts.used ?? 0) + 1),
    basisRevision: goalBasisRevision(goal),
    idempotencyKey:
      options.idempotencyKey ??
      `${goal.id}:${trigger}:${new Date(options.at).toISOString()}`,
  };
}

export function continuationEligible(goal: Goal, at: string) {
  const continuation = goal.autonomy?.continuation;
  if (!continuation) return false;
  const expiredClaim = continuation.status === "claimed" &&
    Boolean(continuation.leaseUntil) &&
    Date.parse(continuation.leaseUntil!) <= Date.parse(at);
  if (continuation.status !== "scheduled" && !expiredClaim) return false;
  if (Date.parse(continuation.dueAt) > Date.parse(at)) return false;
  if (goal.autonomy?.paused || goal.autonomy?.boundaryChange?.status === "pending") return false;
  if (!["active", "waiting", "review"].includes(goal.status)) return false;
  if (goal.attention?.kind === "decision" || goal.attention?.kind === "intervention")
    return false;
  return continuation.basisRevision === goalBasisRevision(goal);
}

export function claimContinuation(
  goal: Goal,
  continuationId: string,
  at: string,
  leaseMs = DEFAULT_LEASE_MS,
) {
  const continuation = goal.autonomy?.continuation;
  if (!continuation || continuation.id !== continuationId)
    return { claimed: false as const, reason: "continuation_missing" as const };
  if (!continuationEligible(goal, at))
    return { claimed: false as const, reason: "continuation_not_eligible" as const };
  const claimedAt = new Date(at).toISOString();
  continuation.status = "claimed";
  continuation.claimedAt = claimedAt;
  continuation.leaseUntil = new Date(Date.parse(at) + leaseMs).toISOString();
  continuation.leaseId = `lease_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  return { claimed: true as const, continuation };
}

export function reportContinuation(
  goal: Goal,
  continuationId: string,
  outcome: "sent" | "failed" | "settled",
  at: string,
  detail?: string,
  leaseId?: string,
) {
  const continuation = goal.autonomy?.continuation;
  if (!continuation || continuation.id !== continuationId)
    return { updated: false as const, reason: "continuation_missing" as const };
  if (!["claimed", "sent"].includes(continuation.status))
    return { updated: false as const, reason: "continuation_not_claimed" as const };
  if (leaseId && continuation.leaseId !== leaseId)
    return { updated: false as const, reason: "stale_lease" as const };
  const stamp = new Date(at).toISOString();
  if (outcome === "sent") {
    continuation.status = "sent";
    continuation.sentAt = stamp;
  } else if (outcome === "failed") {
    continuation.status = "failed";
    continuation.settledAt = stamp;
    if (detail) continuation.lastError = detail.slice(0, 1_000);
  } else {
    continuation.status = "settled";
    continuation.settledAt = stamp;
  }
  return { updated: true as const, continuation };
}
export function finishContinuation(
  goal: Goal,
  at: string,
  status: "settled" | "cancelled" = "settled",
) {
  const continuation = goal.autonomy?.continuation;
  if (!continuation || ["settled", "cancelled", "failed"].includes(continuation.status))
    return false;
  continuation.status = status;
  continuation.settledAt = new Date(at).toISOString();
  return true;
}

export function sameCandidate(
  left: { revision: string; digest?: string } | undefined,
  right: { revision: string; digest?: string } | undefined,
) {
  return Boolean(left && right && left.revision === right.revision &&
    (left.digest ?? "") === (right.digest ?? ""));
}

export function releaseApprovalValid(target: ReleaseTarget | undefined) {
  return Boolean(
    target?.authorization &&
    ["authorized", "executing", "verifying"].includes(target.status) &&
    target.authorization.candidateRevision === target.candidate.revision &&
    (target.authorization.candidateDigest ?? "") === (target.candidate.digest ?? ""),
  );
}

export function findMergeRelease(state: WorkspaceState, goal: Goal) {
  return state.goals.find(candidate =>
    candidate.kind === "release" &&
    candidate.release?.sourceGoalIds.includes(goal.id) &&
    candidate.release.environment === "production");
}

export function releaseMergeGate(state: WorkspaceState, goal: Goal) {
  const project = state.projects.find(item => item.id === goal.projectId);
  const releaseOnMerge = project?.releaseOnMerge ?? "unknown";
  if (!goal.brief || goal.kind !== "delivery") return { allowed: true, releaseOnMerge };
  if (releaseOnMerge === "never") return { allowed: true, releaseOnMerge };
  if (releaseOnMerge === "unknown")
    return {
      allowed: false,
      releaseOnMerge,
      reason: "release_on_merge_unknown" as const,
      detail: "项目尚未确认合并是否会触发生产发布，自主目标不能自动合并。",
    };
  const target = findMergeRelease(state, goal);
  if (!target || !releaseApprovalValid(target.release))
    return {
      allowed: false,
      releaseOnMerge,
      reason: "release_approval_required" as const,
      detail: "合并会触发生产发布，必须先由人批准绑定同一候选版本的发布目标。",
    };
  if (!target?.release || !sameCandidate(goal.delivery?.candidate, target.release.candidate))
    return {
      allowed: false,
      releaseOnMerge,
      reason: "release_candidate_mismatch" as const,
      detail: "交付候选与已批准的发布候选不一致，批准不能复用。",
    };
  return { allowed: true, releaseOnMerge, target };
}

export function failureFingerprint(
  delivery: Delivery | undefined,
  verification: Verification,
) {
  const failed = verification.criteria
    .filter(criterion => criterion.result === "failed")
    .map(criterion => ({
      criterionId: criterion.criterionId,
      result: criterion.result,
    }))
    .sort();
  return createHash("sha256").update(JSON.stringify({
    candidate: delivery?.candidate?.revision ?? delivery?.id ?? "",
    candidateDigest: delivery?.candidate?.digest ?? "",
    failed,
    outcome: verification.outcome,
  })).digest("hex");
}

export type AutoAcceptanceGate =
  | { eligible: true; mode: AcceptanceMode; source: "goal" | "project" | "workspace" }
  | { eligible: false; reason: string; mode?: AcceptanceMode };

export function autoAcceptanceGate(
  state: WorkspaceState,
  goal: Goal,
): AutoAcceptanceGate {
  const resolution = resolveAcceptance(state, goal);
  if (goal.kind === "release")
    return { eligible: false, reason: "release_requires_human_confirmation", mode: resolution.mode };
  if (resolution.mode !== "auto-with-verification")
    return { eligible: false, reason: "human_review", mode: resolution.mode };
  if (workspaceAutonomy(state).paused || goal.autonomy?.paused)
    return { eligible: false, reason: "autonomy_paused", mode: resolution.mode };
  if (goal.mode !== "concierge")
    return { eligible: false, reason: "human_takeover", mode: resolution.mode };
  if (goal.status !== "review" || !goal.delivery)
    return { eligible: false, reason: "delivery_missing", mode: resolution.mode };
  if (goal.attention?.kind === "decision" ||
    goal.autonomy?.boundaryChange?.status === "pending")
    return { eligible: false, reason: "human_decision_pending", mode: resolution.mode };
  const problems = briefProblems(goal.brief, goal);
  if (problems.length)
    return { eligible: false, reason: problems.join("；"), mode: resolution.mode };
  const delivery = goal.delivery;
  if (!delivery.id || !delivery.candidate?.revision)
    return { eligible: false, reason: "candidate_missing", mode: resolution.mode };
  if (!delivery.checks.length || delivery.checks.some(check => check.result !== "passed"))
    return { eligible: false, reason: "checks_not_passed", mode: resolution.mode };
  const evidence = delivery.evidence ?? [];
  const requiredKinds = goal.brief!.verificationPlan.requiredEvidenceKinds;
  for (const kind of requiredKinds)
    if (!evidence.some(item => item.kind === kind && item.result !== "failed"))
      return { eligible: false, reason: `evidence_missing:${kind}`, mode: resolution.mode };
  const verification = goal.autonomy?.lastVerification;
  if (!verification || verification.deliveryId !== delivery.id ||
    verification.outcome !== "passed" || verification.reviewer === delivery.submittedBy ||
    verification.reviewer === goal.owner)
    return { eligible: false, reason: "independent_verification_missing", mode: resolution.mode };
  if (!verification.reviewerHerdr)
    return { eligible: false, reason: "independent_verification_site_missing", mode: resolution.mode };
  const requiredCriteria = goal.brief!.criteria.filter(criterion => criterion.required);
  for (const criterion of requiredCriteria) {
    const result = verification.criteria.find(item => item.criterionId === criterion.id);
    if (!result || result.result !== "passed")
      return { eligible: false, reason: `criterion_not_passed:${criterion.id}`, mode: resolution.mode };
    if (!result.evidenceIds.length ||
      result.evidenceIds.some(id => !evidence.some(item => item.id === id)))
      return { eligible: false, reason: `criterion_evidence_missing:${criterion.id}`, mode: resolution.mode };
    if (result.evidenceIds.some(id =>
      evidence.some(item => item.id === id && item.result === "failed")))
      return { eligible: false, reason: `criterion_evidence_failed:${criterion.id}`, mode: resolution.mode };
  }
  const reviewRounds = goal.reviewRounds ?? 0;
  const reviewLimit = goal.reviewLimit ?? 3;
  if (reviewRounds > reviewLimit)
    return { eligible: false, reason: "review_limit_exceeded", mode: resolution.mode };
  return { eligible: true, mode: resolution.mode, source: resolution.source };
}

export function reconcileAutonomyDefaults(state: WorkspaceState) {
  const defaults = defaultWorkspaceAutonomy();
  state.autonomy ??= defaults;
  state.autonomy.acceptance ??= "human-review";
  state.autonomy.paused ??= false;
  state.autonomy.maxRecoveryAttempts ??= 3;
  state.autonomy.noProgressMinutes ??= 30;
  state.autonomy.revision ??= 1;
  state.autonomy.updatedAt ??= defaults.updatedAt;
  for (const project of state.projects) {
    project.autonomy ??= defaultProjectAutonomy();
    project.releaseOnMerge ??= "unknown";
  }
  for (const goal of state.goals) {
    goal.kind ??= "delivery";
    goal.revision ??= 1;
  }
}
