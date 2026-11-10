import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const BROWSER_CACHE_DIRECTORIES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
] as const;
const WORKSPACE_TEMP_FILE = /^(?:\.state-.*\.tmp|events\.jsonl\..*\.tmp|coordinator-scope\.json\..*\.tmp)$/;
const RUNTIME_TEMP_FILE = /^(?:herdr\.download|\.version-probe-.*|.*\.tmp)$/;

export const CACHE_POLICY = {
  staleDays: 30,
  temporaryHours: 24,
  automaticIntervalHours: 24,
} as const;

export interface CacheMaintenancePaths {
  userDataRoot: string;
  cacheRoot: string;
  logsRoot?: string;
  workspaceRoot?: string;
}

export interface CacheCategoryUsage {
  id: "browser" | "logs" | "temporary";
  label: string;
  bytes: number;
  files: number;
  staleBytes: number;
  staleFiles: number;
}

export interface CacheStatus {
  totalBytes: number;
  totalFiles: number;
  staleBytes: number;
  staleFiles: number;
  categories: CacheCategoryUsage[];
  policy: typeof CACHE_POLICY;
}

export interface CacheCleanupResult {
  removedBytes: number;
  removedFiles: number;
  status: CacheStatus;
  warnings: string[];
}

interface Usage {
  bytes: number;
  files: number;
  staleBytes: number;
  staleFiles: number;
}

interface EntryUsage extends Usage {
  path: string;
  stale: boolean;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function browserRoots(paths: CacheMaintenancePaths) {
  return unique([
    ...BROWSER_CACHE_DIRECTORIES.map(name => join(paths.cacheRoot, name)),
    ...BROWSER_CACHE_DIRECTORIES.map(name => join(paths.userDataRoot, name)),
  ]);
}

function temporaryRoots(paths: CacheMaintenancePaths) {
  return [
    {
      root: join(paths.userDataRoot, "runtime"),
      matches: (name: string) => RUNTIME_TEMP_FILE.test(name),
    },
    ...(paths.workspaceRoot
      ? [{
          root: join(paths.workspaceRoot, ".crewvane"),
          matches: (name: string) => WORKSPACE_TEMP_FILE.test(name),
        }]
      : []),
  ];
}

async function directoryEntries(root: string) {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink())
      throw new Error("拒绝清理符号链接目录");
    return info.isDirectory() ? await readdir(root) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function entryUsage(path: string, staleBefore: number): Promise<EntryUsage> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { path, bytes: 0, files: 0, staleBytes: 0, staleFiles: 0, stale: false };
    throw error;
  }
  if (info.isSymbolicLink()) return {
    path,
    bytes: info.size,
    files: 1,
    staleBytes: info.mtimeMs <= staleBefore ? info.size : 0,
    staleFiles: info.mtimeMs <= staleBefore ? 1 : 0,
    stale: info.mtimeMs <= staleBefore,
  };
  if (!info.isDirectory()) return {
    path,
    bytes: info.size,
    files: 1,
    staleBytes: info.mtimeMs <= staleBefore ? info.size : 0,
    staleFiles: info.mtimeMs <= staleBefore ? 1 : 0,
    stale: info.mtimeMs <= staleBefore,
  };
  const usage: EntryUsage = { path, bytes: 0, files: 0, staleBytes: 0, staleFiles: 0, stale: true };
  for (const child of await readdir(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  })) {
    const childUsage = await entryUsage(join(path, child), staleBefore);
    usage.bytes += childUsage.bytes;
    usage.files += childUsage.files;
    usage.staleBytes += childUsage.staleBytes;
    usage.staleFiles += childUsage.staleFiles;
    usage.stale &&= childUsage.stale;
  }
  // A directory with no files is not user-visible disk usage.
  if (usage.files === 0) usage.stale = false;
  return usage;
}

async function filteredUsage(root: string, allowed: (name: string) => boolean, staleBefore: number): Promise<EntryUsage> {
  let entries;
  try {
    entries = await directoryEntries(root);
  } catch (error) {
    return { path: root, bytes: 0, files: 0, staleBytes: 0, staleFiles: 0, stale: false };
  }
  const usage: EntryUsage = { path: root, bytes: 0, files: 0, staleBytes: 0, staleFiles: 0, stale: true };
  for (const name of entries.filter(allowed)) {
    const child = await entryUsage(join(root, name), staleBefore);
    usage.bytes += child.bytes;
    usage.files += child.files;
    usage.staleBytes += child.staleBytes;
    usage.staleFiles += child.staleFiles;
    usage.stale &&= child.stale;
  }
  if (usage.files === 0) usage.stale = false;
  return usage;
}

