import { newId } from "./model.js";
import type { Goal, WatchdogReason } from "./types.js";

const DEFAULT_NO_PROGRESS_MINUTES = 30;
const OWNER_START_GRACE = 60_000;
const SETTLED_AFTER = 90_000;
const ESCALATE_AFTER = 10 * 60_000;
const RETRY_AFTER = 60_000;
const NUDGE_AFTER = 15 * 60_000;
const BUSINESS_WRITES = new Set([
  "progress", "waiting", "decision", "delivery", "resolved", "review", "blocked",
]);
export interface WatchdogRequest { goalId: string; reason: WatchdogReason; basis: string }
function latestProgress(goal: Goal) {
  return goal.activities.filter(activity => activity.kind !== "watchdog").at(-1);
}
function progressAt(goal: Goal) {
  return latestProgress(goal)?.at ?? goal.createdAt;
}
function ownerReportedCurrentDispatch(goal: Goal) {
  const dispatchedAt = Date.parse(
    goal.dispatch?.at ?? goal.agentRuntime?.attempt.startedAt ?? goal.createdAt,
  );
  if (Number.isFinite(Date.parse(goal.agentRuntime?.lastSemanticWriteAt ?? "")) &&
    Date.parse(goal.agentRuntime!.lastSemanticWriteAt!) >= dispatchedAt)
    return true;
  return goal.activities.some(activity =>
    !["系统", "你", "管家", "concierge", "巡检"].includes(activity.actor) &&
    BUSINESS_WRITES.has(activity.kind) &&
    Date.parse(activity.at) >= dispatchedAt);
}
function concise(value: string, limit = 180) {
  const characters = Array.from(value.replace(/\s+/g, " ").trim());
  return characters.length > limit ? `${characters.slice(0, limit).join("")}…` : characters.join("");
}
function reasonLabel(reason: WatchdogReason, noProgressMinutes: number) {
  return reason === "unassigned" ? "尚未登记独立负责人现场"
    : reason === "blocked" ? "负责人正在等待输入或批准"
      : reason === "missing" ? "负责人现场不可达"
        : reason === "protocol_missing" ? "负责人已停止但未按协议写回结果"
        : reason === "settled" ? "负责人已停止输出但尚未写回结果"
          : `目标 ${noProgressMinutes} 分钟没有写回实质进展`;
}
function inspectable(goal: Goal) {
  return goal.mode === "concierge" && goal.status === "active";
}
function record(goal: Goal, at: string, text: string) {
  goal.activities.push({ id: newId("act"), at, actor: "巡检", kind: "watchdog", text });
  goal.updatedAt = at;
}
function escalateReview(
  goal: Goal,
  watch: NonNullable<Goal["watchdog"]>,
  now: number,
  at: string,
  reason: WatchdogReason,
  noProgressMinutes: number,
) {
  if (!watch.contactedAt || now - Date.parse(watch.contactedAt) < ESCALATE_AFTER || watch.escalatedAt)
    return;
  watch.escalatedAt = at;
  const progress = latestProgress(goal);
  const lastProgress = progress
    ? `${progress.actor}：${concise(progress.text)}`
    : "没有可用的历史进展";
  if (!goal.attention) goal.attention = {
    id: newId("attention"),
    kind: "intervention", source: "watchdog", since: at,
    summary: `目标「${goal.title}」${reasonLabel(reason, noProgressMinutes)}。最后进展：${lastProgress}。已请管家处理 10 分钟仍未恢复，请查看现场。`,
  };
  record(goal, at, `目标「${goal.title}」${reasonLabel(reason, noProgressMinutes)}；已联系管家，但 10 分钟仍无恢复进展，现请你查看现场。`);
}
function reasonFor(
  goal: Goal,
  now: number,
  staleAfter: number,
): WatchdogReason | undefined {
  const age = now - Date.parse(progressAt(goal));
  if (goal.agentRuntime?.receipt?.status === "protocol_missing")
    return "protocol_missing";
  if (!goal.scene && !goal.herdr?.paneId && !goal.herdr?.agent && goal.dispatch?.status !== "pending" &&
    now - Date.parse(goal.dispatch?.at ?? goal.createdAt) >= OWNER_START_GRACE) return "unassigned";
  if (goal.agentRuntime?.lastEventType === "agent.blocked" &&
    !(goal.live?.state === "working" &&
      Date.parse(goal.live.checkedAt) > Date.parse(goal.agentRuntime.lastEventAt)) &&
    now - Date.parse(goal.agentRuntime.lastEventAt) >= 5_000) return "blocked";
  if (goal.live?.state === "blocked") return "blocked";
  if (goal.live?.reachable === false && age >= OWNER_START_GRACE) return "missing";
  const receipt = goal.agentRuntime?.receipt;
  if (age >= staleAfter) return "stale";
  if (receipt && ["waiting", "reminding", "reminded"].includes(receipt.status) &&
    now <= Date.parse(receipt.inspectAt) + 15_000)
    return;
  // A quiet terminal may hold an unrecorded result or an unrecognized input
  // prompt. It is not evidence of delivery, failure or completion. Ask the
  // concierge to reconcile the actual owner, rather than guessing from text.
  if (goal.live?.reachable === true && ["idle", "done"].includes(goal.live.state) &&
    now - Date.parse(goal.live.checkedAt) >= SETTLED_AFTER &&
    receipt?.status !== "written" && !ownerReportedCurrentDispatch(goal))
    return "settled";
}
export function inspectWatchdog(
  goals: Goal[],
  at: string,
  noProgressMinutes = DEFAULT_NO_PROGRESS_MINUTES,
): WatchdogRequest[] {
  const staleAfter =
      Math.max(1, Math.trunc(noProgressMinutes)) * 60_000,
    now = Date.parse(at),
    requests: WatchdogRequest[] = [];
  for (const goal of goals) {
    if (!inspectable(goal) ||
      (goal.attention && goal.attention.source !== "watchdog" && goal.attention.source !== "live")) continue;
    const reason = reasonFor(goal, now, staleAfter), basis = progressAt(goal);
    const contactedAt = Date.parse(goal.watchdog?.contactedAt ?? "");
    const liveCheckedAt = Date.parse(goal.live?.checkedAt ?? "");
    // A concierge's reconciliation note is a semantic write and therefore
    // changes progressAt, but it is not new activity from the owner. Keep the
    // original settled review until the owner scene actually reports a new
    // observation; otherwise every note would start a fresh 90-second loop.
    const settledAwaitingSceneChange = reason === "settled" &&
      goal.watchdog?.reason === "settled" && Number.isFinite(contactedAt) &&
      (!Number.isFinite(liveCheckedAt) || liveCheckedAt <= contactedAt);
    if (!reason) {
      if (goal.attention?.source === "watchdog" || goal.attention?.source === "live") goal.attention = null;
      delete goal.watchdog;
      delete goal.recovery;
      continue;
    }
    if (settledAwaitingSceneChange) {
      const watch = goal.watchdog!;
      escalateReview(goal, watch, now, at, reason, noProgressMinutes);
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
    escalateReview(goal, watch, now, at, reason, noProgressMinutes);
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
