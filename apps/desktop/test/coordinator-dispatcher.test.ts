import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoordinatorInbox, type CoordinatorInboxStatus } from "../electron/coordinator-inbox.js";
import { CoordinatorDispatcher } from "../electron/coordinator-dispatcher.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-coordinator-dispatch-"));
  roots.push(root);
  const inbox = await CoordinatorInbox.open(root);
  const events: string[] = [];
  const statuses: CoordinatorInboxStatus[] = [];
  return { inbox, events, statuses, root };
}

test("drains human work before background work without interleaving", async () => {
  const { inbox, events, statuses } = await fixture();
  const dispatcher = new CoordinatorDispatcher(inbox, {
    execute: async item => {
      events.push(`${item.requestId}:start`);
      await new Promise(resolve => setTimeout(resolve, item.requestId === "human" ? 10 : 1));
      events.push(`${item.requestId}:end`);
      return { status: "sent", estimatedChars: 1_000 };
    },
    onStatus: status => {
      statuses.push(status);
    },
  });
  await dispatcher.enqueue({
    goalId: "goal_background",
    requestId: "background",
    kind: "watchdog",
    priority: "background",
    watchdogReason: "stale",
    watchdogBasis: "basis",
  });
  await dispatcher.enqueue({
    goalId: "goal_human",
    requestId: "human",
    kind: "feedback",
    priority: "human",
  });
  await dispatcher.drain();
  assert.deepEqual(events, ["human:start", "human:end", "background:start", "background:end"]);
  assert.equal(statuses.at(-1)?.processed, 2);
});

test("a failed item does not block later queued cases", async () => {
  const { inbox, events } = await fixture();
  const dispatcher = new CoordinatorDispatcher(inbox, {
    execute: async item => {
      events.push(item.requestId);
      if (item.requestId === "failed") throw new Error("offline");
      return { status: "sent" };
    },
    onStatus: () => {},
  });
  await dispatcher.enqueue({
    goalId: "goal_failed",
    requestId: "failed",
    kind: "goal",
    priority: "normal",
  });
  await dispatcher.enqueue({
    goalId: "goal_next",
    requestId: "next",
    kind: "goal",
    priority: "normal",
  });
  await dispatcher.drain();
  assert.deepEqual(events, ["failed", "next"]);
  const status = await inbox.status();
  assert.equal(status.failed, 1);
  assert.equal(status.processed, 2);
});

test("a live unconfirmed turn pauses the queue until the next drain", async () => {
  const { inbox, events } = await fixture();
  let calls = 0;
  const dispatcher = new CoordinatorDispatcher(inbox, {
    execute: async item => {
      events.push(item.requestId);
      calls += 1;
      return calls === 1
        ? { status: "unconfirmed", detail: "still working", pauseQueue: true }
        : { status: "sent" };
    },
    onStatus: () => {},
  });
  await dispatcher.enqueue({
    goalId: "goal_first",
    requestId: "first",
    kind: "feedback",
    priority: "human",
  });
  await dispatcher.enqueue({
    goalId: "goal_second",
    requestId: "second",
    kind: "goal",
    priority: "normal",
  });
  await dispatcher.drain();
  assert.deepEqual(events, ["first"]);
  assert.equal((await inbox.status()).queued, 1);
  await dispatcher.drain();
  assert.deepEqual(events, ["first", "second"]);
});

test("twenty goals and one hundred events coalesce into one current notification per goal", async () => {
  const { inbox, events } = await fixture();
  const dispatcher = new CoordinatorDispatcher(inbox, {
    execute: async item => {
      events.push(item.requestId);
      await new Promise(resolve => setTimeout(resolve, 1));
      return { status: "sent", estimatedChars: 1_000 };
    },
    onStatus: () => {},
  });
  for (let goal = 0; goal < 20; goal += 1) {
    for (let event = 0; event < 5; event += 1) {
      await dispatcher.enqueue({
        goalId: `goal_${goal}`,
        requestId: `request_${goal}_${event}`,
        kind: event === 4 ? "feedback" : "goal",
        priority: event === 4 ? "human" : "normal",
      });
    }
  }
  await dispatcher.drain();
  assert.equal(events.length, 20);
  assert.equal(new Set(events).size, 20);
  assert.ok(events.every(requestId => requestId.endsWith("_4")));
  const status = await inbox.status();
  assert.equal(status.queued, 0);
  assert.equal(status.processing, undefined);
  assert.equal(status.processed, 20);
});

test("an enqueue racing with the final empty claim is drained in the same cycle", async () => {
  const { inbox, events } = await fixture();
  let releaseClaim!: () => void;
  let claimStarted!: () => void;
  const claimStartedPromise = new Promise<void>(resolve => { claimStarted = resolve; });
  const claimGate = new Promise<void>(resolve => { releaseClaim = resolve; });
  const originalClaim = inbox.claimNext.bind(inbox);
  let first = true;
  inbox.claimNext = async () => {
    if (first) {
      first = false;
      claimStarted();
      await claimGate;
    }
    return originalClaim();
  };
  const dispatcher = new CoordinatorDispatcher(inbox, {
    execute: async item => {
      events.push(item.requestId);
      return { status: "sent" };
    },
    onStatus: () => {},
  });
  const draining = dispatcher.drain();
  await claimStartedPromise;
  const enqueued = dispatcher.enqueue({
    goalId: "goal_race",
    requestId: "request_race",
    kind: "feedback",
    priority: "human",
  });
  releaseClaim();
  await enqueued;
  await draining;
  assert.deepEqual(events, ["request_race"]);
  assert.equal((await inbox.status()).queued, 0);
});
