import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  ChevronDown,
  Clock3,
  FileText,
  ImagePlus,
  MessageSquareText,
  PauseCircle,
  PlayCircle,
  Plus,
  Radio,
  Sparkles,
  SquareTerminal,
  UserRound,
  X,
} from "lucide-react";
import type {
  Activity,
  Goal,
  GoalAttachment,
  WorkspaceState,
  SkillPackView,
} from "../../../../../packages/core/src/types.js";
import { GoalActionDock } from "./GoalActionDock.js";
import { GoalAttachments } from "./GoalAttachments.js";
import { GoalHistory } from "./GoalActivity.js";
import { GoalDeliveryEvidence } from "./GoalDeliveryEvidence.js";
import { GoalAutonomySummary } from "./GoalAutonomySummary.js";
import {
  Badge,
  Button,
  Field,
  IconButton,
  StatusPill,
  TextInput,
} from "../../ui/index.js";
import type { BadgeTone } from "../../ui/index.js";
import type { GoalReplyMode } from "./GoalReplyComposer.js";
import { presentGoal, time } from "./goalPresentation.js";
import { GoalSceneSync } from "./GoalSceneSync.js";
import { attentionRequest } from "../../../../../packages/core/src/model.js";
import type { GoalTone } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";

const goalToneBadge: Record<GoalTone, BadgeTone> = {
  running: "neutral",
  reply: "accent",
  review: "mint",
  waiting: "warm",
  blocked: "danger",
  done: "mint",
};
const runtimeEventLabels: Record<string, string> = {
  "session.started": "会话已启动",
  "turn.started": "Agent 开始处理",
  "agent.response": "收到 Agent 回复",
  "turn.settled": "Agent 回合已结束",
  "turn.interrupted": "Agent 回合已中断",
  "agent.blocked": "Agent 等待输入",
  "session.ended": "Agent 会话已结束",
};
const runtimeAdapterLabels: Record<string, string> = {
  codex: "Codex Hook",
  "claude-code": "Claude Code Hook",
  cursor: "Cursor Hook",
  qoder: "Qoder Hook",
  omp: "OMP Extension",
  custom: "Herdr 生命周期",
};

function ContextAttachments({
  goal,
  activity,
  attachments,
  service,
}: {
  goal: Goal;
  activity?: Activity;
  attachments: GoalAttachment[];
  service: GoalDetailService;
}) {
  if (!activity || !attachments.length) return null;
  return (
    <div className="context-attachments">
      {attachments.map((attachment) => (
        <button
          type="button"
          key={attachment.id}
          onClick={() => void service.openAttachment(goal.id, attachment.id)}
        >
          <ImagePlus size={13} />
          {attachment.name}
        </button>
      ))}
    </div>
  );
}

