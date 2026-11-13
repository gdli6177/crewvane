import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { localProcesses } from "../process.js";
import { privateDirectory, record } from "../io.js";

/** Global lock is always acquired before any workspace lock. It covers only
 * local admission/commit decisions, never a model turn or a backend process. */
export async function withControlLock<T>(directory: string, action: () => Promise<T>, timeoutMs = 5_000): Promise<T> {
  const root = await privateDirectory(directory), path = join(root, "control.lock");
  const deadline = Date.now() + timeoutMs, token = randomUUID();
  for (;;) {
    try {
      await mkdir(path, { mode: 0o700 });
      const identity = await localProcesses.identity(process.pid);
      if (!identity) throw new Error("无法验证当前控制进程。");
      await writeFile(join(path, "owner.json"), JSON.stringify({ ...identity, token }), { mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("会话控制锁不安全。");
      let owner: unknown;
      try { owner = JSON.parse(await readFile(join(path, "owner.json"), "utf8")); }
      catch { /* A crash between mkdir and owner write has no external effect. */ }
      if (record(owner) && Number.isSafeInteger(owner.pid) && typeof owner.bornAt === "string" &&
        !await localProcesses.alive({ pid: owner.pid as number, bornAt: owner.bornAt })) {
        await rm(path, { recursive: true });
        continue;
      }
      if (!owner && Date.now() - info.mtimeMs > 30_000) {
        await rm(path, { recursive: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("backend_busy: 会话控制服务正忙，请稍后重试。");
      await delay(20);
    }
  }
  try { return await action(); }
  finally {
    const owner: unknown = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    if (record(owner) && owner.token === token) await rm(path, { recursive: true });
  }
}
