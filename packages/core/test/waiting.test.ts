import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, attentionGoals, type Goal } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function waiting() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-waiting-"));
  roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.create", input: {
    title: "等待审批", projectId: "personal", mode: "concierge",
  } }) as Goal;
  await service.execute({ type: "session.set", goalId: goal.id,
    reference: { session: "trial", agent: "owner", paneId: "w1:p2" } });
  await service.execute({ type: "goal.wait", goalId: goal.id, reason: "等 YR",
    owner: "YR", remindAt: "2020-01-01T00:00:00Z" });
  return { service, id: goal.id };
}

test("resume clears waiting and reminder, preserves owner site and persists a pending handoff", async () => {
  const { service, id } = await waiting();
  await service.execute({ type: "goal.resume", goalId: id, note: "YR 已批准，继续开发", mode: "concierge" });
  const goal = (await new WorkspaceService(service.root).read()).goals[0]!;
  assert.equal(goal.status, "active");
  assert.equal(goal.waitingFor, undefined);
  assert.equal(goal.remindAt, undefined);
  assert.equal(goal.owner, "owner");
  assert.equal(goal.herdr?.paneId, "w1:p2");
  assert.equal(goal.next, "YR 已批准，继续开发");
  assert.equal(goal.dispatch?.status, "pending");
  assert.equal(goal.dispatch?.kind, "resume");
  assert.ok(goal.dispatch?.id);
  assert.equal(attentionGoals([goal]).length, 0);
});

test("follow-up is active coordination and retry retains its instruction", async () => {
  const { service, id } = await waiting();
  await service.execute({ type: "goal.followup", goalId: id, note: "请核查审批进展" });
  const request = (await service.read()).goals[0]!.dispatch!;
  await service.execute({ type: "goal.dispatch", goalId: id, status: "failed", requestId: request.id, detail: "离线" });
  await service.execute({ type: "goal.dispatch", goalId: id, status: "pending" });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "active");
  assert.equal(goal.waitingFor, undefined);
  assert.equal(goal.remindAt, undefined);
  assert.equal(goal.dispatch?.kind, "follow_up");
  assert.equal(goal.dispatch?.note, "请核查审批进展");
  assert.notEqual(goal.dispatch?.id, request.id);
});

test("manual takeover cancels pending handoff and stale acknowledgements cannot dispatch it again", async () => {
  const { service, id } = await waiting();
  await service.execute({ type: "goal.followup", goalId: id });
  const requestId = (await service.read()).goals[0]!.dispatch!.id;
  await service.execute({ type: "goal.takeover", goalId: id });
  await service.execute({ type: "goal.dispatch", goalId: id, status: "sent", requestId });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.mode, "manual");
  assert.equal(goal.owner, "你");
  assert.equal(goal.dispatch, undefined);
  assert.equal(goal.status, "active");
});

test("snooze clears only the due reminder attention; terminal goals cannot resume", async () => {
  const { service, id } = await waiting();
  await service.execute({ type: "notification.sent", goalId: id, kind: "follow_up", at: "2021-01-01T00:00:00Z" });
  await service.execute({ type: "goal.remind", goalId: id, at: "2030-01-01T09:00:00Z" });
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  await service.execute({ type: "goal.drop", goalId: id });
  await assert.rejects(service.execute({ type: "goal.resume", goalId: id, note: "继续", mode: "concierge" }), /已结束/);
  await assert.rejects(service.execute({ type: "goal.followup", goalId: id }), /已结束/);
});

test("a follow-up reply clears the due item while leaving the final state decision to the concierge", async () => {
  const { service, id } = await waiting();
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
  const replied = await service.execute({
    type: "goal.message",
    goalId: id,
    text: "YR 已经批准，可以继续开发",
    routeToConcierge: true,
  }) as Goal;
  assert.equal(replied.status, "active");
  assert.equal(replied.waitingFor, undefined);
  assert.equal(replied.remindAt, undefined);
  assert.equal(replied.attention, null);
  assert.equal(replied.dispatch?.kind, "feedback");
  assert.equal(replied.dispatch?.status, "pending");
  assert.equal(attentionGoals([replied]).length, 0);
});

test("the concierge can complete a target only with the user's explicit quote", async () => {
  const { service, id } = await waiting();
  await assert.rejects(
    service.execute({ type: "goal.complete", goalId: id, actor: "concierge" }),
    /用户确认完成的原话/,
  );
  const completed = await service.execute({
    type: "goal.complete",
    goalId: id,
    actor: "concierge",
    note: "这件事已经搞定，结束吧",
  }) as Goal;
  assert.equal(completed.status, "completed");
  assert.equal(completed.attention, null);
  assert.equal(completed.remindAt, undefined);
  assert.equal(completed.activities.at(-1)?.actor, "concierge");
  assert.equal(completed.activities.at(-1)?.text, "这件事已经搞定，结束吧");
});
