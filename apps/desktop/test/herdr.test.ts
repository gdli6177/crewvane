import test from "node:test";
import assert from "node:assert/strict";
import { HerdrClient, terminalPrompt, type HerdrRunner } from "../electron/herdr.ts";
import { agentReceiptMarker } from "../../../packages/core/src/index.ts";

function fake(responses: Record<string, string>) {
  const calls: string[][] = [];
  const concierge = {
    name: "concierge", agent_status: "idle", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1",
  };
  const idleConcierge = JSON.stringify({ result: { agents: [concierge] } });
  const runner: HerdrRunner = { async run(args) {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const value = responses[key] ?? responses[args[0]!] ??
      (key === "agent list" ? idleConcierge : key === "agent wait" ? JSON.stringify({ result: { agent: concierge } }) : undefined);
    if (value === undefined) throw new Error(`unexpected Herdr call ${key}`);
    if (value.startsWith("!")) throw new Error(value.slice(1));
    return value;
  } };
  return { calls, runner };
}

test("reuses only a persisted control-plane concierge", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").prepareConcierge(
    "/tmp/workspace",
    {
      session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
      agent: "concierge", launchPolicy: "control-plane-v1",
    },
  );
  assert.deepEqual(reference, {
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", launchPolicy: "control-plane-v1",
  });
  assert.equal(mock.calls.some((args) => args[0] === "workspace"), false);
  assert.equal(mock.calls.some((args) => args[0] === "agent" && args[1] === "start"), false);
});

test("creates a new concierge in the selected workspace, not the default global root", async () => {
  const calls: string[][] = [], responses: Record<string, string> = {
    "agent start": "{}", "agent prompt": "{}",
    "pane process-info": JSON.stringify({ result: { process_info: {
      shell_pid: 12, foreground_processes: [{ pid: 42, name: "codex" }],
    } } }),
    "pane run": "{}", "pane wait-output": "{}", "tab focus": "{}",
    "workspace create": '{"result":{"workspace":{"workspace_id":"w-selected"},"tab":{"tab_id":"w-selected:t1"},"root_pane":{"pane_id":"w-selected:p1"}}}',
  };
  let listCalls = 0;
  const runner: HerdrRunner = { async run(args) {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (key === "agent list") {
      if (listCalls++ === 0) throw new Error("server_not_running");
      return '{"result":{"agents":[]}}';
    }
    const value = responses[key] ?? responses[args[0]!];
    if (value === undefined) throw new Error(`unexpected Herdr call ${key}`);
    return value;
  } };
  const client = new HerdrClient(runner, "crewvane-test", "/tmp/selected-workspace", async () => {});
  const reference = await client.prepareConcierge("/tmp/selected-workspace");
  assert.equal(reference.paneId, "w-selected:p1");
  assert.equal(listCalls, 3, "the client starts, verifies the session, then inspects its agents");
  const creation = calls.find(args => args[0] === "workspace" && args[1] === "create");
  assert.ok(creation);
  assert.equal(creation[creation.indexOf("--cwd") + 1], "/tmp/selected-workspace/.crewvane");
});

test("inspects and opens a persisted blocked concierge without prompting or changing its input", async () => {
  const reference = {
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", launchPolicy: "control-plane-v1" as const,
  };
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "blocked", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
    "tab focus": "{}",
  });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  const site = await client.inspectConcierge(reference);
  assert.equal(site?.live.state, "blocked");
  assert.equal(site?.live.reachable, true);
  await client.open(site!.reference);
  assert.deepEqual(mock.calls.at(-1), ["tab", "focus", "w7:t1"]);
  assert.equal(mock.calls.some(args => args[0] === "agent" && args[1] === "prompt"), false);
});

test("owner reminders wait for the exact live Agent to start processing", async () => {
  const reference = {
    session: "crewvane-test", paneId: "w1:p2",
    agent: "owner-a", workspaceId: "w1", tabId: "w1:t2",
  };
  const marker = agentReceiptMarker("attempt-test", "turn-test");
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a", agent_status: "done", interactive_ready: true,
      workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2",
    }] } }),
    "agent prompt": "{}",
  });
  const result = await new HerdrClient(mock.runner, "crewvane-test")
    .notifyOwnerReminder(reference, `${marker} 请补交结构化回执`);
  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(mock.calls.at(-1), [
    "agent", "prompt", "owner-a", `${marker} 请补交结构化回执`,
    "--wait", "--until", "working", "--timeout", "5000",
  ]);
});

