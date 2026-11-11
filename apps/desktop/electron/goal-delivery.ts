import type { Goal, WorkspaceService } from "../../../packages/core/src/index.js";

export interface GoalDeliveryReceipt {
  status?: "sent" | "unconfirmed";
  detail?: string;
}

// Persisted requests survive application restart. A receipt only acknowledges
// the request that was actually sent, never a newer user action.
export async function deliverGoalUpdate(
  target: WorkspaceService,
  goalId: string,
  send: (goal: Goal) => Promise<void | GoalDeliveryReceipt>,
  expectedRequestId?: string,
) {
  let item = (await target.read()).goals.find(goal => goal.id === goalId);
  if (!item || item.mode !== "concierge" || ["backlog", "completed", "dropped"].includes(item.status)) return;
  if (expectedRequestId && item.dispatch?.id !== expectedRequestId) return;
  if (item.dispatch?.status !== "pending" || !item.dispatch.id) {
    if (expectedRequestId) return;
    await target.execute({ type: "goal.dispatch", goalId, status: "pending" });
  }
  while (true) {
    item = (await target.read()).goals.find(goal => goal.id === goalId);
    if (!item || item.mode !== "concierge" || ["completed", "dropped"].includes(item.status) ||
      item.dispatch?.status !== "pending") return;
    const currentRequestId = item.dispatch.id;
    if (expectedRequestId && currentRequestId !== expectedRequestId) return;
    try {
      const receipt = await send(item) ?? {};
      const latest = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!latest || ["completed", "dropped"].includes(latest.status)) return;
      await target.execute({
        type: "goal.dispatch",
        goalId,
        status: receipt.status === "unconfirmed" ? "unconfirmed" : "sent",
        requestId: currentRequestId,
        ...(receipt.detail ? { detail: receipt.detail } : {}),
      });
    } catch (error) {
      const latest = (await target.read()).goals.find(goal => goal.id === goalId);
      if (!latest || ["completed", "dropped"].includes(latest.status)) return;
      const detail = (error instanceof Error ? error.message : String(error)).replace(/[。.!！]\s*$/, "");
      await target.execute({ type: "goal.dispatch", goalId, status: "failed", requestId: currentRequestId,
        detail: `${detail}。内容已保存，请重试联系管家。` });
    }
    if (expectedRequestId) return;
    // A newer pending request is drained by the same in-flight operation.
  }
}
