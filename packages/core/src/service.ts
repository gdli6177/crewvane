import { WorkspaceStore, newId } from "./store.js";
import {
  cleanupOrphanAttachmentFiles,
  removeAttachmentFiles,
  validateGoalAttachments,
} from "./attachments.js";
import type {
  AcceptanceCriterion,
  AgentAttempt,
  AgentRuntimeEventV1,
  AgentRuntimeEventType,
  AgentRuntimeText,
  BotBinding,
  BotOperation,
  CrewvaneCommand,
  Delivery,
  DeliveryCandidate,
  Evidence,
  Goal,
  GoalAttachment,
  GoalBrief,
  GoalSkillBinding,
  ReleaseTarget,
  Verification,
  VerificationCriterion,
  WorkspaceState,
  WorkflowStep,
} from "./types.js";
import { SkillRegistry } from "./skill-registry.js";
import { sameScene, validatedScene, type ManagedSessionContext } from "./session-types.js";
import { agentReceiptMarker, isAgentRuntimeAdapter } from "./agent-runtime.js";
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
import {
  attentionRequest,
  defaultProjectAutonomy,
  defaultProjectPolicy,
  defaultWorkspaceAutonomy,
  goalIsAutonomous,
  pendingSceneReply,
} from "./model.js";
import { observeSceneWork } from "./scene.js";
import { inspectWatchdog, reportWatchdog } from "./watchdog.js";
import { hasDueReminder, intakeArrangement } from "./task-pool.js";
import { externalWaitTarget, leaveExternalWait } from "./waiting.js";
import {
  acceptanceMandateRevision,
  autoAcceptanceGate,
  briefProblems,
  claimContinuation,
  continuationEligible,
  failureFingerprint,
  finishContinuation,
  isAcceptanceMode,
  isEvidenceKind,
  isReleaseOnMerge,
  parseGoalBrief,
  releaseApprovalValid,
  releaseMergeGate,
  reportContinuation,
  resolveAcceptance,
  sameCandidate,
  scheduleContinuation,
  workspaceAutonomy,
} from "./autonomy.js";
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
function humanOnly(actor: string | undefined, message: string) {
  if (actor !== "你") throw new Error(message);
}
function deliveryCandidate(value: unknown): DeliveryCandidate | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("候选版本无效");
  const candidate = value as Partial<DeliveryCandidate>;
  const revision = text(candidate.revision, "候选修订", 240);
  if (candidate.digest !== undefined && !/^[a-f0-9]{64}$/i.test(candidate.digest))
    throw new Error("候选摘要必须是 SHA-256");
  if (candidate.version !== undefined) text(candidate.version, "候选版本", 120);
  return {
    revision,
    ...(candidate.digest ? { digest: candidate.digest.toLowerCase() } : {}),
    ...(candidate.version ? { version: candidate.version.trim() } : {}),
  };
}
function writableGoalKind(value: unknown): "delivery" | "discovery" {
  if (value !== "delivery" && value !== "discovery")
    throw new Error("目标类型只能是 delivery 或 discovery；发布目标必须通过 release create 建立");
  return value;
}
function rememberBrief(item: Goal, brief: GoalBrief) {
  if (item.brief)
    item.briefHistory = [...(item.briefHistory ?? []), item.brief].slice(-20);
  item.brief = brief;
}
function finishWaitContinuation(
  item: Goal,
  at: string,
  status: "settled" | "cancelled" = "cancelled",
) {
  if (item.autonomy?.continuation?.trigger === "wait-due")
    finishContinuation(item, at, status);
}
function evidenceItems(value: unknown, at: string, checks: Delivery["checks"]): Evidence[] {
  if (value !== undefined && !Array.isArray(value))
    throw new Error("证据列表无效");
  if (Array.isArray(value) && value.length > 100)
    throw new Error("一次最多提交 100 条证据");
  if (value !== undefined) {
    const ids = new Set<string>();
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error(`第 ${index + 1} 条证据无效`);
      const evidence = item as Partial<Evidence>,
        evidenceId = id(evidence.id),
        kind = evidence.kind,
        result = evidence.result;
      if (ids.has(evidenceId)) throw new Error("证据 ID 不能重复");
      ids.add(evidenceId);
      if (!isEvidenceKind(kind) || !["observed", "passed", "failed"].includes(String(result)))
        throw new Error(`证据 ${evidenceId} 的类型或结果无效`);
      if (evidence.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(evidence.sha256))
        throw new Error(`证据 ${evidenceId} 的 SHA-256 无效`);
      const observedAt = evidence.observedAt ? iso(evidence.observedAt) : at;
      return {
        id: evidenceId,
        kind,
        label: text(evidence.label, "证据名称", 240),
        result: result as Evidence["result"],
        observedAt,
        ...(evidence.command ? { command: text(evidence.command, "证据命令", 2_000) } : {}),
        ...(evidence.location ? { location: text(evidence.location, "证据位置", 2_000) } : {}),
        ...(evidence.sourceRevision
          ? { sourceRevision: text(evidence.sourceRevision, "证据修订", 240) }
          : {}),
        ...(evidence.sha256 ? { sha256: evidence.sha256.toLowerCase() } : {}),
        ...(evidence.note ? { note: text(evidence.note, "证据说明", 4_000) } : {}),
      };
    });
  }
  return checks.map((check, index) => ({
    id: `evidence_check_${index + 1}`,
    kind: "command" as const,
    label: check.name,
    result: check.result === "passed" ? "passed" as const : "failed" as const,
    observedAt: at,
    command: check.command,
    ...(check.note ? { note: check.note } : {}),
  }));
}
function verificationItems(
  value: VerificationCriterion[],
  delivery: Delivery,
  brief: GoalBrief,
): VerificationCriterion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50)
    throw new Error("独立复核至少需要一个完成条件结论");
  const criterionIds = new Set(brief.criteria.map(criterion => criterion.id)),
    evidenceIds = new Set((delivery.evidence ?? []).map(evidence => evidence.id)),
    seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("复核条件结论无效");
    const criterionId = id(item.criterionId);
    if (!criterionIds.has(criterionId) || seen.has(criterionId))
      throw new Error(`复核包含未知或重复的完成条件：${criterionId}`);
    seen.add(criterionId);
    if (!["passed", "failed"].includes(item.result))
      throw new Error("复核结果无效");
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.length < 1)
      throw new Error(`完成条件 ${criterionId} 必须引用证据`);
    for (const evidenceId of item.evidenceIds)
      if (!evidenceIds.has(evidenceId))
        throw new Error(`复核引用了交付中不存在的证据：${evidenceId}`);
    return {
      criterionId,
      result: item.result,
      evidenceIds: [...new Set(item.evidenceIds)],
      ...(item.note ? { note: text(item.note, "复核说明", 4_000) } : {}),
    };
  });
}
function ensureGoalAutonomy(item: Goal, defaultLimit = 3) {
  item.autonomy ??= {
    attempts: {
      used: 0,
      limit: defaultLimit,
    },
  };
  return item.autonomy;
}
function completionRecord(
  state: WorkspaceState,
  item: Goal,
  kind: "automatic" | "human",
  by: string,
  at: string,
  note?: string,
  verificationId?: string,
) {
  const record = {
    id: newId("acceptance"),
    kind,
    at,
    by,
    mandateRevision: acceptanceMandateRevision(state, item),
    ...(verificationId ? { verificationId } : {}),
    ...(note ? { note } : {}),
  };
  ensureGoalAutonomy(item).acceptance = record;
  return record;
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
function runtimeText(value: unknown, label: string): AgentRuntimeText | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`无效的${label}`);
  const candidate = value as Partial<AgentRuntimeText>;
  if (typeof candidate.text !== "string" || Array.from(candidate.text).length > 12_000 ||
    typeof candidate.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(candidate.sha256) ||
    typeof candidate.truncated !== "boolean")
    throw new Error(`无效的${label}`);
  return {
    text: candidate.text,
    sha256: candidate.sha256,
    truncated: candidate.truncated,
  };
}
const semanticActivityKinds = new Set<Goal["activities"][number]["kind"]>([
  "progress", "waiting", "decision", "delivery", "accepted", "rework",
  "dropped", "resolved", "ship",
]);
const runtimeEventTypes = new Set<AgentRuntimeEventType>([
  "session.started", "turn.started", "turn.settled", "turn.interrupted",
  "agent.blocked", "agent.response", "session.ended",
]);
function validatedAttempt(value: AgentAttempt): AgentAttempt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("无效的 Agent attempt");
  const goalId = id(value.goalId),
    attemptId = id(value.attemptId),
    startedAt = iso(value.startedAt);
  if (value.adapter !== "custom" && !isAgentRuntimeAdapter(value.adapter))
    throw new Error("不支持的 Agent Runtime Adapter");
  const agent = text(value.agent, "Agent 类型", 64);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(agent))
    throw new Error("Agent 类型格式无效");
  if (value.currentTurnId !== undefined &&
    (typeof value.currentTurnId !== "string" || value.currentTurnId.length > 240))
    throw new Error("Agent turn ID 无效");
  if (value.scene !== undefined &&
    (!value.scene || typeof value.scene !== "object" || Array.isArray(value.scene)))
    throw new Error("Agent attempt 现场无效");
  return {
    goalId,
    attemptId,
    agent,
    adapter: value.adapter,
    startedAt,
    ...(value.currentTurnId ? { currentTurnId: value.currentTurnId } : {}),
    ...(value.scene ? { scene: structuredClone(value.scene) } : {}),
  };
}
function validatedRuntimeEvent(value: AgentRuntimeEventV1): AgentRuntimeEventV1 {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    value.version !== "v1")
    throw new Error("Agent Runtime 事件版本无效");
  const goalId = id(value.goalId),
    attemptId = id(value.attemptId),
    eventId = text(value.eventId, "Agent 事件 ID", 160),
    at = iso(value.at),
    agent = text(value.agent, "Agent 类型", 64);
  if (!isAgentRuntimeAdapter(value.adapter) ||
    !runtimeEventTypes.has(value.type) ||
    value.source !== "hook" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1)
    throw new Error("Agent Runtime 事件字段无效");
  if (value.turnId !== undefined &&
    (typeof value.turnId !== "string" || !value.turnId.trim() ||
      value.turnId.length > 240))
    throw new Error("Agent turn ID 无效");
  return {
    version: "v1",
    eventId,
    sequence: value.sequence,
    at,
    source: "hook",
    agent,
    adapter: value.adapter,
    goalId,
    attemptId,
    type: value.type,
    ...(value.turnId ? { turnId: value.turnId.trim() } : {}),
    ...(value.content === undefined
      ? {}
      : { content: runtimeText(value.content, "Agent 回复") }),
    ...(value.notificationType === undefined
      ? {}
      : { notificationType: text(value.notificationType, "通知类型", 300) }),
  };
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
  constructor(readonly root: string, private readonly managedContext?: ManagedSessionContext) {
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
        item.revision = (item.revision ?? 0) + 1;
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
          item.revision = (item.revision ?? 0) + 1;
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
  private async executeBotRequest(
    command: Extract<CrewvaneCommand, { type: "bot.request" }>,
  ) {
    if (command.schema !== "crewvane.bot.v1")
      throw new Error("Bot 协议版本不受支持");
    const botId = id(command.botId),
      requestId = text(command.requestId, "Bot 请求 ID", 200),
      operation = command.operation;
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId))
      throw new Error("Bot 请求 ID 格式无效");
    const reservation = await this.store.update("bot.request.reserve", state => {
      const binding = state.bots?.find(item => item.id === botId);
      if (!binding || binding.status !== "active")
        throw new Error("Bot 绑定不存在或已撤销");
      if (Date.parse(binding.expiresAt) <= Date.now())
        throw new Error("Bot 绑定已过期");
      if (!binding.operations.includes(operation))
        throw new Error("Bot 没有该操作的权限");
      const existing = state.botRequests?.find(receipt =>
        receipt.botId === botId && receipt.requestId === requestId);
      if (existing?.status === "completed") {
        const current = existing.goalId
          ? state.goals.find(goal => goal.id === existing.goalId)
          : undefined;
        return {
          duplicate: true as const,
          receipt: existing,
          ...(current ? { goal: current } : {}),
        };
      }
      if (existing)
        throw new Error(`Bot 请求此前未确认（${existing.status}），请先读取目标再决定是否重试`);
      state.botRequests ??= [];
      state.botRequests.push({
        botId,
        requestId,
        operation,
        at: nowIso(),
        status: "pending",
      });
      state.botRequests = state.botRequests.slice(-2_000);
      return { duplicate: false as const };
    });
    if (reservation.duplicate) {
      return {
        schema: "crewvane.bot.v1",
        requestId,
        operation,
        duplicate: true,
        receipt: reservation.receipt,
        ...(reservation.goal ? { goal: reservation.goal } : {}),
      };
    }
    try {
      const payload = command.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("Bot 请求载荷必须是对象");
      const binding = (await this.store.read()).bots?.find(item => item.id === botId);
      if (!binding || binding.status !== "active")
        throw new Error("Bot 绑定已撤销");
      const data = payload as Record<string, unknown>;
      let result: unknown,
        goalId: string | undefined;
      if (operation === "goal.submit") {
        const textValue = text(data.text, "目标说明", 20_000),
          projectId = data.projectId === undefined ? "personal" : id(data.projectId);
        if (!binding.projectIds.includes(projectId))
          throw new Error("Bot 不能向未绑定项目提交目标");
        const created = await this.execute({
          type: "goal.intake",
          text: textValue,
          projectId,
          handling: "concierge",
        }) as Goal;
        result = created;
        goalId = created.id;
      } else {
        goalId = id(data.goalId);
        const state = await this.store.read(),
          target = state.goals.find(goal => goal.id === goalId);
        if (!target) throw new Error("找不到目标");
        if (!binding.projectIds.includes(target.projectId))
          throw new Error("Bot 不能访问未绑定项目的目标");
        if (operation === "goal.read") result = target;
        else if (operation === "goal.message")
          result = await this.execute({
            type: "goal.message",
            goalId,
            text: text(data.text, "消息", 12_000),
            actor: `Bot · ${binding.name}`,
          });
        else if (operation === "goal.checkpoint")
          result = await this.execute({
            type: "goal.checkpoint",
            goalId,
            summary: text(data.summary, "本轮进展", 12_000),
            next: text(data.next, "下一动作", 2_000),
            ...(data.dueAt ? { dueAt: iso(data.dueAt) } : {}),
            actor: `Bot · ${binding.name}`,
          });
        else if (operation === "goal.boundary")
          result = await this.execute({
            type: "goal.boundary",
            goalId,
            change: data.change as Extract<
              CrewvaneCommand,
              { type: "goal.boundary" }
            >["change"],
            actor: `Bot · ${binding.name}`,
          });
        else if (operation === "delivery.submit") {
          const delivery = data.delivery;
          if (!delivery || typeof delivery !== "object" || Array.isArray(delivery))
            throw new Error("Bot 交付内容无效");
          result = await this.execute({
            type: "goal.review",
            goalId,
            delivery: delivery as Extract<
              CrewvaneCommand,
              { type: "goal.review" }
            >["delivery"],
            actor: `Bot · ${binding.name}`,
          });
        } else throw new Error("不支持的 Bot 操作");
      }
      const receipt = await this.store.update("bot.request.complete", state => {
        const current = state.botRequests?.find(item =>
          item.botId === botId && item.requestId === requestId);
        if (!current) throw new Error("Bot 请求回执丢失");
        current.status = "completed";
        current.goalId = goalId;
        return current;
      });
      return {
        schema: "crewvane.bot.v1",
        requestId,
        operation,
        duplicate: false,
        receipt,
        result,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.store.update("bot.request.failed", state => {
        const current = state.botRequests?.find(item =>
          item.botId === botId && item.requestId === requestId);
        if (!current) return;
        current.status = "failed";
        current.detail = detail.slice(0, 1_000);
      }).catch(() => {});
      throw error;
    }
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
    if (command.type === "bot.request") return this.executeBotRequest(command);
    return this.store.update(command.type, async (state) => {
      const managed = this.managedContext ?? command.managedContext;
      if (managed && state.backendBinding) {
        const binding = state.backendBinding;
        if (binding.status === "revoked" ||
          managed.installationId !== binding.installationId ||
          managed.backend !== binding.backend || managed.epoch !== binding.epoch ||
          managed.scopeGeneration !== binding.scopeGeneration)
          throw new Error("stale_backend_epoch: 当前受管身份已撤销，请重新进入现场。");
        if (managed.role !== "concierge") {
          if (!managed.goalId || ("goalId" in command && command.goalId !== managed.goalId))
            throw new Error("scene_identity_mismatch: 只能写回自己的目标。");
          const current = state.goals.find(item => item.id === managed.goalId);
          if (managed.role === "owner" &&
            managed.attemptId !== current?.agentRuntime?.attempt.attemptId)
            throw new Error("stale_backend_epoch: 负责人 attempt 已更新。");
        }
        if (command.type.startsWith("backend."))
          throw new Error("后端交接只能由桌面控制服务执行。");
      }
      const goal = (goalId: string) => {
        const found = state.goals.find((item) => item.id === id(goalId));
        if (!found) throw new Error("找不到目标");
        return found;
      };
      const stamp = (item: Goal) => {
        item.revision = (item.revision ?? 0) + 1;
        item.updatedAt = nowIso();
      };
      const isOwnerSemanticWrite = (actor: string) => {
        // The concierge can record reconciliation notes with normal semantic
        // activity kinds, but those notes do not satisfy the owner's write-back
        // protocol. In particular they must not clear a settled/protocol-missing
        // patrol, otherwise each probe starts another review loop.
        if (managed?.role === "concierge" || actor === "concierge" || actor === "管家")
          return false;
        return actor !== "系统";
      };
      const activity = (
        item: Goal,
        kind: Goal["activities"][number]["kind"],
        body: string,
        actor = "你",
      ) => {
        // Any structured non-system write proves that the Agent received the
        // prompt, even when Herdr's immediate lifecycle probe timed out.
        // Promote a stale delivery receipt before recording the real activity
        // so later decisions and progress are not hidden behind "unconfirmed".
        if (item.dispatch?.status === "unconfirmed" && actor !== "系统") {
          item.dispatch.status = "sent";
          delete item.dispatch.detail;
        }
        if (semanticActivityKinds.has(kind) && isOwnerSemanticWrite(actor) &&
          item.agentRuntime &&
          !["completed", "dropped"].includes(item.status)) {
          const now = nowIso();
          item.agentRuntime.lastSemanticWriteAt = now;
          if (item.agentRuntime.currentTurnId)
            item.agentRuntime.lastSemanticWriteTurnId = item.agentRuntime.currentTurnId;
          if (item.agentRuntime.receipt &&
            (item.agentRuntime.receipt.turnId === item.agentRuntime.currentTurnId ||
              item.agentRuntime.receipt.reminderTurnId === item.agentRuntime.currentTurnId))
            item.agentRuntime.receipt.status = "written";
          if (["settled", "protocol_missing"].includes(item.watchdog?.reason ?? ""))
            delete item.watchdog;
        }
        item.activities.push({
          id: newId("act"),
          at: nowIso(),
          actor,
          kind,
          text: text(body, "记录", 12_000),
        });
        stamp(item);
      };
      const cancelAgentReceipt = (item: Goal) => {
        const receipt = item.agentRuntime?.receipt;
        if (receipt && ["waiting", "reminding", "reminded", "protocol_missing"].includes(receipt.status))
          receipt.status = "cancelled";
        if (["settled", "protocol_missing"].includes(item.watchdog?.reason ?? ""))
          delete item.watchdog;
      };
      const cancelSceneReconciliation = (item: Goal) => {
        if (!item.sceneVisit) return false;
        delete item.sceneVisit;
        return true;
      };
      const handBackExternalWait = (item: Goal) => {
        if (item.status !== "waiting") return;
        finishWaitContinuation(item, nowIso());
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
        case "backend.register": {
          if (state.backendBinding) {
            if (state.backendBinding.installationId !== command.binding.installationId ||
              state.backendEpoch !== command.binding.epoch ||
              state.backendBinding.backend !== command.binding.backend)
              throw new Error("stale_backend_epoch: 工作区仍有未完成的后端交接。");
            return state.backendBinding;
          }
          if (state.backendEpoch !== command.binding.epoch &&
            (state.goals.some(item => item.scene || item.herdr || item.legacyScene) ||
              state.concierge.scene || state.concierge.legacyScene?.reference.paneId))
            throw new Error("stale_backend_epoch: 工作区后端代次不一致。");
          state.backendEpoch = command.binding.epoch;
          state.backendBinding = structuredClone(command.binding);
          return state.backendBinding;
        }
        case "scene.prepare": {
          const intent = command.intent;
          if (!intent || !intent.requestId || !intent.bindingId || !intent.attemptId ||
            intent.backendEpoch !== state.backendEpoch || !["owner", "concierge", "verifier"].includes(intent.role))
            throw new Error("stale_backend_epoch: 启动意图与当前后端不匹配。");
          if (!command.goalId) {
            if (state.concierge.launch?.status === "rejected")
              delete state.concierge.launch;
            if (state.concierge.scene || state.concierge.launch) throw new Error("launch_unconfirmed: 管家已有现场或启动意图，请核对原请求。");
            state.concierge.launch = structuredClone(intent);
          } else {
            const item = goal(command.goalId);
            if (item.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(item.status))
              throw new Error("该事项不能启动 Agent。");
            if (intent.role === "verifier") {
              const autonomy = ensureGoalAutonomy(item);
              if (autonomy.verificationLaunch?.status === "rejected")
                delete autonomy.verificationLaunch;
              if (autonomy.verificationSite?.scene || autonomy.verificationLaunch)
                throw new Error("launch_unconfirmed: 已有独立复核现场或启动意图。");
              autonomy.verificationLaunch = structuredClone(intent);
            } else {
              if (item.sceneLaunch?.status === "rejected") delete item.sceneLaunch;
              if (item.scene || item.sceneLaunch) throw new Error("launch_unconfirmed: 该目标已有现场或启动意图，请核对原请求。");
              item.sceneLaunch = structuredClone(intent);
            }
          }
          return intent;
        }
        case "scene.launch.result": {
          const intent = command.goalId
            ? command.role === "verifier" ? goal(command.goalId).autonomy?.verificationLaunch : goal(command.goalId).sceneLaunch
            : state.concierge.launch;
          if (!intent || intent.requestId !== command.requestId)
            throw new Error("launch_unconfirmed: 原启动意图已经变化。");
          intent.status = command.status;
          if (command.detail) intent.detail = text(command.detail, "启动说明", 1000);
          else delete intent.detail;
          return intent;
        }
        case "scene.concierge.status": {
          if (!["ready", "error", "not_ready"].includes(command.status)) throw new Error("无效的管家状态。");
          if (command.initializedAttemptId) {
            if (state.concierge.scene?.attemptId !== command.initializedAttemptId)
              throw new Error("scene_identity_mismatch: 管家初始化对应的现场已经改变。");
            state.concierge.initializedAttemptId = command.initializedAttemptId;
          }
          state.concierge.status = command.status;
          if (command.detail) state.concierge.detail = text(command.detail, "状态说明", 1000);
          else delete state.concierge.detail;
          if (command.live) state.concierge.live = structuredClone(command.live);
          return state.concierge;
        }
        case "scene.bind": {
          const scene = validatedScene(command.scene);
          if (scene.backendEpoch !== state.backendEpoch ||
            (state.backendBinding && (state.backendBinding.installationId !== scene.installationId ||
              state.backendBinding.backend !== scene.backend ||
              state.backendBinding.status === "revoked")))
            throw new Error("stale_backend_epoch: 现场不属于当前后端代次。");
          if (!command.goalId) {
            if (state.concierge.initializedAttemptId !== scene.attemptId)
              delete state.concierge.initializedAttemptId;
            state.concierge.scene = scene;
            state.concierge.status = state.concierge.initializedAttemptId === scene.attemptId ? "ready" : "not_ready";
            delete state.concierge.legacyScene;
            delete state.concierge.live;
            return state.concierge;
          }
          const item = goal(command.goalId);
          if (["backlog", "completed", "dropped"].includes(item.status) || item.mode !== "concierge")
            throw new Error("该事项当前不能启动 Agent 现场。");
          if (sameScene(state.concierge.scene, scene) ||
            state.goals.some(other => other.id !== item.id &&
              !["completed", "dropped"].includes(other.status) && sameScene(other.scene, scene)))
            throw new Error("scene_identity_mismatch: 目标需要独立负责人现场。");
          if (command.role === "verifier") {
            if (sameScene(item.scene, scene)) throw new Error("独立复核不能复用负责人现场。");
            const autonomy = ensureGoalAutonomy(item);
            autonomy.verificationSite = {
              scene,
              status: "ready",
              at: nowIso(),
            };
          } else {
            if (item.agentRuntime && item.agentRuntime.attempt.attemptId !== scene.attemptId)
              throw new Error("scene_identity_mismatch: 现场 attempt 与负责人不一致。");
            item.scene = scene;
            item.owner = item.sceneLaunch?.agent || item.agentRuntime?.attempt.agent || item.owner;
            if (item.agentRuntime) item.agentRuntime.attempt.scene = structuredClone(scene);
            delete item.legacyScene;
            delete item.herdr;
            delete item.live;
            delete item.sceneVisit;
          }
          return item;
        }
        case "scene.retire": {
          // Only the trusted transport calls this after a fresh, identity-bound
          // exited observation. It retires the binding, not the business goal.
          const item = goal(command.goalId);
          if (!item.scene || item.scene.bindingId !== command.bindingId || item.scene.attemptId !== command.attemptId)
            throw new Error("scene_identity_mismatch: 原现场已经变化，不能恢复。");
          item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          delete item.agentRuntime;
          delete item.sceneVisit;
          return item;
        }
        case "scene.release": {
          if (!command.goalId) {
            if (state.concierge.scene?.bindingId !== command.bindingId) return false;
            delete state.concierge.scene;
            delete state.concierge.launch;
            delete state.concierge.live;
            delete state.concierge.initializedAttemptId;
            state.concierge.status = "not_ready";
            return true;
          }
          const item = goal(command.goalId);
          if (command.role === "verifier") {
            if (item.autonomy?.verificationSite?.scene?.bindingId !== command.bindingId) return false;
            delete item.autonomy.verificationSite;
            delete item.autonomy.verificationLaunch;
            return true;
          }
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已结束的目标可以释放现场。");
          if (item.scene?.bindingId !== command.bindingId) return false;
          item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          return true;
        }
        case "scene.legacy.clear": {
          const reason = text(command.reason, "旧现场清理原因", 1000);
          if (!command.goalId) {
            if (!state.concierge.legacyScene) return false;
            delete state.concierge.legacyScene;
            state.concierge.status = "not_ready";
            delete state.concierge.live;
            return true;
          }
          const item = goal(command.goalId);
          if (item.scene || !item.legacyScene) return false;
          delete item.legacyScene;
          delete item.live;
          activity(item, "session", `已忽略无法重新核实的旧 Herdr 现场：${reason}`, "系统");
          return true;
        }
        case "scene.observe": {
          for (const observation of command.scenes) {
            if (!["working", "idle", "done", "blocked", "unknown"].includes(observation.presence.state))
              throw new Error("无效的现场观测。");
            const item = state.goals.find(candidate =>
              candidate.scene?.bindingId === observation.bindingId &&
              !["completed", "dropped"].includes(candidate.status));
            const current = item?.live ?? (state.concierge.scene?.bindingId === observation.bindingId
              ? state.concierge.live : undefined);
            if (current?.state === observation.presence.state &&
              current?.reachable === observation.presence.reachable) continue;
            const presence = { ...observation.presence, checkedAt: iso(observation.presence.checkedAt) };
            if (item) {
              item.live = presence;
              observeSceneWork(item, presence);
              if (presence.state === "working") {
                delete item.watchdog;
                delete item.recovery;
              }
            } else if (state.concierge.scene?.bindingId === observation.bindingId) {
              state.concierge.live = presence;
              if (!presence.reachable) {
                state.concierge.status = "not_ready";
                state.concierge.detail = "管家现场已关闭或不可达，请恢复管家。";
              } else if (state.concierge.initializedAttemptId === state.concierge.scene.attemptId) {
                state.concierge.status = "ready";
                delete state.concierge.detail;
              }
            }
          }
          return true;
        }
        case "backend.revoke": {
          if (state.backendEpoch !== command.expectedEpoch)
            throw new Error("stale_backend_epoch: 后端代次已改变。");
          if (state.backendBinding) state.backendBinding.status = "revoked";
          return true;
        }
        case "backend.commit": {
          const binding = command.binding;
          if (!binding || !["herdr", "orca"].includes(binding.backend) ||
            !Number.isSafeInteger(binding.epoch) || binding.epoch <= state.backendEpoch ||
            !binding.installationId || !binding.scopeGeneration || !binding.operationId)
            throw new Error("无效的后端交接代次。");
          // Mutate only backend fields in the latest locked snapshot. Never
          // replace the workspace with the prepared checkpoint.
          state.backendBinding = structuredClone(binding);
          state.backendEpoch = binding.epoch;
          if (state.concierge.scene)
            state.concierge.legacyScene = undefined;
          state.concierge = { session: "crewvane", status: "not_ready" };
          for (const item of state.goals) {
            const handoff = command.handoffs[item.id];
            if (handoff) item.backendHandoff = structuredClone(handoff);
            if (item.scene)
              item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
            delete item.scene;
            delete item.sceneLaunch;
            delete item.herdr;
            delete item.legacyScene;
            delete item.live;
            delete item.agentRuntime;
            delete item.sceneVisit;
            delete item.watchdog;
            delete item.ownerLaunchRecovery;
            if (item.autonomy?.verificationSite) delete item.autonomy.verificationSite;
            if (item.autonomy?.verificationLaunch) delete item.autonomy.verificationLaunch;
            const continuation = item.autonomy?.continuation;
            if (continuation && ["claimed", "sent"].includes(continuation.status)) {
              continuation.status = "cancelled";
              continuation.lastError = "后端交接已撤销旧执行租约；根据最新目标记录重新评估。";
            }
          }
          return true;
        }
        case "backend.activate": {
          if (!state.backendBinding || state.backendBinding.operationId !== command.operationId ||
            state.backendBinding.status !== "resuming")
            throw new Error("后端交接操作不匹配。");
          state.backendBinding.status = "active";
          delete state.backendBinding.operationId;
          return true;
        }
        case "backend.handoff": {
          const item = goal(command.goalId);
          if (item.backendHandoff?.operationId !== command.operationId)
            throw new Error("后端恢复记录已变化。");
          Object.assign(item.backendHandoff, structuredClone(command.patch));
          return item.backendHandoff;
        }
        case "workspace.rename":
          state.name = text(command.name, "工作区名称", 80);
          return state.name;
        case "workspace.recovery.dismiss":
          delete state.recovery;
          return true;
        case "workspace.autonomy.set": {
          humanOnly(command.actor, "自主目标设置只能由人修改");
          const autonomy = state.autonomy ?? defaultWorkspaceAutonomy();
          if (command.acceptance !== undefined && !isAcceptanceMode(command.acceptance))
            throw new Error("无效的验收方式");
          if (command.paused !== undefined && typeof command.paused !== "boolean")
            throw new Error("无效的暂停状态");
          if (command.maxRecoveryAttempts !== undefined &&
            (!Number.isSafeInteger(command.maxRecoveryAttempts) ||
              command.maxRecoveryAttempts < 1 || command.maxRecoveryAttempts > 20))
            throw new Error("默认恢复次数必须是 1 到 20 的整数");
          if (command.noProgressMinutes !== undefined &&
            (!Number.isSafeInteger(command.noProgressMinutes) ||
              command.noProgressMinutes < 5 || command.noProgressMinutes > 10_080))
            throw new Error("无进展检测时间必须是 5 到 10080 分钟的整数");
          if (command.acceptance !== undefined) autonomy.acceptance = command.acceptance;
          if (command.paused !== undefined) autonomy.paused = command.paused;
          if (command.maxRecoveryAttempts !== undefined)
            autonomy.maxRecoveryAttempts = command.maxRecoveryAttempts;
          if (command.noProgressMinutes !== undefined)
            autonomy.noProgressMinutes = command.noProgressMinutes;
          if (command.initialize || command.acceptance !== undefined)
            autonomy.initializedAt ??= nowIso();
          autonomy.revision += 1;
          autonomy.updatedAt = nowIso();
          state.autonomy = autonomy;
          return autonomy;
        }
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
            autonomy: defaultProjectAutonomy(),
            releaseOnMerge: "unknown" as const,
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
        case "bot.binding.set": {
          humanOnly(command.actor, "Bot 绑定只能由人创建或修改");
          const binding = command.binding;
          if (!binding || typeof binding !== "object")
            throw new Error("Bot 绑定内容无效");
          const botId = id(binding.id),
            name = text(binding.name, "Bot 名称", 120),
            expiresAt = iso(binding.expiresAt),
            allowedOperations: BotOperation[] = [
              "goal.submit",
              "goal.read",
              "goal.message",
            ];
          if (Date.parse(expiresAt) <= Date.now())
            throw new Error("Bot 绑定必须有一个未来有效期");
          if (!["initiator", "executor"].includes(binding.role))
            throw new Error("无效的 Bot 角色");
          if (binding.role !== "initiator")
            throw new Error("0.9 只开放本地发起方 Bot；执行方 Bot 需要后续独立安全评审");
          if (!Array.isArray(binding.projectIds) || binding.projectIds.length < 1 ||
            binding.projectIds.length > 50)
            throw new Error("Bot 至少需要绑定一个项目");
          const projectIds = [...new Set(binding.projectIds.map(value => id(value)))];
          if (projectIds.some(projectId =>
            !state.projects.some(project => project.id === projectId)))
            throw new Error("Bot 绑定了不存在的项目");
          if (!Array.isArray(binding.operations) || binding.operations.length < 1)
            throw new Error("Bot 至少需要一个操作权限");
          const operations = [...new Set(binding.operations)];
          if (operations.some(operation => !allowedOperations.includes(operation)))
            throw new Error("0.9 的 Bot 只能提交目标、读取状态和追加消息");
          const saved: BotBinding = {
            id: botId,
            name,
            role: binding.role,
            projectIds,
            operations,
            expiresAt,
            status: "active",
          };
          state.bots ??= [];
          const index = state.bots.findIndex(item => item.id === botId);
          if (index < 0) state.bots.push(saved);
          else state.bots[index] = saved;
          return saved;
        }
        case "bot.binding.revoke": {
          humanOnly(command.actor, "Bot 绑定只能由人撤销");
          const botId = id(command.botId),
            binding = state.bots?.find(item => item.id === botId);
          if (!binding) throw new Error("找不到 Bot 绑定");
          binding.status = "revoked";
          return binding;
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
        case "project.autonomy.set": {
          humanOnly(command.actor, "项目自主目标设置只能由人修改");
          const project = state.projects.find(item => item.id === id(command.projectId));
          if (!project) throw new Error("找不到项目");
          if (command.acceptance !== "inherit" && !isAcceptanceMode(command.acceptance))
            throw new Error("无效的项目验收方式");
          if (!isReleaseOnMerge(command.releaseOnMerge))
            throw new Error("无效的合并发布声明");
          const revision = (project.autonomy?.revision ?? 0) + 1;
          project.autonomy = {
            acceptance: command.acceptance,
            revision,
            updatedAt: nowIso(),
          };
          project.releaseOnMerge = command.releaseOnMerge;
          return { autonomy: project.autonomy, releaseOnMerge: project.releaseOnMerge };
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
          const kind = input.kind === undefined
            ? "delivery" as const
            : writableGoalKind(input.kind);
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
            kind,
            revision: 1,
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
          const kind = command.kind === undefined
            ? "delivery" as const
            : writableGoalKind(command.kind);
          const goalAttachments = await validateGoalAttachments(this.root, command.attachments);
          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            kind, revision: 1,
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
          const backendLabel = state.backendBinding?.backend === "orca" ? "Orca" : "Herdr";
          const request = text(command.text, "终端消息", 20_000);
          const incomingAttachments = await validateGoalAttachments(this.root, command.attachments);
          if (command.goalId) {
            const item = goal(command.goalId);
            if (command.kind !== undefined)
              throw new Error("已有目标请使用 goal kind 明确切换类型");
            if (command.handling)
              throw new Error("终端补充消息不能改变执行安排，请使用明确的开始命令");
            if (["completed", "dropped"].includes(item.status))
              throw new Error("目标已结束，不能再追加终端消息");
            if (item.mode === "concierge") handBackExternalWait(item);
            delete item.sceneReply;
            cancelAgentReceipt(item);
            const combined = await validateGoalAttachments(this.root, [
              ...(item.attachments ?? []),
              ...incomingAttachments,
            ]);
            if (combined.length) item.attachments = combined;
            const at = nowIso();
            item.activities.push({
              id: newId("act"),
              at,
              actor: `你 · ${backendLabel} 直聊`,
              kind: "message",
              text: attachmentActivity(request, incomingAttachments),
              ...(incomingAttachments.length
                ? { attachmentIds: incomingAttachments.map(attachment => attachment.id) }
                : {}),
            });
            item.revision = (item.revision ?? 0) + 1;
            item.updatedAt = at;
            return item;
          }

          const projectId = command.projectId && command.projectId !== "personal" ? command.projectId : "personal";
          const project = state.projects.find(item => item.id === id(projectId));
          if (!project) throw new Error("请选择有效项目");
          const arrangement = intakeArrangement(command.handling ?? "concierge");
          const kind = command.kind === undefined
            ? "delivery" as const
            : writableGoalKind(command.kind);
          const at = nowIso();
          const item: Goal = {
            id: newId("goal"), projectId: project.id,
            title: automaticGoalTitle(request), description: request,
            kind, revision: 1,
            ...arrangement,
            steps: [],
            next: arrangement.mode === "concierge"
              ? `管家正在理解 ${backendLabel} 终端中的原文并整理目标。` : arrangement.next,
            attention: null,
            // The concierge already received this message in its terminal turn.
            // Mark it as delivered so desktop dispatch does not replay the same text.
            ...(arrangement.mode === "concierge"
              ? { dispatch: { id: newId("handoff"), kind: "feedback" as const, status: "sent" as const, at, detail: `已从 ${backendLabel} 终端直接送达管家` } }
              : {}),
            ...(incomingAttachments.length ? { attachments: incomingAttachments } : {}),
            activities: [{ id: newId("act"), at, actor: `你 · ${backendLabel} 直聊`, kind: "created", text: request }],
            createdAt: at, updatedAt: at,
          };
          state.goals.push(item);
          return item;
        }
        case "scene.visit": {
          const item = goal(command.goalId), request = attentionRequest(item);
          if (!request || item.mode !== "concierge" ||
            (!item.scene && (!item.herdr?.agent || item.herdr.transport === "pane")) ||
            pendingSceneReply(item)) return item;
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
        case "scene.cancel": {
          const item = goal(command.goalId);
          if (command.reason !== "user-input")
            throw new Error("无效的现场核对取消原因");
          if (!cancelSceneReconciliation(item)) return false;
          stamp(item);
          return true;
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
          if (actor !== item.agentRuntime?.attempt.agent && actor !== item.herdr?.agent &&
            actor !== "concierge" && actor !== state.concierge.agent)
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
          activity(item, "message", quote, `你 · ${item.scene?.backend === "orca" ? "Orca" : "Herdr"} 现场`);
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
          cancelAgentReceipt(item);
          cancelSceneReconciliation(item);
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
          item.revision = (item.revision ?? 0) + 1;
          item.updatedAt = at;
          return item;
        }
        case "goal.skill.attach": {
          const item = goal(command.goalId);
          ongoing(item, true);
          const actor = command.actor === "concierge" ? "管家" : "你",
            registry = new SkillRegistry(this.root),
            resolved = await registry.binding(command.packId),
            binding: GoalSkillBinding = {
              packId: resolved.packId,
              version: resolved.version,
              digest: resolved.digest,
              roles: resolved.roles,
              attachedAt: nowIso(),
              attachedBy: command.actor,
            };
          item.skills = [
            ...(item.skills ?? []).filter(candidate => candidate.packId !== binding.packId),
            binding,
          ].sort((left, right) => left.packId.localeCompare(right.packId));
          if (item.skills.length > 8)
            throw new Error("每个目标最多挂载 8 个本地能力包");
          activity(
            item,
            "skill",
            `已挂载本地能力包：${resolved.view.name}（${resolved.packId}@${resolved.version}）。`,
            actor,
          );
          return item;
        }
        case "goal.skill.detach": {
          const item = goal(command.goalId),
            packId = text(command.packId, "能力包 ID", 100);
          ongoing(item, true);
          const existing = item.skills?.find(candidate => candidate.packId === packId);
          if (!existing) throw new Error("该能力包未挂载到当前目标");
          item.skills = item.skills!.filter(candidate => candidate.packId !== packId);
          if (!item.skills.length) delete item.skills;
          activity(
            item,
            "skill",
            `已移除本地能力包：${packId}@${existing.version}。`,
            command.actor === "concierge" ? "管家" : "你",
          );
          return item;
        }
        case "goal.skill.audit": {
          const item = goal(command.goalId),
            packId = text(command.packId, "能力包 ID", 100),
            scriptId = text(command.scriptId, "脚本 ID", 80);
          if (!item.skills?.some(binding => binding.packId === packId))
            throw new Error("该能力包未挂载到当前目标");
          if (command.outcome !== "succeeded" && command.outcome !== "failed")
            throw new Error("能力包脚本结果无效");
          activity(
            item,
            "skill",
            `能力包脚本 ${packId}/${scriptId} ${command.outcome === "succeeded" ? "执行成功" : "执行失败"}：${text(command.summary, "脚本执行结果", 8_000)}`,
            command.actor?.trim() || "系统",
          );
          return item;
        }
        case "goal.skill.resolve": {
          const item = goal(command.goalId),
            value = command.resolution;
          ongoing(item, true);
          if (!["concierge", "owner", "verifier"].includes(value.role))
            throw new Error("能力包解析角色无效");
          if (!Array.isArray(value.packs) || value.packs.length > 12)
            throw new Error("能力包解析结果无效");
          if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest))
            throw new Error("能力包解析摘要无效");
          for (const pack of value.packs) {
            if (
              !pack ||
              typeof pack.id !== "string" ||
              typeof pack.version !== "string" ||
              typeof pack.digest !== "string" ||
              !Array.isArray(pack.roles) ||
              !pack.roles.every(role => ["concierge", "owner", "verifier"].includes(role)) ||
              !["builtin", "local"].includes(pack.source) ||
              !/^[a-f0-9]{64}$/.test(pack.digest)
            )
              throw new Error("能力包解析明细无效");
          }
          const resolution = {
            id: newId("skillres"),
            role: value.role,
            ...(value.attemptId ? { attemptId: id(value.attemptId) } : {}),
            resolvedAt: nowIso(),
            digest: value.digest,
            packs: structuredClone(value.packs),
          } as const;
          item.skillResolutions = [...(item.skillResolutions ?? []), resolution].slice(-40);
          stamp(item);
          return resolution;
        }
        case "goal.owner-launch.recovery": {
          const item = goal(command.goalId),
            value = command.recovery;
          ongoing(item, true);
          if (
            typeof value.id !== "string" ||
            !/^[A-Za-z0-9_-]{8,160}$/.test(value.id) ||
            typeof value.attemptId !== "string" ||
            !/^[A-Za-z0-9_-]{8,160}$/.test(value.attemptId) ||
            typeof value.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(value.session) ||
            !["pending", "attached", "superseded"].includes(value.status) ||
            !Number.isFinite(Date.parse(value.createdAt))
          )
            throw new Error("负责人恢复信息无效");
          if (value.tabId !== undefined && !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(value.tabId))
            throw new Error("负责人恢复信息中的 Tab ID 无效");
          if (value.paneId !== undefined && !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(value.paneId))
            throw new Error("负责人恢复信息中的 Pane ID 无效");
          item.ownerLaunchRecovery = {
            ...structuredClone(value),
            createdAt: iso(value.createdAt),
            ...(value.attachedAt ? { attachedAt: iso(value.attachedAt) } : {}),
            ...(value.detail ? { detail: text(value.detail, "恢复说明", 2_000) } : {}),
          };
          activity(
            item,
            "session",
            value.status === "attached"
              ? `已通过恢复 ID ${value.id} 绑定现成负责人现场。`
              : `负责人启动恢复 ID：${value.id}。环境确认失败时可使用 owner attach 绑定已核实的现场。`,
            "系统",
          );
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
          cancelAgentReceipt(item);
          finishContinuation(item, nowIso(), "cancelled");
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
          finishWaitContinuation(item, nowIso());
          item.dispatch = { id: newId("handoff"), kind: "feedback", status: "pending", at: nowIso() };
          delete item.watchdog;
          activity(item, "session", "已重新交给管家统筹。", "你");
          return item;
        }
        case "goal.restore": {
          const item = goal(command.goalId);
          if (item.status !== "dropped" || item.mode !== "manual" || item.herdr)
            throw new Error("只有已移出且没有执行现场的个人事项可以恢复到待办池");
          finishContinuation(item, nowIso(), "cancelled");
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
          if (item.status === "active" || !item.remindAt)
            finishWaitContinuation(item, nowIso());
          if (item.status === "waiting" && item.mode === "concierge" &&
            item.brief && item.remindAt) {
            const autonomy = ensureGoalAutonomy(
              item,
              item.brief.attemptBudget.maxRecoveryAttempts,
            );
            autonomy.continuation = scheduleContinuation(item, "wait-due", {
              at: nowIso(),
              dueAt: item.remindAt,
              idempotencyKey: `${item.id}:wait-due:${item.remindAt}`,
            });
          }
          return item;
        }
        case "goal.dispatch": {
          const item = goal(command.goalId);
          if (command.requestId && item.dispatch?.id !== command.requestId) return item;
          ongoing(item, true);
          if (item.mode !== "concierge")
            throw new Error("这个目标已由你接管");
          if (!["pending", "sent", "unconfirmed", "failed"].includes(command.status)) throw new Error("无效的派送状态");
          const at = nowIso(), detail = command.detail ? text(command.detail, "派送说明", 2000) : undefined;
          item.mode = "concierge";
          item.dispatch = { ...item.dispatch,
            id: command.status === "pending" && !command.requestId ? newId("handoff") : item.dispatch?.id,
            status: command.status, at, detail,
            ...(command.kind ? { kind: command.kind } : {}),
            ...(command.note !== undefined
              ? { note: text(command.note, "派发说明", 12_000) }
              : {}),
          };
          if (command.status !== "failed" && item.attention?.source === "dispatch")
            item.attention = null;
          if (command.status === "failed" && !attentionRequest(item)) item.attention = {
            id: newId("attention"),
            kind: "intervention", source: "dispatch", summary: detail || "目标尚未送达管家，请重试。", since: at,
          };
          if (["sent", "unconfirmed"].includes(command.status) && item.attention?.source === "dispatch")
            item.attention = null;
          activity(item, "session",
            command.status === "sent" ? "目标已送达管家。"
              : command.status === "unconfirmed" ? `目标已提交，送达状态待现场确认。${detail ?? ""}`
                : command.status === "failed" ? `联系管家失败：${detail}`
                  : "正在联系管家。",
            "系统");
          return item;
        }
        case "goal.resume": {
          const item = goal(command.goalId); ongoing(item);
          if (item.status !== "waiting") throw new Error("只有等待中的目标可以恢复推进");
          if (!["concierge", "manual"].includes(command.mode)) throw new Error("请选择由谁继续推进");
          const note = text(command.note, "最新结果与下一步", 2000);
          finishWaitContinuation(item, nowIso());
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
          finishContinuation(item, nowIso(), "cancelled");
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
          if (item.scene) item.sceneHistory = [...(item.sceneHistory ?? []), item.scene].slice(-20);
          delete item.scene;
          delete item.sceneLaunch;
          delete item.live;
          delete item.sceneVisit;
          delete item.sceneReply;
          delete item.watchdog;
          delete item.recovery;
          delete item.agentRuntime;
          delete item.ownerLaunchRecovery;
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
        case "goal.brief": {
          const item = goal(command.goalId);
          ongoing(item);
          if (item.mode !== "concierge")
            throw new Error("个人目标不需要 Agent 委托摘要");
          if (command.expectedRevision !== undefined &&
            command.expectedRevision !== (item.revision ?? 1))
            throw new Error("委托摘要已更新；请重新读取目标后再提交");
          const existing = item.brief,
            actor = command.actor?.trim() ? text(command.actor, "摘要提交者", 120) : "管家",
            at = nowIso(),
            brief = parseGoalBrief(command.brief, {
              revision: (existing?.revision ?? 0) + 1,
              setBy: actor,
              setAt: at,
            });
          const problems = briefProblems(brief, item);
          if (problems.length) throw new Error(problems.join("；"));
          if (existing && actor !== "你") {
            const criteria = (value: GoalBrief) => value.criteria
              .map(criterion => `${criterion.id}:${criterion.required}:${criterion.statement}`)
              .sort().join("|");
            if (existing.outcome !== brief.outcome ||
              criteria(existing) !== criteria(brief) ||
              JSON.stringify(existing.externalEffects) !== JSON.stringify(brief.externalEffects) ||
              JSON.stringify(existing.outOfScope) !== JSON.stringify(brief.outOfScope))
              throw new Error("结果、完成条件或外部影响发生变化，请提交边界变更");
          }
          rememberBrief(item, brief);
          const autonomy = ensureGoalAutonomy(item, brief.attemptBudget.maxRecoveryAttempts);
          autonomy.attempts.limit = brief.attemptBudget.maxRecoveryAttempts;
          finishWaitContinuation(item, nowIso());
          item.status = "active";
          item.waitingFor = undefined;
          activity(
            item,
            "progress",
            `委托摘要 v${brief.revision} 已建立：${brief.outcome}`,
            actor,
          );
          return item;
        }
        case "goal.checkpoint": {
          const item = goal(command.goalId);
          ongoing(item);
          if (item.mode !== "concierge")
            throw new Error("个人目标不参与自主续跑");
          const actor = command.actor?.trim() ? text(command.actor, "负责人", 120) : "负责人",
            summary = substantiveAgentText(command.summary, "本轮进展", 12_000),
            next = substantiveAgentText(command.next, "下一动作", 2_000);
          item.status = "active";
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.next = next;
          if (item.attention?.kind === "follow_up") item.attention = null;
          activity(item, "progress", summary, actor);
          const autonomy = ensureGoalAutonomy(
            item,
            item.brief?.attemptBudget.maxRecoveryAttempts ??
              workspaceAutonomy(state).maxRecoveryAttempts,
          );
          autonomy.continuation = scheduleContinuation(item, "checkpoint", {
            at: nowIso(),
            dueAt: command.dueAt ? iso(command.dueAt) : nowIso(),
          });
          return item;
        }
        case "goal.boundary": {
          const item = goal(command.goalId);
          ongoing(item);
          if (item.mode !== "concierge")
            throw new Error("个人目标不参与边界变更");
          const change = command.change;
          if (!change || typeof change !== "object")
            throw new Error("边界变更内容无效");
          const at = nowIso(),
            proposedCriteria = change.proposedCriteria === undefined
              ? undefined
              : parseGoalBrief({
                  outcome: item.brief?.outcome ?? item.description,
                  inScope: item.brief?.inScope ?? [],
                  outOfScope: item.brief?.outOfScope ?? [],
                  criteria: change.proposedCriteria,
                  constraints: item.brief?.constraints ?? [],
                  externalEffects: change.proposedExternalEffects ??
                    item.brief?.externalEffects ?? [],
                  verificationPlan: item.brief?.verificationPlan ?? {
                    requiredEvidenceKinds: ["inspection"],
                    independentReviewer: true,
                  },
                  attemptBudget: item.brief?.attemptBudget ?? {
                    maxRecoveryAttempts: workspaceAutonomy(state).maxRecoveryAttempts,
                  },
                  source: item.brief?.source ?? {
                    activityIds: [],
                    ruleRefs: [],
                  },
                }, {
                  revision: item.brief?.revision ?? 1,
                  setBy: item.brief?.setBy ?? "管家",
                  setAt: item.brief?.setAt ?? at,
                }).criteria;
          const boundary = {
            id: newId("boundary"),
            reason: text(change.reason, "边界变更原因", 4_000),
            ...(change.proposedOutcome
              ? { proposedOutcome: text(change.proposedOutcome, "建议结果", 4_000) }
              : {}),
            ...(proposedCriteria ? { proposedCriteria } : {}),
            ...(change.proposedExternalEffects
              ? {
                  proposedExternalEffects: change.proposedExternalEffects.map(value =>
                    text(value, "建议外部影响", 2_000)),
                }
              : {}),
            evidence: Array.isArray(change.evidence)
              ? change.evidence.map(value => text(value, "边界证据", 2_000)).slice(0, 20)
              : [],
            alternatives: Array.isArray(change.alternatives)
              ? change.alternatives.map(value => text(value, "可选方案", 2_000)).slice(0, 20)
              : [],
            recommendation: text(change.recommendation, "推荐方案", 4_000),
            status: "pending" as const,
            createdAt: at,
          };
          if (!boundary.evidence.length || !boundary.alternatives.length)
            throw new Error("边界变更必须附证据和可选方案");
          ensureGoalAutonomy(item).boundaryChange = boundary;
          item.attention = {
            id: newId("attention"),
            kind: "decision",
            summary: `边界变更：${boundary.reason}`,
            since: at,
            source: "governance",
            decisionKey: `boundary:${item.id}:${boundary.id}`,
          };
          item.next = "自主推进已暂停，等待你批准或拒绝边界变更。";
          activity(item, "boundary", boundary.reason, command.actor || "管家");
          return item;
        }
        case "goal.verify": {
          const item = goal(command.goalId);
          if (item.status !== "review" || !item.delivery)
            throw new Error("只有待复核的交付可以提交独立复核");
          if (!item.brief)
            throw new Error("缺少委托摘要，不能提交自主复核");
          const delivery = item.delivery,
            reviewer = text(
              command.reviewer || command.actor || process.env.CREWVANE_AGENT_NAME,
              "复核人",
              120,
            );
          if (!delivery.id)
            throw new Error("交付缺少稳定 ID，请重新提交验收");
          if (reviewer === delivery.submittedBy || reviewer === item.owner)
            throw new Error("复核人不能是交付提交者或当前负责人");
          const reviewerHerdr = command.reviewerHerdr ??
            (item.autonomy?.verificationSite?.status === "ready"
              ? item.autonomy.verificationSite.reference
              : undefined);
          const reviewerScene = item.autonomy?.verificationSite?.status === "ready"
            ? item.autonomy.verificationSite.scene : undefined;
          if (reviewerScene && (sameScene(reviewerScene, item.scene) ||
            sameScene(reviewerScene, state.concierge.scene)))
            throw new Error("复核站点不能复用交付执行者或管家的现场");
          if (reviewerScene && managed?.role === "verifier" &&
            reviewerScene.attemptId !== managed.attemptId)
            throw new Error("stale_backend_epoch: 独立复核 attempt 已更新。");
          if (reviewerHerdr && reviewerHerdr.agent && reviewerHerdr.agent !== reviewer)
            throw new Error("复核站点与复核人身份不一致");
          if (reviewerHerdr && item.herdr) {
            const samePane = reviewerHerdr.paneId &&
              reviewerHerdr.paneId === item.herdr.paneId;
            const sameTab = reviewerHerdr.tabId &&
              reviewerHerdr.tabId === item.herdr.tabId;
            if (samePane || sameTab)
              throw new Error("复核站点不能复用交付执行者的现场");
          }
          if (command.deliveryId !== delivery.id)
            throw new Error("复核必须绑定当前交付");
          const criteria = verificationItems(command.criteria, delivery, item.brief),
            required = item.brief.criteria.filter(criterion => criterion.required),
            missing = required.filter(criterion =>
              !criteria.some(result => result.criterionId === criterion.id));
          if (missing.length)
            throw new Error(`复核未覆盖必选完成条件：${missing.map(item => item.id).join("、")}`);
          if (command.outcome === "passed" &&
            required.some(criterion =>
              criteria.find(result => result.criterionId === criterion.id)?.result !== "passed"))
            throw new Error("必选完成条件未全部通过，不能将复核标记为通过");
          if (!["passed", "failed"].includes(command.outcome))
            throw new Error("无效的复核结论");
          const at = nowIso(),
            verification: Verification = {
              id: newId("verification"),
              deliveryId: delivery.id!,
              outcome: command.outcome,
              summary: substantiveAgentText(command.summary, "复核摘要", 12_000),
              criteria,
              reviewer,
              ...(reviewerScene ? { reviewerScene: structuredClone(reviewerScene) } : {}),
              ...(reviewerHerdr
                ? { reviewerHerdr: structuredClone(reviewerHerdr) }
                : {}),
              verifiedAt: at,
            },
            autonomy = ensureGoalAutonomy(item);
          autonomy.lastVerification = verification;
          finishContinuation(item, at);
          if (verification.outcome === "passed") {
            const gate = autoAcceptanceGate(state, item);
            if (gate.eligible) {
              const acceptance = completionRecord(
                state,
                item,
                "automatic",
                "Crewvane",
                at,
                `独立复核通过：${verification.summary}`,
                verification.id,
              );
              item.status = "completed";
              item.attention = null;
              item.waitingFor = undefined;
              item.remindAt = undefined;
              item.next = "目标已在验证授权内自动验收，不表示生产发布已完成。";
              activity(
                item,
                "accepted",
                `自动验收通过（授权修订 ${acceptance.mandateRevision}）：${verification.summary}`,
                "系统",
              );
              return item;
            }
            if (gate.reason === "human_review") {
              item.attention ??= {
                id: newId("attention"),
                kind: "review",
                summary: "独立复核已通过，等待你完成人工验收。",
                since: at,
              };
              item.next = "查看交付、证据和独立复核，再完成最终验收。";
              activity(item, "verification", verification.summary, reviewer);
              return item;
            }
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: `独立复核通过，但自动验收门禁未满足：${gate.reason}`,
              since: at,
              source: "governance",
            };
            item.next = "查看缺失证据或授权，再决定人工验收、补充复核或继续返工。";
            activity(item, "verification", verification.summary, reviewer);
            return item;
          }
          const fingerprint = failureFingerprint(delivery, verification),
            repeated = autonomy.attempts.failureFingerprint === fingerprint;
          autonomy.attempts.used += 1;
          autonomy.attempts.failureFingerprint = fingerprint;
          const limit = Math.min(
            autonomy.attempts.limit,
            item.brief.attemptBudget.maxRecoveryAttempts,
          );
          if (repeated || autonomy.attempts.used >= limit) {
            item.status = "active";
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: repeated
                ? "复核再次报告同一失败且没有新证据，已停止自动重试。"
                : `复核失败且恢复预算已用尽（${autonomy.attempts.used}/${limit}）。`,
              since: at,
              source: "governance",
            };
            item.next = "查看失败证据和已尝试方案，决定人工接手、调整边界或提供新信息。";
            activity(item, "verification", verification.summary, reviewer);
            return item;
          }
          item.status = "active";
          item.attention = null;
          item.next = `复核未通过，基于新证据继续返工：${verification.summary}`;
          activity(item, "verification", verification.summary, reviewer);
          autonomy.continuation = scheduleContinuation(item, "recovery", {
            at: nowIso(),
            attempt: autonomy.attempts.used + 1,
          });
          return item;
        }
        case "goal.verification.site": {
          const item = goal(command.goalId);
          if (item.status !== "review" || !item.delivery)
            throw new Error("只有待复核交付可以登记复核现场");
          if (!["launching", "ready", "blocked", "failed"].includes(command.status))
            throw new Error("无效的复核现场状态");
          const reference = command.reference;
          if (!reference || typeof reference.session !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(reference.session))
            throw new Error("复核现场缺少有效 Herdr Session");
          if (!reference.paneId && !reference.tabId)
            throw new Error("复核现场缺少 Pane 或 Tab 标识");
          if (reference.agent !== undefined &&
            !/^[a-z][a-z0-9_-]{0,31}$/.test(reference.agent))
            throw new Error("复核现场 Agent 名称无效");
          const at = nowIso(),
            autonomy = ensureGoalAutonomy(item);
          autonomy.verificationSite = {
            reference: structuredClone(reference),
            status: command.status,
            at,
            ...(command.detail ? { detail: text(command.detail, "复核现场说明", 1_000) } : {}),
          };
          if (command.status === "ready" &&
            item.attention?.source === "governance" &&
            /独立复核者/.test(item.attention.summary)) {
            item.attention = null;
            item.next = "独立复核现场已就绪，等待复核者提交逐项结果。";
          } else if (command.status === "blocked" || command.status === "failed") {
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: command.status === "blocked"
                ? "独立复核者等待现场交互确认，复核尚未开始。"
                : "独立复核者启动失败，复核尚未开始。",
              since: at,
              source: "governance",
            };
            item.next = command.status === "blocked"
              ? "在复核者现场审核启动或 Hook 信任提示，确认就绪后重新安排独立复核。"
              : "查看复核现场记录，修复启动条件后重新安排独立复核。";
          }
          activity(
            item,
            "verification",
            command.status === "ready"
              ? "独立复核现场已就绪。"
              : `独立复核现场：${command.status}${command.detail ? `；${command.detail}` : ""}`,
            command.actor || "系统",
          );
          return item;
        }
        case "goal.boundary.resolve": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "边界变更只能由人批准或拒绝");
          const boundary = item.autonomy?.boundaryChange;
          if (!boundary || boundary.id !== command.boundaryId ||
            boundary.status !== "pending")
            throw new Error("当前没有匹配的待处理边界变更");
          if (!["approved", "rejected"].includes(command.outcome))
            throw new Error("无效的边界变更决定");
          const note = text(command.note, "边界变更决定原话", 4_000),
            at = nowIso();
          boundary.status = command.outcome;
          boundary.resolvedAt = at;
          item.attention = null;
          if (command.outcome === "approved") {
            if (item.brief) {
              rememberBrief(item, {
                ...item.brief,
                revision: item.brief.revision + 1,
                ...(boundary.proposedOutcome ? { outcome: boundary.proposedOutcome } : {}),
                ...(boundary.proposedCriteria ? { criteria: boundary.proposedCriteria } : {}),
                ...(boundary.proposedExternalEffects
                  ? { externalEffects: boundary.proposedExternalEffects }
                  : {}),
                setBy: "你",
                setAt: at,
              });
            }
            const autonomy = ensureGoalAutonomy(item);
            autonomy.attempts.used = 0;
            delete autonomy.attempts.failureFingerprint;
            item.status = "active";
            item.next = `边界变更已批准，从既有成果继续：${note}`;
            activity(item, "boundary", `边界变更批准：${note}`, "你");
            finishContinuation(item, at);
            autonomy.continuation = scheduleContinuation(item, "decision-resolved", {
              at: nowIso(),
            });
          } else {
            item.status = "active";
            item.next = `边界变更已拒绝：${note}`;
            activity(item, "boundary", `边界变更拒绝：${note}`, "你");
            finishContinuation(item, at, "cancelled");
          }
          return item;
        }
        case "goal.kind.set": {
          const item = goal(command.goalId);
          ongoing(item, false, true);
          if (item.kind === "release" || item.release)
            throw new Error("发布目标类型不能通过 goal kind 修改");
          const kind = writableGoalKind(command.kind);
          if ((item.kind ?? "delivery") === kind) return item;
          item.kind = kind;
          activity(
            item,
            "progress",
            kind === "discovery"
              ? "目标已标记为探索：先收集证据和候选方向，不据此自动决定产品方向。"
              : "目标已标记为交付：按委托摘要产出可独立复核的成果。",
            command.actor || "管家",
          );
          return item;
        }
        case "goal.autonomy.pause":
        case "goal.autonomy.resume": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "自主推进只能由人暂停或恢复");
          if (["completed", "dropped"].includes(item.status))
            throw new Error("已结束的目标不能修改自主推进");
          const autonomy = ensureGoalAutonomy(item);
          if (command.type === "goal.autonomy.pause") {
            autonomy.paused = true;
            item.next = item.attention?.summary ?? "自主推进已暂停；当前 Agent 回合不会被强制终止。";
            activity(item, "autonomy", "你暂停了新的自主续跑。", "你");
          } else {
            autonomy.paused = false;
            item.next = "自主推进已恢复。";
            activity(item, "autonomy", "你恢复了自主续跑。", "你");
            if (item.mode === "concierge" && item.brief &&
              !["review", "waiting"].includes(item.status)) {
              finishContinuation(item, nowIso(), "cancelled");
              autonomy.continuation = scheduleContinuation(item, "recovery", {
                at: nowIso(),
              });
            }
            if (item.mode === "concierge" && item.status !== "review")
              item.dispatch = {
                id: newId("handoff"),
                kind: "feedback",
                note: "用户已恢复该目标的自主推进。请读取最新结构，继续下一个短回合。",
                status: "pending",
                at: nowIso(),
              };
          }
          return item;
        }
        case "goal.autonomy.acceptance": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "目标验收方式只能由人修改");
          if (item.kind === "release" || item.release)
            throw new Error("发布目标不能继承交付目标的自动验收设置");
          if (["completed", "dropped"].includes(item.status))
            throw new Error("已结束的目标不能修改验收方式");
          if (command.acceptance !== "inherit" &&
            !isAcceptanceMode(command.acceptance))
            throw new Error("无效的目标验收方式");
          const autonomy = ensureGoalAutonomy(
            item,
            item.brief?.attemptBudget.maxRecoveryAttempts ??
              workspaceAutonomy(state).maxRecoveryAttempts,
          );
          if (command.acceptance === "inherit") delete autonomy.override;
          else autonomy.override = command.acceptance;
          const resolved = resolveAcceptance(state, item);
          activity(
            item,
            "autonomy",
            command.acceptance === "inherit"
              ? `目标验收覆盖已移除，当前生效：${resolved.mode}（${resolved.source}）。`
              : `目标验收方式已设为 ${resolved.mode}，仅作用于当前目标。`,
            "你",
          );
          return item;
        }
        case "goal.reopen": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "只有人可以重新打开目标");
          if (!["completed", "dropped"].includes(item.status))
            throw new Error("只有已完成或已放弃的目标可以重新打开");
          const note = text(command.note, "重新打开原因", 4_000),
            at = nowIso();
          finishContinuation(item, at, "cancelled");
          item.status = "active";
          item.attention = null;
          item.waitingFor = undefined;
          item.remindAt = undefined;
          item.next = note;
          const autonomy = item.autonomy;
          if (autonomy) {
            autonomy.paused = false;
            autonomy.attempts.used = 0;
            delete autonomy.attempts.failureFingerprint;
            delete autonomy.lastVerification;
            delete autonomy.boundaryChange;
          }
          if (item.mode === "concierge") {
            item.dispatch = {
              id: newId("handoff"),
              kind: "feedback",
              note,
              status: "pending",
              at,
            };
          }
          activity(item, "reopened", `重新打开：${note}`, "你");
          if (item.mode === "concierge" && item.brief && autonomy) {
            finishContinuation(item, nowIso(), "cancelled");
            autonomy.continuation = scheduleContinuation(item, "decision-resolved", {
              at: nowIso(),
            });
          }
          return item;
        }
        case "goal.progress": {
          const item = goal(command.goalId);
          ongoing(item);
          const actor = command.actor || "管家",
            summary = actor.startsWith("你")
              ? text(command.summary, "实际结果", 12_000)
              : substantiveAgentText(command.summary, "实际结果", 12_000);
          finishWaitContinuation(item, nowIso());
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
          if (item.mode === "concierge" && item.brief && item.remindAt) {
            const autonomy = ensureGoalAutonomy(
              item,
              item.brief.attemptBudget.maxRecoveryAttempts,
            );
            autonomy.continuation = scheduleContinuation(item, "wait-due", {
              at: nowIso(),
              dueAt: item.remindAt,
              idempotencyKey: `${item.id}:wait-due:${item.remindAt}`,
            });
          }
          return item;
        }
        case "goal.decide": {
          const item = goal(command.goalId);
          ongoing(item);
          const question = text(command.question, "问题", 2000);
          const key = normalizeDecisionKey(command.key ? text(command.key, "决定键", 300) : question);
          const known = latestDecision(state, item.projectId, key);
          finishWaitContinuation(item, nowIso());
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
          finishWaitContinuation(item, at);
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
        case "release.create": {
          humanOnly(command.actor, "发布目标只能由人建立");
          if (!Array.isArray(command.sourceGoalIds) || !command.sourceGoalIds.length ||
            command.sourceGoalIds.length > 20)
            throw new Error("发布目标至少需要一个来源目标");
          const sourceGoalIds = [...new Set(command.sourceGoalIds.map(value => id(value)))],
            sources = sourceGoalIds.map(goal),
            projectIds = new Set(sources.map(source => source.projectId));
          if (projectIds.size !== 1)
            throw new Error("发布目标的来源必须属于同一项目");
          const environment = text(command.environment, "发布环境", 120),
            candidate = deliveryCandidate(command.candidate);
          if (!candidate) throw new Error("发布目标必须绑定候选修订");
          const unaccepted = sources.find(source =>
            source.kind !== "delivery" ||
            source.status !== "completed" ||
            !source.delivery?.candidate ||
            !source.autonomy?.acceptance);
          if (unaccepted)
            throw new Error(`来源目标「${unaccepted.title}」必须已完成并通过验收`);
          const mismatched = sources.find(source =>
            !sameCandidate(source.delivery!.candidate, candidate));
          if (mismatched)
            throw new Error(`来源目标「${mismatched.title}」的候选与发布候选不一致`);
          const at = nowIso(),
            projectId = sources[0]!.projectId,
            releaseTarget: ReleaseTarget = {
              sourceGoalIds,
              environment,
              candidate,
              status: "awaiting-authorization",
            },
            item: Goal = {
              id: newId("goal"),
              projectId,
              title: `发布 ${candidate.version ?? candidate.revision} 到 ${environment}`,
              description: `发布目标，来源：${sources.map(source => source.title).join("、")}`,
              kind: "release",
              revision: 1,
              mode: "concierge",
              status: "active",
              steps: [],
              next: "等待你对本次生产发布作单独批准。",
              owner: "待分配负责人",
              attention: {
                id: newId("attention"),
                kind: "decision",
                summary: `请批准将候选 ${candidate.revision} 发布到 ${environment}。`,
                since: at,
                source: "governance",
                decisionKey: `release:${environment}:${candidate.revision}`,
              },
              release: releaseTarget,
              autonomy: {
                attempts: {
                  used: 0,
                  limit: 1,
                },
              },
              activities: [{
                id: newId("act"),
                at,
                actor: "你",
                kind: "release",
                text: `建立独立发布目标：${environment} · ${candidate.revision}`,
              }],
              createdAt: at,
              updatedAt: at,
            };
          state.goals.push(item);
          return item;
        }
        case "release.approve": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "生产发布必须由人逐次批准");
          if (item.kind !== "release" || !item.release)
            throw new Error("当前目标不是发布目标");
          if (!["drafting", "awaiting-authorization"].includes(item.release.status))
            throw new Error("当前发布不在可批准状态");
          const note = text(command.note, "发布批准原话", 4_000),
            at = nowIso(),
            authorization = {
              id: newId("release_approval"),
              approvedAt: at,
              approvedBy: "你" as const,
              candidateRevision: item.release.candidate.revision,
              ...(item.release.candidate.digest
                ? { candidateDigest: item.release.candidate.digest }
                : {}),
              note,
            };
          item.release.authorization = authorization;
          item.release.status = "authorized";
          item.attention = null;
          item.next = `本次 ${item.release.environment} 发布已获批准，等待执行器报告真实结果。`;
          item.dispatch = {
            id: newId("handoff"),
            kind: "feedback",
            note: `用户已单独批准候选 ${item.release.candidate.revision} 发布到 ${item.release.environment}。请安排执行并只报告真实结果；批准不能扩展到其他候选或环境。`,
            status: "pending",
            at,
          };
          activity(item, "release", `发布批准：${note}`, "你");
          return item;
        }
        case "release.reject": {
          const item = goal(command.goalId);
          humanOnly(command.actor, "生产发布必须由人逐次决定");
          if (item.kind !== "release" || !item.release)
            throw new Error("当前目标不是发布目标");
          if (["succeeded", "cancelled"].includes(item.release.status))
            throw new Error("当前发布已经结束");
          const note = text(command.note, "拒绝发布原话", 4_000);
          item.release.status = "cancelled";
          item.status = "dropped";
          item.attention = null;
          item.next = `发布已取消：${note}`;
          item.dispatch = undefined;
          activity(item, "release", `拒绝本次发布：${note}`, "你");
          return item;
        }
        case "release.result": {
          const item = goal(command.goalId);
          if (item.kind !== "release" || !item.release)
            throw new Error("当前目标不是发布目标");
          if (!releaseApprovalValid(item.release))
            throw new Error("发布授权无效或候选版本已经变化");
          if (!Array.isArray(command.evidence) || command.evidence.length < 1)
            throw new Error("发布结果至少需要一项真实证据");
          if (!["succeeded", "failed"].includes(command.outcome))
            throw new Error("无效的发布结果");
          const evidence = command.evidence.map(value =>
            text(value, "发布证据", 4_000)).slice(0, 50),
            at = nowIso();
          item.release.status = command.outcome;
          item.release.result = {
            outcome: command.outcome,
            evidence,
            reportedAt: at,
          };
          if (command.outcome === "succeeded") {
            item.status = "review";
            item.attention = {
              id: newId("attention"),
              kind: "review",
              summary: "生产发布已执行完成，请查看真实结果并作最终确认。",
              since: at,
              source: "governance",
            };
            item.next = "核对发布环境、候选版本和实际结果，确认后完成目标。";
          } else {
            item.status = "active";
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: "生产发布失败，需要你决定恢复方案。",
              since: at,
              source: "governance",
            };
            item.next = "查看失败证据、环境与候选版本，决定重试、回滚或终止。";
          }
          activity(
            item,
            "release",
            `发布${command.outcome === "succeeded" ? "成功" : "失败"}：${evidence.join("；")}`,
            command.actor || "发布执行器",
          );
          return item;
        }
        case "goal.ship": {
          const item = goal(command.goalId);
          if (item.status === "dropped")
            throw new Error("已放弃的目标不能执行上线动作");
          if (item.status === "backlog")
            throw new Error("尚未开始的目标不能执行上线动作");
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
          if (command.operation === "merge" && goalIsAutonomous(item)) {
            const gate = releaseMergeGate(state, item);
            if (!gate.allowed) {
              const detail = "detail" in gate
                ? gate.detail ?? "自主目标的合并发布边界尚未满足。"
                : "自主目标的合并发布边界尚未满足。";
              item.attention = {
                id: newId("attention"),
                kind: "decision",
                summary: detail,
                since: nowIso(),
                source: "governance",
                decisionKey: `release-merge:${item.id}:${gate.reason}`,
              };
              item.next = detail;
              activity(item, "ship", detail, command.actor || "管家");
              return {
                allowed: false,
                requiresHuman: true,
                reason: gate.reason,
                policy,
                releaseOnMerge: gate.releaseOnMerge,
              };
            }
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
          const at = nowIso(),
            candidate = deliveryCandidate(delivery.candidate),
            evidence = evidenceItems(delivery.evidence, at, checks),
            acceptance = resolveAcceptance(state, item);
          finishContinuation(item, at);
          if (acceptance.mode === "auto-with-verification" && !item.brief)
            throw new Error("自主目标提交验收前必须先提交委托摘要");
          if (acceptance.mode === "auto-with-verification" && !candidate)
            throw new Error("自主目标的交付必须绑定候选修订");
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
            id: newId("delivery"),
            summary: substantiveAgentText(delivery.summary, "成果摘要", 12_000),
            ...(delivery.location
              ? { location: text(delivery.location, "交付位置", 2000) }
              : {}),
            ...(delivery.url ? { url: text(delivery.url, "链接", 2000) } : {}),
            ...(candidate ? { candidate } : {}),
            checks,
            evidence,
            submittedAt: at,
            submittedBy: command.actor || "管家",
          };
          item.status = "review";
          item.reviewRounds = reviewRounds + 1;
          item.reviewLimit = reviewLimit;
          if (item.autonomy) delete item.autonomy.lastVerification;
          if (acceptance.mode === "auto-with-verification") {
            item.attention = null;
            item.next = "成果已提交，正在等待独立复核；通过后按授权自动验收。";
          } else {
            item.attention = {
              id: newId("attention"),
              kind: "review",
              summary: "成果已提交，等待你的验收。",
              since: at,
            };
            item.next = "查看实际成果和检查结果，选择验收通过或退回修改。";
          }
          activity(
            item,
            "delivery",
            item.delivery.summary,
            command.actor || "管家",
          );
          if (acceptance.mode === "auto-with-verification") {
            ensureGoalAutonomy(
              item,
              item.brief?.attemptBudget.maxRecoveryAttempts ??
                workspaceAutonomy(state).maxRecoveryAttempts,
            ).continuation = scheduleContinuation(item, "verification", {
              at: nowIso(),
            });
          }
          delete item.watchdog;
          delete item.recovery;
          return item;
        }
        case "goal.accept": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有提交验收的目标才能通过验收");
          if (item.kind !== "release" && !item.delivery)
            throw new Error("只有提交验收的目标才能通过验收");
          const actor = command.actor || "你";
          humanOnly(
            actor,
            "成果验收必须由人通过桌面或可信注意力界面完成，受管 Agent 不能代替人验收",
          );
          const note = command.note?.trim()
            ? text(command.note, "验收依据", 4000)
            : "成果验收通过。";
          if (item.kind === "release" &&
            (item.release?.status !== "succeeded" ||
              item.release.result?.outcome !== "succeeded"))
            throw new Error("发布目标必须由执行器报告成功后，再由人确认结果");
          const at = nowIso();
          completionRecord(
            state,
            item,
            "human",
            actor,
            at,
            note,
          );
          finishContinuation(item, at);
          item.status = "completed";
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = "这件事已完成，不需要继续关注。";
          cancelAgentReceipt(item);
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
          if (item.status === "review")
            throw new Error("待验收成果必须使用人工验收或独立复核结果，不能直接标记完成");
          ongoing(item, true, true);
          const actor = command.actor || "你";
          if ((item.brief || item.autonomy) && actor !== "你")
            throw new Error("自主目标的最终完成必须由人通过桌面或可信注意力界面确认");
          const note = text(command.note, "用户确认完成的原话", 4000);
          const at = nowIso();
          finishContinuation(item, at);
          item.status = "completed";
          item.attention = null;
          item.remindAt = undefined;
          item.waitingFor = undefined;
          item.next = `已结束：${note}`;
          cancelAgentReceipt(item);
          activity(item, "accepted", note, actor);
          return item;
        }
        case "goal.rework": {
          const item = goal(command.goalId);
          if (item.status !== "review")
            throw new Error("只有待验收目标可以退回");
          const at = nowIso();
          finishContinuation(item, at, "cancelled");
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
          finishContinuation(item, nowIso(), "cancelled");
          item.status = "dropped";
          item.attention = null;
          item.remindAt = undefined;
          item.next = text(command.note || "这件事已放弃。", "原因", 4000);
          cancelAgentReceipt(item);
          activity(item, "dropped", item.next, actor);
          return item;
        }
        case "goal.resolve": {
          const item = goal(command.goalId);
          ongoing(item, true, true);
          if (item.kind === "release" && item.attention?.kind === "decision")
            throw new Error("发布目标必须使用单独的发布批准或拒绝命令");
          if (item.autonomy?.boundaryChange?.status === "pending")
            throw new Error("边界变更必须使用边界变更批准或拒绝命令");
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
                ? `${item.scene?.backend === "orca" ? "Orca" : "Herdr"} 负责人现场`
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
            if (item.agentRuntime)
              item.agentRuntime.attempt.legacyScene = {
                version: 0, backend: "herdr", verification: "unverified", reference: structuredClone(reference),
              };
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
        case "agent.runtime.register": {
          const item = goal(command.goalId),
            attempt = validatedAttempt(command.attempt);
          ongoing(item, true);
          if (attempt.goalId !== item.id)
            throw new Error("Agent attempt 与目标不一致");
          attempt.scene ??= item.scene ? structuredClone(item.scene) : undefined;
          if (!attempt.scene && item.herdr) attempt.legacyScene = {
            version: 0, backend: "herdr", verification: "unverified",
            reference: structuredClone(item.herdr),
          };
          if (!/^[a-f0-9]{64}$/.test(command.hookTokenHash))
            throw new Error("Agent Hook 令牌无效");
          if (!Array.isArray(command.capabilities) ||
            command.capabilities.some(capability => !runtimeEventTypes.has(capability)))
            throw new Error("Agent Runtime 能力声明无效");
          item.agentRuntime = {
            attempt,
            capabilities: [...new Set(command.capabilities)],
            lastEventId: "",
            lastEventType: "session.started",
            lastEventAt: attempt.startedAt,
            lastSequence: 0,
            hookTokenHash: command.hookTokenHash,
            ...(attempt.currentTurnId ? { currentTurnId: attempt.currentTurnId } : {}),
            seenEventIds: [],
          };
          delete item.recovery;
          delete item.watchdog;
          return item.agentRuntime;
        }
        case "agent.runtime.event": {
          const event = validatedRuntimeEvent(command.event),
            item = goal(event.goalId),
            runtime = item.agentRuntime;
          if (!runtime) return { accepted: false, reason: "runtime_missing" };
          if (["completed", "dropped"].includes(item.status))
            return { accepted: false, reason: "goal_ended" };
          if (runtime.attempt.attemptId !== event.attemptId)
            return { accepted: false, reason: "old_attempt" };
          if (runtime.attempt.adapter !== event.adapter ||
            runtime.attempt.agent !== event.agent)
            return { accepted: false, reason: "runtime_mismatch" };
          if (runtime.seenEventIds?.includes(event.eventId))
            return { accepted: false, reason: "duplicate" };
          if (event.sequence <= runtime.lastSequence)
            return { accepted: false, reason: "late_event" };
          if (event.type === "turn.started" && event.turnId &&
            event.turnId !== runtime.currentTurnId &&
            runtime.seenTurnIds?.includes(event.turnId))
            return { accepted: false, reason: "old_turn" };
          const sessionEvent = event.type === "session.started" ||
            event.type === "session.ended";
          // A turn may move the runtime forward only through an explicit
          // turn.started event. Other events carrying a different turn ID are
          // late writes from a settled/interrupted turn and must not move the
          // active receipt or replace the newest reply.
          if (!sessionEvent && event.turnId &&
            event.type !== "turn.started" &&
            runtime.currentTurnId && event.turnId !== runtime.currentTurnId)
            return { accepted: false, reason: "old_turn" };

          runtime.lastEventId = event.eventId;
          runtime.lastEventType = event.type;
          runtime.lastEventAt = event.at;
          runtime.lastSequence = event.sequence;
          runtime.seenEventIds = [...(runtime.seenEventIds ?? []), event.eventId].slice(-64);
          if (!sessionEvent && event.turnId) {
            runtime.currentTurnId = event.turnId;
            runtime.attempt.currentTurnId = event.turnId;
          }
          if (event.type === "turn.started") {
            runtime.currentTurnStartedAt = event.at;
            const receipt = runtime.receipt;
            const reminder = receipt &&
              ["reminding", "reminded", "protocol_missing", "written"].includes(receipt.status) &&
              event.content?.text.startsWith(
                agentReceiptMarker(runtime.attempt.attemptId, receipt.turnId),
              );
            if (reminder) receipt.reminderTurnId = event.turnId;
            else runtime.receipt = undefined;
            // A real Agent turn proves that the person reached the scene. Hook
            // capable owners use their turn lifecycle instead of racing a
            // synthetic reconciliation prompt against the user's next input.
            if (!reminder) cancelSceneReconciliation(item);
            if (event.turnId)
              runtime.seenTurnIds = [
                ...(runtime.seenTurnIds ?? []).filter(turn => turn !== event.turnId),
                event.turnId,
              ].slice(-128);
            if (event.content) runtime.lastPrompt = event.content;
            delete item.recovery;
            if (item.watchdog?.reason === "settled" ||
              item.watchdog?.reason === "protocol_missing")
              delete item.watchdog;
          } else if (event.type === "agent.response") {
            if (event.content) runtime.lastReply = event.content;
          } else if (event.type === "turn.settled") {
            if (event.content) runtime.lastReply = event.content;
            const turn = event.turnId ?? runtime.currentTurnId;
            if (item.mode === "concierge" && turn && runtime.receipt?.reminderTurnId !== turn &&
              runtime.receipt?.turnId !== turn) {
              const settled = Date.parse(event.at);
              runtime.receipt = {
                turnId: turn,
                status: runtime.lastSemanticWriteTurnId === turn ||
                  (runtime.currentTurnStartedAt && runtime.lastSemanticWriteAt &&
                    Date.parse(runtime.lastSemanticWriteAt) >= Date.parse(runtime.currentTurnStartedAt))
                  ? "written" : "waiting",
                settledAt: event.at,
                remindAt: new Date(settled + 5_000).toISOString(),
                inspectAt: new Date(settled + 35_000).toISOString(),
              };
            }
            delete item.recovery;
          } else if (event.type === "turn.interrupted" ||
            event.type === "session.ended") {
            runtime.receipt = undefined;
            if (item.watchdog?.reason === "settled" ||
              item.watchdog?.reason === "protocol_missing")
              delete item.watchdog;
          } else if (event.type === "agent.blocked") {
            runtime.receipt = undefined;
          }
          item.revision = (item.revision ?? 0) + 1;
          item.updatedAt = event.at;
          return { accepted: true, goal: item, event };
        }
        case "agent.runtime.receipt": {
          const item = goal(command.goalId),
            runtime = item.agentRuntime,
            at = iso(command.at);
          if (!runtime || runtime.attempt.attemptId !== command.attemptId ||
            !runtime.receipt || runtime.receipt.turnId !== command.turnId ||
            (runtime.currentTurnId !== command.turnId &&
              runtime.currentTurnId !== runtime.receipt.reminderTurnId))
            return { updated: false, reason: "stale_receipt" };
          if (runtime.receipt.status === "written")
            return { updated: false, reason: "semantic_write_present" };
          if (command.stage === "cancelled") {
            cancelAgentReceipt(item);
            return { updated: true, goal: item };
          }
          if (command.stage === "reminding") {
            if (runtime.receipt.status !== "waiting")
              return { updated: false, reason: "reminder_in_progress" };
            runtime.receipt.status = "reminding";
            return { updated: true, goal: item };
          }
          if (command.stage === "reminded") {
            if (!["waiting", "reminding"].includes(runtime.receipt.status))
              return { updated: false, reason: "already_reminded" };
            runtime.receipt.status = "reminded";
            runtime.receipt.remindedAt = at;
            runtime.receipt.inspectAt =
              new Date(Date.parse(at) + 30_000).toISOString();
            if (command.detail)
              runtime.receipt.reminderError = text(
                command.detail,
                "回执提醒失败说明",
                1000,
              );
            else
              delete runtime.receipt.reminderError;
            activity(item, "session",
              command.detail
                ? `负责人回合结束但尚未写回；结构化回执提醒未送达：${command.detail}`
                : "负责人结束回合后尚未按协议写回，已发送一次结构化回执提醒。",
              "系统");
            return { updated: true, goal: item };
          }
          if (runtime.receipt.status !== "reminded")
            return { updated: false, reason: "reminder_not_sent" };
          runtime.receipt.status = "protocol_missing";
          runtime.receipt.missingAt = at;
          runtime.receipt.detail = command.detail
            ? text(command.detail, "回执缺失说明", 1000)
            : "负责人结束回合并收到一次提醒后，仍未提交结构化结果。";
          item.watchdog = {
            reason: "protocol_missing",
            basis: [...item.activities]
              .reverse()
              .find(activity => activity.kind !== "watchdog")?.at ??
              item.createdAt,
            detectedAt: at,
          };
          activity(item, "watchdog",
            "负责人回合已结束但未按 Crewvane 协议写回；现已交给管家核对，不据此推断完成或失败。",
            "系统");
          return { updated: true, goal: item };
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
          if (!item.herdr && !item.scene)
            throw new Error("当前目标没有可保存的负责人现场");
          item.ownerResume = preservedOwnerResume(command.resume);
          stamp(item);
          return item;
        }
        case "session.resume.capture": {
          const item = goal(command.goalId);
          if (!item.scene || ["completed", "dropped", "backlog"].includes(item.status))
            throw new Error("当前目标没有可捕获的负责人现场");
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
            // Legacy Herdr presence writers must not erase the neutral launch
            // identity. They update observations, not ownership.
            ...state.concierge,
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
          else delete concierge.detail;
          if (command.live === null) delete concierge.live;
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
        case "autonomy.inspect": {
          const at = iso(command.at);
          return state.goals.flatMap(item => {
            if (!continuationEligible(item, at)) return [];
            const continuation = item.autonomy!.continuation!;
            return [{
              goalId: item.id,
              continuationId: continuation.id,
              trigger: continuation.trigger,
              dueAt: continuation.dueAt,
              attempt: continuation.attempt,
              basisRevision: continuation.basisRevision,
              status: item.status,
            }];
          }).sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt));
        }
        case "autonomy.claim": {
          const item = goal(command.goalId),
            result = claimContinuation(
              item,
              id(command.continuationId),
              iso(command.at),
              command.leaseMs,
            );
          if (!result.claimed) return result;
          return {
            claimed: true,
            goalId: item.id,
            continuation: result.continuation,
            deliveryId: item.delivery?.id,
            candidate: item.delivery?.candidate,
          };
        }
        case "autonomy.report": {
          const item = goal(command.goalId),
            at = iso(command.at),
            result = reportContinuation(
              item,
              id(command.continuationId),
              command.outcome,
              at,
              command.detail,
              command.leaseId,
            );
          if (!result.updated) return result;
          if (command.outcome === "failed") {
            item.attention = {
              id: newId("attention"),
              kind: "intervention",
              summary: command.detail
                ? `自主续跑发送失败：${text(command.detail, "续跑失败说明", 1_000)}`
                : "自主续跑发送失败，需要你重试或接管。",
              since: at,
              source: "governance",
            };
          }
          if (command.outcome !== "sent" || command.detail) {
            activity(
              item,
              "autonomy",
              command.outcome === "sent"
                ? `续跑已发送。${command.detail ?? ""}`.trim()
                : command.outcome === "failed"
                  ? `续跑失败：${command.detail ?? "未提供原因"}`
                  : `续跑已结算。${command.detail ?? ""}`.trim(),
              "系统",
            );
          }
          return { updated: true, continuation: result.continuation };
        }
        case "watchdog.inspect":
          return inspectWatchdog(
            state.goals,
            iso(command.at),
            workspaceAutonomy(state).noProgressMinutes,
          );
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
