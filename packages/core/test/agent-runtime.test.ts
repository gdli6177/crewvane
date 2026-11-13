import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clipAgentRuntimeText,
  agentReceiptMarker,
  inspectWatchdog,
  WorkspaceService,
  type AgentRuntimeEventType,
  type AgentRuntimeEventV1,
  type Goal,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

const startedAt = "2030-01-01T08:00:00.000Z";
const at = (seconds: number) =>
  new Date(Date.parse(startedAt) + seconds * 1_000).toISOString();

test("replaying offline Hooks preserves a real semantic write made during that turn", async () => {
  const { service, goalId } = await fixture();
  const before = new Date(Date.now() - 1_000).toISOString();
  await service.execute({
    type: "goal.progress", goalId, actor: "owner-a",
    summary: "应用关闭时的真实写回", next: "恢复后核对",
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "offline", at: before }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "turn.settled", {
      turnId: "offline", at: new Date().toISOString(),
    }),
  });
  assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "written");
});

test("human takeover cancels automated receipts even if the old Agent emits another Stop", async () => {
  const { service, goalId } = await fixture();
  for (const event of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "before-takeover" }),
    runtimeEvent(goalId, 2, "turn.settled", { turnId: "before-takeover" }),
  ]) await service.execute({ type: "agent.runtime.event", event });
  await service.execute({ type: "goal.takeover", goalId });
  assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "cancelled");
  for (const event of [
    runtimeEvent(goalId, 3, "turn.started", { turnId: "after-takeover" }),
    runtimeEvent(goalId, 4, "turn.settled", { turnId: "after-takeover" }),
  ]) await service.execute({ type: "agent.runtime.event", event });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt, undefined);
  assert.equal(goal.mode, "manual");
});

test("a written Hook receipt beats Herdr idle, while expired receipt timers cannot hide true staleness", async () => {
  const { service, goalId } = await fixture();
  const start = new Date().toISOString();
  for (const item of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "written", at: start }),
    runtimeEvent(goalId, 2, "turn.settled", { turnId: "written", at: start }),
  ]) await service.execute({ type: "agent.runtime.event", event: item });
  await service.execute({
    type: "goal.progress", goalId, actor: "owner-a",
    summary: "真实进展", next: "继续后续验证",
  });
  await service.execute({
    type: "live.sync", presences: { [goalId]: {
      state: "done", reachable: true, checkedAt: start,
    } },
  });
  let goal = (await service.read()).goals[0]!;
  assert.deepEqual(inspectWatchdog([goal], new Date(Date.parse(start) + 120_000).toISOString()), []);
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 3, "turn.started", {
      turnId: "unwritten", at: new Date(Date.parse(start) + 1_000).toISOString(),
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 4, "turn.settled", { turnId: "unwritten", at: start }),
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "waiting");
  assert.equal(
    inspectWatchdog([goal], new Date(Date.parse(start) + 31 * 60_000).toISOString())[0]?.reason,
    "stale",
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-agent-runtime-"));
  roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: {
      title: "即时事件目标",
      description: "验证 Hook 与语义写回分离。",
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
      attemptId: "attempt_a",
      agent: "owner-a",
      adapter: "codex",
      startedAt,
    },
    hookTokenHash: "a".repeat(64),
    capabilities: [
      "session.started",
      "turn.started",
      "turn.settled",
      "agent.response",
    ],
  });
  return { service, goalId: goal.id };
}

function runtimeEvent(
  goalId: string,
  sequence: number,
  type: AgentRuntimeEventType,
  options: {
    attemptId?: string;
    turnId?: string;
    at?: string;
    text?: string;
    eventId?: string;
  } = {},
): AgentRuntimeEventV1 {
  return {
    version: "v1",
    eventId: options.eventId ?? `event-${sequence}`,
    sequence,
    at: options.at ?? at(sequence),
    source: "hook",
    agent: "owner-a",
    adapter: "codex",
    goalId,
    attemptId: options.attemptId ?? "attempt_a",
    type,
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.text
      ? { content: clipAgentRuntimeText(options.text) }
      : {}),
  };
}

