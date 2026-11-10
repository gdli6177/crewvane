import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  FileText,
  Sparkles,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import type { Goal, WorkspaceState } from "../../../../../packages/core/src/types.js";
import { GoalActionDock } from "./GoalActionDock.js";
import { GoalDeliveryEvidence } from "./GoalDeliveryEvidence.js";
import { GoalAttachments } from "./GoalAttachments.js";
import { GoalSceneSync } from "./GoalSceneSync.js";
import type { GoalReplyMode } from "./GoalReplyComposer.js";
import { presentGoal, time } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";
import { attentionRequest } from "../../../../../packages/core/src/model.js";
import { IconButton } from "../../ui/index.js";

export function GoalAttentionCard({
  goal,
  state,
  service,
  busy,
  error,
  onClose,
  openDetails,
  notify,
}: {
  goal: Goal;
  state: WorkspaceState;
  service: GoalDetailService;
  busy: boolean;
  error: string;
  onClose: () => void;
  openDetails: () => void;
  notify: (text: string) => void;
}) {
  const [replyMode, setReplyMode] = useState<GoalReplyMode | null>(null);
  const view = presentGoal(goal, state);
  const active = view.needsDecision || view.needsIntervention || view.dueFollowUp || view.dispatchFailed || goal.status === "review";
  useEffect(() => {
    if (!active) onClose();
  }, [active]);
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className={`goal-attention-modal ${view.tone}`}>
          <header className="goal-attention-header">
            <div className="goal-detail-origin">
              <span><Sparkles size={15} /></span>
              <p><small>ATTENTION · {view.projectName}</small><strong>{view.label}</strong></p>
            </div>
            <div className="goal-detail-header-actions">
              <button type="button" className="goal-scene-button" disabled={busy}
                title={goal.herdr ? `打开 ${goal.owner} 的 Herdr 工作现场` : "打开当前工作区的管家现场"}
                onClick={() => void service.openHerdr(goal.id)}>
                <SquareTerminal size={15} /><span>{goal.herdr ? "回到现场" : "找管家"}</span>
              </button>
              <Dialog.Close asChild><IconButton label="关闭"><X size={18} /></IconButton></Dialog.Close>
            </div>
          </header>
          <Dialog.Title className="goal-attention-title">{goal.title}</Dialog.Title>
          <Dialog.Description className="goal-attention-description">
            只展示此刻需要的依据和操作。完整目标记录随时可查。
          </Dialog.Description>
          <div className="goal-attention-body">
            <section className={`attention-action-focus ${view.tone}`} aria-label="当前需要处理的事项">
              {view.needsDecision ? <Zap size={18} /> : goal.status === "review" ? <Check size={18} /> :
                view.dueFollowUp ? <Clock3 size={18} /> : <CircleAlert size={18} />}
              <div>
                <small>{view.label}</small>
                <h2>{goal.attention?.summary || (goal.status === "review" ? "核对实际成果后验收" : goal.next)}</h2>
                {!view.sceneSync && <p>{view.detail}</p>}
              </div>
            </section>
            <GoalSceneSync goal={goal} view={view} service={service} busy={busy} />
            {view.needsDecision && !view.sceneSync && view.contextActivity && (
              <section className="goal-handoff attention-evidence" aria-label="决定依据">
                <header><span><Bot size={14} /></span><div><strong>{view.contextActivity.actor}</strong><small>负责人交接 · {time(view.contextActivity.at)}</small></div></header>
                <p>{view.contextActivity.text}</p>
              </section>
            )}
            {goal.status === "review" && <GoalDeliveryEvidence goal={goal} service={service} />}
            {view.dueFollowUp && (
              <div className="attention-next-step">
                <span>当前下一步</span><p>{goal.next || "等待管家更新下一步。"}</p>
                <small>{goal.waitingFor ? `等待外部：${goal.waitingFor}` : "按你设定的时间提醒"}{goal.remindAt ? ` · ${time(goal.remindAt)} 到期` : ""}</small>
              </div>
            )}
            {!!goal.attachments?.length && (view.needsDecision || goal.status === "review") && (
              <details className="attention-attachments">
                <summary>查看目标图片（{goal.attachments.length}）<ChevronRight size={14} /></summary>
                <GoalAttachments goalId={goal.id} attachments={goal.attachments} service={service} readOnly />
              </details>
            )}
            {error && <p className="goal-inline-error" role="alert">{error}</p>}
          </div>
          <footer className={`goal-action-dock ${view.tone}`}>
            <GoalActionDock key={attentionRequest(goal)?.id} goal={goal} view={view} service={service} busy={busy} error={error}
              replyMode={replyMode} setReplyMode={setReplyMode} notify={notify} />
          </footer>
          <footer className="goal-attention-footer">
            <span><FileText size={13} /> 终端原文留在现场，不作为验收依据。</span>
            <button type="button" onClick={openDetails}>完整记录 <ChevronRight size={14} /></button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
