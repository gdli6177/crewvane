import { attentionKind, attentionRequest, pendingSceneReply } from "../../../../../packages/core/src/model.js";
import type {
  Activity,
  Goal,
  GoalAttachment,
  WorkspaceState,
} from "../../../../../packages/core/src/types.js";

export type GoalTone = "running" | "waiting" | "review" | "reply" | "blocked" | "done";

export const statusLabel = {
  active: "进行中",
  waiting: "等待中",
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
  sceneSync?: ReturnType<typeof sceneSyncPresentation>;
}
export function sceneSyncPresentation(goal: Goal) {
  if (goal.mode !== "concierge" || ["completed", "dropped"].includes(goal.status)) return undefined;
  const reply = pendingSceneReply(goal);
  const delivered = goal.dispatch?.kind === "scene_reply" && goal.dispatch.status === "sent";
  if (reply) return {
    label: goal.dispatch?.status === "failed" ? "现场答复同步失败"
      : delivered ? "答复已送达，事项尚未解决" : "现场已答复，管家核对中",
    detail: goal.dispatch?.status === "failed"
      ? goal.dispatch.detail || "答复已保存，恢复管家连接后可以重试。"
      : delivered ? "管家已收到你的原话；当前问题尚未明确解决，可以继续在现场沟通或补充说明。"
      : "你的原话已保存；管家正在核对这条事项，无需重复答复。",
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
  const dueFollowUp = !ended && goal.status === "waiting" && kind === "follow_up";
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
  let label = "管家处理中";
  let detail = "负责人正在推进；暂时不需要你处理。";
  let brief = latestAgentReply?.text || "有真正需要你的变化时，管家会带回这里。";
  let nextLabel = "接下来的安排";
  if (ended) {
    tone = goal.status === "dropped" ? "blocked" : "done";
    label = statusLabel[goal.status];
    detail = goal.status === "completed" ? "已经验收完成。" : "已经放弃，只保留记录。";
    brief = goal.delivery?.summary || goal.next || detail;
    nextLabel = "最后记录";
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
  } else if (needsDecision) {
    tone = "reply";
    label = "等你决定";
    detail = "负责人停在这里，需要你的明确授权或选择。";
    brief = goal.attention?.summary || goal.next;
    nextLabel = "决定后继续";
  } else if (needsIntervention) {
    tone = "blocked";
    label = "需要你排障";
    detail = "负责人无法自行继续，需要你在现场完成一次操作。";
    brief = goal.attention?.summary || goal.next;
    nextLabel = "处理后的安排";
  } else if (dueFollowUp) {
    tone = "waiting";
    label = "到点跟进";
    detail = "到了你设定的跟进时间，可以确认等待是否已有结果。";
    brief = goal.waitingFor
      ? `正在等待 ${goal.waitingFor}，现在需要确认是否已有结果。`
      : "等待事项已到跟进时间。";
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
    detail = "这个目标由你推进：补充进展、提交成果，需要协作时可以交回管家。";
    brief = goal.next;
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