test("runtime registration, event deduplication, sequence and attempt isolation are explicit", async () => {
  const { service, goalId } = await fixture();
  let runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.attempt.legacyScene?.reference.paneId, "w1:p2");
  assert.deepEqual(runtime.capabilities, [
    "session.started",
    "turn.started",
    "turn.settled",
    "agent.response",
  ]);

  const started = await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
  }) as { accepted: boolean };
  assert.equal(started.accepted, true);

  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", {
      turnId: "turn-1",
      eventId: "event-1",
    }),
  }), { accepted: false, reason: "duplicate" });

  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "agent.response", {
      turnId: "turn-1",
      eventId: "late-sequence",
    }),
  }), { accepted: false, reason: "late_event" });

  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "agent.response", {
      attemptId: "attempt_old",
      turnId: "turn-1",
      eventId: "old-attempt",
    }),
  }), { accepted: false, reason: "old_attempt" });

  runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.currentTurnId, "turn-1");
  assert.equal(runtime.lastSequence, 1);
  assert.deepEqual(runtime.seenEventIds, ["event-1"]);
});

test("a new turn advances after settle while a late event from the previous turn is rejected", async () => {
  const { service, goalId } = await fixture();
  for (const event of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
    runtimeEvent(goalId, 2, "agent.response", {
      turnId: "turn-1",
      text: "第一轮结果",
    }),
    runtimeEvent(goalId, 3, "turn.settled", {
      turnId: "turn-1",
      at: at(3),
    }),
    runtimeEvent(goalId, 4, "turn.started", { turnId: "turn-2" }),
  ]) {
    const result = await service.execute({
      type: "agent.runtime.event",
      event,
    }) as { accepted: boolean };
    assert.equal(result.accepted, true, `${event.type} ${event.turnId}`);
  }
  assert.equal(
    (await service.read()).goals[0]!.agentRuntime?.receipt,
    undefined,
  );

  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 5, "agent.response", {
      turnId: "turn-1",
      text: "迟到回复",
      eventId: "old-turn-reply",
    }),
  }), { accepted: false, reason: "old_turn" });
  const runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.currentTurnId, "turn-2");
  assert.equal(runtime.lastReply?.text, "第一轮结果");
});

test("a settled turn creates a receipt and semantic writes mark it written", async () => {
  const { service, goalId } = await fixture();
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "agent.response", {
      turnId: "turn-1",
      text: "实现完成，准备写回。",
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 3, "turn.settled", {
      turnId: "turn-1",
      at: at(3),
    }),
  });
  let runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.receipt?.status, "waiting");
  assert.equal(runtime.receipt?.remindAt, at(8));
  assert.equal(runtime.receipt?.inspectAt, at(38));
  assert.equal(runtime.lastReply?.text, "实现完成，准备写回。");

  await service.execute({
    type: "goal.progress",
    goalId,
    actor: "owner-a",
    summary: "已完成实现并通过检查。",
    next: "提交验收。",
  });
  runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.lastSemanticWriteTurnId, "turn-1");
  assert.equal(runtime.receipt?.status, "written");
});

test("receipt escalation is reminder-once and protocol_missing without treating Stop as completion", async () => {
  const { service, goalId } = await fixture();
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "turn.settled", {
      turnId: "turn-1",
      at: at(2),
    }),
  });

  assert.deepEqual(await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "protocol_missing",
    at: at(7),
  }), { updated: false, reason: "reminder_not_sent" });

  const reminded = await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "reminded",
    at: at(7),
  }) as { updated: boolean; goal: Goal };
  assert.equal(reminded.updated, true);
  assert.equal(reminded.goal.status, "active");
  assert.equal(reminded.goal.attention, null);
  assert.equal(reminded.goal.agentRuntime?.receipt?.status, "reminded");

  assert.deepEqual(await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "reminded",
    at: at(8),
  }), { updated: false, reason: "already_reminded" });

  const missing = await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "protocol_missing",
    at: at(37),
  }) as { updated: boolean; goal: Goal };
  assert.equal(missing.updated, true);
  assert.equal(missing.goal.status, "active");
  assert.equal(missing.goal.attention, null);
  assert.equal(missing.goal.agentRuntime?.receipt?.status, "protocol_missing");
  assert.equal(missing.goal.watchdog?.reason, "protocol_missing");
});

