import { newId } from "./model.js";
import type { Goal, WatchdogReason } from "./types.js";

const STALE_AFTER = 30 * 60_000;
const OWNER_START_GRACE = 60_000;
const SETTLED_AFTER = 90_000;
const ESCALATE_AFTER = 10 * 60_000;
const RETRY_AFTER = 60_000;
const NUDGE_AFTER = 15 * 60_000;
export interface WatchdogRequest { goalId: string; reason: WatchdogReason; basis: string }
function progressAt(goal: Goal) {
  return goal.activities.filter(activity => activity.kind !== "watchdog").at(-1)?.at ?? goal.createdAt;
}
function inspectable(goal: Goal) {
  if (goal.mode !== "concierge") return false;
  if (goal.status === "active") return true;
  // Owners sometimes use "waiting" to mean that their current turn is over.
  // Reconcile that state only when the recorded wait target is the owner's own
  // live Agent. A wait for the human or another external party is intentional.
  return goal.status === "waiting" && Boolean(goal.herdr?.agent) &&
    goal.waitingFor === goal.herdr?.agent;
}
function record(goal: Goal, at: string, text: string) {
  goal.activities.push({ id: newId("act"), at, actor: "巡检", kind: "watchdog", text });
  goal.updatedAt = at;
}
function reasonFor(goal: Goal, now: number): WatchdogReason | undefined {
  const age = now - Date.parse(progressAt(goal));
  if (!goal.herdr?.paneId && !goal.herdr?.agent && goal.dispatch?.status !== "pending" &&
    now - Date.parse(goal.dispatch?.at ?? goal.createdAt) >= OWNER_START_GRACE) return "unassigned";
  if (goal.live?.state === "blocked") return "blocked";
  if (goal.live?.reachable === false && age >= OWNER_START_GRACE) return "missing";
  // A quiet terminal may hold an unrecorded result or an unrecognized input
  // prompt. It is not evidence of delivery, failure or completion. Ask the
  // concierge to reconcile the actual owner, rather than guessing from text.
  if (goal.live?.reachable === true && ["idle", "done"].includes(goal.live.state) &&
    now - Date.parse(goal.live.checkedAt) >= SETTLED_AFTER) return "settled";
  if (age >= STALE_AFTER) return "stale";
}
export function inspectWatchdog(goals: Goal[], at: string): WatchdogRequest[] {
  const now = Date.parse(at), requests: WatchdogRequest[] = [];
  for (const goal of goals) {
    if (!inspectable(goal) ||
      (goal.attention && goal.attention.source !== "watchdog" && goal.attention.source !== "live")) continue;
    const reason = reasonFor(goal, now), basis = progressAt(goal);
    if (!reason) {
      if (goal.attention?.source === "watchdog" || goal.attention?.source === "live") goal.attention = null;
      delete goal.watchdog;
      delete goal.recovery;
      continue;
    }
    if (!goal.watchdog || goal.watchdog.reason !== reason || goal.watchdog.basis !== basis) {
      goal.watchdog = { reason, basis, detectedAt: at };
      if (goal.attention?.source === "watchdog" || goal.attention?.source === "live") goal.attention = null;
      if (reason === "settled" && goal.live?.reachable && ["idle", "done"].includes(goal.live.state))
        goal.recovery = goal.live.state as "idle" | "done";
      else delete goal.recovery;
    }
    const watch = goal.watchdog;
    if (watch.contactedAt && now - Date.parse(watch.contactedAt) >= ESCALATE_AFTER && !watch.escalatedAt) {
      watch.escalatedAt = at;
      if (!goal.attention) goal.attention = {
        id: newId("attention"),
        kind: "intervention", source: "watchdog", since: at,
        summary: reason === "unassigned" ? "巡检已请管家分配负责人，但 10 分钟仍没有独立执行现场，请查看管家。" :
          "巡检已请管家处理，但 10 分钟仍未收到恢复进展，请查看现场。",
      };
      record(goal, at, "已联系管家，但仍未收到恢复进展，现请你查看现场。");
    }
    if (watch.escalatedAt) continue;
    const interval = watch.lastError ? RETRY_AFTER : NUDGE_AFTER;
    if (!watch.attemptedAt || now - Date.parse(watch.attemptedAt) >= interval)
      requests.push({ goalId: goal.id, reason, basis });
  }
  return requests;
}
export function reportWatchdog(goal: Goal, at: string, basis: string, outcome: "contacted" | "failed", detail?: string) {
  const watch = goal.watchdog;
  if (!watch || !inspectable(goal) || watch.basis !== basis || progressAt(goal) !== basis) return;
  watch.attemptedAt = at;
  if (outcome === "contacted") {
    watch.contactedAt ??= at;
    delete watch.lastError;
    delete goal.recovery;
    if (goal.attention?.source === "watchdog" && !watch.escalatedAt) goal.attention = null;
    record(goal, at, "已请管家核查负责人及下一步，暂不打扰你。");
  } else {
    watch.lastError = detail || "管家暂时不可达";
    delete goal.recovery;
    if (!goal.attention) goal.attention = {
      id: newId("attention"),
      kind: "intervention", source: "watchdog", since: at,
      summary: `巡检未能联系管家：${watch.lastError}。请重新连接管家。`,
    };
    record(goal, at, `联系管家失败：${watch.lastError}`);
  }
}
