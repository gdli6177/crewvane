import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  WorkspaceService,
  type Goal,
} from "../../packages/core/src/index.js";
import {
  startAgentWhenPaneReady,
  launchOwner,
  type HerdrCommandRunner,
} from "../src/owner-launch.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })
    ),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-owner-launch-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}

function fakeRunner(options: {
  custom?: boolean;
  stallPrompt?: boolean;
  paneShape?: boolean;
} = {}) {
  const calls: string[][] = [];
  const run: HerdrCommandRunner = async (args) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    if (key === "agent start" && args.includes("--help"))
      return "[possible values: omp, codex]";
    if (key === "tab create")
      return JSON.stringify({
        result: {
          workspace: { workspace_id: "w7" },
          tab: { tab_id: "w7:t3" },
          ...(options.paneShape
            ? { pane: { pane_id: "w7:p3", tab_id: "w7:t3" } }
            : { root_pane: { pane_id: "w7:p3" } }),
        },
      });
    if (key === "pane process-info" && options.custom)
      return JSON.stringify({
        result: {
          process_info: {
            shell_pid: 10,
            foreground_processes: [{ pid: 42 }],
          },
        },
      });
    if (key === "agent prompt" && options.stallPrompt)
      throw new Error(
        'Herdr agent prompt: {"code":"agent_prompt_stalled"}',
      );
    return "{}";
  };
  return { calls, run };
}

test("launches the configured agent with an isolated owner environment", async () => {
  const { root, service } = await fixture();
  const goal = (await service.execute({
    type: "goal.create",
    input: {
      title: "隔离负责人",
      projectId: "personal",
      mode: "concierge",
    },
  })) as Goal;
  await service.execute({
    type: "agents.configure",
    preferences: {
      concierge: "codex",
      owner: "omp --model codex/gpt-6",
    },
  });
  const mock = fakeRunner({ paneShape: true });
  const result = await launchOwner(
    service,
    { goalId: goal.id, name: "case-owner" },
    {
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "crewvane-test",
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
      run: mock.run,
    },
  );

  assert.equal(result.reference.agent, "case-owner");
  assert.equal(result.reference.workspaceId, "w7");
  const environmentCalls = mock.calls.filter(
    (args) => args[0] === "pane" && args[1] === "run",
  );
  const environmentScript = environmentCalls.map(args => args[3]).join("; ");
  assert.ok(environmentCalls.length);
  assert.match(environmentScript, /unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE/);
  assert.match(
    environmentScript,
    new RegExp(`CREWVANE_WORKSPACE='${await realpath(root)}'`),
  );
  assert.match(environmentScript, /CREWVANE_AGENT_NAME='case-owner'/);
  const exported = await promisify(execFile)("/bin/sh", ["-c", `${environmentScript}; /usr/bin/env`],
    { env: { PATH: "/usr/bin:/bin", CREWVANE_COORDINATOR: "1", CREWVANE_COORDINATOR_SCOPE_FILE: "old-scope" } });
  assert.match(exported.stdout, new RegExp(`CREWVANE_GOAL_ID=${goal.id}`));
  assert.match(exported.stdout, new RegExp(`CREWVANE_WORKSPACE=${await realpath(root)}`));
  assert.doesNotMatch(exported.stdout, /CREWVANE_COORDINATOR=/);
  const start = mock.calls.find(
    (args) =>
      args[0] === "agent" &&
      args[1] === "start" &&
      args.includes("--kind"),
  );
  assert.ok(start);
  assert.equal(start[start.indexOf("--kind") + 1], "omp");
  assert.deepEqual(
    start.slice(start.indexOf("--") + 1),
    ["--model", "codex/gpt-6"],
  );
  const prompt = mock.calls.find(
    (args) => args[0] === "agent" && args[1] === "prompt",
  );
  assert.ok(prompt);
  assert.match(prompt[3]!, /隔离负责人/);
  assert.match(prompt[3]!, /完整目标原文/);
  assert.match(prompt[3]!, /goal scene-reply/);
  assert.match(prompt[3]!, /不等于批准、验收或目标完成/);
  assert.deepEqual(prompt.slice(-3), ["--wait", "--until", "working"]);

  const state = await service.read();
  assert.equal(state.goals[0]?.owner, "case-owner");
  assert.equal(state.goals[0]?.herdr?.paneId, "w7:p3");
});

