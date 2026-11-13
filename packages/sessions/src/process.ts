import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalProcessIdentity } from "../../core/src/index.js";

const exec = promisify(execFile);
let processTable: {
  at: number;
  promise: Promise<Map<number, LocalProcessIdentity & { parent: number }>>;
} | undefined;
function table(refreshAfter?: NonNullable<typeof processTable>["promise"]) {
  if (processTable && processTable.promise !== refreshAfter && Date.now() - processTable.at < 150)
    return processTable.promise;
  const promise = exec("/bin/ps", ["-axo", "pid=,ppid=,lstart="], {
    timeout: 2_000, maxBuffer: 2_000_000, env: { ...process.env, LC_ALL: "C" },
  }).then(({ stdout }) => {
    const rows = new Map<number, LocalProcessIdentity & { parent: number }>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), bornAt: match[3]!.trim() });
    }
    return rows;
  });
  processTable = { at: Date.now(), promise };
  return promise;
}
async function identityFor(pid: number, expectedBirth?: string): Promise<LocalProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    const snapshot = table();
    let row = (await snapshot).get(pid);
    // Launch admission just sampled ps before the child existed. A cache miss
    // (or a reused PID) needs one fresh, shared sample; it is not a dead process.
    if (!row || expectedBirth !== undefined && row.bornAt !== expectedBirth)
      row = (await table(snapshot)).get(pid);
    if (row) return { pid, bornAt: row.bornAt };
  } catch { /* An unverified PID is not a live identity. */ }
}
export interface ProcessInspector {
  identity(pid: number): Promise<LocalProcessIdentity | undefined>;
  alive(identity: LocalProcessIdentity): Promise<boolean>;
  hasChild(identity: LocalProcessIdentity): Promise<boolean>;
}
export const localProcesses: ProcessInspector = {
  identity: identityFor,
  async alive(identity) {
    return (await identityFor(identity.pid, identity.bornAt))?.bornAt === identity.bornAt;
  },
  async hasChild(identity) {
    if (!await this.alive(identity)) return false;
    return [...(await table()).values()].some(row => row.parent === identity.pid);
  },
};
