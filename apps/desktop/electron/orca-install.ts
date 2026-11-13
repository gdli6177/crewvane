import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  detectOrcaApplication, verifyOrcaApplication, ORCA_RELEASE,
  type BackendDetection,
} from "../../../packages/sessions/src/index.js";

const exec = promisify(execFile);
export interface OrcaInstallationStatus {
  detection: BackendDetection;
  verifiedVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  phase: "idle" | "checking" | "downloading" | "verifying" | "awaiting_installation" | "error";
  receivedBytes?: number;
  totalBytes?: number;
  detail?: string;
}
export interface OrcaInstallDependencies {
  detect(appPath: string): Promise<BackendDetection>;
  release: { version: string; url: string; bytes: number; sha256: string };
  fetch: typeof fetch;
  /** Opens the verified read-only volume using the OS, never overwrites .app. */
  openInstaller(dmgPath: string): Promise<void>;
  platform: string;
  arch: string;
}
async function openVerifiedInstaller(dmgPath: string) {
  const { stdout } = await exec("/usr/bin/hdiutil",
    ["attach", "-readonly", "-nobrowse", "-plist", dmgPath],
    { timeout: 30_000, maxBuffer: 1_000_000 });
  // Convert the plist without parsing human-readable mount output.
  const { stdout: json } = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = execFile("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"],
      { timeout: 5_000, maxBuffer: 1_000_000 }, (error, output) => error ? reject(error) : resolve({ stdout: output }));
    child.stdin?.end(stdout);
  });
  const parsed: unknown = JSON.parse(json);
  const entities = parsed && typeof parsed === "object" && "system-entities" in parsed
    ? (parsed as Record<string, unknown>)["system-entities"] : undefined;
  const mounts = Array.isArray(entities)
    ? entities.flatMap((item: unknown) => item && typeof item === "object" &&
      "mount-point" in item && typeof item["mount-point"] === "string" ? [item["mount-point"]] : []) : [];
  const mount = mounts.find(path => path.startsWith("/Volumes/"));
  if (!mount) throw new Error("无法读取 Orca 安装卷。");
  try {
    const checked = await verifyOrcaApplication(join(mount, "Orca.app"));
    if (checked.version !== ORCA_RELEASE.version) throw new Error("安装卷中的 Orca 版本与已验证版本不同。");
    await exec("/usr/bin/open", [mount], { timeout: 5_000 });
  } catch (error) {
    await exec("/usr/bin/hdiutil", ["detach", mount], { timeout: 10_000 }).catch(() => {});
    throw error;
  }
}
const defaults: OrcaInstallDependencies = {
  detect: detectOrcaApplication, release: ORCA_RELEASE, fetch,
  openInstaller: openVerifiedInstaller, platform: process.platform, arch: process.arch,
};
function compare(a: string, b: string) {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  return (x[0]! - y[0]!) || (x[1]! - y[1]!) || (x[2]! - y[2]!);
}
/**
 * Installation and backend selection are deliberately separate transactions.
 * The downloaded image is pinned, hashed, signed and opened in Finder.
 * User applications, profiles and running terminals are never overwritten.
 */