test("retries a busy initialization pane without creating a replacement", async () => {
  const calls: string[][] = [],
    waits: number[] = [];
  let attempts = 0;
  const run: HerdrCommandRunner = async (args) => {
    calls.push(args);
    attempts += 1;
    if (attempts < 3)
      throw new Error('Herdr agent start: {"code":"agent_pane_busy"}');
    return '{"result":{"agent":{"name":"owner-a","pane_id":"w7:p3"}}}';
  };
  await startAgentWhenPaneReady(
    run,
    ["agent", "start", "owner-a", "--kind", "qodercli", "--pane", "w7:p3"],
    async ms => { waits.push(ms); },
  );

  assert.equal(calls.length, 3);
  assert.ok(calls.every(args => args[args.indexOf("--pane") + 1] === "w7:p3"));
  assert.deepEqual(waits, [100, 160]);
});

test("does not replay an agent start error once process startup may have begun", async () => {
  let attempts = 0;
  await assert.rejects(startAgentWhenPaneReady(
    async () => {
      attempts += 1;
      throw new Error('Herdr agent start: {"code":"agent_not_ready"}');
    },
    ["agent", "start", "owner-a", "--kind", "qodercli", "--pane", "w7:p3"],
    async () => {},
  ), /agent_not_ready/);
  assert.equal(attempts, 1);
});

test("reopens the original Agent kind with its native resume arguments", async () => {
  const { root, service } = await fixture();
  const goal = (await service.execute({
    type: "goal.create",
    input: {
      title: "恢复原负责人",
      projectId: "personal",
      mode: "concierge",
    },
  })) as Goal;
  const mock = fakeRunner({ paneShape: true });
  const result = await launchOwner(
    service,
    {
      goalId: goal.id,
      name: "owner-a",
      task: "继续原目标，先等待管家转交新消息。",
      resume: {
        owner: "owner-a",
        cwd: root,
        savedAt: new Date().toISOString(),
        agentSession: {
          source: "herdr:codex",
          agent: "codex",
          kind: "id",
          value: "session-123",
        },
      },
    },
    {
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "crewvane-test",
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
      run: mock.run,
    },
  );
  assert.equal(result.runtime, "codex");
  const start = mock.calls.find(args =>
    args[0] === "agent" && args[1] === "start" && !args.includes("--help"));
  assert.ok(start);
  assert.equal(start[start.indexOf("--kind") + 1], "codex");
  assert.deepEqual(
    start.slice(start.indexOf("--") + 1),
    ["resume", "session-123"],
  );
  assert.equal(
    mock.calls.some(args =>
      args[0] === "agent" && args[1] === "start" && args.includes("--help")),
    false,
  );
  assert.match(mock.calls.find(args =>
    args[0] === "agent" && args[1] === "prompt")![3]!, /继续原目标/);
});

test("launches a custom interactive CLI and records its real foreground process", async () => {
  const { root, service } = await fixture();
  const goal = (await service.execute({
    type: "goal.create",
    input: {
      title: "自定义负责人",
      projectId: "personal",
      mode: "concierge",
    },
  })) as Goal;
  await service.execute({
    type: "agents.configure",
    preferences: {
      concierge: "codex",
      owner: '"/opt/My Agent" --model local',
    },
  });
  const mock = fakeRunner({ custom: true });
  await launchOwner(
    service,
    { goalId: goal.id, name: "custom-owner", task: "执行自定义任务" },
    {
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "crewvane-test",
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
      run: mock.run,
    },
  );

  assert.equal(
    mock.calls.some(
      (args) =>
        args[0] === "agent" &&
        args[1] === "start" &&
        !args.includes("--help"),
    ),
    false,
  );
  const launches = mock.calls.filter(
    (args) => args[0] === "pane" && args[1] === "run",
  );
  assert.ok(launches.length > 3);
  assert.ok(launches.some(args => /My Agent/.test(args[3]!)));
  assert.equal(launches.at(-1)![2], "w7:p3");
  assert.match(launches.at(-1)![3]!, /^执行自定义任务\n/);
  assert.match(launches.at(-1)![3]!, /goal scene-reply/);
  const state = await service.read();
  assert.equal(state.goals[0]?.herdr?.transport, "pane");
  assert.equal(state.goals[0]?.herdr?.processId, 42);
});