test("a working or replaced owner Pane never receives a competing reminder", async () => {
  const reference = {
    session: "crewvane-test", paneId: "w1:p2", agent: "owner-a",
    workspaceId: "w1", tabId: "w1:t2",
  };
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a", agent_status: "working", interactive_ready: true,
      workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2",
    }] } }),
  });
  const result = await new HerdrClient(mock.runner, "crewvane-test")
    .notifyOwnerReminder(
      reference,
      `${agentReceiptMarker("attempt-test", "turn-test")} 请补交结构化回执`,
    );
  assert.equal(result.status, "unconfirmed");
  assert.match(result.detail ?? "", /仍在工作/);
  assert.equal(mock.calls.some(args => args[0] === "pane" && args[1] === "run"), false);
});

test("a reminder whose Agent never starts is unconfirmed and is not replayed", async () => {
  const reference = {
    session: "crewvane-test", paneId: "w1:p2", agent: "owner-a",
    workspaceId: "w1", tabId: "w1:t2",
  };
  const marker = agentReceiptMarker("attempt-test", "turn-test");
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a", agent_status: "idle", interactive_ready: true,
      workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2",
    }] } }),
    "agent prompt": "!Herdr agent prompt：agent_prompt_stalled",
  });
  const result = await new HerdrClient(mock.runner, "crewvane-test")
    .notifyOwnerReminder(reference, `${marker} 请补交结构化回执`);
  assert.equal(result.status, "unconfirmed");
  assert.match(result.detail ?? "", /未确认负责人开始处理/);
  assert.equal(
    mock.calls.filter(args => args[0] === "agent" && args[1] === "prompt").length,
    1,
  );
});

test("unknown owner state and multi-line reminders never inject terminal input", async () => {
  const reference = {
    session: "crewvane-test", paneId: "w1:p2", agent: "owner-a",
    workspaceId: "w1", tabId: "w1:t2",
  };
  const marker = agentReceiptMarker("attempt-test", "turn-test");
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a", agent_status: "unknown", interactive_ready: true,
      workspace_id: "w1", tab_id: "w1:t2", pane_id: "w1:p2",
    }] } }),
  });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  const unknown = await client.notifyOwnerReminder(reference, `${marker} 请补交结构化回执`);
  assert.equal(unknown.status, "unconfirmed");
  assert.match(unknown.detail ?? "", /状态为 unknown/);
  await assert.rejects(
    client.notifyOwnerReminder(reference, `${marker}\n请补交结构化回执`),
    /单个逻辑行/,
  );
  assert.equal(mock.calls.some(args => args[0] === "agent" && args[1] === "prompt"), false);
});

test("never mistakes a different agent in the old pane for the concierge", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "manual-agent", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").findConcierge({
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", launchPolicy: "control-plane-v1",
  });
  assert.equal(reference, undefined);
  assert.equal(mock.calls.some(args => args[0] === "tab" && args[1] === "close"), false);
});

test("does not silently close a same-named agent without a governed reference", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").findConcierge({
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1", agent: "concierge",
  });
  assert.equal(reference, undefined);
  assert.ok(mock.calls.every(args => args[0] === "agent" && args[1] === "list"));
});

test("records the exact foreground PID and follows a moved concierge agent", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t2", pane_id: "w7:p2",
    }] } }),
    "pane process-info": JSON.stringify({ result: { process_info: {
      shell_pid: 12,
      foreground_processes: [{ pid: 42, name: "codex" }],
    } } }),
  });
  const current = await new HerdrClient(mock.runner, "crewvane-test").findConcierge({
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", launchPolicy: "control-plane-v1",
  });
  assert.deepEqual(current, {
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t2", paneId: "w7:p2",
    agent: "concierge", launchPolicy: "control-plane-v1", processId: 42,
  });
});

