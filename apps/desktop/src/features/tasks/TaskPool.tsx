import { useState } from "react";
import { Check, ChevronRight, NotebookPen, Plus } from "lucide-react";
import { attentionKind } from "../../../../../packages/core/src/model.js";
import { taskPoolGoals } from "../../../../../packages/core/src/task-pool.js";
import type { Goal, IntakeHandling } from "../../../../../packages/core/src/types.js";
import { Button, ChoiceGroup, EmptyState, StatusPill, TextInput } from "../../ui/index.js";
import { time } from "../goals/goalPresentation.js";

export function TaskPool({ goals, open, create, section, onSection }: {
  goals: Goal[];
  open: (goalId: string) => void;
  create: (handling: IntakeHandling) => void;
  section: "later" | "self";
  onSection: (section: "later" | "self") => void;
}) {
  const [query, setQuery] = useState("");
  const later = taskPoolGoals(goals, "later"), self = taskPoolGoals(goals, "self");
  const visible = (section === "later" ? later : self).filter(goal =>
    `${goal.title} ${goal.description} ${goal.next}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="content">
      <section className="intro">
        <div>
          <span className="eyebrow">留一点余地</span>
          <h1>先记下来，<em>不必现在开始。</em></h1>
          <p>还没准备好的放这里。自己要做的，也不用交给 Agent。</p>
        </div>
      </section>
      <div className="task-pool-overview" aria-label="待办概览">
        <span><strong>{later.length}</strong> 件待安排</span>
        <i aria-hidden="true" />
        <span><strong>{self.length}</strong> 件由你推进</span>
      </div>
      <div className="filter-bar">
        <ChoiceGroup label="待办池分类" value={section} onChange={onSection}
          options={[{ value: "later", label: `先记下 ${later.length}` }, { value: "self", label: `我来做 ${self.length}` }]} />
        <TextInput className="filter-search" aria-label="搜索待办" placeholder="搜索待办…"
          value={query} onChange={event => setQuery(event.target.value)} />
      </div>
      <div className="goal-list">
        {visible.map(goal => (
          <button className="goal-row" type="button" key={goal.id} onClick={() => open(goal.id)}>
            <span className={`goal-dot ${goal.status}`} />
            <div className="goal-row-copy">
              <strong>{goal.title}</strong>
              <p>{goal.remindAt ? `${time(goal.remindAt)} 提醒 · ` : ""}{goal.description}</p>
              <small>
                你
                <span aria-hidden="true">·</span>
                {time(goal.updatedAt)} 更新
              </small>
            </div>
            <StatusPill tone={attentionKind(goal) ? "warm" : "neutral"}>
              {attentionKind(goal) === "follow_up" ? "提醒到期" : attentionKind(goal) ? "需要处理" : section === "later" ? "尚未开始" : "我来做"}
            </StatusPill>
            <ChevronRight />
          </button>
        ))}
        {!visible.length && (
          <EmptyState icon={section === "later" ? <NotebookPen size={19} /> : <Check size={19} />}
            title={query ? "没有找到这件事" : section === "later" ? "想到了就先放下" : "留给自己做的事"}
            description={query ? "换个关键词试试。" : section === "later"
              ? "只记录，不启动 Agent。准备好后再决定下一步。"
              : "记录之后自己安排，做完即可标记完成。"}
            action={!query && <Button size="sm" variant="secondary" icon={<Plus size={14} />}
              onClick={() => create(section)}>{section === "later" ? "记一件事" : "记一件我来做的事"}</Button>} />
        )}
      </div>
    </div>
  );
}
