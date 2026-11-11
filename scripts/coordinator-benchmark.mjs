import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CoordinatorDispatcher } from "../apps/desktop/electron/coordinator-dispatcher.ts";
import { CoordinatorInbox } from "../apps/desktop/electron/coordinator-inbox.ts";

const GOALS = 20;
const EVENTS_PER_GOAL = 5;
const TURN_LATENCY_MS = 50;

function percentile(values, ratio) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
}

async function run() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-coordinator-benchmark-"));
  try {
    const inbox = await CoordinatorInbox.open(root);
    const enqueueMsSamples = [];
    const queueWaitMs = [];
    const turnMs = [];
    const dispatched = [];
    const dispatcher = new CoordinatorDispatcher(inbox, {
      execute: async item => {
        const started = performance.now();
        await new Promise(resolve => setTimeout(resolve, TURN_LATENCY_MS));
        turnMs.push(performance.now() - started);
        queueWaitMs.push(Date.now() - Date.parse(item.enqueuedAt));
        dispatched.push(item.requestId);
        return {
          status: "sent",
          estimatedChars: 2_000,
        };
      },
      onStatus: () => {},
    });

    const enqueueStarted = performance.now();
    for (let goal = 0; goal < GOALS; goal += 1) {
      for (let event = 0; event < EVENTS_PER_GOAL; event += 1) {
        const enqueueStarted = performance.now();
        await dispatcher.enqueue({
          goalId: `goal_${goal}`,
          requestId: `request_${goal}_${event}`,
          kind: event === EVENTS_PER_GOAL - 1 ? "feedback" : "goal",
          priority: event === EVENTS_PER_GOAL - 1 ? "human" : "normal",
        });
        enqueueMsSamples.push(performance.now() - enqueueStarted);
      }
    }
    const enqueueMs = performance.now() - enqueueStarted;

    const drainStarted = performance.now();
    await dispatcher.drain();
    const drainMs = performance.now() - drainStarted;
    const status = await inbox.status();
    const stored = JSON.parse(await readFile(
      join(root, ".crewvane", "coordinator-inbox.json"),
      "utf8",
    ));
    const coalesced = stored.items.filter(item => item.status === "coalesced").length;

    return {
      workload: {
        goals: GOALS,
        submittedEvents: GOALS * EVENTS_PER_GOAL,
        simulatedConciergeTurnMs: TURN_LATENCY_MS,
      },
      result: {
        coordinatorTurns: dispatched.length,
        coalescedEvents: coalesced,
        remainingQueued: status.queued,
        processed: status.processed,
      },
      timing: {
        enqueueP50Ms: percentile(enqueueMsSamples, 0.5),
        enqueueP95Ms: percentile(enqueueMsSamples, 0.95),
        totalEnqueueMs: enqueueMs,
        drainMs,
        queueWaitP50Ms: percentile(queueWaitMs, 0.5),
        queueWaitP95Ms: percentile(queueWaitMs, 0.95),
        coordinatorTurnP50Ms: percentile(turnMs, 0.5),
        coordinatorTurnP95Ms: percentile(turnMs, 0.95),
        coordinatorTurnsPerSecond: dispatched.length / (drainMs / 1_000),
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const samples = [];
for (let index = 0; index < 3; index += 1) samples.push(await run());
console.log(JSON.stringify({ samples }, null, 2));