test("new Hook turns, direct input and ending a goal cancel old receipt work", async () => {
  const { service, goalId } = await fixture();
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "turn.settled", {
      turnId: "turn-1",
      at: at(2),
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 3, "turn.started", { turnId: "turn-2" }),
  });
  assert.equal(
    (await service.read()).goals[0]!.agentRuntime?.receipt,
    undefined,
  );
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 4, "turn.settled", {
      turnId: "turn-2",
      at: at(4),
    }),
  });
  await service.execute({
    type: "goal.message",
    goalId,
    text: "我补充一条新信息，请重新核对。",
  });
  let goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "cancelled");

  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 5, "turn.started", { turnId: "turn-3" }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 6, "turn.settled", {
      turnId: "turn-3",
      at: at(6),
    }),
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "waiting");

  await service.execute({
    type: "goal.direct",
    goalId,
    text: "现场补充：不要再按旧方案执行。",
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "cancelled");

  await service.execute({
    type: "goal.complete",
    goalId,
    actor: "你",
    note: "确认结束。",
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "completed");
  assert.equal(goal.agentRuntime?.receipt?.status, "cancelled");
});

test("Hook heartbeat never becomes business activity or postpones stale detection", async () => {
  const { service, goalId } = await fixture();
  const before = (await service.read()).goals[0]!;
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", {
      turnId: "turn-1",
      at: at(20 * 60),
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "agent.response", {
      turnId: "turn-1",
      text: "仍在执行。",
      at: at(20 * 60 + 10),
    }),
  });
  const after = (await service.read()).goals[0]!;
  assert.equal(after.activities.length, before.activities.length);
  const requests = inspectWatchdog([after], at(31 * 60));
  assert.equal(requests[0]?.reason, "stale");
});

test("a blocked Hook can recover from a newer Herdr working heartbeat", async () => {
  const { service, goalId } = await fixture();
  const base = Date.parse((await service.read()).goals[0]!.createdAt);
  const relative = (seconds: number) =>
    new Date(base + seconds * 1_000).toISOString();
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", {
      turnId: "turn-1",
      at: relative(1),
    }),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 2, "agent.blocked", {
      turnId: "turn-1",
      at: relative(2),
    }),
  });
  await service.execute({
    type: "live.sync",
    presences: {
      [goalId]: { state: "working", checkedAt: relative(9), reachable: true },
    },
  });
  assert.deepEqual(
    inspectWatchdog([(await service.read()).goals[0]!], relative(10)),
    [],
  );
});

test("a late Hook event cannot revive an ended goal", async () => {
  const { service, goalId } = await fixture();
  await service.execute({
    type: "goal.complete",
    goalId,
    actor: "你",
    note: "已经确认结束。",
  });
  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 1, "turn.started", { turnId: "late-turn" }),
  }), { accepted: false, reason: "goal_ended" });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "completed");
  assert.equal(goal.agentRuntime?.currentTurnId, undefined);
});

test("a structured write after protocol_missing clears the stale watchdog prompt", async () => {
  const { service, goalId } = await fixture();
  for (const event of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
    runtimeEvent(goalId, 2, "turn.settled", {
      turnId: "turn-1",
      at: at(2),
    }),
  ]) {
    await service.execute({ type: "agent.runtime.event", event });
  }
  await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "reminded",
    at: at(7),
  });
  await service.execute({
    type: "agent.runtime.receipt",
    goalId,
    attemptId: "attempt_a",
    turnId: "turn-1",
    stage: "protocol_missing",
    at: at(37),
  });
  assert.equal(
    (await service.read()).goals[0]!.watchdog?.reason,
    "protocol_missing",
  );

  await service.execute({
    type: "goal.progress",
    goalId,
    actor: "owner-a",
    summary: "补交真实结果与下一步。",
    next: "等待验收。",
  });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.agentRuntime?.receipt?.status, "written");
  assert.equal(goal.watchdog, undefined);
});