test("a recorded PID stops matching when the agent was replaced", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "concierge", agent_status: "idle", workspace_id: "w7", tab_id: "w7:t1", pane_id: "w7:p1",
    }] } }),
    "pane process-info": JSON.stringify({ result: { process_info: {
      shell_pid: 12,
      foreground_processes: [{ pid: 99, name: "other-agent" }],
    } } }),
  });
  const current = await new HerdrClient(mock.runner, "crewvane-test").findConcierge({
    session: "crewvane-test", workspaceId: "w7", tabId: "w7:t1", paneId: "w7:p1",
    agent: "concierge", processId: 42, launchPolicy: "control-plane-v1",
  });
  assert.equal(current, undefined);
});

test("new goals notify the same concierge without creating an owner or another session", async () => {
  const mock = fake({ "agent prompt": "{}" });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  const reference = { session: "crewvane-test", agent: "concierge" };
  await client.notifyGoal(reference, "goal_one", "事项一");
  await client.notifyGoal(reference, "goal_two", "事项二");
  await client.notifyGoal(reference, "goal_three", "事项三", {
    id: "goal_three", projectId: "personal", title: "事项三",
    description: "完整原文\n保留全部约束", mode: "concierge", status: "active",
    steps: [{ id: "intake", name: "待管家梳理", prompt: "先整理，再分发" }], stageId: "intake",
    next: "管家正在整理", owner: "待分配负责人", attention: null,
    attachments: [{
      id: "att_0123456789abcdef", name: "现场截图.png",
      path: ".crewvane/attachments/att_0123456789abcdef.png",
      mime: "image/png", size: 128,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      addedAt: new Date().toISOString(),
    }],
    activities: [{ id: "activity", at: new Date().toISOString(), actor: "你", kind: "created", text: "完整原文\n保留全部约束" }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }, "/workspace");
  const prompts = mock.calls.filter(args => args.slice(0, 3).join(" ") === "agent prompt concierge");
  assert.equal(prompts.length, 3);
  assert.match(prompts[0]![3]!, /goal_one/);
  assert.match(prompts[1]![3]!, /goal_two/);
  for (const args of prompts) {
    assert.match(args[3]!, /不亲自执行目标/);
    assert.match(args[3]!, /整理后交给本目标独立负责人/);
    assert.match(args[3]!, /退回修改转交原负责人/);
    assert.match(args[3]!, /向人交接/);
    assert.match(args[3]!, /agent prompt <名称> "<完整任务>" --wait --until working/);
    assert.match(args[3]!, /agent_prompt_stalled/);
    assert.match(args[3]!, /禁止未经核对就重复发送/);
    assert.match(args[3]!, /crewvane owner launch <目标ID> --name <负责人名称> --json/);
    assert.match(args[3]!, /命令行单次输入通常只有约 1 KB/);
    assert.match(args[3]!, /禁止手工串联 Herdr 命令/);
    assert.equal((args[3]!.match(/\[CREWVANE_CASE_BEGIN\]/g) ?? []).length, 1);
    assert.equal((args[3]!.match(/\[CREWVANE_CASE_END\]/g) ?? []).length, 1);
  }
  assert.match(prompts[2]![3]!, /完整原文\\n保留全部约束/);
  assert.doesNotMatch(prompts[2]![3]!, /待管家梳理|"steps"|"stageId"/);
  assert.match(prompts[2]![3]!, /\/workspace\/\.crewvane\/attachments\/att_0123456789abcdef\.png/);
  assert.match(prompts[2]![3]!, /实际查看图片/);
  assert.ok(prompts.every(args => args.includes("--wait") && !args.includes("--timeout")));
});

test("watchdog keeps recovery with owners instead of asking the concierge to execute", async () => {
  const mock = fake({ "agent prompt": "{}" });
  await new HerdrClient(mock.runner, "crewvane-test").notifyWatchdog(
    { session: "crewvane-test", agent: "concierge" }, [
      { goalId: "goal_blocked", reason: "blocked" },
      { goalId: "goal_stale", reason: "stale" },
      { goalId: "goal_settled", reason: "settled" },
    ],
  );
  const prompts = mock.calls.filter(args => args.slice(0, 3).join(" ") === "agent prompt concierge");
  assert.equal(prompts.length, 3);
  for (const [index, goalId] of ["goal_blocked", "goal_stale", "goal_settled"].entries()) {
    const message = prompts[index]![3]!;
    assert.match(message, new RegExp(goalId));
    assert.match(message, /不亲自执行目标/);
    assert.match(message, /联系其他负责人协调恢复/);
    assert.match(message, /不能自己接手执行/);
    assert.equal((message.match(/case_id:/g) ?? []).length, 1);
    assert.doesNotMatch(message, /能处理的由你处理/);
  }
  assert.doesNotMatch(prompts[0]![3]!, /goal_stale/);
  assert.doesNotMatch(prompts[1]![3]!, /goal_blocked/);
  assert.match(prompts[2]![3]!, /尚未写回这一阶段的结果/);
  assert.match(prompts[2]![3]!, /不要自行验收/);
  assert.doesNotMatch(prompts[2]![3]!, /goal_stale/);
  assert.ok(prompts.every(args =>
    args.includes("--wait") &&
    args.includes("--timeout") &&
    args[args.indexOf("--timeout") + 1] === "30000"));
});
test("resumed concierge receives current role instructions without starting another agent", async () => {
  const mock=fake({"agent prompt":"{}"});
  await new HerdrClient(mock.runner,"test").refreshConcierge(
    {session:"test",agent:"concierge",paneId:"w1:p1"},"/workspace",{concierge:"codex",owner:"custom-cli"},
  );
  assert.equal(mock.calls.length,1);
  assert.deepEqual(mock.calls[0]!.slice(0,3),["agent","prompt","concierge"]);
  assert.match(mock.calls[0]![3]!,/不亲自执行目标/);
  assert.match(mock.calls[0]![3]!,/custom-cli/);
  assert.doesNotMatch(mock.calls[0]![3]!,/Codex 负责人使用 workspace-write/);
  assert.ok(mock.calls[0]!.includes("--wait") && !mock.calls[0]!.includes("--timeout"));
});
test("a running terminal-title spinner wins over a stale idle agent status", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner", agent: "omp", agent_status: "idle", revision: 58,
      terminal_title_stripped: "π ⠋ 🧪 IDLE: working on a tool call",
      workspace_id: "w2", tab_id: "w2:t2", pane_id: "w2:p2",
    }] } }),
  });
  const presences = await new HerdrClient(mock.runner, "crewvane-test").presences([{
    id: "goal_one",
    herdr: { session: "crewvane-test", agent: "owner", paneId: "w2:p2" },
  }]);
  assert.equal(presences.goal_one?.state, "working");
});

