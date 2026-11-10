import { WorkspaceStore, newId } from "./store.js";
import {
  cleanupOrphanAttachmentFiles,
  removeAttachmentFiles,
  validateGoalAttachments,
} from "./attachments.js";
import type { CrewvaneCommand, Goal, GoalAttachment, WorkspaceState, WorkflowStep } from "./types.js";
import {
  isHighRiskCategory,
  isShipPolicy,
  latestDecision,
  normalizeDecisionKey,
  outcomeLabel,
  projectPolicy,
  riskCategoryForText,
  riskSummary,
} from "./governance.js";
import { attentionRequest, defaultProjectPolicy, pendingSceneReply } from "./model.js";
import { observeSceneWork } from "./scene.js";
import { inspectWatchdog, reportWatchdog } from "./watchdog.js";
import { hasDueReminder, intakeArrangement } from "./task-pool.js";
import { externalWaitTarget, leaveExternalWait } from "./waiting.js";
export const nowIso = () => new Date().toISOString();
function text(value: unknown, label: string, limit = 20_000): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > limit ||
    value.includes("\0")
  )
    throw new Error(`请提供有效的${label}`);
  return value.trim();
}
function automaticGoalTitle(request: string): string {
  const firstLine = request.split(/\r\n?|\n/).find(line => line.trim())?.trim();
  return Array.from(firstLine || "新目标").slice(0, 80).join("");
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error("无效的记录 ID");
  return value;
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("请提供有效的 ISO 时间");
  return new Date(value).toISOString();
}
function preservedOwnerResume(value: unknown): NonNullable<Goal["ownerResume"]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请提供有效的负责人恢复信息");
  const resume = value as NonNullable<Goal["ownerResume"]>;
  const owner = text(resume.owner, "负责人名称", 120);
  const savedAt = iso(resume.savedAt);
  const cwd = resume.cwd === undefined
    ? undefined
    : text(resume.cwd, "负责人工作目录", 4096);
  if (cwd !== undefined && !cwd.startsWith("/"))
    throw new Error("负责人工作目录必须是绝对路径");
  const session = resume.agentSession;
  if (session === undefined) return { owner, savedAt, ...(cwd ? { cwd } : {}) };
  if (!session || typeof session !== "object" || Array.isArray(session))
    throw new Error("负责人会话信息无效");
  const source = text(session.source, "Agent 会话来源", 160);
  const agent = text(session.agent, "Agent 类型", 64);
  if (!/^[A-Za-z0-9:_-]+$/.test(source) || !/^[a-z][a-z0-9_-]{0,31}$/.test(agent))
    throw new Error("负责人会话来源或 Agent 类型无效");
  if (session.kind !== "id" && session.kind !== "path")
    throw new Error("负责人会话标识类型无效");
  const sessionValue = text(session.value, "Agent 会话标识", 4096);
  if (/[\x00-\x1f\x7f]/.test(sessionValue))
    throw new Error("Agent 会话标识包含无效字符");
  return {
    owner,
    savedAt,
    ...(cwd ? { cwd } : {}),
    agentSession: { source, agent, kind: session.kind, value: sessionValue },
  };
}
function steps(value: unknown): WorkflowStep[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30)
    throw new Error("工序至少需要一步");
  if (new Set(value.map((step) => step.id)).size !== value.length)
    throw new Error("工序步骤 ID 不能重复");
  return value.map((step) => ({
    id: id(step.id),
    name: text(step.name, "工序名称", 100),
    prompt: text(step.prompt, "提示词", 12_000),
  }));
}
function ongoing(item: Goal, allowReview = false, allowBacklog = false) {
  if (["completed", "dropped"].includes(item.status))
    throw new Error("已结束的目标不能继续修改");
  if (item.status === "review" && !allowReview)
    throw new Error("目标正在等待验收，请先验收或退回修改");
  if (item.status === "backlog" && !allowBacklog)
    throw new Error("这件事尚未开始，请先选择我来做或交给管家");
}
function attachmentActivity(text: string, attachments: GoalAttachment[]): string {
  if (!attachments.length) return text;
  return `${text}\n\n附带图片：${attachments.map(item => item.name).join("、")}`;
}
function substantiveAgentText(value: string | undefined, label: string, limit: number) {
  const result = text(value, label, limit);
  if (/^(?:已(?:经)?)?(?:回答|回复|答复|处理|完成)(?:了)?(?:用户)?(?:的)?(?:问题)?[。.!！]?$/.test(result))
    throw new Error(`${label}必须写回具体内容，不能只写「已回答」或同类占位摘要`);
  return result;
}
export { attentionGoals, attentionKind } from "./model.js";
export class WorkspaceService {
  readonly store: WorkspaceStore;
  constructor(readonly root: string) {
    this.store = new WorkspaceStore(root);
  }
  async read() {
    return this.store.read();
  }
  private async removeGoalAttachment(command: Extract<CrewvaneCommand, { type: "goal.attachment.remove" }>) {
    const attachmentId = id(command.attachmentId),
      actor = command.actor?.trim() ? text(command.actor, "操作者", 120) : "你",
      result = await this.store.update(command.type, async state => {
        const item = state.goals.find(goal => goal.id === id(command.goalId));
        if (!item) throw new Error("找不到目标");
        const attachment = item.attachments?.find(candidate => candidate.id === attachmentId);
        if (!attachment) throw new Error("找不到这个附件");
        const remaining = (item.attachments ?? []).filter(candidate => candidate.id !== attachmentId);
        if (remaining.length) item.attachments = remaining;
        else delete item.attachments;
        const at = nowIso();
        item.activities.push({
          id: newId("act"),
          at,
          actor,
          kind: "progress",
          text: `已删除图片：${attachment.name}`,
        });
        item.updatedAt = at;
        return { goal: item, attachment };
      });
    await removeAttachmentFiles(this.root, [result.attachment]);
    return result.goal;
  }
  private async deleteEndedGoal(command: Extract<CrewvaneCommand, { type: "goal.delete" }>) {
    const result = await this.store.update(command.type, state => {
      const goalId = id(command.goalId),
        index = state.goals.findIndex(goal => goal.id === goalId),
        item = state.goals[index];
      if (!item) throw new Error("找不到目标");
      if (!["completed", "dropped"].includes(item.status))
        throw new Error("只有已完成或已放弃的目标可以永久删除");
      if (command.actor && command.actor !== "你")
        throw new Error("只有人可以永久删除目标");
      state.goals.splice(index, 1);
      return item;
    });
    await removeAttachmentFiles(this.root, result.attachments ?? []);
    return { deleted: result.id };
  }
  private async cleanupAttachments(command: Extract<CrewvaneCommand, { type: "attachments.cleanup" }>) {
    const retentionDays = command.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)
      throw new Error("附件保留天数必须是 1 到 3650 的整数");
    const at = command.at ? iso(command.at) : nowIso(),
      cutoff = Date.parse(at) - retentionDays * 24 * 60 * 60 * 1000,
      removed = await this.store.update(command.type, state => {
        const expired: GoalAttachment[] = [];
        for (const item of state.goals) {
          if (!["completed", "dropped"].includes(item.status) || !item.attachments?.length) continue;
          if (Date.parse(item.updatedAt) > cutoff) continue;
          const removedHere = item.attachments;
          expired.push(...removedHere);
          delete item.attachments;
          item.activities.push({
            id: newId("act"),
            at,
            actor: "系统",
            kind: "progress",
            text: `已清理保留期满的 ${removedHere.length} 张图片。`,
          });
          item.updatedAt = at;
        }
        return expired;
      });
    await removeAttachmentFiles(this.root, removed);
    const referenced = (await this.store.read()).goals.flatMap(goal =>
      (goal.attachments ?? []).map(item => item.path));
    const orphans = await cleanupOrphanAttachmentFiles(this.root, referenced, 24 * 60 * 60 * 1000, Date.parse(at));
    return { removed: removed.length, orphans };
  }
  async execute(command: CrewvaneCommand): Promise<unknown> {
    if (
      !command ||
      typeof command !== "object" ||
      typeof command.type !== "string"
    )
      throw new Error("无效的命令");
    if (command.type === "snapshot") return this.store.read();
    if (command.type === "goal.attachment.remove") return this.removeGoalAttachment(command);
    if (command.type === "goal.delete") return this.deleteEndedGoal(command);
    if (command.type === "attachments.cleanup") return this.cleanupAttachments(command);
    return this.store.update(command.type, async (state) => {
      const goal = (goalId: string) => {
        const found = state.goals.find((item) => item.id === id(goalId));
        if (!found) throw new Error("找不到目标");
        return found;
      };
      const stamp = (item: Goal) => {
        item.updatedAt = nowIso();
      };
      const activity = (
        item: Goal,
        kind: Goal["activities"][number]["kind"],
        body: string,
        actor = "你",
      ) => {
        item.activities.push({
          id: newId("act"),
          at: nowIso(),
          actor,
          kind,
          text: text(body, "记录", 12_000),
        });
        stamp(item);
      };
      const handBackExternalWait = (item: Goal) => {
        if (item.status !== "waiting") return;
        activity(item, "session",
          `已交回 Agent 核查。此前等待外部：${item.waitingFor}。${item.next}${item.remindAt ? `\n原跟进时间：${item.remindAt}` : ""}`,
          "系统");
        leaveExternalWait(item);
      };
      if ("goalId" in command && command.goalId && command.type !== "goal.scene-reply") {
        const item = goal(command.goalId);
        if (command.attentionId && command.attentionId !== attentionRequest(item)?.id)
          throw new Error("待处理事项已经变化；请重新读取当前目标，不能用旧回复处理新问题");
        if (command.sceneReplyId && command.sceneReplyId !== item.sceneReply?.id)
          throw new Error("现场回复已经更新；请重新读取用户最新原话");
        if (command.sceneReplyId) {
          if (!command.attentionId || command.attentionId !== item.sceneReply?.attentionId)
            throw new Error("现场回执必须绑定对应的待处理事项");
          if (["goal.accept", "goal.complete", "goal.drop", "goal.resolve", "goal.rework"].includes(command.type) &&
            (!("note" in command) || command.note?.trim() !== item.sceneReply.quote))
            throw new Error("处理现场回执时必须记录用户原话，不能替换成 Agent 自己的结论");
        }
      }
      switch (command.type) {
        case "workspace.rename":
          state.name = text(command.name, "工作区名称", 80);
          return state.name;
        case "workspace.recovery.dismiss":
          delete state.recovery;
          return true;
        case "agents.configure": {
          const startup = (value: unknown) => {
            if (typeof value !== "string" || !value.trim() || value.length > 2000 || /[\x00-\x1f\x7f;&|<>`$]/.test(value)) throw new Error("无效的 Agent 启动命令：请使用单行 CLI 命令与参数，不支持 shell 表达式");
            return value.trim();
          };
          state.agents = {
            concierge: startup(command.preferences.concierge),
            ...(command.preferences.owner?.trim() ? { owner: startup(command.preferences.owner) } : {}),
            ...(command.preferences.worker?.trim() ? { worker: startup(command.preferences.worker) } : {}),
          };
          return state.agents;
        }
        case "project.add": {
          const name = text(command.name, "项目名称", 100);
          if (state.projects.some((p) => p.name === name))
            throw new Error("已有同名项目");
          const project = {
            id: newId("project"),
            name,
            policy: defaultProjectPolicy(),
            ...(command.path
              ? { path: text(command.path, "项目路径", 1000) }
              : {}),
            createdAt: nowIso(),
          };
          state.projects.push(project);
          return project;
        }
        case "project.remove": {
          if (command.projectId === "personal")
            throw new Error("个人事项不能删除");
          if (state.goals.some((g) => g.projectId === command.projectId))
            throw new Error("项目仍有目标，请先完成或放弃这些目标");
          state.projects = state.projects.filter(
            (p) => p.id !== id(command.projectId),
          );
          return true;
        }
        case "project.policy.set": {
          if (command.actor !== "你")
            throw new Error("上线策略只能由人在 Crewvane 设置中修改");
          const project = state.projects.find(item => item.id === id(command.projectId));
          if (!project) throw new Error("找不到项目");
          if (!isShipPolicy(command.policy?.shipPolicy))
            throw new Error("无效的上线策略");
          if (!Array.isArray(command.policy.approvers) || command.policy.approvers.length > 20)
            throw new Error("审批人列表无效");
          const approvers = [...new Set(command.policy.approvers.map(value =>
            text(value, "审批人", 120)))];
          project.policy = {
            shipPolicy: command.policy.shipPolicy,
            approvers,
            revision: (project.policy?.revision ?? 0) + 1,
            updatedAt: nowIso(),
          };
          return project;
        }
        case "workflow.save": {
          const workflow = {
            id: id(command.workflow.id),
            name: text(command.workflow.name, "工序名称", 100),
            steps: steps(command.workflow.steps),
          };
          const index = state.workflows.findIndex((w) => w.id === workflow.id);
          if (index < 0) state.workflows.push(workflow);
          else state.workflows[index] = workflow;
          return workflow;
        }
        case "goal.create": {
          const input = command.input;
          if (!input || !["concierge", "manual"].includes(input.mode))
            throw new Error("无效的目标");
          const project = state.projects.find(
            (p) => p.id === id(input.projectId),
          );
          if (!project) throw new Error("请选择有效项目");
          if (input.workflowId)
            throw new Error("工序已移除；请在目标说明中直接写清工作要求");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"),
            projectId: project.id,
            title: text(input.title, "目标", 160),
            description: text(
              input.description || "由管家进一步梳理目标与完成标准。",
              "目标说明",
            ),
            mode: input.mode,
            status: "active",
            steps: [],
            next:
              input.next?.trim() ||
              (input.mode === "concierge"
                ? "管家正在理解目标并安排下一步。"
                : "补充下一步和跟进时间，或交给管家继续处理。"),
            owner:
              input.mode === "concierge"
                ? "待分配负责人"
                : "你",
            ...(input.remindAt ? { remindAt: iso(input.remindAt) } : {}),
            attention: null,
            ...(input.mode === "concierge"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "pending" as const, at } }
              : {}),
            activities: [
              {
                id: newId("act"),
                at,
                actor: "你",
                kind: "created",
                text:
                  input.mode === "concierge"
                    ? "已交给管家统筹。"
                    : "已记录，由你安排下一步。",
              },
            ],
            createdAt: at,
            updatedAt: at,
          };
          if (input.waitingFor !== undefined) {
            item.waitingFor = externalWaitTarget(input.waitingFor, state, item);
            item.status = "waiting";
          }
          state.goals.push(item);
          return item;
        }
        case "goal.intake": {
          const request = text(command.text, "事情说明", 20_000);
          const arrangement = intakeArrangement(command.handling ?? "concierge");
          const goalAttachments = await validateGoalAttachments(this.root, command.attachments);
          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            ...arrangement,
            steps: [],
            attention: null,
            ...(arrangement.mode === "concierge"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "pending" as const, at } }
              : {}),
            ...(command.remindAt ? { remindAt: iso(command.remindAt) } : {}),
            ...(goalAttachments.length ? { attachments: goalAttachments } : {}),
            activities: [{ id: newId("act"), at, actor: "你", kind: "created", text: request }],
            createdAt: at, updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "goal.direct": {
          const request = text(command.text, "Herdr 终端消息", 20_000);
          const incomingAttachments = await validateGoalAttachments(this.root, command.attachments);
          if (command.goalId) {
            const item = goal(command.goalId);
            if (command.handling)
              throw new Error("终端补充消息不能改变执行安排，请使用明确的开始命令");
            if (["completed", "dropped"].includes(item.status))
              throw new Error("目标已结束，不能再追加终端消息");
            if (item.mode === "concierge") handBackExternalWait(item);
            delete item.sceneReply;
            const combined = await validateGoalAttachments(this.root, [
              ...(item.attachments ?? []),
              ...incomingAttachments,
            ]);
            if (combined.length) item.attachments = combined;
            const at = nowIso();
            item.activities.push({
              id: newId("act"),
              at,
              actor: "你 · Herdr 直聊",
              kind: "message",
              text: attachmentActivity(request, incomingAttachments),
              ...(incomingAttachments.length
                ? { attachmentIds: incomingAttachments.map(attachment => attachment.id) }
                : {}),
            });
            item.updatedAt = at;
            return item;
          }

          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const arrangement = intakeArrangement(command.handling ?? "concierge");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            ...arrangement,
            steps: [],
            next: arrangement.mode === "concierge"
              ? "管家正在理解 Herdr 终端中的原文并整理目标。" : arrangement.next,
            attention: null,
            // The concierge already received this message in its terminal turn.
            // Mark it as delivered so desktop dispatch does not replay the same text.
            ...(arrangement.mode === "concierge"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "sent" as const, at, detail: "已从 Herdr 终端直接送达管家" } }
              : {}),
            ...(incomingAttachments.length ? { attachments: incomingAttachments } : {}),
            activities: [{ id: newId("act"), at, actor: "你 · Herdr 直聊", kind: "created", text: request }],
            createdAt: at, updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "scene.visit": {
          const item = goal(command.goalId), request = attentionRequest(item);
          if (!request || item.mode !== "concierge" || !item.herdr?.agent ||
            item.herdr.transport === "pane" || pendingSceneReply(item)) return item;
          if (item.sceneVisit?.attentionId === request.id &&
            (item.sceneVisit.status === "pending" ||
              item.sceneVisit.status === "checking" &&
              (!command.retry || Date.now() - Date.parse(item.sceneVisit.attemptedAt || item.sceneVisit.at) < 150_000))) return item;
          item.sceneVisit = {
            id: newId("visit"), attentionId: request.id, at: nowIso(),
            worked: item.live?.state === "working",
            status: command.retry ? "pending" : "watching",
          };
          return item;
        }
        case "scene.check": {
          const item = goal(command.goalId), visit = item.sceneVisit;
          if (!visit || visit.id !== command.visitId ||
            visit.attentionId !== attentionRequest(item)?.id || pendingSceneReply(item) ||
            item.mode !== "concierge" ||
            (command.status === "checking" ? visit.status !== "pending" : visit.status !== "checking")) return false;
          if (!["checking", "checked", "failed"].includes(command.status)) throw new Error("无效的现场核对状态");
          visit.status = command.status;
          if (command.status === "checking") visit.attemptedAt = nowIso();
          if (command.detail) visit.detail = text(command.detail, "现场核对说明", 1000);
          return true;
        }
        case "goal.scene-reply": {
          const item = goal(command.goalId);
          ongoing(item, true);
          if (item.mode !== "concierge")
            throw new Error("目标已由你接管，现场回执不能重新派发给管家");
          const actor = text(command.actor, "现场负责人", 120);
          if (actor !== item.herdr?.agent && actor !== state.concierge.agent)
            throw new Error("只有本目标登记的负责人或管家可以提交现场回执");
          const quote = text(command.quote, "用户在现场的原话", 4000);
          const summary = substantiveAgentText(command.summary, "现场处理结果", 4000);
          if (!command.attentionId || command.attentionId !== attentionRequest(item)?.id)
            throw new Error("待处理事项已经变化；请重新读取当前目标，不能用旧回复处理新问题");
          const previous = item.sceneReply;
          if (previous?.attentionId === command.attentionId &&
            previous.quote === quote && previous.summary === summary && previous.actor === actor)
            return item;
          const at = nowIso();
          item.sceneReply = {
            id: newId("reply"), attentionId: command.attentionId, quote, summary, actor, at,
          };
          activity(item, "message", quote, "你 · Herdr 现场");
          activity(item, "message", summary, actor);
          item.dispatch = {
            id: newId("handoff"), kind: "scene_reply", status: "pending", at,
            note: "用户已在负责人现场答复。请核对原话并关闭对应事项，不要要求用户重复处理。",
          };
          return item;
        }
        case "goal.message": {
          const item = goal(command.goalId);
          if (["completed", "dropped"].includes(item.status))
            throw new Error("目标已结束，不能再发送消息");
          if (item.status === "backlog" && command.routeToConcierge)
            throw new Error("这件事尚未开始，请先明确交给管家");
          const message = text(command.text, "消息", 12_000);
          const incomingAttachments = await validateGoalAttachments(this.root, command.attachments);
          const combined = await validateGoalAttachments(this.root, [
            ...(item.attachments ?? []),
            ...incomingAttachments,
          ]);
          if (combined.length) item.attachments = combined;
          if (item.mode === "concierge" || command.routeToConcierge) handBackExternalWait(item);
          if (item.attention?.source === "dispatch") item.attention = null;
          if ((item.mode === "concierge" || command.routeToConcierge) && (
            item.attention?.kind === "follow_up" ||
            hasDueReminder(item)
          )) {
            item.attention = null;
            item.remindAt = undefined;
          }
          if (command.routeToConcierge && item.mode !== "concierge") {
            item.mode = "concierge";
            item.owner = item.herdr?.agent || "待分配负责人";
          }
          if (item.mode === "concierge") {
            item.dispatch = {
              id: newId("handoff"),
              kind: "feedback",
              note: message,
              status: "pending",
              at: nowIso(),
            };
          }
          const at = nowIso(),
            actor = command.actor?.trim() ? text(command.actor, "操作者", 120) : "你";
          if (actor.startsWith("你")) delete item.sceneReply;
          item.activities.push({
            id: newId("act"),
            at,
            actor,
            kind: "message",
            text: message,
            ...(incomingAttachments.length
              ? { attachmentIds: incomingAttachments.map(attachment => attachment.id) }
              : {}),
          });
          item.updatedAt = at;
          return item;
        }
        case "goal.takeover": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.mode === "manual" && item.status !== "backlog") return item;
          const fromBacklog = item.status === "backlog";
          if (fromBacklog && hasDueReminder(item)) {
            item.remindAt = undefined;
            if (item.attention?.kind === "follow_up") item.attention = null;
          }
          item.mode = "manual";
          item.status = "active";
          item.owner = "你";
          item.next = "由你安排；做完即可标记完成。";
          item.waitingFor = undefined;
          if (!fromBacklog) item.remindAt = undefined;
          if (item.attention?.source === "dispatch") item.attention = null;
          delete item.dispatch;
          delete item.sceneVisit;
          delete item.sceneReply;
          delete item.watchdog;
          delete item.live;
          activity(item, "session", "你已接管这个目标，不再向管家发送后续更新。", "你");
          return item;
        }
        case "goal.delegate": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.mode === "concierge" && item.status !== "backlog") return item;
          if (item.attention && item.attention.kind !== "follow_up" && item.attention.source !== "dispatch")
            throw new Error("请先处理当前待决定或介入事项，再交给管家");
          item.mode = "concierge";
          item.status = "active";
          item.owner = "待分配负责人";
          item.next = "管家正在接手目标并安排下一步。";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.attention = null;
          item.dispatch = { id: newId("handoff"), kind: "feedback", status: "pending", at: nowIso() };
          delete item.watchdog;
          activity(item, "session", "已重新交给管家统筹。", "你");
          return item;
        }
        case "goal.restore": {
          const item = goal(command.goalId);
          if (item.status !== "dropped" || item.mode !== "manual" || item.herdr)
            throw new Error("只有已移出且没有执行现场的个人事项可以恢复到待办池");
          Object.assign(item, intakeArrangement("later"));
          item.attention = null;
          delete item.remindAt;
          delete item.waitingFor;
          delete item.dispatch;
          delete item.watchdog;
          delete item.sceneVisit;
          delete item.sceneReply;
          activity(item, "progress", "已恢复到待办池，尚未开始执行。");
          return item;
        }
        case "goal.update": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          for (const field of [
            "title",
            "description",
            "next",
            "owner",
          ] as const)
            if (command.patch[field] !== undefined)
              item[field] = text(
                command.patch[field],
                field,
                field === "description" ? 20_000 : 500,
              );
          if (command.patch.stageId !== undefined) {
            throw new Error("工序已移除；请直接更新目标下一步");
          }
          if (command.patch.waitingFor !== undefined || command.patch.status === "waiting") {
            item.waitingFor = externalWaitTarget(command.patch.waitingFor ?? item.waitingFor, state, item);
          }
          if (command.patch.remindAt !== undefined)
            item.remindAt =
              command.patch.remindAt === null
                ? undefined
                : iso(command.patch.remindAt);
          if (command.patch.remindAt !== undefined && item.attention?.kind === "follow_up")
            item.attention = null;
          if (command.patch.status !== undefined) {
            ongoing(item);
            if (!["active", "waiting"].includes(command.patch.status))
              throw new Error("无效的目标状态");
            item.status = command.patch.status;
            if (item.status === "active") {
              item.waitingFor = undefined;
              item.remindAt = undefined;
            }
          }
          activity(item, "progress", "已更新目标说明与下一步。");
          return item;
        }
        case "goal.dispatch": {
          const item = goal(command.goalId);
          if (command.requestId && item.dispatch?.id !== command.requestId) return item;
          ongoing(item, true);
          if (item.mode !== "concierge")
            throw new Error("这个目标已由你接管");
          if (!["pending", "sent", "failed"].includes(command.status)) throw new Error("无效的派送状态");
          const at = nowIso(), detail = command.detail ? text(command.detail, "派送说明", 2000) : undefined;
          item.mode = "concierge";
          item.dispatch = { ...item.dispatch,
            id: command.status === "pending" && !command.requestId ? newId("handoff") : item.dispatch?.id,
            status: command.status, at, detail };
          if (command.status !== "failed" && item.attention?.source === "dispatch")
            item.attention = null;
          if (command.status === "failed" && !attentionRequest(item)) item.attention = {
            id: newId("attention"),
            kind: "intervention", source: "dispatch", summary: detail || "目标尚未送达管家，请重试。", since: at,
          };
          if (command.status === "sent" && item.attention?.source === "dispatch") item.attention = null;
          activity(item, "session", command.status === "sent" ? "目标已送达管家。" : command.status === "failed" ? `联系管家失败：${detail}` : "正在联系管家。", "系统");
          return item;
        }
        case "goal.resume": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以恢复推进");
          if (!["concierge", "manual"].includes(command.mode)) throw new Error("请选择由谁继续推进");
          const note = text(command.note, "最新结果与下一步", 2000);
          item.status = "active";
          item.mode = command.mode;
          item.next = note;
          item.owner = command.mode === "manual" ? "你" : item.herdr?.agent || "待分配负责人";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.attention = null;
          delete item.watchdog;
          delete item.live;
          if (command.mode === "concierge") item.dispatch = {
            id: newId("handoff"), kind: "resume", note, status: "pending", at: nowIso(),
          };
          else delete item.dispatch;
          activity(item, "resolved", `等待已结束。${note}`, "你");
          return item;
        }
        case "goal.restart": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已完成或已放弃的目标可以重启");
          if (item.mode !== "concierge")
            throw new Error("个人事项请恢复到待办池，不需要重启 Agent");
          const note = text(command.note, "交给管家的重启说明", 12_000);
          item.status = "active";
          item.attention = null;
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.owner = item.ownerResume?.owner || item.herdr?.agent || "待分配负责人";
          item.next = item.ownerResume?.agentSession
            ? "正在恢复原负责人会话，并把你的消息交给管家。"
            : "正在重新启动负责人，并把你的消息交给管家。";
          item.dispatch = {
            id: newId("handoff"),
            kind: "restart",
            note,
            status: "pending",
            at: nowIso(),
          };
          delete item.delivery;
          delete item.risk;
          delete item.reviewRounds;
          delete item.reviewLimit;
          delete item.herdr;
          delete item.live;
          delete item.sceneVisit;
          delete item.sceneReply;
          delete item.watchdog;
          delete item.recovery;
          activity(item, "message", note, "你");
          activity(item, "session", item.next, "系统");
          return item;
        }
        case "goal.followup": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以请求跟进");
          const note = command.note?.trim() ? text(command.note, "跟进说明", 2000) : "请核查等待事项的最新进展，并写回跟进结果。";
          handBackExternalWait(item);
          if (item.mode !== "concierge") item.owner = item.herdr?.agent || "待分配负责人";
          item.mode = "concierge";
          item.dispatch = { id: newId("handoff"), kind: "follow_up", note, status: "pending", at: nowIso() };
          activity(item, "session", `已请求管家跟进：${note}`, "你");
          return item;
        }
        case "goal.progress": {
          const item = goal(command.goalId);
          ongoing(item);
          const actor = command.actor || "管家",
            summary = actor.startsWith("你")
              ? text(command.summary, "实际结果", 12_000)
              : substantiveAgentText(command.summary, "实际结果", 12_000);
          item.status = "active";
          item.remindAt = undefined;
          item.waitingFor = undefined;
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.next) item.next = text(command.next, "下一步", 2000);
          if (command.stageId) {
            throw new Error("工序已移除；请直接写清当前实际结果和下一步");
          }
          if (actor === "你" && item.mode === "concierge")
            item.dispatch = {
              id: newId("handoff"), kind: "feedback", note: summary,
              status: "pending", at: nowIso(),
            };
          activity(item, "progress", summary, actor);
          delete item.recovery;
          return item;
        }
        case "goal.wait": {
          const item = goal(command.goalId);
          ongoing(item);
          const target = externalWaitTarget(command.owner, state, item);
          item.status = "waiting";
          if (item.attention?.kind === "follow_up") item.attention = null;
          item.next = text(command.reason, "等待原因", 2000);
          item.waitingFor = target;
          item.remindAt = command.remindAt ? iso(command.remindAt) : undefined;
          activity(item, "waiting", `等待外部：${target}。${command.reason}${item.remindAt ? `\n跟进时间：${item.remindAt}` : ""}`, command.actor || "管家");
          delete item.recovery;
          delete item.watchdog;
          return item;
        }
        case "goal.decide": {
          const item = goal(command.goalId);
          ongoing(item);
          const question = text(command.question, "问题", 2000);
          const key = normalizeDecisionKey(command.key ? text(command.key, "决定键", 300) : question);
          const known = latestDecision(state, item.projectId, key);
          item.status = "active";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          if (known) {
            if (item.attention?.source === "governance") item.attention = null;
            item.next = command.next
              ? text(command.next, "下一步", 2000)
              : `沿用你此前${outcomeLabel(known.outcome)}的决定：${known.quote}`;
            activity(item, "decision", `决定账本命中：此前已${outcomeLabel(known.outcome)}「${known.quote}」，不再重复询问。`, known.source);
            return item;
          }
          const riskCategory = riskCategoryForText(question);
          item.attention = {
            id: newId("attention"),
            kind: "decision",
            summary: riskCategory ? riskSummary(riskCategory, question) : question,
            since: nowIso(),
            ...(riskCategory ? { source: "governance" as const } : {}),
            decisionKey: riskCategory ? `risk:${riskCategory}:${key}` : key,
          };
          if (command.next) item.next = text(command.next, "下一步", 2000);
          activity(item, "decision", item.attention.summary, command.actor || "管家");
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.risk": {
          const item = goal(command.goalId);
          ongoing(item);
          if (!isHighRiskCategory(command.category))
            throw new Error("无效的高风险动作类型");
          const summary = text(command.summary, "高风险动作", 2000);
          const actionKey = `risk:${command.category}:${normalizeDecisionKey(
            command.actionKey ? text(command.actionKey, "动作键", 300) : summary,
          )}`;
          const at = nowIso(), known = latestDecision(state, item.projectId, actionKey);
          item.risk = { category: command.category, summary, actionKey, at };
          item.status = "active";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          if (known) {
            item.attention = null;
            item.next = `沿用你此前${outcomeLabel(known.outcome)}的决定：${known.quote}`;
            activity(item, "decision", `决定账本命中高风险动作「${summary}」：${outcomeLabel(known.outcome)}。`, known.source);
            return item;
          }
          item.attention = {
            id: newId("attention"),
            kind: "decision",
            summary: riskSummary(command.category, summary),
            since: at,
            source: "governance",
            decisionKey: actionKey,
          };
          item.next = `执行高风险动作前等待你确认：${summary}`;
          activity(item, "decision", item.attention.summary, command.actor || "管家");
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.ship": {
          const item = goal(command.goalId);
          ongoing(item);
          if (!["merge", "deploy"].includes(command.operation))
            throw new Error("无效的上线动作");
          if (typeof command.checksPassed !== "boolean")
            throw new Error("上线前必须提供真实检查结果");
          leaveExternalWait(item);
          const project = state.projects.find(value => value.id === item.projectId);
          if (!project) throw new Error("找不到目标所属项目");
          const policy = projectPolicy(state, item.projectId);
          const actionKey = `ship:${item.projectId}:${command.operation}`;
          if (!command.checksPassed) {
            item.next = `上线检查未通过，先修复 ${command.operation === "merge" ? "合并" : "部署"}前的问题。`;
            activity(item, "ship", `${command.operation} 检查未通过，未执行上线动作。`, command.actor || "管家");
            return { allowed: false, requiresHuman: false, reason: "checks_failed", policy };
          }
          const known = latestDecision(state, item.projectId, actionKey);
          if (known?.outcome === "rejected") {
            item.attention = null;
            item.next = `你此前已拒绝该上线动作：${known.quote}`;
            activity(item, "ship", item.next, known.source);
            return { allowed: false, requiresHuman: false, reason: "rejected", policy, decision: known };
          }
          const requiresHuman = !known && (
            policy.shipPolicy === "external-approval" ||
            (policy.shipPolicy === "auto-merge-manual-deploy" && command.operation === "deploy"));
          if (requiresHuman) {
            item.attention = {
              id: newId("attention"),
              kind: "decision",
              summary: [
                `上线策略 ${policy.shipPolicy} 要求你确认${command.operation === "merge" ? "合并" : "部署"}。`,
                policy.approvers.length ? `审批人：${policy.approvers.join("、")}。` : "",
              ].join(""),
              since: nowIso(),
              source: "governance",
              decisionKey: actionKey,
            };
            item.next = `等待你按上线策略确认${command.operation}。`;
            activity(item, "ship", item.attention.summary, command.actor || "管家");
            return { allowed: false, requiresHuman: true, reason: policy.shipPolicy, policy, decisionKey: actionKey };
          }
          item.attention = null;
          item.next = `${command.operation} 已通过项目上线策略，可继续执行并核实结果。`;
          activity(item, "ship", `${command.operation} 已获上线策略放行。`, command.actor || "管家");
          return {
            allowed: true,
            requiresHuman: false,
            reason: known ? "ledger" : policy.shipPolicy,
            policy,
            ...(known ? { decision: known } : {}),
          };
        }
        case "goal.review": {
          const item = goal(command.goalId),
            delivery = command.delivery;
          ongoing(item, true);
          if (
            !delivery ||
            !Array.isArray(delivery.checks) ||
            delivery.checks.length < 1
          )
            throw new Error("提交验收至少需要一项真实检查记录");
          const checks = delivery.checks.map((check) => ({
            name: text(check.name, "检查名称", 200),
            command: text(check.command, "检查命令或操作", 1000),
            result:
              check.result === "passed"
                ? ("passed" as const)
                : check.result === "failed"
                  ? ("failed" as const)
                  : (() => {
                      throw new Error("无效的检查结果");
                    })(),
            ...(check.note ? { note: text(check.note, "检查说明", 2000) } : {}),
          }));
          if (checks.some((check) => check.result !== "passed"))
            throw new Error("仍有检查未通过，请修复后再提交验收");
          const at = nowIso();
          leaveExternalWait(item);
          delete item.waitingFor;
          delete item.remindAt;
          const reviewRounds = item.reviewRounds ?? 0,
            reviewLimit = item.reviewLimit ?? 3;
          if (reviewRounds >= reviewLimit) {
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: `审查已达到 ${reviewLimit} 轮上限，需要你决定是否增加一轮。`,
              since: at,
              source: "governance",
              decisionKey: `review:${item.id}:round-${reviewLimit + 1}`,
            };
            item.next = "审查轮次达到上限，新的提交已被拦截并升级。";
            activity(item, "decision", item.attention.summary, "系统");
            return item;
          }
          item.delivery = {
            summary: substantiveAgentText(delivery.summary, "成果摘要", 12_000),
            ...(delivery.location
              ? { location: text(delivery.location, "交付位置", 2000) }
              : {}),
            ...(delivery.url ? { url: text(delivery.url, "链接", 2000) } : {}),
            checks,
            submittedAt: at,
            submittedBy: command.actor || "管家",
          };
          item.status = "review";
          item.reviewRounds = reviewRounds + 1;
          item.reviewLimit = reviewLimit;
          item.attention = {
            id: newId("attention"),
            kind: "review",
            summary: "成果已提交，等待你的验收。",
            since: at,
          };
          item.next = "查看实际成果和检查结果，选择验收通过或退回修改。";
          activity(
            item,
            "delivery",
            item.delivery.summary,
            command.actor || "管家",
          );
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.accept": {
          const item = goal(command.goalId);
          if (item.status !== "review" || !item.delivery)
            throw new Error("只有提交验收的目标才能通过验收");
          const actor = command.actor || "你";
          const note = command.note?.trim()
            ? text(command.note, "验收依据", 4000)
            : "成果验收通过。";
          if (actor !== "你" && !command.note?.trim())
            throw new Error("管家结束目标时必须记录用户明确确认完成的原话");
          item.status = "completed";
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = "这件事已完成，不需要继续关注。";
          activity(
            item,
            "accepted",
            note,
            actor,
          );
          return item;
        }
        case "goal.complete": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          const actor = command.actor || "你";
          const note = text(command.note, "用户确认完成的原话", 4000);
          item.status = "completed";
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = `已结束：${note}`;
          activity(item, "accepted", note, actor);
          return item;
        }
        case "goal.rework": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有待验收目标可以退回");
          item.status = "active";
          item.attention = null;
          item.next = text(command.note, "修改意见", 4000);
          activity(item, "rework", command.note, command.actor || "你");
          return item;
        }
        case "goal.drop": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          const actor = command.actor || "你";
          if (actor !== "你" && !command.note?.trim())
            throw new Error("管家放弃目标时必须记录用户明确放弃的原话");
          item.status = "dropped";
          item.attention = null;
          item.remindAt = undefined;
          item.next = text(command.note || "这件事已放弃。", "原因", 4000);
          activity(item, "dropped", item.next, actor);
          return item;
        }
        case "goal.resolve": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          if (item.attention?.kind === "review")
            throw new Error("成果请使用验收通过或退回修改");
          if (!item.attention && !hasDueReminder(item))
            throw new Error("当前没有需要解决的注意力事项");
          const at = nowIso(), note = command.note?.trim() ? text(command.note, "决定", 4000) : "";
          const decisionAttention = item.attention?.kind === "decision" ? item.attention : undefined;
          const isDecision = Boolean(decisionAttention);
          if (isDecision) {
            if (!note) throw new Error("决定账本需要记录你的原话");
            const outcome = command.outcome ?? "approved";
            if (!["approved", "rejected"].includes(outcome))
              throw new Error("无效的决定结果");
            state.decisions.push({
              id: newId("decision"),
              projectId: item.projectId,
              actionKey: text(decisionAttention!.decisionKey || decisionAttention!.summary, "决定键", 4000),
              outcome,
              quote: note,
              source: command.sceneReplyId || command.source === "scene"
                ? "Herdr 负责人现场"
                : command.source === "herdr"
                ? "Herdr 注意力面板"
                : command.source === "cli" ? "Crewvane CLI" : "Crewvane 桌面",
              goalId: item.id,
              decidedAt: at,
            });
            item.next = `你已${outcome === "approved" ? "批准" : "拒绝"}：${note}`;
            item.status = "active";
            item.waitingFor = undefined;
            item.remindAt = undefined;
            if (item.mode === "concierge")
              item.dispatch = {
                id: newId("handoff"),
                kind: "feedback",
                note: item.next,
                status: "pending",
                at,
              };
          }
          if (item.attention?.kind === "intervention" &&
            item.attention.source === "governance" &&
            item.attention.summary.includes("审查已达到")) {
            item.reviewLimit = (item.reviewLimit ?? 3) + 1;
          }
          item.attention = null;
          item.remindAt = undefined;
          if (command.sceneReplyId && item.mode === "concierge" && !isDecision)
            item.dispatch = {
              id: newId("handoff"), kind: "feedback", note, status: "pending", at,
            };
          if (note && !isDecision) item.next = note;
          if (note) activity(item, "resolved", note, command.actor || "你");
          else stamp(item);
          return item;
        }
        case "goal.remind": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          item.remindAt = iso(command.at);
          if (item.attention?.kind === "follow_up") item.attention = null;
          if (command.note) item.next = text(command.note, "提醒说明", 2000);
          activity(
            item,
            "reminder",
            command.note || `将在 ${item.remindAt} 提醒。`,
          );
          return item;
        }
        case "session.set": {
          const reference = command.reference;
          if (
            typeof reference?.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(reference.session)
          )
            throw new Error("无效的 Herdr Session");
          if (reference.transport !== undefined && reference.transport !== "pane")
            throw new Error("无效的现场通信方式");
          if (reference.transport === "pane" &&
            (!reference.paneId || !Number.isSafeInteger(reference.processId) || reference.processId! <= 0))
            throw new Error("自定义 CLI 现场需要真实 Pane 与前台进程 ID");
          if (command.goalId) {
            const item = goal(command.goalId);
            if (item.status === "backlog")
              throw new Error("暂存事项不能关联执行现场，请先交给管家");
            const sameSite = (other: typeof reference) => other.session === reference.session &&
              (!!reference.paneId && reference.paneId === other.paneId ||
               !!reference.tabId && reference.tabId === other.tabId ||
               !!reference.agent && reference.agent === other.agent);
            if (reference.agent === "concierge" || sameSite(state.concierge))
              throw new Error("目标需要独立负责人，不能把全局管家登记为执行现场");
            if (state.goals.some(other => other.id !== item.id &&
              !["completed","dropped"].includes(other.status) && other.herdr && sameSite(other.herdr)))
              throw new Error("该现场属于其他目标，请为当前目标创建独立负责人 Tab");
            item.herdr = structuredClone(reference);
            delete item.sceneVisit;
            delete item.live;
            if (item.mode === "concierge" && item.status === "active")
              item.owner = reference.agent || "独立负责人";
            activity(item, "session", "已关联 Herdr 现场。", "系统");
            return item;
          }
          state.concierge = {
            ...state.concierge,
            ...structuredClone(reference),
          };
          delete state.concierge.live;
          return state.concierge;
        }
        case "session.release": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已完成或已放弃的目标可以释放负责人现场");
          if (!item.herdr) return item;
          delete item.herdr;
          delete item.live;
          activity(item, "session", "目标已结束，负责人现场已关闭。", "系统");
          return item;
        }
        case "session.preserve": {
          const item = goal(command.goalId);
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已结束的目标可以保存负责人恢复信息");
          if (!item.herdr)
            throw new Error("当前目标没有可保存的负责人现场");
          item.ownerResume = preservedOwnerResume(command.resume);
          stamp(item);
          return item;
        }
        case "concierge.status": {
          if (!["ready", "error", "not_ready"].includes(command.status))
            throw new Error("无效的管家状态");
          if (command.live &&
            !["working", "idle", "done", "blocked", "unknown"].includes(command.live.state))
            throw new Error("无效的 Herdr 状态");
          const reference = command.reference;
          if (reference?.processId !== undefined &&
            (!Number.isSafeInteger(reference.processId) || reference.processId <= 0))
            throw new Error("无效的管家进程 ID");
          const concierge: WorkspaceState["concierge"] = {
            session: reference?.session ?? "crewvane",
            ...(reference?.workspaceId === undefined ? {} : { workspaceId: reference.workspaceId }),
            ...(reference?.tabId === undefined ? {} : { tabId: reference.tabId }),
            ...(reference?.paneId === undefined ? {} : { paneId: reference.paneId }),
            ...(reference?.agent === undefined ? {} : { agent: reference.agent }),
            ...(reference?.transport === undefined ? {} : { transport: reference.transport }),
            ...(reference?.processId === undefined ? {} : { processId: reference.processId }),
            ...(reference?.launchPolicy === undefined ? {} : { launchPolicy: reference.launchPolicy }),
            status: command.status,
          };
          if (command.detail)
            concierge.detail = text(command.detail, "状态说明", 1000);
          if (command.live)
            concierge.live = {
              state: command.live.state,
              checkedAt: iso(command.live.checkedAt),
              ...(command.live.reachable === undefined
                ? {}
                : { reachable: Boolean(command.live.reachable) }),
            };
          state.concierge = concierge;
          return state.concierge;
        }
        case "live.sync": {
          for (const [goalId, presence] of Object.entries(command.presences)) {
            const item = goal(goalId);
            if (
              !["working", "idle", "done", "blocked", "unknown"].includes(
                presence.state,
              )
            )
              throw new Error("无效的 Herdr 状态");
            item.live = {
              state: presence.state,
              checkedAt: iso(presence.checkedAt),
              ...(presence.reachable === undefined ? {} : { reachable: Boolean(presence.reachable) }),
            };
            delete item.recovery;
            if (presence.state === "working") delete item.watchdog;
            observeSceneWork(item, item.live);
            if (
              presence.state !== "blocked" &&
              item.attention?.source === "live"
            )
              item.attention = null;
          }
          return true;
        }
        case "live.event": {
          const target = command.target;
          const idPattern = /^[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_-]{1,64})?$/;
          const targets = [
            ["paneId", target?.paneId],
            ["tabId", target?.tabId],
            ["workspaceId", target?.workspaceId],
          ] as const;
          if (!targets.some(([, value]) => typeof value === "string" && value.length > 0))
            throw new Error("Herdr 插件事件缺少现场身份");
          for (const [name, value] of targets) {
            if (value !== undefined && (typeof value !== "string" || !idPattern.test(value)))
              throw new Error(`无效的 Herdr ${name}`);
          }
          for (const [name, value] of Object.entries(command.reference ?? {})) {
            if (name === "agent" && value !== undefined &&
              (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value)))
              throw new Error("无效的 Herdr Agent 名称");
            if (name !== "agent" && value !== undefined &&
              (typeof value !== "string" || !idPattern.test(value)))
              throw new Error(`无效的 Herdr ${name}`);
          }
          if (!["working", "idle", "done", "blocked", "unknown"].includes(command.presence.state))
            throw new Error("无效的 Herdr 状态");
          let matched = 0;
          for (const item of state.goals) {
            const reference = item.herdr;
            if (["completed", "dropped"].includes(item.status) || !reference ||
              (command.reference?.agent !== undefined &&
                reference.agent !== command.reference.agent) ||
              (target.paneId !== undefined && reference.paneId !== target.paneId) ||
              (target.tabId !== undefined && reference.tabId !== target.tabId) ||
              (target.workspaceId !== undefined && reference.workspaceId !== target.workspaceId)) continue;
            item.live = {
              state: command.presence.state,
              checkedAt: iso(command.presence.checkedAt),
              ...(command.presence.reachable === undefined ? {} : { reachable: Boolean(command.presence.reachable) }),
            };
            delete item.recovery;
            if (command.presence.state === "working") delete item.watchdog;
            observeSceneWork(item, item.live);
            if (command.reference)
              item.herdr = { ...reference, ...structuredClone(command.reference) };
            if (command.presence.state !== "blocked" && item.attention?.source === "live")
              item.attention = null;
            matched += 1;
          }
          const concierge = state.concierge;
          if (
            (
              command.presence.reachable === false ||
              command.reference?.agent === concierge.agent
            ) &&
            (target.paneId === undefined || concierge.paneId === target.paneId) &&
            (target.tabId === undefined || concierge.tabId === target.tabId) &&
            (target.workspaceId === undefined || concierge.workspaceId === target.workspaceId)
          ) {
            if (command.reference) {
              state.concierge = {
                ...concierge,
                ...structuredClone(command.reference),
              };
            }
            const current = state.concierge;
            current.live = {
              state: command.presence.state,
              checkedAt: iso(command.presence.checkedAt),
              ...(command.presence.reachable === undefined
                ? {}
                : { reachable: Boolean(command.presence.reachable) }),
            };
            if (command.presence.reachable === false) {
              current.status = "not_ready";
              current.detail = "管家现场已关闭或不可达，请恢复管家。";
            } else {
              current.status = "ready";
              delete current.detail;
            }
            matched += 1;
          }
          return { matched };
        }
        case "watchdog.inspect":
          return inspectWatchdog(state.goals, iso(command.at));
        case "watchdog.report": {
          if (!["contacted", "failed"].includes(command.outcome)) throw new Error("无效的巡检结果");
          reportWatchdog(goal(command.goalId), iso(command.at), iso(command.basis), command.outcome,
            command.detail ? text(command.detail, "巡检说明", 1000) : undefined);
          return true;
        }
        case "notification.sent": {
          const item = goal(command.goalId),
            kind = command.kind;
          if (attentionRequest(item)?.kind !== kind) return true;
          if (item.attention?.kind === kind)
            item.attention.notifiedAt = iso(command.at);
          else if (kind === "follow_up")
            item.attention = {
              id: attentionRequest(item)?.id ?? newId("attention"),
              kind,
              summary: item.next,
              since: iso(command.at),
              notifiedAt: iso(command.at),
            };
          return true;
        }
        default:
          throw new Error("不支持的命令");
      }
    });
  }
}
