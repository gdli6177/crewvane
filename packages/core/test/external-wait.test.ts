import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService, attentionGoals, type Goal } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(mode: "concierge" | "manual" = "concierge") {
  const root = await mkdtemp(join(tmpdir(), "cv-external-wait-"));
  roots.push(root);
  const service = new WorkspaceService(root);
  const goal = await service.execute({ type: "goal.create", input: {
    title: "核对等待语义", projectId: "personal", mode,
  } }) as Goal;
  if (mode === "concierge") {
    await service.execute({ type: "session.set", goalId: goal.id,
      reference: { session: "trial", agent: "owner-a", paneId: "w1:p2" } });
    await service.execute({ type: "session.set",
      reference: { session: "trial", agent: "concierge", paneId: "w1:p1" } });
  }
  return { root, service, id: goal.id };
}

test("waiting requires a named party outside the human and all registered Agents", async () => {
  const { service, id } = await fixture();
  const other = await service.execute({ type: "goal.intake", text: "另一个目标" }) as Goal;
  await service.execute({ type: "session.set", goalId: other.id,
    reference: { session: "trial", agent: "worker-b", paneId: "w1:p3" } });
  for (const owner of [undefined, "", "你", "我", "本人", "用户", "human", "user",
    "管家", "concierge", "负责人", "待分配负责人", "agent", "owner-a", "WORKER-B"]) {
    await assert.rejects(service.execute({
      type: "goal.wait", goalId: id, reason: "暂时停下", owner,
    }), /外部第三方/, `must reject ${String(owner)}`);
  }
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "active");
  assert.equal(goal.owner, "owner-a");
});

test("external wait keeps the execution owner and reminders never change lifecycle", async () => {
  const { service, id } = await fixture();
  await service.execute({ type: "goal.remind", goalId: id, at: "2020-01-01T00:00:00Z" });
  let goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "active");
  assert.equal(goal.waitingFor, undefined);
  assert.equal(attentionGoals([goal]).length, 1, "active concierge reminders must still fire");
  await service.execute({ type: "goal.wait", goalId: id, reason: "等 YR 的审批", owner: "YR" });
  await service.execute({ type: "goal.remind", goalId: id, at: "2030-01-01T00:00:00Z" });
  goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "waiting");
  assert.equal(goal.waitingFor, "YR");
  assert.equal(goal.owner, "owner-a");
});

test("waiting cannot hide a user decision and update cannot bypass the waiting invariant", async () => {
  const { service, id } = await fixture();
  await assert.rejects(service.execute({
    type: "goal.update", goalId: id, patch: { status: "waiting" },
  }), /外部第三方/);
  await assert.rejects(service.execute({
    type: "goal.update", goalId: id, patch: { status: "waiting", waitingFor: "owner-a" },
  }), /外部第三方/);
  await service.execute({ type: "goal.decide", goalId: id, question: "需要你选择方案" });
  await assert.rejects(service.execute({
    type: "goal.wait", goalId: id, reason: "绕开问题", owner: "YR",
  }), /待处理/);
  await assert.rejects(service.execute({
    type: "goal.update", goalId: id, patch: { status: "waiting", waitingFor: "YR" },
  }), /待处理/);
  const goal = (await service.read()).goals[0]!;
  assert.equal(goal.status, "active");
  assert.equal(goal.attention?.kind, "decision");
});

test("feedback and explicit follow-up return external waits to active while Agents handle them", async () => {
  for (const type of ["goal.message", "goal.direct", "goal.followup"] as const) {
    const { service, id } = await fixture();
    await service.execute({ type: "goal.wait", goalId: id, reason: "等待审批", owner: "YR",
      remindAt: "2020-01-01T00:00:00Z" });
    if (type === "goal.followup") await service.execute({ type, goalId: id, note: "请核实进展" });
    else await service.execute({ type, goalId: id, text: "YR 已回复，请处理下一步" });
    const goal = (await service.read()).goals[0]!;
    assert.equal(goal.status, "active", type);
    assert.equal(goal.waitingFor, undefined, type);
    assert.equal(goal.remindAt, undefined, type);
    assert.equal(attentionGoals([goal]).length, 0);
    assert.equal(goal.owner, "owner-a");
    assert.ok(goal.activities.some(activity => activity.kind === "session" &&
      activity.text.includes("此前等待外部：YR") && activity.text.includes("2020-01-01")));
  }
});

