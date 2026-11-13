import type {
  LocalProcessIdentity, SceneReferenceV1, SessionBackendId, SkillRole,
} from "../../core/src/index.js";

export type Compatibility = "missing" | "unverified" | "incompatible" | "compatible";
export interface SessionCapabilities {
  create: boolean;
  inspect: boolean;
  send: boolean;
  focus: boolean;
  close: boolean;
  discover: boolean;
  nativeResume: boolean;
}
export interface BackendDetection {
  id: SessionBackendId;
  status: Compatibility;
  version?: string;
  path?: string;
  appPath?: string;
  capabilities: SessionCapabilities;
  detail?: string;
  runtime?: RuntimeIdentity;
}
export interface RuntimeIdentity {
  id: string;
  generation: string;
  backend: SessionBackendId;
  version: string;
  process?: LocalProcessIdentity;
}
export interface RuntimeConnection {
  installationId: string;
  cwd: string;
  /** Launching the native UI is an explicit connection operation. */
  startIfMissing?: boolean;
}
export interface CreateSceneRequest {
  requestId: string;
  bindingId: string;
  installationId: string;
  backendEpoch: number;
  attemptId: string;
  role: SkillRole;
  goalId?: string;
  cwd: string;
  title: string;
  launcherPath: string;
  receiptPath: string;
}
export interface CreateSceneResult {
  status: "created" | "rejected" | "unknown";
  requestId: string;
  scene?: SceneReferenceV1;
  recoveryId: string;
  mayHaveCreated: boolean;
  detail?: string;
}
export interface SceneObservation {
  bindingId: string;
  identity: "match" | "mismatch" | "unverifiable";
  reachable: boolean;
  state: "working" | "idle" | "blocked" | "exited" | "unknown";
  observedAt: string;
  source: "backend";
  detail?: string;
}
export interface SendSceneRequest {
  deliveryId: string;
  scene: SceneReferenceV1;
  text: string;
  payloadSha256: string;
  /** Only the original upstream request can be retried. */
  retry?: { requestId: string; incarnationId: string; payloadSha256: string };
}
export interface SendReceipt {
  status: "rejected" | "accepted" | "started" | "unknown";
  deliveryId: string;
  payloadSha256: string;
  scene: SceneReferenceV1;
  at: string;
  upstreamRequestId?: string;
  detail?: string;
}
export interface FocusResult {
  status: "focused" | "missing" | "failed";
  navigated: boolean;
  detail?: string;
}
export interface CloseReceipt {
  status: "stopped" | "already_stopped" | "unknown";
  bindingId: string;
  at: string;
  identityVerified: boolean;
  detail?: string;
}
export interface OwnedSceneQuery {
  installationId: string;
  runtimeId: string;
  requestId?: string;
  bindingId?: string;
}
export interface OwnedSceneMatch {
  requestId: string;
  scene: SceneReferenceV1;
}
export type AgentResumeResult =
  | { status: "supported"; agent: string; kind: "id" | "path"; value: string }
  | { status: "unsupported" | "unknown"; detail?: string };
export interface SessionAdapter {
  readonly id: SessionBackendId;
  detect(): Promise<BackendDetection>;
  connect(input: RuntimeConnection): Promise<RuntimeIdentity>;
  create(input: CreateSceneRequest): Promise<CreateSceneResult>;
  inspect(scene: SceneReferenceV1): Promise<SceneObservation>;
  inspectMany(scenes: SceneReferenceV1[]): Promise<SceneObservation[]>;
  send(input: SendSceneRequest): Promise<SendReceipt>;
  focus(scene: SceneReferenceV1): Promise<FocusResult>;
  close(scene: SceneReferenceV1): Promise<CloseReceipt>;
  discover(input: OwnedSceneQuery): Promise<OwnedSceneMatch[]>;
  captureResume(scene: SceneReferenceV1): Promise<AgentResumeResult>;
}
export type SessionErrorCode =
  | "backend_missing" | "backend_unverified" | "backend_incompatible"
  | "backend_unreachable" | "backend_switch_in_progress" | "backend_busy"
  | "scene_identity_mismatch" | "launch_unconfirmed" | "delivery_unconfirmed"
  | "focus_failed" | "switch_recovery_required" | "stale_backend_epoch";
export class SessionError extends Error {
  constructor(readonly code: SessionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SessionError";
  }
}
