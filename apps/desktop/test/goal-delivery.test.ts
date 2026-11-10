import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService, type Goal } from "../../../packages/core/src/index.js";
import { deliverGoalUpdate } from "../electron/goal-delivery.js";
import { HerdrClient } from "../electron/herdr.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-handoff-"));
  roots.push(root);
  const service = new WorkspaceService(root);
  const item = await service.execute({ type: "goal.create", input: {
    title: "审批", projectId: "personal", mode: "manual",
  } }) as Goal;
  await service.execute({ type: "goal.wait", goalId: item.id, reason: "等 YR", owner: "YR" });
  return { service, id: item.id };
}

test("offline handoff is saved and restart retries the actual follow-up as active coordination", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "goal.followup", goalId: id, note: "核查审批进展" });
  await deliverGoalUpdate(service, id, async () => { throw new Error("连接失败"); });
  let goal = (await service.read()).goals[0]!;
  assert.equal(goal.dispatch?.status, "failed");
  assert.equal(goal.attention?.source, "dispatch");
  assert.equal(goal.status, "active");
  const calls: string[][] = [];
  const messenger = new HerdrClient({ async run(args) {
    calls.push(args);
    if (args.slice(0, 2).join(" ") === "agent wait")
      return JSON.stringify({ result: { agent: {
        name: "concierge", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1",
      } } });
    return "{}";
  } }, "trial");
  await deliverGoalUpdate(new WorkspaceService(service.root), id, async item => {
    await messenger.notifyFollowUp({ session: "trial", agent: "concierge" }, item.id, item.dispatch!.note!, item);
  });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.dispatch?.status, "sent");
  assert.equal(goal.attention, null);
  assert.equal(goal.status, "active");
  assert.match(calls[0]![3]!, /核查审批进展/);
  assert.match(calls[0]![3]!, /具名外部第三方/);
  assert.match(calls[0]![3]!, /\[CREWVANE_CASE_BEGIN\]/);
  assert.match(calls[0]![3]!, /\[CREWVANE_CASE_END\]/);
});

test("a newer feedback request is not acknowledged by an older in-flight follow-up", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "goal.followup", goalId: id });
  const sent: string[] = [];
  await deliverGoalUpdate(service, id, async item => {
    sent.push(item.dispatch!.kind!);
    if (sent.length === 1) {
      await service.execute({ type: "goal.message", goalId: id, text: "审批通过，继续" });
    }
  });
  assert.deepEqual(sent, ["follow_up", "feedback"]);
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.dispatch?.kind, "feedback");
  assert.equal(goal.dispatch?.status, "sent");
  assert.equal(goal.status, "active");
});

test("manual takeover during send is never turned back into a concierge goal", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "goal.followup", goalId: id });
  await deliverGoalUpdate(service, id, async () => {
    await service.execute({ type: "goal.takeover", goalId: id });
  });
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.mode, "manual");
  assert.equal(goal.dispatch, undefined);
});
