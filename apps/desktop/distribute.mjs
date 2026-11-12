import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const exec = promisify(execFile);
const metadata = JSON.parse(await readFile(join(here, "package.json"), "utf8"));
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Installers currently require macOS arm64");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version))
  throw new Error("Invalid desktop release version");
const rootPackage = JSON.parse(await readFile(join(here, "../../package.json"), "utf8"));
if (rootPackage.version !== metadata.version)
  throw new Error("Root and desktop versions must match");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${metadata.version}`)
  throw new Error("Release tag must match the packaged version");

const output = join(here, "release", "installers");
const app = join(here, "release", "Crewvane-darwin-arm64", "Crewvane.app");
const stem = `Crewvane-${metadata.version}-macOS-arm64`;
const stage = await mkdtemp(join(tmpdir(), "crewvane-installer-"));
const dmg = join(output, `${stem}.dmg`);

async function createDmg() {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await rm(dmg, { force: true });
    try {
      await exec("hdiutil", ["create", "-volname", "Crewvane", "-srcfolder", stage,
        "-format", "UDZO", "-ov", dmg], { timeout: 180_000 });
      return;
    } catch (error) {
      const stderr = typeof error === "object" && error && "stderr" in error
        ? String(error.stderr)
        : "";
      if (attempt === 4 || !/Resource busy/i.test(stderr)) throw error;
      console.warn(`hdiutil reported a transient busy resource; retrying (${attempt + 1}/4)`);
      await delay(attempt * 1_000);
    }
  }
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
try {
  await cp(app, join(stage, "Crewvane.app"), { recursive: true, verbatimSymlinks: true });
  await symlink("/Applications", join(stage, "Applications"));
  await writeFile(join(stage, "安装说明.txt"),
    "Crewvane｜协航\n\n将 Crewvane.app 拖入 Applications 后，从应用程序打开。\n" +
    "适用于 Apple Silicon Mac。本内测版采用完整 ad-hoc 签名，但尚未使用 Apple Developer ID 签名与公证。\n" +
    "若提示“无法验证开发者”，请在 macOS 系统设置 > 隐私与安全性中选择“仍要打开”。\n" +
    "若提示“已损坏”，请核对 SHA-256 并从 GitHub Releases 重新下载当前版本，不要继续使用 v0.3.0。\n" +
    "使用说明：https://github.com/gdli6177/crewvane/blob/main/docs/crewvane.md\n");
  await createDmg();
  await exec("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app,
    join(output, `${stem}.zip`)], { timeout: 180_000 });
  const files = [`${stem}.dmg`, `${stem}.zip`];
  const sums = [];
  for (const name of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(output, name))) hash.update(chunk);
    sums.push(`${hash.digest("hex")}  ${name}`);
  }
  await writeFile(join(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
  console.log(JSON.stringify({ output, files: [...files, "SHA256SUMS.txt"] }));
} finally {
  await rm(stage, { recursive: true, force: true });
}
