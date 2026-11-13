import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Goal } from "../../core/src/index.js";
import { goalNotificationPrompt } from "../src/prompts.js";

test("a persisted scene reply instructs the concierge to resolve the exact decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-prompts-"));
  const at = "2030-01-01T08:00:00.000Z";
  const goal: Goal = {
    id: "goal_prompt",
    projectId: "personal",
    title: "现场决定",
    description: "选择方案",
    mode: "concierge",
    status: "active",
    steps: [],
    next: "选择方案 A 或 B",
    owner: "独立负责人",
    attention: {
      id: "attention_prompt",
      kind: "decision",
      summary: "采用方案 A 还是 B？",
      since: at,
    },
    sceneReply: {
      id: "reply_prompt",
      attentionId: "attention_prompt",
      quote: "采用方案 A，先确认最小范围。",
      summary: "已选择方案 A。",
      actor: "owner-a",
      at,
    },
    activities: [],
    createdAt: at,
    updatedAt: at,
  };
  try {
    const prompt = await goalNotificationPrompt(root, goal);
    assert.match(prompt, /不要再次调用 scene-reply/);
    assert.match(prompt, /crewvane goal resolve goal_prompt/);
    assert.match(prompt, /--attention-id attention_prompt/);
    assert.match(prompt, /--scene-reply-id reply_prompt/);
    assert.match(prompt, /--note "采用方案 A，先确认最小范围。"/);
    assert.match(prompt, /普通 progress 不会关闭注意力/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
