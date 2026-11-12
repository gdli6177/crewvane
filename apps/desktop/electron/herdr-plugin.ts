import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const CREWVANE_HERDR_PLUGIN_ID = "dev.crewvane";
const PLUGIN_SOURCE_FILES = [
  "herdr-plugin.toml",
  "open-pane.sh",
  "run-cli.sh",
  "new-goal.sh",
  "sync-live.sh",
  "focus-concierge.sh",
] as const;

export interface HerdrPluginStatus {
  phase: "idle" | "installing" | "ready" | "error";
  installed: boolean;
  version?: string;
  path?: string;
  detail?: string;
}

interface PluginInfo {
  plugin_id?: unknown;
  version?: unknown;
  enabled?: unknown;
  plugin_root?: unknown;
}

type Runner = (executable: string, args: string[], env: NodeJS.ProcessEnv) =>
  Promise<{ stdout: string; stderr: string }>;

function pluginList(stdout: string): PluginInfo | undefined {
  let value: any;
  try { value = JSON.parse(stdout); }
  catch { throw new Error("Herdr 插件列表不是有效 JSON"); }
  if (value?.result?.plugin?.plugin_id === CREWVANE_HERDR_PLUGIN_ID)
    return value.result.plugin as PluginInfo;
  const plugins = value?.result?.plugins ?? value?.plugins;
  if (!Array.isArray(plugins)) throw new Error("Herdr 插件列表缺少 plugins");
  return plugins.find((plugin: PluginInfo) => plugin.plugin_id === CREWVANE_HERDR_PLUGIN_ID) as PluginInfo | undefined;
}

function manifestVersion(manifest: string) {
  if (!new RegExp(`^id\\s*=\\s*"${CREWVANE_HERDR_PLUGIN_ID.replaceAll(".", "\\.")}"$`, "m").test(manifest))
    throw new Error("内置 Herdr 插件 ID 不匹配");
  const version = /^version\s*=\s*"([^"]+)"$/m.exec(manifest)?.[1];
  if (!version) throw new Error("内置 Herdr 插件缺少版本");
  return version;
}

export class HerdrPlugin {
  private current: HerdrPluginStatus = { phase: "idle", installed: false };
  private pending?: Promise<HerdrPluginStatus>;

  constructor(
    readonly sourceRoot: string,
    readonly installRoot: string,
    readonly expectedVersion: string,
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly runner: Runner = async (executable, args, env) => exec(executable, args, {
      // An existing Herdr server may need to answer after it wakes up or
      // upgrades. Causing a false error at exactly 30s makes settings look
      // broken while the command is still healthy.
      env, timeout: 60_000, maxBuffer: 2_000_000,
    }),
  ) {}

  status(): HerdrPluginStatus {
    return { ...this.current };
  }

  fail(detail: string) {
    return this.publish({ phase: "error", installed: false, path: this.installRoot, detail });
  }

  ensure(herdr: string): Promise<HerdrPluginStatus> {
    if (this.pending) return this.pending;
    this.pending = this.prepare(herdr).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private publish(status: HerdrPluginStatus) {
    this.current = { ...status };
    return this.status();
  }

  private async sourceIdentity() {
    const manifest = await readFile(join(this.sourceRoot, "herdr-plugin.toml"), "utf8");
    const version = manifestVersion(manifest);
    if (version !== this.expectedVersion)
      throw new Error(`Herdr 插件版本 ${version} 与应用版本 ${this.expectedVersion} 不一致`);
    const hash = createHash("sha256").update(manifest);
    for (const file of PLUGIN_SOURCE_FILES.filter(file => file !== "herdr-plugin.toml"))
      hash.update(await readFile(join(this.sourceRoot, file)));
    return { version, digest: hash.digest("hex") };
  }

  private async deploy() {
    const identity = await this.sourceIdentity();
    let installedDigest: string | undefined;
    try {
      installedDigest = JSON.parse(await readFile(join(this.installRoot, ".crewvane-owned.json"), "utf8")).digest;
    } catch { /* install or upgrade */ }
    if (installedDigest === identity.digest) return { ...identity, changed: false };

    const temporary = `${this.installRoot}.download-${process.pid}`;
    const backup = `${this.installRoot}.previous-${process.pid}`;
    await rm(temporary, { recursive: true, force: true });
    await rm(backup, { recursive: true, force: true });
    await mkdir(dirname(this.installRoot), { recursive: true });
    await cp(this.sourceRoot, temporary, { recursive: true });
    await writeFile(join(temporary, ".crewvane-owned.json"), `${JSON.stringify({
      pluginId: CREWVANE_HERDR_PLUGIN_ID,
      version: identity.version,
      digest: identity.digest,
    }, null, 2)}\n`, { mode: 0o600 });

    let backedUp = false;
    try {
      await rename(this.installRoot, backup).then(() => { backedUp = true; }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await rename(temporary, this.installRoot);
      if (backedUp) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(this.installRoot, { recursive: true, force: true });
      if (backedUp) await rename(backup, this.installRoot).catch(() => {});
      throw error;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    return { ...identity, changed: true };
  }

  private async prepare(herdr: string): Promise<HerdrPluginStatus> {
    try {
      const identity = await this.deploy();
      if (this.current.phase !== "ready" || identity.changed)
        this.publish({ phase: "installing", installed: this.current.installed, detail: "正在准备 Herdr 注意力面板…" });
      const listed = pluginList((await this.runner(
        herdr, ["plugin", "list", "--plugin", CREWVANE_HERDR_PLUGIN_ID, "--json"], this.environment,
      )).stdout);
      if (!identity.changed && listed?.enabled === true && listed.version === identity.version &&
        typeof listed.plugin_root === "string" && resolve(listed.plugin_root) === resolve(this.installRoot)) {
        return this.publish({
          phase: "ready", installed: true, version: identity.version, path: this.installRoot,
          detail: "Herdr 动作与注意力面板已就绪",
        });
      }
      const linked = pluginList((await this.runner(
        herdr, ["plugin", "link", this.installRoot, "--enabled"], this.environment,
      )).stdout);
      if (!linked || linked.plugin_id !== CREWVANE_HERDR_PLUGIN_ID)
        throw new Error("Herdr 没有返回已注册的 Crewvane 插件");
      return this.publish({
        phase: "ready", installed: true, version: identity.version, path: this.installRoot,
        detail: "Herdr 动作与注意力面板已就绪",
      });
    } catch (error) {
      const detail = `Herdr 插件准备失败：${error instanceof Error ? error.message : String(error)}`;
      this.publish({ phase: "error", installed: false, path: this.installRoot, detail });
      return this.status();
    }
  }
}
