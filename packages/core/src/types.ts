export type GoalStatus = "backlog" | "active" | "waiting" | "review" | "completed" | "dropped";
export type GoalKind = "delivery" | "discovery" | "release";
export type AcceptanceMode = "human-review" | "auto-with-verification";
export type ReleaseOnMerge = "never" | "production" | "unknown";
export type IntakeHandling = "concierge" | "later" | "self";
export type AttentionKind = "decision" | "review" | "follow_up" | "intervention";
export type LiveState = "working" | "idle" | "done" | "blocked" | "unknown";
export type ShipPolicy = "auto" | "auto-merge-manual-deploy" | "external-approval";
export type AgentRuntimeAdapterId =
  | "codex"
  | "claude-code"
  | "cursor"
  | "qoder"
  | "omp"
  | "custom";
export type SkillRole = "concierge" | "owner" | "verifier";
export type LocalSkillRole = Exclude<SkillRole, "concierge">;
export type SkillPackSource = "builtin" | "local";
export interface SkillPackScript {
  id: string;
  path: string;
  sha256: string;
  description: string;
}
export interface SkillPackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  minimumCrewvane: string;
  kind: "process";
  roles: LocalSkillRole[];
  entry: string;
  references?: string[];
  scripts?: SkillPackScript[];
}
export interface SkillPackView {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: "role" | "process" | "setup";
  roles: SkillRole[];
  source: SkillPackSource;
  digest: string;
  status:
    | "builtin"
    | "ready"
    | "disabled"
    | "missing"
    | "needs-approval";
  entry: string;
  referenceCount: number;
  scripts: Array<SkillPackScript & {
    approved: boolean;
    approvalInvalidated?: boolean;
  }>;
  installedAt?: string;
  disabledAt?: string;
  detail?: string;
}
export interface GoalSkillBinding {
  packId: string;
  version: string;
  digest: string;
  roles: LocalSkillRole[];
  attachedAt: string;
  attachedBy: "human" | "concierge";
}
export interface SkillResolutionPack {
  id: string;
  version: string;
  digest: string;
  source: SkillPackSource;
  roles: SkillRole[];
}
export interface GoalSkillResolution {
  id: string;
  role: SkillRole;
  attemptId?: string;
  resolvedAt: string;
  digest: string;
  packs: SkillResolutionPack[];
}
export interface OwnerLaunchRecovery {
  id: string;
  attemptId: string;
  session: string;
  createdAt: string;
  status: "pending" | "attached" | "superseded";
  tabId?: string;
  paneId?: string;
  attachedAt?: string;
  detail?: string;
}
export type AgentRuntimeEventType =
  | "session.started"
  | "turn.started"
  | "turn.settled"
  | "turn.interrupted"
  | "agent.blocked"
  | "agent.response"
  | "session.ended";
