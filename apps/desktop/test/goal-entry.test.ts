import assert from "node:assert/strict";
import test from "node:test";
import { initialState } from "../../../packages/core/src/model.ts";
import type { Goal } from "../../../packages/core/src/types.ts";
import { goalEntryDestination } from "../src/features/goals/goalEntry.ts";

const at = new Date().toISOString();
function goal(patch: Partial<Goal> = {}): Goal {
  return {
    id: "goal_entry", projectId: "personal", title: "场景入口", description: "",
    mode: "concierge", status: "active", steps: [], next: "继续处理",
    owner: "负责人", attention: null, activities: [], createdAt: at, updatedAt: at,
    ...patch,
  };
}

test("real live intervention opens the owner scene directly", () => {
  assert.equal(goalEntryDestination(goal({
    attention: { kind: "intervention", summary: "需要输入登录信息", since: at, source: "live" },
    herdr: { session: "crewvane", agent: "owner", tabId: "w:t", paneId: "w:p" },
  })), "scene");
});

test("decision and review retain compact action cards", () => {
  assert.equal(goalEntryDestination(goal({
    attention: { kind: "decision", summary: "选择哪个方案？", since: at },
    herdr: { session: "crewvane", agent: "owner" },
  })), "attention");
  assert.equal(goalEntryDestination(goal({
    status: "review",
    attention: { kind: "review", summary: "等待验收", since: at },
    delivery: { summary: "真实成果", checks: [], submittedAt: at, submittedBy: "负责人" },
  })), "attention");
});

test("due follow-up stays actionable without entering the terminal", () => {
  assert.equal(goalEntryDestination(goal({
    status: "waiting", remindAt: "2020-01-01T00:00:00.000Z",
  })), "attention");
});

test("ordinary active goals use a registered scene, not an invented one", () => {
  assert.equal(goalEntryDestination(goal({
    herdr: { session: "crewvane", agent: "owner" },
  })), "scene");
  assert.equal(goalEntryDestination(goal({ herdr: { session: "crewvane" } })), "details");
  assert.equal(goalEntryDestination(goal({ status: "waiting" })), "details");
});

test("dispatch failures remain retry cards and ended goals retain their history", () => {
  assert.equal(goalEntryDestination(goal({
    attention: { kind: "intervention", summary: "尚未派发", since: at, source: "dispatch" },
    herdr: { session: "crewvane", agent: "owner" },
    dispatch: { status: "failed", at },
  })), "attention");
  assert.equal(goalEntryDestination(goal({ status: "completed" })), "details");
  assert.equal(goalEntryDestination(goal({ status: "dropped" })), "details");
});

test("captured and personal tasks open their own controls rather than waking the concierge", () => {
  for (const status of ["backlog", "active", "waiting", "completed", "dropped"] as const)
    assert.equal(goalEntryDestination(goal({ status, mode: "manual" })), "task");
  assert.equal(goalEntryDestination(goal({
    mode: "manual", status: "active", remindAt: "2020-01-01T00:00:00.000Z",
  })), "task");
  assert.equal(goalEntryDestination(goal({
    mode: "manual", attention: { kind: "decision", summary: "仍需授权", since: at, source: "governance" },
  })), "attention", "personal ownership must not hide an outstanding explicit decision");
});
