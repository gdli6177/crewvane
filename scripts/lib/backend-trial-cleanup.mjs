import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { WorkspaceService } from "../../packages/core/src/index.ts";
import { SessionControl, localAdapter } from "../../packages/sessions/src/index.ts";

const exec = promisify(execFile);

export function ownedTrialProcesses(output, trial, known = [], callerPid = process.pid) {
  const prefix = trial.endsWith("/") ? trial : `${trial}/`;
  const rows = output.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/);
    return match ? [{
      pid: Number(match[1]), ppid: Number(match[2]),
      started: match[3].replace(/\s+/g, " "), command: match[4],
    }] : [];
  });
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const protectedPids = new Set([callerPid]);
  for (let parent = byPid.get(callerPid)?.ppid; parent && !protectedPids.has(parent); parent = byPid.get(parent)?.ppid)
    protectedPids.add(parent);
  // Select only known owners of this trial, then include their descendants.
  // A broad substring match would also catch the diagnostic shell that invoked
  // this cleanup and could terminate the caller.
  const owned = new Set(rows.filter(row =>
    row.command.includes(prefix) &&
    (((row.command.startsWith(prefix) || row.command.startsWith("/Applications/Orca.app/Contents/")) &&
      /\/(?:Orca(?: Helper(?: \([^)]*\))?)?|orca-terminal-host|chrome_crashpad_handler)(?:\s|$)/.test(row.command)) ||
      row.command.includes(`${trial}/userData/session-control/launchers/`) ||
      /^(?:\S*\/)?(?:codex|omp|claude|cursor|qoder)(?:\s|$)/.test(row.command))
  ).map(row => row.pid));
  // Keep the original birth identity after a dying parent reparents children.
  // A reused PID with a different start time is never part of this trial.
  for (const previous of known) {
    if (byPid.get(previous.pid)?.started === previous.started) owned.add(previous.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.pid) || !owned.has(row.ppid)) continue;
      owned.add(row.pid);
      changed = true;
    }
  }
  return rows.filter(row => owned.has(row.pid) && !protectedPids.has(row.pid));
}

async function ownedProcesses(trial, known) {
  const listed = await exec("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    timeout: 10_000, maxBuffer: 8_000_000,
  });
  return ownedTrialProcesses(listed.stdout, trial, known);
}

