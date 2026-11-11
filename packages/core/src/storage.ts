import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

export interface LockOwner {
  pid: number;
  hostname: string;
  started_at: string;
  cmd: string;
}

export async function readEvents(
  root: string,
): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, ".crewvane", "events.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`invalid event at line ${index + 1}`);
      return value as Record<string, unknown>;
    });
}

function lockTimeoutMs(): number {
  const raw = Number(process.env.CREWVANE_LOCK_TIMEOUT_MS ?? 5000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

export function lockOwner(): LockOwner {
  return {
    pid: process.pid,
    hostname: hostname(),
    started_at: new Date().toISOString(),
    cmd: process.argv.join(" "),
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readLockOwner(lock: string): Promise<LockOwner | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(lock, "owner.json"), "utf8"),
    );
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Partial<LockOwner>;
    if (typeof record.pid !== "number" || typeof record.hostname !== "string")
      return null;
    return {
      pid: record.pid,
      hostname: record.hostname,
      started_at:
        typeof record.started_at === "string" ? record.started_at : "",
      cmd: typeof record.cmd === "string" ? record.cmd : "",
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function lockHeldMessage(lock: string, owner: LockOwner | null): string {
  if (!owner) {
    return `state is locked: ${lock}; owner file missing. If no command is using it, remove the lock directory manually: rm -rf ${lock}`;
  }
  const sameHost = owner.hostname === hostname();
  const liveness = sameHost
    ? pidAlive(owner.pid)
      ? "pid is alive"
      : "pid is not alive"
    : "pid liveness not checked (different host)";
  return `state is locked: ${lock}; owner pid ${owner.pid} on ${owner.hostname} started ${owner.started_at} cmd ${owner.cmd}; ${liveness}. If the owner is dead, remove the lock directory manually: rm -rf ${lock}`;
}

/** State admission and the hook registry both take this directory lock.
 * A dead pid on this host is reclaimed. A live pid, or a lock from another host, is left in place.
 */
export async function withLock<T>(
  directory: string,
  action: () => Promise<T>,
  timeoutMs = lockTimeoutMs(),
): Promise<T> {
  await mkdir(directory, { recursive: true });
  const lock = join(await realpath(directory), ".crewvane-lock");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(
        join(lock, "owner.json"),
        `${JSON.stringify(lockOwner())}\n`,
      );
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readLockOwner(lock);
      if (owner && owner.hostname === hostname() && !pidAlive(owner.pid)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(lockHeldMessage(lock, owner));
      await setTimeout(20);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true });
  }
}

/** Called while holding the shared state lock. `.crewvane/sequence` is the counter that orders events with equal timestamps. */
export async function nextSequence(root: string): Promise<number> {
  const file = join(root, ".crewvane", "sequence");
  let previous = 0;
  try {
    previous = Number(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!Number.isSafeInteger(previous) || previous < 0)
    throw new Error("invalid state sequence");
  await writeFile(file, String(previous + 1));
  return previous + 1;
}