test("an agent_blocked dispatch becomes an actionable reminder without changing terminal input", async () => {
  const mock = fake({
    "agent prompt": '!Herdr agent prompt：{"code":"agent_blocked","message":"agent concierge is blocked and requires interactive input"}',
  });
  await assert.rejects(
    () => new HerdrClient(mock.runner, "crewvane-test").notifyGoal(
      { session: "crewvane-test", agent: "concierge" },
      "goal_blocked",
      "等待处理后派发",
    ),
    /打开管家现场，完成或关闭当前提示后再重试/,
  );
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0]!.slice(0, 3), ["agent", "prompt", "concierge"]);
  assert.equal(mock.calls.some(args => args[0] === "pane" && args[1] === "run"), false);
});

test("a stalled lifecycle probe does not duplicate a prompt that already reached the agent", async () => {
  const mock = fake({
    "agent prompt": '!Herdr agent prompt：{"code":"agent_prompt_stalled","message":"prompt was submitted but produced no observed working state"}',
  });
  const receipt = await new HerdrClient(mock.runner, "crewvane-test").notifyGoal(
    { session: "crewvane-test", agent: "concierge" },
    "goal_stalled_probe",
    "已送达但状态侦测延迟",
  );
  assert.equal(receipt.status, "unconfirmed");
  assert.match(receipt.detail ?? "", /不重复发送/);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0]!.slice(0, 3), ["agent", "prompt", "concierge"]);
});

test("a lifecycle status timeout is unconfirmed and never replayed", async () => {
  const mock = fake({
    "agent prompt": '!Herdr agent prompt：{"code":"timeout","message":"timed out waiting for agent status"}',
  });
  const receipt = await new HerdrClient(mock.runner, "crewvane-test").notifyGoal(
    { session: "crewvane-test", agent: "concierge" },
    "goal_timeout_probe",
    "已提交但状态确认超时",
  );
  assert.equal(receipt.status, "unconfirmed");
  assert.match(receipt.detail ?? "", /状态确认超时/);
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.calls[0]!.slice(0, 3), ["agent", "prompt", "concierge"]);
});

