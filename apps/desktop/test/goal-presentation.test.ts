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
  goalProgressLabel,
  goalSystemActivities,
  presentGoal,
} from "../src/features/goals/goalPresentation.ts";
import { inspectWatchdog } from "../../../packages/core/src/watchdog.ts";
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

test("an unconfirmed handoff is presented without asking for a duplicate send", async () => {
  const root = await fixture();
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "现场确认中",
      projectId: "personal",
      mode: "concierge",
    },
  }) as Goal;
  await service.execute({
    type: "goal.dispatch",
    goalId: goal.id,
    status: "unconfirmed",
    requestId: goal.dispatch!.id,
    detail: "Herdr 已提交任务，但状态确认超时；先以现场为准，不重复发送。",
  });

  const state = await service.read();
  const view = presentGoal(state.goals[0]!, state);
  assert.equal(view.dispatchFailed, false);
  assert.equal(view.label, "已提交，等待现场确认");
  assert.equal(view.tone, "waiting");
  assert.match(view.detail, /不重复发送/);
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
  assert.equal(current.status, "active");
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

test("an idle owner is only pending reconciliation after a real watchdog request", async () => {
  const service = new WorkspaceService(await fixture());
  const goal = await service.execute({ type:"goal.create", input:{
    title:"负责人已空闲", projectId:"personal", mode:"concierge",
  } }) as Goal;
  await service.execute({ type:"session.set", goalId:goal.id, reference:{
    session:"test", paneId:"w1:p2", agent:"owner-a",
  } });
  await service.execute({ type:"live.sync", presences:{ [goal.id]:{
    state:"done", reachable:true, checkedAt:new Date(Date.now()-120_000).toISOString(),
  } } });
  let state = await service.read(), current = state.goals[0]!;
  assert.equal(goalProgressLabel(current), "负责人空闲");
  assert.equal(presentGoal(current, state).label, "负责人空闲");
  assert.doesNotMatch(presentGoal(current, state).detail, /结果尚未写回|管家会核对/);
  assert.doesNotMatch(presentGoal(current, state).detail, /正在执行/);
  await service.execute({ type:"watchdog.inspect", at:new Date().toISOString() });
  state = await service.read(); current = state.goals[0]!;
  assert.equal(goalProgressLabel(current), "待管家核对");
  assert.equal(current.attention, null);
  assert.equal(presentGoal(current, state).label, "待管家核对");
  const watchdog = structuredClone(current.watchdog!);
  await service.execute({
    type:"watchdog.report", goalId:goal.id, at:new Date().toISOString(),
    basis:watchdog.basis, outcome:"contacted",
  });
  state = await service.read(); current = state.goals[0]!;
  assert.equal(goalProgressLabel(current), "已请管家核对");
  assert.equal(presentGoal(current, state).label, "已请管家核对");
  await service.execute({ type:"live.sync", presences:{ [goal.id]:{
    state:"working", reachable:true, checkedAt:new Date().toISOString(),
  } } });
  assert.equal(goalProgressLabel((await service.read()).goals[0]!), "执行中");
  assert.equal(inspectWatchdog((await service.read()).goals, new Date().toISOString()).length, 0);
});

async function writtenRuntimeFixture() {
  const service = new WorkspaceService(await fixture());
  const goal = await service.execute({
    type: "goal.direct", text: "已回报的空闲负责人",
  }) as Goal;
  const startedAt = new Date().toISOString();
  await service.execute({
    type: "session.set", goalId: goal.id,
    reference: { session: "test", paneId: "w1:p2", agent: "owner-a" },
  });
  await service.execute({
    type: "agent.runtime.register", goalId: goal.id,
    attempt: { goalId: goal.id, attemptId: "attempt_a", agent: "owner-a",
      adapter: "codex", startedAt },
    hookTokenHash: "a".repeat(64),
    capabilities: ["turn.started", "turn.settled"],
  });
  for (const [sequence, type] of [[1, "turn.started"], [2, "turn.settled"]] as const)
    await service.execute({
      type: "agent.runtime.event",
      event: { version: "v1", eventId: `event-${sequence}`, sequence, type,
        at: startedAt, source: "hook", adapter: "codex", agent: "owner-a",
        goalId: goal.id, attemptId: "attempt_a", turnId: "turn-a" },
    });
  await service.execute({
    type: "goal.progress", goalId: goal.id, actor: "owner-a",
    summary: "两种接入方案已核实，结论及依据已写回。",
    next: "继续按已确认的方案推进。",
  });
  await service.execute({
    type: "live.sync",
    presences: { [goal.id]: { state: "idle", reachable: true, checkedAt: startedAt } },
  });
  return { service, goalId: goal.id, startedAt };
}

