import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal } from "../../../packages/core/src/index.js";
import { prepareBackendHandoffCase } from "../electron/backend-handoff-case.js";
import { coordinatorScopePath, writeCoordinatorScope } from "../electron/coordinator-scope.js";

async function fixture(t: test.TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "cv-handoff-case-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const service = new WorkspaceService(workspace);
  const previous = await service.execute({ type: "goal.intake", text: "前一个目标" }) as Goal;
  const next = await service.execute({ type: "goal.intake", text: "下一个目标" }) as Goal;
  await service.execute({
    type: "backend.commit",
    binding: { installationId: "installation", backend: "orca", epoch: 1,
      scopeGeneration: "scope", status: "resuming", operationId: "switch" },
    handoffs: { [next.id]: { operationId: "switch", checkpointRevision: 1,
      method: "case-rehydrate", status: "prepared" } },
  });
  await writeCoordinatorScope(workspace, previous.id, "previous-delivery");
  return { workspace, service, previous, next, input: {
    workspace, goalId: next.id, operationId: "switch", note: "根据最新案卷继续",
  } };
}

test("a working concierge keeps its previous scope until idle, then the next case is published", async t => {
  const f = await fixture(t);
  let releaseIdle!: (idle: boolean) => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const idle = new Promise<boolean>(resolve => { releaseIdle = resolve; });
  const pending = prepareBackendHandoffCase({ ...f.input, waitForIdle: () => { entered(); return idle; } });
  await waiting;
  const scopeDuringPreviousTurn = JSON.parse(await readFile(coordinatorScopePath(f.workspace), "utf8"));
  releaseIdle(true);
  const prepared = await pending;
  assert.equal(scopeDuringPreviousTurn.goalId, f.previous.id,
    "publishing the next scope before the previous turn settles allows cross-case reads");
  const scope = JSON.parse(await readFile(coordinatorScopePath(f.workspace), "utf8"));
  assert.equal(scope.goalId, f.next.id);
  assert.equal(scope.requestId, prepared?.dispatch?.id);
});

test("busy or blocked concierge never changes scope or stages a new handoff delivery", async t => {
  const f = await fixture(t);
  const before = (await f.service.read()).goals.find(goal => goal.id === f.next.id)!;
  const bytes = await readFile(coordinatorScopePath(f.workspace), "utf8");
  await assert.rejects(prepareBackendHandoffCase({ ...f.input, waitForIdle: async () => false }), /仍在一回合内/);
  assert.equal(await readFile(coordinatorScopePath(f.workspace), "utf8"), bytes);
  const after = (await f.service.read()).goals.find(goal => goal.id === f.next.id)!;
  assert.deepEqual(after.backendHandoff, before.backendHandoff);
  assert.deepEqual(after.dispatch, before.dispatch);
});

test("a human decision or ended goal during the idle wait is reread and never dispatched", async t => {
  for (const action of ["decide", "complete"] as const) {
    const f = await fixture(t);
    const bytes = await readFile(coordinatorScopePath(f.workspace), "utf8");
    const prepared = await prepareBackendHandoffCase({
      ...f.input,
      waitForIdle: async () => {
        if (action === "decide")
          await f.service.execute({ type: "goal.decide", goalId: f.next.id, question: "等待期间新增的决定" });
        else await f.service.execute({ type: "goal.complete", goalId: f.next.id, note: "用户明确结束" });
        return true;
      },
    });
    assert.equal(prepared, undefined);
    assert.equal(await readFile(coordinatorScopePath(f.workspace), "utf8"), bytes);
    const after = (await f.service.read()).goals.find(goal => goal.id === f.next.id)!;
    assert.equal(after.backendHandoff?.status, "skipped");
  }
});
