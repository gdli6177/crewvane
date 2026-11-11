import type { CrewvaneCommand, GoalAttachment } from "../../../packages/core/src/index.js";
import type { HerdrStatus } from "../electron/herdr-install.js";
import type { HerdrPluginStatus } from "../electron/herdr-plugin.js";
import type { WebhookSaveInput, WebhookSettings } from "../electron/webhook-notifications.js";
import type { SkillsInstallResult, SkillsStatus } from "../electron/skill-installer.js";
import type { CacheCleanupResult, CacheStatus } from "../electron/cache-maintenance.js";
import type { AgentHookAdapterStatus, ManagedAdapterId } from "../electron/agent-hook-manager.js";
import type { CoordinatorInboxStatus } from "../electron/coordinator-inbox.js";
export interface DesktopApi {
  command(command: CrewvaneCommand): Promise<any>;
  importAttachments(inputs: { name: string; bytes: ArrayBuffer }[]): Promise<GoalAttachment[]>;
  attachmentPreview(goalId: string, attachmentId: string): Promise<string>;
  openAttachment(goalId: string, attachmentId: string): Promise<void>;
  selectWorkspace(): Promise<string | null>; selectProject(): Promise<string | null>;
  environment(): Promise<{ workspace?: string; version: string }>;
  herdrStatus(): Promise<HerdrStatus & { session: string; plugin: HerdrPluginStatus }>;
  cacheMaintenanceStatus(): Promise<CacheStatus>;
  cleanCache(): Promise<CacheCleanupResult>;
  agentChoices(): Promise<{ kind: string; installed: boolean }[]>;
  webhookSettings(): Promise<WebhookSettings>;
  saveWebhook(input: WebhookSaveInput): Promise<WebhookSettings>;
  testWebhook(): Promise<WebhookSettings>;
  installHerdr(): Promise<unknown>; cliStatus(): Promise<{ installed: boolean; path: string; directory: string }>;
  skillsStatus(): Promise<SkillsStatus>; installSkills(): Promise<SkillsInstallResult>;
  agentRuntimeStatus(): Promise<AgentHookAdapterStatus[]>;
  configureAgentRuntime(
    id: ManagedAdapterId,
    action: "install" | "disable" | "uninstall" | "refresh",
  ): Promise<AgentHookAdapterStatus>;
  readClipboardText(): Promise<string>; writeClipboardText(value: string): Promise<void>;
  installCli(): Promise<{ output: string }>; prepareConcierge(): Promise<unknown>;
  coordinatorStatus(): Promise<CoordinatorInboxStatus>;
  dispatchGoal(goalId: string): Promise<unknown>;
  restartGoal(goalId: string, note: string): Promise<unknown>;
  terminalSnapshot(): Promise<{ session: string; data: string; running: boolean; sequence: number; cols: number; rows: number; error?: string } | undefined>;
  writeTerminal(session: string, data: string): Promise<void>;
  resizeTerminal(session: string, cols: number, rows: number): Promise<void>;
  openHerdr(goalId?: string): Promise<void>; openUrl(url: string): Promise<void>; showCli(): Promise<void>;
  openRecoveryBackup(): Promise<void>;
  openTerminal(): Promise<void>;
  subscribe(listener: (event: any) => void): () => void;
}
declare global { interface Window { crewvane: DesktopApi } }
export const api = window.crewvane;