export interface AgentRuntimeText {
  text: string;
  sha256: string;
  truncated: boolean;
}
export interface AgentAttempt {
  goalId: string;
  attemptId: string;
  agent: string;
  adapter: AgentRuntimeAdapterId;
  startedAt: string;
  currentTurnId?: string;
  scene?: HerdrReference;
}
export interface AgentRuntimeReceipt {
  turnId: string;
  status: "waiting" | "reminding" | "reminded" | "written" | "protocol_missing" | "cancelled";
  settledAt: string;
  remindAt: string;
  inspectAt: string;
  remindedAt?: string;
  reminderTurnId?: string;
  reminderError?: string;
  missingAt?: string;
  detail?: string;
}
export interface AgentRuntimeState {
  attempt: AgentAttempt;
  capabilities: AgentRuntimeEventType[];
  lastEventId: string;
  lastEventType: AgentRuntimeEventType;
  lastEventAt: string;
  lastSequence: number;
  hookTokenHash: string;
  currentTurnId?: string;
  lastPrompt?: AgentRuntimeText;
  currentTurnStartedAt?: string;
  lastReply?: AgentRuntimeText;
  lastSemanticWriteAt?: string;
  lastSemanticWriteTurnId?: string;
  receipt?: AgentRuntimeReceipt;
  seenEventIds?: string[];
  seenTurnIds?: string[];
}
export interface AgentRuntimeEventV1 {
  version: "v1";
  eventId: string;
  sequence: number;
  at: string;
  source: "hook";
  agent: string;
  adapter: AgentRuntimeAdapterId;
  goalId: string;
  attemptId: string;
  type: AgentRuntimeEventType;
  turnId?: string;
  content?: AgentRuntimeText;
  notificationType?: string;
}
export interface ProjectPolicy {
  shipPolicy: ShipPolicy;
  approvers: string[];
  revision: number;
  updatedAt: string;
}
export interface ProjectAutonomy {
  acceptance: "inherit" | AcceptanceMode;
  revision: number;
  updatedAt: string;
}
export interface Project {
  id: string;
  name: string;
  path?: string;
  policy: ProjectPolicy;
  autonomy?: ProjectAutonomy;
  releaseOnMerge?: ReleaseOnMerge;
  createdAt: string;
}
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
  id?: string;
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
export interface OwnerResume {
  owner: string;
  cwd?: string;
  savedAt: string;
  agentSession?: {
    source: string;
    agent: string;
    kind: "id" | "path";
    value: string;
  };
}
export interface LiveEventTarget {
  paneId?: string; tabId?: string; workspaceId?: string;
}
export interface LiveEventReferenceUpdate {
  paneId?: string; tabId?: string; workspaceId?: string; agent?: string;
}
export interface LivePresence { state: LiveState; checkedAt: string; reachable?: boolean }
export type WatchdogReason = "blocked" | "missing" | "stale" | "unassigned" | "settled" | "protocol_missing";
export interface WatchdogState {
  reason: WatchdogReason; basis: string; detectedAt: string;
  attemptedAt?: string; contactedAt?: string; escalatedAt?: string; lastError?: string;
}
export interface DeliveryCheck { name: string; command: string; result: "passed" | "failed"; note?: string }
export interface DeliveryCandidate {
  revision: string;
  digest?: string;
  version?: string;
}
export type EvidenceKind = "command" | "artifact" | "url" | "attachment" | "inspection";
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  result: "observed" | "passed" | "failed";
  observedAt: string;
  command?: string;
  location?: string;
  sourceRevision?: string;
  sha256?: string;
  note?: string;
}
export interface Delivery {
  id?: string;
  summary: string;
  location?: string;
  url?: string;
  candidate?: DeliveryCandidate;
  checks: DeliveryCheck[];
  evidence?: Evidence[];
  submittedAt: string;
  submittedBy: string;
}
export type ContinuationTrigger =
  | "checkpoint"
  | "verification"
  | "recovery"
  | "wait-due"
  | "decision-resolved"
  | "dependency";
