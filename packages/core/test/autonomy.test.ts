import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  resolveAcceptance,
  type Continuation,
  type Goal,
  type GoalBriefInput,
} from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-autonomy-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}
function brief(goal: Goal, outcome = "修复登录失败并证明回归通过"): GoalBriefInput {
  const message = goal.activities.find(activity => activity.actor === "你")?.id ??
    goal.activities[0]!.id;
  return {
    outcome,
    inScope: ["修复登录流程", "补充真实回归证据"],
    outOfScope: ["无关的视觉改版"],
    criteria: [{
      id: "tests-pass",
      statement: "真实登录回归检查通过",
      required: true,
      provenance: { kind: "user-message", activityId: message },
    }],
    constraints: ["不修改使用方规则"],
    externalEffects: [],
    verificationPlan: {
      requiredEvidenceKinds: ["command"],
      independentReviewer: true,
    },
    attemptBudget: { maxRecoveryAttempts: 3 },
    source: { activityIds: [message], ruleRefs: [] },
  };
}
async function deliver(
  service: WorkspaceService,
  goal: Goal,
  revision = "abc123",
) {
  return service.execute({
    type: "goal.review",
    goalId: goal.id,
    actor: "owner-a",
    delivery: {
      summary: "登录流程已修复，并留下真实回归命令。",
      candidate: { revision },
      checks: [{
        name: "登录回归",
        command: "pnpm test -- login",
        result: "passed",
      }],
      evidence: [{
        id: "ev_login",
        kind: "command",
        label: "登录回归",
        result: "passed",
        observedAt: new Date().toISOString(),
        command: "pnpm test -- login",
        sourceRevision: revision,
      }],
    },
  }) as Promise<Goal>;
}

test("acceptance resolution follows goal, project, workspace priority and defaults to human review", async () => {
  const { service } = await fixture();
  let state = await service.read();
  assert.equal(state.version, 4);
  assert.equal(state.autonomy.acceptance, "human-review");
  assert.equal(state.autonomy.initializedAt, undefined);
  const item = await service.execute({
    type: "goal.intake",
    text: "需要自主验收的目标",
  }) as Goal;
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  await service.execute({
    type: "project.autonomy.set",
    projectId: "personal",
    acceptance: "human-review",
    releaseOnMerge: "unknown",
    actor: "你",
  });
  await service.execute({
    type: "goal.autonomy.resume",
    goalId: item.id,
    actor: "你",
  });
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const reviewed = await deliver(service, item);
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.attention?.kind, "review");
  assert.equal(reviewed.autonomy?.continuation, undefined);
  await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "独立复核通过。",
    reviewer: "reviewer-a",
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_login"],
    }],
  });
  state = await service.read();
  assert.equal(state.goals[0]?.status, "review");
  assert.equal(state.goals[0]?.attention?.kind, "review");
});

test("independent verification can automatically complete only when the full gate passes", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "修复登录失败，并用真实回归证明。",
  }) as Goal;
  await service.execute({
    type: "session.set",
    goalId: item.id,
    reference: {
      session: "test",
      agent: "owner-a",
      paneId: "w1:p2",
      tabId: "w1:t2",
    },
  });
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "concierge",
    brief: brief(item),
  });
  const reviewed = await deliver(service, item);
  assert.equal(reviewed.attention, null);
  assert.equal(reviewed.autonomy?.continuation?.trigger, "verification");
  await assert.rejects(service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "负责人自检通过。",
    reviewer: "owner-a",
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_login"],
    }],
  }), /复核人不能/);
  const completed = await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "独立复核逐项核对真实命令和候选版本。",
    reviewer: "reviewer-a",
    reviewerHerdr: {
      session: "test",
      agent: "reviewer-a",
      paneId: "w1:p9",
      tabId: "w1:t9",
    },
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_login"],
    }],
  }) as Goal;
  assert.equal(completed.status, "completed");
  assert.equal(completed.attention, null);
  assert.equal(completed.autonomy?.acceptance?.kind, "automatic");
  assert.equal(completed.autonomy?.lastVerification?.reviewer, "reviewer-a");
  assert.equal(completed.delivery?.evidence?.[0]?.id, "ev_login");
});

test("human acceptance cannot be delegated to an owner, concierge or Bot identity", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "交付后必须由人完成最后验收。",
  }) as Goal;
  const reviewed = await deliver(service, item);
  await assert.rejects(service.execute({
    type: "goal.accept",
    goalId: item.id,
    note: "负责人声称用户已经同意。",
    actor: "owner-a",
  }), /成果验收必须由人/);
  const accepted = await service.execute({
    type: "goal.accept",
    goalId: item.id,
    note: "我已核对真实成果。",
    actor: "你",
  }) as Goal;
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.autonomy?.acceptance?.kind, "human");
  assert.equal(accepted.autonomy?.acceptance?.by, "你");
});