test("restart notifications carry the user's note and restored-owner context", async () => {
  const mock = fake({ "agent prompt": "{}" });
  await new HerdrClient(mock.runner, "crewvane-test").notifyGoal(
    { session: "crewvane-test", agent: "concierge" },
    "goal_restart",
    "继续原目标",
    {
      id: "goal_restart",
      title: "继续原目标",
      description: "原有目标说明",
      projectId: "personal",
      status: "active",
      next: "恢复原负责人",
      attention: null,
      attachments: [],
      activities: [],
      dispatch: {
        kind: "restart",
        note: "补齐异常场景",
        status: "pending",
        at: new Date().toISOString(),
      },
    } as any,
  );
  const prompt = mock.calls.find(args => args[0] === "agent" && args[1] === "prompt")![3]!;
  assert.match(prompt, /event: restart/);
  assert.match(prompt, /restart_note: 补齐异常场景/);
  assert.match(prompt, /桌面已经优先恢复原负责人会话/);
});

test("initial concierge identity delivery also tolerates a missed short lifecycle transition without resending", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [] } }),
    "workspace create": JSON.stringify({ result: {
      workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" },
    } }),
    "pane run": "{}", "pane wait-output": "{}", "agent start": "{}",
    "pane process-info": '{"result":{"process_info":{"shell_pid":10,"foreground_processes":[{"pid":42}]}}}',
    "agent prompt": '!Herdr agent prompt：{"code":"agent_prompt_stalled","message":"short turn already settled"}',
    "tab focus": "{}",
  });
  const reference = await new HerdrClient(mock.runner, "cv-test", "/tmp/workspace").prepareConcierge("/tmp/workspace");
  assert.equal(reference.agent, "concierge");
  assert.equal(reference.processId, 42);
  assert.equal(mock.calls.filter(args => args[1] === "prompt").length, 1);
  assert.equal(mock.calls.filter(args => args[1] === "start").length, 1);
});

test("surfaces a stopped server without inventing a session", async () => {
  const mock = fake({ "agent list": '!Herdr agent list：{"error":"server_not_running"}' });
  await assert.rejects(
    () => new HerdrClient(mock.runner, "crewvane-test").prepareConcierge("/tmp/workspace"),
    /server_not_running/,
  );
});

test("starts one replacement only after a stale pane is rejected", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [] } }),
    "pane get": '!Herdr pane get：{"error":"pane_not_found"}',
    "workspace create": JSON.stringify({ result: {
      workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" },
    } }),
    "pane run": "{}", "pane wait-output": "{}", "agent start": "{}", "agent prompt": "{}",
    "tab close": "{}", "tab focus": "{}",
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").prepareConcierge(
    "/tmp/workspace",
    { session: "crewvane-test", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", agent: "concierge" },
    "codex",
    "/tmp/bin",
    "/home/test/.local/bin",
    "/home/test/.local/bin",
  );
  assert.equal(reference.paneId, "w8:p1");
  assert.equal(mock.calls.filter((args) => args[0] === "workspace" && args[1] === "create").length, 1);
  const start = mock.calls.find((args) => args[0] === "agent" && args[1] === "start");
  assert.deepEqual(start?.slice(0, 6), ["agent", "start", "concierge", "--kind", "codex", "--pane"]);
  assert.equal(mock.calls.some(args => args[0] === "tab" && args[1] === "close"), false);
  assert.ok(!start?.includes("workspace-write"));
  assert.ok(!start?.includes("sandbox_workspace_write.network_access=true"));
  assert.ok(!start?.includes("danger-full-access"));
  const instructions = mock.calls.find(args => args[0] === "agent" && args[1] === "prompt")?.[3];
  assert.match(instructions!, /不亲自执行目标/);
  assert.match(instructions!, /不能因为任务简单而自己执行/);
  assert.match(instructions!, /由负责人产出真实成果、实际运行检查/);
  assert.match(instructions!, /crewvane direct --new/);
  assert.match(instructions!, /不能在终端里处理完却不写回 App/);
  assert.match(instructions!, /crewvane owner launch/);
  assert.match(instructions!, /清除管家继承的案卷限制/);
  assert.match(instructions!, /不要手工串联/);
    assert.match(instructions!, /不得只写「已回答」/);
  assert.doesNotMatch(instructions!, /workflow list|--stage|工序快照/);
  assert.doesNotMatch(instructions!, /简单事项你可以自己完成/);
});

