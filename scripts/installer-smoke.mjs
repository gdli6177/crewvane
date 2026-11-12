// Exercise both downloadable formats without requiring model credentials on CI.
import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { completeAutonomySetup } from "./lib/autonomy-setup.mjs";
import { verifyReconciliationPresentation } from "./lib/reconciliation-presentation.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const { version } = JSON.parse(await readFile(join(repo, "apps/desktop/package.json"), "utf8"));
const installers = join(repo, "apps/desktop/release/installers");
const stem = `Crewvane-${version}-macOS-arm64`;
// Keep the isolated HOME and Herdr socket paths below macOS's AF_UNIX
// sun_path limit. CI's TMPDIR is otherwise long enough to make Herdr's own
// plugin subcommand fail before the installed UI can be exercised.
const trial = await mkdtemp("/tmp/crewvane-install-test-");
await exec("shasum", ["-a", "256", "-c", "SHA256SUMS.txt"], { cwd: installers });
await exec("hdiutil", ["verify", join(installers, `${stem}.dmg`)]);
async function verifyDownloadedApp(appPath, label) {
  // Verify the icon in the delivered bundle, rather than only the source
  // artwork: an old ICNS can otherwise survive a successful application build.
  const { stdout: iconFile } = await exec("/usr/libexec/PlistBuddy", [
    "-c", "Print :CFBundleIconFile", join(appPath, "Contents/Info.plist"),
  ]);
  const iconName = iconFile.trim();
  assert.ok(iconName && !/[\\/]/.test(iconName), "Bundle icon must name a resource");
  const iconResource = iconName.endsWith(".icns") ? iconName : `${iconName}.icns`;
  assert.deepEqual(
    await readFile(join(appPath, "Contents/Resources", iconResource)),
    await readFile(join(repo, "apps/desktop/assets/brand/crewvane-icon.icns")),
    `${label}: shipped application must use the current Dock icon`,
  );
  await exec("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const bundledHerdr = join(appPath, "Contents/Resources/herdr");
  await access(bundledHerdr);
  const { stdout: herdrVersion } = await exec(bundledHerdr, ["--version"]);
  assert.match(herdrVersion, /^herdr \d+\.\d+\.\d+/,
    `${label}: downloaded app must include a runnable Herdr binary`);
  await exec("codesign", ["--verify", "--strict", "--verbose=2", bundledHerdr]);
  assert.match(
    await readFile(join(appPath, "Contents/Resources/herdr-plugin/herdr-plugin.toml"), "utf8"),
    /id = "dev\.crewvane"/,
    `${label}: downloaded app must contain the bundled Herdr plugin`,
  );
  // A browser-downloaded app carries the quarantine marker when extracted.
  // Gatekeeper evaluates nested code through the sealed bundle signature.
  await exec("xattr", ["-w", "com.apple.quarantine",
    "0081;00000000;Safari;", appPath]);
  await exec("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  // Gatekeeper's first-open approval is interactive. Remove only the test
  // marker after proving signature integrity so CI can launch the same bytes.
  await exec("xattr", ["-d", "com.apple.quarantine", appPath]);
  console.log(`${label}: complete code signature survives ZIP/DMG delivery and quarantine`);
}
async function launchInstalled(appPath, label) {
  await verifyDownloadedApp(appPath, label);
  assert.ok(
    (await readFile(join(appPath, "Contents/Resources/app.asar"))).includes(
      Buffer.from("CREWVANE_TEST_HOME"),
    ),
    "Installer predates isolated CLI testing; rebuild with pnpm desktop:dist before running",
  );
  assert.ok(
    (await stat(join(appPath, "Contents/Resources/app.asar"))).size < 50 * 1024 * 1024,
    "App archive must contain bundled code/assets, not source dependencies or previous releases",
  );
  const workspace = join(trial, `${label}-workspace`);
  const home = join(trial, `${label}-home`);
  await mkdir(workspace); await mkdir(join(home, ".local/bin"), { recursive: true });
  const app = await electron.launch({
    executablePath: join(appPath, "Contents/MacOS/Crewvane"),
    args: [],
    env: { ...process.env, CREWVANE_TEST_HOME: home,
      CREWVANE_TEST_USER_DATA: join(trial, `${label}-userData`),
      CREWVANE_TEST_WORKSPACE: workspace, CREWVANE_HERDR_SESSION: `crewvane-installer-${label}` },
    timeout: 60_000,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await completeAutonomySetup(page);
    await page.getByRole("heading", { name: "现在，可以安心了。" }).waitFor();
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), version);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    await page.waitForFunction(() => window.crewvane.cliStatus().then(status => status.installed), null, {
      timeout: 30_000,
    });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "重新安装", exact: true }).waitFor();
    const cli = join(home, ".local/bin/crewvane");
    assert.ok((await exec(cli, ["status", "--root", workspace, "--json"])).stdout.includes('"version": 3'));
    const created = JSON.parse((await exec(cli, ["goal", "create", "--title", "安装包 CLI 验收",
      "--project", "personal", "--root", workspace, "--json"])).stdout);
    await writeFile(join(trial, `${label}-cli.json`), JSON.stringify(created));
    await page.getByRole("button", { name: "全部目标", exact: true }).click();
    await page.getByText("安装包 CLI 验收", { exact: true }).waitFor();
    await verifyReconciliationPresentation(page, trial, label);
    await page.screenshot({ path: join(trial, `${label}-installed.png`) });
    assert.deepEqual(errors, []);
    console.log(`${label}: installed app starts, icon/signature verified, bundled CLI installs and writes a goal`);
  } finally {
    await app.close();
  }
}
let mounted = false;
const mount = join(trial, "volume");
try {
  await exec("ditto", ["-x", "-k", join(installers, `${stem}.zip`), join(trial, "zip")]);
  await launchInstalled(join(trial, "zip/Crewvane.app"), "zip");
  await mkdir(mount);
  await exec("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount,
    join(installers, `${stem}.dmg`)]);
  mounted = true;
  await access(join(mount, "Applications"));
  await exec("ditto", [join(mount, "Crewvane.app"), join(trial, "installed/Crewvane.app")]);
  await exec("hdiutil", ["detach", mount]);
  mounted = false;
  await launchInstalled(join(trial, "installed/Crewvane.app"), "dmg");
  console.log("Installer verification passed (DMG + ZIP + SHA-256)");
} finally {
  if (mounted) await exec("hdiutil", ["detach", mount]);
  await rm(trial, { recursive: true, force: true });
}
