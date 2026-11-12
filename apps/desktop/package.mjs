import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { packager } from "@electron/packager";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareHerdr } from "./scripts/prepare-herdr.mjs";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url)),
  electronVersion = createRequire(import.meta.url)("electron/package.json")
    .version,
  desktopPackage = JSON.parse(
    await readFile(join(here, "package.json"), "utf8"),
  ),
  signingIdentity = process.env.CREWVANE_MACOS_SIGN_IDENTITY,
  electronZipDir = process.env.CREWVANE_ELECTRON_ZIP_DIR
    ? resolve(process.env.CREWVANE_ELECTRON_ZIP_DIR)
    : undefined,
  stage = await mkdtemp(join(tmpdir(), "crewvane-package-"));

try {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Desktop packaging currently requires macOS arm64");
  if (signingIdentity) {
    const identities = await execFile("security", ["find-identity", "-v", "-p", "codesigning"]);
    if (!identities.stdout.includes(signingIdentity) && !identities.stdout.includes(`"${signingIdentity}"`))
      throw new Error(`Configured Developer ID is not available: ${signingIdentity}`);
  }
  // Electron/main, preload, CLI and renderer are bundled by build.mjs.
  // Deploying the source package also copies its previous release directory,
  // recursively shipping old applications/installers with every new build.
  await import("./scripts/build-icons.mjs");
  await cp(join(here, "dist"), join(stage, "dist"), { recursive: true });
  const nativePackage = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  await cp(nativePackage, join(stage, "node_modules/node-pty"), {
    recursive: true,
    filter: (path) => !/\/(?:src|deps|test|fixtures|obj\.target)(?:\/|$)/.test(path),
  });
  const addonPackage = dirname(createRequire(join(nativePackage, "package.json")).resolve("node-addon-api/package.json"));
  await cp(addonPackage, join(stage, "node_modules/node-addon-api"), { recursive: true });
  await cp(join(here, "assets/brand/crewvane-icon.png"), join(stage, "dist/assets/crewvane-icon.png"));
  const bundledSkills = join(stage, "crewvane-skills");
  await mkdir(bundledSkills, { recursive: true });
  await cp(join(here, "../../skills/crewvane"), join(bundledSkills, "crewvane"), { recursive: true });
  await cp(
    join(here, "../../skills/crewvane-local-pack-author"),
    join(bundledSkills, "crewvane-local-pack-author"),
    { recursive: true },
  );
  const cliNode = join(stage, "cli-node");
  await cp(process.execPath, cliNode);
  const herdrBinary = await prepareHerdr();
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({
      name: "crewvane",
      version: desktopPackage.version,
      description: desktopPackage.description,
      productName: "Crewvane",
      main: "dist/main.cjs",
      dependencies: { "node-pty": createRequire(import.meta.url)("node-pty/package.json").version },
      private: false,
    }),
  );
  const paths = await packager({
    dir: stage,
    out: join(here, "release"),
    name: "Crewvane",
    electronVersion,
    appBundleId: "dev.crewvane.desktop",
    platform: "darwin",
    arch: "arm64",
    icon: join(here, "assets/brand/crewvane-icon.icns"),
    asar: { unpack: "{**/dist/cli/**,**/node_modules/node-pty/**}" },
    extraResource: [cliNode, join(here, "herdr-plugin"), bundledSkills, herdrBinary],
    ignore: [/^\/cli-node$/, /^\/dist\/.*\.map$/],
    overwrite: true,
    prune: true,
    appCategoryType: "public.app-category.developer-tools",
    extendInfo: {
      NSAppleEventsUsageDescription:
        "Crewvane uses the selected terminal to open and focus your current Herdr work scene.",
    },
    ...(electronZipDir ? { electronZipDir } : {}),
    // Electron patches its binaries while packaging. Re-sign every nested
    // executable and seal the app afterwards so Gatekeeper does not report the
    // downloaded app as damaged. An explicitly configured Developer ID enables
    // hardened runtime; ad-hoc builds must not mix it with Electron's bundled
    // frameworks or macOS refuses to load them in the signed helpers.
    osxSign: {
      identity: signingIdentity || "-",
      identityValidation: Boolean(signingIdentity),
      timestamp: signingIdentity ? undefined : "none",
      strictVerify: true,
      optionsForFile: () => ({
        hardenedRuntime: Boolean(signingIdentity),
        ...(signingIdentity ? {} : { entitlements: [] }),
      }),
    },
  });
  console.log(paths.join("\n"));
} finally {
  await rm(stage, { recursive: true, force: true });
}