test("a concierge reconciliation note cannot satisfy an owner write-back or restart settled patrol", async () => {
  const { service, goalId } = await fixture();
  const current = Date.now();
  const liveAt = new Date(current - 120_000).toISOString();
  const inspectAt = new Date(current + 100_000).toISOString();
  await service.execute({
    type: "live.sync",
    presences: {
      [goalId]: { state: "idle", reachable: true, checkedAt: liveAt },
    },
  });
  const [request] = await service.execute({
    type: "watchdog.inspect",
    at: inspectAt,
  }) as Awaited<ReturnType<typeof inspectWatchdog>>;
  assert.equal(request?.reason, "settled");
  await service.execute({
    type: "watchdog.report",
    goalId,
    at: inspectAt,
    basis: request!.basis,
    outcome: "contacted",
  });

  await service.execute({
    type: "goal.progress",
    goalId,
    actor: "concierge",
    summary: "已核对负责人和现有成果，尚未发现新的可确认结果。",
    next: "继续核对原负责人。",
  });
  let goal = (await service.read()).goals[0]!;
  assert.equal(goal.watchdog?.reason, "settled");
  assert.ok(goal.activities.some(activity =>
    activity.actor === "concierge" &&
    activity.text.includes("尚未发现新的可确认结果")));
  assert.deepEqual(await service.execute({
    type: "watchdog.inspect",
    at: new Date(current + 240_000).toISOString(),
  }), []);
  assert.equal((await service.read()).goals[0]!.watchdog?.reason, "settled");

  await service.execute({
    type: "goal.progress",
    goalId,
    actor: "owner-a",
    summary: "负责人已补交真实结果并对齐下一步。",
    next: "继续执行。",
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.watchdog, undefined);
});

test("an automatic receipt turn cannot trigger a reminder chain and its write-back satisfies the original receipt", async () => {
  const { service, goalId } = await fixture();
  for (const event of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "original" }),
    runtimeEvent(goalId, 2, "turn.settled", { turnId: "original" }),
  ]) await service.execute({ type: "agent.runtime.event", event });
  await service.execute({
    type: "agent.runtime.receipt", goalId, attemptId: "attempt_a",
    turnId: "original", stage: "reminding", at: at(7),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 3, "turn.started", {
      turnId: "auto-reminder",
      text: `${agentReceiptMarker("attempt_a", "original")}\n请补交结构化结果`,
    }),
  });
  await service.execute({
    type: "agent.runtime.receipt", goalId, attemptId: "attempt_a",
    turnId: "original", stage: "reminded", at: at(9),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 4, "turn.settled", { turnId: "auto-reminder" }),
  });
  let runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.receipt?.turnId, "original");
  assert.equal(runtime.receipt?.status, "reminded");
  assert.equal(runtime.receipt?.inspectAt, at(39));
  await service.execute({
    type: "goal.progress", goalId, actor: "owner-a",
    summary: "自动提醒后补齐的实际结果。", next: "继续原目标",
  });
  runtime = (await service.read()).goals[0]!.agentRuntime!;
  assert.equal(runtime.receipt?.status, "written");
});

test("replayed Stop and old turn starts cannot reset a sent reminder", async () => {
  const { service, goalId } = await fixture();
  for (const event of [
    runtimeEvent(goalId, 1, "turn.started", { turnId: "turn-1" }),
    runtimeEvent(goalId, 2, "turn.settled", { turnId: "turn-1" }),
  ]) await service.execute({ type: "agent.runtime.event", event });
  await service.execute({
    type: "agent.runtime.receipt", goalId, attemptId: "attempt_a",
    turnId: "turn-1", stage: "reminded", at: at(7),
  });
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 3, "turn.settled", { turnId: "turn-1" }),
  });
  assert.equal((await service.read()).goals[0]!.agentRuntime?.receipt?.status, "reminded");
  await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 4, "turn.started", { turnId: "turn-2" }),
  });
  assert.deepEqual(await service.execute({
    type: "agent.runtime.event",
    event: runtimeEvent(goalId, 5, "turn.started", { turnId: "turn-1" }),
  }), { accepted: false, reason: "old_turn" });
});
