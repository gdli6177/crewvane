import test from "node:test";
import assert from "node:assert/strict";
import {
  AutonomyScheduler,
  type AutonomyCandidate,
} from "../electron/autonomy-scheduler.js";
import type { CrewvaneCommand } from "../../../packages/core/src/index.js";

test("scheduler claims each due continuation, dispatches with its lease, and reports sent", async () => {
  const calls: CrewvaneCommand[] = [],
    candidate: AutonomyCandidate = {
      goalId: "goal_1",
      continuationId: "continuation_1",
      trigger: "checkpoint",
      dueAt: "2026-01-01T00:00:00.000Z",
      attempt: 1,
      basisRevision: "1:date",
      status: "active",
    };
  const scheduler = new AutonomyScheduler({
    service: () => ({
      async execute(command) {
        calls.push(command);
        if (command.type === "autonomy.inspect") return [candidate];
        if (command.type === "autonomy.claim")
          return {
            claimed: true,
            goalId: candidate.goalId,
            continuation: {
              id: candidate.continuationId,
              attempt: 1,
              leaseId: "lease_current",
            },
          };
        return { updated: true };
      },
    }),
    now: () => new Date("2026-01-01T00:00:01.000Z"),
    dispatch: async (_item, leaseId) => {
      assert.equal(leaseId, "lease_current");
      return { status: "accepted" };
    },
  });
  assert.equal(await scheduler.tick(), 1);
  assert.deepEqual(calls.map(call => call.type), [
    "autonomy.inspect",
    "autonomy.claim",
    "autonomy.report",
  ]);
  const report = calls[2] as Extract<CrewvaneCommand, { type: "autonomy.report" }>;
  assert.equal(report.outcome, "sent");
  assert.equal(report.leaseId, "lease_current");
});

test("scheduler turns dispatch failures into an actionable failed report", async () => {
  let reported: Extract<CrewvaneCommand, { type: "autonomy.report" }> | undefined;
  const scheduler = new AutonomyScheduler({
    service: () => ({
      async execute(command) {
        if (command.type === "autonomy.inspect")
          return [{
            goalId: "goal_1",
            continuationId: "continuation_1",
            trigger: "verification",
            dueAt: "2026-01-01T00:00:00.000Z",
            attempt: 2,
            basisRevision: "2:date",
            status: "review",
          }];
        if (command.type === "autonomy.claim")
          return {
            claimed: true,
            goalId: "goal_1",
            continuation: {
              id: "continuation_1",
              attempt: 2,
              leaseId: "lease_failed",
            },
          };
        if (command.type === "autonomy.report") reported = command;
        return undefined;
      },
    }),
    now: () => new Date("2026-01-01T00:00:01.000Z"),
    dispatch: async () => {
      throw new Error("负责人现场不可达");
    },
  });
  assert.equal(await scheduler.tick(), 1);
  assert.equal(reported?.outcome, "failed");
  assert.match(reported?.detail ?? "", /现场不可达/);
});

test("scheduler never claims when inspect returns nothing or the workspace is closed", async () => {
  const commands: string[] = [];
  const closed = new AutonomyScheduler({
    service: () => undefined,
    dispatch: async () => ({ status: "accepted" }),
  });
  assert.equal(await closed.tick(), 0);
  const empty = new AutonomyScheduler({
    service: () => ({
      async execute(command) {
        commands.push(command.type);
        return [];
      },
    }),
    dispatch: async () => ({ status: "accepted" }),
  });
  assert.equal(await empty.tick(), 0);
  assert.deepEqual(commands, ["autonomy.inspect"]);
});
