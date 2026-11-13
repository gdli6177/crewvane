import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicJSON, readJSON, record } from "./io.js";
import { SessionRecoveryChannel, requestSessionRecovery, type RecoveryRequest } from "./recovery-channel.js";

function descriptorPath(workspace: string) {
  return join(workspace, ".crewvane", "runtime", "session-host.json");
}

/** Discover the current desktop on every call, including after an app restart.
 * Credentials stay in an owner-only file, never in a Goal or launcher receipt. */
export async function publishSessionHost(workspace: string, channel: SessionRecoveryChannel) {
  await atomicJSON(descriptorPath(workspace), { version: 1, ...channel.environment });
}

export async function unpublishSessionHost(workspace: string, channel: SessionRecoveryChannel) {
  const path = descriptorPath(workspace);
  const current = await readJSON(path).catch(() => undefined);
  if (record(current) && current.CREWVANE_RECOVERY_DIRECTORY === channel.directory &&
    current.CREWVANE_RECOVERY_TOKEN === channel.token)
    await rm(path, { force: true });
}

export async function requestWorkspaceSessionHost(workspace: string, request: RecoveryRequest):
Promise<{ handled: false } | { handled: true; result: unknown }> {
  const path = descriptorPath(workspace);
  let value: unknown;
  try {
    const info = await lstat(path);
    if (info.mode & 0o077 || process.getuid && info.uid !== process.getuid())
      throw new Error("会话 Host 描述文件权限不安全。");
    value = await readJSON(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { handled: false };
    throw error;
  }
  if (!record(value) || value.version !== 1 || typeof value.CREWVANE_RECOVERY_DIRECTORY !== "string" ||
    typeof value.CREWVANE_RECOVERY_TOKEN !== "string")
    throw new Error("会话 Host 描述文件损坏；请重新打开 Crewvane。");
  const result = await requestSessionRecovery({
    CREWVANE_RECOVERY_DIRECTORY: value.CREWVANE_RECOVERY_DIRECTORY,
    CREWVANE_RECOVERY_TOKEN: value.CREWVANE_RECOVERY_TOKEN,
  }, request);
  return { handled: true, result };
}