test("automatic acceptance requires a persisted independent verification site", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "复核不能只凭一个名字。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const reviewed = await deliver(service, item);
  const verified = await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "复核结论通过，但没有留下独立现场。",
    reviewer: "reviewer-a",
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_login"],
    }],
  }) as Goal;
  assert.equal(verified.status, "review");
  assert.equal(verified.autonomy?.acceptance, undefined);
  assert.equal(verified.attention?.kind, "intervention");
  assert.match(verified.attention?.summary ?? "", /verification_site_missing/);
});

test("verification uses the persisted independent site when the CLI omits a reference", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "复核现场需要留下独立证据。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const reviewed = await deliver(service, item);
  const site = {
    session: "test",
    agent: "reviewer-site",
    paneId: "w1:p9",
    tabId: "w1:t9",
  };
  await service.execute({
    type: "goal.verification.site",
    goalId: item.id,
    reference: site,
    status: "ready",
    actor: "reviewer-site",
  });
  const completed = await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "独立复核现场已逐项核对。",
    reviewer: "reviewer-site",
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_login"],
    }],
  }) as Goal;
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.autonomy?.lastVerification?.reviewerHerdr, site);
});

test("verification site lifecycle preserves launching, ready, blocked and failed facts", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "复核现场需要可恢复记录。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const reviewed = await deliver(service, item);
  const reference = {
    session: "test",
    agent: "reviewer-site",
    paneId: "w1:p9",
    tabId: "w1:t9",
  };
  const launching = await service.execute({
    type: "goal.verification.site",
    goalId: item.id,
    reference,
    status: "launching",
  }) as Goal;
  assert.equal(launching.autonomy?.verificationSite?.status, "launching");
  const blocked = await service.execute({
    type: "goal.verification.site",
    goalId: item.id,
    reference,
    status: "blocked",
    detail: "等待 Hook 信任确认",
  }) as Goal;
  assert.equal(blocked.attention?.kind, "intervention");
  const ready = await service.execute({
    type: "goal.verification.site",
    goalId: item.id,
    reference,
    status: "ready",
  }) as Goal;
  assert.equal(ready.attention, null);
  assert.equal(ready.autonomy?.verificationSite?.status, "ready");
  const failed = await service.execute({
    type: "goal.verification.site",
    goalId: item.id,
    reference,
    status: "failed",
    detail: "启动命令退出",
  }) as Goal;
  assert.equal(failed.attention?.kind, "intervention");
  assert.match(failed.attention?.summary ?? "", /启动失败/);
  assert.equal(failed.delivery?.id, reviewed.delivery?.id);
});

test("checkpoint creates a durable lease and expired or old receipts cannot win", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "推进一个有明确下一步的目标",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item, "完成可验证的实现"),
  });
  await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "已完成第一阶段实现，下一阶段运行回归。",
    next: "运行回归并整理证据。",
    actor: "owner-a",
    dueAt: "2026-01-01T00:00:00.000Z",
  });
  const at = "2026-01-01T00:00:01.000Z",
    inspected = await service.execute({
      type: "autonomy.inspect",
      at,
    }) as Array<{ goalId: string; continuationId: string }>;
  assert.equal(inspected.length, 1);
  const first = await service.execute({
    type: "autonomy.claim",
    goalId: item.id,
    continuationId: inspected[0]!.continuationId,
    at,
    leaseMs: 1_000,
  }) as { continuation: Continuation };
  assert.equal(first.continuation.status, "claimed");
  assert.ok(first.continuation.leaseId);
  const stale = await service.execute({
    type: "autonomy.report",
    goalId: item.id,
    continuationId: first.continuation.id,
    outcome: "sent",
    leaseId: "lease_old",
    at,
  }) as { updated: boolean; reason?: string };
  assert.deepEqual(stale, { updated: false, reason: "stale_lease" });
  const recheck = await service.execute({
    type: "autonomy.inspect",
    at: "2026-01-01T00:00:03.000Z",
  }) as Array<{ continuationId: string }>;
  assert.equal(recheck.length, 1);
  const second = await service.execute({
    type: "autonomy.claim",
    goalId: item.id,
    continuationId: recheck[0]!.continuationId,
    at: "2026-01-01T00:00:03.000Z",
    leaseMs: 10_000,
  }) as { continuation: Continuation };
  assert.notEqual(second.continuation.leaseId, first.continuation.leaseId);
  const late = await service.execute({
    type: "autonomy.report",
    goalId: item.id,
    continuationId: second.continuation.id,
    outcome: "sent",
    leaseId: first.continuation.leaseId,
    at: "2026-01-01T00:00:04.000Z",
  }) as { updated: boolean };
  assert.equal(late.updated, false);
  const sent = await service.execute({
    type: "autonomy.report",
    goalId: item.id,
    continuationId: second.continuation.id,
    outcome: "sent",
    leaseId: second.continuation.leaseId,
    at: "2026-01-01T00:00:04.000Z",
  }) as { updated: boolean };
  assert.equal(sent.updated, true);
});

