import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkspaceService,
  type Goal,
} from "../../packages/core/src/index.js";
import {
  attachOwner,
  type OwnerAttachInput,
} from "../src/owner-attach.js";
import type { HerdrCommandRunner } from "../src/owner-launch.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-owner-attach-"));
  fixtures.push(root);
  const service = new WorkspaceService(root),
    goal = await service.execute({
      type: "goal.create",
      input: {
        title: "恢复负责人现场",
        projectId: "personal",
        mode: "concierge",
      },
    }) as Goal;
  await service.execute({
    type: "goal.owner-launch.recovery",
    goalId: goal.id,
    recovery: {
      id: "recovery_test_123",
      attemptId: "attempt_test_123",
      session: "crewvane-test",
      createdAt: new Date().toISOString(),
      status: "pending",
      tabId: "w1:t2",
      paneId: "w1:p2",
    },
  });
  return { root, service, goal };
}

function runner(options: { agent?: boolean } = {}) {
  const calls: string[][] = [];
  const run: HerdrCommandRunner = async args => {
    calls.push(args);
    if (args[0] === "tab" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
      } });
    if (args[0] === "pane" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
        pane_id: "w1:p2",
      } });
    if (args[0] === "agent" && args[1] === "get")
      return options.agent
        ? JSON.stringify({ result: { agent: {
            name: args[2],
            pane_id: "w1:p2",
          } } })
        : JSON.stringify({ result: {} });
    if (args[0] === "pane" && args[1] === "process-info")
      return JSON.stringify({ result: { process_info: {
        shell_pid: 10,
        foreground_processes: [{ pid: 42 }],
      } } });
    return "{}";
  };
  return { calls, run };
}

const input: OwnerAttachInput = {
  goalId: "",
  name: "owner-a",
  session: "crewvane-test",
  workspaceId: "w1",
  tabId: "w1:t2",
  paneId: "w1:p2",
  recoveryId: "recovery_test_123",
};

test("binds a verified existing Agent scene and consumes the matching recovery ID", async () => {
  const { service, goal } = await fixture(),
    mock = runner({ agent: true });
  const result = await attachOwner(service, {
      ...input,
      goalId: goal.id,
      agent: "owner-a",
    }, {
      environment: {
        HERDR_ENV: "1",
        HERDR_SESSION: "crewvane-test",
      },
      run: mock.run,
    });
  assert.deepEqual(result.reference, {
    session: "crewvane-test",
    workspaceId: "w1",
    tabId: "w1:t2",
    paneId: "w1:p2",
    agent: "owner-a",
  });
  const saved = (await service.read()).goals[0]!;
  assert.equal(saved.herdr?.agent, "owner-a");
  assert.equal(saved.ownerLaunchRecovery?.status, "attached");
  assert.equal(
    mock.calls.some(call =>
      call[0] === "agent" &&
      call[1] === "prompt"),
    false,
    "recovery must never replay the Agent task",
  );
});

test("binds an unmanaged custom CLI only when its foreground process is real", async () => {
  const { service, goal } = await fixture(),
    mock = runner();
  const result = await attachOwner(service, {
    ...input,
    goalId: goal.id,
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run: mock.run,
  });
  assert.equal(result.reference.transport, "pane");
  assert.equal(result.reference.processId, 42);
});

test("binds an exec-launched custom CLI when it replaced the pane shell", async () => {
  const { service, goal } = await fixture();
  const mock = runner();
  mock.run = async args => {
    if (args[0] === "tab" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
      } });
    if (args[0] === "pane" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
        pane_id: "w1:p2",
      } });
    if (args[0] === "pane" && args[1] === "process-info")
      return JSON.stringify({ result: { process_info: {
        shell_pid: 42,
        foreground_processes: [{
          pid: 42,
          name: "sleep",
          argv0: "sleep",
          cmdline: "sleep 60",
        }],
      } } });
    return "{}";
  };
  const result = await attachOwner(service, {
    ...input,
    goalId: goal.id,
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run: mock.run,
  });
  assert.equal(result.reference.transport, "pane");
  assert.equal(result.reference.processId, 42);
});

test("does not bind an idle pane shell as an owner process", async () => {
  const { service, goal } = await fixture();
  const run: HerdrCommandRunner = async args => {
    if (args[0] === "tab" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
      } });
    if (args[0] === "pane" && args[1] === "get")
      return JSON.stringify({ result: {
        workspace_id: "w1",
        tab_id: "w1:t2",
        pane_id: "w1:p2",
      } });
    if (args[0] === "pane" && args[1] === "process-info")
      return JSON.stringify({ result: { process_info: {
        shell_pid: 42,
        foreground_processes: [{ pid: 42, name: "zsh", argv0: "zsh" }],
      } } });
    return "{}";
  };
  await assert.rejects(attachOwner(service, {
    ...input,
    goalId: goal.id,
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run,
  }), /没有可核实的 Agent 或前台进程/);
});

test("rejects stale recovery IDs, Session drift and occupied scenes", async () => {
  const { service, goal } = await fixture(),
    mock = runner({ agent: true });
  await assert.rejects(attachOwner(service, {
    ...input,
    goalId: goal.id,
    recoveryId: "recovery_wrong_123",
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run: mock.run,
  }), /恢复 ID/);

  const saved = (await service.read()).goals[0]!;
  await service.execute({
    type: "goal.owner-launch.recovery",
    goalId: goal.id,
    recovery: {
      ...saved.ownerLaunchRecovery!,
      status: "superseded",
    },
  });
  await assert.rejects(attachOwner(service, {
    ...input,
    goalId: goal.id,
    agent: "owner-a",
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run: mock.run,
  }), /新的负责人启动记录取代/);
  await service.execute({
    type: "goal.owner-launch.recovery",
    goalId: goal.id,
    recovery: {
      ...saved.ownerLaunchRecovery!,
      status: "pending",
    },
  });
  await assert.rejects(attachOwner(service, {
    ...input,
    goalId: goal.id,
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "another-session",
    },
    run: mock.run,
  }), /Session/);

  await service.execute({
    type: "session.set",
    goalId: goal.id,
    reference: {
      session: "crewvane-test",
      workspaceId: "w1",
      tabId: "w1:t9",
      paneId: "w1:p9",
      agent: "other-owner",
    },
  });
  await assert.rejects(attachOwner(service, {
    ...input,
    goalId: goal.id,
    agent: "owner-a",
  }, {
    environment: {
      HERDR_ENV: "1",
      HERDR_SESSION: "crewvane-test",
    },
    run: mock.run,
  }), /其他负责人现场/);
});
