import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceService } from "../../core/src/index.js";
import { readJSON, record } from "./io.js";
import { localProcesses } from "./process.js";
import { readLaunchReceipt, receiptProcess } from "./launcher.js";
import { SessionControl } from "./control/control.js";

/** Produces explicit managed paths only. Unknown leases, live launchers and
 * unfinished switch journals are never garbage-collected, even manually. */
export async function staleSessionStorage(directory: string, now = Date.now()): Promise<string[]> {
  const rootInfo = await lstat(directory).catch(() => undefined);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink() ||
    process.getuid && rootInfo.uid !== process.getuid()) return [];
  // Validate every component, including parents: lstat(file) alone follows a
  // symlinked adapters/ or launchers/ parent outside the managed directory.
  const managed = async (...parts: string[]) => {
    let path = directory;
    for (const part of parts.flatMap(part => part.split("/"))) {
      if (!/^[\w.-]+$/.test(part) || part === "." || part === "..") return;
      path = join(path, part);
      const info = await lstat(path).catch(() => undefined);
      if (!info || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid()) return;
    }
    return path;
  };
  const control = new SessionControl(directory);
  const config = await control.status().catch(() => undefined);
  if (!config) return [];
  const activeRequests = new Set<string>(), activeBindings = new Set<string>();
  for (const entry of await control.registrations()) {
    let state;
    try { state = await new WorkspaceService(entry.root).read(); }
    catch { return []; } // Cannot prove ownership/liveness across all roots.
    const intents = [state.concierge.launch, ...state.goals.flatMap(goal =>
      [goal.sceneLaunch, goal.autonomy?.verificationLaunch])].filter(Boolean);
    for (const intent of intents) if (intent!.status !== "rejected") activeRequests.add(intent!.requestId);
    for (const scene of [state.concierge.scene, ...state.goals.flatMap(goal =>
      [goal.scene, goal.autonomy?.verificationSite?.scene])])
      if (scene) activeBindings.add(scene.bindingId);
  }
  const paths: string[] = [], cutoff = now - 24 * 60 * 60_000, month = now - 30 * 24 * 60 * 60_000;
  const entries = async (folder: string) => {
    const root = await managed(folder);
    if (!root || !(await lstat(root)).isDirectory()) return [];
    return (await readdir(root)).filter(name => /^[\w-]+\.json$/.test(name)).map(name => join(root, name));
  };
  for (const path of await entries("runtime-launches")) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > cutoff) continue;
    const value = await readJSON(path);
    if (!record(value) || !record(value.intent) || typeof value.intent.requestId !== "string" ||
      !/^[\w-]{1,160}$/.test(value.intent.requestId) ||
      typeof value.intent.bindingId !== "string" || activeRequests.has(value.intent.requestId) ||
      activeBindings.has(value.intent.bindingId)) continue;
    const id = value.intent.requestId, launcher = await managed("launchers", id);
    if (!launcher) continue;
    const receiptPath = await managed("launchers", id, "environment-ready.json");
    const receipt = receiptPath ? await readLaunchReceipt(receiptPath).catch(() => undefined) : undefined;
    const leasePath = await managed("leases", `${id}.json`);
    const lease = leasePath ? await readJSON(leasePath).catch(() => undefined) : undefined;
    if (!receipt && value.intent.status !== "rejected") continue;
    if (receipt && await localProcesses.alive(receiptProcess(receipt))) continue;
    if (record(lease) && lease.status !== "finished") continue;
    paths.push(path, launcher);
    for (const backend of ["herdr", "orca"]) {
      const adapterPath = await managed("adapters", backend, "launches", `${id}.json`);
      if (adapterPath) paths.push(adapterPath);
    }
  }
  for (const path of await entries("leases")) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > month) continue;
    const lease = await readJSON(path);
    if (record(lease) && lease.status === "finished" &&
      typeof lease.requestId === "string" && !activeRequests.has(lease.requestId) &&
      (typeof lease.bindingId !== "string" || !activeBindings.has(lease.bindingId))) paths.push(path);
  }
  for (const folder of ["runtime-deliveries", "adapters/herdr/deliveries", "adapters/orca/deliveries"]) {
    for (const path of await entries(folder)) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs > month) continue;
      const receipt = await readJSON(path);
      if (record(receipt) && record(receipt.scene) && typeof receipt.scene.bindingId === "string" &&
        !activeBindings.has(receipt.scene.bindingId) && ["rejected", "started", "accepted"].includes(String(receipt.status)))
        paths.push(path);
      if (paths.includes(path) && folder === "adapters/herdr/deliveries" &&
        typeof receipt === "object" && receipt && "deliveryId" in receipt && typeof receipt.deliveryId === "string") {
        if (!/^[\w-]+$/.test(receipt.deliveryId)) continue;
        const payload = await managed("adapters/herdr/payloads", `${receipt.deliveryId}.txt`);
        // The receipt proves terminal delivery and owns the retention window;
        // a recently accessed payload must not extend that window forever.
        if (payload && (await lstat(payload)).isFile()) paths.push(payload);
      }
    }
  }
  const finalJournals: { path: string; at: number }[] = [];
  for (const path of await entries("switch")) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) continue;
    const value = await readJSON(path);
    if (record(value) && ["ready", "cancelled"].includes(String(value.phase)) &&
      value.operationId !== config.switchOperationId) finalJournals.push({ path, at: info.mtimeMs });
  }
  finalJournals.sort((a, b) => b.at - a.at).forEach((entry, index) => {
    if (index >= 20 || entry.at < month) paths.push(entry.path);
  });
  const recoveryRoot = await managed("recovery");
  if (recoveryRoot && (await lstat(recoveryRoot)).isDirectory()) {
    for (const name of await readdir(recoveryRoot)) {
      if (!/^[\w-]+$/.test(name)) continue;
      const path = await managed("recovery", name);
      if (!path || !(await lstat(path)).isDirectory() || (await lstat(path)).mtimeMs > cutoff) continue;
      const files = await readdir(path);
      // A pending/claimed request may already have caused a side effect.
      if (files.some(file => /\.request\.json|\.claimed\.json/.test(file))) continue;
      const hostPath = await managed("recovery", name, "host.json");
      const host = hostPath && await readJSON(hostPath).catch(() => undefined);
      if (!record(host) || !record(host.process) || typeof host.process.pid !== "number" ||
        typeof host.process.bornAt !== "string" ||
        await localProcesses.alive({ pid: host.process.pid, bornAt: host.process.bornAt })) continue;
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}
