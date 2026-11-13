import type { BackendHandoff, Goal } from "../../../packages/core/src/index.js";

export interface BackendHandoffEvidence {
  activityIds: Set<string>;
  sceneBindingId?: string;
  dispatchId?: string;
  attentionId?: string;
  status: Goal["status"];
}

/** Capture only durable business evidence, never the delivery receipt itself. */
export function captureBackendHandoffEvidence(goal: Goal): BackendHandoffEvidence {
  return {
    activityIds: new Set(goal.activities.map(activity => activity.id)),
    sceneBindingId: goal.scene?.bindingId,
    dispatchId: goal.dispatch?.id,
    attentionId: goal.attention?.id,
    status: goal.status,
  };
}

/**
 * An Agent transport accepting input is not evidence that the concierge
 * coordinated the case. A new owner scene, a human-relevant semantic state, or
 * a new concierge/owner activity is.
 */
export function backendHandoffAdvanced(
  before: BackendHandoffEvidence,
  goal: Goal,
) {
  if (goal.scene?.bindingId && goal.scene.bindingId !== before.sceneBindingId)
    return true;
  if (goal.status !== before.status) return true;
  if (goal.attention?.id && goal.attention.id !== before.attentionId)
    return true;
  return goal.activities.some(activity =>
    !before.activityIds.has(activity.id) &&
    (activity.actor === "concierge" || activity.actor === goal.owner));
}

/**
 * Recover an already persisted handoff after a transient timeout. Only work
 * appended after the prepared snapshot counts, so stale source-backend
 * activity can never make an unconfirmed handoff look complete.
 */
export function backendHandoffHasPersistedProof(
  handoff: BackendHandoff,
  goal: Goal,
) {
  if (goal.scene || goal.attention || goal.status !== "active") return true;
  const checkpoint = handoff.checkpointActivityId
    ? goal.activities.findIndex(activity => activity.id === handoff.checkpointActivityId)
    : -1;
  const candidates = checkpoint >= 0 ? goal.activities.slice(checkpoint + 1) : goal.activities;
  return candidates.some(activity =>
    activity.actor === "concierge" || activity.actor === goal.owner);
}
