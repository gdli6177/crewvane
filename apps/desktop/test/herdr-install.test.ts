import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Executables } from "../electron/executables.ts";
import { HerdrInstallation } from "../electron/herdr-install.ts";

async function fixture(run: (f: { home: string; bin: string; path: string; tools: Executables }) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "crewvane-herdr-install-"));
  const bin = join(home, "managed"), path = join(bin, "herdr");
  await mkdir(bin);
  try { await run({ home, bin, path, tools: new Executables(home, bin, { PATH: "/usr/bin:/bin" }, true) }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
const binary = (v: string) => Buffer.from(`#!/bin/sh\nprintf 'herdr ${v}\\n'\n`);
function server(bytes = binary("0.9.5"), checksum?: string) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/releases/latest")) return Response.json({
      tag_name: "v0.9.5",
      assets: [{
        name: "herdr-macos-aarch64",
        url: "https://api.github.com/repos/herdrdev/herdr/releases/assets/123",
        browser_download_url: "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64",
        digest: `sha256:${checksum ?? createHash("sha256").update(bytes).digest("hex")}`,
      }],
    });
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  }) as typeof fetch;
  return { calls, fetcher };
}
test("Finder-style PATH finds a CLI in the user's login shell configuration", () => fixture(async ({ home, bin }) => {
  const custom = join(home, "custom");
  await mkdir(custom);
  await writeFile(join(custom, "herdr"), binary("0.9.5"), { mode: 0o700 });
  const shell = join(home, "shell");
  await writeFile(shell, `#!/bin/sh\nprintf '\\n__CREWVANE_PATH__${custom}\\n'\n`, { mode: 0o700 });
  const tools = new Executables(home, bin, { PATH: "/usr/bin:/bin", SHELL: shell });
  assert.equal(await tools.find("herdr"), join(custom, "herdr"));
  assert.equal(await tools.find("~/custom/herdr"), join(custom, "herdr"));
  assert.equal(await tools.find("./custom/herdr", home), join(custom, "herdr"));
}));
test("missing Herdr installs a verified latest binary without Homebrew and concurrent calls coalesce", () => fixture(async ({ tools, path }) => {
  const { calls, fetcher } = server(), events: string[] = [];
  const install = new HerdrInstallation(tools, path, s => events.push(s.phase), fetcher, "darwin", "arm64");
  const [a, b] = await Promise.all([install.ensure(), install.ensure()]);
  assert.equal(a.executable, path); assert.equal(a.version, "0.9.5");
  assert.deepEqual(a, b); assert.equal(calls.length, 2);
  assert.deepEqual(events, ["checking", "downloading", "ready"]);
  await install.ensure();
  assert.equal(calls.length, 2, "no second download/check during cached readiness");
}));
test("GitHub authentication is attached to release discovery and asset download", () => fixture(async ({ tools, path }) => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const binaryBytes = binary("0.9.5");
  const fetcher = (async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (input.endsWith("/releases/latest")) return Response.json({
      tag_name: "v0.9.5",
      assets: [{
        name: "herdr-macos-aarch64",
        url: "https://api.github.com/repos/herdrdev/herdr/releases/assets/123",
        browser_download_url: "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64",
        digest: `sha256:${createHash("sha256").update(binaryBytes).digest("hex")}`,
      }],
    });
    return new Response(binaryBytes);
  }) as typeof fetch;
  const result = await new HerdrInstallation(
    tools,
    path,
    () => {},
    fetcher,
    "darwin",
    "arm64",
    undefined,
    "test-token",
  ).ensure();
  assert.equal(result.version, "0.9.5");
  assert.deepEqual(calls.map(call => call.authorization), ["Bearer test-token", "Bearer test-token"]);
}));
test("an already installed latest or newer CLI is reused, invalid candidates are skipped", () => fixture(async ({ home, tools, path }) => {
  await writeFile(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  const external = join(home, ".local/bin/herdr");
  await writeFile(external, binary("0.10.0"), { mode: 0o700 });
  const { calls, fetcher } = server();
  const result = await new HerdrInstallation(tools, path, () => {}, fetcher, "darwin", "arm64").ensure();
  assert.equal(result.executable, external);
  assert.equal(calls.length, 1);
}));
test("the packaged private runtime wins over a newer shell Herdr", () => fixture(async ({ home, tools, path }) => {
  const bundled = join(home, "app/Contents/Resources/herdr");
  await mkdir(join(home, "app/Contents/Resources"), { recursive: true });
  await writeFile(bundled, binary("0.9.5"), { mode: 0o700 });
  await mkdir(join(home, ".local/bin"), { recursive: true });
  const external = join(home, ".local/bin/herdr");
  await writeFile(external, binary("0.10.0"), { mode: 0o700 });
  const { calls, fetcher } = server();
  const result = await new HerdrInstallation(
    tools,
    path,
    () => {},
    fetcher,
    "darwin",
    "arm64",
    bundled,
  ).ensure();
  assert.equal(result.executable, bundled);
  assert.equal(result.version, "0.9.5");
  assert.equal(calls.length, 1);
  assert.deepEqual(await readFile(external), binary("0.10.0"));
}));
test("an older CLI gets a private latest copy without changing the user's installation", () => fixture(async ({ home, tools, path }) => {
  await mkdir(join(home, ".local/bin"), { recursive: true });
  const external = join(home, ".local/bin/herdr");
  await writeFile(external, binary("0.8.0"), { mode: 0o700 });
  const result = await new HerdrInstallation(tools, path, () => {}, server().fetcher, "darwin", "arm64").ensure();
  assert.equal(result.version, "0.9.5"); assert.equal(result.executable, path);
  assert.deepEqual(await readFile(external), binary("0.8.0"));
}));
test("explicit update checks never download or replace an installed runtime", () => fixture(async ({ tools, path }) => {
  await writeFile(path, binary("0.8.0"), { mode: 0o700 });
  const { calls, fetcher } = server();
  const result = await new HerdrInstallation(tools, path, () => {}, fetcher, "darwin", "arm64").check();
  assert.equal(calls.length, 1);
  assert.equal(result.version, "0.8.0");
  assert.equal(result.latestVersion, "0.9.5");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.phase, "ready");
  assert.match(result.detail!, /可更新/);
  assert.deepEqual(await readFile(path), binary("0.8.0"));
}));
test("checksum failures leave the existing binary untouched and keep it usable", () => fixture(async ({ tools, path }) => {
  await writeFile(path, binary("0.8.0"), { mode: 0o700 });
  const install = new HerdrInstallation(tools, path, () => {}, server(binary("0.9.5"), "0".repeat(64)).fetcher, "darwin", "arm64");
  const result = await install.ensure();
  assert.equal(result.phase, "ready"); assert.equal(result.version, "0.8.0");
  assert.match(result.detail!, /校验失败.*继续使用本机 Herdr 0\.8\.0/);
  assert.deepEqual(await readFile(path), binary("0.8.0"));
}));
test("offline with no CLI fails visibly, offline with a local CLI remains usable", () => fixture(async ({ tools, path }) => {
  const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
  const install = new HerdrInstallation(tools, path, () => {}, offline, "darwin", "arm64");
  await assert.rejects(install.ensure(), /重试/);
  assert.equal((await install.status()).installed, false);
  await writeFile(path, binary("0.9.5"), { mode: 0o700 });
  const result = await install.ensure();
  assert.equal(result.phase, "ready"); assert.equal(result.installed, true);
  assert.match(result.detail!, /继续使用本机 Herdr 0\.9\.5/);
}));
test("a bundled Herdr remains usable when update metadata is unavailable", () => fixture(async ({ home, tools, path }) => {
  const bundled = join(home, "app/Contents/Resources/herdr");
  await mkdir(join(home, "app/Contents/Resources"), { recursive: true });
  await writeFile(bundled, binary("0.9.5"), { mode: 0o700 });
  const offline = (async () => { throw new Error("offline"); }) as typeof fetch;
  const install = new HerdrInstallation(tools, path, () => {}, offline,
    "darwin", "arm64", bundled);
  const result = await install.ensure();
  assert.equal(result.phase, "ready");
  assert.equal(result.executable, bundled);
  assert.match(result.detail!, /继续使用应用内置 Herdr 0\.9\.5/);
}));
test("an installed Herdr is ready before a slow update check completes", () => fixture(async ({ tools, path }) => {
  await writeFile(path, binary("0.9.5"), { mode: 0o700 });
  let rejectFetch!: (error: Error) => void;
  const stalled = new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
  const install = new HerdrInstallation(tools, path, () => {}, (() => stalled) as typeof fetch,
    "darwin", "arm64");
  const preparing = install.ensure();
  let current = await install.status();
  for (let attempt = 0; attempt < 100 && !current.installed; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10));
    current = await install.status();
  }
  assert.deepEqual(await install.status(), {
    installed: true,
    executable: path,
    version: "0.9.5",
    latestVersion: "0.9.5",
    phase: "ready",
    detail: "Herdr 0.9.5 已可用，正在检查更新…",
  });
  rejectFetch(new Error("offline"));
  const settled = await preparing;
  assert.equal(settled.phase, "ready");
  assert.match(settled.detail!, /继续使用本机 Herdr 0\.9\.5/);
}));
