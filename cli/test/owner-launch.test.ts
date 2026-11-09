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
  const environmentCall = mock.calls.find(
    (args) => args[0] === "pane" && args[1] === "run",
  );
  assert.ok(environmentCall);
  assert.match(environmentCall[3]!, /unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE/);
  assert.match(
    environmentCall[3]!,
    new RegExp(`CREWVANE_WORKSPACE='${await realpath(root)}'`),
  );
  assert.match(environmentCall[3]!, /CREWVANE_AGENT_NAME='case-owner'/);
  const exported = await promisify(execFile)("/bin/sh", ["-c", `${environmentCall[3]}; /usr/bin/env`],
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
  assert.equal(launches.length, 3);
  assert.match(launches[1]![3]!, /My Agent/);
  assert.equal(launches.at(-1)![2], "w7:p3");
  assert.match(launches.at(-1)![3]!, /^执行自定义任务\n/);
  assert.match(launches.at(-1)![3]!, /goal scene-reply/);
  const state = await service.read();
  assert.equal(state.goals[0]?.herdr?.transport, "pane");
  assert.equal(state.goals[0]?.herdr?.processId, 42);
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
