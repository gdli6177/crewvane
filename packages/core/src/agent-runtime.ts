import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { withLock } from "./storage.js";
import type {
  AgentRuntimeAdapterId,
  AgentRuntimeEventType,
  AgentRuntimeText,
} from "./types.js";

export const AGENT_RUNTIME_TEXT_LIMIT = 12_000;
export const AGENT_HOOK_CONNECT_TIMEOUT_MS = 500;
export const AGENT_HOOK_SPOOL_MAX_EVENTS = 200;
export const AGENT_HOOK_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function agentReceiptMarker(attemptId: string, turnId: string) {
  const digest = createHash("sha256")
    .update(`${attemptId}:${turnId}`).digest("hex").slice(0, 24);
  return `[CREWVANE_RECEIPT:${digest}]`;
}

export function agentRuntimeSocketPath(workspace: string) {
  const owner = typeof process.getuid === "function"
    ? String(process.getuid())
    : "user";
  const digest = createHash("sha256")
    .update(resolve(workspace))
    .digest("hex")
    .slice(0, 24);
  return join(tmpdir(), `crewvane-${owner}`, `${digest}.sock`);
}

const adapters = new Set<AgentRuntimeAdapterId>([
  "codex",
  "claude-code",
  "cursor",
  "qoder",
  "omp",
]);

export function isAgentRuntimeAdapter(value: unknown): value is AgentRuntimeAdapterId {
  return typeof value === "string" && adapters.has(value as AgentRuntimeAdapterId);
}

export function clipAgentRuntimeText(value: unknown): AgentRuntimeText | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const characters = Array.from(value);
  return {
    text: characters.slice(0, AGENT_RUNTIME_TEXT_LIMIT).join(""),
    sha256: createHash("sha256").update(value).digest("hex"),
    truncated: characters.length > AGENT_RUNTIME_TEXT_LIMIT,
  };
}

export interface NativeRuntimeEvent {
  type: AgentRuntimeEventType;
  turnId?: string;
  text?: AgentRuntimeText;
  notificationType?: string;
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function eventName(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    const clipped = clipAgentRuntimeText(value);
    if (clipped) return clipped;
  }
}

function turnId(raw: Record<string, any>) {
  for (const value of [
    raw.turn_id,
    raw.turnId,
    raw.generation_id,
    raw.generationId,
  ]) {
    if (typeof value === "string" && value.trim())
      return value.trim().slice(0, 240);
  }
  const index = raw.turn_index ?? raw.turnIndex;
  if (Number.isSafeInteger(index) && index >= 0) {
    const session = firstText(
      raw.session_id,
      raw.sessionId,
      raw.conversation_id,
      raw.conversationId,
    )?.text.slice(0, 120);
    return `${session || "turn"}:${index}`;
  }
}

function responseFromOmp(value: unknown, depth = 0): AgentRuntimeText | undefined {
  if (depth > 5 || !record(value)) return;
  if (typeof value.role === "string" && value.role !== "assistant") return;
  const content = value.role === "assistant" && Array.isArray(value.content)
    ? value.content
        .filter((item: unknown) =>
          record(item) && ["text", "output_text"].includes(String(item.type ?? "")))
        .map((item: any) => item.text)
        .filter((item: unknown) => typeof item === "string")
        .join("")
    : value.content;
  const direct = firstText(
    value.text,
    typeof content === "string" ? content : undefined,
    value.last_assistant_message,
  );
  if (direct) return direct;
  for (const key of ["message", "messages", "events", "data"]) {
    const list = value[key];
    if (list === undefined) continue;
    for (const item of (Array.isArray(list) ? [...list].reverse() : [list])) {
      const candidate = responseFromOmp(item, depth + 1);
      if (candidate) return candidate;
    }
  }
  return;
}

/**
 * Converts only the lifecycle shapes documented by each Agent. Tool inputs and
 * outputs are deliberately not copied into the normalized event.
 */
