import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  WorkspaceStore,
  attentionGoals,
  type Goal,
} from "../src/index.js";
const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-core-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}
async function create(service: WorkspaceService) {
  return (await service.execute({
    type: "goal.create",
    input: {
      title: "验证注意力闭环",
      projectId: "personal",
      mode: "concierge",
    },
  })) as Goal;
}
test("dispatch failures remain actionable and successful retry clears only its own intervention", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "failed", detail: "Herdr 未安装" });
  let saved = (await service.read()).goals[0]!;
  assert.equal(saved.attention?.source, "dispatch");
  assert.equal(attentionGoals([saved]).length, 1);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "pending" });
  saved = (await service.read()).goals[0]!;
  assert.equal(saved.attention, null, "a retry in flight must clear the stale contact failure");
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" });
  assert.equal((await service.read()).goals[0]?.attention, null);
  await service.execute({ type: "goal.decide", goalId: item.id, question: "是否调整交付范围？" });
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "failed", detail: "管家暂时不可达" });
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" });
  assert.equal((await service.read()).goals[0]?.attention?.kind, "decision");
});
test("late dispatch never reopens a dropped goal", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.dispatch", goalId: item.id, status: "pending" });
  await service.execute({ type: "goal.drop", goalId: item.id, note: "不再需要" });
  await assert.rejects(service.execute({ type: "goal.dispatch", goalId: item.id, status: "sent" }));
  assert.equal((await service.read()).goals[0]?.status, "dropped");
});
test("goal owners cannot register the concierge or another live goal's execution pane", async () => {
  const {service}=await fixture(), first=await create(service), second=await create(service);
  await service.execute({type:"concierge.status",status:"ready",
    reference:{session:"test",agent:"concierge",paneId:"w1:p1",tabId:"w1:t1"}});
  await assert.rejects(service.execute({type:"session.set",goalId:first.id,
    reference:{session:"test",agent:"concierge",paneId:"w1:p1",tabId:"w1:t1"}}),/独立负责人/);
  await service.execute({type:"session.set",goalId:first.id,
    reference:{session:"test",agent:"owner-a",paneId:"w1:p2",tabId:"w1:t2"}});
  await assert.rejects(service.execute({type:"session.set",goalId:second.id,
    reference:{session:"test",agent:"owner-a",paneId:"w1:p2",tabId:"w1:t2"}}),/其他目标/);
  await service.execute({type:"session.set",goalId:second.id,
    reference:{session:"test",agent:"owner-b",paneId:"w1:p3",tabId:"w1:t3"}});
  const state=await service.read();
  assert.equal(state.goals[0]?.owner,"owner-a");
  assert.equal(state.goals[1]?.owner,"owner-b");
});
test("completed or dropped goals release their ended owner scene", async () => {
  const { service } = await fixture(), item = await create(service);
  await service.execute({
    type: "session.set",
    goalId: item.id,
    reference: { session: "test", agent: "owner-a", paneId: "w1:p2", tabId: "w1:t2" },
  });
  await assert.rejects(
    service.execute({ type: "session.release", goalId: item.id }),
    /只有已完成或已放弃/,
  );
  await service.execute({ type: "goal.drop", goalId: item.id, note: "结束现场" });
  const released = await service.execute({ type: "session.release", goalId: item.id }) as Goal;
  assert.equal(released.herdr, undefined);
  assert.equal(released.live, undefined);
  assert.equal(released.activities.at(-1)?.text, "目标已结束，负责人现场已关闭。");
});
test("Agent role preferences persist without changing running concierge references", async () => {
  const { service } = await fixture();
  await service.execute({ type: "concierge.status", status: "ready",
    reference: { session: "crewvane-test", agent: "concierge", paneId: "w1:p1" } });
  await service.execute({ type: "agents.configure", preferences: { concierge: "codex --model my-model", owner: "omp --model other-model", worker: "qodercli" } });
  const state = await service.read();
  assert.deepEqual(state.agents, { concierge: "codex --model my-model", owner: "omp --model other-model", worker: "qodercli" });
  assert.equal(state.concierge.paneId, "w1:p1");
  await assert.rejects(service.execute({ type: "agents.configure", preferences: { concierge: "codex; echo injected" } }), /无效/);
});
test("concierge readiness and live state stay independent when the agent is blocked", async () => {
  const { service } = await fixture(), checkedAt = new Date().toISOString();
  await service.execute({
    type: "concierge.status",
    status: "ready",
    reference: { session: "crewvane-test", agent: "concierge", paneId: "w1:p1", tabId: "w1:t1" },
    live: { state: "blocked", checkedAt, reachable: true },
    detail: "管家正在等待交互输入",
  });
  let state = await service.read();
  assert.equal(state.concierge.status, "ready");
  assert.equal(state.concierge.live?.state, "blocked");
  assert.equal(state.concierge.detail, "管家正在等待交互输入");
  await service.execute({
    type: "concierge.status",
    status: "ready",
    reference: state.concierge,
    live: { state: "idle", checkedAt, reachable: true },
  });
  state = await service.read();
  assert.equal(state.concierge.live?.state, "idle");
  assert.equal(state.concierge.detail, undefined);
  await assert.rejects(
    service.execute({
      type: "concierge.status",
      status: "ready",
      live: { state: "failed" as never, checkedAt },
    }),
    /无效的 Herdr 状态/,
  );
});
test("Herdr plugin events immediately reconcile the concierge and its moved pane", async () => {
  const { service } = await fixture(), checkedAt = new Date().toISOString();
  await service.execute({
    type: "concierge.status",
    status: "ready",
    reference: {
      session: "crewvane-test", workspaceId: "w1", tabId: "w1:t1",
      paneId: "w1:p1", agent: "concierge", processId: 42,
      launchPolicy: "control-plane-v1",
    },
    live: { state: "idle", checkedAt, reachable: true },
  });
  await service.execute({
    type: "live.event",
    target: { paneId: "w1:p1", workspaceId: "w1" },
    reference: { paneId: "w1:p2", tabId: "w1:t2", agent: "concierge" },
    presence: { state: "working", checkedAt, reachable: true },
  });
  let state = await service.read();
  assert.equal(state.concierge.paneId, "w1:p2");
  assert.equal(state.concierge.tabId, "w1:t2");
  assert.equal(state.concierge.status, "ready");
  assert.equal(state.concierge.live?.state, "working");

  await service.execute({
    type: "live.event",
    target: { paneId: "w1:p2", workspaceId: "w1" },
    presence: { state: "unknown", checkedAt, reachable: false },
  });
  state = await service.read();
  assert.equal(state.concierge.status, "not_ready");
  assert.equal(state.concierge.live?.reachable, false);
  assert.match(state.concierge.detail ?? "", /已关闭|不可达/);
});
test("a different agent in a stale concierge pane cannot make it online", async () => {
  const { service } = await fixture(), checkedAt = new Date().toISOString();
  await service.execute({
    type: "concierge.status",
    status: "not_ready",
    reference: {
      session: "crewvane-test", workspaceId: "w1", tabId: "w1:t1",
      paneId: "w1:p1", agent: "concierge",
    },
    live: { state: "unknown", checkedAt, reachable: false },
  });
  const result = await service.execute({
    type: "live.event",
    target: { paneId: "w1:p1", workspaceId: "w1" },
    reference: { paneId: "w1:p1", workspaceId: "w1", agent: "manual-agent" },
    presence: { state: "working", checkedAt, reachable: true },
  }) as { matched: number };
  assert.equal(result.matched, 0);
  const state = await service.read();
  assert.equal(state.concierge.status, "not_ready");
  assert.equal(state.concierge.live?.reachable, false);
});
test("new goals no longer use workflow definitions", async () => {
  const { service } = await fixture();
  const item = await create(service);
  const state = await service.read();
  assert.equal(state.version, 3);
  assert.deepEqual(state.goals[0]?.steps, []);
  assert.equal(item.mode, "concierge");
  assert.equal(state.concierge.session, "crewvane");
  await assert.rejects(service.execute({
    type: "goal.create",
    input: {
      title: "旧工序目标",
      projectId: "personal",
      workflowId: "feature",
      mode: "concierge",
    },
  }), /工序已移除/);
});
test("waiting only becomes attention at the reminder time", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.wait",
    goalId: item.id,
    reason: "等 YR 审批",
    owner: "YR",
    remindAt: "2030-01-01T08:00:00Z",
  });
  assert.equal(
    attentionGoals(
      (await service.read()).goals,
      Date.parse("2029-12-31T08:00:00Z"),
    ).length,
    0,
  );
  assert.equal(
    attentionGoals(
      (await service.read()).goals,
      Date.parse("2030-01-01T08:00:00Z"),
    )[0]?.id,
    item.id,
  );
});
test("goal messages return external waiting to coordination and remain isolated by goal id", async () => {
  const { service } = await fixture(), first = await create(service), second = await create(service);
  await service.execute({
    type: "goal.wait", goalId: first.id, reason: "等 YR 审批", owner: "YR",
    remindAt: "2030-01-01T08:00:00Z",
  });
  await service.execute({
    type: "goal.review", goalId: second.id,
    delivery: {
      summary: "原始交付",
      checks: [{ name: "读取", command: "cat result", result: "passed" }],
    },
  });
  const beforeFirst = (await service.read()).goals.find(goal => goal.id === first.id)!,
    beforeSecond = (await service.read()).goals.find(goal => goal.id === second.id)!;
  const messaged = await service.execute({
    type: "goal.message", goalId: first.id, text: "先保留现有范围，不要扩大。",
  }) as Goal;
  assert.equal(messaged.status, "active");
  assert.equal(messaged.next, beforeFirst.next);
  assert.equal(messaged.waitingFor, undefined);
  assert.equal(messaged.remindAt, undefined);
  assert.equal(messaged.dispatch?.status, "pending");
  assert.equal(messaged.activities.at(-1)?.kind, "message");
  assert.equal(messaged.activities.at(-1)?.text, "先保留现有范围，不要扩大。");
  const untouched = (await service.read()).goals.find(goal => goal.id === second.id)!;
  assert.equal(untouched?.next, beforeSecond.next);
  assert.equal(untouched?.attention?.kind, "review");
  assert.ok(!untouched?.activities.some(activity => activity.text.includes("不要扩大")));

  const reviewed = await service.execute({
    type: "goal.message", goalId: second.id, text: "有疑问，请先解释检查范围。",
  }) as Goal;
  assert.equal(reviewed.status, "review");
  assert.equal(reviewed.attention?.kind, "review");
  assert.equal(reviewed.next, beforeSecond.next);
  assert.equal(reviewed.dispatch?.status, "pending");
});
test("live done never means complete; blocked is first routed to the concierge", async () => {
  const { service } = await fixture();
  const item = await create(service),
    at = new Date().toISOString();
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "done", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.status, "active");
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "blocked", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.attention, null);
  const requests = await service.execute({ type: "watchdog.inspect", at }) as { goalId: string }[];
  assert.equal(requests[0]?.goalId, item.id);
  assert.equal((await service.read()).goals[0]?.attention, null);
  await service.execute({
    type: "live.sync",
    presences: { [item.id]: { state: "working", checkedAt: at } },
  });
  assert.equal((await service.read()).goals[0]?.attention, null);
});
test("review requires checks and preserves rework and acceptance history", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.review",
        goalId: item.id,
        delivery: { summary: "完成", checks: [] },
      }),
    /真实检查/,
  );
  const delivery = {
    summary: "实际改动已完成",
    location: "src/app.ts",
    checks: [{ name: "回归", command: "pnpm test", result: "passed" as const }],
  };
  await service.execute({ type: "goal.review", goalId: item.id, delivery });
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.resolve",
        goalId: item.id,
        note: "假装验收",
      }),
    /验收通过或退回修改/,
  );
  await service.execute({
    type: "goal.rework",
    goalId: item.id,
    note: "补充移动端验证",
  });
  await service.execute({
    type: "goal.review",
    goalId: item.id,
    delivery: { ...delivery, summary: "已补充移动端验证" },
  });
  await service.execute({
    type: "goal.accept",
    goalId: item.id,
    note: "试用通过",
  });
  const state = await service.read();
  assert.equal(state.goals[0]?.status, "completed");
  assert.deepEqual(
    state.goals[0]?.activities.slice(-3).map((a) => a.kind),
    ["rework", "delivery", "accepted"],
  );
  assert.equal(attentionGoals(state.goals).length, 0);
});
test("concurrent services retain both updates and state file is valid", async () => {
  const { root, service } = await fixture(),
    other = new WorkspaceService(root);
  await Promise.all([create(service), create(other)]);
  const state = await new WorkspaceStore(root).read();
  assert.equal(state.goals.length, 2);
  assert.equal(
    JSON.parse(await readFile(join(root, ".crewvane/state.json"), "utf8"))
      .version,
    3,
  );
});
test("incompatible state is archived and a recoverable v2 workspace is created", async () => {
  const { root, service } = await fixture(),
    legacy = join(root, ".crewvane");
  await mkdir(join(legacy, "attachments"), { recursive: true });
  await writeFile(
    join(legacy, "state.json"),
    JSON.stringify({ version: 1, tasks: [{ id: "legacy-task" }] }),
  );
  await writeFile(join(legacy, "attachments", "legacy.txt"), "preserved");

  const recovered = await service.read();
  assert.equal(recovered.version, 3);
  assert.equal(recovered.recovery?.reason, "unsupported-version");
  assert.match(recovered.recovery?.detail ?? "", /版本 1/);
  assert.ok(recovered.recovery?.archivedPath);
  assert.equal((await stat(recovered.recovery!.archivedPath)).isDirectory(), true);
  assert.deepEqual(
    JSON.parse(await readFile(join(recovered.recovery!.archivedPath, "state.json"), "utf8")),
    { version: 1, tasks: [{ id: "legacy-task" }] },
  );
  assert.equal(
    await readFile(join(recovered.recovery!.archivedPath, "attachments/legacy.txt"), "utf8"),
    "preserved",
  );
  assert.equal(JSON.parse(await readFile(join(legacy, "state.json"), "utf8")).version, 3);
  assert.equal((await service.read()).recovery?.id, recovered.recovery?.id);
  assert.equal(
    (await readdir(root)).filter(name => name.startsWith(".crewvane.backup-")).length,
    1,
  );
  await service.execute({ type: "workspace.recovery.dismiss" });
  assert.equal((await service.read()).recovery, undefined);
});

