import type {
  BackendHandoff, LocalProcessIdentity, SceneReferenceV1, SessionBackendId, WorkspaceState,
} from "../../../core/src/index.js";
import type { CloseReceipt, SessionAdapter } from "../contracts.js";

export type SwitchPhase = "preflight" | "prepared" | "quiescing" | "old_stopped" | "committing" | "resuming" | "ready" | "cancelled" | "recovery_required";
export interface BackendControlV1 {
  version: 1;
  installationId: string;
  selected: SessionBackendId;
  epoch: number;
  scopeGeneration: string;
  phase: "ready" | "switching" | "recovery_required";
  switchOperationId?: string;
  maintenance?: { id: string; backend: SessionBackendId; startedAt: string };
  orcaAppPath?: string;
}
export interface WorkspaceRegistration {
  root: string;
  registeredAt: string;
}
export interface SceneResource {
  workspace: string;
  role: "concierge" | "owner" | "verifier";
  goalId?: string;
  scene: SceneReferenceV1;
}
export interface SwitchWorkspace {
  root: string;
  committed?: boolean;
  resumed?: boolean;
  handoffs: Record<string, BackendHandoff>;
}
export interface SwitchJournal {
  version: 1;
  operationId: string;
  from: SessionBackendId;
  to: SessionBackendId;
  fromEpoch: number;
  nextEpoch: number;
  scopeGeneration: string;
  phase: SwitchPhase;
  resumePhase?: Exclude<SwitchPhase, "ready" | "cancelled" | "recovery_required">;
  createdAt: string;
  updatedAt: string;
  workspaces: SwitchWorkspace[];
  resources: SceneResource[];
  closed: CloseReceipt[];
  detail?: string;
  restoresOperationId?: string;
}
export interface OperationLease {
  id: string;
  requestId: string;
  workspace: string;
  backend: SessionBackendId;
  epoch: number;
  kind: "create" | "send" | "close" | "bind";
  bindingId?: string;
  goalId?: string;
  role?: "concierge" | "owner" | "verifier";
  owner: LocalProcessIdentity;
  startedAt: string;
  expiresAt: string;
  status: "running" | "finished" | "unknown";
}
/** This value is deliberately not serializable. Renderer/Agent operation IDs
 * are never converted into switch authority. */
export interface SwitchAuthority { readonly operationId: string; readonly proof: symbol }
export interface SwitchHooks {
  adapter(backend: SessionBackendId, workspace: string): Promise<SessionAdapter>;
  /** Runs after the preflight journal and barrier are durable, before any
   * adapter connection or inspection. Used to verify process-loss recovery. */
  afterAdmission?(journal: SwitchJournal): Promise<void>;
  busy?(workspace: string): Promise<boolean>;
  resume(input: {
    workspace: string;
    state: WorkspaceState;
    authority: SwitchAuthority;
    operationId: string;
  }): Promise<void>;
  onProgress?(journal: SwitchJournal): void;
  /** Fault injection / durable-boundary verification. */
  afterPersist?(phase: SwitchPhase, journal: SwitchJournal): Promise<void>;
}
