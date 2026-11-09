import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  WorkspaceService, attentionGoals, attentionRequest, taskPoolGoals,
  importAttachmentBytes, type Goal, type CrewvaneCommand,
} from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp("/tmp/cv-task-pool-");
  roots.push(root);
  return { root, service: new WorkspaceService(root) };
}

test("capturing a thought persists without dispatch, attention, an owner or stale-work escalation", async () => {
  const { root, service } = await fixture();
  const item = await service.execute({ type: "goal.intake", handling: "later",
    text: "有空再研究新版定价，不要现在开始。" }) as Goal;
  assert.equal(item.status, "backlog");
  assert.equal(item.mode, "manual");
  assert.equal(item.dispatch, undefined);
  assert.equal(item.herdr, undefined);
  const later = new Date(Date.now() + 7 * 86400_000).toISOString();
  assert.deepEqual(await service.execute({ type: "watchdog.inspect", at: later }), []);
  const state = await new WorkspaceService(root).read();
  assert.equal(state.recovery, undefined);
  assert.equal(state.goals[0]?.status, "backlog");
  assert.equal(attentionGoals(state.goals, Date.parse(later)).length, 0);
  assert.equal(taskPoolGoals(state.goals, "later").length, 1);
});

test("notes and progress APIs cannot silently authorize a deferred goal", async () => {
  const { service } = await fixture();
  const item = await service.execute({ type: "goal.intake", handling: "later", text: "以后考虑" }) as Goal;
  await service.execute({ type: "goal.message", goalId: item.id, text: "先把背景记录下来。" });
  await service.execute({ type: "goal.direct", goalId: item.id, text: "从终端继续记一条背景，不开始。" });
  await service.execute({ type: "goal.update", goalId: item.id, patch: { description: "保留这些补充背景" } });
  const commands: CrewvaneCommand[] = [
    { type: "goal.message", goalId: item.id, text: "普通补充", routeToConcierge: true },
    { type: "goal.progress", goalId: item.id, summary: "偷偷开始执行" },
    { type: "goal.update", goalId: item.id, patch: { status: "active" } },
    { type: "goal.wait", goalId: item.id, reason: "虚构等待" },
    { type: "goal.decide", goalId: item.id, question: "能开始吗？" },
    { type: "goal.dispatch", goalId: item.id, status: "pending" },
    { type: "session.set", goalId: item.id, reference: { session: "test", agent: "owner-x" } },
  ];
  for (const command of commands) await assert.rejects(service.execute(command));
  const saved = (await service.read()).goals[0]!;
  assert.equal(saved.status, "backlog");
  assert.equal(saved.dispatch, undefined);
  assert.equal(saved.activities.length, 4);
});

test("personal tasks complete directly and do not need a delivery or agent session", async () => {
  const { service } = await fixture();
  const item = await service.execute({ type: "goal.intake", handling: "self", text: "去办签证" }) as Goal;
  assert.equal(item.mode, "manual");
  assert.equal(item.status, "active");
  assert.equal(item.owner, "你");
  assert.equal(item.dispatch, undefined);
  assert.equal(attentionGoals([item]).length, 0);
  const complete = await service.execute({ type: "goal.complete", goalId: item.id, note: "我已办完。" }) as Goal;
  assert.equal(complete.status, "completed");
  assert.equal(complete.delivery, undefined);
  assert.equal(taskPoolGoals([complete], "self").length, 0);
});