test("concurrent readers archive an incompatible workspace only once", async () => {
  const { root } = await fixture(),
    legacy = join(root, ".crewvane");
  await mkdir(legacy, { recursive: true });
  await writeFile(
    join(legacy, "state.json"),
    JSON.stringify({ version: 1, tasks: [{ id: "legacy-task" }] }),
  );

  const [first, second] = await Promise.all([
    new WorkspaceService(root).read(),
    new WorkspaceService(root).read(),
  ]);
  assert.equal(first.recovery?.id, second.recovery?.id);
  assert.equal(first.recovery?.archivedPath, second.recovery?.archivedPath);
  assert.equal(
    (await readdir(root)).filter(name => name.startsWith(".crewvane.backup-")).length,
    1,
  );
});

test("a first write against incompatible state recovers under the same workspace lock", async () => {
  const { root, service } = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane/state.json"), JSON.stringify({ version: 1, tasks: [] }));

  const item = await create(service);
  const state = await service.read();
  assert.equal(state.goals[0]?.id, item.id);
  assert.equal(state.recovery?.reason, "unsupported-version");
  assert.equal((await readdir(root)).filter(name => name.startsWith(".crewvane.backup-")).length, 1);
});

test("legacy event-only workspaces are archived before a new snapshot is written", async () => {
  const { root, service } = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(
    join(root, ".crewvane/events.jsonl"),
    `${JSON.stringify({ type: "workspace_changed", state: { version: 1, tasks: [] } })}\n`,
  );
  const recovered = await service.read();
  assert.equal(recovered.recovery?.reason, "legacy-event-log");
  assert.match(
    await readFile(join(recovered.recovery!.archivedPath, "events.jsonl"), "utf8"),
    /"version":1/,
  );
});

