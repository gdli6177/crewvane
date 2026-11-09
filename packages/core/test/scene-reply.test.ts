import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { WorkspaceService, attentionGoals, attentionRequest, type Goal } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("the concierge resolves the exact question from a scene receipt and records the user's original words", async () => {
  const { service, goal } = await fixture();
  const reply = await service.execute({
    type: "goal.scene-reply", goalId: goal.id, attentionId: goal.attention!.id!,
    quote: "先做核心范围，其他的下次再做。",
    summary: "核心范围已确认，等待决定记录后继续。", actor: "owner-a",
  }) as Goal;
  await assert.rejects(service.execute({
    type: "goal.resolve", goalId: goal.id, attentionId: reply.sceneReply!.attentionId,
    sceneReplyId: reply.sceneReply!.id, note: "Agent 自行批准", actor: "concierge",
  }), /必须记录用户原话/);
  await service.execute({
    type: "goal.resolve", goalId: goal.id, attentionId: reply.sceneReply!.attentionId,
    sceneReplyId: reply.sceneReply!.id, note: reply.sceneReply!.quote, actor: "concierge",
    outcome: "approved",
  });
  const state = await service.read();
  assert.equal(attentionGoals(state.goals).length, 0);
  assert.equal(state.goals[0]!.status, "active");
  assert.equal(state.goals[0]!.herdr?.agent, "owner-a", "the original owner continues");
  assert.equal(state.decisions[0]!.quote, reply.sceneReply!.quote);
  assert.equal(state.decisions[0]!.source, "Herdr 负责人现场");
});

test("late scene receipts cannot clear a replacement question or a newer human response", async () => {
  const { service, goal } = await fixture();
  const reply = await service.execute({
    type: "goal.scene-reply", goalId: goal.id, attentionId: goal.attention!.id!,
    quote: "先做核心范围", summary: "用户已选核心范围。", actor: "owner-a",
  }) as Goal;
  const newer = await service.execute({
    type: "goal.scene-reply", goalId: goal.id, attentionId: goal.attention!.id!,
    quote: "等一下，先不要开始", summary: "用户补充要求暂停，需管家重新判断。", actor: "owner-a",
  }) as Goal;
  await assert.rejects(service.execute({
    type: "goal.resolve", goalId: goal.id, attentionId: goal.attention!.id!,
    sceneReplyId: reply.sceneReply!.id, note: reply.sceneReply!.quote,
  }), /现场回复已经更新/);
  const question = await service.execute({
    type: "goal.decide", goalId: goal.id, question: "现在可以删除旧数据吗？",
  }) as Goal;
  assert.notEqual(question.attention!.id, goal.attention!.id);
  await assert.rejects(service.execute({
    type: "goal.resolve", goalId: goal.id, attentionId: goal.attention!.id!,
    sceneReplyId: newer.sceneReply!.id, note: newer.sceneReply!.quote,
  }), /待处理事项已经变化/);
  const final = (await service.read()).goals[0]!;
  assert.equal(final.attention!.id, question.attention!.id);
  assert.equal(attentionGoals([final]).length, 1);
});

test("receipt retries are idempotent and another goal's owner cannot submit them", async () => {
  const { service, goal } = await fixture();
  const command = {
    type: "goal.scene-reply" as const, goalId: goal.id, attentionId: goal.attention!.id!,
    quote: "先做核心范围", summary: "确认核心范围后继续。", actor: "owner-a",
  };
  await assert.rejects(service.execute({ ...command, actor: "owner-b" }), /登记的负责人/);
  const first = await service.execute(command) as Goal;
  const second = await service.execute(command) as Goal;
  assert.equal(second.dispatch!.id, first.dispatch!.id);
  assert.equal(second.activities.length, first.activities.length);
  await service.execute({ type: "goal.takeover", goalId: goal.id });
  await assert.rejects(service.execute(command), /已由你接管/);
});

test("a newer human desktop message invalidates an in-flight scene decision", async () => {
  const { service, goal } = await fixture();
  const replied = await service.execute({ type: "goal.scene-reply", goalId: goal.id,
    attentionId: goal.attention!.id!, quote: "先做核心范围。", summary: "已确认范围。", actor: "owner-a" }) as Goal;
  await service.execute({ type: "goal.message", goalId: goal.id, text: "等一下，先不要开始。" });
  await assert.rejects(service.execute({
    type: "goal.resolve", goalId: goal.id, attentionId: replied.sceneReply!.attentionId,
    sceneReplyId: replied.sceneReply!.id, note: replied.sceneReply!.quote,
  }), /现场回复已经更新/);
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
});

