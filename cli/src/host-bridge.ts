import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

interface HostResponse {
  ok?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export async function runHostHerdr(
  socketPath: string,
  token: string,
  args: string[],
  timeoutMs = 190_000,
): Promise<string> {
  try {
    return await runSocket(socketPath, token, args, timeoutMs);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["ENOENT", "ECONNREFUSED", "EPERM", "EACCES"].includes(code ?? ""))
      throw error;
  }
  return runFiles(socketPath, token, args, timeoutMs);
}

function runSocket(
  socketPath: string,
  token: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let input = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      finish(new Error("Herdr Host Bridge 响应超时"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        version: 1,
        token,
        args,
      })}\n`);
    });
    socket.on("data", chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > 2_000_000) {
        finish(new Error("Herdr Host Bridge 返回内容过大"));
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(input.slice(0, newline)) as HostResponse;
        if (response.ok) {
          finish(undefined, response.stdout ?? "");
          return;
        }
        const detail = [
          response.error,
          response.stderr?.trim(),
          response.stdout?.trim(),
        ].filter(Boolean).join("\n");
        finish(new Error(detail || "Herdr Host Bridge 执行失败"));
      } catch (error) {
        finish(new Error(`Herdr Host Bridge 返回无效：${
          error instanceof Error ? error.message : String(error)
        }`));
      }
    });
    socket.once("error", error => finish(error));
    socket.once("close", () => {
      if (!settled) finish(new Error("Herdr Host Bridge 提前关闭"));
    });
  });
}

async function runFiles(
  socketPath: string,
  token: string,
  args: string[],
  timeoutMs: number,
) {
  const requestDirectory = join(
    dirname(socketPath),
    "host-requests",
  );
  await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const requestPath = join(requestDirectory, `${id}.request.json`);
  const temporary = `${requestPath}.${process.pid}.tmp`;
  const responsePath = join(requestDirectory, `${id}.response.json`);
  const claimPath = join(requestDirectory, `${id}.claimed.json`);
  await writeFile(temporary, `${JSON.stringify({
    id,
    version: 1,
    token,
    args,
  })}\n`, { mode: 0o600 });
  await rename(temporary, requestPath);
  const handshakeDeadline = Date.now() + Math.min(timeoutMs, 2_000);
  let claimed = false;
  while (Date.now() < handshakeDeadline) {
    const raw = await readFile(responsePath, "utf8").catch(() => undefined);
    if (raw !== undefined) return parseResponse(raw, responsePath);
    if (await readFile(claimPath, "utf8").catch(() => undefined)) {
      claimed = true;
      break;
    }
    await delay(40);
  }
  if (!claimed) {
    await unlink(requestPath).catch(() => {});
    throw Object.assign(new Error("Herdr Host Bridge 未连接"), {
      code: "ECONNREFUSED",
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readFile(responsePath, "utf8").catch(() => undefined);
    if (raw !== undefined) {
      return parseResponse(raw, responsePath);
    }
    await delay(40);
  }
  await unlink(requestPath).catch(() => {});
  throw Object.assign(new Error("Herdr Host Bridge 响应超时"), {
    code: "ETIMEDOUT",
  });
}

async function parseResponse(raw: string, responsePath: string) {
  await unlink(responsePath).catch(() => {});
  const response = JSON.parse(raw) as HostResponse;
  if (response.ok) return response.stdout ?? "";
  const detail = [
    response.error,
    response.stderr?.trim(),
    response.stdout?.trim(),
  ].filter(Boolean).join("\n");
  throw new Error(detail || "Herdr Host Bridge 执行失败");
}
