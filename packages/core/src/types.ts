export type GoalStatus = "active" | "waiting" | "review" | "completed" | "dropped";
export type AttentionKind = "decision" | "review" | "follow_up" | "intervention";
export type LiveState = "working" | "idle" | "done" | "blocked" | "unknown";
export type ShipPolicy = "auto" | "auto-merge-manual-deploy" | "external-approval";
export interface ProjectPolicy {
  shipPolicy: ShipPolicy;
  approvers: string[];
  revision: number;
  updatedAt: string;
}
export interface Project { id: string; name: string; path?: string; policy: ProjectPolicy; createdAt: string }
export interface WorkflowStep { id: string; name: string; prompt: string }
export interface Workflow { id: string; name: string; steps: WorkflowStep[] }
export interface AgentPreferences { concierge: string; owner?: string; worker?: string }
export type WorkspaceRecoveryReason =
  | "unsupported-version"
  | "invalid-state"
  | "legacy-event-log";
export interface WorkspaceRecovery {
  id: string;
  detectedAt: string;
  archivedPath: string;
  reason: WorkspaceRecoveryReason;
  detail: string;
}
export interface Attention {
  kind: AttentionKind; summary: string; since: string; notifiedAt?: string;
  source?: "live" | "dispatch" | "watchdog" | "governance";
  decisionKey?: string;
}
export type DecisionOutcome = "approved" | "rejected";
export interface DecisionRecord {
  id: string; projectId: string; actionKey: string; outcome: DecisionOutcome;
  quote: string; source: string; goalId?: string; decidedAt: string;
}
export type HighRiskCategory =
  | "delete-data" | "stop-service" | "spend-money" | "external-message"
  | "product-direction" | "create-secret" | "rotate-secret" | "change-permissions"
  | "change-ship-policy";
