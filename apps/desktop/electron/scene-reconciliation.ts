import {
  attentionRequest, pendingSceneReply, SCENE_RECONCILIATION_GRACE_MS,
  type WorkspaceService,
} from "../../../packages/core/src/index.js";

// Older owners did not receive the write-back protocol at launch. After a user
// visit and one observed work cycle, ask that same owner once, at a safe idle
// point. Never copy terminal history into the concierge's context.
export async function reconcileSceneReply(
  target: WorkspaceService,
  goalId: string,
  connection: { requestSceneReply(goal: import("../../../packages/core/src/index.js").Goal): Promise<boolean> },
  options: { now?: () => Date; graceMs?: number } = {},
) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  const visit = item?.sceneVisit;
  if (!item || !visit || visit.status !== "pending" || (!item.scene && !item.herdr) ||
    visit.attentionId !== attentionRequest(item)?.id || pendingSceneReply(item)) return;
  // Hook-capable Agents already report turn settlement. Do not inject another
  // turn that can take the keyboard away from the person answering in-scene.
  if (item.agentRuntime?.capabilities.includes("turn.settled")) return;
  const now = (options.now ?? (() => new Date()))().getTime();
  const graceMs = options.graceMs ?? SCENE_RECONCILIATION_GRACE_MS;
  const observedAt = Date.parse(visit.pendingAt ?? visit.at);
  if (!Number.isFinite(observedAt) || now - observedAt < graceMs) return;
  // The claim is persisted and atomic. A concurrent tick or restart cannot
  // submit the same reconciliation prompt twice.
  if (!await target.execute({ type: "scene.check", goalId, visitId: visit.id, status: "checking" })) return;
  try {
    const sent = await connection.requestSceneReply(item);
    await target.execute({
      type: "scene.check", goalId, visitId: visit.id, status: sent ? "checked" : "failed",
      ...(!sent ? { detail: "现场正在工作、等待交互或身份已变化；没有发送核对消息。" } : {}),
    });
  } catch (error) {
    await target.execute({
      type: "scene.check", goalId, visitId: visit.id, status: "failed",
      detail: String(error instanceof Error ? error.message : error).slice(0, 1000),
    });
  }
}
