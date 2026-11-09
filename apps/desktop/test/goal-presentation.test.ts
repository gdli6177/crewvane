import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type Goal,
} from "../../../packages/core/src/index.ts";
import {
  goalConversationActivities,
  goalSystemActivities,
  presentGoal,
} from "../src/features/goals/goalPresentation.ts";
import { pendingSceneReply } from "../../../packages/core/src/model.ts";

async function fixture() {
  return mkdtemp(join(tmpdir(), "crewvane-goal-presentation-"));
}

test("dispatch failure is presented as contact failure, not owner intervention", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "离线派发",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "goal.dispatch",
    goalId: goal.id,
    status: "failed",
    requestId: goal.dispatch!.id,
    detail: "管家暂时不可达",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(view.dispatchFailed, true);
  assert.equal(view.needsIntervention, false);
  assert.equal(view.label, "联系管家失败");
  assert.equal(view.tone, "blocked");
});

test("the latest raw message and its attachments remain visible without changing status", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "消息详情",
      projectId: "personal",
      mode: "manual",
      next: "按原计划继续",
    },
  }) as Goal;
  await service.execute({
    type: "goal.message",
    goalId: goal.id,
    text: "只补充背景，不改下一步。",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(view.latest?.kind, "message");
  assert.equal(view.latest?.text, "只补充背景，不改下一步。");
  assert.equal(current.next, "按原计划继续");
  assert.equal(current.status, "waiting");
});

test("the summary keeps the latest agent reply when newer user context arrives", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "保留执行反馈",
      projectId: "personal",
      mode: "concierge",
      next: "整理验收材料",
    },
  }) as Goal;
  await service.execute({
    type: "goal.message",
    goalId: goal.id,
    actor: "负责人",
    text: "已核对三份材料，结论都在附件清单中。",
  });
  await service.execute({
    type: "goal.message",
    goalId: goal.id,
    text: "补充一句背景，先不要改下一步。",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(view.latest?.text, "补充一句背景，先不要改下一步。");
  assert.equal(view.latestAgentReply?.actor, "负责人");
  assert.equal(view.latestAgentReply?.text, "已核对三份材料，结论都在附件清单中。");
  assert.match(view.brief, /已核对三份材料/);
  assert.equal(view.nextLabel, "接下来的安排");
});

test("a manual active goal is presented as owned by the human", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "人工推进",
      projectId: "personal",
      mode: "concierge",
      next: "整理结论后提交",
    },
  }) as Goal;
  await service.execute({ type: "goal.takeover", goalId: goal.id });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  assert.equal(current.mode, "manual");
  assert.equal(view.label, "由你处理");
  assert.match(view.detail, /标记完成/);
});

test("decision context uses the latest agent handoff while keeping transport events out of conversation", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "选择实现方向",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "goal.progress",
    goalId: goal.id,
    summary: "负责人完成了两种方案的对比，并建议先保品牌辨识度。",
    actor: "负责人",
  });
  await service.execute({
    type: "goal.decide",
    goalId: goal.id,
    question: "先保品牌辨识度，还是先直白解释功能？",
    actor: "管家",
  });
  await service.execute({
    type: "goal.dispatch",
    goalId: goal.id,
    status: "failed",
    detail: "运行时连接失败",
  });

  const state = await service.read();
  const current = state.goals.find((item) => item.id === goal.id)!;
  const view = presentGoal(current, state);
  const conversation = goalConversationActivities(current);
  const system = goalSystemActivities(current);
  const historyWithoutContext = goalConversationActivities(current, [
    view.contextActivity!.id,
  ]);
  assert.equal(view.needsDecision, true);
  assert.match(view.contextActivity?.text ?? "", /两种方案的对比/);
  assert.equal(conversation[0]?.kind, "decision");
  assert.ok(
    historyWithoutContext.every(
      (activity) => activity.id !== view.contextActivity!.id,
    ),
  );
  assert.ok(conversation.every((activity) => activity.kind !== "session"));
  assert.ok(system.some((activity) => activity.kind === "session"));
  assert.ok(
    conversation.every(
      (activity, index) =>
        index === 0 ||
        Date.parse(conversation[index - 1]!.at) >= Date.parse(activity.at),
    ),
  );
});

test("scene receipts show synchronization separately from the unanswered decision and offer retry on failure", async () => {
  const service = new WorkspaceService(await fixture());
  const item = await service.execute({ type: "goal.intake", text: "现场答复显示" }) as Goal;
  await service.execute({ type: "session.set", goalId: item.id,
    reference: { session: "cv-test", agent: "owner-a", paneId: "w1:p2" } });
  const request = await service.execute({ type: "goal.decide", goalId: item.id, question: "先做核心范围？" }) as Goal;
  await service.execute({ type: "goal.scene-reply", goalId: item.id, attentionId: request.attention!.id!,
    quote: "先做核心范围。", summary: "已确认范围，等管家记录决定。", actor: "owner-a" });
  let state = await service.read(), current = state.goals[0]!;
  assert.equal(presentGoal(current, state).label, "现场已答复，管家核对中");
  await service.execute({ type: "goal.dispatch", goalId: item.id, requestId: current.dispatch!.id,
    status: "failed", detail: "管家暂时离线" });
  state = await service.read(); current = state.goals[0]!;
  const view = presentGoal(current, state);
  assert.equal(view.needsDecision, true);
  assert.equal(view.sceneSync?.quote, "先做核心范围。");
  assert.equal(view.sceneSync?.retry, "dispatch");
  assert.equal(view.label, "现场答复同步失败");
  await service.execute({ type: "goal.takeover", goalId: item.id });
  assert.equal(pendingSceneReply((await service.read()).goals[0]!), undefined);
});
