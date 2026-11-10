import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearManagedCaches,
  inspectManagedCaches,
  type CacheMaintenancePaths,
} from "../electron/cache-maintenance.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const now = Date.now();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-cache-maintenance-"));
  fixtures.push(root);
  const paths: CacheMaintenancePaths = {
    userDataRoot: join(root, "userData"),
    cacheRoot: join(root, "cache"),
    logsRoot: join(root, "logs"),
    workspaceRoot: join(root, "workspace"),
  };
  await Promise.all([
    mkdir(join(paths.cacheRoot, "Cache", "nested"), { recursive: true }),
    mkdir(join(paths.userDataRoot, "runtime"), { recursive: true }),
    mkdir(join(paths.workspaceRoot, ".crewvane"), { recursive: true }),
    mkdir(paths.logsRoot, { recursive: true }),
  ]);
  return { root, paths };
}
async function age(path: string, days: number) {
  const date = new Date(now - days * 24 * 60 * 60 * 1000);
  await utimes(path, date, date);
}

test("inventory is read-only and separates stale files from current cache", async () => {
  const { paths } = await fixture();
  const stale = join(paths.cacheRoot, "Cache", "nested", "old.bin"),
    fresh = join(paths.cacheRoot, "Cache", "fresh.bin");
  await writeFile(stale, Buffer.alloc(120));
  await writeFile(fresh, Buffer.alloc(30));
  await age(stale, 31);
  const status = await inspectManagedCaches(paths, now);
  assert.equal(status.totalBytes, 150);
  assert.equal(status.staleBytes, 120);
  assert.equal(status.categories.find(item => item.id === "browser")?.files, 2);
  assert.deepEqual(await readFile(stale), Buffer.alloc(120));
});

test("automatic cleanup removes only stale cache, old logs and old atomic temp files", async () => {
  const { paths } = await fixture();
  const staleCache = join(paths.cacheRoot, "Cache", "old.bin"),
    freshCache = join(paths.cacheRoot, "Cache", "fresh.bin"),
    oldLog = join(paths.logsRoot!, "old.log"),
    freshLog = join(paths.logsRoot!, "fresh.log"),
    oldTemp = join(paths.userDataRoot, "runtime", "herdr.download"),
    liveRuntime = join(paths.userDataRoot, "runtime", "herdr"),
    oldScopeTemp = join(paths.workspaceRoot!, ".crewvane", "coordinator-scope.json.1.tmp"),
    goalState = join(paths.workspaceRoot!, ".crewvane", "state.json");
  for (const path of [staleCache, freshCache, oldLog, freshLog, oldTemp, liveRuntime, oldScopeTemp, goalState])
    await writeFile(path, path);
  await Promise.all([
    age(staleCache, 31), age(oldLog, 31), age(oldTemp, 2), age(oldScopeTemp, 2),
  ]);
  const result = await clearManagedCaches(paths, { mode: "automatic", now: now + 0 });
  assert.ok(result.removedBytes > 0);
  assert.ok(result.warnings.length === 0);
  await assert.rejects(readFile(staleCache));
  await assert.rejects(readFile(oldLog));
  await assert.rejects(readFile(oldTemp));
  await assert.rejects(readFile(oldScopeTemp));
  await readFile(freshCache);
  await readFile(freshLog);
  await readFile(liveRuntime);
  await readFile(goalState);
});

test("manual cleanup clears browser and managed temp caches without following symlinks", async () => {
  const { root, paths } = await fixture();
  const outside = join(root, "outside.txt"),
    nested = join(paths.cacheRoot, "Cache", "nested", "data.bin"),
    runtimeTemp = join(paths.userDataRoot, "runtime", "herdr.download"),
    linkedLogs = join(root, "linked-logs");
  await writeFile(outside, "keep");
  await writeFile(nested, "cache");
  await writeFile(runtimeTemp, "partial");
  await symlink(outside, join(paths.cacheRoot, "Cache", "outside-link"));
  await mkdir(linkedLogs);
  await writeFile(join(linkedLogs, "must-remain.log"), "keep");
  await rm(paths.logsRoot!, { recursive: true, force: true });
  await symlink(linkedLogs, paths.logsRoot!);
  let runtimeCleared = 0;
  const result = await clearManagedCaches(paths, {
    mode: "manual",
    now,
    clearBrowserRuntime: async () => { runtimeCleared += 1; },
  });
  assert.equal(runtimeCleared, 1);
  assert.ok(result.status.totalBytes < result.removedBytes);
  await assert.rejects(readFile(nested));
  await assert.rejects(readFile(runtimeTemp));
  assert.equal(await readFile(outside, "utf8"), "keep");
  assert.equal(await readFile(join(linkedLogs, "must-remain.log"), "utf8"), "keep");
  assert.ok(result.warnings.some(warning => /符号链接/.test(warning)));
});