test("starts a fresh governed concierge when the old pane contains a manual agent", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [] } }),
    "pane get": JSON.stringify({ result: { pane: {
      pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1",
    } } }),
    "pane process-info": JSON.stringify({ result: { process_info: {
      shell_pid: 12,
      foreground_processes: [{ pid: 99, name: "manual-agent" }],
    } } }),
    "workspace create": JSON.stringify({ result: {
      workspace: { workspace_id: "w8" }, tab: { tab_id: "w8:t1" }, root_pane: { pane_id: "w8:p1" },
    } }),
    "pane run": "{}", "pane wait-output": "{}", "agent start": "{}", "agent prompt": "{}",
    "tab focus": "{}",
  });
  const reference = await new HerdrClient(mock.runner, "crewvane-test").prepareConcierge(
    "/tmp/workspace",
    {
      session: "crewvane-test", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1",
      agent: "concierge", launchPolicy: "control-plane-v1",
    },
    "codex",
    "/tmp/bin",
    "/home/test/.local/bin",
    "/home/test/.local/bin",
  );
  assert.equal(reference.paneId, "w8:p1");
  assert.ok(mock.calls.some(args => args[0] === "workspace" && args[1] === "create"));
  assert.equal(mock.calls.some(args =>
    args[0] === "pane" && args[1] === "run" && args[2] === "w1:p1"), false);
  assert.equal(mock.calls.some(args =>
    args[0] === "tab" && args[1] === "close" && args[2] === "w1:t1"), false);
});

test("custom commands start in the real pane, preserve argv and reuse the recorded foreground process", async () => {
  const mock = fake({
    "agent list": '{"result":{"agents":[]}}',
    "workspace create": '{"result":{"workspace":{"workspace_id":"w8"},"tab":{"tab_id":"w8:t1"},"root_pane":{"pane_id":"w8:p1"}}}',
    "pane run": "{}", "pane wait-output": "{}", "tab focus": "{}",
    "pane process-info": '{"result":{"process_info":{"shell_pid":12,"foreground_processes":[{"pid":42,"name":"custom-cli"}]}}}',
  });
  const client = new HerdrClient(mock.runner, "custom-session");
  const reference = await client.prepareConcierge("/workspace", undefined, "", "/cli", "/bin", "/agents",
    undefined, { concierge: 'custom-cli --model "custom model"' }, ["--model", "custom model"], "/agents/custom-cli");
  assert.equal(reference.transport, "pane"); assert.equal(reference.processId, 42);
  assert.ok(mock.calls.some(args => args[0] === "pane" && args[3] === "'/agents/custom-cli' '--model' 'custom model'"));
  assert.ok(!mock.calls.some(args => args[0] === "agent" && args[1] === "start"));
  assert.equal((await client.prepareConcierge("/workspace", reference)).processId, 42);
  await client.notifyGoal(reference, "g1", "目标");
  assert.equal(mock.calls.filter(args => args[0] === "workspace" && args[1] === "create").length, 1);
  assert.ok(mock.calls.some(args => args[0] === "pane" && args[1] === "run" && args[3]?.includes("g1")));
  const messages = mock.calls.filter(args => args[0] === "pane" && args[1] === "run" && args[3]?.includes("不亲自执行目标"));
  assert.equal(messages.length, 2, "both initial instructions and a reused custom CLI receive the role boundary");
});

