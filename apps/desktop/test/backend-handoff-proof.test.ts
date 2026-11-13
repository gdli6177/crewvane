import test from "node:test";
import assert from "node:assert/strict";
import {
  backendHandoffAdvanced,
  backendHandoffHasPersistedProof,
  captureBackendHandoffEvidence,
} from "../electron/backend-handoff-proof.js";
import type { BackendHandoff, Goal } from "../../../packages/core/src/index.js";

function goal(): Goal {
  return {
    id: "goal_handoff",
    projectId: "personal",
    title: "交接目标",
    description: "验证交接证明",
    mode: "concierge",
    steps: [],
    next: "等待交接",
    owner: "owner-alpha",
    status: "active",
    activities: [{
      id: "act_old",
      at: "2030-01-01T00:00:00.000Z",
      actor: "系统",
      kind: "session",
      text: "旧记录",
    }],
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

test("transport acceptance and scene polling do not prove concierge coordination", () => {
  const beforeGoal = goal();
  const before = captureBackendHandoffEvidence(beforeGoal);
  const unchanged = structuredClone(beforeGoal);
  unchanged.live = { state: "idle", checkedAt: "2030-01-01T00:00:05.000Z", reachable: true };
  assert.equal(backendHandoffAdvanced(before, unchanged), false,
    "Agent idle/transport receipts must not be recorded as business progress");
});

test("a new concierge write, owner write, attention, or bound scene proves coordination", () => {
  const beforeGoal = goal();
  const before = captureBackendHandoffEvidence(beforeGoal);

  const conciergeWrite = structuredClone(beforeGoal);
  conciergeWrite.activities.push({
    id: "act_concierge",
    at: "2030-01-01T00:00:05.000Z",
    actor: "concierge",
    kind: "progress",
    text: "已核对并派发负责人。",
  });
  assert.equal(backendHandoffAdvanced(before, conciergeWrite), true);

  const ownerWrite = structuredClone(beforeGoal);
  ownerWrite.activities.push({
    id: "act_owner",
    at: "2030-01-01T00:00:05.000Z",
    actor: "owner-alpha",
    kind: "progress",
    text: "已恢复并继续明确步骤。",
  });
  assert.equal(backendHandoffAdvanced(before, ownerWrite), true);

  const attention = structuredClone(beforeGoal);
  attention.attention = {
    id: "attention_handoff",
    kind: "decision",
    summary: "需要选择",
    since: "2030-01-01T00:00:05.000Z",
  };
  assert.equal(backendHandoffAdvanced(before, attention), true);

  const scene = structuredClone(beforeGoal);
  scene.scene = {
    version: 1,
    backend: "herdr",
    installationId: "installation",
    runtimeId: "runtime",
    runtimeGeneration: "generation",
    bindingId: "binding-new",
    attemptId: "attempt",
    backendEpoch: 1,
    locator: {
      kind: "herdr",
      session: "session",
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
    },
  };
  assert.equal(backendHandoffAdvanced(before, scene), true);
});
test("retry recognizes only structured activity appended after the persisted checkpoint", () => {
  const checkpointGoal = goal();
  const handoff: BackendHandoff = {
    operationId: "switch-operation",
    checkpointRevision: checkpointGoal.revision ?? 1,
    checkpointActivityId: checkpointGoal.activities.at(-1)!.id,
    method: "case-rehydrate",
    status: "unconfirmed",
  };
  assert.equal(backendHandoffHasPersistedProof(handoff, checkpointGoal), false);

  const systemOnly = structuredClone(checkpointGoal);
  systemOnly.activities.push({
    id: "act_delivery", at: "2030-01-01T00:00:05.000Z",
    actor: "系统", kind: "session", text: "正在联系管家。",
  });
  assert.equal(backendHandoffHasPersistedProof(handoff, systemOnly), false);

  const conciergeWrite = structuredClone(systemOnly);
  conciergeWrite.activities.push({
    id: "act_late_concierge", at: "2030-01-01T00:01:00.000Z",
    actor: "concierge", kind: "progress", text: "已核对并创建新负责人。",
  });
  assert.equal(backendHandoffHasPersistedProof(handoff, conciergeWrite), true);
});