async function stopOwnedProcesses(trial) {
  let known = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    known = await ownedProcesses(trial, known);
    if (!known.length) return;
    for (const { pid } of known) {
      try { process.kill(pid, signal); } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  const remaining = await ownedProcesses(trial, known);
  if (remaining.length)
    throw new Error(`Owned backend trial processes survived cleanup: ${remaining.map(row => row.pid).join(",")}`);
}

/** Only exact scenes registered by this isolated trial may be closed. */
export async function cleanupBackendTrial(trial, executable, environment) {
  if (!trial.startsWith("/private/tmp/cv-backend-e2e-")) throw new Error("Not an owned backend trial.");
  const directory = join(trial, "userData/session-control");
  let closedScenes = 0;
  let deletedSetups = 0;
  try {
    const control = new SessionControl(directory);
    const configuration = await control.status().catch(() => undefined);
    if (configuration) {
      const workspace = join(trial, "工作 区");
      const state = await new WorkspaceService(workspace).read();
      const scenes = [state.concierge.scene, ...state.goals.flatMap(goal =>
        [goal.scene, goal.autonomy?.verificationSite?.scene])].filter(Boolean);
      for (const backend of ["herdr", "orca"]) {
        const adapter = localAdapter({ backend, workspace, directory, control: configuration,
          herdrExecutable: resolve(executable, "../../Resources/herdr"),
          environment: { ...environment, HOME: join(trial, "home"),
            XDG_CONFIG_HOME: join(trial, "home/.config"), XDG_STATE_HOME: join(trial, "home/.local/state") } });
        const runtime = await adapter.connect({ installationId: configuration.installationId, cwd: workspace }).catch(() => undefined);
        if (runtime) for (const match of await adapter.discover({
          installationId: configuration.installationId, runtimeId: runtime.id,
        })) scenes.push(match.scene);
      }
      for (const scene of [...new Map(scenes.map(scene => [scene.bindingId, scene])).values()]) {
        if (scene.installationId !== configuration.installationId) throw new Error("Foreign scene in trial.");
        const adapter = localAdapter({ backend: scene.backend, workspace, directory, control: configuration,
          herdrExecutable: resolve(executable, "../../Resources/herdr"),
          environment: { ...environment, HOME: join(trial, "home"),
            XDG_CONFIG_HOME: join(trial, "home/.config"), XDG_STATE_HOME: join(trial, "home/.local/state") } });
        await adapter.connect({ installationId: configuration.installationId, cwd: workspace });
        const stopped = await adapter.close(scene);
        if (!stopped.identityVerified || stopped.status === "unknown")
          throw new Error(`Owned trial cleanup unconfirmed: ${scene.bindingId}: ${stopped.detail}`);
        closedScenes++;
      }
    }

    // Orca registers each exact cwd as a visible folder project. Cleanup runs
    // even when session-control metadata is already missing, because the Orca
    // profile is the source that can still leave stale project rows visible.
    const profile = environment.ORCA_USER_DATA_PATH;
    if (!profile?.startsWith("/private/tmp/")) return;
    if (!await access(profile).then(() => true, () => false)) return;
    const orcaApp = environment.CREWVANE_TEST_ORCA_APP || configuration?.orcaAppPath || "/Applications/Orca.app";
    const orca = join(orcaApp, "Contents/Resources/bin/orca");
    const scope = {
      ...environment,
      ...(environment.CREWVANE_ORCA_HOST_HOME
        ? { HOME: environment.CREWVANE_ORCA_HOST_HOME }
        : {}),
      ORCA_USER_DATA_PATH: profile,
    };
    const prefix = trial.endsWith("/") ? trial : `${trial}/`;
    const listSetups = async () => {
      const listed = await exec(orca,
        ["project", "setups", "--environment", "local", "--json"],
        { env: scope, timeout: 10_000, maxBuffer: 4_000_000 });
      const setups = JSON.parse(listed.stdout).result?.setups;
      if (!Array.isArray(setups)) throw new Error("Orca project setup listing was not an array.");
      return setups.filter(setup => typeof setup?.path === "string" &&
        (setup.path === trial || setup.path.startsWith(prefix)) &&
        typeof setup?.id === "string");
    };
    const ownedSetups = await listSetups().catch(error => {
      throw new Error(`Could not inspect Orca project cleanup: ${String(error)}`);
    });
    for (const setup of ownedSetups.sort((a, b) => b.path.length - a.path.length)) {
      await exec(orca,
        ["project", "setup-delete", "--setup", setup.id, "--force", "--environment", "local", "--json"],
        { env: scope, timeout: 15_000, maxBuffer: 4_000_000 });
      deletedSetups++;
    }
    if (ownedSetups.length) {
      const remaining = await listSetups().catch(error => {
        throw new Error(`Could not verify Orca project cleanup: ${String(error)}`);
      });
      if (remaining.length)
        throw new Error(`Owned Orca project setups survived cleanup: ${remaining.map(setup => setup.path).join(",")}`);
    }
    // A per-trial profile is disposable. Stop the exact Orca process after its
    // test registrations are gone so later runs cannot accumulate an unbounded
    // project sidebar or accidentally reuse stale terminal state.
    if (!profile.startsWith(`${trial}/`) && profile !== trial) return;
    try {
      const status = await exec(orca, ["status", "--environment", "local", "--json"],
        { env: scope, timeout: 10_000, maxBuffer: 1_000_000 });
      const pid = JSON.parse(status.stdout).result?.app?.pid;
      if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, "SIGTERM");
    } catch {
      // A profile-scoped app may already be closed.
    }
  } finally {
    // Closing the main Electron app does not guarantee that its daemon,
    // crash reporter, or terminal children exit. Every process matched here has
    // this exact disposable trial path in its command line, so user sessions
    // and other isolated trials are never touched.
    await stopOwnedProcesses(trial);
  }
  return { closedScenes, deletedSetups, residualProcesses: 0 };
}