test("reminders for captured and personal tasks become due without changing ownership or starting agents", async () => {
  const { service } = await fixture();
  for (const handling of ["later", "self"] as const) {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const item = await service.execute({ type: "goal.intake", handling, text: "提醒我安排这件事", remindAt: future }) as Goal;
    assert.equal(attentionGoals([item]).length, 0);
    const due = attentionRequest(item, Date.parse(future));
    assert.equal(due?.kind, "follow_up");
    assert.equal(attentionGoals([item], Date.parse(future)).length, 1);
    await service.execute({ type: "goal.remind", goalId: item.id, at: new Date(Date.now() - 1000).toISOString() });
    let saved = (await service.read()).goals.find(goal => goal.id === item.id)!;
    const requestId = attentionRequest(saved)?.id;
    await service.execute({ type: "goal.message", goalId: item.id, text: "只是记录备注，还没有处理。" });
    saved = (await service.read()).goals.find(goal => goal.id === item.id)!;
    assert.equal(attentionRequest(saved)?.id, requestId, "adding notes does not dismiss a personal reminder");
    await service.execute({ type: "goal.resolve", goalId: item.id, attentionId: requestId, note: "提醒已处理，这件事仍先放着。" });
    saved = (await service.read()).goals.find(goal => goal.id === item.id)!;
    assert.equal(saved.status, item.status);
    assert.equal(saved.mode, "manual");
    assert.equal(saved.dispatch, undefined);
    assert.equal(attentionGoals([saved]).length, 0);
    await service.execute({ type: "notification.sent", goalId: item.id, kind: "follow_up", at: new Date().toISOString() });
    assert.equal(attentionGoals((await service.read()).goals).length, 0, "a late notification receipt cannot resurrect an acknowledged reminder");
  }
});

test("starting a captured goal keeps its project, images and history, and delegation retries share one handoff", async () => {
  const { root, service } = await fixture();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aW3sAAAAASUVORK5CYII=", "base64");
  const attachments = await importAttachmentBytes(root, [{ name: "idea.png", bytes }]);
  const project = await service.execute({ type: "project.add", name: "研究" }) as { id: string };
  const item = await service.execute({ type: "goal.intake", handling: "later", projectId: project.id,
    text: "研究这个界面", attachments }) as Goal;
  const started = await service.execute({ type: "goal.takeover", goalId: item.id }) as Goal;
  assert.equal(started.status, "active");
  assert.equal(started.mode, "manual");
  const results = await Promise.all([
    service.execute({ type: "goal.delegate", goalId: item.id }),
    service.execute({ type: "goal.delegate", goalId: item.id }),
  ]) as Goal[];
  assert.equal(results[0]!.dispatch?.id, results[1]!.dispatch?.id);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" });
  const retried = await service.execute({ type: "goal.delegate", goalId: item.id }) as Goal;
  assert.equal(retried.id, item.id);
  assert.equal(retried.projectId, project.id);
  assert.equal(retried.description, item.description);
  assert.deepEqual(retried.attachments, item.attachments);
  assert.equal(retried.activities.filter(activity => activity.text === "已重新交给管家统筹。").length, 1);
  assert.equal(retried.dispatch?.status, "sent");
  assert.equal(retried.mode, "concierge");
  assert.equal(taskPoolGoals([retried], "later").length + taskPoolGoals([retried], "self").length, 0);
});

test("removed personal items retain their history and can be restored without authorizing execution", async () => {
  const { service } = await fixture();
  const item = await service.execute({ type: "goal.intake", handling: "later", text: "可能以后要做" }) as Goal;
  await service.execute({ type: "goal.drop", goalId: item.id, note: "先移出待办池" });
  assert.equal(taskPoolGoals((await service.read()).goals, "later").length, 0);
  const restored = await service.execute({ type: "goal.restore", goalId: item.id }) as Goal;
  assert.equal(restored.status, "backlog");
  assert.equal(restored.mode, "manual");
  assert.equal(restored.dispatch, undefined);
  assert.ok(restored.activities.some(activity => activity.text === "先移出待办池"));
});

test("delegation does not dismiss an unresolved personal decision", async () => {
  const { service } = await fixture();
  const item = await service.execute({ type: "goal.intake", handling: "self", text: "人工安排的变更" }) as Goal;
  const asked = await service.execute({ type: "goal.risk", goalId: item.id, category: "change-permissions",
    summary: "是否增加管理员权限？" }) as Goal;
  await assert.rejects(service.execute({ type: "goal.delegate", goalId: item.id }), /先处理当前/);
  assert.equal(attentionRequest((await service.read()).goals[0]!)?.id, asked.attention!.id);
});
