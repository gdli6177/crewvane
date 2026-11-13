import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { localProcesses } from "../src/process.js";

test("a process created after a cached process table is immediately verified by PID and birth time", async t => {
  await localProcesses.identity(process.pid);
  const child = spawn("/bin/sleep", ["10"]);
  t.after(() => { child.kill(); });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const pid = child.pid!;
  const bornAt = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
    { env: { ...process.env, LC_ALL: "C" } }).toString().trim();
  assert.equal(await localProcesses.alive({ pid, bornAt }), true);
  assert.equal(await localProcesses.alive({ pid, bornAt: `${bornAt}-different` }), false);
});