test("new triggers replace queued or sent continuations but never steal a live lease", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "连续推进多个短回合",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const first = await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "第一阶段完成。",
    next: "继续第二阶段。",
    actor: "owner-a",
  }) as Goal;
  const firstId = first.autonomy!.continuation!.id;
  const claimed = await service.execute({
    type: "autonomy.claim",
    goalId: item.id,
    continuationId: firstId,
    at: new Date().toISOString(),
    leaseMs: 60_000,
  }) as { continuation: Continuation };
  await assert.rejects(service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "新的回合不能抢占租约。",
    next: "等待租约结算。",
    actor: "owner-a",
  }), /lease/);
  await service.execute({
    type: "autonomy.report",
    goalId: item.id,
    continuationId: firstId,
    outcome: "sent",
    leaseId: claimed.continuation.leaseId,
    at: new Date().toISOString(),
  });
  const second = await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "第二阶段完成。",
    next: "继续第三阶段。",
    actor: "owner-a",
  }) as Goal;
  assert.notEqual(second.autonomy?.continuation?.id, firstId);
  const secondId = second.autonomy!.continuation!.id;
  const third = await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "第三阶段完成。",
    next: "继续第四阶段。",
    actor: "owner-a",
  }) as Goal;
  assert.notEqual(third.autonomy?.continuation?.id, secondId);
  assert.equal(third.autonomy?.continuation?.status, "scheduled");
});

test("the same candidate and failed criteria stop recovery even after a new delivery id", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "同一失败没有新证据时必须停止自动重试。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const first = await deliver(service, item);
  await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: first.delivery!.id!,
    outcome: "failed",
    summary: "登录回归仍然失败。",
    reviewer: "reviewer-a",
    criteria: [{
      criterionId: "tests-pass",
      result: "failed",
      evidenceIds: ["ev_login"],
    }],
  });
  const second = await deliver(service, item);
  assert.notEqual(second.delivery?.id, first.delivery?.id);
  const stopped = await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: second.delivery!.id!,
    outcome: "failed",
    summary: "同一候选和同一完成条件再次失败。",
    reviewer: "reviewer-a",
    criteria: [{
      criterionId: "tests-pass",
      result: "failed",
      evidenceIds: ["ev_login"],
    }],
  }) as Goal;
  assert.equal(stopped.status, "active");
  assert.equal(stopped.attention?.kind, "intervention");
  assert.match(stopped.attention?.summary ?? "", /同一失败/);
  assert.equal(stopped.autonomy?.attempts.used, 2);
  assert.equal(stopped.autonomy?.continuation?.status, "settled");
  assert.equal((await service.execute({
    type: "autonomy.inspect",
    at: new Date(Date.now() + 60_000).toISOString(),
  }) as unknown[]).length, 0);
});

test("a boundary change pauses the loop and an approved revision resumes from existing work", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "实现一个边界明确的修复",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "已有实现和候选版本。",
    next: "继续补齐测试。",
    actor: "owner-a",
  });
  const changed = await service.execute({
    type: "goal.boundary",
    goalId: item.id,
    actor: "owner-a",
    change: {
      reason: "为满足登录安全要求，需要把局部修复扩大为认证流程迁移。",
      proposedOutcome: "迁移认证流程并保留现有登录入口",
      evidence: ["现有实现无法安全兼容旧会话"],
      alternatives: ["保持局部修复并接受已知风险", "回滚本次改动"],
      recommendation: "批准认证流程迁移",
    },
  }) as Goal;
  assert.equal(changed.autonomy?.boundaryChange?.status, "pending");
  assert.equal(changed.attention?.kind, "decision");
  const paused = await service.execute({
    type: "autonomy.inspect",
    at: new Date(Date.now() + 1_000).toISOString(),
  }) as unknown[];
  assert.equal(paused.length, 0);
  const approved = await service.execute({
    type: "goal.boundary.resolve",
    goalId: item.id,
    boundaryId: changed.autonomy!.boundaryChange!.id,
    outcome: "approved",
    note: "接受迁移，但仍需保留原登录入口。",
    actor: "你",
  }) as Goal;
  assert.equal(approved.autonomy?.boundaryChange?.status, "approved");
  assert.equal(approved.brief?.revision, 2);
  assert.equal(
    approved.autonomy?.continuation?.trigger,
    "decision-resolved",
  );
  assert.equal(approved.attention, null);
  assert.equal(approved.briefHistory?.length, 1);
  assert.equal(approved.briefHistory?.[0]?.revision, 1);
});

