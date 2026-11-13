import { record, string } from "../io.js";

export class OrcaCommandError extends Error {
  constructor(readonly code: string, message: string, readonly uncertain = false) {
    super(`Orca ${code}: ${message}`);
  }
}
export interface OrcaEnvelope {
  result: Record<string, unknown>;
  runtimeId: string;
}
export function orcaEnvelope(stdout: string): OrcaEnvelope {
  let value: unknown;
  try { value = JSON.parse(stdout); }
  catch { throw new OrcaCommandError("invalid_response", "运行时未返回完整 JSON；结果未确认。", true); }
  if (!record(value) || typeof value.ok !== "boolean")
    throw new OrcaCommandError("invalid_response", "运行时返回了未知协议。", true);
  if (!value.ok) {
    const error = record(value.error) ? value.error : {};
    throw new OrcaCommandError(
      typeof error.code === "string" ? error.code : "unknown_error",
      typeof error.message === "string" ? error.message.slice(0, 1_000) : "运行时拒绝请求。",
    );
  }
  if (!record(value.result) || !record(value._meta))
    throw new OrcaCommandError("invalid_response", "运行时响应缺少身份。", true);
  return { result: value.result, runtimeId: string(value._meta.runtimeId, "runtimeId") };
}
export interface OrcaTerminal {
  handle: string;
  worktreeId: string;
  executionHostId: string;
  incarnationId: string;
  connected: boolean;
  writable: boolean;
  orphaned: boolean;
  paneKey?: string;
}
export function orcaTerminal(value: unknown): OrcaTerminal {
  if (!record(value)) throw new OrcaCommandError("invalid_response", "终端记录无效。", true);
  return {
    handle: string(value.handle, "terminal handle", 240),
    worktreeId: string(value.worktreeId, "worktreeId"),
    executionHostId: string(value.executionHostId, "executionHostId", 240),
    incarnationId: string(value.incarnationId, "incarnationId", 240),
    connected: value.connected === true,
    writable: value.writable === true,
    orphaned: value.orphaned === true,
    ...(typeof value.paneKey === "string" ? { paneKey: value.paneKey } : {}),
  };
}
export interface OrcaProgramObservation {
  paneKey: string;
  state: "working" | "idle" | "blocked" | "unknown";
}
/** Whitelist structural lifecycle fields only; never store terminal previews,
 * prompts, tools, input, or assistant text returned by broad upstream queries. */
export function orcaPrograms(value: unknown): OrcaProgramObservation[] {
  if (!Array.isArray(value)) throw new OrcaCommandError("invalid_response", "工作区列表无效。", true);
  return value.flatMap(worktree => {
    if (!record(worktree) || !Array.isArray(worktree.agents)) return [];
    return worktree.agents.filter(record).flatMap(agent => {
      if (typeof agent.paneKey !== "string") return [];
      // worktree ps returns the public Agent lifecycle enum, not the
      // terminal status enum. "done" means ready for input, never goal done.
      const state = agent.state === "working" ? "working" :
        ["permission", "blocked", "waiting"].includes(String(agent.state)) ? "blocked" :
          agent.state === "idle" || agent.state === "done" ? "idle" : "unknown";
      return [{ paneKey: agent.paneKey, state }];
    });
  });
}
export function terminalPaneKey(value: unknown): string | undefined {
  if (!record(value) || typeof value.tabId !== "string" || typeof value.leafId !== "string") return;
  return `${value.tabId}:${value.leafId}`;
}