test("a custom Pane discovered as an Agent uses lifecycle-aware prompting", async () => {
  const mock = fake({
    "pane process-info": '{"result":{"process_info":{"shell_pid":12,"foreground_processes":[{"pid":42,"name":"codex"}]}}}',
    "agent list": '{"result":{"agents":[{"name":"detected-codex","agent_status":"idle","workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}]}}',
    "agent prompt": "{}",
  });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  const result = await client.notifyGoal({
    session: "crewvane-test",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    agent: "concierge",
    processId: 42,
    transport: "pane",
    launchPolicy: "control-plane-v1",
  }, "goal_detected", "自动发现 Agent");
  assert.deepEqual(result, { status: "sent" });
  assert.deepEqual(
    mock.calls.find(args => args[0] === "agent" && args[1] === "prompt")?.slice(0, 3),
    ["agent", "prompt", "w1:p1"],
  );
  assert.equal(
    mock.calls.some(args => args[0] === "pane" && args[1] === "run"),
    false,
  );
});

test("custom command exit or a replaced foreground process never receives task text", async () => {
  for (const foreground_processes of [[], [{ pid: 99 }]]) {
    const mock = fake({ "pane process-info": JSON.stringify({ result: { process_info: { shell_pid: 12, foreground_processes } } }) });
    const client = new HerdrClient(mock.runner);
    await assert.rejects(client.notifyGoal({ session: "crewvane", paneId: "w1:p1", transport: "pane", processId: 42 }, "g1", "任务"), /已退出或现场已更换/);
    assert.ok(!mock.calls.some(args => args[1] === "run"), "never send instructions to an idle shell or replacement program");
  }
});
test("completed goal scenes close their dedicated Herdr tab and recover a moved tab by live identity", async () => {
  const direct = fake({ "tab close": "{}" });
  await new HerdrClient(direct.runner, "crewvane-test").closeGoal({
    session: "crewvane-test", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", agent: "owner-a",
  });
  assert.deepEqual(direct.calls, [["tab", "close", "w1:t2"]]);

  const moved = fake({
    "tab close": '!Herdr tab close：{"error":"tab_not_found"}',
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a", agent: "owner-a", workspace_id: "w1", tab_id: "w1:t9", pane_id: "w1:p9",
    }] } }),
  });
  await new HerdrClient(moved.runner, "crewvane-test").closeGoal({
    session: "crewvane-test", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", agent: "owner-a",
  });
  assert.deepEqual(moved.calls, [
    ["tab", "close", "w1:t2"],
    ["agent", "list"],
    ["tab", "close", "w1:t9"],
  ]);
});
test("captures the owner's resumable Agent identity before the tab closes", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "owner-a",
      agent: "owner-a",
      agent_session: {
        source: "herdr:codex",
        agent: "codex",
        kind: "id",
        value: "session-123",
      },
      agent_status: "idle",
      workspace_id: "w1",
      tab_id: "w1:t2",
      pane_id: "w1:p2",
      cwd: "/tmp/project",
    }] } }),
  });
  const resume = await new HerdrClient(mock.runner, "crewvane-test").captureOwnerResume({
    session: "crewvane-test",
    workspaceId: "w1",
    tabId: "w1:t2",
    paneId: "w1:p2",
    agent: "owner-a",
  });
  assert.equal(resume?.owner, "owner-a");
  assert.equal(resume?.cwd, "/tmp/project");
  assert.deepEqual(resume?.agentSession, {
    source: "herdr:codex",
    agent: "codex",
    kind: "id",
    value: "session-123",
  });
  assert.ok(resume?.savedAt);
});
test("does not capture a resume identity from a replaced or foreign session", async () => {
  const mock = fake({
    "agent list": JSON.stringify({ result: { agents: [{
      name: "other-owner", agent_status: "idle", workspace_id: "w1",
      tab_id: "w1:t8", pane_id: "w1:p8",
    }] } }),
  });
  const client = new HerdrClient(mock.runner, "crewvane-test");
  assert.equal(await client.captureOwnerResume({
    session: "crewvane-test", paneId: "w1:p2", agent: "owner-a",
  }), undefined);
  assert.equal(await client.captureOwnerResume({
    session: "someone-else", paneId: "w1:p8", agent: "other-owner",
  }), undefined);
});
test("custom CLI prompt fits canonical terminal lines and preserves Unicode content", () => {
  const text = "长提示词✨".repeat(400);
  const wrapped = terminalPrompt(text);
  assert.equal(wrapped.replaceAll("\n", ""), text);
  assert.ok(wrapped.split("\n").every(line => Buffer.byteLength(line) <= 768));
});