test("review acceptance and due follow-up replies close only their matching attention item", async () => {
  for (const kind of ["review", "follow_up"] as const) {
    const { service, goal } = await fixture();
    await service.execute({ type: "goal.resolve", goalId: goal.id, note: "核心范围" });
    if (kind === "review") await service.execute({
      type: "goal.review", goalId: goal.id, actor: "owner-a",
      delivery: { summary: "已实现核心范围。", checks: [{ name: "真实检查", command: "test", result: "passed" }] },
    });
    else await service.execute({ type: "goal.wait", goalId: goal.id, reason: "等待审批", owner: "YR",
      remindAt: new Date(Date.now() - 1000).toISOString() });
    const current = (await service.read()).goals[0]!;
    const reply = await service.execute({ type: "goal.scene-reply", goalId: goal.id,
      attentionId: attentionRequest(current)!.id, quote: kind === "review" ? "验收通过，结束目标。" : "已经收到审批结果，继续推进。",
      summary: "已收到用户明确答复。", actor: "owner-a" }) as Goal;
    if (kind === "follow_up") {
      await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "failed",
        requestId: reply.dispatch!.id, detail: "管家暂时离线" });
      assert.equal(attentionRequest((await service.read()).goals[0]!)!.id, reply.sceneReply!.attentionId,
        "a delivery failure must not replace an implicit due reminder's identity");
      await service.execute({ type: "goal.dispatch", goalId: goal.id, status: "pending" });
    }
    await service.execute(kind === "review" ? {
      type: "goal.accept", goalId: goal.id, attentionId: reply.sceneReply!.attentionId,
      sceneReplyId: reply.sceneReply!.id, note: reply.sceneReply!.quote, actor: "concierge",
    } : {
      type: "goal.progress", goalId: goal.id, attentionId: reply.sceneReply!.attentionId,
      sceneReplyId: reply.sceneReply!.id, summary: "审批结果已收到，继续实施。", actor: "concierge",
    });
    const final = (await service.read()).goals[0]!;
    assert.equal(attentionGoals([final]).length, 0);
    assert.equal(final.status, kind === "review" ? "completed" : "active");
    await assert.rejects(service.execute({ type: "goal.scene-reply", goalId: goal.id,
      attentionId: reply.sceneReply!.attentionId, quote: reply.sceneReply!.quote,
      summary: reply.sceneReply!.summary, actor: "owner-a" }));
  }
});

test("a reminder receipt retains its identity when delivery stamps the reminder, and only viewing never dismisses it", async () => {
  const { service, goal } = await fixture();
  await service.execute({ type: "goal.resolve", goalId: goal.id, note: "核心范围" });
  await service.execute({
    type: "goal.wait", goalId: goal.id, reason: "等待审批", owner: "YR",
    remindAt: new Date(Date.now() - 1000).toISOString(),
  });
  const before = (await service.read()).goals[0]!;
  const request = attentionRequest(before)!;
  await service.execute({
    type: "notification.sent", goalId: goal.id, kind: "follow_up", at: new Date().toISOString(),
  });
  const after = (await service.read()).goals[0]!;
  assert.equal(attentionRequest(after)!.id, request.id);
  await service.execute({
    type: "live.sync", presences: { [goal.id]: { state: "working", reachable: true, checkedAt: new Date().toISOString() } },
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
});
async function fixture() {
  const root = await mkdtemp("/tmp/cv-scene-reply-");
  roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({
    type: "goal.create",
    input: { title: "现场确认范围", projectId: "personal", mode: "concierge" },
  }) as Goal;
  await service.execute({
    type: "session.set", goalId: goal.id,
    reference: { session: "test", paneId: "w1:p2", tabId: "w1:t2", agent: "owner-a" },
  });
  const pending = await service.execute({
    type: "goal.decide", goalId: goal.id, question: "先交付核心范围吗？",
  }) as Goal;
  return { root, service, goal: pending };
}

test("a scene reply persists the human's words and notifies the concierge without pretending the decision is resolved", async () => {
  const { root, service, goal } = await fixture();
  assert.ok(goal.attention?.id, "each pending question needs an independent identity");
  const replied = await service.execute({
    type: "goal.scene-reply", goalId: goal.id, attentionId: goal.attention.id,
    quote: "先做核心范围，其他的下次再做。",
    summary: "已理解范围，将继续实现核心部分。", actor: "owner-a",
  }) as Goal;
  assert.equal(attentionGoals([replied]).length, 1);
  assert.equal(replied.attention?.id, goal.attention.id);
  assert.equal(replied.dispatch?.kind, "scene_reply");
  assert.equal(replied.dispatch?.status, "pending");
  assert.equal(replied.sceneReply?.attentionId, goal.attention.id);
  const persisted = (await new WorkspaceService(root).read()).goals[0]!;
  assert.equal(persisted.sceneReply?.quote, "先做核心范围，其他的下次再做。");
  assert.ok(persisted.activities.some(activity =>
    activity.actor === "你 · Herdr 现场" && activity.text === persisted.sceneReply?.quote));
});
