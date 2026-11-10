import type { Goal, WorkspaceState } from "./types.js";

const identity = (value: string) => value.normalize("NFKC").trim().replace(/^@/, "").toLowerCase();
const humanNames = new Set(["你", "我", "本人", "用户", "人", "human", "user", "me", "you", "myself"]);
const internalNames = new Set([
  "管家", "总管", "船长", "负责人", "独立负责人", "待分配负责人", "待分配", "工人", "小队长",
  "尚未开始", "agent", "agents", "bot", "concierge", "owner", "worker", "self",
]);
function agentNames(state: WorkspaceState) {
  return new Set([state.concierge.agent, ...state.goals.map(goal => goal.herdr?.agent)]
    .filter((agent): agent is string => Boolean(agent)).map(identity));
}
function internalParty(value: string, agents: Set<string>) {
  const name = identity(value);
  return humanNames.has(name) || internalNames.has(name) ||
    /^(?:agent|owner|worker|bot)[\s:_-]/i.test(name) ||
    agents.has(name);
}
function externalParty(value: unknown, agents: Set<string>): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 120 &&
    !/[\x00-\x1f\x7f]/.test(value) && !internalParty(value, agents);
}
function pendingHumanAction(goal: Goal) {
  return Boolean(goal.attention && goal.attention.kind !== "follow_up");
}
export function externalWaitTarget(value: unknown, state: WorkspaceState, goal: Goal): string {
  if (pendingHumanAction(goal))
    throw new Error("目标还有需要你处理的待处理事项，不能转为等待外部；请先处理当前事项");
  if (!externalParty(value, agentNames(state)))
    throw new Error("等待只用于具名的外部第三方；请指定外部联系人或机构。需要你处理请请求决定，Agent 内部协调请保持跟进中");
  return value.trim();
}

/** An explicit handoff is work for an Agent until it establishes a new external wait. */
export function leaveExternalWait(goal: Goal) {
  if (goal.status !== "waiting") return;
  goal.status = "active";
  delete goal.waitingFor;
  delete goal.remindAt;
  if (goal.attention?.kind === "follow_up") goal.attention = null;
  delete goal.watchdog;
  delete goal.recovery;
}

/** Semantic repair of otherwise valid v2 data; do not archive or discard history. */
export function normalizeExternalWaits(state: WorkspaceState) {
  const agents = agentNames(state);
  for (const goal of state.goals) {
    if (goal.status !== "waiting") continue;
    const party = goal.waitingFor;
    // Older versions overwrote the execution owner with the waiting party.
    if (goal.owner === party)
      goal.owner = goal.mode === "manual" ? "你" : goal.herdr?.agent || "待分配负责人";
    if (externalParty(party, agents) && !pendingHumanAction(goal)) continue;
    goal.status = goal.attention?.kind === "review" && goal.delivery ? "review" : "active";
    delete goal.waitingFor;
    if (!goal.attention && typeof party === "string" && humanNames.has(identity(party)))
      goal.attention = {
        id: `legacy_wait_${goal.id}`, kind: "intervention", since: goal.updatedAt,
        summary: goal.next || "这件事需要你处理，请查看目标。",
      };
    delete goal.watchdog;
    delete goal.recovery;
  }
}