export type ContinuationStatus = "scheduled" | "claimed" | "sent" | "settled" | "cancelled" | "failed";
export interface Continuation {
  id: string;
  trigger: ContinuationTrigger;
  status: ContinuationStatus;
  dueAt: string;
  attempt: number;
  basisRevision: string;
  idempotencyKey: string;
  claimedAt?: string;
  leaseUntil?: string;
  leaseId?: string;
  sentAt?: string;
  settledAt?: string;
  lastError?: string;
}
export interface AcceptanceCriterion {
  id: string;
  statement: string;
  required: boolean;
  provenance:
    | { kind: "user-message"; activityId: string }
    | { kind: "project-rule"; ref: string }
    | { kind: "verification-method"; rationale: string };
}
export interface GoalBrief {
  revision: number;
  outcome: string;
  inScope: string[];
  outOfScope: string[];
  criteria: AcceptanceCriterion[];
  constraints: string[];
  externalEffects: string[];
  verificationPlan: {
    requiredEvidenceKinds: EvidenceKind[];
    independentReviewer: true;
  };
  attemptBudget: {
    maxRecoveryAttempts: number;
  };
  source: {
    activityIds: string[];
    ruleRefs: string[];
  };
  setBy: string;
  setAt: string;
}
export interface VerificationCriterion {
  criterionId: string;
  result: "passed" | "failed";
  evidenceIds: string[];
  note?: string;
}
export interface Verification {
  id: string;
  deliveryId: string;
  outcome: "passed" | "failed";
  summary: string;
  criteria: VerificationCriterion[];
  reviewer: string;
  reviewerHerdr?: HerdrReference;
  verifiedAt: string;
}
export interface VerificationSite {
  reference: HerdrReference;
  status: "launching" | "ready" | "blocked" | "failed";
  at: string;
  detail?: string;
}
export interface AcceptanceRecord {
  id: string;
  kind: "automatic" | "human";
  at: string;
  by: string;
  mandateRevision: number;
  verificationId?: string;
  note?: string;
}
export interface BoundaryChange {
  id: string;
  reason: string;
  proposedOutcome?: string;
  proposedCriteria?: AcceptanceCriterion[];
  proposedExternalEffects?: string[];
  evidence: string[];
  alternatives: string[];
  recommendation: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt?: string;
}
export interface GoalAutonomy {
  override?: AcceptanceMode;
  paused?: boolean;
  attempts: {
    used: number;
    limit: number;
    failureFingerprint?: string;
  };
  continuation?: Continuation;
  lastVerification?: Verification;
  verificationSite?: VerificationSite;
  acceptance?: AcceptanceRecord;
  boundaryChange?: BoundaryChange;
}
export interface ReleaseTarget {
  sourceGoalIds: string[];
  environment: string;
  candidate: DeliveryCandidate;
  status:
    | "drafting"
    | "awaiting-authorization"
    | "authorized"
    | "executing"
    | "verifying"
    | "succeeded"
    | "failed"
    | "cancelled";
  authorization?: {
    id: string;
    approvedAt: string;
    approvedBy: "你";
    candidateRevision: string;
    candidateDigest?: string;
    note: string;
  };
  result?: {
    outcome: "succeeded" | "failed";
    evidence: string[];
    reportedAt: string;
  };
}
export interface WorkspaceAutonomy {
  acceptance: AcceptanceMode;
  initializedAt?: string;
  paused: boolean;
  maxRecoveryAttempts: number;
  noProgressMinutes: number;
  revision: number;
  updatedAt: string;
}
export type BotOperation =
  | "goal.submit"
  | "goal.read"
  | "goal.message"
  | "goal.checkpoint"
  | "goal.boundary"
  | "delivery.submit";
