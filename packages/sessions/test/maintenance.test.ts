import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionControl, staleSessionStorage } from "../src/index.js";
import { localProcesses } from "../src/process.js";
import { WorkspaceService } from "../../core/src/index.js";

const now = Date.now(), old = new Date(now - 40 * 86_400_000);
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-session-maintenance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "control"), workspace = join(root, "workspace");
  await mkdir(workspace);
  const control = new SessionControl(directory);
  await control.initialize();
  await control.registerWorkspace(workspace);
  async function file(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await utimes(path, old, old);
    return path;
  }
  async function launch(id: string, options: { live?: boolean; unknown?: boolean; rejected?: boolean } = {}) {
    const intent = { requestId: id, bindingId: `binding-${id}`, status: options.rejected ? "rejected" : "created" };
    const path = await file(join(directory, "runtime-launches", `${id}.json`), { intent });
    const launcher = join(directory, "launchers", id);
    const processIdentity = options.live ? await localProcesses.identity(process.pid) : { pid: 2147483646, bornAt: "not-live" };
    await file(join(launcher, "environment-ready.json"), {
      version: 1, ...intent, installationId: "installation", attemptId: `attempt-${id}`, backendEpoch: 0,
      ...processIdentity,
    });
    await file(join(directory, "leases", `${id}.json`), { requestId: id, status: options.unknown ? "unknown" : "finished" });
    return { path, launcher };
  }
  return { root, directory, workspace, control, file, launch };
}

test("cleanup removes stale stopped launchers and terminal journals while protecting live and unknown work", async t => {
  const f = await fixture(t), dead = await f.launch("dead");
  const live = await f.launch("live", { live: true }), unknown = await f.launch("unknown", { unknown: true });
  const unfinished = await f.file(join(f.directory, "switch", "unfinished.json"),
    { operationId: "unfinished", phase: "recovery_required" });
  const completed = await f.file(join(f.directory, "switch", "completed.json"),
    { operationId: "completed", phase: "ready" });
  const paths = await staleSessionStorage(f.directory, now);
  assert(paths.includes(dead.path));
  assert(paths.includes(dead.launcher));
  assert(paths.includes(completed));
  assert(!paths.includes(live.path));
  assert(!paths.includes(live.launcher));
  assert(!paths.includes(unknown.path));
  assert(!paths.includes(unknown.launcher));
  assert(!paths.includes(unfinished));
  assert(!paths.some(path => path.includes("state.json") || path.endsWith("backend.json")));
});

test("currently registered scenes and symlinked parents never become cleanup candidates", async t => {
  const f = await fixture(t), owned = await f.launch("owned");
  await new WorkspaceService(f.workspace).execute({ type: "scene.prepare", intent: {
    requestId: "owned", bindingId: "binding-owned", attemptId: "attempt-owned",
    backendEpoch: 0, role: "concierge", agent: "concierge", status: "created", createdAt: old.toISOString(),
  } });
  const outside = join(f.root, "outside");
  await f.file(join(outside, "herdr", "deliveries", "do-not-touch.json"), {
    status: "accepted", scene: { bindingId: "unrelated" },
  });
  await symlink(outside, join(f.directory, "adapters"));
  const paths = await staleSessionStorage(f.directory, now);
  assert(!paths.includes(owned.path));
  assert(!paths.some(path => path.includes("adapters") || path.startsWith(outside)));
  const linkedRoot = join(f.root, "linked-control");
  await symlink(f.directory, linkedRoot);
  assert.deepEqual(await staleSessionStorage(linkedRoot, now), []);
});

test("recovery cleanup retains uncertain requests and living hosts, removes only stale abandoned channels", async t => {
  const f = await fixture(t);
  async function channel(id: string, pending: boolean, live: boolean) {
    const path = join(f.directory, "recovery", id);
    await f.file(join(path, "host.json"), { version: 1,
      process: live ? await localProcesses.identity(process.pid) : { pid: 2147483646, bornAt: "dead" } });
    if (pending) await f.file(join(path, "one.claimed.json"), { version: 1 });
    await utimes(path, old, old);
    return path;
  }
  const stale = await channel("stale", false, false), claimed = await channel("claimed", true, false),
    alive = await channel("live", false, true);
  const paths = await staleSessionStorage(f.directory, now);
  assert(paths.includes(stale));
  assert(!paths.includes(claimed));
  assert(!paths.includes(alive));
});

test("only stale terminal OMP payload references are reclaimed with their accepted receipt", async t => {
  const f = await fixture(t);
  const base = join(f.directory, "adapters/herdr");
  const receipt = await f.file(join(base, "deliveries", "old.json"), {
    deliveryId: "old", status: "accepted", scene: { bindingId: "unrelated" },
  });
  const payload = join(base, "payloads", "old.txt");
  await mkdir(dirname(payload), { recursive: true });
  await writeFile(payload, "完整旧消息");
  const unknown = await f.file(join(base, "deliveries", "unknown.json"), {
    deliveryId: "unknown", status: "unknown", scene: { bindingId: "unrelated" },
  });
  await writeFile(join(base, "payloads", "unknown.txt"), "可能仍在使用的消息");
  const paths = await staleSessionStorage(f.directory, now);
  assert(paths.includes(receipt));
  assert(paths.includes(payload));
  assert(!paths.includes(unknown), "unknown delivery receipts remain protected");
  assert(!paths.includes(join(base, "payloads", "unknown.txt")));
});
