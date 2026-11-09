import type { Goal } from "../../../../../packages/core/src/types.js";
import { Button } from "../../ui/index.js";
import type { GoalPresentation } from "./goalPresentation.js";
import type { GoalDetailService } from "./goalService.js";
import { attentionRequest } from "../../../../../packages/core/src/model.js";

export function GoalSceneSync({ goal, view, service, busy }: {
  goal: Goal; view: GoalPresentation; service: GoalDetailService; busy: boolean;
}) {
  const sync = view.sceneSync;
  const visited = goal.sceneVisit?.attentionId === attentionRequest(goal)?.id &&
    goal.sceneVisit?.status === "watching";
  if (!sync && !visited) return null;
  if (!sync) return (
    <section className="goal-handoff" aria-label="现场答复同步">
      <p>仅查看现场不会变更事项。如果已经在现场处理，可以请负责人核对结果。</p>
      <Button variant="secondary" disabled={busy || goal.live?.state === "working"} onClick={async () => {
        try { await service.command({ type: "scene.visit", goalId: goal.id, retry: true }); }
        catch { /* Shared command service reports the failure. */ }
      }}>同步现场处理结果</Button>
    </section>
  );
  return (
    <section className="goal-handoff" aria-label="现场答复同步">
      <strong>{sync.quote ? "你在现场的答复" : sync.label}</strong>
      {sync.quote && <blockquote>{sync.quote}</blockquote>}
      {sync.summary && <p>{sync.summary}</p>}
      <p>{sync.detail}</p>
      {sync.retry && (
        <Button variant="secondary" disabled={busy} onClick={async () => {
          try {
            if (sync.retry === "dispatch") await service.retryDispatch(goal.id);
            else await service.command({ type: "scene.visit", goalId: goal.id, retry: true });
          } catch { /* The shared command service surfaces the actual failure. */ }
        }}>重试同步</Button>
      )}
    </section>
  );
}
