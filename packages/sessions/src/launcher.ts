import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderAgentCommand } from "../../core/src/agent-command.js";
import type { LocalProcessIdentity } from "../../core/src/index.js";
import { childPath, privateDirectory, record, string } from "./io.js";

export interface LaunchReceipt {
  version: 1;
  requestId: string;
  installationId: string;
  bindingId: string;
  attemptId: string;
  backendEpoch: number;
  pid: number;
  bornAt: string;
  terminalHandle?: string;
  herdr?: { session: string; workspaceId: string; tabId: string; paneId: string };
}
export interface LaunchFiles {
  launcherPath: string;
  receiptPath: string;
  digest: string;
}
export function quoteShell(value: string) {
  if (value.includes("\0")) throw new Error("启动参数不能包含空字符。");
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export async function createLaunchFiles(
  directory: string,
  input: Omit<LaunchReceipt, "pid" | "bornAt" | "terminalHandle" | "version"> & {
    executable: string;
    args: string[];
    cwd: string;
    environment: Record<string, string>;
  },
): Promise<LaunchFiles> {
  childPath(directory, input.requestId); // Validate before using it as a directory.
  const root = await privateDirectory(join(directory, "launchers", input.requestId));
  const receiptPath = childPath(root, "environment-ready"), launcherPath = childPath(root, "launch", ".zsh");
  // Startup must run in a real interactive login shell. Keep the command in
  // command position: `exec cursor-2` and `command cursor-2` both break aliases.
  const command = renderAgentCommand(input.executable, input.args);
  const fixed = {
    version: 1, requestId: input.requestId, installationId: input.installationId,
    bindingId: input.bindingId, attemptId: input.attemptId, backendEpoch: input.backendEpoch,
  };
  const body = [
    "umask 077",
    "crewvane_herdr_session=${HERDR_SESSION:-}; crewvane_herdr_workspace=${HERDR_WORKSPACE_ID:-}; crewvane_herdr_tab=${HERDR_TAB_ID:-}; crewvane_herdr_pane=${HERDR_PANE_ID:-}",
    "unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE CREWVANE_HERDR_BINARY HERDR_ENV HERDR_SESSION HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID",
    ...Object.entries(input.environment).map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("无效的启动环境字段。");
      return `export ${key}=${quoteShell(value)}${key === "PATH" ? ":$PATH" : ""}`;
    }),
    ...(input.environment.CREWVANE_BACKEND === "herdr" ? [
      'export HERDR_ENV=1 HERDR_SESSION="$crewvane_herdr_session" HERDR_WORKSPACE_ID="$crewvane_herdr_workspace" HERDR_TAB_ID="$crewvane_herdr_tab" HERDR_PANE_ID="$crewvane_herdr_pane"',
    ] : []),
    `cd ${quoteShell(input.cwd)} || exit 1`,
    "crewvane_process_birth=$(LC_ALL=C /bin/ps -p $$ -o lstart= | /usr/bin/sed 's/^ *//;s/ *$//')",
    "crewvane_terminal_handle=${ORCA_TERMINAL_HANDLE:-}",
    // Handle and birth-time are OS-owned inputs, but still validate before
    // putting them into the tiny JSON receipt. No prompt or token is included.
    '[[ "$crewvane_terminal_handle" =~ \'^[A-Za-z0-9_-]+$\' ]] || crewvane_terminal_handle=""',
    ...["session", "workspace", "tab", "pane"].map(key =>
      `[[ "$crewvane_herdr_${key}" =~ '^[A-Za-z0-9_:-]+$' ]] || crewvane_herdr_${key}=""`),
    `printf ${quoteShell(JSON.stringify(fixed).slice(0, -1) + ',"pid":%s,"bornAt":"%s","terminalHandle":"%s","herdr":{"session":"%s","workspaceId":"%s","tabId":"%s","paneId":"%s"}}\\n')} "$$" "$crewvane_process_birth" "$crewvane_terminal_handle" "$crewvane_herdr_session" "$crewvane_herdr_workspace" "$crewvane_herdr_tab" "$crewvane_herdr_pane" > ${quoteShell(receiptPath + ".tmp")}`,
    `/bin/mv ${quoteShell(receiptPath + ".tmp")} ${quoteShell(receiptPath)}`,
    command,
    "crewvane_exit_status=$?",
    "exit $crewvane_exit_status",
    "",
  ].join("\n");
  await writeFile(launcherPath, body, { mode: 0o600, flag: "wx" });
  await chmod(launcherPath, 0o600);
  return { launcherPath, receiptPath, digest: createHash("sha256").update(body).digest("hex") };
}
export function launcherCommand(path: string, environment: Record<string, string> = {}) {
  // `source` allows aliases/functions from .zshrc, while source path and all
  // user argv remain independently quoted. No eval of an arbitrary shell line.
  const prefix = Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("无效的启动环境字段。");
    return `${key}=${quoteShell(value)}`;
  }).join(" ");
  return `${prefix ? `env ${prefix} ` : ""}/bin/zsh -ilc ${quoteShell(`source ${quoteShell(path)}`)}`;
}
export async function readLaunchReceipt(path: string): Promise<LaunchReceipt | undefined> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Buffer.byteLength(raw) > 8_192) throw new Error("启动收据超限。");
  const data: unknown = JSON.parse(raw);
  if (!record(data) || data.version !== 1 || !Number.isSafeInteger(data.pid) ||
    (data.pid as number) <= 0 || !Number.isSafeInteger(data.backendEpoch))
    throw new Error("启动收据无效。");
  return {
    version: 1,
    requestId: string(data.requestId, "requestId", 160),
    installationId: string(data.installationId, "installationId", 160),
    bindingId: string(data.bindingId, "bindingId", 160),
    attemptId: string(data.attemptId, "attemptId", 160),
    backendEpoch: data.backendEpoch as number,
    pid: data.pid as number,
    bornAt: string(data.bornAt, "process birth", 100).trim(),
    ...(typeof data.terminalHandle === "string" && data.terminalHandle
      ? { terminalHandle: string(data.terminalHandle, "terminalHandle", 240) } : {}),
    ...(record(data.herdr) && typeof data.herdr.paneId === "string" && data.herdr.paneId ? {
      herdr: {
        session: string(data.herdr.session, "Herdr session"),
        workspaceId: string(data.herdr.workspaceId, "Herdr workspace"),
        tabId: string(data.herdr.tabId, "Herdr tab"), paneId: string(data.herdr.paneId, "Herdr pane"),
      },
    } : {}),
  };
}
export function receiptProcess(receipt: LaunchReceipt): LocalProcessIdentity {
  return { pid: receipt.pid, bornAt: receipt.bornAt };
}
