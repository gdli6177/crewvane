import type { Goal, IntakeHandling } from "./types.js";

/** Capture is separate from authorizing an agent to start work. */
export function intakeArrangement(handling: IntakeHandling) {
  switch (handling) {
    case "later": return {
      mode: "manual" as const, status: "backlog" as const, owner: "尚未开始",
      next: "先记在这里，准备好后再决定由谁来做。",
    };
    case "self": return {
      mode: "manual" as const, status: "active" as const, owner: "你",
      next: "由你安排；做完即可标记完成。",
    };
    case "concierge": return {
      mode: "concierge" as const, status: "active" as const, owner: "待分配负责人",
      next: "管家正在理解原文并整理目标。",
    };
    default: throw new Error("请选择先记下、我来做或交给管家");
  }
}

export function isPersonalTask(goal: Goal) {
  return goal.mode === "manual" && (goal.status === "active" || goal.status === "waiting");
}

export function taskPoolGoals(goals: Goal[], section: "later" | "self") {
  return goals.filter(goal => section === "later" ? goal.status === "backlog" : isPersonalTask(goal))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function hasDueReminder(goal: Goal, now = Date.now()) {
  return Boolean(goal.remindAt && Date.parse(goal.remindAt) <= now &&
    ["waiting", "backlog", "active"].includes(goal.status));
}
