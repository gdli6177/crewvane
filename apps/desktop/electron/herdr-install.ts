import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Executables } from "./executables.js";
const exec = promisify(execFile);
const MANIFEST =
  "https://api.github.com/repos/herdrdev/herdr/releases/latest";
export interface HerdrStatus {
  installed: boolean; executable?: string; version?: string; latestVersion?: string;
  phase: "checking" | "downloading" | "ready" | "error";
  detail?: string; updateAvailable?: boolean;
}
function version(text: string) {
  return /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(text.trim())?.[1];
}
function compare(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}
export class HerdrInstallation {
  private current: HerdrStatus = { installed: false, phase: "checking" };
  private pending?: Promise<HerdrStatus>;
  private manifest?: { at: number; value: { version: string; url: string; sha256: string } };
  constructor(readonly tools: Executables, readonly managedPath: string,
    readonly emit: (status: HerdrStatus) => void,
    readonly fetcher: typeof fetch = fetch,
    readonly platform = process.platform, readonly arch = process.arch,
    private bundledPath?: string, private readonly githubToken?: string) {}
  disableBundledForTest() {
    // Isolated UI tests must not silently reuse the packaged production Herdr.
    this.bundledPath = undefined;
  }
  private publish(status: HerdrStatus) { this.current = status; this.emit({ ...status }); return { ...status }; }
  private async installed() {
    // A file existing is not enough: wrong-architecture/stale executables must
    // not be advertised as usable. Continue looking after an invalid candidate.
    const privateCandidates = [...new Set([
      this.managedPath,
      ...(this.bundledPath ? [this.bundledPath] : []),
    ])];
    const systemCandidates = (await this.tools.paths()).map(dir => `${dir}/herdr`);
    const probe = async (executable: string) => {
      try {
        const text = (await exec(executable, ["--version"], { timeout: 10_000 })).stdout;
        const found = version(text);
        if (found && /^herdr\s/i.test(text.trim()))
          return { executable, version: found };
      } catch { /* try other installation locations */ }
    };
    let best: { executable: string; version: string } | undefined;
    // Crewvane owns a dedicated Herdr session. Prefer its private runtime over
    // a Homebrew/mise binary so the app and every child CLI address the same
    // server even when the user's shell has a different Herdr installation.
    for (const executable of privateCandidates) {
      const candidate = await probe(executable);
      if (candidate && (!best || compare(candidate.version, best.version) > 0))
        best = candidate;
    }
    if (!best) {
      for (const executable of systemCandidates) {
        const candidate = await probe(executable);
        if (candidate && (!best || compare(candidate.version, best.version) > 0))
          best = candidate;
      }
    }
    return best;
  }
  async status() {
    if (this.pending) return { ...this.current };
    const installed = await this.installed();
    if (this.pending) return { ...this.current };
    return this.current = { ...this.current, installed: !!installed, ...installed,
      ...(!installed ? { executable: undefined, version: undefined } : {}),
      phase: this.current.phase === "error" ? "error" : installed ? "ready" : "checking" };
  }
  ensure(force = false): Promise<HerdrStatus> {
    if (this.pending) return this.pending;
    this.pending = this.prepare(force).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  /**
   * Metadata-only update discovery for an explicit Settings action. Unlike
   * ensure(), checking never downloads or replaces a usable binary.
   */
  check(): Promise<HerdrStatus> {
    if (this.pending) return this.pending;
    this.pending = this.checkNow().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async checkNow() {
    const local = await this.installed();
    this.publish({
      installed: !!local,
      ...local,
      ...(local ? { latestVersion: local.version } : {}),
      updateAvailable: false,
      phase: "checking",
      detail: local ? `正在检查 Herdr ${local.version} 的更新…` : "正在检查 Herdr 最新版本…",
    });
    try {
      const latest = await this.latest(true);
      const updateAvailable = !!local && compare(local.version, latest.version) < 0;
      return this.publish({
        installed: !!local,
        ...local,
        latestVersion: latest.version,
        updateAvailable,
        phase: "ready",
        detail: local
          ? updateAvailable
            ? `发现 Herdr ${latest.version}，可更新；当前 ${local.version} 仍可使用。`
            : `Herdr ${local.version} 已是当前版本。`
          : `Herdr ${latest.version} 可安装。`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (local) return this.publish({
        installed: true,
        ...local,
        updateAvailable: false,
        phase: "ready",
        detail: `检查更新未完成：${reason}。继续使用${local.executable === this.bundledPath ? "应用内置" : "本机"} Herdr ${local.version}，可稍后重试。`,
      });
      this.publish({
        installed: false,
        updateAvailable: false,
        phase: "error",
        detail: `Herdr 版本检查未完成：${reason}。请检查网络后重试。`,
      });
      throw new Error(this.current.detail);
    }
  }
  private async latest(force: boolean) {
    if (!force && this.manifest && Date.now() - this.manifest.at < 6 * 3600_000) return this.manifest.value;
    // The official herdr.dev index contains the complete release history and
    // can be very slow on constrained networks. The GitHub latest-release API
    // carries the same current version and an immutable asset digest in a much
    // smaller payload.
    const response = await this.fetcher(MANIFEST, {
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Crewvane",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(this.githubToken ? { Authorization: `Bearer ${this.githubToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`版本检查失败（HTTP ${response.status}）`);
    const data = await response.json() as any;
    const target = `${this.platform === "darwin" ? "macos" : this.platform}-${this.arch === "arm64" ? "aarch64" : this.arch === "x64" ? "x86_64" : this.arch}`;
    const expectedVersion = typeof data.tag_name === "string"
      ? /^v?(\d+\.\d+\.\d+)$/.exec(data.tag_name)?.[1]
      : undefined;
    const asset = Array.isArray(data.assets)
      ? data.assets.find((item: any) =>
        item?.name === `herdr-${target}` &&
        typeof item?.url === "string" &&
        typeof item?.browser_download_url === "string")
      : undefined;
    const digest = typeof asset?.digest === "string"
      ? /^sha256:([a-f\d]{64})$/i.exec(asset.digest)?.[1]
      : undefined;
    if (!expectedVersion || !asset || !digest)
      throw new Error("官方版本清单缺少当前平台的有效下载与 SHA-256");
    const value = {
      version: expectedVersion,
      url: asset.url as string,
      browserUrl: asset.browser_download_url as string,
      sha256: digest.toLowerCase(),
    };
    this.manifest = { at: Date.now(), value };
    return value;
  }
  private async prepare(force: boolean) {
    const local = await this.installed();
    // A valid bundled or user-installed binary is immediately usable. Keep
    // update discovery attached to the same ensure() promise, but never make
    // Finder startup, a workspace, or an offline launch wait for the network.
    this.publish({
      installed: !!local,
      ...local,
      ...(local ? { latestVersion: local.version } : {}),
      phase: local ? "ready" : "checking",
      detail: local
        ? `Herdr ${local.version} 已可用，正在检查更新…`
        : "正在检查 Herdr 最新版本…",
    });
    let temporary: string | undefined;
    try {
      const latest = await this.latest(force);
      if (local && compare(local.version, latest.version) >= 0)
        return this.publish({ installed: true, ...local, latestVersion: latest.version, phase: "ready" });
      this.publish({ installed: !!local, ...local, latestVersion: latest.version, phase: "downloading",
        updateAvailable: !!local, detail: local ? `正在准备 Herdr ${latest.version}…` : "正在自动安装 Herdr，无需 Homebrew…" });
      const response = await this.fetcher(latest.url, {
        signal: AbortSignal.timeout(120_000),
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "Crewvane",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.githubToken ? { Authorization: `Bearer ${this.githubToken}` } : {}),
        },
      });
      if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
      const declaredSize = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredSize) && declaredSize > 100 * 1024 * 1024)
        throw new Error("Herdr 下载文件大小异常，未安装该文件");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 100 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== latest.sha256)
        throw new Error("Herdr 下载校验失败，未安装该文件");
      await mkdir(dirname(this.managedPath), { recursive: true });
      temporary = `${this.managedPath}.download`;
      await writeFile(temporary, bytes, { mode: 0o700 });
      await chmod(temporary, 0o700);
      const checked = version((await exec(temporary, ["--version"], { timeout: 10_000 })).stdout);
      if (checked !== latest.version) throw new Error("下载的 Herdr 无法运行或版本不匹配");
      await rename(temporary, this.managedPath);
      temporary = undefined;
      return this.publish({ installed: true, executable: this.managedPath,
        version: checked, latestVersion: latest.version, phase: "ready" });
    } catch (error) {
      const detail = `Herdr 自动准备未完成：${error instanceof Error ? error.message : String(error)}`;
      if (local) {
        const source = this.bundledPath && local.executable === this.bundledPath ? "应用内置" : "本机";
        return this.publish({ installed: true, ...local, phase: "ready",
          detail: `${detail}。继续使用${source} Herdr ${local.version}，可稍后重试更新。` });
      }
      this.publish({ installed: false, phase: "error",
        detail: `${detail}。请检查网络后点击重试。` });
      throw new Error(this.current.detail);
    } finally {
      if (temporary) await rm(temporary, { force: true });
    }
  }
}
