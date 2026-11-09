import { attentionRequest, pendingSceneReply } from "./model.js";
import type { Goal, LivePresence } from "./types.js";

// This observes a work cycle, never its meaning. Only the owner can write a
// semantic receipt, and only a separate state command resolves the question.
export function observeSceneWork(goal: Goal, presence: LivePresence) {
  const visit = goal.sceneVisit;
  if (!visit || visit.status !== "watching" || goal.mode !== "concierge" ||
    visit.attentionId !== attentionRequest(goal)?.id || pendingSceneReply(goal) ||
    presence.reachable !== true || Date.parse(presence.checkedAt) < Date.parse(visit.at)) return;
  if (presence.state === "working") visit.worked = true;
  if (visit.worked && ["idle", "done"].includes(presence.state)) visit.status = "pending";
}