test("manual goals start active and a passive personal note does not end a real external wait", async () => {
  const { service, id } = await fixture("manual");
  assert.equal((await service.read()).goals[0]!.status, "active");
  await service.execute({ type: "goal.wait", goalId: id, reason: "等待物流", owner: "快递公司" });
  await service.execute({ type: "goal.message", goalId: id, text: "留个备注" });
  assert.equal((await service.read()).goals[0]!.status, "waiting");
});

test("handing personal external waits to the concierge awaits a real execution owner", async () => {
  for (const type of ["goal.followup", "goal.message"] as const) {
    const { service, id } = await fixture("manual");
    await service.execute({ type: "goal.wait", goalId: id, reason: "等待物流", owner: "快递公司" });
    if (type === "goal.followup") await service.execute({ type, goalId: id });
    else await service.execute({ type, goalId: id, text: "请帮我跟进", routeToConcierge: true });
    const goal = (await service.read()).goals[0]!;
    assert.equal(goal.mode, "concierge");
    assert.equal(goal.status, "active");
    assert.equal(goal.owner, "待分配负责人");
  }
});

test("legacy invalid waits normalize without losing attention, history or external waits", async () => {
  const { root, service, id } = await fixture();
  const state = await service.read(), base = state.goals[0]!;
  state.goals = [undefined, "你", "owner-a", "concierge", "待分配负责人", "YR"].map((waitingFor, i) => ({
    ...structuredClone(base), id: `${id}_${i}`, status: "waiting", waitingFor,
  }));
  state.goals.push({ ...structuredClone(base), id: `${id}_decision`, status: "waiting", waitingFor: "YR",
    attention: { id: "attention_original", kind: "decision", summary: "请选择方案", since: base.updatedAt } });
  state.goals.push({ ...structuredClone(base), id: `${id}_due`, status: "waiting", waitingFor: "YR",
    remindAt: "2020-01-01T00:00:00Z",
    attention: { id: "reminder_original", kind: "follow_up", summary: "检查审批进展", since: base.updatedAt } });
  await writeFile(join(root, ".crewvane/state.json"), JSON.stringify(state));
  const normalized = await new WorkspaceService(root).read();
  assert.deepEqual(normalized.goals.slice(0, 6).map(goal => goal.status),
    ["active", "active", "active", "active", "active", "waiting"]);
  assert.equal(normalized.goals[1]!.attention?.kind, "intervention");
  assert.equal(normalized.goals[6]!.attention?.id, "attention_original");
  assert.equal(normalized.goals[6]!.status, "active");
  assert.equal(normalized.goals[7]!.status, "waiting", "a due external follow-up remains an external wait");
  assert.ok(normalized.goals.every(goal => goal.activities.length === base.activities.length));
  assert.equal(normalized.recovery, undefined, "do not archive otherwise valid workspace data");
  await service.execute({ type: "workspace.rename", name: "等待语义回归" });
  const persisted = JSON.parse(await readFile(join(root, ".crewvane/state.json"), "utf8"));
  assert.equal(persisted.goals[1].status, "active");
});

test("historical self-waits are active and still receive quiet-owner reconciliation", async () => {
  const { root, service } = await fixture(), state = await service.read();
  const goal = state.goals[0]!;
  goal.status = "waiting"; goal.waitingFor = "owner-a";
  goal.live = { state: "idle", reachable: true, checkedAt: new Date(Date.now() - 120_000).toISOString() };
  await writeFile(join(root, ".crewvane/state.json"), JSON.stringify(state));
  const requests = await service.execute({ type: "watchdog.inspect", at: new Date().toISOString() }) as { reason: string }[];
  assert.equal((await service.read()).goals[0]!.status, "active");
  assert.equal(requests[0]?.reason, "settled");
});
