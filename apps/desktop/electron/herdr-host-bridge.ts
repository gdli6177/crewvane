import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ALLOWED = new Set([
  "agent",
  "pane",
  "tab",
  "workspace",
]);

interface Request {
  id?: string;
  version?: number;
  token?: string;
  args?: unknown;
}

export class HerdrHostBridge {
  readonly token = randomBytes(32).toString("hex");
  readonly socketPath: string;
  readonly requestDirectory: string;
  private server?: Server;
  private fileTimer?: NodeJS.Timeout;
  private drainingFiles = false;

  constructor(
    workspaceRoot: string,
    private readonly session: string,
    private readonly executable: () => Promise<string>,
  ) {
    // macOS limits Unix-domain socket paths to roughly 104 bytes. Workspaces
    // may live under deeply nested project folders, so keep the socket in a
    // short, owner-only runtime directory keyed by the canonical workspace.
    const workspaceKey = createHash("sha256")
      .update(workspaceRoot)
      .digest("hex")
      .slice(0, 20);
    const runtimeDirectory = join(
      process.platform === "win32" ? tmpdir() : "/tmp",
      `crewvane-host-${workspaceKey}`,
    );
    this.socketPath = join(runtimeDirectory, "host.sock");
    this.requestDirectory = join(runtimeDirectory, "host-requests");
  }

  async start() {
    await mkdir(join(this.socketPath, ".."), { recursive: true, mode: 0o700 });
    await chmod(join(this.socketPath, ".."), 0o700).catch(() => {});
    await mkdir(this.requestDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.requestDirectory, 0o700).catch(() => {});
    await this.cleanupFileChannel();
    await unlink(this.socketPath).catch(() => {});
    this.server = createServer(socket => {
      let input = "", handled = false;
      socket.setEncoding("utf8");
      // Herdr commands may legitimately run for the full exec timeout while
      // producing no output. Treat the socket timeout as an absolute upper
      // bound rather than an idle timeout.
      socket.setTimeout(210_000);
      socket.on("timeout", () => socket.destroy());
      socket.on("error", () => socket.destroy());
      const respond = (value: unknown) => {
        if (handled || socket.destroyed) return;
        handled = true;
        socket.end(`${JSON.stringify(value)}\n`);
      };
      socket.on("data", chunk => {
        input += chunk;
        if (Buffer.byteLength(input) > 600_000) {
          respond({ ok: false, error: "请求过大" });
          return;
        }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        void (async () => {
          let request: Request;
          try {
            request = JSON.parse(input.slice(0, newline)) as Request;
          } catch {
            respond({ ok: false, error: "请求不是有效 JSON" });
            return;
          }
          if (!this.validRequest(request)) {
            respond({ ok: false, error: "Host Bridge 请求未获授权" });
            return;
          }
          respond(await this.execute(request.args as string[]));
        })();
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    await chmod(this.socketPath, 0o600);
    this.fileTimer = setInterval(() => {
      void this.drainFileChannel();
    }, 50);
    this.fileTimer.unref();
  }

  async stop() {
    const server = this.server;
    this.server = undefined;
    if (this.fileTimer) clearInterval(this.fileTimer);
    this.fileTimer = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => {});
    while (this.drainingFiles) await new Promise(resolve => setTimeout(resolve, 20));
    await rm(this.requestDirectory, { recursive: true, force: true }).catch(() => {});
  }

  private validRequest(request: Request) {
    return request.version === 1 &&
      request.token === this.token &&
      Array.isArray(request.args) &&
      request.args.length > 0 &&
      request.args.length <= 64 &&
      request.args.every(value =>
        typeof value === "string" && value.length <= 200_000) &&
      ALLOWED.has(String(request.args[0]));
  }

  private async execute(args: string[]) {
    try {
      const binary = await this.executable();
      const result = await exec(
        binary,
        ["--session", this.session, ...args],
        {
          timeout: 200_000,
          maxBuffer: 2_000_000,
          env: process.env,
        },
      );
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const value = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: string | number;
      };
      return {
        ok: false,
        error: value.message,
        stdout: value.stdout ?? "",
        stderr: value.stderr ?? "",
        code: value.code,
      };
    }
  }

  private async drainFileChannel() {
    if (this.drainingFiles || !this.fileTimer) return;
    this.drainingFiles = true;
    try {
      const names = (await readdir(this.requestDirectory))
        .filter(name => name.endsWith(".request.json"))
        .sort()
        .slice(0, 16);
      for (const name of names) {
        const requestPath = join(this.requestDirectory, name);
        const info = await lstat(requestPath).catch(() => undefined);
        if (!info?.isFile() || info.size > 600_000) {
          await unlink(requestPath).catch(() => {});
          continue;
        }
        let request: Request;
        try {
          request = JSON.parse(await readFile(requestPath, "utf8")) as Request;
        } catch {
          await unlink(requestPath).catch(() => {});
          continue;
        }
        const validId = request.id && /^[a-zA-Z0-9_-]{1,160}$/.test(request.id)
          ? request.id
          : undefined;
        const claim = validId
          ? join(this.requestDirectory, `${validId}.claimed.json`)
          : undefined;
        const target = validId
          ? join(this.requestDirectory, `${validId}.response.json`)
          : undefined;
        let claimedHere = false;
        if (claim) {
          try {
            await writeFile(claim, `${JSON.stringify({
              claimedAt: new Date().toISOString(),
            })}\n`, { mode: 0o600, flag: "wx" });
            claimedHere = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        let response: {
          ok: boolean;
          stdout?: string;
          stderr?: string;
          error?: string;
          code?: string | number;
        };
        if (claim && !claimedHere) {
          // A claim without a response means the previous bridge stopped
          // after handing the command to Herdr but before observing the
          // result. Treat it as unconfirmed and never replay the command.
          const existing = target
            ? await readFile(target, "utf8").catch(() => undefined)
            : undefined;
          if (existing !== undefined) {
            await unlink(requestPath).catch(() => {});
            await unlink(claim).catch(() => {});
            continue;
          }
          response = {
            ok: false,
            error: "Host Bridge 请求此前已认领，结果未确认，未自动重放",
          };
        } else {
          response = this.validRequest(request)
            ? await this.execute(request.args as string[])
            : { ok: false, error: "Host Bridge 请求未获授权" };
        }
        if (target) {
          const temporary = `${target}.${process.pid}.tmp`;
          await writeFile(temporary, `${JSON.stringify(response)}\n`, { mode: 0o600 });
          await rename(temporary, target);
        }
        await unlink(requestPath).catch(() => {});
        if (claim && claimedHere) await unlink(claim).catch(() => {});
      }
    } finally {
      this.drainingFiles = false;
    }
  }

  private async cleanupFileChannel() {
    const names = await readdir(this.requestDirectory)
      .catch(() => [] as string[]);
    const cutoff = Date.now() - 15 * 60_000;
    for (const name of names) {
      if (!/\.(?:request|response|claimed)\.json(?:\.\d+\.tmp)?$/.test(name)) continue;
      const path = join(this.requestDirectory, name);
      const info = await lstat(path).catch(() => undefined);
      if (info && info.mtimeMs < cutoff)
        await rm(path, { force: true }).catch(() => {});
    }
  }
}
