import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { quoteShell } from "./herdr.js";

const exec = promisify(execFile);

export type SceneOpenMode = "external" | "embedded";
export type ExternalTerminalId = "auto" | "iterm2" | "terminal" | "ghostty";
export type ResolvedExternalTerminalId = Exclude<ExternalTerminalId, "auto">;

export interface SceneSettings {
  openWith: SceneOpenMode;
  terminal: ExternalTerminalId;
}

export interface ExternalTerminalAvailability {
  id: ResolvedExternalTerminalId;
  label: string;
  installed: boolean;
  detail?: string;
}

export interface SceneSettingsStatus {
  settings: SceneSettings;
  terminals: ExternalTerminalAvailability[];
  resolved?: ResolvedExternalTerminalId;
}

export interface ExternalSceneInput {
  workspaceRoot: string;
  session: string;
  herdrExecutable: string;
}

export interface ExternalSceneLease {
  id: string;
  terminal: ResolvedExternalTerminalId;
  session: string;
  workspaceHash: string;
  tty?: string;
  processId?: number;
  openedAt: string;
}

interface StoredScenePreferences extends SceneSettings {
  lastSuccessfulTerminal?: ResolvedExternalTerminalId;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ExternalTerminalManagerOptions {
  userDataRoot: string;
  run?: CommandRunner;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pathExists?: (path: string) => Promise<boolean>;
}

const defaults: StoredScenePreferences = {
  openWith: "external",
  terminal: "auto",
};

const terminalLabels: Record<ResolvedExternalTerminalId, string> = {
  iterm2: "iTerm2",
  terminal: "Terminal",
  ghostty: "Ghostty",
};

const installedPaths: Record<ResolvedExternalTerminalId, string[]> = {
  iterm2: ["/Applications/iTerm.app", "/Applications/iTerm2.app"],
  terminal: ["/System/Applications/Utilities/Terminal.app", "/Applications/Utilities/Terminal.app"],
  ghostty: ["/Applications/Ghostty.app"],
};

const validModes = new Set<SceneOpenMode>(["external", "embedded"]);
const validTerminals = new Set<ExternalTerminalId>(["auto", "iterm2", "terminal", "ghostty"]);
const resolvedTerminals = new Set<ResolvedExternalTerminalId>(["iterm2", "terminal", "ghostty"]);

function asSettings(value: unknown): StoredScenePreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ...defaults };
  const candidate = value as Record<string, unknown>;
  return {
    openWith: validModes.has(candidate.openWith as SceneOpenMode)
      ? candidate.openWith as SceneOpenMode
      : defaults.openWith,
    terminal: validTerminals.has(candidate.terminal as ExternalTerminalId)
      ? candidate.terminal as ExternalTerminalId
      : defaults.terminal,
    ...(resolvedTerminals.has(candidate.lastSuccessfulTerminal as ResolvedExternalTerminalId)
      ? { lastSuccessfulTerminal: candidate.lastSuccessfulTerminal as ResolvedExternalTerminalId }
      : {}),
  };
}

function workspaceHash(path: string) {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function normalizeSession(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(value))
    throw new Error("外部终端 Session 名称无效");
  return value;
}

function normalizePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new Error(`${label}无效`);
  return value;
}

function appleScript(lines: string[]) {
  return lines.join("\n");
}

const focusScripts: Record<ResolvedExternalTerminalId, string | undefined> = {
  iterm2: appleScript([
    "on run argv",
    'tell application "iTerm2"',
    "set targetTTY to item 1 of argv",
    "repeat with targetWindow in windows",
    "repeat with targetTab in tabs of targetWindow",
    "repeat with targetSession in sessions of targetTab",
    "try",
    "if tty of targetSession is targetTTY then",
    "select targetTab",
    "select targetSession",
    "set frontmost of targetWindow to true",
    "activate",
    "return true",
    "end if",
    "end try",
    "end repeat",
    "end repeat",
    "end repeat",
    "return false",
    "end tell",
    "end run",
  ]),
  terminal: appleScript([
    "on run argv",
    'tell application "Terminal"',
    "set targetTTY to item 1 of argv",
    "repeat with targetWindow in windows",
    "repeat with targetTab in tabs of targetWindow",
    "if tty of targetTab is targetTTY then",
    "set selected tab of targetWindow to targetTab",
    "set frontmost of targetWindow to true",
    "activate",
    "return true",
    "end if",
    "end repeat",
    "end repeat",
    "return false",
    "end tell",
    "end run",
  ]),
  // Ghostty has no stable per-window AppleScript locator. Opening remains
  // supported, while focus only activates the application.
  ghostty: undefined,
};

