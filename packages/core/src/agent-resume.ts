import type { OwnerResume } from "./types.js";

type AgentSession = NonNullable<OwnerResume["agentSession"]>;

/**
 * Native argv used to reopen an Agent conversation inside a fresh Herdr pane.
 * Herdr reports the session identity but has no resume CLI command, so the
 * caller starts the same Agent kind with its native resume arguments.
 */
export function resumeAgentArgs(session?: AgentSession): string[] | undefined {
  if (!session) return undefined;
  const { source, agent, kind, value } = session;
  const identity = `${source}\0${agent}`;
  const supported = new Set([
    "herdr:claude\0claude",
    "herdr:codex\0codex",
    "herdr:copilot\0copilot",
    "herdr:devin\0devin",
    "herdr:droid\0droid",
    "herdr:kimi\0kimi",
    "herdr:mastracode\0mastracode",
    "herdr:pi\0pi",
    "herdr:omp\0omp",
    "herdr:hermes\0hermes",
    "herdr:opencode\0opencode",
    "herdr:qodercli\0qodercli",
    "herdr:qwen\0qwen",
    "herdr:kilo\0kilo",
    "herdr:cursor\0cursor",
    "herdr:antigravity_cli\0agy",
    "herdr:grok\0grok",
    "herdr:letta\0letta",
  ]);
  if (!supported.has(identity)) return undefined;
  if (kind === "path" && agent !== "pi" && agent !== "omp") return undefined;
  switch (agent) {
    case "claude":
    case "devin":
    case "droid":
    case "grok":
    case "qodercli":
    case "qwen":
    case "cursor":
      return ["--resume", value];
    case "codex":
      return ["resume", value];
    case "copilot":
      return [`--resume=${value}`];
    case "kimi":
    case "opencode":
    case "kilo":
      return ["--session", value];
    case "mastracode":
      return ["--thread", value];
    case "pi":
      return ["--session", value];
    case "omp":
      return [`--resume=${value}`];
    case "hermes":
      return ["--resume", value];
    case "agy":
      return ["--conversation", value];
    case "letta":
      if (value.startsWith("default:")) {
        const agentId = value.slice("default:".length);
        return agentId
          ? ["--conversation", "default", "--agent", agentId]
          : undefined;
      }
      return ["--conversation", value];
    default:
      return undefined;
  }
}
