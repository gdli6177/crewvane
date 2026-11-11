import type {
  Attention,
  AttentionKind,
  Goal,
  GoalKind,
  ProjectAutonomy,
  ProjectPolicy,
  WorkspaceAutonomy,
  WorkspaceRecovery,
  WorkspaceState,
} from "./types.js";
import { hasDueReminder } from "./task-pool.js";
export const newId = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
export const defaultProjectPolicy = (): ProjectPolicy => ({
  shipPolicy: "external-approval",
  approvers: [],
  revision: 1,
  updatedAt: new Date().toISOString(),
});
export const defaultProjectAutonomy = (): ProjectAutonomy => ({
  acceptance: "inherit",
  revision: 1,
  updatedAt: new Date().toISOString(),
});
export const defaultWorkspaceAutonomy = (): WorkspaceAutonomy => ({
  acceptance: "human-review",
  paused: false,
  maxRecoveryAttempts: 3,
  noProgressMinutes: 30,
  revision: 1,
  updatedAt: new Date().toISOString(),
});
export const initialState = (recovery?: WorkspaceRecovery): WorkspaceState => ({
  version: 3,
  name: "我的工作台",
  projects: [{
    id: "personal",
    name: "个人事项",
    policy: defaultProjectPolicy(),
    autonomy: defaultProjectAutonomy(),
    releaseOnMerge: "unknown",
    createdAt: new Date().toISOString(),
  }],
  workflows: [],
  goals: [],
  decisions: [],
  autonomy: defaultWorkspaceAutonomy(),
  ...(recovery ? { recovery } : {}),
  concierge: { session: "crewvane", status: "not_ready" },
});
export const goalKind = (goal: Goal): GoalKind => goal.kind ?? "delivery";
export const goalRevision = (goal: Goal) => goal.revision ?? 1;
export const goalIsAutonomous = (goal: Goal) =>
  Boolean(goal.brief || goal.autonomy || goal.kind === "discovery" || goal.kind === "release");
export function attentionGoals(goals: Goal[], now = Date.now()): Goal[] {
  return goals.filter((goal) => attentionKind(goal, now)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
export function attentionKind(goal: Goal, now = Date.now()): AttentionKind | undefined {
  if (["completed", "dropped"].includes(goal.status)) return undefined;
  if (goal.attention) return goal.attention.kind;
  return hasDueReminder(goal, now) ? "follow_up" : undefined;
}
export function attentionRequest(goal: Goal, now = Date.now()): (Attention & { id: string }) | undefined {
  if (["completed", "dropped"].includes(goal.status)) return undefined;
  if (goal.attention) return {
    ...goal.attention,
    // Stable identity for pre-existing questions; a newly raised question
    // always gets its own random ID, even within the same millisecond.
    id: goal.attention.id ?? `legacy_${goal.id}_${Date.parse(goal.attention.since)}`,
  };
  if (attentionKind(goal, now) === "follow_up") return {
    id: `reminder_${goal.id}_${Date.parse(goal.remindAt!)}`,
    kind: "follow_up", summary: goal.next, since: goal.remindAt!,
  };
}
export function pendingSceneReply(goal: Goal) {
  return goal.mode === "concierge" && goal.sceneReply?.attentionId === attentionRequest(goal)?.id
    ? goal.sceneReply
    : undefined;
}