test("a goal-level acceptance override outranks project and workspace settings and remains human-only", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  await service.execute({
    type: "project.autonomy.set",
    projectId: "personal",
    acceptance: "human-review",
    releaseOnMerge: "unknown",
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "这个目标单独使用自动验收。",
  }) as Goal;
  await assert.rejects(service.execute({
    type: "goal.autonomy.acceptance",
    goalId: item.id,
    acceptance: "auto-with-verification",
    actor: "owner-a",
  }), /只能由人/);
  const overridden = await service.execute({
    type: "goal.autonomy.acceptance",
    goalId: item.id,
    acceptance: "auto-with-verification",
    actor: "你",
  }) as Goal;
  let state = await service.read();
  assert.deepEqual(resolveAcceptance(state, overridden), {
    mode: "auto-with-verification",
    source: "goal",
  });
  const inherited = await service.execute({
    type: "goal.autonomy.acceptance",
    goalId: item.id,
    acceptance: "inherit",
    actor: "你",
  }) as Goal;
  state = await service.read();
  assert.deepEqual(resolveAcceptance(state, inherited), {
    mode: "human-review",
    source: "project",
  });
});

test("discovery goals can be created and switched before delivery, while release kinds stay governed", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.create",
    input: {
      title: "调查一个方向",
      projectId: "personal",
      kind: "discovery",
      mode: "concierge",
    },
  }) as Goal;
  assert.equal(item.kind, "discovery");
  const changed = await service.execute({
    type: "goal.kind.set",
    goalId: item.id,
    kind: "delivery",
    actor: "owner-a",
  }) as Goal;
  assert.equal(changed.kind, "delivery");
  await assert.rejects(service.execute({
    type: "goal.kind.set",
    goalId: item.id,
    kind: "release" as never,
    actor: "owner-a",
  }), /发布目标必须通过 release create/);
});

test("external wait schedules a durable wait-due continuation and resuming settles it", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "等待外部依赖后继续自动推进。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const dueAt = new Date(Date.now() + 60_000).toISOString();
  const waiting = await service.execute({
    type: "goal.wait",
    goalId: item.id,
    reason: "等待外部依赖返回结果",
    owner: "YR",
    remindAt: dueAt,
    actor: "owner-a",
  }) as Goal;
  assert.equal(waiting.autonomy?.continuation?.trigger, "wait-due");
  assert.equal(waiting.autonomy?.continuation?.dueAt, dueAt);
  const early = await service.execute({
    type: "autonomy.inspect",
    at: new Date(Date.now() + 30_000).toISOString(),
  }) as unknown[];
  assert.equal(early.length, 0);
  const due = await service.execute({
    type: "autonomy.inspect",
    at: new Date(Date.now() + 90_000).toISOString(),
  }) as Array<{ trigger: string }>;
  assert.deepEqual(due.map(candidate => candidate.trigger), ["wait-due"]);
  const resumed = await service.execute({
    type: "goal.resume",
    goalId: item.id,
    note: "外部依赖已返回，继续验证。",
    mode: "concierge",
  }) as Goal;
  assert.equal(resumed.status, "active");
  assert.equal(resumed.autonomy?.continuation?.status, "cancelled");
});

test("review, acceptance and ending a goal cannot leave an old continuation runnable", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "提交成果前必须结算旧续跑。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  await service.execute({
    type: "goal.checkpoint",
    goalId: item.id,
    summary: "实现完成，准备提交。",
    next: "提交成果。",
    actor: "owner-a",
  });
  const reviewed = await deliver(service, item);
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.autonomy?.continuation?.status, "settled");
  await assert.rejects(service.execute({
    type: "goal.complete",
    goalId: item.id,
    note: "负责人声称完成。",
    actor: "owner-a",
  }), /待验收成果必须/);
  const accepted = await service.execute({
    type: "goal.accept",
    goalId: item.id,
    note: "人已核对成果。",
    actor: "你",
  }) as Goal;
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.autonomy?.continuation?.status, "settled");
});

