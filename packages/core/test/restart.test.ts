import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal } from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function serviceFixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-restart-"));
  fixtures.push(root);
  return new WorkspaceService(root);
}

async function completedGoal(service: WorkspaceService) {
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "重启验收后的目标",
      description: "保留历史并续接原来的负责人。",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "session.set",
    goalId: goal.id,
    reference: {
      session: "crewvane-test",
      workspaceId: "w1",
      tabId: "w1:t2",
      paneId: "w1:p2",
      agent: "owner-a",
    },
  });
  await service.execute({
    type: "agent.runtime.register",
    goalId: goal.id,
    attempt: {
      goalId: goal.id,
      attemptId: "attempt_restart",
      agent: "owner-a",
      adapter: "codex",
      startedAt: new Date().toISOString(),
    },
    hookTokenHash: "a".repeat(64),
    capabilities: [
      "session.started",
      "turn.started",
      "turn.settled",
      "agent.response",
    ],
  });
  await service.execute({
    type: "goal.review",
    goalId: goal.id,
    actor: "owner-a",
    delivery: {
      summary: "第一轮成果",
      location: "/tmp/result.md",
      checks: [{
        name: "真实检查",
        command: "pnpm test",
        result: "passed",
        note: "10 tests passed",
      }],
    },
  });
  await service.execute({
    type: "goal.accept",
    goalId: goal.id,
    note: "验收通过，结束目标。",
  });
  await service.execute({
    type: "session.preserve",
    goalId: goal.id,
    resume: {
      owner: "owner-a",
      cwd: "/tmp/project",
      savedAt: new Date().toISOString(),
      agentSession: {
        source: "herdr:codex",
        agent: "codex",
        kind: "id",
        value: "session-123",
      },
    },
  });
  await service.execute({ type: "session.release", goalId: goal.id });
  return goal;
}

test("restart reopens an ended concierge goal and preserves its history", async () => {
  const service = await serviceFixture(), first = await completedGoal(service);
  let ended = (await service.read()).goals.find(goal => goal.id === first.id)!;
  assert.equal(ended.status, "completed");
  assert.equal(ended.herdr, undefined);
  assert.equal(ended.ownerResume?.agentSession?.value, "session-123");
  assert.ok(ended.delivery);

  const restarted = await service.execute({
    type: "goal.restart",
    goalId: first.id,
    note: "请从上次成果继续，补齐失败场景。",
  }) as Goal;
  assert.equal(restarted.status, "active");
  assert.equal(restarted.owner, "owner-a");
  assert.equal(restarted.dispatch?.kind, "restart");
  assert.equal(restarted.dispatch?.status, "pending");
  assert.equal(restarted.dispatch?.note, "请从上次成果继续，补齐失败场景。");
  assert.equal(restarted.delivery, undefined);
  assert.equal(restarted.herdr, undefined);
  assert.equal(restarted.ownerResume?.agentSession?.value, "session-123");
  assert.equal(restarted.agentRuntime, undefined);
  assert.ok(restarted.activities.some(activity =>
    activity.kind === "message" && activity.text === "请从上次成果继续，补齐失败场景。"));
  assert.ok(restarted.activities.some(activity =>
    activity.kind === "accepted" && activity.text === "验收通过，结束目标。"));

  ended = (await service.read()).goals.find(goal => goal.id === first.id)!;
  assert.equal(ended.status, "active");
  assert.equal(ended.dispatch?.kind, "restart");
});

test("dropped concierge goals can restart, while active and personal goals cannot", async () => {
  const service = await serviceFixture();
  const dropped = await service.execute({
    type: "goal.create",
    input: {
      title: "重新打开放弃项",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await assert.rejects(service.execute({
    type: "goal.restart",
    goalId: dropped.id,
    note: "尚未结束",
  }), /只有已完成或已放弃/);
  await service.execute({
    type: "goal.drop",
    goalId: dropped.id,
    note: "先暂停",
  });
  const restarted = await service.execute({
    type: "goal.restart",
    goalId: dropped.id,
    note: "现在继续",
  }) as Goal;
  assert.equal(restarted.status, "active");

  const personal = await service.execute({
    type: "goal.intake",
    text: "个人事项",
    handling: "self",
  }) as Goal;
  await service.execute({
    type: "goal.complete",
    goalId: personal.id,
    note: "做完了",
  });
  await assert.rejects(service.execute({
    type: "goal.restart",
    goalId: personal.id,
    note: "重新做",
  }), /个人事项/);
});

test("owner resume identity is accepted only for an ended live owner", async () => {
  const service = await serviceFixture();
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "保存恢复信息",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  const resume = {
    owner: "owner-a",
    savedAt: new Date().toISOString(),
    agentSession: {
      source: "herdr:omp",
      agent: "omp",
      kind: "path" as const,
      value: "/tmp/omp-session.json",
    },
  };
  await assert.rejects(service.execute({
    type: "session.preserve",
    goalId: goal.id,
    resume,
  }), /已结束的目标/);
  await service.execute({
    type: "session.set",
    goalId: goal.id,
    reference: {
      session: "crewvane-test",
      tabId: "w1:t2",
      paneId: "w1:p2",
      agent: "owner-a",
    },
  });
  await service.execute({
    type: "goal.drop",
    goalId: goal.id,
    note: "稍后重启",
  });
  await service.execute({ type: "session.preserve", goalId: goal.id, resume });
  await service.execute({ type: "session.release", goalId: goal.id });
  const saved = (await service.read()).goals[0]!;
  assert.equal(saved.herdr, undefined);
  assert.equal(saved.ownerResume?.agentSession?.kind, "path");
  assert.equal(saved.ownerResume?.agentSession?.value, "/tmp/omp-session.json");
});
