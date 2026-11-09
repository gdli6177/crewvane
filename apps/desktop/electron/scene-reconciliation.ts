import { attentionRequest, pendingSceneReply, type WorkspaceService } from "../../../packages/core/src/index.js";
import type { HerdrClient } from "./herdr.js";

// Older owners did not receive the write-back protocol at launch. After a user
// visit and one observed work cycle, ask that same owner once, at a safe idle
// point. Never copy terminal history into the concierge's context.
export async function reconcileSceneReply(
  target: WorkspaceService,
  goalId: string,
  connection: Pick<HerdrClient, "requestSceneReply">,
) {
  const item = (await target.read()).goals.find(goal => goal.id === goalId);
  const visit = item?.sceneVisit;
  if (!item || !visit || visit.status !== "pending" || !item.herdr ||
    visit.attentionId !== attentionRequest(item)?.id || pendingSceneReply(item)) return;
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
