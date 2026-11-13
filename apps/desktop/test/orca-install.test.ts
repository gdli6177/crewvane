import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrcaInstallation } from "../electron/orca-install.js";
import type { BackendDetection } from "../../../packages/sessions/src/index.js";

const bytes = Buffer.from("a small verified installer fixture");
const release = {
  version: "1.4.258", url: "https://github.com/stablyai/orca/releases/download/v1.4.258/test.dmg",
  bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
};
async function fixture(t: test.TestContext, overrides: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cv-orca-installer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let opened = 0, appVersion = "1.4.207";
  const detection = (): BackendDetection => ({
    id: "orca", version: appVersion, appPath: "/Applications/Orca.app",
    status: appVersion === release.version ? "compatible" : "unverified",
    capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false },
  });
  const installer = new OrcaInstallation(directory, () => {}, {
    platform: "darwin", arch: "arm64", release,
    detect: async () => detection(),
    fetch: async () => new Response(bytes),
    openInstaller: async path => { assert.deepEqual(await readFile(path), bytes); opened++; },
    ...overrides,
  });
  return { installer, directory, opened: () => opened, installed: () => { appVersion = release.version; } };
}
test("Orca update downloads only the pinned image, verifies before opening and waits for user installation", async t => {
  const f = await fixture(t);
  assert.equal((await f.installer.status()).updateAvailable, true);
  const first = f.installer.install(), repeated = f.installer.install();
  assert.equal(first, repeated, "Repeated clicks share the same download.");
  assert.equal((await first).phase, "awaiting_installation");
  assert.equal(f.opened(), 1);
  assert.equal((await f.installer.status()).detection.version, "1.4.207", "Opening installer is not successful installation.");
  assert.equal((await f.installer.status()).phase, "awaiting_installation", "Reading settings preserves installation instructions.");
  f.installed();
  assert.equal((await f.installer.refresh()).detection.status, "compatible");
});
test("status reads do not repeatedly spawn detection or erase an offline update result", async t => {
  let detections = 0, downloads = 0;
  const f = await fixture(t, {
    detect: async (): Promise<BackendDetection> => {
      detections++;
      return { id: "orca", status: "missing",
        capabilities: { create: false, inspect: false, send: false, focus: false, close: false, discover: false, nativeResume: false } };
    },
    fetch: async () => { downloads++; return Response.json({ tag_name: `v${release.version}` }); },
  });
  const checked = await f.installer.check();
  assert.match(checked.detail!, /可安装/);
  assert.doesNotMatch(checked.detail!, /已安装/);
  for (let i = 0; i < 10; i++) assert.deepEqual(await f.installer.status(), checked);
  assert.equal(detections, 1);
  assert.equal(downloads, 1, "Update check reads metadata only.");
  assert.equal(f.opened(), 0);
});
test("corrupt or oversize downloads never open an installer and remove temporary bytes", async t => {
  for (const body of [Buffer.alloc(bytes.length, 2), Buffer.alloc(bytes.length + 1)]) {
    const f = await fixture(t, { fetch: async () => new Response(body) });
    assert.equal((await f.installer.install()).phase, "error");
    assert.equal(f.opened(), 0);
    assert.deepEqual(await readdir(f.directory), []);
  }
});
test("offline checks preserve usable installation; unverified upstream versions do not change the pinned update", async t => {
  const f = await fixture(t, { fetch: async () => { throw new Error("offline"); } });
  const failed = await f.installer.check();
  assert.equal(failed.phase, "error");
  assert.equal(failed.detection.version, "1.4.207");
  const g = await fixture(t, { fetch: async () => Response.json({ tag_name: "v2.0.0" }) });
  const checked = await g.installer.check();
  assert.equal(checked.latestVersion, "2.0.0");
  assert.equal(checked.verifiedVersion, release.version);
  assert.match(checked.detail!, /尚未经本版验证/);
});
test("cancelling an in-flight download keeps the old backend independent and deletes partial files", async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, { fetch: async (_url: string, init: RequestInit) => {
    started();
    return new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
  } });
  const task = f.installer.install();
  await ready;
  f.installer.cancel();
  const result = await task;
  assert.equal(result.phase, "idle");
  assert.match(result.detail!, /已取消/);
  assert.equal(f.opened(), 0);
  assert.deepEqual(await readdir(f.directory), []);
});
test("an installed future version is not silently downgraded", async t => {
  const f = await fixture(t, { detect: async () => ({
    id: "orca", version: "2.0.0", status: "unverified",
    capabilities: { create: false, inspect: false, send: false, focus: false, close: false, discover: false, nativeResume: false },
  }) });
  await f.installer.status();
  assert.match((await f.installer.install()).detail!, /不自动降级/);
  assert.equal(f.opened(), 0);
});