export class OrcaInstallation {
  private current: OrcaInstallationStatus;
  private pending?: Promise<OrcaInstallationStatus>;
  private abort?: AbortController;
  private application = "/Applications/Orca.app";
  private detected = false;
  private detecting?: Promise<OrcaInstallationStatus>;
  private readonly dependencies: OrcaInstallDependencies;
  constructor(
    readonly directory: string,
    private readonly emit: (status: OrcaInstallationStatus) => void,
    dependencies: Partial<OrcaInstallDependencies> = {},
  ) {
    this.dependencies = { ...defaults, ...dependencies };
    this.current = {
      detection: { id: "orca", status: "missing", capabilities: {
        create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false,
      } },
      verifiedVersion: this.dependencies.release.version, updateAvailable: false, phase: "idle",
    };
  }
  private publish(change: Partial<OrcaInstallationStatus>) {
    this.current = { ...this.current, ...change };
    const value = structuredClone(this.current);
    this.emit(value);
    return value;
  }
  async status() {
    if (this.pending || this.detected) return structuredClone(this.current);
    return this.refresh();
  }
  refresh(appPath = this.application) {
    if (this.pending) return Promise.resolve(structuredClone(this.current));
    return this.detecting ??= this.detectNow(appPath).finally(() => { this.detecting = undefined; });
  }
  private async detectNow(appPath = this.application) {
    const detection = await this.dependencies.detect(appPath);
    this.application = appPath;
    this.detected = true;
    const updateAvailable = !!detection.version && compare(detection.version, this.dependencies.release.version) < 0;
    const waiting = this.current.phase === "awaiting_installation" && detection.status !== "compatible";
    return this.publish({
      detection, updateAvailable,
      phase: waiting ? "awaiting_installation" : "idle",
      detail: waiting ? "安装卷已打开，尚未检测到兼容版本。请完成安装后再点击“重新检测”。"
        : detection.status === "compatible" ? "已通过本版兼容检测。" : detection.detail,
    });
  }
  check() {
    if (this.pending) return this.pending;
    return this.pending = this.checkNow().finally(() => { this.pending = undefined; });
  }
  private async checkNow() {
    await this.detectNow();
    this.publish({ phase: "checking", detail: "正在检查 Orca 官方发布…" });
    try {
      const response = await this.dependencies.fetch("https://api.github.com/repos/stablyai/orca/releases/latest", {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Crewvane" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value: unknown = await response.json();
      const tag = value && typeof value === "object" && "tag_name" in value ? value.tag_name : undefined;
      const latestVersion = typeof tag === "string" ? /^v?(\d+\.\d+\.\d+)$/.exec(tag)?.[1] : undefined;
      if (!latestVersion) throw new Error("官方版本清单无效");
      return this.publish({
        phase: "idle", latestVersion,
        detail: compare(latestVersion, this.dependencies.release.version) > 0
          ? `官方已发布 ${latestVersion}，尚未经本版验证；更新入口仍提供已验证的 ${this.dependencies.release.version}。`
          : this.current.updateAvailable
            ? `可更新到已验证的 Orca ${this.dependencies.release.version}。`
            : this.current.detection.status === "compatible"
              ? `已安装本版验证的 Orca ${this.dependencies.release.version}。`
              : `可安装已验证的 Orca ${this.dependencies.release.version}。${this.current.detection.detail ?? ""}`,
      });
    } catch (error) {
      return this.publish({ phase: "error",
        detail: `检查更新未完成：${error instanceof Error ? error.message : String(error)}。现有后端与目标保持不变，可重试或下载已验证安装包。` });
    }
  }
  cancel() {
    this.abort?.abort();
    if (!this.pending && this.current.phase === "awaiting_installation")
      this.publish({ phase: "idle", detail: "已取消更新，可继续使用当前后端。" });
  }
  install() {
    if (this.pending) return this.pending;
    return this.pending = this.installNow().finally(() => {
      this.pending = undefined;
      this.abort = undefined;
    });
  }
  private async privateDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
      process.getuid && info.uid !== process.getuid()) throw new Error("安装缓存目录不安全。");
    await chmod(this.directory, 0o700);
  }
  private async installNow() {
    if (this.dependencies.platform !== "darwin" || this.dependencies.arch !== "arm64")
      return this.publish({ phase: "error", detail: "本版只验证了 macOS Apple Silicon 安装包。" });
    await this.detectNow();
    // Never turn an "update" into a silent downgrade.
    if (this.current.detection.version && compare(this.current.detection.version, this.dependencies.release.version) > 0)
      return this.publish({ phase: "error", detail: "已安装更新的 Orca，不自动降级。请选择本版支持的独立应用或等待兼容更新。" });
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(300_000)]);
    let temporary: string | undefined;
    try {
      await this.privateDirectory();
      temporary = join(this.directory, `${randomUUID()}.download`);
      const final = join(this.directory, `Orca-${this.dependencies.release.version}-arm64.dmg`);
      this.publish({ phase: "downloading", receivedBytes: 0, totalBytes: this.dependencies.release.bytes,
        detail: `正在下载官方 Orca ${this.dependencies.release.version}…` });
      const response = await this.dependencies.fetch(this.dependencies.release.url, {
        headers: { "User-Agent": "Crewvane" }, signal,
      });
      if (!response.ok || !response.body) throw new Error(`下载安装包失败（HTTP ${response.status}）`);
      const declared = response.headers.get("content-length");
      if (declared && Number(declared) !== this.dependencies.release.bytes) throw new Error("官方安装包大小与固定清单不匹配。");
      const hash = createHash("sha256");
      let received = 0, lastEmit = 0;
      const guard = new Transform({
        transform: (chunk: Buffer, _encoding, done) => {
          received += chunk.length;
          if (received > this.dependencies.release.bytes) return done(new Error("安装包超出已验证大小。"));
          hash.update(chunk);
          if (Date.now() - lastEmit > 200) {
            lastEmit = Date.now();
            this.publish({ receivedBytes: received });
          }
          done(null, chunk);
        },
      });
      const body = response.body;
      async function* chunks() {
        const reader = body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally { reader.releaseLock(); }
      }
      await pipeline(chunks(), guard, createWriteStream(temporary, { mode: 0o600, flags: "wx" }), { signal });
      this.publish({ phase: "verifying", receivedBytes: received, detail: "正在核验安装包 SHA-256 与应用签名…" });
      if (received !== this.dependencies.release.bytes || hash.digest("hex") !== this.dependencies.release.sha256)
        throw new Error("Orca SHA-256 校验失败，未打开安装包。");
      // Existing files are trusted only after reading and hashing their bytes.
      await rename(temporary, final);
      temporary = undefined;
      await this.dependencies.openInstaller(final);
      return this.publish({ phase: "awaiting_installation",
        detail: "已打开验证过的安装卷。请按 macOS 提示安装或更新 Orca，再点击“重新检测”。此操作不会切换后端或关闭现有现场。" });
    } catch (error) {
      const cancelled = this.abort.signal.aborted;
      return this.publish({ phase: cancelled ? "idle" : "error",
        detail: cancelled ? "已取消下载，现有后端与目标保持不变。" :
          `Orca 安装未完成：${error instanceof Error ? error.message : String(error)}。可重试或从官方发布页手动安装。` });
    } finally {
      if (temporary) await rm(temporary, { force: true });
    }
  }
}