test("environment setup never sends one oversized line through a canonical terminal", async () => {
  const { root, service } = await fixture();
  const goal = await service.execute({ type:"goal.create", input:{
    title:"长路径终端", projectId:"personal", mode:"concierge",
  } }) as Goal;
  const mock = fakeRunner();
  await launchOwner(service, { goalId:goal.id, name:"long-path-owner" }, {
    environment:{ HERDR_ENV:"1", HERDR_SESSION:"crewvane-test", HOME:root,
      PATH:Array.from({length:40},(_,index)=>`/opt/${"a".repeat(90)}/${index}`).join(":") },
    run:mock.run,
  });
  const initialization = mock.calls.filter(args => args[0]==="pane" && args[1]==="run")
    .filter(args => !args.includes("agent"));
  assert.ok(initialization.length > 8);
  for (const args of initialization) assert.ok(Buffer.byteLength(args[3]!) <= 768);
  const exported = await promisify(execFile)("/bin/sh", ["-c",
    `${initialization.map(args=>args[3]).join("; ")}; /usr/bin/env`],
    {env:{PATH:"/usr/bin:/bin"}});
  for (let index=0; index<40; index+=1)
    assert.ok(exported.stdout.includes(`/opt/${"a".repeat(90)}/${index}`));
});

test("keeps a bound owner site when Herdr reports a stalled prompt", async () => {
  const { root, service } = await fixture();
  const goal = (await service.execute({
    type: "goal.create",
    input: {
      title: "提交状态待核对",
      projectId: "personal",
      mode: "concierge",
    },
  })) as Goal;
  const mock = fakeRunner({ stallPrompt: true });
  const result = await launchOwner(
    service,
    { goalId: goal.id, name: "stalled-owner", task: "执行任务" },
    {
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "crewvane-test",
        HOME: root,
        PATH: "/usr/bin:/bin",
      },
      run: mock.run,
    },
  );
  assert.match(result.warning ?? "", /禁止重复发送/);
  assert.equal(
    mock.calls.some(
      (args) => args[0] === "tab" && args[1] === "close",
    ),
    false,
  );
  assert.equal((await service.read()).goals[0]?.herdr?.agent, "stalled-owner");
});

test("a failed launch is recorded rather than presented as ongoing execution", async () => {
  const { service } = await fixture();
  const goal = await service.execute({ type:"goal.create", input:{
    title:"启动失败可见", projectId:"personal", mode:"concierge",
  } }) as Goal;
  const calls: string[][] = [];
  await assert.rejects(launchOwner(service, {goalId:goal.id, name:"failed-owner"}, {
    environment:{HERDR_ENV:"1",HERDR_SESSION:"crewvane-test",PATH:"/usr/bin:/bin"},
    run:async args => {
      calls.push(args);
      if (args[0]==="agent" && args[1]==="start" && args.includes("--help"))
        return "[possible values: codex]";
      if (args[0]==="tab" && args[1]==="create") return JSON.stringify({result:{
        workspace:{workspace_id:"w1"},tab:{tab_id:"w1:t2"},root_pane:{pane_id:"w1:p2"},
      }});
      if (args[0]==="pane" && args[1]==="run")
        throw new Error("input contains a 2460-byte line");
      return "{}";
    },
  }),/2460-byte/);
  assert.ok(calls.some(args => args[0]==="tab" && args[1]==="close"));
  const saved = (await service.read()).goals[0]!;
  assert.equal(saved.herdr,undefined);
  assert.equal(saved.status,"active");
  assert.match(saved.next,/尚未开始执行/);
  assert.match(saved.activities.at(-1)!.text,/负责人启动未完成/);
});
