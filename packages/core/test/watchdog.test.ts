import test from "node:test";
import assert from "node:assert/strict";
import { inspectWatchdog, reportWatchdog } from "../src/watchdog.js";
import { attentionGoals, type Goal } from "../src/index.js";
const start = "2030-01-01T08:00:00.000Z";
const after = (minutes: number) => new Date(Date.parse(start) + minutes * 60_000).toISOString();
function goal(): Goal {
  return { id: "goal_test", projectId: "personal", title: "巡检事项", description: "", mode: "concierge",
    status: "active", steps: [], next: "推进", owner: "负责人", attention: null,
    herdr: {session:"test",paneId:"w1:p2",agent:"owner"},
    activities: [{ id: "created", kind: "created", at: start, actor: "你", text: "已交代事项" }],
    createdAt: start, updatedAt: start };
}
test("two goals without owner references are checked after startup grace, not treated as dispatched execution", () => {
  const first = goal(), second = {...goal(),id:"goal_second"};
  delete first.herdr; delete second.herdr;
  first.dispatch = {status:"sent",at:start};
  second.dispatch = {status:"sent",at:start};
  assert.deepEqual(inspectWatchdog([first,second],after(0.5)),[]);
  const requests = inspectWatchdog([first,second],after(1));
  assert.deepEqual(requests.map(request=>[request.goalId,request.reason]),[
    ["goal_test","unassigned"],["goal_second","unassigned"],
  ]);
  assert.equal(first.attention,null);
  reportWatchdog(first,after(1),requests[0]!.basis,"contacted");
  first.herdr={session:"test",paneId:"w1:p3",agent:"first-owner"};
  assert.deepEqual(inspectWatchdog([first],after(2)),[]);
  assert.equal(first.watchdog,undefined);
  second.status="waiting";
  assert.deepEqual(inspectWatchdog([second],after(2)),[]);
});
test("preparing concierge and pending human decisions do not trigger unassigned-owner patrols", () => {
  const item=goal(); delete item.herdr;
  item.dispatch={status:"pending",at:start};
  assert.deepEqual(inspectWatchdog([item],after(2)),[]);
  item.dispatch={status:"sent",at:start};
  item.attention={kind:"decision",summary:"请人决定范围",since:start};
  assert.deepEqual(inspectWatchdog([item],after(2)),[]);
});
test("no-progress check contacts concierge first, deduplicates, and escalates only after no recovery", () => {
  const item = goal();
  assert.deepEqual(inspectWatchdog([item], after(29)), []);
  const [request] = inspectWatchdog([item], after(31));
  assert.equal(request?.reason, "stale");
  assert.equal(attentionGoals([item], Date.parse(after(31))).length, 0);
  reportWatchdog(item, after(31), request!.basis, "contacted");
  assert.deepEqual(inspectWatchdog([item], after(32)), []);
  assert.equal(item.attention, null);
  assert.deepEqual(inspectWatchdog([item], after(41)), []);
  assert.equal(structuredClone(item).attention?.source, "watchdog");
  const count = item.activities.length;
  inspectWatchdog([item], after(42));
  assert.equal(item.activities.length, count);
});
test("blocked or missing owner is checked without treating idle or waiting as failure", () => {
  const item = goal();
  item.live = { state: "idle", checkedAt: start };
  assert.deepEqual(inspectWatchdog([item], after(1)), []);
  item.live = { state: "blocked", checkedAt: after(1), reachable: true };
  assert.equal(inspectWatchdog([item], after(1))[0]?.reason, "blocked");
  assert.equal(item.attention, null);
  item.live = { state: "unknown", checkedAt: after(2), reachable: false };
  assert.equal(inspectWatchdog([item], after(2))[0]?.reason, "missing");
  item.status = "waiting"; item.remindAt = after(60);
  assert.deepEqual(inspectWatchdog([item], after(40)), []);
  assert.equal(item.attention, null);
});
test("a settled owner is reconciled without declaring its goal completed or failed", () => {
  const first = goal(), second = {...goal(), id:"goal_second"};
  first.live = { state: "done", checkedAt: after(1), reachable: true };
  second.live = { state: "working", checkedAt: after(1), reachable: true };
  assert.deepEqual(inspectWatchdog([first, second], after(2.4)), []);
  const requests = inspectWatchdog([first, second], after(2.5));
  assert.deepEqual(requests.map(request => [request.goalId, request.reason]), [["goal_test", "settled"]]);
  assert.equal(first.status, "active");
  assert.equal(first.attention, null);
  assert.equal(first.recovery, "done");
  reportWatchdog(first, after(2.5), requests[0]!.basis, "contacted");
  assert.equal(attentionGoals([first], Date.parse(after(2.5))).length, 0);
  // Contacting the concierge is not evidence that the owner made progress.
  assert.equal(first.watchdog?.reason, "settled");
  assert.equal(first.recovery, undefined);
  first.live = { state:"working", checkedAt:after(3), reachable:true };
  assert.deepEqual(inspectWatchdog([first], after(3)), []);
  assert.equal(first.recovery, undefined);
});
test("a quiet owner that recorded waiting on itself is still reconciled", () => {
  const item = goal();
  item.status = "waiting";
  item.waitingFor = "owner";
  item.live = { state:"idle", checkedAt:after(1), reachable:true };
  const [request] = inspectWatchdog([item], after(2.5));
  assert.equal(request?.reason, "settled");
  reportWatchdog(item, after(2.5), request!.basis, "contacted");
  assert.equal(item.watchdog?.contactedAt, after(2.5));
  assert.ok(item.activities.some(activity => /已请管家核查/.test(activity.text)));
});
test("waiting for a person or another party does not probe the owner terminal", () => {
  const human = goal(), external = goal();
  human.status = external.status = "waiting";
  human.waitingFor = "你";
  external.waitingFor = "YR";
  human.live = external.live = { state:"idle", checkedAt:after(1), reachable:true };
  assert.deepEqual(inspectWatchdog([human, external], after(20)), []);
});
test("an idle owner cannot hide a fresh structured attention request", () => {
  const item = goal();
  item.live = { state:"idle", checkedAt:start, reachable:true };
  item.attention = { kind:"decision", summary:"请选择方案", since:start };
  assert.deepEqual(inspectWatchdog([item], after(5)), []);
  assert.equal(item.attention.kind, "decision");
  assert.equal(item.recovery, undefined);
});
test("an unreachable concierge becomes actionable, and successful retry clears only its own failure", () => {
  const item = goal(), [request] = inspectWatchdog([item], after(31));
  reportWatchdog(item, after(31), request!.basis, "failed", "会话未运行");
  assert.equal(item.attention?.kind, "intervention");
  assert.deepEqual(inspectWatchdog([item], after(31.5)), []);
  assert.equal(inspectWatchdog([item], after(32)).length, 1);
  reportWatchdog(item, after(32), request!.basis, "contacted");
  assert.equal(item.attention, null);
  item.attention = { kind: "decision", summary: "范围由人决定", since: after(33) };
  reportWatchdog(item, after(33), request!.basis, "failed", "再度断线");
  assert.equal(item.attention.kind, "decision");
});
test("late patrol replies cannot override fresh progress or completed work", () => {
  const item = goal(), [request] = inspectWatchdog([item], after(31));
  item.activities.push({ id: "progress", kind: "progress", at: after(32), actor: "负责人", text: "检查已通过" });
  reportWatchdog(item, after(33), request!.basis, "failed", "旧请求失败");
  assert.equal(item.attention, null);
  assert.deepEqual(inspectWatchdog([item], after(33)), []);
  assert.equal(item.watchdog, undefined);
  item.status = "completed";
  assert.deepEqual(inspectWatchdog([item], after(90)), []);
});
