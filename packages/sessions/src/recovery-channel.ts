import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedSessionContext } from "../../core/src/index.js";
import { atomicJSON, childPath, privateDirectory, readJSON, record } from "./io.js";
import { SessionError } from "./contracts.js";
import { localProcesses } from "./process.js";

export interface RecoveryRequest {
  context: ManagedSessionContext;
  operation: "launch" | "send";
  input: Record<string, unknown>;
}
interface Envelope extends RecoveryRequest { version: 1; token: string; id: string }
/** Ephemeral, owner-only bridge. Only the desktop retains SwitchAuthority;
 * a CLI never receives an operation flag that can manufacture that authority.
 * File transport also works for Agents whose sandbox disallows Unix sockets. */
export class SessionRecoveryChannel {
  readonly token = randomBytes(32).toString("hex");
  readonly directory: string;
  private timer?: NodeJS.Timeout;
  private draining?: Promise<void>;
  constructor(directory: string, private readonly handle: (request: RecoveryRequest) => Promise<unknown>) {
    this.directory = join(directory, "recovery", randomUUID());
  }
  get environment() {
    return { CREWVANE_RECOVERY_DIRECTORY: this.directory, CREWVANE_RECOVERY_TOKEN: this.token };
  }
  async start() {
    await privateDirectory(this.directory);
    const processIdentity = await localProcesses.identity(process.pid);
    if (!processIdentity) throw new Error("无法确认恢复通道控制进程身份。");
    await atomicJSON(join(this.directory, "host.json"), { version: 1, process: processIdentity });
    this.timer = setInterval(() => {
      this.draining ??= this.drain().catch(() => {
        // Leave claims intact; a transport observation failure must never
        // crash the desktop or replay a possibly accepted recovery request.
      }).finally(() => { this.draining = undefined; });
    }, 50);
    this.timer.unref();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
    await rm(this.directory, { recursive: true, force: true });
  }
  private async drain() {
    const names = (await readdir(this.directory)).filter(name => /^[\w-]+\.request\.json$/.test(name)).slice(0, 8);
    for (const name of names) {
      const requestPath = join(this.directory, name), claim = requestPath.replace(".request.", ".claimed.");
      try { await rename(requestPath, claim); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const id = name.slice(0, -".request.json".length);
      let response: { ok: boolean; result?: unknown; error?: string };
      try {
        const value = await readJSON(claim);
        if (!record(value) || value.version !== 1 || value.id !== id || typeof value.token !== "string" ||
          Buffer.byteLength(value.token) !== Buffer.byteLength(this.token) ||
          !timingSafeEqual(Buffer.from(value.token), Buffer.from(this.token)) ||
          !["launch", "send"].includes(String(value.operation)) || !record(value.context) || !record(value.input))
          throw new Error("恢复请求未获授权。");
        response = { ok: true, result: await this.handle(value as unknown as Envelope) };
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await atomicJSON(childPath(this.directory, id, ".response.json"), response);
      await rm(claim, { force: true });
    }
  }
}

export async function requestSessionRecovery(environment: NodeJS.ProcessEnv, request: RecoveryRequest,
  timeoutMs = 75_000): Promise<unknown> {
  const directory = environment.CREWVANE_RECOVERY_DIRECTORY, token = environment.CREWVANE_RECOVERY_TOKEN;
  if (!directory || !token) throw new SessionError("backend_switch_in_progress", "普通调用不能在交接期间启动或投递现场。");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 ||
    process.getuid && info.uid !== process.getuid()) throw new Error("恢复通道目录不安全。");
  const id = randomUUID(), path = childPath(directory, id, ".request.json");
  // Publishing a request is the point after which a timeout is uncertain.
  await writeFile(`${path}.tmp`, JSON.stringify({ ...request, version: 1, id, token }), { mode: 0o600, flag: "wx" });
  await rename(`${path}.tmp`, path);
  const deadline = Date.now() + timeoutMs;
  let claimed = false;
  while (Date.now() < deadline) {
    const responsePath = childPath(directory, id, ".response.json");
    const response = await readJSON(responsePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    });
    if (response) {
      await rm(responsePath, { force: true });
      if (!record(response) || typeof response.ok !== "boolean") throw new Error("恢复回执损坏，不能重复执行。");
      if (!response.ok) throw new Error(String(response.error ?? "恢复请求失败。"));
      return response.result;
    }
    if (!claimed && Date.now() >= deadline - timeoutMs + 1_000) {
      // An unavailable host must not leave a request which executes later
      // after the caller already saw a failure. rename races atomically with
      // the host's claim; once claimed, preserve uncertainty and keep waiting.
      const canceled = path.replace(".request.", ".canceled.");
      try {
        await rename(path, canceled);
        await rm(canceled, { force: true });
        throw new SessionError("backend_unreachable", "桌面会话服务未连接，请重新打开 Crewvane；本请求未执行。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        claimed = true;
      }
    }
    await delay(50);
  }
  throw new SessionError("delivery_unconfirmed", "恢复操作结果未确认；已保留原请求，不能自动重发。");
}
