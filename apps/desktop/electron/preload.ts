import { contextBridge, ipcRenderer } from "electron";
import type { CrewvaneCommand, GoalAttachment } from "../../../packages/core/src/index.js";
contextBridge.exposeInMainWorld("crewvane", {
  command: (command: CrewvaneCommand) => ipcRenderer.invoke("crewvane:command", command),
  importAttachments: (inputs: { name: string; bytes: ArrayBuffer }[]) =>
    ipcRenderer.invoke("crewvane:import-attachments", inputs) as Promise<GoalAttachment[]>,
  attachmentPreview: (goalId: string, attachmentId: string) =>
    ipcRenderer.invoke("crewvane:attachment-preview", goalId, attachmentId) as Promise<string>,
  openAttachment: (goalId: string, attachmentId: string) =>
    ipcRenderer.invoke("crewvane:open-attachment", goalId, attachmentId) as Promise<void>,
  selectWorkspace: () => ipcRenderer.invoke("crewvane:workspace"), selectProject: () => ipcRenderer.invoke("crewvane:project"),
  environment: () => ipcRenderer.invoke("crewvane:environment"), herdrStatus: () => ipcRenderer.invoke("crewvane:herdr-status"),
  cacheMaintenanceStatus: () => ipcRenderer.invoke("crewvane:cache-status"),
  cleanCache: () => ipcRenderer.invoke("crewvane:cache-clean"),
  agentChoices: () => ipcRenderer.invoke("crewvane:agent-choices"),
  webhookSettings: () => ipcRenderer.invoke("crewvane:webhook-settings"),
  saveWebhook: (input: unknown) => ipcRenderer.invoke("crewvane:webhook-save", input),
  testWebhook: () => ipcRenderer.invoke("crewvane:webhook-test"),
  installHerdr: () => ipcRenderer.invoke("crewvane:install-herdr"),
  checkHerdrUpdate: () => ipcRenderer.invoke("crewvane:check-herdr-update"),
  cliStatus: () => ipcRenderer.invoke("crewvane:cli-status"),
  orcaStatus: () => ipcRenderer.invoke("crewvane:orca-status"),
  orcaAction: (action: "check" | "install" | "cancel" | "refresh") =>
    ipcRenderer.invoke("crewvane:orca-action", action),
  selectOrcaApplication: () => ipcRenderer.invoke("crewvane:orca-select-application"),
  backendStatus: () => ipcRenderer.invoke("crewvane:backend-status"),
  switchBackend: (backend: "herdr" | "orca") =>
    ipcRenderer.invoke("crewvane:backend-switch", backend),
  retryBackendSwitch: () => ipcRenderer.invoke("crewvane:backend-retry"),
  cancelBackendSwitch: () => ipcRenderer.invoke("crewvane:backend-cancel"),
  restoreBackend: () => ipcRenderer.invoke("crewvane:backend-restore"),
  skillsStatus: () => ipcRenderer.invoke("crewvane:skills-status"), installSkills: () => ipcRenderer.invoke("crewvane:install-skills"),
  methodPacksStatus: () => ipcRenderer.invoke("crewvane:method-packs-status"),
  previewMethodPack: () => ipcRenderer.invoke("crewvane:method-pack-preview"),
  installMethodPack: (path: string, approveScripts: string[]) =>
    ipcRenderer.invoke("crewvane:method-pack-install", path, approveScripts),
  mutateMethodPack: (
    packId: string,
    action: "approve" | "disable" | "enable" | "remove",
    scriptIds: string[] = [],
  ) => ipcRenderer.invoke("crewvane:method-pack-action", packId, action, scriptIds),
  agentRuntimeStatus: () => ipcRenderer.invoke("crewvane:agent-runtime-status"),
  configureAgentRuntime: (id: string, action: "install" | "disable" | "uninstall" | "refresh") =>
    ipcRenderer.invoke("crewvane:agent-runtime-action", id, action),
  readClipboardText: () => ipcRenderer.invoke("crewvane:clipboard-read"),
  readClipboardContent: () => ipcRenderer.invoke("crewvane:clipboard-content"),
  writeClipboardText: (value: string) => ipcRenderer.invoke("crewvane:clipboard-write", value),
  sceneSettings: () => ipcRenderer.invoke("crewvane:scene-settings"),
  saveSceneSettings: (input: unknown) => ipcRenderer.invoke("crewvane:scene-settings-save", input),
  testSceneSettings: () => ipcRenderer.invoke("crewvane:scene-settings-test"),
  openTerminal: () => ipcRenderer.invoke("crewvane:open-terminal"),
  installCli: () => ipcRenderer.invoke("crewvane:install-cli"), prepareConcierge: () => ipcRenderer.invoke("crewvane:prepare-concierge"),
  coordinatorStatus: () => ipcRenderer.invoke("crewvane:coordinator-status"),
  dispatchGoal: (goalId: string) => ipcRenderer.invoke("crewvane:dispatch-goal", goalId),
  restartGoal: (goalId: string, note: string) =>
    ipcRenderer.invoke("crewvane:restart-goal", goalId, note),
  terminalSnapshot: () => ipcRenderer.invoke("crewvane:terminal-snapshot"),
  writeTerminal: (session: string, data: string) => ipcRenderer.invoke("crewvane:terminal-write", session, data),
  resizeTerminal: (session: string, cols: number, rows: number) => ipcRenderer.invoke("crewvane:terminal-resize", session, cols, rows),
  openScene: (goalId?: string, recover?: boolean) => ipcRenderer.invoke("crewvane:open-scene", goalId, recover),
  openExternalScene: (goalId?: string) => ipcRenderer.invoke("crewvane:open-scene-external", goalId),
  openHerdr: (goalId?: string) => ipcRenderer.invoke("crewvane:open-herdr", goalId), openUrl: (url: string) => ipcRenderer.invoke("crewvane:open-url", url), showCli: () => ipcRenderer.invoke("crewvane:show-cli"),
  openRecoveryBackup: () => ipcRenderer.invoke("crewvane:open-recovery-backup"),
  subscribe: (listener: (event: any) => void) => { const handler = (_: unknown, data: unknown) => listener(data); ipcRenderer.on("crewvane:event", handler); return () => ipcRenderer.removeListener("crewvane:event", handler); },
});