function sum(entries: Usage[]) {
  return entries.reduce<Usage>((usage, entry) => ({
    bytes: usage.bytes + entry.bytes,
    files: usage.files + entry.files,
    staleBytes: usage.staleBytes + entry.staleBytes,
    staleFiles: usage.staleFiles + entry.staleFiles,
  }), { bytes: 0, files: 0, staleBytes: 0, staleFiles: 0 });
}

export async function inspectManagedCaches(
  paths: CacheMaintenancePaths,
  now = Date.now(),
): Promise<CacheStatus> {
  const staleBefore = now - CACHE_POLICY.staleDays * 24 * 60 * 60 * 1000,
    temporaryBefore = now - CACHE_POLICY.temporaryHours * 60 * 60 * 1000;
  const browser = sum(await Promise.all(
    browserRoots(paths).map(root => entryUsage(root, staleBefore)),
  ));
  const logs = sum(paths.logsRoot
    ? [await entryUsage(paths.logsRoot, staleBefore)]
    : []);
  const temporary = sum(await Promise.all(
    temporaryRoots(paths).map(({ root, matches }) =>
      filteredUsage(root, matches, temporaryBefore)),
  ));
  const categories: CacheCategoryUsage[] = [
    { id: "browser", label: "界面与渲染缓存", ...browser },
    { id: "logs", label: "诊断日志", ...logs },
    { id: "temporary", label: "遗留临时文件", ...temporary },
  ];
  const total = sum(categories);
  return {
    totalBytes: total.bytes,
    totalFiles: total.files,
    staleBytes: total.staleBytes,
    staleFiles: total.staleFiles,
    categories,
    policy: CACHE_POLICY,
  };
}

async function removeTreeChildren(root: string, warnings: string[]) {
  let entries;
  try {
    entries = await directoryEntries(root);
  } catch (error) {
    warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await Promise.all(entries.map(async name => {
    try {
      await rm(join(root, name), { recursive: true, force: true });
    } catch (error) {
      warnings.push(`${join(root, name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

async function removeStaleChildren(root: string, cutoff: number, warnings: string[]) {
  let entries;
  try {
    entries = await directoryEntries(root);
  } catch (error) {
    warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await Promise.all(entries.map(async name => {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await removeStaleChildren(path, cutoff, warnings);
      } else if (info.mtimeMs <= cutoff) {
        await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

async function removeFiltered(
  root: string,
  allowed: (name: string) => boolean,
  cutoff: number | undefined,
  warnings: string[],
) {
  let entries;
  try {
    entries = await directoryEntries(root);
  } catch (error) {
    warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  await Promise.all(entries.filter(allowed).map(async name => {
    const path = join(root, name);
    try {
      const info = await lstat(path);
      if (cutoff === undefined || info.mtimeMs <= cutoff)
        await rm(path, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

export async function clearManagedCaches(
  paths: CacheMaintenancePaths,
  options: {
    mode?: "automatic" | "manual";
    now?: number;
    clearBrowserRuntime?: () => Promise<void>;
  } = {},
): Promise<CacheCleanupResult> {
  const mode = options.mode ?? "manual",
    now = options.now ?? Date.now(),
    staleBefore = now - CACHE_POLICY.staleDays * 24 * 60 * 60 * 1000,
    temporaryBefore = now - CACHE_POLICY.temporaryHours * 60 * 60 * 1000,
    before = await inspectManagedCaches(paths, now),
    warnings: string[] = [];
  if (mode === "manual")
    await Promise.all(browserRoots(paths).map(root => removeTreeChildren(root, warnings)));
  else
    await Promise.all(browserRoots(paths).map(root => removeStaleChildren(root, staleBefore, warnings)));
  if (paths.logsRoot) await removeStaleChildren(paths.logsRoot, staleBefore, warnings);
  await Promise.all(temporaryRoots(paths).map(({ root, matches }) =>
    removeFiltered(root, matches, mode === "automatic" ? temporaryBefore : undefined, warnings)));
  if (options.clearBrowserRuntime) {
    try {
      await options.clearBrowserRuntime();
    } catch (error) {
      warnings.push(`Chromium cache: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const status = await inspectManagedCaches(paths, now);
  return {
    removedBytes: Math.max(0, before.totalBytes - status.totalBytes),
    removedFiles: Math.max(0, before.totalFiles - status.totalFiles),
    status,
    warnings,
  };
}