export interface RiskEscalation {
  category: HighRiskCategory; summary: string; actionKey: string; at: string;
}
export interface HerdrReference {
  session: string; workspaceId?: string; tabId?: string; paneId?: string; agent?: string;
  transport?: "pane"; processId?: number; launchPolicy?: "control-plane-v1";
}
export interface LiveEventTarget {
  paneId?: string; tabId?: string; workspaceId?: string;
}
export interface LiveEventReferenceUpdate {
  paneId?: string; tabId?: string; workspaceId?: string; agent?: string;
}
export interface LivePresence { state: LiveState; checkedAt: string; reachable?: boolean }
export type WatchdogReason = "blocked" | "missing" | "stale" | "unassigned";
export interface WatchdogState {
  reason: WatchdogReason; basis: string; detectedAt: string;
  attemptedAt?: string; contactedAt?: string; escalatedAt?: string; lastError?: string;
}
export interface DeliveryCheck { name: string; command: string; result: "passed" | "failed"; note?: string }
export interface Delivery { summary: string; location?: string; url?: string; checks: DeliveryCheck[]; submittedAt: string; submittedBy: string }
export interface Activity { id: string; at: string; actor: string; kind: "created" | "message" | "progress" | "waiting" | "decision" | "delivery" | "accepted" | "rework" | "dropped" | "resolved" | "reminder" | "session" | "watchdog" | "ship"; text: string; attachmentIds?: string[] }
export interface GoalAttachment {
  id: string; name: string; path: string; mime: string; size: number; sha256: string; addedAt: string;
}
export interface Goal {
  id: string; projectId: string; title: string; description: string;
  mode: "concierge" | "manual"; status: GoalStatus;
  steps: WorkflowStep[]; stageId?: string; next: string; owner: string;
  waitingFor?: string; remindAt?: string; attention: Attention | null;
  delivery?: Delivery; herdr?: HerdrReference; live?: LivePresence;
  reviewRounds?: number; reviewLimit?: number;
  risk?: RiskEscalation;
  dispatch?: { id?: string; kind?: "resume" | "follow_up" | "feedback"; note?: string; status: "pending" | "sent" | "failed"; at: string; detail?: string };
  watchdog?: WatchdogState;
  attachments?: GoalAttachment[];
  activities: Activity[]; createdAt: string; updatedAt: string;
}
export interface WorkspaceState {
  version: 2; name: string; projects: Project[]; workflows: Workflow[]; goals: Goal[];
  decisions: DecisionRecord[];
  agents?: AgentPreferences;
  recovery?: WorkspaceRecovery;
  concierge: HerdrReference & {
    status: "not_ready" | "ready" | "error";
    detail?: string;
    live?: LivePresence;
  };
}
export type CrewvaneCommand =
  | { type: "snapshot" }
  | { type: "workspace.rename"; name: string }
  | { type: "workspace.recovery.dismiss" }
  | { type: "agents.configure"; preferences: AgentPreferences }
  | { type: "project.add"; name: string; path?: string }
  | { type: "project.remove"; projectId: string }
  | { type: "project.policy.set"; projectId: string; policy: Pick<ProjectPolicy, "shipPolicy" | "approvers">; actor: string }
  | { type: "workflow.save"; workflow: Workflow }
  | { type: "goal.create"; input: { title: string; description?: string; projectId: string; workflowId?: string; mode: "concierge" | "manual"; next?: string; waitingFor?: string; remindAt?: string } }
  | { type: "goal.intake"; text: string; projectId?: string; attachments?: GoalAttachment[] }
  | { type: "goal.direct"; text: string; goalId?: string; projectId?: string; attachments?: GoalAttachment[] }
  | { type: "goal.attachment.remove"; goalId: string; attachmentId: string; actor?: string }
  | { type: "attachments.cleanup"; retentionDays?: number; at?: string }
  | { type: "goal.delete"; goalId: string; actor?: string }
  | { type: "goal.update"; goalId: string; patch: { title?: string; description?: string; next?: string; owner?: string; stageId?: string; waitingFor?: string; remindAt?: string | null; status?: "active" | "waiting" } }
  | { type: "goal.message"; goalId: string; text: string; attachments?: GoalAttachment[]; actor?: string; routeToConcierge?: boolean }
  | { type: "goal.progress"; goalId: string; summary: string; next?: string; stageId?: string; actor?: string }
  | { type: "goal.dispatch"; goalId: string; status: "pending" | "sent" | "failed"; detail?: string; requestId?: string }
  | { type: "goal.resume"; goalId: string; note: string; mode: "concierge" | "manual" }
  | { type: "goal.takeover"; goalId: string }
  | { type: "goal.delegate"; goalId: string }
  | { type: "goal.followup"; goalId: string; note?: string }
  | { type: "goal.wait"; goalId: string; reason: string; owner?: string; remindAt?: string; actor?: string }
  | { type: "goal.decide"; goalId: string; question: string; next?: string; actor?: string; key?: string }
  | { type: "goal.risk"; goalId: string; category: HighRiskCategory; summary: string; actionKey?: string; actor?: string }
  | { type: "goal.ship"; goalId: string; operation: "merge" | "deploy"; checksPassed: boolean; actor?: string }
  | { type: "goal.review"; goalId: string; delivery: Omit<Delivery, "submittedAt" | "submittedBy">; actor?: string }
  | { type: "goal.accept" | "goal.complete" | "goal.drop"; goalId: string; note?: string; actor?: string }
  | { type: "goal.resolve"; goalId: string; note?: string; actor?: string; outcome?: DecisionOutcome; source?: "desktop" | "herdr" | "cli" }
  | { type: "goal.rework"; goalId: string; note: string; actor?: string }
  | { type: "goal.remind"; goalId: string; at: string; note?: string }
  | { type: "session.set"; goalId?: string; reference: HerdrReference }
  | { type: "session.release"; goalId: string }
  | { type: "concierge.status"; status: "not_ready" | "ready" | "error"; detail?: string; reference?: HerdrReference; live?: LivePresence | null }
  | { type: "live.sync"; presences: Record<string, LivePresence> }
  | { type: "live.event"; target: LiveEventTarget; presence: LivePresence; reference?: LiveEventReferenceUpdate }
  | { type: "watchdog.inspect"; at: string }
  | { type: "watchdog.report"; goalId: string; at: string; basis: string; outcome: "contacted" | "failed"; detail?: string }
  | { type: "notification.sent"; goalId: string; kind: AttentionKind; at: string };
