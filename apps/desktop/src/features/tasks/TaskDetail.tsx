import { useState } from "react";
import { Check, Clock3, Send } from "lucide-react";
import type { CrewvaneCommand, Goal } from "../../../../../packages/core/src/types.js";
import { attentionRequest } from "../../../../../packages/core/src/model.js";
import type { GoalDetailService } from "../goals/goalService.js";
import { GoalAttachments } from "../goals/GoalAttachments.js";
import { GoalHistory } from "../goals/GoalActivity.js";
import { time } from "../goals/goalPresentation.js";
import { Button, Card, Field, Modal, StatusPill, TextArea, TextInput } from "../../ui/index.js";

export function TaskDetail({ goal, service, busy, error, close, delegated, notify }: {
  goal: Goal;
  service: GoalDetailService;
  busy: boolean;
  error: string;
  close: () => void;
  delegated: () => void;
  notify: (message: string) => void;
}) {
  const [note, setNote] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const later = goal.status === "backlog";
  const ended = goal.status === "completed" || goal.status === "dropped";
  const request = attentionRequest(goal);
  async function act(command: CrewvaneCommand, message: string, done?: () => void) {
    try {
      await service.command(request ? { ...command, attentionId: request.id } : command);
      notify(message);
      done?.();
    } catch {
      // The service reports errors and leaves the draft visible.
    }
  }
  return (
    <Modal title={goal.title} description={later ? "先记下，准备好再开始。" : ended ? "记录已保留。" : "由你安排，做完即可。"}
      error={error} onClose={close}>
      <div className="ui-form">
        <div className="task-meta">
          <StatusPill tone={ended ? "mint" : request ? "warm" : "neutral"}>
            {ended ? goal.status === "dropped" ? "已移出" : "已完成" : later ? "尚未开始" : "我来做"}
          </StatusPill>
          {goal.remindAt && <span><Clock3 size={14} />{time(goal.remindAt)} 提醒</span>}
        </div>
        <Card tone="soft"><p className="task-description">{goal.description}</p></Card>
        {goal.status === "waiting" && <Card tone="soft"><p className="task-description">
          {goal.waitingFor ? `等待外部：${goal.waitingFor}。` : "正在等待外部结果。"} {goal.next}
        </p></Card>}
        {request && (
          <Card tone="warm">
            <p className="task-description">{later ? "到提醒时间了。现在开始，或继续放着，都由你决定。" : "到了你设定的提醒时间。"}</p>
            <div className="task-actions">
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act(
                { type: "goal.resolve", goalId: goal.id, note: "提醒已处理，原安排保持不变。" }, "提醒已处理")}>知道了</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(
                { type: "goal.remind", goalId: goal.id, at: new Date(Date.now() + 3_600_000).toISOString() },
                "1 小时后提醒")}>1 小时后提醒</Button>
            </div>
          </Card>
        )}
        {!!goal.attachments?.length && <GoalAttachments goalId={goal.id} attachments={goal.attachments} service={service} readOnly />}
        {!ended && (
          <>
            <div className="task-actions">
              {goal.herdr && <Button variant="ghost" size="sm" disabled={busy}
                onClick={() => void service.openHerdr(goal.id)}>回到现场</Button>}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setNotesOpen(!notesOpen)}>补充说明</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setReminderOpen(!reminderOpen)}>
                {goal.remindAt ? "修改提醒" : "提醒我"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(
                { type: "goal.drop", goalId: goal.id, note: "你已将这件事移出待办池。" },
                "已移出，可在全部目标的已放弃记录中恢复", close)}>移出待办池</Button>
            </div>
            {notesOpen && (
              <form className="ui-form" onSubmit={event => {
                event.preventDefault();
                void act({ type: "goal.message", goalId: goal.id, text: note },
                  "说明已记录，不会启动 Agent", () => { setNote(""); setNotesOpen(false); });
              }}>
                <Field label="补充说明" htmlFor="task-note">
                  <TextArea id="task-note" value={note} onChange={event => setNote(event.target.value)}
                    required maxLength={12000} autoFocus placeholder="只记背景，不必现在想清楚…" />
                </Field>
                <Button type="submit" size="sm" variant="secondary" disabled={busy || !note.trim()}>保存说明</Button>
              </form>
            )}
            {reminderOpen && (
              <form className="ui-form" onSubmit={event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void act({ type: "goal.remind", goalId: goal.id, at: new Date(String(data.get("at"))).toISOString() },
                  "提醒已设置；到期会出现在注意力", () => setReminderOpen(false));
              }}>
                <Field label="提醒时间" hint="只提醒你，不自动启动 Agent。" htmlFor="task-reminder">
                  <TextInput id="task-reminder" name="at" type="datetime-local" required
                    defaultValue={goal.remindAt ? localDateTime(goal.remindAt) : localDateTime(new Date(Date.now() + 86400_000).toISOString())} />
                </Field>
                <div className="task-actions">
                  <Button type="submit" size="sm" variant="secondary" disabled={busy}>保存提醒</Button>
                  {goal.remindAt && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(
                    { type: "goal.update", goalId: goal.id, patch: { remindAt: null } },
                    "提醒已取消", () => setReminderOpen(false))}>取消提醒</Button>}
                </div>
              </form>
            )}
          </>
        )}
        <details className="manual-tools">
          <summary>记录与补充（{goal.activities.length}）</summary>
          <GoalHistory goal={goal} latestIds={[]} service={service} />
        </details>
        <div className="modal-actions">
          {ended ? (
            <>
              {goal.status === "dropped" && !goal.herdr && <Button variant="secondary" disabled={busy} onClick={() => void act(
                { type: "goal.restore", goalId: goal.id }, "已恢复到待办池", close)}>恢复到待办池</Button>}
              <Button variant="danger" disabled={busy} onClick={() => {
                if (window.confirm("永久删除这条记录与附件？此操作无法恢复。"))
                  void act({ type: "goal.delete", goalId: goal.id }, "记录已永久删除", close);
              }}>永久删除</Button>
            </>
          ) : (
            <>
              {later ? <Button variant="secondary" disabled={busy} onClick={() => void act(
                { type: "goal.takeover", goalId: goal.id }, "已放入我来做")}>我来做</Button> : null}
              <Button variant={later ? "primary" : "secondary"} disabled={busy} icon={<Send size={14} />}
                onClick={() => void act({ type: "goal.delegate", goalId: goal.id }, "已交给管家，正在安排负责人", delegated)}>交给管家</Button>
              {!later && <Button variant="primary" disabled={busy} icon={<Check size={15} />}
                onClick={() => void act({ type: "goal.complete", goalId: goal.id, note: "你已确认这件事完成。" },
                  "已完成，可以放下了", close)}>标记完成</Button>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function localDateTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