export function normalizeNativeHookEvent(
  adapter: AgentRuntimeAdapterId,
  input: unknown,
): NativeRuntimeEvent[] {
  if (!record(input)) return [];
  const name = eventName(input.hook_event_name ?? input.hookEventName ?? input.event ?? input.type);
  const eventTurn = turnId(input);
  const withTurn = <T extends NativeRuntimeEvent>(event: T): T =>
    eventTurn ? { ...event, turnId: eventTurn } : event;
  switch (adapter) {
    case "codex": {
      if (name === "sessionstart") return [withTurn({ type: "session.started" })];
      if (name === "userpromptsubmit") return [withTurn({
        type: "turn.started",
        text: firstText(input.prompt),
      })];
      if (name === "permissionrequest") return [withTurn({
        type: "agent.blocked",
        notificationType: "permission_request",
      })];
      if (name === "interrupt") return [withTurn({ type: "turn.interrupted" })];
      if (name === "sessionend") return [withTurn({ type: "session.ended" })];
      if (name === "stop") {
        const response = firstText(input.last_assistant_message);
        return [
          withTurn({
            type: "agent.response",
            ...(response ? { text: response } : {}),
          }),
          withTurn({ type: "turn.settled" }),
        ];
      }
      return [];
    }
    case "claude-code":
    case "qoder": {
      if (name === "sessionstart") return [withTurn({ type: "session.started" })];
      if (name === "userpromptsubmit") return [withTurn({
        type: "turn.started",
        text: firstText(input.prompt),
      })];
      if (name === "notification" || name === "permissionrequest") {
        const notification = typeof input.notification_type === "string"
          ? input.notification_type : "permission_request";
        // Authentication success, idle notices and elicitation completion are
        // notifications too. They do not prove that the Agent is blocked.
        if (name === "notification" && ![
          "permission_request", "permission_prompt", "elicitation_dialog",
        ].includes(notification)) return [];
        return [withTurn({
          type: "agent.blocked",
          notificationType: notification,
        })];
      }
      if (name === "stop" || name === "stopfailure") {
        const response = firstText(input.last_assistant_message);
        return [
          withTurn({
            type: "agent.response",
            ...(response ? { text: response } : {}),
          }),
          withTurn(name === "stopfailure"
            ? { type: "agent.blocked", notificationType: "stop_failure" }
            : { type: "turn.settled" }),
        ];
      }
      if (name === "sessionend") return [withTurn({ type: "session.ended" })];
      return [];
    }
    case "cursor": {
      if (name === "sessionstart") return [withTurn({ type: "session.started" })];
      if (name === "beforesubmitprompt") return [withTurn({
        type: "turn.started",
        text: firstText(input.prompt),
      })];
      if (name === "afteragentresponse") return [withTurn({
        type: "agent.response",
        text: firstText(input.text),
      })];
      if (name === "stop") {
        const status = String(input.status ?? "").toLowerCase();
        return [withTurn(status === "aborted"
          ? { type: "turn.interrupted" }
          : status === "error"
            ? { type: "agent.blocked", notificationType: "stop_error" }
            : { type: "turn.settled" })];
      }
      if (name === "sessionend") return [withTurn({ type: "session.ended" })];
      return [];
    }
    case "omp": {
      if (name === "sessionstart") return [{ type: "session.started" }];
      if (name === "agentstart" || name === "turnstart" || name === "beforeagentstart") {
        const prompt = firstText(input.prompt);
        return [withTurn({
          type: "turn.started",
          ...(prompt ? { text: prompt } : {}),
        })];
      }
      if (name === "agentresponse" || name === "messageresponse" || name === "turnend") return [withTurn({
        type: "agent.response",
        ...(responseFromOmp(input) ? { text: responseFromOmp(input) } : {}),
      })];
      if (name === "agentend") {
        if (input.willContinue === true || input.awaitingAsyncWork === true)
          return [];
        const response = responseFromOmp(input);
        return [
          ...(response
            ? [withTurn({ type: "agent.response" as const, text: response })]
            : []),
          withTurn({ type: "turn.settled" }),
        ];
      }
      if (name === "agentblocked" || name === "toolapprovalrequested") return [withTurn({
        type: "agent.blocked",
        notificationType: firstText(input.reason, input.message)?.text ?? "agent_blocked",
      })];
      if (name === "sessionend" || name === "sessionshutdown")
        return [{ type: "session.ended" }];
      return [];
    }
  }
  return [];
}

export function agentRuntimeCapabilities(
  adapter: AgentRuntimeAdapterId,
): AgentRuntimeEventType[] {
  const common: AgentRuntimeEventType[] = [
    "session.started",
    "turn.started",
    "turn.settled",
    "agent.blocked",
    "agent.response",
    "session.ended",
  ];
  if (adapter === "custom") return [];
  if (adapter === "codex" || adapter === "cursor")
    return [...common, "turn.interrupted"];
  return common;
}

export async function nextAgentRuntimeSequence(root: string, attemptId: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(attemptId))
    throw new Error("无效的 Agent attempt ID");
  const directory = join(root, ".crewvane", "runtime");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withLock(join(directory, "sequence-locks"), async () => {
    const path = join(directory, `${attemptId}.sequence`);
    let previous = 0;
    try {
      previous = Number(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!Number.isSafeInteger(previous) || previous < 0)
      throw new Error("Agent Hook 序号文件无效");
    const next = previous + 1;
    await writeFile(path, String(next), { mode: 0o600 });
    return next;
  }, 100);
}

export async function spoolAgentRuntimeEvents(
  spoolRoot: string,
  events: unknown[],
  now = new Date(),
) {
  await mkdir(spoolRoot, { recursive: true, mode: 0o700 });
  const existing = await readdir(spoolRoot).catch(() => [] as string[]);
  const files = existing.filter(name => /^\d{13}-[a-zA-Z0-9_-]+\.json$/.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - AGENT_HOOK_SPOOL_MAX_EVENTS + 1))) {
    await unlink(join(spoolRoot, name)).catch(() => {});
  }
  for (const name of files) {
    const path = join(spoolRoot, name);
    const info = await stat(path).catch(() => undefined);
    if (info && now.getTime() - info.mtimeMs > AGENT_HOOK_SPOOL_MAX_AGE_MS)
      await unlink(path).catch(() => {});
  }
  const suffix = createHash("sha256")
    .update(JSON.stringify(events))
    .update(String(process.pid))
    .update(String(Math.random()))
    .digest("hex")
    .slice(0, 16);
  const temporary = join(spoolRoot, `.${process.pid}-${suffix}.tmp`);
  const target = join(spoolRoot, `${now.getTime()}-${suffix}.json`);
  await writeFile(temporary, `${JSON.stringify(events)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return target;
}