test("brief revisions retain an explicit history for audit and display", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "委托摘要需要保留修订记录。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const revised = await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: {
      ...brief(item),
      constraints: ["补充一条不改变结果取舍的执行约束"],
    },
  }) as Goal;
  assert.equal(revised.brief?.revision, 2);
  assert.equal(revised.briefHistory?.length, 1);
  assert.equal(revised.briefHistory?.[0]?.revision, 1);
  assert.equal(revised.briefHistory?.[0]?.outcome, brief(item).outcome);
});

test("watchdog.inspect uses the workspace no-progress threshold", async () => {
  const { service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "用工作区设置检测无进展。",
  }) as Goal;
  const start = "2030-01-01T08:00:00.000Z";
  await service.store.update("test setup", state => {
    state.autonomy.noProgressMinutes = 10;
    const saved = state.goals.find(goal => goal.id === item.id)!;
    saved.herdr = { session: "test", paneId: "w1:p2", agent: "owner-a" };
    saved.dispatch = { status: "sent", at: start };
    saved.createdAt = start;
    saved.updatedAt = start;
    saved.activities[0]!.at = start;
  });
  const requests = await service.execute({
    type: "watchdog.inspect",
    at: "2030-01-01T08:11:00.000Z",
  }) as Array<{ reason: string }>;
  assert.deepEqual(requests.map(request => request.reason), ["stale"]);
});

test("automatic acceptance rejects a passed criterion that cites failed evidence", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "workspace.autonomy.set",
    acceptance: "auto-with-verification",
    initialize: true,
    actor: "你",
  });
  const item = await service.execute({
    type: "goal.intake",
    text: "失败证据不能被通过结论掩盖。",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: item.id,
    actor: "管家",
    brief: brief(item),
  });
  const reviewed = await service.execute({
    type: "goal.review",
    goalId: item.id,
    actor: "owner-a",
    delivery: {
      summary: "交付里同时保留了真实失败证据。",
      candidate: { revision: "rev-evidence" },
      checks: [{
        name: "登录回归",
        command: "pnpm test -- login",
        result: "passed",
      }],
      evidence: [
        {
          id: "ev_login",
          kind: "command",
          label: "登录回归",
          result: "passed",
          observedAt: new Date().toISOString(),
          command: "pnpm test -- login",
        },
        {
          id: "ev_failed",
          kind: "artifact",
          label: "失败截图",
          result: "failed",
          observedAt: new Date().toISOString(),
          location: "artifacts/failed.png",
        },
      ],
    },
  }) as Goal;
  const verified = await service.execute({
    type: "goal.verify",
    goalId: item.id,
    deliveryId: reviewed.delivery!.id!,
    outcome: "passed",
    summary: "错误地引用了失败证据。",
    reviewer: "reviewer-a",
    reviewerHerdr: {
      session: "test",
      tabId: "w1:t2",
      paneId: "w1:p2",
      agent: "reviewer-a",
    },
    criteria: [{
      criterionId: "tests-pass",
      result: "passed",
      evidenceIds: ["ev_failed"],
    }],
  }) as Goal;
  assert.equal(verified.status, "review");
  assert.equal(verified.autonomy?.acceptance, undefined);
  assert.match(verified.attention?.summary ?? "", /失败证据|criterion_evidence_failed/);
});

test("v2 workspaces migrate in place with a backup and conservative autonomy defaults", async () => {
  const { root, service } = await fixture();
  const legacy = {
    version: 2,
    name: "旧工作区",
    projects: [{
      id: "personal",
      name: "个人事项",
      policy: {
        shipPolicy: "external-approval",
        approvers: [],
        revision: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
    workflows: [],
    goals: [{
      id: "goal_legacy",
      projectId: "personal",
      title: "旧目标",
      description: "不能被迁移丢掉",
      mode: "concierge",
      status: "active",
      steps: [],
      next: "继续",
      owner: "待分配负责人",
      attention: null,
      activities: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    decisions: [],
    concierge: { session: "crewvane", status: "not_ready" },
  };
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane/state.json"), JSON.stringify(legacy));
  const state = await service.read();
  assert.equal(state.version, 4);
  assert.equal(state.goals[0]?.kind, "delivery");
  assert.equal(state.goals[0]?.autonomy, undefined);
  assert.equal(state.autonomy.acceptance, "human-review");
  assert.equal(state.autonomy.initializedAt, undefined);
  assert.equal(state.projects[0]?.autonomy?.acceptance, "inherit");
  assert.equal(state.projects[0]?.releaseOnMerge, "unknown");
  const backup = JSON.parse(await readFile(
    join(root, ".crewvane/state.v2.backup.json"),
    "utf8",
  ));
  assert.equal(backup.version, 2);
  assert.equal(backup.goals[0].title, "旧目标");
});
