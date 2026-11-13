import assert from "node:assert/strict";
import test from "node:test";
import { ownedTrialProcesses } from "../../../scripts/lib/backend-trial-cleanup.mjs";

const trial = "/private/tmp/cv-backend-e2e-owned";
const birth = "Fri Nov 13 22:15:00 2026";
const row = (pid: number, ppid: number, command: string, started = birth) =>
  `${pid} ${ppid} ${started} ${command}`;

test("backend trial cleanup owns only the exact profile and descendants, protecting its caller and user Orca", () => {
  const rows = [
    row(10, 1, `/Applications/Orca.app/Contents/MacOS/Orca --user-data-dir=${trial}/orca-profile`),
    row(20, 10, `${trial}/orca-profile/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host`),
    row(30, 20, "omp"),
    row(40, 1, "/Applications/Orca.app/Contents/MacOS/Orca"),
    row(50, 1, "/private/tmp/cv-backend-e2e-other/profile/Orca.app/Contents/MacOS/Orca"),
    row(90, 1, `/bin/zsh -c inspect Orca ${trial}/orca-profile`),
    row(99, 90, `/bin/zsh -c cleanup Orca ${trial}/orca-profile`),
    row(100, 99, `/node cleanup.mjs ${trial}/`),
  ].join("\n");
  assert.deepEqual(ownedTrialProcesses(rows, trial, [], 100).map(item => item.pid), [10, 20, 30]);
});

test("backend trial cleanup retains reparented children by birth identity, rejecting reused PIDs", () => {
  const before = ownedTrialProcesses([
    row(10, 1, `${trial}/Orca.app/Contents/MacOS/Orca`),
    row(20, 10, "/bin/zsh"),
    row(30, 20, "omp"),
  ].join("\n"), trial, [], 100);
  const after = ownedTrialProcesses([
    row(20, 1, "/bin/zsh"),
    row(30, 1, "omp", "Fri Nov 13 22:16:00 2026"),
  ].join("\n"), trial, before, 100);
  assert.deepEqual(after.map(item => item.pid), [20]);
});
