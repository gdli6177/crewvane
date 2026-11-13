import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()))
    throw new Error("会话控制目录必须是当前用户拥有的真实目录。");
  if (info.mode & 0o077) await chmod(path, 0o700);
  return realpath(path);
}
export async function atomicJSON(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
/** Claim an operation before any external effect. A truncated claim from a
 * crash deliberately blocks replay rather than treating it as a new request. */
export async function claimJSON(path: string, value: unknown): Promise<boolean> {
  await privateDirectory(dirname(path));
  try {
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
export async function readJSON(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000)
    throw new Error("会话控制文件无效。");
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
export function childPath(root: string, id: string, extension = ".json") {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("无效的会话操作 ID。");
  return join(resolve(root), `${id}${extension}`);
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function string(value: unknown, label: string, limit = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\0\r\n]/.test(value))
    throw new Error(`无效的 ${label}。`);
  return value;
}