test("unreadable state JSON is preserved instead of blocking the workspace", async () => {
  const { root, service } = await fixture();
  await mkdir(join(root, ".crewvane"), { recursive: true });
  await writeFile(join(root, ".crewvane/state.json"), "{not-json");
  const recovered = await service.read();
  assert.equal(recovered.recovery?.reason, "invalid-state");
  assert.equal(
    await readFile(join(recovered.recovery!.archivedPath, "state.json"), "utf8"),
    "{not-json",
  );
});
test("future versions and malformed nested snapshots are also protected", async () => {
  for (const [version, goals] of [[4, []], [3, [null]]] as const) {
    const { root, service } = await fixture();
    await mkdir(join(root, ".crewvane"), { recursive: true });
    await writeFile(join(root, ".crewvane/state.json"), JSON.stringify({
      version,
      name: "test",
      projects: [],
      workflows: [],
      goals,
      decisions: [],
      concierge: { session: "crewvane", status: "not_ready" },
    }));
    const recovered = await service.read();
    assert.equal(recovered.version, 3);
    assert.equal(recovered.recovery?.reason,
      version === 4 ? "unsupported-version" : "invalid-state");
    assert.equal((await readdir(root)).filter(name => name.startsWith(".crewvane.backup-")).length, 1);
  }
});
test("a compatible v3 snapshot is reused without creating a backup", async () => {
  const { root, service } = await fixture();
  const created = await create(service);
  const second = await service.read();
  assert.equal(second.goals[0]?.id, created.id);
  assert.equal(second.recovery, undefined);
  assert.equal((await readdir(root)).filter(name => name.startsWith(".crewvane.backup-")).length, 0);
});
test("resolving a due reminder clears it so it cannot notify twice", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.remind",
    goalId: item.id,
    at: "2020-01-01T00:00:00Z",
    note: "检查结果",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 1);
  await service.execute({
    type: "goal.resolve",
    goalId: item.id,
    note: "已处理",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  assert.equal((await service.read()).goals[0]?.remindAt, undefined);
});
test("background progress cannot dismiss a decision or take a delivery out of review", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.decide",
    goalId: item.id,
    question: "请选择交付范围",
  });
  await service.execute({
    type: "goal.progress",
    goalId: item.id,
    summary: "补充了调查结果",
  });
  assert.equal((await service.read()).goals[0]?.attention?.kind, "decision");
  await service.execute({
    type: "goal.resolve",
    goalId: item.id,
    note: "先做核心范围",
  });
  await service.execute({
    type: "goal.review",
    goalId: item.id,
    delivery: {
      summary: "核心范围已交付",
      checks: [{ name: "验证", command: "实际试用", result: "passed" }],
    },
  });
  await assert.rejects(
    () =>
      service.execute({
        type: "goal.progress",
        goalId: item.id,
        summary: "迟到的进度",
      }),
    /等待验收/,
  );
  assert.equal((await service.read()).goals[0]?.status, "review");
});
test("late agent commands never reopen completed or dropped goals", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({ type: "goal.drop", goalId: item.id, note: "已取消" });
  for (const command of [
    { type: "goal.progress", goalId: item.id, summary: "旧消息" },
    { type: "goal.wait", goalId: item.id, reason: "旧等待" },
    { type: "goal.decide", goalId: item.id, question: "旧问题" },
    { type: "goal.remind", goalId: item.id, at: "2030-01-01T00:00:00Z" },
    {
      type: "goal.review",
      goalId: item.id,
      delivery: {
        summary: "旧交付",
        checks: [{ name: "检查", command: "读取", result: "passed" }],
      },
    },
  ] as const) {
    await assert.rejects(
      () =>
        service.execute(
          structuredClone(command) as import("../src/index.js").CrewvaneCommand,
        ),
      /已结束/,
    );
  }
  assert.equal((await service.read()).goals[0]?.status, "dropped");
});
test("manual waiting can resume and stops an old follow-up notification", async () => {
  const { service } = await fixture();
  const item = await create(service);
  await service.execute({
    type: "goal.remind",
    goalId: item.id,
    at: "2020-01-01T00:00:00Z",
  });
  await service.execute({
    type: "notification.sent",
    goalId: item.id,
    kind: "follow_up",
    at: new Date().toISOString(),
  });
  await service.execute({
    type: "goal.progress",
    goalId: item.id,
    summary: "审批已通过，继续执行",
  });
  assert.equal(attentionGoals((await service.read()).goals).length, 0);
  assert.equal((await service.read()).goals[0]?.status, "active");
});

test("agent answers must include the substantive response", async () => {
  const { root, service } = await fixture();
  const item = await service.execute({
    type: "goal.intake",
    text: "解释为什么保留旧接口",
  }) as Goal;
  await assert.rejects(
    service.execute({
      type: "goal.progress",
      goalId: item.id,
      summary: "已回答",
      actor: "负责人 alpha-owner",
    }),
    /必须写回具体内容/,
  );
  const answered = await service.execute({
    type: "goal.progress",
    goalId: item.id,
    summary: "旧接口仍被两个外部客户端使用，保留两轮兼容期后再移除。",
    actor: "负责人 alpha-owner",
  }) as Goal;
  assert.match(answered.activities.at(-1)!.text, /两个外部客户端/);
  await rm(root, { recursive: true, force: true });
});
