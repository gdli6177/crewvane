import {
  attentionRequest,
  WorkspaceService,
  type Goal,
} from "../../../packages/core/src/index.js";
import { writeCoordinatorScope } from "./coordinator-scope.js";

interface HandoffCaseInput {
  workspace: string;
  goalId: string;
  operationId: string;
  note: string;
  waitForIdle: () => Promise<boolean>;
}

/** Prepare exactly one case for the serialized recovery concierge. */
export async function prepareBackendHandoffCase(input: HandoffCaseInput): Promise<Goal | undefined> {
  // The previous turn can still run scoped CLI commands after it has created
  // its owner. Never publish the next scope until that turn actually settles.
  if (!await input.waitForIdle())
    throw new Error("新管家仍在一回合内，已停止发送后续案卷；交接记录已保留。");
  const service = new WorkspaceService(input.workspace);
  const goal = (await service.read()).goals.find(item => item.id === input.goalId);
  if (!goal?.backendHandoff || goal.backendHandoff.operationId !== input.operationId) return;
  if (goal.scene)
    throw new Error("等待期间已出现负责人现场，请先核对原交接；没有重复派发。");
  if (goal.status !== "active" || goal.mode !== "concierge" || goal.autonomy?.paused || attentionRequest(goal)) {
    await service.execute({ type: "backend.handoff", goalId: goal.id, operationId: input.operationId,
      patch: { method: "deferred", status: "skipped" } });
    return;
  }
  const queued = await service.execute({
    type: "goal.dispatch", goalId: goal.id, status: "pending", kind: "resume", note: input.note,
  }) as Goal;
  const deliveryId = queued.dispatch?.id;
  if (!deliveryId) throw new Error("恢复交接缺少持久化派发编号。");
  await writeCoordinatorScope(input.workspace, goal.id, deliveryId);
  await service.execute({
    type: "backend.handoff", goalId: goal.id, operationId: input.operationId,
    patch: { status: "pending", receiptId: deliveryId },
  });
  return queued;
}
