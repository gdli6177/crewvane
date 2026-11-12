import { attentionKind, attentionRequest, pendingSceneReply } from "../../../../../packages/core/src/model.js";
import { resolveAcceptance } from "../../../../../packages/core/src/autonomy.js";
import type {
  Activity,
  Goal,
  GoalAttachment,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";

export type GoalTone = "running" | "waiting" | "review" | "reply" | "blocked" | "done";

export const statusLabel = {
  backlog: "暂存",
  active: "跟进中",
  waiting: "等待外部",
  review: "待验收",
  completed: "已完成",
  dropped: "已放弃",
} as const;

export const activityKindLabel: Record<Activity["kind"], string> = {
  created: "目标",
  message: "消息",
  progress: "答复",
  waiting: "等待",
  decision: "决定",
  delivery: "交付",
  accepted: "验收",
  rework: "返工",
  dropped: "放弃",
  resolved: "处理",
  reminder: "提醒",
  session: "会话",
  watchdog: "巡检",
  ship: "上线",
  autonomy: "续跑",
  boundary: "边界",
  verification: "复核",
  release: "发布",
  reopened: "重开",
  skill: "方法",
};

const contentKinds = new Set<Activity["kind"]>([
  "created",
  "message",
  "progress",
  "waiting",
  "decision",
  "delivery",
  "accepted",
  "rework",
  "dropped",
  "resolved",
]);

export const isGoalConversationActivity = (activity: Activity) =>
  contentKinds.has(activity.kind);

export function goalConversationActivities(goal: Goal, excludeIds: string[] = []) {
  const excluded = new Set(excludeIds);
  return [...goal.activities]
    .filter(
      (activity) =>
        isGoalConversationActivity(activity) && !excluded.has(activity.id),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function goalSystemActivities(goal: Goal) {
  return [...goal.activities]
    .filter((activity) => !isGoalConversationActivity(activity))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export interface GoalPresentation {
  tone: GoalTone;
  label: string;
  detail: string;
  brief: string;
  nextLabel: string;
  projectName: string;
  latest?: Activity;
  latestAttachments: GoalAttachment[];
  latestAgentReply?: Activity;
  latestAgentReplyAttachments: GoalAttachment[];
  contextActivity?: Activity;
  contextAttachments: GoalAttachment[];
  ended: boolean;
  needsDecision: boolean;
  needsIntervention: boolean;
  dispatchFailed: boolean;
  dueFollowUp: boolean;
  verificationPending: boolean;
  sceneSync?: ReturnType<typeof sceneSyncPresentation>;
}
export function sceneSyncPresentation(goal: Goal) {
  if (goal.mode !== "concierge" || ["completed", "dropped"].includes(goal.status)) return undefined;
  const reply = pendingSceneReply(goal);
  const delivered = goal.dispatch?.kind === "scene_reply" && goal.dispatch.status === "sent";
  const unconfirmed = goal.dispatch?.kind === "scene_reply" && goal.dispatch.status === "unconfirmed";
  if (reply) return {
    label: goal.dispatch?.status === "failed" ? "现场答复同步失败"
      : unconfirmed ? "答复已提交，等待现场确认"
        : delivered ? "答复已送达，事项尚未解决" : "现场答复待同步",
    detail: goal.dispatch?.status === "failed"
      ? goal.dispatch.detail || "答复已保存，恢复管家连接后可以重试。"
      : unconfirmed ? goal.dispatch?.detail || "答复已写入本机；Herdr 状态确认超时，先以现场为准。"
        : delivered ? "管家已收到你的原话；当前问题尚未明确解决，可以继续在现场沟通或补充说明。"
      : "你的原话已保存，正在等待交给管家；原事项在明确处理前仍会保留，无需重复答复。",
    quote: reply.quote,
    summary: reply.summary,
    retry: goal.dispatch?.status === "failed" ? "dispatch" as const : undefined,
  };
  const visit = goal.sceneVisit;
  if (!visit || visit.attentionId !== attentionRequest(goal)?.id ||
    visit.status === "watching") return undefined;
  const expired = visit.status === "checking" &&
    Date.now() - Date.parse(visit.attemptedAt || visit.at) >= 150_000;
  const checking = visit.status === "pending" || visit.status === "checking" && !expired;
  return {
    label: checking ? "正在核对现场" : "现场尚未确认处理结果",
    detail: checking
      ? "负责人正在核对最近的真实交互；原事项在确认前仍会保留。"
      : expired ? "上次现场核对中断或超时；原事项仍保留，可以重试同步。"
      : visit.detail || "尚未收到明确答复的回执，原事项仍待处理。可以继续在现场沟通或重试同步。",
    quote: undefined,
    summary: undefined,
    retry: checking ? undefined : "scene" as const,
  };
}

function executionPresentation(goal: Goal): Pick<GoalPresentation, "label" | "detail" | "tone"> {
  if (goal.watchdog?.contactedAt) return {
    label: "已请管家核对", tone: "waiting",
    detail: "核对请求已送达管家，尚未收到新的处理结果；这不表示管家此刻仍在执行。",
  };
  const receipt = goal.agentRuntime?.receipt?.status;
  if (goal.watchdog || receipt === "protocol_missing") return {
    label: "待管家核对", tone: "waiting",
    detail: "已产生核对请求，正在等待交给管家；现在不需要你处理。",
  };
  if (receipt === "waiting") return {
    label: "检查回执", tone: "running",
    detail: "负责人本轮已结束，正在等待结构化回执；现在不需要你处理。",
  };
  if (receipt === "reminding" || receipt === "reminded") return {
    label: "已提醒写回", tone: "running",
    detail: "正在处理本轮唯一一次写回提醒；仍缺少结果时再交给管家核对。",
  };
  if (receipt === "written") return {
    label: "本轮已回报", tone: "running",
    detail: "负责人已写回本轮进展；目标仍按记录的下一步跟进，不代表整个目标已完成。",
  };
  if (goal.live?.reachable === false) return {
    label: "现场连接中断", tone: "waiting",
    detail: "当前无法连接负责人现场；这不等于目标完成或失败。",
  };
  if (goal.live?.state === "working") return {
    label: "执行中", tone: "running",
    detail: "负责人正在执行；暂时不需要你处理。",
  };
  if (goal.live?.state === "blocked") return {
    label: "现场待输入", tone: "waiting",
    detail: "负责人现场正在等待输入或批准；需要人介入时会明确进入注意力。",
  };
  if (goal.live?.state === "idle" || goal.live?.state === "done") return {
    label: goal.next.trim() ? "按计划跟进" : "待管家更新",
    tone: "running",
    detail: goal.next.trim()
      ? "负责人当前空闲；目标仍在跟进中，下一步已经记录。到了需要你处理时会进入注意力。"
      : "负责人当前空闲，尚未记录明确的下一步；管家会补全推进计划。",
  };
  return goal.herdr ? {
    label: "待管家跟进", tone: "running",
    detail: "现场已登记，尚未确认负责人当前是否执行；以记录的下一步为准。",
  } : {
    label: "待分配", tone: "running",
    detail: "目标已保存，管家会安排负责人并写回下一步。",
  };
}

export function goalProgressLabel(goal: Goal) {
  if (goal.status === "completed" || goal.status === "dropped") return statusLabel[goal.status];
  const kind = attentionKind(goal);
  if (kind === "decision") return "等你决定";
  if (kind === "review") return "等你验收";
  if (kind === "follow_up") return "到点跟进";
  if (kind === "intervention") return goal.herdr ? "需要你排障" : "需要你处理";
  if (goal.status === "waiting") return "等待外部";
  if (goal.mode === "manual") return "由你处理";
  if (goal.status === "review" &&
    goal.autonomy?.continuation?.trigger === "verification" &&
    !goal.autonomy.lastVerification)
    return "独立复核中";
  return executionPresentation(goal).label;
}

export interface GoalSceneContext {
  id: string;
  title: string;
  projectName: string;
  label: string;
  currentAction: string;
}

export function presentSceneContext(goal: Goal, state: WorkspaceState): GoalSceneContext {
  const view = presentGoal(goal, state);
  return {
    id: goal.id,
    title: goal.title,
    projectName: view.projectName,
    label: view.label,
    currentAction: view.sceneSync?.detail || goal.attention?.summary || goal.next || view.brief,
  };
}

export function presentGoal(goal: Goal, state: WorkspaceState): GoalPresentation {
  const ended = goal.status === "completed" || goal.status === "dropped";
  const kind = attentionKind(goal);
  const needsDecision = !ended && kind === "decision";
  const dispatchFailed = !ended && goal.attention?.source === "dispatch";
  const needsIntervention = !ended && kind === "intervention" && !dispatchFailed;
  const dueFollowUp = !ended && kind === "follow_up";
  const verificationPending = !ended &&
    goal.status === "review" &&
    resolveAcceptance(state, goal).mode === "auto-with-verification" &&
    !goal.autonomy?.lastVerification &&
    goal.autonomy?.continuation?.trigger === "verification" &&
    ["scheduled", "claimed", "sent"].includes(goal.autonomy.continuation.status);
  const sceneSync = !ended ? sceneSyncPresentation(goal) : undefined;
  const latest = [...goal.activities]
    .reverse()
    .find((activity) => contentKinds.has(activity.kind));
  const attachmentsFor = (activity?: Activity) => (activity?.attachmentIds ?? [])
    .map((id) => goal.attachments?.find((attachment) => attachment.id === id))
    .filter((attachment): attachment is GoalAttachment => Boolean(attachment));
  const latestAttachments = attachmentsFor(latest);
  const latestAgentReply = [...goal.activities]
    .reverse()
    .find((activity) =>
      activity.kind !== "created" &&
      contentKinds.has(activity.kind) &&
      !activity.actor.startsWith("你") &&
      !["系统", "巡检"].includes(activity.actor));
  const latestAgentReplyAttachments = attachmentsFor(latestAgentReply);
  const contextActivity = [...goal.activities]
    .reverse()
    .find((activity) =>
      isGoalConversationActivity(activity) &&
      !activity.actor.startsWith("你") &&
      !["系统", "巡检"].includes(activity.actor) &&
      !["decision", "delivery", "accepted", "rework", "dropped", "resolved"].includes(activity.kind));
  const contextAttachments = attachmentsFor(contextActivity);

  let tone: GoalTone = "running";
  let label = goal.mode === "manual" ? "由你处理" : goal.herdr ? "等待管家跟进" : "等待分配";
  let detail = goal.mode === "manual"
    ? "这件事由你安排，做完即可标记完成；需要协作时可以交给管家。"
    : "目标已保存，管家会安排负责人并写回下一步。";
  let brief = latestAgentReply?.text || "有真正需要你的变化时，管家会带回这里。";
  let nextLabel = "接下来的安排";
  if (ended) {
    tone = goal.status === "dropped" ? "blocked" : "done";
    label = statusLabel[goal.status];
    detail = goal.status === "completed" ? "已经验收完成。" : "已经放弃，只保留记录。";
    brief = goal.delivery?.summary || goal.next || detail;
    nextLabel = "最后记录";
  } else if (goal.status === "backlog") {
    tone = "waiting";
    label = dueFollowUp ? "到点安排" : "尚未开始";
    detail = "只记录，不会启动 Agent。准备好后再决定由谁来做。";
    brief = goal.description;
    nextLabel = "准备好再开始";
  } else if (verificationPending) {
    tone = "waiting";
    label = "独立复核中";
    detail = "系统正在等待未提交该交付的独立复核者核对完成条件和真实证据。";
    brief = goal.attention?.summary || goal.next;
    nextLabel = "复核后的安排";
  } else if (goal.status === "review") {
    tone = "review";
    label = "等你验收";
    detail = goal.delivery?.checks.length
      ? `交付与 ${goal.delivery.checks.length} 项检查记录已经就绪。`
      : "成果已经提交，等待你判断是否通过。";
    brief = goal.delivery?.summary || goal.attention?.summary || goal.next;
    nextLabel = "验收后的安排";
  } else if (dispatchFailed) {
    tone = "blocked";
    label = "联系管家失败";
    detail = "目标已保存在本机；恢复连接后重试即可继续。";
    brief = goal.dispatch?.detail || goal.attention?.summary || detail;
    nextLabel = "恢复后继续";
  } else if (goal.dispatch?.status === "unconfirmed") {
    tone = "waiting";
    label = "已提交，等待现场确认";
    detail = goal.dispatch.detail || "任务已写入本机，Herdr 状态确认超时；系统会核对现场，不会自动重复发送。";
    brief = detail;
    nextLabel = "核对后的安排";
  } else if (needsDecision) {
    tone = "reply";
    label = goal.kind === "release"
      ? "等你批准发布"
      : goal.autonomy?.boundaryChange?.status === "pending"
        ? "等你批准边界"
        : "等你决定";
    detail = goal.kind === "release"
      ? "这只是本次候选和环境的执行许可；执行完成后仍需你核对真实结果。"
      : goal.autonomy?.boundaryChange?.status === "pending"
        ? "结果、完成条件或外部影响将发生变化，需要你明确批准。"
        : "负责人停在这里，需要你的明确授权或选择。";
    brief = goal.attention?.summary || goal.next;
    nextLabel = "决定后继续";
  } else if (needsIntervention) {
    tone = "blocked";
    label = goal.herdr ? "需要你排障" : "需要你处理";
    detail = goal.herdr
      ? "负责人无法自行继续，需要你在现场完成一次操作。"
      : "这件事有尚未处理的事项，可以回复管家或查看完整记录。";
    brief = goal.attention?.summary || goal.next;
    nextLabel = "处理后的安排";
  } else if (dueFollowUp) {
    tone = "waiting";
    label = "到点跟进";
    detail = "到了你设定的提醒时间，请确认下一步安排。";
    brief = goal.waitingFor
      ? `正在等待 ${goal.waitingFor}，现在需要确认是否已有结果。`
      : goal.next || "到了你设定的提醒时间。";
    nextLabel = "下一步";
  } else if (goal.status === "waiting") {
    tone = "waiting";
    label = "等待外部";
    detail = goal.waitingFor
      ? `正在等待 ${goal.waitingFor}；现在不需要你处理。`
      : "正在等待外部结果；现在不需要你处理。";
    brief = goal.next;
    nextLabel = "恢复推进的条件";
  } else if (goal.mode === "manual") {
    tone = "running";
    label = "由你处理";
    detail = "这件事由你安排，做完即可标记完成；需要协作时可以交给管家。";
    brief = goal.next;
  } else {
    ({ tone, label, detail } = executionPresentation(goal));
    if (goal.watchdog || goal.agentRuntime?.receipt?.status === "protocol_missing")
      nextLabel = "核对后的安排";
  }
  if (sceneSync) {
    label = sceneSync.label;
    detail = sceneSync.detail;
    brief = sceneSync.summary || brief;
  }

  return {
    tone,
    label,
    detail,
    brief: brief || "还没有记录下一步。",
    nextLabel,
    projectName:
      state.projects.find((project) => project.id === goal.projectId)?.name ??
      "个人事项",
    latest,
    latestAttachments,
    latestAgentReply,
    latestAgentReplyAttachments,
    contextActivity,
    contextAttachments,
    ended,
    needsDecision,
    needsIntervention,
    dispatchFailed,
    dueFollowUp,
    verificationPending,
    sceneSync,
  };
}

export const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