export interface BotBinding {
  id: string;
  name: string;
  role: "initiator" | "executor";
  projectIds: string[];
  operations: BotOperation[];
  expiresAt: string;
  status: "active" | "revoked";
}
export interface BotRequestReceipt {
  botId: string;
  requestId: string;
  operation: BotOperation;
  at: string;
  goalId?: string;
  status: "pending" | "completed" | "failed";
  detail?: string;
}
export interface Activity {
  id: string;
  at: string;
  actor: string;
  kind:
    | "created"
    | "message"
    | "progress"
    | "waiting"
    | "decision"
    | "delivery"
    | "accepted"
    | "rework"
    | "dropped"
    | "resolved"
    | "reminder"
    | "session"
    | "watchdog"
    | "ship"
    | "autonomy"
    | "boundary"
    | "verification"
    | "release"
    | "reopened"
    | "skill";
  text: string;
  attachmentIds?: string[];
}
export interface GoalAttachment {
  id: string; name: string; path: string; mime: string; size: number; sha256: string; addedAt: string;
}
export interface Goal {
  id: string; projectId: string; title: string; description: string;
  kind?: GoalKind; revision?: number;
  mode: "concierge" | "manual"; status: GoalStatus;
  steps: WorkflowStep[]; stageId?: string; next: string; owner: string;
  waitingFor?: string; remindAt?: string; attention: Attention | null;
  delivery?: Delivery; brief?: GoalBrief; briefHistory?: GoalBrief[];
  autonomy?: GoalAutonomy; release?: ReleaseTarget;
  herdr?: HerdrReference; ownerResume?: OwnerResume; live?: LivePresence;
  reviewRounds?: number; reviewLimit?: number;
  risk?: RiskEscalation;
  dispatch?: { id?: string; kind?: "resume" | "restart" | "follow_up" | "feedback" | "scene_reply" | "continuation" | "verification"; note?: string; status: "pending" | "sent" | "unconfirmed" | "failed"; at: string; detail?: string };
  sceneReply?: SceneReply;
  recovery?: "idle" | "done" | "blocked";
  sceneVisit?: SceneVisit;
  watchdog?: WatchdogState;
  agentRuntime?: AgentRuntimeState;
  skills?: GoalSkillBinding[];
  skillResolutions?: GoalSkillResolution[];
  ownerLaunchRecovery?: OwnerLaunchRecovery;
  attachments?: GoalAttachment[];
  activities: Activity[]; createdAt: string; updatedAt: string;
}
export interface SceneReply {
  id: string;
  attentionId: string;
  quote: string;
  summary: string;
  actor: string;
  at: string;
}
export interface SceneVisit {
  id: string;
  attentionId: string;
  at: string;
  worked: boolean;
  status: "watching" | "pending" | "checking" | "checked" | "failed";
  attemptedAt?: string;
  detail?: string;
}
export interface WorkspaceState {
  version: 3; name: string; projects: Project[]; workflows: Workflow[]; goals: Goal[];
  autonomy: WorkspaceAutonomy;
  bots?: BotBinding[];
  botRequests?: BotRequestReceipt[];
  decisions: DecisionRecord[];
  agents?: AgentPreferences;
  recovery?: WorkspaceRecovery;
  concierge: HerdrReference & {
    status: "not_ready" | "ready" | "error";
    detail?: string;
    live?: LivePresence;
  };
}
type WorkspaceCommand =
  | { type: "snapshot" }
  | { type: "workspace.rename"; name: string }
  | { type: "workspace.recovery.dismiss" }
  | { type: "agents.configure"; preferences: AgentPreferences }
  | {
      type: "workspace.autonomy.set";
      acceptance?: AcceptanceMode;
      paused?: boolean;
      maxRecoveryAttempts?: number;
      noProgressMinutes?: number;
      initialize?: boolean;
      actor: string;
    }
  | { type: "project.add"; name: string; path?: string }
  | { type: "project.remove"; projectId: string }
  | { type: "project.policy.set"; projectId: string; policy: Pick<ProjectPolicy, "shipPolicy" | "approvers">; actor: string }
  | {
      type: "project.autonomy.set";
      projectId: string;
      acceptance: "inherit" | AcceptanceMode;
      releaseOnMerge: ReleaseOnMerge;
      actor: string;
    }
  | { type: "workflow.save"; workflow: Workflow }
  | {
      type: "goal.create";
      input: {
        title: string;
        description?: string;
        projectId: string;
        workflowId?: string;
        kind?: Exclude<GoalKind, "release">;
        mode: "concierge" | "manual";
        next?: string;
        waitingFor?: string;
        remindAt?: string;
      };
    }
  | {
      type: "goal.intake";
      text: string;
      projectId?: string;
      kind?: Exclude<GoalKind, "release">;
      handling?: IntakeHandling;
      remindAt?: string;
      attachments?: GoalAttachment[];
    }
  | {
      type: "goal.direct";
      text: string;
      goalId?: string;
      projectId?: string;
      kind?: Exclude<GoalKind, "release">;
      handling?: IntakeHandling;
      attachments?: GoalAttachment[];
    }
  | { type: "goal.attachment.remove"; goalId: string; attachmentId: string; actor?: string }
  | { type: "attachments.cleanup"; retentionDays?: number; at?: string }
  | { type: "goal.delete"; goalId: string; actor?: string }
  | { type: "goal.update"; goalId: string; patch: { title?: string; description?: string; next?: string; owner?: string; stageId?: string; waitingFor?: string; remindAt?: string | null; status?: "active" | "waiting" } }
  | { type: "goal.message"; goalId: string; text: string; attachments?: GoalAttachment[]; actor?: string; routeToConcierge?: boolean }
  | {
      type: "goal.skill.attach";
      goalId: string;
      packId: string;
      actor: "human" | "concierge";
    }
  | {
      type: "goal.skill.detach";
      goalId: string;
      packId: string;
      actor: "human" | "concierge";
    }
  | {
      type: "goal.skill.audit";
      goalId: string;
      packId: string;
      scriptId: string;
      outcome: "succeeded" | "failed";
      summary: string;
      actor?: string;
    }
  | {
      type: "goal.skill.resolve";
      goalId: string;
      resolution: Omit<GoalSkillResolution, "id" | "resolvedAt">;
    }
  | {
      type: "goal.owner-launch.recovery";
      goalId: string;
      recovery: OwnerLaunchRecovery;
    }
  | { type: "goal.scene-reply"; goalId: string; attentionId: string; quote: string; summary: string; actor: string }
  | { type: "scene.visit"; goalId: string; retry?: boolean }
  | { type: "scene.check"; goalId: string; visitId: string; status: "checking" | "checked" | "failed"; detail?: string }
  | { type: "goal.progress"; goalId: string; summary: string; next?: string; stageId?: string; actor?: string }
  | {
      type: "goal.dispatch";
      goalId: string;
      status: "pending" | "sent" | "unconfirmed" | "failed";
      detail?: string;
      requestId?: string;
      kind?: NonNullable<Goal["dispatch"]>["kind"];
      note?: string;
    }
  | { type: "goal.resume"; goalId: string; note: string; mode: "concierge" | "manual" }
  | { type: "goal.restart"; goalId: string; note: string }
  | { type: "goal.takeover"; goalId: string }
  | { type: "goal.delegate"; goalId: string }
  | { type: "goal.restore"; goalId: string }
  | { type: "goal.followup"; goalId: string; note?: string }
  | { type: "goal.wait"; goalId: string; reason: string; owner?: string; remindAt?: string; actor?: string }
  | { type: "goal.decide"; goalId: string; question: string; next?: string; actor?: string; key?: string }
  | { type: "goal.risk"; goalId: string; category: HighRiskCategory; summary: string; actionKey?: string; actor?: string }
  | { type: "goal.ship"; goalId: string; operation: "merge" | "deploy"; checksPassed: boolean; actor?: string }
  | { type: "goal.review"; goalId: string; delivery: Omit<Delivery, "submittedAt" | "submittedBy">; actor?: string }
  | {
      type: "goal.brief";
      goalId: string;
      brief: GoalBriefInput;
      expectedRevision?: number;
      actor?: string;
    }
  | {
      type: "goal.checkpoint";
      goalId: string;
      summary: string;
      next: string;
      dueAt?: string;
      actor?: string;
    }
  | {
      type: "goal.verify";
      goalId: string;
      deliveryId: string;
      outcome: "passed" | "failed";
      summary: string;
      criteria: VerificationCriterion[];
      reviewer?: string;
      reviewerHerdr?: HerdrReference;
      actor?: string;
    }
  | {
      type: "goal.verification.site";
      goalId: string;
      reference: HerdrReference;
      status: VerificationSite["status"];
      detail?: string;
      actor?: string;
    }
  | {
      type: "goal.boundary";
      goalId: string;
      change: {
        reason: string;
        proposedOutcome?: string;
        proposedCriteria?: AcceptanceCriterion[];
        proposedExternalEffects?: string[];
        evidence: string[];
        alternatives: string[];
        recommendation: string;
      };
      actor?: string;
    }
  | {
      type: "goal.boundary.resolve";
      goalId: string;
      boundaryId: string;
      outcome: "approved" | "rejected";
      note: string;
      actor?: string;
    }
  | {
      type: "goal.kind.set";
      goalId: string;
      kind: Exclude<GoalKind, "release">;
      actor?: string;
    }
  | { type: "goal.autonomy.pause" | "goal.autonomy.resume"; goalId: string; actor?: string }
  | {
      type: "goal.autonomy.acceptance";
      goalId: string;
      acceptance: "inherit" | AcceptanceMode;
      actor?: string;
    }
  | { type: "goal.reopen"; goalId: string; note: string; actor?: string }
  | {
      type: "release.create";
      sourceGoalIds: string[];
      environment: string;
      candidate: DeliveryCandidate;
      actor?: string;
    }
  | { type: "release.approve" | "release.reject"; goalId: string; note: string; actor?: string }
  | {
      type: "release.result";
      goalId: string;
      outcome: "succeeded" | "failed";
      evidence: string[];
      actor?: string;
    }
  | { type: "autonomy.inspect"; at: string }
  | {
      type: "autonomy.claim";
      goalId: string;
      continuationId: string;
      at: string;
      leaseMs?: number;
    }
  | {
      type: "autonomy.report";
      goalId: string;
      continuationId: string;
      outcome: "sent" | "failed" | "settled";
      detail?: string;
      leaseId?: string;
      at: string;
    }
  | {
      type: "bot.binding.set";
      binding: Omit<BotBinding, "status">;
      actor: string;
    }
  | { type: "bot.binding.revoke"; botId: string; actor: string }
  | {
      type: "bot.request";
      schema: "crewvane.bot.v1";
      requestId: string;
      operation: BotOperation;
      botId: string;
      payload: unknown;
    }
  | { type: "goal.accept" | "goal.complete" | "goal.drop"; goalId: string; note?: string; actor?: string }
  | { type: "goal.resolve"; goalId: string; note?: string; actor?: string; outcome?: DecisionOutcome; source?: "desktop" | "herdr" | "cli" | "scene" }
  | { type: "goal.rework"; goalId: string; note: string; actor?: string }
  | { type: "goal.remind"; goalId: string; at: string; note?: string }
  | { type: "session.set"; goalId?: string; reference: HerdrReference }
  | { type: "session.preserve"; goalId: string; resume: OwnerResume }
  | { type: "session.release"; goalId: string }
  | { type: "concierge.status"; status: "not_ready" | "ready" | "error"; detail?: string; reference?: HerdrReference; live?: LivePresence | null }
  | { type: "live.sync"; presences: Record<string, LivePresence> }
  | { type: "live.event"; target: LiveEventTarget; presence: LivePresence; reference?: LiveEventReferenceUpdate }
  | {
      type: "agent.runtime.register";
      goalId: string;
      attempt: AgentAttempt;
      hookTokenHash: string;
      capabilities: AgentRuntimeEventType[];
    }
  | { type: "agent.runtime.event"; event: AgentRuntimeEventV1 }
  | {
      type: "agent.runtime.receipt";
      goalId: string;
      attemptId: string;
      turnId: string;
      stage: "reminding" | "reminded" | "protocol_missing" | "cancelled";
      at: string;
      detail?: string;
    }
  | { type: "watchdog.inspect"; at: string }
  | { type: "watchdog.report"; goalId: string; at: string; basis: string; outcome: "contacted" | "failed"; detail?: string }
  | { type: "notification.sent"; goalId: string; kind: AttentionKind; at: string };

// Optimistic guards bind a reply to the exact question and human response.
// They are checked under the same lock as the state change.
export type CrewvaneCommand = WorkspaceCommand & {
  attentionId?: string;
  sceneReplyId?: string;
  requestId?: string;
};

export interface GoalBriefInput {
  outcome: string;
  inScope: string[];
  outOfScope: string[];
  criteria: AcceptanceCriterion[];
  constraints: string[];
  externalEffects: string[];
  verificationPlan: {
    requiredEvidenceKinds: EvidenceKind[];
    independentReviewer: true;
  };
  attemptBudget: {
    maxRecoveryAttempts: number;
  };
  source: {
    activityIds: string[];
    ruleRefs: string[];
  };
}