test("a written turn and idle concierge never imply an outstanding reconciliation", async () => {
  const { service, goalId, startedAt } = await writtenRuntimeFixture();
  await service.execute({ type: "concierge.status", status: "ready",
    live: { state: "idle", reachable: true, checkedAt: startedAt } });
  assert.deepEqual(await service.execute({
    type: "watchdog.inspect",
    at: new Date(Date.parse(startedAt) + 120_000).toISOString(),
  }), []);
  const state = await service.read(), goal = state.goals.find(item => item.id === goalId)!;
  assert.equal(goal.status, "active");
  assert.equal(goal.agentRuntime?.receipt?.status, "written");
  assert.equal(goal.watchdog, undefined);
  assert.equal(goalProgressLabel(goal), "本轮已回报");
  const view = presentGoal(goal, state);
  assert.equal(view.label, "本轮已回报");
  assert.match(view.detail, /已写回/);
  assert.doesNotMatch(view.detail, /尚未写回|管家.*核对/);
  assert.match(view.brief, /两种接入方案已核实/);
  // Old recovery hints cannot manufacture a new reconciliation request.
  const legacyHint = { ...goal, recovery: "idle" as const };
  assert.equal(goalProgressLabel(legacyHint), "本轮已回报");
  assert.equal(presentGoal(legacyHint, state).label, "本轮已回报");
});

test("a written turn does not hide a later genuine business-staleness check", async () => {
  const { service, startedAt } = await writtenRuntimeFixture();
  const [request] = await service.execute({
    type: "watchdog.inspect",
    at: new Date(Date.parse(startedAt) + 31 * 60_000).toISOString(),
  }) as { reason: string }[];
  assert.equal(request?.reason, "stale");
  const state = await service.read(), goal = state.goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "written");
  assert.equal(goalProgressLabel(goal), "待管家核对");
  assert.equal(presentGoal(goal, state).label, "待管家核对");
  assert.doesNotMatch(presentGoal(goal, state).detail, /尚未写回/);
});

test("new turns and actual missing receipts replace the old written presentation", async () => {
  const { service, goalId } = await writtenRuntimeFixture();
  for (const [sequence, type] of [[3, "turn.started"], [4, "turn.settled"]] as const)
    await service.execute({
      type: "agent.runtime.event",
      event: { version: "v1", eventId: `event-${sequence}`, sequence, type,
        at: new Date().toISOString(), source: "hook", adapter: "codex", agent: "owner-a",
        goalId, attemptId: "attempt_a", turnId: "turn-b" },
    });
  const state = await service.read(), goal = state.goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "waiting");
  assert.equal(goalProgressLabel(goal), "检查回执");
  assert.equal(presentGoal(goal, state).label, "检查回执");
});

test("semantic human requests, external waiting and manual ownership outrank idle runtime state", async () => {
  const { service, goalId } = await writtenRuntimeFixture();
  await service.execute({ type: "goal.decide", goalId,
    question: "请提供实际调用示例，以便继续验证。", actor: "owner-a" });
  let state = await service.read(), view = presentGoal(state.goals[0]!, state);
  assert.equal(view.label, "等你决定");
  assert.equal(view.needsDecision, true);
  assert.match(view.brief, /请提供实际调用示例/);
  assert.equal(goalProgressLabel(state.goals[0]!), "等你决定");
  await service.execute({ type: "goal.resolve", goalId, note: "示例已提供", actor: "你" });
  await service.execute({ type: "goal.wait", goalId,
    reason: "供应商核对实际调用权限", owner: "外部供应商", actor: "owner-a" });
  state = await service.read(); view = presentGoal(state.goals[0]!, state);
  assert.equal(view.label, "等待外部");
  assert.equal(goalProgressLabel(state.goals[0]!), "等待外部");
  await service.execute({ type: "goal.takeover", goalId });
  state = await service.read(); view = presentGoal(state.goals[0]!, state);
  assert.equal(view.label, "由你处理");
  assert.equal(goalProgressLabel(state.goals[0]!), "由你处理");
  assert.match(view.detail, /由你安排/);
});

test("runtime labels describe lost connections and pending input without inventing reconciliation", async () => {
  const { service, goalId } = await writtenRuntimeFixture();
  for (const [state, reachable, expected] of [
    ["idle", false, "现场连接中断"],
    ["blocked", true, "现场待输入"],
    ["working", true, "执行中"],
  ] as const) {
    await service.execute({ type: "live.sync", presences: {
      [goalId]: { state, reachable, checkedAt: new Date().toISOString() },
    } });
    const snapshot = await service.read(), goal = snapshot.goals[0]!;
    assert.equal(goalProgressLabel(goal), expected);
    assert.equal(presentGoal(goal, snapshot).label, expected);
  }
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
  assert.equal(presentGoal(current, state).label, "现场答复待同步");
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
