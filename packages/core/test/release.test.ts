import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type Goal,
  type GoalBriefInput,
} from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-release-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}
function brief(goal: Goal): GoalBriefInput {
  const activityId = goal.activities[0]!.id;
  return {
    outcome: "完成可发布的候选",
    inScope: ["实现和验证"],
    outOfScope: [],
    criteria: [{
      id: "candidate-verified",
      statement: "候选版本通过真实检查",
      required: true,
      provenance: { kind: "user-message", activityId },
    }],
    constraints: [],
    externalEffects: ["生产发布"],
    verificationPlan: {
      requiredEvidenceKinds: ["command"],
      independentReviewer: true,
    },
    attemptBudget: { maxRecoveryAttempts: 3 },
    source: { activityIds: [activityId], ruleRefs: [] },
  };
}
async function reviewedGoal(service: WorkspaceService) {
  const goal = await service.execute({
    type: "goal.intake",
    text: "准备一个待发布候选",
  }) as Goal;
  await service.execute({
    type: "goal.brief",
    goalId: goal.id,
    actor: "管家",
    brief: brief(goal),
  });
  return service.execute({
    type: "goal.review",
    goalId: goal.id,
    actor: "owner-a",
    delivery: {
      summary: "候选已通过测试。",
      candidate: { revision: "rev-42", version: "0.9.0" },
      checks: [{ name: "测试", command: "pnpm test", result: "passed" }],
      evidence: [{
        id: "ev_tests",
        kind: "command",
        label: "测试通过",
        result: "passed",
        observedAt: new Date().toISOString(),
        command: "pnpm test",
        sourceRevision: "rev-42",
      }],
    },
  }) as Promise<Goal>;
}

test("production release is a separate goal with per-release human approval and final human confirmation", async () => {
  const { service } = await fixture();
  const source = await reviewedGoal(service);
  await service.execute({
    type: "goal.accept",
    goalId: source.id,
    note: "候选验收通过。",
    actor: "你",
  });
  const release = await service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "rev-42", version: "0.9.0" },
    actor: "你",
  }) as Goal;
  assert.equal(release.kind, "release");
  assert.equal(release.autonomy?.acceptance, undefined);
  assert.equal(release.release?.status, "awaiting-authorization");
  assert.equal(release.attention?.kind, "decision");
  await assert.rejects(service.execute({
    type: "release.approve",
    goalId: release.id,
    note: "Agent 自行批准",
    actor: "owner-a",
  }), /由人/);
  const approved = await service.execute({
    type: "release.approve",
    goalId: release.id,
    note: "批准 0.9.0 候选 rev-42 发布到生产。",
    actor: "你",
  }) as Goal;
  assert.equal(approved.release?.status, "authorized");
  assert.equal(approved.release?.authorization?.candidateRevision, "rev-42");
  assert.equal(approved.dispatch?.status, "pending");
  const succeeded = await service.execute({
    type: "release.result",
    goalId: release.id,
    outcome: "succeeded",
    evidence: ["生产环境观察到 0.9.0 已生效"],
    actor: "发布执行器",
  }) as Goal;
  assert.equal(succeeded.release?.status, "succeeded");
  assert.equal(succeeded.status, "review");
  assert.equal(succeeded.attention?.kind, "review");
  assert.equal(succeeded.autonomy?.acceptance, undefined);
  const accepted = await service.execute({
    type: "goal.accept",
    goalId: release.id,
    note: "已核对生产环境、候选和真实结果。",
    actor: "你",
  }) as Goal;
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.autonomy?.acceptance?.kind, "human");
  assert.equal(accepted.release?.status, "succeeded");
});

test("candidate mismatch cannot be approved by a different release record", async () => {
  const { service } = await fixture();
  const source = await reviewedGoal(service);
  await service.execute({
    type: "goal.accept",
    goalId: source.id,
    note: "候选验收通过。",
    actor: "你",
  });
  await assert.rejects(service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "other-rev" },
    actor: "你",
  }), /候选与发布候选不一致/);
  const release = await service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "rev-42" },
    actor: "你",
  }) as Goal;
  await service.execute({
    type: "release.approve",
    goalId: release.id,
    note: "只批准 rev-42。",
    actor: "你",
  });
  const state = await service.read();
  assert.equal(state.goals.find(goal => goal.id === release.id)?.release
    ?.authorization?.candidateRevision, "rev-42");
});

test("a release can bind only completed, explicitly accepted delivery goals", async () => {
  const { service } = await fixture();
  const source = await reviewedGoal(service);
  await assert.rejects(service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "rev-42" },
    actor: "你",
  }), /必须已完成并通过验收/);
  await service.execute({
    type: "goal.accept",
    goalId: source.id,
    note: "候选已经通过人工验收。",
    actor: "你",
  });
  const release = await service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "rev-42" },
    actor: "你",
  }) as Goal;
  assert.equal(release.release?.status, "awaiting-authorization");
});

test("autonomous merge is blocked for unknown release-on-merge and requires a bound production approval", async () => {
  const { service } = await fixture();
  const source = await reviewedGoal(service);
  await service.execute({
    type: "goal.accept",
    goalId: source.id,
    note: "候选验收通过，准备合并。",
    actor: "你",
  });
  await service.execute({
    type: "project.policy.set",
    projectId: "personal",
    policy: { shipPolicy: "auto", approvers: [] },
    actor: "你",
  });
  await service.execute({
    type: "project.autonomy.set",
    projectId: "personal",
    acceptance: "inherit",
    releaseOnMerge: "unknown",
    actor: "你",
  });
  const unknown = await service.execute({
    type: "goal.ship",
    goalId: source.id,
    operation: "merge",
    checksPassed: true,
    actor: "owner-a",
  }) as { allowed: boolean; reason?: string };
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, "release_on_merge_unknown");
  await service.execute({
    type: "project.autonomy.set",
    projectId: "personal",
    acceptance: "inherit",
    releaseOnMerge: "production",
    actor: "你",
  });
  const blocked = await service.execute({
    type: "goal.ship",
    goalId: source.id,
    operation: "merge",
    checksPassed: true,
    actor: "owner-a",
  }) as { allowed: boolean; reason?: string };
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "release_approval_required");
  const release = await service.execute({
    type: "release.create",
    sourceGoalIds: [source.id],
    environment: "production",
    candidate: { revision: "rev-42", version: "0.9.0" },
    actor: "你",
  }) as Goal;
  await service.execute({
    type: "release.approve",
    goalId: release.id,
    note: "批准该候选发布。",
    actor: "你",
  });
  const allowed = await service.execute({
    type: "goal.ship",
    goalId: source.id,
    operation: "merge",
    checksPassed: true,
    actor: "owner-a",
  }) as { allowed: boolean };
  assert.equal(allowed.allowed, true);
});
