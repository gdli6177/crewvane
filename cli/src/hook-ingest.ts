import { createConnection } from "node:net";
import { join } from "node:path";
import {
  AGENT_HOOK_CONNECT_TIMEOUT_MS,
  agentRuntimeSocketPath,
  isAgentRuntimeAdapter,
  nextAgentRuntimeSequence,
  normalizeNativeHookEvent,
  spoolAgentRuntimeEvents,
  type AgentRuntimeEventV1,
} from "../../packages/core/src/index.js";

const MAX_PAYLOAD_BYTES = 512_000;
const MAX_SPOOL_BYTES = 1_000_000;

export interface HookIngestInput {
  adapter: string;
  stdin: () => Promise<string>;
  environment?: NodeJS.ProcessEnv;
  send?: (events: AgentRuntimeEventV1[], token: string) => Promise<boolean>;
  spool?: (events: AgentRuntimeEventV1[], token: string) => Promise<unknown>;
  now?: () => Date;
}

function sendOverSocket(
  socketPath: string,
  events: AgentRuntimeEventV1[],
  token: string,
) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => finish(false), AGENT_HOOK_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.end(`${JSON.stringify({ token, events })}\n`);
    });
    let response = "";
    socket.on("data", chunk => {
      response += chunk;
      if (response.length > 4096) finish(false);
    });
    socket.once("end", () => {
      clearTimeout(timer);
      try {
        finish(JSON.parse(response.trim()).ok === true);
      } catch {
        finish(false);
      }
    });
    socket.once("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

export async function ingestAgentHook(input: HookIngestInput): Promise<{
  accepted: boolean;
  reason?: string;
}> {
  const environment = input.environment ?? process.env;
  const goalId = environment.CREWVANE_GOAL_ID?.trim(),
    attemptId = environment.CREWVANE_ATTEMPT_ID?.trim(),
    token = environment.CREWVANE_HOOK_TOKEN?.trim(),
    agent = environment.CREWVANE_AGENT_NAME?.trim(),
    workspace = environment.CREWVANE_WORKSPACE?.trim();
  // Installed Hooks are global. An Agent outside a Crewvane target is a no-op.
  if (!goalId || !attemptId || !token || !agent || !workspace)
    return { accepted: false, reason: "not_managed" };
  if (!isAgentRuntimeAdapter(input.adapter))
    return { accepted: false, reason: "unsupported_adapter" };

  let rawText: string;
  try {
    rawText = await input.stdin();
  } catch {
    return { accepted: false, reason: "stdin_unavailable" };
  }
  if (!rawText.trim() || Buffer.byteLength(rawText) > MAX_PAYLOAD_BYTES)
    return { accepted: false, reason: "invalid_payload" };
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { accepted: false, reason: "invalid_json" };
  }
  const nativeEvents = normalizeNativeHookEvent(input.adapter, raw);
  if (!nativeEvents.length)
    return { accepted: false, reason: "unsupported_event" };

  const now = input.now?.() ?? new Date();
  const events: AgentRuntimeEventV1[] = [];
  for (const [index, event] of nativeEvents.entries()) {
    const sequence = await nextAgentRuntimeSequence(workspace, attemptId)
      .catch(() => undefined);
    // Never poison a persistent sequence with a timestamp fallback. Losing an
    // observational event is safer than rejecting every later valid event.
    if (sequence === undefined)
      return { accepted: false, reason: "sequence_unavailable" };
    events.push({
      version: "v1",
      eventId: `${input.adapter}-${attemptId}-${sequence}-${index}`,
      sequence,
      at: now.toISOString(),
      source: "hook",
      agent,
      adapter: input.adapter,
      goalId,
      attemptId,
      type: event.type,
      ...(event.turnId
        ? { turnId: event.turnId }
        : event.type === "turn.started"
          ? { turnId: `turn-${sequence}` }
          : {}),
      ...(event.text ? { content: event.text } : {}),
      ...(event.notificationType
        ? { notificationType: event.notificationType }
        : {}),
    });
  }
  const socketPath = environment.CREWVANE_HOOK_SOCKET?.trim() ||
    agentRuntimeSocketPath(workspace);
  const send = input.send ?? (async (queued, hookToken) =>
    sendOverSocket(socketPath, queued, hookToken));
  try {
    if (await send(events, token)) return { accepted: true };
  } catch {
    // Delivery is observational and fail-open. Fall through to the local spool.
  }

  const spoolRoot = environment.CREWVANE_HOOK_SPOOL?.trim() ||
    join(workspace, ".crewvane", "runtime", "spool");
  const bodyBytes = Buffer.byteLength(JSON.stringify(events));
  if (bodyBytes > MAX_SPOOL_BYTES)
    return { accepted: false, reason: "spool_too_large" };
  try {
    const spool = input.spool ?? (async (queued, hookToken) =>
      spoolAgentRuntimeEvents(spoolRoot, [{ token: hookToken, events: queued }], now));
    await spool(events, token);
    return { accepted: true, reason: "spooled" };
  } catch {
    return { accepted: false, reason: "spool_failed" };
  }
}