export function GoalDetail({
  goal,
  state,
  onClose,
  service,
  busy,
  removeAttachment,
  deleteGoal,
  edit,
  notify,
  error,
  submit,
}: {
  goal: Goal;
  state: WorkspaceState;
  onClose: () => void;
  service: GoalDetailService;
  busy: boolean;
  removeAttachment: (attachmentId: string) => void;
  deleteGoal: () => void;
  edit: () => void;
  notify: (text: string) => void;
  error: string;
  submit: () => void;
}) {
  const [replyMode, setReplyMode] = useState<GoalReplyMode | null>(null);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [reopenNote, setReopenNote] = useState("");
  const [methodPacks, setMethodPacks] = useState<SkillPackView[]>([]);
  const [methodPickerOpen, setMethodPickerOpen] = useState(false);
  useEffect(() => {
    if (!service.methodPacks) return;
    let current = true;
    void service.methodPacks().then(packs => {
      if (current) setMethodPacks(packs);
    }).catch(() => {});
    return () => {
      current = false;
    };
  }, [goal.id, service]);
  const view = presentGoal(goal, state);
  const descriptionCanCollapse = goal.description.trim().length > 240;
  const focusTitle = view.needsDecision
    ? goal.attention?.summary || goal.next
    : goal.status === "review"
      ? "检查成果与证据后完成验收"
      : view.dueFollowUp
        ? goal.waitingFor
          ? `确认 ${goal.waitingFor} 是否已有结果`
          : "确认等待事项是否已有结果"
        : view.needsIntervention || view.dispatchFailed
          ? goal.attention?.summary || goal.next
          : view.brief;
  const showContext =
    !!view.contextActivity &&
    !view.needsIntervention &&
    !view.dispatchFailed &&
    goal.status !== "review";
  const runtimeError =
    goal.dispatch?.status === "failed"
      ? goal.dispatch.detail
      : goal.watchdog?.lastError;
  const runtime = goal.agentRuntime;
  const observedRuntime = runtime && runtime.lastSequence > 0 ? runtime : undefined;
  const runtimeSource = observedRuntime
    ? runtimeAdapterLabels[observedRuntime.attempt.adapter] ?? "Agent 即时事件"
    : goal.live
      ? "Herdr 现场监测"
      : "巡检保护";
  const runtimeDetail = observedRuntime
    ? runtimeEventLabels[observedRuntime.lastEventType] ?? observedRuntime.lastEventType
    : goal.live
      ? `Herdr 现场状态：${
          goal.live.state === "working" ? "工作中"
            : goal.live.state === "blocked" ? "等待输入"
              : goal.live.state === "unknown" ? "状态未知"
                : "已空闲"
        }`
      : "尚未收到即时的 Agent 生命周期事件";
  const runtimeAt = observedRuntime?.lastEventAt ??
    goal.live?.checkedAt;
  const deliveryActivityId = goal.delivery
    ? [...goal.activities]
        .reverse()
        .find((activity) => activity.kind === "delivery")?.id
    : undefined;
  const conversationExcludeIds = [
    ...(showContext ? [view.contextActivity!.id] : []),
    ...(deliveryActivityId ? [deliveryActivityId] : []),
  ];

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content
          className="goal-detail-modal"
          onFocusOutside={(event) => event.preventDefault()}
        >
          <header className="goal-detail-header">
            <div className="goal-detail-origin">
              <span>
                <Sparkles size={15} />
              </span>
              <p>
                <small>{goal.mode === "concierge" ? "管家协同" : "个人推进"}</small>
                <strong>{view.projectName}</strong>
              </p>
            </div>
            <div className="goal-detail-header-actions">
              {!view.ended && (
                <button
                  type="button"
                  className="goal-scene-button"
                  disabled={busy}
                  title={
                    goal.herdr
                      ? `打开 ${goal.owner} 的 Herdr 工作现场`
                      : "打开当前工作区的管家现场"
                  }
                  onClick={() => void service.openHerdr(goal.id)}
                >
                  <SquareTerminal size={15} />
                  <span>{goal.herdr ? "回到现场" : "找管家"}</span>
                </button>
              )}
              <StatusPill tone={goalToneBadge[view.tone]}>{view.label}</StatusPill>
              <Dialog.Close asChild>
                <IconButton label="关闭">
                  <X size={18} />
                </IconButton>
              </Dialog.Close>
            </div>
          </header>
          <Dialog.Title className="visually-hidden">
            目标详情：{goal.title}
          </Dialog.Title>
          <Dialog.Description className="visually-hidden">
            当前目标结论、待办、交付证据、对话记录、附件和状态操作。
          </Dialog.Description>

          <div className="goal-detail-body">
            <article className="goal-detail-content">
              <header className="goal-detail-title">
                <h2>{goal.title}</h2>
                <div className="goal-detail-meta">
                  <span>
                    <UserRound size={12} />
                    {goal.owner}
                  </span>
                  {goal.waitingFor && (
                    <span>
                      <Clock3 size={12} />
                      等待 {goal.waitingFor}
                    </span>
                  )}
                  {goal.remindAt && (
                    <span>
                      <Clock3 size={12} />
                      {time(goal.remindAt)} 跟进
                    </span>
                  )}
                  {goal.status === "review" && (
                    <span>第 {goal.reviewRounds ?? 1} 轮审查</span>
                  )}
                  {goal.autonomy?.paused && <span>自主续跑已暂停</span>}
                  <time>{time(goal.updatedAt)} 更新</time>
                </div>
              </header>

              <section
                className={`goal-focus ${view.tone}`}
                aria-label="现在需要你关注的事"
              >
                <div className="goal-focus-copy">
                  <span>{view.label}</span>
                  <h3>{focusTitle}</h3>
                  <p>{view.detail}</p>
                </div>
                <div className="goal-focus-next">
                  <small>{view.nextLabel}</small>
                  <p>{goal.next || "暂无记录，等待管家更新。"}</p>
                </div>
              </section>

              <GoalSceneSync goal={goal} view={view} service={service} busy={busy} />
              <GoalAutonomySummary
                goal={goal}
                state={state}
                service={service}
                busy={busy}
                notify={notify}
              />
              {(
                <section
                  className="goal-agent-runtime"
                  aria-label="Agent 运行状态"
                >
                  <header>
                    <span>
                      <Radio size={14} aria-hidden="true" />
                    </span>
                    <div>
                      <strong>{runtimeSource}</strong>
                      <small
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        {runtimeDetail}
                        {runtimeAt ? ` · ${time(runtimeAt)}` : ""}
                      </small>
                    </div>
                    {runtime?.receipt?.status === "waiting" && <Badge tone="neutral">检查回执</Badge>}
                    {runtime?.receipt?.status === "reminding" && <Badge tone="accent">发送提醒</Badge>}
                    {runtime?.receipt?.status === "reminded" && <Badge tone="warm">已提醒写回</Badge>}
                    {runtime?.receipt?.status === "protocol_missing" && <Badge tone="danger">回执缺失</Badge>}
                  </header>
                  {runtime?.lastReply ? (
                    <p>
                      <MessageSquareText size={13} aria-hidden="true" />
                      <span>{runtime.lastReply.text}</span>
                    </p>
                  ) : (
                    <p className="muted">
                      {runtime
                        ? "等待负责人提交近期回复或结构化进展。"
                        : goal.live
                          ? "Herdr 状态保持可用；目标完成、等待外部和找人决定仍以 Crewvane 结构化为准。"
                          : "Hook 不可用时由 Herdr 与巡检完整兜底，不会阻止目标继续执行。"}
                    </p>
                  )}
                </section>
              )}
              {(goal.skills?.length || methodPacks.some(pack =>
                pack.source === "local" && pack.status !== "missing")) && (
                <section className="goal-methods" aria-label="这个目标使用的工作方法">
                  <header>
                    <span><Sparkles size={14} aria-hidden="true" /></span>
                    <div>
                      <strong>工作方法</strong>
                      <small>只作用于这个目标，可随时移除</small>
                    </div>
                    {!view.ended && service.methodPacks && (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Plus size={14} />}
                        disabled={busy}
                        onClick={() => {
                          setMethodPickerOpen(open => !open);
                          void service.methodPacks?.().then(setMethodPacks).catch(() => {});
                        }}
                      >
                        添加
                      </Button>
                    )}
                  </header>
                  {!!goal.skills?.length && (
                    <div className="goal-method-chips">
                      {goal.skills.map(binding => {
                        const current = methodPacks.find(pack =>
                          pack.id === binding.packId && pack.source === "local");
                        const unavailable =
                          !current ||
                          current.status === "missing" ||
                          current.status === "disabled" ||
                          (current.digest && current.digest !== binding.digest);
                        return (
                          <span
                            className={`goal-method-chip ${unavailable ? "unavailable" : ""}`}
                            key={binding.packId}
                            title={`${binding.packId}@${binding.version}`}
                          >
                            <Sparkles size={12} />
                            {current?.name ?? binding.packId}
                            {unavailable && <small>需重新挂载</small>}
                            {!view.ended && (
                              <button
                                type="button"
                                aria-label={`移除 ${current?.name ?? binding.packId}`}
                                disabled={busy}
                                onClick={async () => {
                                  try {
                                    await service.command({
                                      type: "goal.skill.detach",
                                      goalId: goal.id,
                                      packId: binding.packId,
                                      actor: "human",
                                    });
                                    notify(`已从这个目标移除 ${current?.name ?? binding.packId}`);
                                  } catch {
                                    // The shared command surface reports the error.
                                  }
                                }}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {methodPickerOpen && !view.ended && (
                    <div className="goal-method-picker">
                      {methodPacks.filter(pack =>
                        pack.source === "local" &&
                        ["ready", "needs-approval"].includes(pack.status) &&
                        !goal.skills?.some(binding => binding.packId === pack.id)).length ? (
                        methodPacks
                          .filter(pack =>
                            pack.source === "local" &&
                            ["ready", "needs-approval"].includes(pack.status) &&
                            !goal.skills?.some(binding => binding.packId === pack.id))
                          .map(pack => (
                            <button
                              type="button"
                              key={pack.id}
                              disabled={busy}
                              onClick={async () => {
                                try {
                                  await service.command({
                                    type: "goal.skill.attach",
                                    goalId: goal.id,
                                    packId: pack.id,
                                    actor: "human",
                                  });
                                  setMethodPickerOpen(false);
                                  notify(`已为这个目标添加「${pack.name}」`);
                                } catch {
                                  // The shared command surface reports the error.
                                }
                              }}
                            >
                              <strong>{pack.name}</strong>
                              <span>{pack.description}</span>
                              {pack.status === "needs-approval" && <small>包含未授权脚本；说明仍可使用</small>}
                            </button>
                          ))
                      ) : (
                        <p>
                          还没有可用的本地工作方法。可在设置安装，或让 Agent 使用
                          「crewvane-local-pack-author」创建。
                        </p>
                      )}
                    </div>
                  )}
                </section>
              )}
              {showContext && (
                <section className="goal-handoff" aria-label="最近一次交接">
                  <header>
                    <span>
                      <Bot size={14} />
                    </span>
                    <div>
                      <strong>{view.contextActivity!.actor}</strong>
                      <small>
                        最近交接 · {time(view.contextActivity!.at)}
                      </small>
                    </div>
                  </header>
                  <p>{view.contextActivity!.text}</p>
                  <ContextAttachments
                    goal={goal}
                    activity={view.contextActivity}
                    attachments={view.contextAttachments}
                    service={service}
                  />
                </section>
              )}

              <GoalDeliveryEvidence goal={goal} service={service} />

              <section className="goal-original">
                <header>
                  <span>
                    <FileText size={14} />
                    目标说明
                  </span>
                  {descriptionCanCollapse && (
                    <button
                      type="button"
                      onClick={() => setDescriptionOpen((open) => !open)}
                    >
                      {descriptionOpen ? "收起" : "展开全文"}
                    </button>
                  )}
                </header>
                <p className={descriptionOpen ? "" : "clamped"}>
                  {goal.description || "创建目标时没有附加说明。"}
                </p>
              </section>

              {!!goal.attachments?.length && (
                <GoalAttachments
                  goalId={goal.id}
                  attachments={goal.attachments}
                  service={service}
                  remove={removeAttachment}
                />
              )}

              {runtimeError && (
                <details className="goal-runtime-note">
                  <summary>
                    运行时连接有问题
                    <ChevronDown size={14} />
                  </summary>
                  <p>{runtimeError}</p>
                </details>
              )}

              <details className="manual-tools goal-detail-advanced">
                <summary>
                  目标管理
                  <ChevronDown size={14} />
                </summary>
                <p>用于人工接管、纠正记录或结束目标。日常推进优先使用底部操作。</p>
                <div className="modal-actions">
                  <Button variant="secondary" disabled={busy} onClick={edit}>
                    编辑目标
                  </Button>
                  {goal.status !== "review" && (
                    <Button variant="secondary" disabled={busy} onClick={submit}>
                      提交成果
                    </Button>
                  )}
                  {!view.ended && goal.mode === "concierge" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          await service.command({
                            type: "goal.takeover",
                            goalId: goal.id,
                          });
                          notify("已由你接管，不会再向管家发送后续更新");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      我来处理
                    </Button>
                  )}
                  {!view.ended && goal.mode === "concierge" &&
                    Boolean(goal.brief || goal.autonomy) && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      icon={goal.autonomy?.paused
                        ? <PlayCircle size={15} />
                        : <PauseCircle size={15} />}
                      onClick={async () => {
                        try {
                          await service.command({
                            type: goal.autonomy?.paused
                              ? "goal.autonomy.resume"
                              : "goal.autonomy.pause",
                            goalId: goal.id,
                            actor: "你",
                          });
                          notify(goal.autonomy?.paused
                            ? "已恢复自主续跑"
                            : "已暂停新的自主续跑；当前回合不会被强制终止");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      {goal.autonomy?.paused ? "恢复自主推进" : "暂停自主推进"}
                    </Button>
                  )}
                  {!view.ended && goal.mode === "manual" && (
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          await service.command({
                            type: "goal.delegate",
                            goalId: goal.id,
                          });
                          notify("已重新交给管家");
                        } catch {
                          // The application-level command surface reports the real error.
                        }
                      }}
                    >
                      交给管家
                    </Button>
                  )}
                  {view.ended ? (
                    <Button variant="danger" disabled={busy} onClick={deleteGoal}>
                      永久删除目标
                    </Button>
                  ) : (
                    <Button variant="danger" disabled={busy} onClick={() => setReplyMode("drop")}>
                      放弃目标
                    </Button>
                  )}
                </div>
                {view.ended && (
                  <form
                    className="goal-reopen-form"
                    onSubmit={async event => {
                      event.preventDefault();
                      try {
                        await service.command({
                          type: "goal.reopen",
                          goalId: goal.id,
                          note: reopenNote,
                          actor: "你",
                        });
                        setReopenNote("");
                        notify("目标已重新打开，保留原记录与证据");
                      } catch {
                        // The application-level command surface reports the real error.
                      }
                    }}
                  >
                    <Field label="重新打开原因">
                      <TextInput
                        value={reopenNote}
                        onChange={event => setReopenNote(event.target.value)}
                        placeholder="例如：复核遗漏了真实环境，需要继续修复。"
                      />
                    </Field>
                    <Button
                      type="submit"
                      variant="secondary"
                      disabled={busy || !reopenNote.trim()}
                    >
                      重新打开
                    </Button>
                  </form>
                )}
              </details>
            </article>

            <aside className="goal-detail-context">
              <GoalHistory
                goal={goal}
                latestIds={conversationExcludeIds}
                service={service}
              />
            </aside>
          </div>

          <footer className={`goal-action-dock ${view.tone}`}>
            <GoalActionDock
              key={replyMode === "message" ? "message" : attentionRequest(goal)?.id}
              goal={goal}
              view={view}
              service={service}
              busy={busy}
              error={error}
              replyMode={replyMode}
              setReplyMode={setReplyMode}
              notify={notify}
            />
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
