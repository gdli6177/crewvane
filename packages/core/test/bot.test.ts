import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService, type Goal } from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-bot-"));
  fixtures.push(root);
  return { root, service: new WorkspaceService(root) };
}
test("local initiator Bot uses the shared goal protocol idempotently and cannot approve releases", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "bot.binding.set",
    actor: "你",
    binding: {
      id: "bot_demo",
      name: "Demo Bot",
      role: "initiator",
      projectIds: ["personal"],
      operations: ["goal.submit", "goal.read", "goal.message"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const envelope = {
    schema: "crewvane.bot.v1" as const,
    requestId: "req-1",
    operation: "goal.submit" as const,
    botId: "bot_demo",
    payload: { text: "Bot 提交的本地目标", projectId: "personal" },
  };
  const first = await service.execute({
    type: "bot.request",
    ...envelope,
  }) as { duplicate: boolean; result: Goal };
  assert.equal(first.duplicate, false);
  assert.equal(first.result.kind, "delivery");
  const duplicate = await service.execute({
    type: "bot.request",
    ...envelope,
  }) as { duplicate: boolean; goal?: Goal };
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.goal?.id, first.result.id);
  const read = await service.execute({
    type: "bot.request",
    schema: "crewvane.bot.v1",
    requestId: "req-2",
    operation: "goal.read",
    botId: "bot_demo",
    payload: { goalId: first.result.id },
  }) as { result: Goal };
  assert.equal(read.result.id, first.result.id);
  await assert.rejects(service.execute({
    type: "bot.request",
    schema: "crewvane.bot.v1",
    requestId: "req-3",
    operation: "goal.checkpoint",
    botId: "bot_demo",
    payload: {
      goalId: first.result.id,
      summary: "发起方越权 checkpoint",
      next: "不该成功",
    },
  }), /没有该操作/);
  await assert.rejects(service.execute({
    type: "release.approve",
    goalId: first.result.id,
    note: "Bot 自己批准",
    actor: "bot_demo",
  }), /由人/);
});

test("Bot bindings are human-created, initiator-only, project-scoped and revocable", async () => {
  const { service } = await fixture();
  await assert.rejects(service.execute({
    type: "bot.binding.set",
    actor: "owner-a",
    binding: {
      id: "bot_bad",
      name: "Bad Bot",
      role: "executor",
      projectIds: ["personal"],
      operations: ["goal.read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }), /由人/);
  await assert.rejects(service.execute({
    type: "bot.binding.set",
    actor: "你",
    binding: {
      id: "bot_exec",
      name: "Executor Bot",
      role: "executor",
      projectIds: ["personal"],
      operations: ["goal.read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  }), /发起方 Bot/);
  await service.execute({
    type: "bot.binding.set",
    actor: "你",
    binding: {
      id: "bot_read",
      name: "Reader Bot",
      role: "initiator",
      projectIds: ["personal"],
      operations: ["goal.read"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  await service.execute({
    type: "bot.binding.revoke",
    botId: "bot_read",
    actor: "你",
  });
  await assert.rejects(service.execute({
    type: "bot.request",
    schema: "crewvane.bot.v1",
    requestId: "req-revoked",
    operation: "goal.read",
    botId: "bot_read",
    payload: { goalId: "missing" },
  }), /已撤销/);
});

test("concurrent duplicate Bot requests reserve one receipt and create at most one goal", async () => {
  const { service } = await fixture();
  await service.execute({
    type: "bot.binding.set",
    actor: "你",
    binding: {
      id: "bot_concurrent",
      name: "Concurrent Bot",
      role: "initiator",
      projectIds: ["personal"],
      operations: ["goal.submit"],
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const request = {
    type: "bot.request" as const,
    schema: "crewvane.bot.v1" as const,
    requestId: "same-request",
    operation: "goal.submit" as const,
    botId: "bot_concurrent",
    payload: { text: "只应创建一次的目标", projectId: "personal" },
  };
  const results = await Promise.allSettled([
    service.execute(request),
    service.execute(request),
  ]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  for (const result of results) {
    if (result.status === "rejected")
      assert.match(String(result.reason), /此前未确认/);
  }
  const state = await service.read();
  assert.equal(state.goals.length, 1);
  assert.equal(state.botRequests?.length, 1);
  assert.equal(state.botRequests?.[0]?.status, "completed");
});
