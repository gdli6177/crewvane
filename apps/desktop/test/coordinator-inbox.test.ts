import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoordinatorInbox } from "../electron/coordinator-inbox.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-coordinator-inbox-"));
  roots.push(root);
  return { root, inbox: await CoordinatorInbox.open(root) };
}

test("persists priority order and keeps the inbox private", async () => {
  const { root, inbox } = await fixture();
  await inbox.enqueue({
    goalId: "goal_normal",
    requestId: "request_normal",
    kind: "goal",
    priority: "normal",
  });
  await inbox.enqueue({
    goalId: "goal_human",
    requestId: "request_human",
    kind: "feedback",
    priority: "human",
  });
  assert.equal((await inbox.claimNext())?.requestId, "request_human");
  assert.equal((await inbox.claimNext())?.requestId, undefined);
  assert.equal((await stat(join(root, ".crewvane", "coordinator-inbox.json"))).mode & 0o777, 0o600);
});

test("coalesces an older queued notification for the same goal", async () => {
  const { inbox } = await fixture();
  await inbox.enqueue({
    goalId: "goal_one",
    requestId: "request_old",
    kind: "feedback",
    priority: "human",
  });
  await inbox.enqueue({
    goalId: "goal_one",
    requestId: "request_new",
    kind: "feedback",
    priority: "human",
  });
  assert.equal((await inbox.claimNext())?.requestId, "request_new");
  assert.equal((await inbox.status()).queued, 0);
});

test("a lower-priority notification cannot displace a queued human request", async () => {
  const { inbox } = await fixture();
  await inbox.enqueue({
    goalId: "goal_one",
    requestId: "request_human",
    kind: "feedback",
    priority: "human",
  });
  const coalesced = await inbox.enqueue({
    goalId: "goal_one",
    requestId: "request_watchdog",
    kind: "watchdog",
    priority: "background",
    watchdogReason: "stale",
    watchdogBasis: "basis",
  });
  assert.equal(coalesced.status, "coalesced");
  assert.match(coalesced.detail!, /request_human/);
  assert.equal((await inbox.claimNext())?.requestId, "request_human");
});

test("recovery keeps never-started work queued and marks in-flight work unconfirmed", async () => {
  const { root, inbox } = await fixture();
  await inbox.enqueue({
    goalId: "goal_processing",
    requestId: "request_processing",
    kind: "goal",
    priority: "normal",
  });
  await inbox.enqueue({
    goalId: "goal_waiting",
    requestId: "request_waiting",
    kind: "reconcile",
    priority: "background",
  });
  assert.equal((await inbox.claimNext())?.requestId, "request_processing");

  const reopened = await CoordinatorInbox.open(root);
  const recovered = await reopened.recoverInterrupted();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.item.requestId, "request_processing");
  assert.match(recovered[0]!.detail, /避免重复发送/);
  const status = await reopened.status();
  assert.equal(status.queued, 1);
  assert.equal(status.unconfirmed, 1);
  assert.equal((await reopened.claimNext())?.requestId, "request_waiting");
});

test("retains a bounded inbox and requests context rotation at the budget", async () => {
  const { root, inbox } = await fixture();
  for (let index = 0; index < 45; index += 1) {
    await inbox.enqueue({
      goalId: `goal_${index}`,
      requestId: `request_${index}`,
      kind: "goal",
      priority: "normal",
    });
    const claimed = await inbox.claimNext();
    await inbox.finish(claimed!.id, "sent", "sent", 4_000);
  }
  const status = await inbox.status();
  assert.equal(status.contextCases, 45);
  assert.equal(status.contextResetDue, true);
  const stored = JSON.parse(await readFile(join(root, ".crewvane", "coordinator-inbox.json"), "utf8"));
  assert.ok(stored.items.length <= 240);
  const reset = await inbox.markContextReset();
  assert.equal(reset.contextCases, 0);
  assert.equal(reset.contextResetDue, false);
  assert.equal(reset.contextEpoch, 2);
});

test("deduplicates active requests and allows watchdog retry after its cooldown", async () => {
  const { root, inbox } = await fixture();
  const input = {
    goalId: "goal_watchdog",
    requestId: "watchdog-stale-basis",
    kind: "watchdog" as const,
    priority: "background" as const,
    watchdogReason: "stale",
    watchdogBasis: "2026-01-01T00:00:00.000Z",
  };
  const first = await inbox.enqueue(input);
  assert.equal((await inbox.enqueue(input)).id, first.id);
  const claimed = await inbox.claimNext();
  await inbox.finish(claimed!.id, "failed", "offline");
  const path = join(root, ".crewvane", "coordinator-inbox.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  const failed = stored.items.find((item: { id: string }) => item.id === first.id);
  failed.finishedAt = new Date(Date.now() - 61_000).toISOString();
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
  const reopened = await CoordinatorInbox.open(root);
  const retried = await reopened.enqueue(input);
  assert.notEqual(retried.id, first.id);
});

test("a successful newer retry clears the dashboard's actionable failure count", async () => {
  const { inbox } = await fixture();
  await inbox.enqueue({
    goalId: "goal_retry",
    requestId: "request_failed",
    kind: "goal",
    priority: "normal",
  });
  const first = await inbox.claimNext();
  await inbox.finish(first!.id, "failed", "offline");
  const failed = await inbox.status();
  assert.equal(failed.failed, 1);
  assert.deepEqual(failed.alerts.map(alert => alert.goalId), ["goal_retry"]);

  await inbox.enqueue({
    goalId: "goal_retry",
    requestId: "request_sent",
    kind: "feedback",
    priority: "human",
  });
  const retry = await inbox.claimNext();
  await inbox.finish(retry!.id, "sent", "sent");
  const status = await inbox.status();
  assert.equal(status.failed, 0);
  assert.deepEqual(status.alerts, []);
  assert.equal(status.queued, 0);
});
