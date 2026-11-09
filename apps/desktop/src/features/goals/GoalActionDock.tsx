import { useState } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  Clock3,
  SquareTerminal,
  UserRound,
} from "lucide-react";
import type { CrewvaneCommand, Goal } from "../../../../../packages/core/src/types.js";
import {
  GoalReplyComposer,
  type GoalReplyMode,
} from "./GoalReplyComposer.js";
import { Button } from "../../ui/index.js";
import type { GoalPresentation } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";
import { attentionRequest } from "../../../../../packages/core/src/model.js";

export function GoalActionDock({
  goal,
  view,
  service,
  busy,
  error,
  replyMode,
  setReplyMode,
  notify,
}: {
  goal: Goal;
  view: GoalPresentation;
  service: GoalDetailService;
  busy: boolean;
  error: string;
  replyMode: GoalReplyMode | null;
  setReplyMode: (mode: GoalReplyMode | null) => void;
  notify: (text: string) => void;
}) {
  const [decisionText, setDecisionText] = useState("");
  const [manualDecision, setManualDecision] = useState(false);

  async function act(command: CrewvaneCommand, receipt?: string) {
    try {
      const attentionId = attentionRequest(goal)?.id;
      await service.command(attentionId ? { ...command, attentionId } : command);
      if (receipt) notify(receipt);
      return true;
    } catch {
      return false;
    }
  }

  async function snooze() {
    await act(
      {
        type: "goal.remind",
        goalId: goal.id,
        at: new Date(Date.now() + 3_600_000).toISOString(),
        note: goal.next,
      },
      "1 小时后再提醒你",
    );
  }

  if (replyMode) {
    return (
      <GoalReplyComposer
        goal={goal}
        mode={replyMode}
        busy={busy}
        error={error}
        service={service}
        routeToConcierge={
          replyMode === "message" &&
          goal.status === "waiting" &&
          goal.mode !== "concierge"
        }
        onClose={() => setReplyMode(null)}
        onComplete={(receipt) => {
          setReplyMode(null);
          notify(receipt);
        }}
      />
    );
  }

  if (view.sceneSync?.quote && !manualDecision) {
    return (
      <div className="goal-quiet-row">
        <span><Bot size={18} /></span>
        <div>
          <strong>现场答复已保存</strong>
          <small>由管家核对并更新状态，无需再填一遍。你仍可补充情况或直接处理。</small>
        </div>
        <div className="goal-action-buttons">
          <Button variant="secondary" onClick={() => setReplyMode("message")}>补充意见</Button>
          <Button variant="ghost" onClick={() => setManualDecision(true)}>直接处理</Button>
        </div>
      </div>
    );
  }

  if (view.needsDecision) {
    return (
      <form
        className="goal-decision-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await act(
              {
                type: "goal.resolve",
                goalId: goal.id,
                note: decisionText,
                actor: "你",
                outcome: "approved",
                source: "desktop",
              },
              "已记入批准账本，正在通知管家",
            )
          ) {
            setDecisionText("");
          }
        }}
      >
        <div className="goal-action-copy">
          <span>记录你的决定</span>
          <strong>写下你的原话；批准或拒绝都会记入决定账本。</strong>
        </div>
        <textarea
          aria-label="你的决定"
          value={decisionText}
          onChange={(event) => setDecisionText(event.target.value)}
          placeholder="写下你的原话；批准或拒绝都会进入决定账本。"
        />
        <div className="goal-action-buttons">
          <Button variant="secondary" onClick={() => setReplyMode("message")}>
            补充意见
          </Button>
          <Button
            variant="danger"
            disabled={busy || !decisionText.trim()}
            onClick={() =>
              void act(
                {
                  type: "goal.resolve",
                  goalId: goal.id,
                  note: decisionText,
                  actor: "你",
                  outcome: "rejected",
                  source: "desktop",
                },
                "已记入拒绝账本，正在通知管家",
              )
            }
          >
            拒绝
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !decisionText.trim()}>
            批准并继续
          </Button>
        </div>
      </form>
    );
  }

  if (goal.status === "review") {
    return (
      <div className="goal-decision-row">
        <div className="goal-action-copy">
          <span>明确验收</span>
          <strong>通过后目标结束；需要修改就退回并说明。</strong>
        </div>
        <div className="goal-action-buttons">
          <Button variant="secondary" onClick={() => setReplyMode("message")}>
            问管家
          </Button>
          <Button variant="secondary" onClick={() => setReplyMode("return")}>
            退回修改
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            icon={<Check size={15} />}
            onClick={() =>
              void act(
                {
                  type: "goal.accept",
                  goalId: goal.id,
                  note: "已查看成果与检查记录，验收通过。",
                },
                "验收完成，这件事可以放下了",
              )
            }
          >
            验收通过
          </Button>
        </div>
      </div>
    );
  }

  if (view.dispatchFailed) {
    return (
      <div className="goal-quiet-row blocked">
        <span>
          <CircleAlert size={18} />
        </span>
        <div>
          <strong>还没有联系上管家</strong>
          <small>目标已经安全保存，恢复连接后可以直接重试。</small>
        </div>
        <div className="goal-action-buttons">
          <Button variant="secondary" onClick={() => setReplyMode("message")}>
            先留言
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              try {
                await service.retryDispatch(goal.id);
                notify("正在重新联系管家");
              } catch {
                // The application-level command surface reports the real error.
              }
            }}
          >
            重试联系管家
          </Button>
        </div>
      </div>
    );
  }

  if (view.needsIntervention) {
    return (
      <div className="goal-quiet-row blocked">
        <span>
          <CircleAlert size={18} />
        </span>
        <div>
          <strong>负责人现场需要你处理</strong>
          <small>{goal.attention?.summary || goal.next}</small>
        </div>
        <div className="goal-action-buttons">
          <Button variant="secondary" onClick={() => setReplyMode("message")}>
            告诉管家
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            icon={<SquareTerminal size={15} />}
            onClick={() => void service.openHerdr(goal.id)}
          >
            {goal.herdr ? "打开工作现场" : "找管家"}
          </Button>
        </div>
      </div>
    );
  }

  if (view.dueFollowUp) {
    return (
      <GoalReplyComposer
        goal={goal}
        mode="message"
        busy={busy}
        error={error}
        service={service}
        inline
        dismissible={false}
        autoFocus={false}
        heading="把现在的情况告诉管家"
        placeholder={
          goal.waitingFor
            ? `例如：${goal.waitingFor} 已有结果、仍在等，或这件事已经结束。`
            : "例如：已经收到结果、仍在等，或这件事已经结束。"
        }
        note="你只描述情况；是否继续等待、推进、验收或结束，由管家判断。"
        submitLabel="交给管家"
        successMessage="已交给管家；管家会读取你的原话并判断下一步。"
        routeToConcierge={goal.mode !== "concierge"}
        secondaryAction={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void snooze()}>
            1 小时后提醒
          </Button>
        }
        onClose={() => undefined}
        onComplete={notify}
      />
    );
  }

  if (goal.status === "waiting") {
    return (
      <div className="goal-quiet-row waiting">
        <span>
          <Clock3 size={18} />
        </span>
        <div>
          <strong>现在不用处理</strong>
          <small>
            {goal.waitingFor ? `正在等待 ${goal.waitingFor}。` : "正在等待外部结果。"}
            {goal.next ? ` ${goal.next}` : ""}
          </small>
        </div>
        <div className="goal-action-buttons">
          <Button variant="primary" onClick={() => setReplyMode("message")}>
            告诉管家
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void snooze()}
          >
            1 小时后提醒
          </Button>
        </div>
      </div>
    );
  }

  if (view.ended) {
    return (
      <div className="goal-quiet-row done">
        <span>
          <Check size={18} />
        </span>
        <div>
          <strong>{view.label}</strong>
          <small>目标记录和附件仍可回看。</small>
        </div>
      </div>
    );
  }

  return (
    <div className="goal-quiet-row">
      <span>
        {goal.mode === "concierge" ? <Bot size={18} /> : <UserRound size={18} />}
      </span>
      <div>
        <strong>{goal.mode === "concierge" ? "管家正在处理" : "由你继续处理"}</strong>
        <small>
          {goal.mode === "concierge"
            ? "注意力面板只显示真正需要你的改变。"
            : "补充进展、更新安排，完成后再提交验收。"}
        </small>
      </div>
      <div className="goal-action-buttons">
        <Button variant="secondary" onClick={() => setReplyMode("message")}>
          {goal.mode === "concierge" ? "给管家留言" : "补充说明"}
        </Button>
      </div>
    </div>
  );
}
