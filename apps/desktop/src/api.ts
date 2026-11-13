import type { CrewvaneCommand, GoalAttachment, SkillPackManifest, SkillPackView } from "../../../packages/core/src/index.js";
import type { HerdrStatus } from "../electron/herdr-install.js";
import type { OrcaInstallationStatus } from "../electron/orca-install.js";
import type { HerdrPluginStatus } from "../electron/herdr-plugin.js";
import type { WebhookSaveInput, WebhookSettings } from "../electron/webhook-notifications.js";
import type { SkillsInstallResult, SkillsStatus } from "../electron/skill-installer.js";
import type { CacheCleanupResult, CacheStatus } from "../electron/cache-maintenance.js";
import type { AgentHookAdapterStatus, ManagedAdapterId } from "../electron/agent-hook-manager.js";
import type { CoordinatorInboxStatus } from "../electron/coordinator-inbox.js";
import type {
  BackendControlV1,
  SwitchJournal,
  WorkspaceRegistration,
} from "../../../packages/sessions/src/control/types.js";
import type {
  ExternalSceneLease,
  SceneSettings,
  SceneSettingsStatus,
} from "../electron/external-terminal.js";
export type SceneOpenResult =
  | { mode: "external"; lease: ExternalSceneLease }
  | { mode: "embedded" }
  | { mode: "native"; app: "Orca" };
export interface BackendControlStatus {
  control: BackendControlV1;
  journal?: SwitchJournal;
  workspaces: WorkspaceRegistration[];
  orca: OrcaInstallationStatus;
  impact: { goals: number; scenes: number };
}
export interface DesktopApi {
  command(command: CrewvaneCommand): Promise<any>;
  importAttachments(inputs: { name: string; bytes: ArrayBuffer }[]): Promise<GoalAttachment[]>;
  attachmentPreview(goalId: string, attachmentId: string): Promise<string>;
  openAttachment(goalId: string, attachmentId: string): Promise<void>;
  selectWorkspace(): Promise<string | null>; selectProject(): Promise<string | null>;
  environment(): Promise<{ workspace?: string; version: string }>;
  herdrStatus(): Promise<HerdrStatus & { session: string; plugin: HerdrPluginStatus }>;
  orcaStatus(): Promise<OrcaInstallationStatus>;
  orcaAction(action: "check" | "install" | "cancel" | "refresh"): Promise<OrcaInstallationStatus | void>;
  selectOrcaApplication(): Promise<OrcaInstallationStatus | null>;
  backendStatus(): Promise<BackendControlStatus>;
  switchBackend(backend: "herdr" | "orca"): Promise<{
    journal?: SwitchJournal;
    status: BackendControlStatus;
  }>;
  retryBackendSwitch(): Promise<{
    journal?: SwitchJournal;
    status: BackendControlStatus;
  }>;
  cancelBackendSwitch(): Promise<void>;
  restoreBackend(): Promise<{ journal?: SwitchJournal; status: BackendControlStatus }>;
  cacheMaintenanceStatus(): Promise<CacheStatus>;
  cleanCache(): Promise<CacheCleanupResult>;
  agentChoices(): Promise<{ kind: string; installed: boolean }[]>;
  webhookSettings(): Promise<WebhookSettings>;
  saveWebhook(input: WebhookSaveInput): Promise<WebhookSettings>;
  testWebhook(): Promise<WebhookSettings>;
  installHerdr(): Promise<HerdrStatus>;
  checkHerdrUpdate(): Promise<HerdrStatus>;
  cliStatus(): Promise<{ installed: boolean; path: string; directory: string }>;
  skillsStatus(): Promise<SkillsStatus>; installSkills(): Promise<SkillsInstallResult>;
  methodPacksStatus(): Promise<SkillPackView[]>;
  previewMethodPack(): Promise<{
    path: string;
    manifest: SkillPackManifest;
    digest: string;
    files: string[];
    totalBytes: number;
    entryPreview: string;
    references: Array<{ path: string; content: string; characters: number }>;
  } | null>;
  installMethodPack(path: string, approveScripts: string[]): Promise<SkillPackView>;
  mutateMethodPack(
    packId: string,
    action: "approve" | "disable" | "enable" | "remove",
    scriptIds?: string[],
  ): Promise<SkillPackView[]>;
  agentRuntimeStatus(): Promise<AgentHookAdapterStatus[]>;
  configureAgentRuntime(
    id: ManagedAdapterId,
    action: "install" | "disable" | "uninstall" | "refresh",
  ): Promise<AgentHookAdapterStatus>;
  readClipboardText(): Promise<string>;
  readClipboardContent(): Promise<
    { kind: "text"; text: string } | { kind: "image" } | { kind: "empty" }
  >;
  writeClipboardText(value: string): Promise<void>;
  sceneSettings(): Promise<SceneSettingsStatus>;
  saveSceneSettings(input: SceneSettings): Promise<SceneSettingsStatus>;
  testSceneSettings(): Promise<ExternalSceneLease>;
  installCli(): Promise<{ output: string }>; prepareConcierge(): Promise<unknown>;
  coordinatorStatus(): Promise<CoordinatorInboxStatus>;
  dispatchGoal(goalId: string): Promise<unknown>;
  restartGoal(goalId: string, note: string): Promise<unknown>;
  terminalSnapshot(): Promise<{ session: string; data: string; running: boolean; sequence: number; cols: number; rows: number; error?: string } | undefined>;
  writeTerminal(session: string, data: string): Promise<void>;
  resizeTerminal(session: string, cols: number, rows: number): Promise<void>;
  openScene(goalId?: string, recover?: boolean): Promise<SceneOpenResult>;
  openExternalScene(goalId?: string): Promise<ExternalSceneLease>;
  openHerdr(goalId?: string): Promise<void>; openUrl(url: string): Promise<void>; showCli(): Promise<void>;
  openRecoveryBackup(): Promise<void>;
  openTerminal(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
}
declare global { interface Window { crewvane: DesktopApi } }
export const api = window.crewvane;