const openScripts: Record<ResolvedExternalTerminalId, string> = {
  iterm2: appleScript([
    "on run argv",
    'tell application "iTerm2"',
    "activate",
    "set newWindow to create window with default profile",
    "tell current session of newWindow",
    'write text ("exec " & quoted form of item 1 of argv)',
    "end tell",
    "return true",
    "end tell",
    "end run",
  ]),
  terminal: appleScript([
    "on run argv",
    'tell application "Terminal"',
    "activate",
    'do script ("exec " & quoted form of item 1 of argv)',
    "return true",
    "end tell",
    "end run",
  ]),
  ghostty: "",
};

export class ExternalTerminalManager {
  private readonly root: string;
  private readonly preferencesPath: string;
  private readonly leaseRoot: string;
  private readonly launcherRoot: string;
  private readonly run: CommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly pathExists: (path: string) => Promise<boolean>;
  private readonly focusAutomationUnavailable = new Set<ResolvedExternalTerminalId>();

  constructor(options: ExternalTerminalManagerOptions) {
    this.root = options.userDataRoot;
    this.preferencesPath = join(this.root, "scene-settings.json");
    this.leaseRoot = join(this.root, "external-terminal", "leases");
    this.launcherRoot = join(this.root, "external-terminal", "launchers");
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.pathExists = options.pathExists ??
      (path => lstat(path).then(() => true).catch(() => false));
    this.run = options.run ?? (async (command, args) => {
      const result = await exec(command, args, {
        timeout: 8_000,
        maxBuffer: 256_000,
        env: this.env,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    });
  }

  private async readPreferences(): Promise<StoredScenePreferences> {
    try {
      return asSettings(JSON.parse(await readFile(this.preferencesPath, "utf8")));
    } catch {
      return { ...defaults };
    }
  }

  private async writePreferences(value: StoredScenePreferences) {
    await mkdir(dirname(this.preferencesPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.preferencesPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.preferencesPath);
    await chmod(this.preferencesPath, 0o600);
  }

  async detect(): Promise<ExternalTerminalAvailability[]> {
    if (this.platform !== "darwin") {
      return Object.entries(terminalLabels).map(([id, label]) => ({
        id: id as ResolvedExternalTerminalId,
        label,
        installed: false,
        detail: "仅支持 macOS",
      }));
    }
    return Promise.all(
      (Object.keys(terminalLabels) as ResolvedExternalTerminalId[]).map(async id => {
        const installed = (
          await Promise.all(installedPaths[id].map(async path =>
            this.pathExists(path),
          ))
        ).some(Boolean);
        return {
          id,
          label: terminalLabels[id],
          installed,
          ...(!installed ? { detail: `未在标准位置找到 ${terminalLabels[id]}.app` } : {}),
        };
      }),
    );
  }

  private resolveTerminal(
    preferences: StoredScenePreferences,
    terminals: ExternalTerminalAvailability[],
  ): ResolvedExternalTerminalId | undefined {
    if (preferences.terminal !== "auto")
      return terminals.find(item => item.id === preferences.terminal && item.installed)?.id;
    const launchedFrom = this.env.TERM_PROGRAM;
    const current = launchedFrom === "iTerm.app"
      ? "iterm2"
      : launchedFrom === "Apple_Terminal"
        ? "terminal"
        : launchedFrom === "ghostty"
          ? "ghostty"
          : undefined;
    const candidates = [
      current,
      preferences.lastSuccessfulTerminal,
      "terminal" as const,
      "iterm2" as const,
      "ghostty" as const,
    ];
    return candidates.find(id =>
      id && terminals.some(item => item.id === id && item.installed),
    ) as ResolvedExternalTerminalId | undefined;
  }

  async status(): Promise<SceneSettingsStatus> {
    const preferences = await this.readPreferences(),
      terminals = await this.detect();
    const resolved = this.resolveTerminal(preferences, terminals);
    return {
      settings: { openWith: preferences.openWith, terminal: preferences.terminal },
      terminals,
      ...(resolved ? { resolved } : {}),
    };
  }

  async save(input: SceneSettings): Promise<SceneSettingsStatus> {
    if (!validModes.has(input?.openWith) || !validTerminals.has(input?.terminal))
      throw new Error("工作现场设置无效");
    const previous = await this.readPreferences();
    await this.writePreferences({
      openWith: input.openWith,
      terminal: input.terminal,
      ...(previous.lastSuccessfulTerminal
        ? { lastSuccessfulTerminal: previous.lastSuccessfulTerminal }
        : {}),
    });
    return this.status();
  }

  private leasePath(input: ExternalSceneInput) {
    return join(
      this.leaseRoot,
      `${workspaceHash(input.workspaceRoot)}-${workspaceHash(input.session)}.json`,
    );
  }

  private launcherPath(input: ExternalSceneInput) {
    return join(
      this.launcherRoot,
      `${workspaceHash(input.workspaceRoot)}-${workspaceHash(input.session)}.sh`,
    );
  }

  private ttyPath(input: ExternalSceneInput) {
    return join(
      this.leaseRoot,
      `${workspaceHash(input.workspaceRoot)}-${workspaceHash(input.session)}.tty`,
    );
  }

  private pidPath(input: ExternalSceneInput) {
    return join(
      this.leaseRoot,
      `${workspaceHash(input.workspaceRoot)}-${workspaceHash(input.session)}.pid`,
    );
  }

  private async readLease(
    input: ExternalSceneInput,
  ): Promise<ExternalSceneLease | undefined> {
    try {
      const value = JSON.parse(await readFile(this.leasePath(input), "utf8")) as ExternalSceneLease;
      const tty = await readFile(this.ttyPath(input), "utf8")
        .then(content => content.trim())
        .catch(() => "");
      const pid = await readFile(this.pidPath(input), "utf8")
        .then(content => Number(content.trim()))
        .catch(() => value.processId);
      if (
        typeof value.id !== "string" ||
        value.session !== input.session ||
        value.workspaceHash !== workspaceHash(input.workspaceRoot) ||
        !resolvedTerminals.has(value.terminal) ||
        (!tty.startsWith("/dev/") &&
          (!Number.isSafeInteger(pid) || Number(pid) <= 1))
      ) return undefined;
      return {
        ...value,
        ...(tty.startsWith("/dev/") ? { tty } : {}),
        ...(Number.isSafeInteger(pid) && Number(pid) > 1
          ? { processId: Number(pid) }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async writeLauncher(
    input: ExternalSceneInput,
    leasePath: string,
    lease: ExternalSceneLease,
  ) {
    await mkdir(this.launcherRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.leaseRoot, { recursive: true, mode: 0o700 });
    await chmod(this.launcherRoot, 0o700);
    await chmod(this.leaseRoot, 0o700);
    const launcher = this.launcherPath(input),
      ttyPath = this.ttyPath(input),
      pidPath = this.pidPath(input),
      temporaryLease = `${leasePath}.tmp`;
    await writeFile(temporaryLease, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryLease, leasePath);
    await chmod(leasePath, 0o600);
    const script = [
      "#!/bin/sh",
      "set -eu",
      "umask 077",
      'current_tty="$(tty 2>/dev/null || true)"',
      'if [ -n "$current_tty" ]; then',
      `  printf '%s\\n' "$current_tty" > ${quoteShell(`${ttyPath}.tmp`)}`,
      `  chmod 600 ${quoteShell(`${ttyPath}.tmp`)}`,
      `  mv ${quoteShell(`${ttyPath}.tmp`)} ${quoteShell(ttyPath)}`,
      "fi",
      `printf '%s\\n' "$$" > ${quoteShell(`${pidPath}.tmp`)}`,
      `chmod 600 ${quoteShell(`${pidPath}.tmp`)}`,
      `mv ${quoteShell(`${pidPath}.tmp`)} ${quoteShell(pidPath)}`,
      `cd ${quoteShell(input.workspaceRoot)}`,
      `exec ${quoteShell(input.herdrExecutable)} session attach ${quoteShell(input.session)}`,
      "",
    ].join("\n");
    const temporaryLauncher = `${launcher}.${process.pid}.tmp`;
    await writeFile(temporaryLauncher, script, { mode: 0o700 });
    await chmod(temporaryLauncher, 0o700);
    await rename(temporaryLauncher, launcher);
    return launcher;
  }

  private async removeStaleLease(input: ExternalSceneInput) {
    const path = this.leasePath(input);
    await rm(path, { force: true }).catch(() => {});
    await rm(this.ttyPath(input), { force: true }).catch(() => {});
    await rm(`${this.ttyPath(input)}.tmp`, { force: true }).catch(() => {});
    await rm(this.pidPath(input), { force: true }).catch(() => {});
    await rm(`${this.pidPath(input)}.tmp`, { force: true }).catch(() => {});
  }

  private async processAlive(processId?: number) {
    if (!processId) return false;
    try {
      await this.run("/bin/kill", ["-0", String(processId)]);
      return true;
    } catch {
      return false;
    }
  }

  private async ttyAlive(tty?: string) {
    if (!tty?.startsWith("/dev/")) return false;
    const name = tty.slice("/dev/".length);
    if (!/^[A-Za-z0-9]+$/.test(name)) return false;
    try {
      const result = await this.run("/bin/ps", ["-t", name, "-o", "pid="]);
      return Boolean(result.stdout.trim());
    } catch {
      return false;
    }
  }

  private async activate(
    terminal: ResolvedExternalTerminalId,
  ): Promise<boolean> {
    const application = terminal === "iterm2"
      ? "iTerm"
      : terminal === "terminal"
        ? "Terminal"
        : "Ghostty";
    return this.run("/usr/bin/open", ["-a", application])
      .then(() => true)
      .catch(() => false);
  }

  private async focusExisting(
    terminal: ResolvedExternalTerminalId,
    lease: ExternalSceneLease,
  ): Promise<boolean> {
    // Herdr has already selected the requested Session tab. A live attach
    // process therefore only needs its existing terminal window activated;
    // TTY matching is a compatibility fallback for older leases.
    if (lease.processId) {
      return await this.processAlive(lease.processId)
        ? this.activate(terminal)
        : false;
    }
    // PS is intentionally cheap. It distinguishes a legacy lease whose
    // terminal window was closed from one whose TTY still exists, avoiding an
    // 8-second AppleScript probe that makes the desktop feel unresponsive.
    const tty = lease.tty;
    if (!tty || !await this.ttyAlive(tty)) return false;
    if (terminal === "ghostty") {
      return this.activate(terminal);
    }
    if (this.focusAutomationUnavailable.has(terminal)) {
      return this.activate(terminal);
    }
    const script = focusScripts[terminal];
    if (!script) return false;
    try {
      const result = await this.run("/usr/bin/osascript", ["-e", script, "--", tty]);
      return result.stdout.trim() === "true";
    } catch {
      // Automation permission can be denied even though LaunchServices may
      // still bring the terminal forward. Avoid a second prompt/8s stall and
      // never create a duplicate Herdr window just because focus failed.
      this.focusAutomationUnavailable.add(terminal);
      return this.activate(terminal);
    }
  }

  private async openNew(
    terminal: ResolvedExternalTerminalId,
    launcher: string,
  ): Promise<void> {
    if (terminal === "ghostty") {
      await this.run("open", [
        "-na",
        "Ghostty",
        "--args",
        "-e",
        launcher,
      ]);
      return;
    }
    if (terminal === "terminal") {
      await this.run("/usr/bin/open", ["-a", "Terminal", launcher]);
      return;
    }
    await this.run("/usr/bin/osascript", ["-e", openScripts[terminal], "--", launcher]);
  }

  private async waitForProcessId(
    input: ExternalSceneInput,
    timeout = 2_000,
  ): Promise<number | undefined> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const pid = await readFile(this.pidPath(input), "utf8")
        .then(content => Number(content.trim()))
        .catch(() => undefined);
      if (Number.isSafeInteger(pid) && Number(pid) > 1) return Number(pid);
      await delay(50);
    }
  }

  async open(input: ExternalSceneInput): Promise<ExternalSceneLease> {
    if (this.platform !== "darwin")
      throw new Error("外部终端现场目前只支持 macOS");
    normalizePath(input.workspaceRoot, "工作区路径");
    normalizePath(input.herdrExecutable, "Herdr 路径");
    normalizeSession(input.session);
    const preferences = await this.readPreferences(),
      terminals = await this.detect(),
      terminal = this.resolveTerminal(preferences, terminals);
    if (!terminal) {
      const selected = preferences.terminal === "auto"
        ? "iTerm2、Terminal 或 Ghostty"
        : terminalLabels[preferences.terminal];
      throw new Error(`没有找到可用的 ${selected}。可在设置中改用内嵌轻现场。`);
    }
    const leaseFile = this.leasePath(input),
      existing = await this.readLease(input);
    if (existing && existing.terminal === terminal &&
      await this.focusExisting(terminal, existing)) {
      return existing;
    }
    if (existing) await this.removeStaleLease(input);

    const lease: ExternalSceneLease = {
      id: `${workspaceHash(input.workspaceRoot)}-${this.now().getTime()}`,
      terminal,
      session: input.session,
      workspaceHash: workspaceHash(input.workspaceRoot),
      openedAt: this.now().toISOString(),
    };
    const launcher = await this.writeLauncher(input, leaseFile, lease);
    try {
      await this.openNew(terminal, launcher);
    } catch (error) {
      await this.removeStaleLease(input);
      const commandError = error as Error & { stderr?: string | Buffer };
      const detail = [
        commandError instanceof Error ? commandError.message : String(error),
        commandError.stderr ? String(commandError.stderr).trim() : "",
      ].filter(Boolean).join(" ");
      throw new Error(
        `无法在 ${terminalLabels[terminal]} 打开工作现场。请允许 Crewvane 控制该终端，或在设置中改用内嵌轻现场。${detail ? ` ${detail}` : ""}`,
      );
    }
    await this.writePreferences({
      ...preferences,
      lastSuccessfulTerminal: terminal,
    });
    const processId = await this.waitForProcessId(input);
    return processId ? { ...lease, processId } : lease;
  }
}
