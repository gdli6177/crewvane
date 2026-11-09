import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  ChevronDown,
  Clock3,
  FileText,
  ImagePlus,
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
} from "../../../../../packages/core/src/types.js";
import { GoalActionDock } from "./GoalActionDock.js";
import { GoalAttachments } from "./GoalAttachments.js";
import { GoalHistory } from "./GoalActivity.js";
import { GoalDeliveryEvidence } from "./GoalDeliveryEvidence.js";
import { Button, IconButton, StatusPill } from "../../ui/index.js";
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
              key={attentionRequest(goal)?.id}
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
