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
  installHerdr: () => ipcRenderer.invoke("crewvane:install-herdr"), cliStatus: () => ipcRenderer.invoke("crewvane:cli-status"),
  skillsStatus: () => ipcRenderer.invoke("crewvane:skills-status"), installSkills: () => ipcRenderer.invoke("crewvane:install-skills"),
  readClipboardText: () => ipcRenderer.invoke("crewvane:clipboard-read"),
  writeClipboardText: (value: string) => ipcRenderer.invoke("crewvane:clipboard-write", value),
  openTerminal: () => ipcRenderer.invoke("crewvane:open-terminal"),
  installCli: () => ipcRenderer.invoke("crewvane:install-cli"), prepareConcierge: () => ipcRenderer.invoke("crewvane:prepare-concierge"),
  dispatchGoal: (goalId: string) => ipcRenderer.invoke("crewvane:dispatch-goal", goalId),
  restartGoal: (goalId: string, note: string) =>
    ipcRenderer.invoke("crewvane:restart-goal", goalId, note),
  terminalSnapshot: () => ipcRenderer.invoke("crewvane:terminal-snapshot"),
  writeTerminal: (session: string, data: string) => ipcRenderer.invoke("crewvane:terminal-write", session, data),
  resizeTerminal: (session: string, cols: number, rows: number) => ipcRenderer.invoke("crewvane:terminal-resize", session, cols, rows),
  openHerdr: (goalId?: string) => ipcRenderer.invoke("crewvane:open-herdr", goalId), openUrl: (url: string) => ipcRenderer.invoke("crewvane:open-url", url), showCli: () => ipcRenderer.invoke("crewvane:show-cli"),
  openRecoveryBackup: () => ipcRenderer.invoke("crewvane:open-recovery-backup"),
  subscribe: (listener: (event: any) => void) => { const handler = (_: unknown, data: unknown) => listener(data); ipcRenderer.on("crewvane:event", handler); return () => ipcRenderer.removeListener("crewvane:event", handler); },
});
