import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionRecoveryChannel, requestSessionRecovery } from "../src/index.js";
import type { RecoveryRequest } from "../src/recovery-channel.js";

const request: RecoveryRequest = {
  context: { installationId: "installation", backend: "orca", epoch: 1,
    scopeGeneration: "scope", role: "concierge", goalId: "goal-one" },
  operation: "launch", input: { goalId: "goal-one", name: "owner-one" },
};
test("recovery channel keeps switch authority in the host and returns one private receipt", async t => {
  const root = await mkdtemp(join(tmpdir(), "cv-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const channel = new SessionRecoveryChannel(root, async input => {
    calls++;
    assert.deepEqual(input.context, request.context);
    assert.equal(input.input.goalId, "goal-one");
    return { scene: { bindingId: "owned-binding" } };
  });
  await channel.start();
  t.after(() => channel.stop());
  assert.equal((await stat(channel.directory)).mode & 0o777, 0o700);
  assert.deepEqual(await requestSessionRecovery(channel.environment, request),
    { scene: { bindingId: "owned-binding" } });
  assert.equal(calls, 1);
  await assert.rejects(requestSessionRecovery({
    ...channel.environment, CREWVANE_RECOVERY_TOKEN: "f".repeat(64),
  }, request), /未获授权/);
  assert.equal(calls, 1);
});
test("ordinary CLI cannot create recovery authority and missing host results never auto-replay", async t => {
  await assert.rejects(requestSessionRecovery({}, request), /普通调用不能/);
  const root = await mkdtemp(join(tmpdir(), "cv-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const channel = new SessionRecoveryChannel(root, async () => { throw new Error("unreachable"); });
  await channel.start();
  t.after(() => channel.stop());
  await assert.rejects(requestSessionRecovery(channel.environment, request), /unreachable/);
});

test("an unavailable host cancels an unclaimed request rather than executing it later", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cv-host-offline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(requestSessionRecovery({
    CREWVANE_RECOVERY_DIRECTORY: directory, CREWVANE_RECOVERY_TOKEN: "a".repeat(64),
  }, request, 2_000), /未连接.*本请求未执行/);
  assert.deepEqual(await readdir(directory), []);
});
