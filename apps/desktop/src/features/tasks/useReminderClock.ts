import { useEffect, useState } from "react";
import type { Goal } from "../../../../../packages/core/src/types.js";

/** A quiet workspace still needs to render when its next reminder becomes due. */
export function useReminderClock(goals: Goal[]) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let next = Infinity;
    for (const goal of goals) {
      if (["completed", "dropped"].includes(goal.status) || !goal.remindAt) continue;
      const at = Date.parse(goal.remindAt);
      if (at > now && at < next) next = at;
    }
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setTick(value => value + 1),
      Math.min(2_147_483_647, Math.max(1, next - now + 20)));
    return () => window.clearTimeout(timer);
  }, [goals, tick]);
}
