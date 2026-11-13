import test from "node:test";
import assert from "node:assert/strict";
import { SessionPoller } from "../electron/session-poller.js";
import type { SceneReferenceV1 } from "../../../packages/core/src/index.js";
import type { SceneObservation } from "../../../packages/sessions/src/index.js";

const scenes = Array.from({ length: 100 }, (_, i): SceneReferenceV1 => ({
  version: 1, backend: "orca", installationId: "installation", backendEpoch: 1,
  runtimeId: "runtime", runtimeGeneration: "generation", bindingId: `binding-${i}`, attemptId: `attempt-${i}`,
  locator: { kind: "orca", repoId: "repo", worktreeId: "repo::/tmp/fixture",
    terminalHandle: `terminal-${i}`, executionHostId: "local", incarnationId: `incarnation-${i}` },
}));
test("ten minutes of routine observation stays one batch per ten seconds regardless of goal count", async () => {
  let now = 0, calls = 0;
  const poller = new SessionPoller(() => now);
  const read = async (batch: SceneReferenceV1[]): Promise<SceneObservation[]> => {
    calls++;
    return batch.map(scene => ({ bindingId: scene.bindingId, identity: "match", reachable: true,
      state: "idle", observedAt: new Date(now).toISOString(), source: "backend" }));
  };
  for (now = 0; now < 600_000; now += 100) await poller.inspect(scenes, read);
  assert.equal(calls, 60);
});
test("transport failure backs off thirty then sixty seconds; explicit reset probes immediately", async () => {
  let now = 0, calls = 0;
  const poller = new SessionPoller(() => now);
  const offline = async (): Promise<SceneObservation[]> => {
    calls++;
    return [{ bindingId: scenes[0]!.bindingId, identity: "unverifiable", reachable: false,
      state: "unknown", observedAt: new Date(now).toISOString(), source: "backend" }];
  };
  await poller.inspect(scenes, offline);
  now = 29_999;
  assert.equal(await poller.inspect(scenes, offline), undefined);
  now = 30_000;
  await poller.inspect(scenes, offline);
  now = 89_999;
  assert.equal(await poller.inspect(scenes, offline), undefined);
  now = 90_000;
  await poller.inspect(scenes, offline);
  assert.equal(calls, 3);
  poller.reset();
  await poller.inspect(scenes, offline);
  assert.equal(calls, 4);
});
test("simultaneous ticks share the in-flight group", async () => {
  const poller = new SessionPoller();
  let calls = 0, release!: (observations: SceneObservation[]) => void;
  const read = () => { calls++; return new Promise<SceneObservation[]>(resolve => { release = resolve; }); };
  const first = poller.inspect(scenes, read), second = poller.inspect(scenes, read);
  release([]);
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});
