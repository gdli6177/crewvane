import { rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SceneReply } from "../../../packages/core/src/index.js";

export interface CoordinatorScope {
  goalId: string;
  requestId?: string;
  setAt: string;
  attentionId?: string;
  sceneReplyId?: string;
}

export function coordinatorScopePath(root: string) {
  return join(root, ".crewvane", "coordinator-scope.json");
}

export async function writeCoordinatorScope(
  root: string,
  goalId: string,
  requestId?: string,
  sceneReply?: SceneReply,
) {
  const path = coordinatorScopePath(root),
    temporary = `${path}.${process.pid}-${randomUUID()}.tmp`,
    scope: CoordinatorScope = {
      goalId,
      ...(requestId ? { requestId } : {}),
      setAt: new Date().toISOString(),
      ...(sceneReply
        ? { attentionId: sceneReply.attentionId, sceneReplyId: sceneReply.id }
        : {}),
    };
  try {
    await writeFile(temporary, `${JSON.stringify(scope, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
