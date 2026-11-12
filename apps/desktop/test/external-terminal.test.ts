import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExternalTerminalManager,
  type SceneSettings,
} from "../electron/external-terminal.js";

async function fixture(options: {
  installed?: Array<"iterm2" | "terminal" | "ghostty">;
  focus?: boolean;
  failFocus?: boolean;
  processAlive?: boolean;
  ttyProcessAlive?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "crewvane-scene-")),
    calls: Array<{ command: string; args: string[] }> = [],
    installed = new Set(options.installed ?? ["iterm2", "terminal", "ghostty"]);
  const manager = new ExternalTerminalManager({
    userDataRoot: root,
    platform: "darwin",
    env: {},
    now: () => new Date("2026-11-12T08:00:00.000Z"),
    pathExists: async path => {
      if (path.includes("iTerm")) return installed.has("iterm2");
      if (path.includes("Terminal")) return installed.has("terminal");
      if (path.includes("Ghostty")) return installed.has("ghostty");
      return false;
    },
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "/bin/kill")
        return options.processAlive === false
          ? Promise.reject(new Error("No such process"))
          : { stdout: "", stderr: "" };
      if (command === "/bin/ps")
        return {
          stdout: options.ttyProcessAlive === false ? "" : "123\n",
          stderr: "",
        };
      if (command === "/usr/bin/osascript" &&
        args.some(value => value.includes("tty of"))) {
        if (options.failFocus)
          throw Object.assign(new Error("Apple Events permission denied"), {
            stderr: "Not authorized to send Apple events",
          });
        return {
          stdout: options.focus === false ? "false\n" : "true\n",
          stderr: "",
        };
      }
      return { stdout: "true\n", stderr: "" };
    },
  });
  return { root, calls, manager };
}

test("scene settings default to an installed external terminal", async () => {
  const { root, manager } = await fixture();
  try {
    const status = await manager.status();
    assert.deepEqual(status.settings, {
      openWith: "external",
      terminal: "auto",
    });
    assert.equal(status.resolved, "terminal");
    assert.deepEqual(
      status.terminals.filter(item => item.installed).map(item => item.id),
      ["iterm2", "terminal", "ghostty"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scene settings persist explicitly and protect an unknown file", async () => {
  const { root, manager } = await fixture({ installed: ["terminal"] });
  try {
    const saved = await manager.save({
      openWith: "embedded",
      terminal: "terminal",
    });
    assert.deepEqual(saved.settings, {
      openWith: "embedded",
      terminal: "terminal",
    });
    const file = join(root, "scene-settings.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await writeFile(file, "{broken", { mode: 0o600 });
    const recovered = await manager.status();
    assert.deepEqual(recovered.settings, {
      openWith: "external",
      terminal: "auto",
    });
    await assert.rejects(
      manager.save({ openWith: "invalid", terminal: "terminal" } as unknown as SceneSettings),
      /设置无效/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening an external scene writes a private launcher and reuses its TTY", async () => {
  const { root, calls, manager } = await fixture();
  const workspace = "/tmp/workspace with 'quote' $(not-a-command)",
    session = "crewvane-test-1234",
    input = {
      workspaceRoot: workspace,
      session,
      herdrExecutable: "/Applications/Crewvane.app/Contents/Resources/herdr",
    };
  try {
    const opened = await manager.open(input);
    assert.equal(opened.terminal, "terminal");
    assert.equal(calls.at(-1)?.command, "/usr/bin/open");
    assert.deepEqual(calls.at(-1)?.args.slice(0, 2), ["-a", "Terminal"]);
    assert.match(calls.at(-1)?.args.at(-1) ?? "", /external-terminal\/launchers/);
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 16);
    const folder = join(root, "external-terminal");
    const launcher = join(folder, "launchers", `${hash(workspace)}-${hash(session)}.sh`);
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);
    const script = await readFile(launcher, "utf8");
    assert.match(script, /tty 2>\/dev\/null/);
    assert.match(script, /session attach/);
    assert.ok(script.includes("'\\''"));
    assert.equal(script.includes(`cd /tmp/workspace with 'quote' $(not-a-command)`), false);

    const leaseRoot = join(folder, "leases"),
      lease = join(leaseRoot, `${hash(workspace)}-${hash(session)}.json`),
      tty = join(leaseRoot, `${hash(workspace)}-${hash(session)}.tty`);
    assert.equal(JSON.parse(await readFile(lease, "utf8")).id, opened.id);
    await writeFile(tty, "/dev/ttys123\n", { mode: 0o600 });
    const callCount = calls.length;
    const reused = await manager.open(input);
    assert.equal(reused.id, opened.id);
    assert.equal(reused.tty, "/dev/ttys123");
    assert.ok(calls.slice(callCount).some(call =>
      call.command === "/bin/ps" &&
      call.args[0] === "-t"
    ));
    assert.match(calls.at(-1)?.args[1] ?? "", /tty of/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an alive external scene process activates its existing window before TTY matching", async () => {
  const { root, calls, manager } = await fixture({ focus: false });
  const workspace = "/tmp/workspace-process-reuse",
    session = "crewvane-process-reuse",
    hash = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 16);
  try {
    const folder = join(root, "external-terminal"),
      leaseRoot = join(folder, "leases"),
      id = `${hash(workspace)}-${hash(session)}`,
      { mkdir } = await import("node:fs/promises");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(leaseRoot, `${id}.json`), JSON.stringify({
      id: "existing-process",
      terminal: "terminal",
      session,
      workspaceHash: hash(workspace),
      openedAt: "2026-11-12T07:00:00.000Z",
    }), { mode: 0o600 });
    await writeFile(join(leaseRoot, `${id}.tty`), "/dev/ttys321\n", { mode: 0o600 });
    await writeFile(join(leaseRoot, `${id}.pid`), "4242\n", { mode: 0o600 });
    const reused = await manager.open({
      workspaceRoot: workspace,
      session,
      herdrExecutable: "/tmp/herdr",
    });
    assert.equal(reused.id, "existing-process");
    assert.equal(reused.processId, 4242);
    assert.deepEqual(calls.slice(0, 2), [
      { command: "/bin/kill", args: ["-0", "4242"] },
      { command: "/usr/bin/open", args: ["-a", "Terminal"] },
    ]);
    assert.equal(calls.some(call =>
      call.command === "/usr/bin/open" &&
      call.args.some(value => /external-terminal\/launchers/.test(value))
    ), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed external scene skips the slow AppleScript probe and opens cleanly", async () => {
  for (const modern of [true, false]) {
    const { root, calls, manager } = await fixture({
      focus: false,
      processAlive: false,
      ttyProcessAlive: false,
    });
    const workspace = `/tmp/closed-${modern ? "modern" : "legacy"}`,
      session = `crewvane-closed-${modern ? "modern" : "legacy"}`,
      hash = (value: string) =>
        createHash("sha256").update(value).digest("hex").slice(0, 16);
    try {
      const folder = join(root, "external-terminal"),
        leaseRoot = join(folder, "leases"),
        id = `${hash(workspace)}-${hash(session)}`,
        { mkdir } = await import("node:fs/promises");
      await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(leaseRoot, `${id}.json`), JSON.stringify({
        id: "closed-scene",
        terminal: "terminal",
        session,
        workspaceHash: hash(workspace),
        openedAt: "2026-11-12T07:00:00.000Z",
      }), { mode: 0o600 });
      await writeFile(join(leaseRoot, `${id}.tty`), "/dev/ttys999\n", { mode: 0o600 });
      if (modern)
        await writeFile(join(leaseRoot, `${id}.pid`), "4242\n", { mode: 0o600 });
      const opened = await manager.open({
        workspaceRoot: workspace,
        session,
        herdrExecutable: "/tmp/herdr",
      });
      assert.notEqual(opened.id, "closed-scene");
      assert.equal(calls.some(call =>
        call.command === "/usr/bin/osascript" &&
        call.args.some(value => value.includes("tty of"))
      ), false, "closed windows must not wait on AppleScript");
      assert.ok(calls.some(call =>
        call.command === "/usr/bin/open" &&
        call.args.some(value => /external-terminal\/launchers/.test(value))
      ));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a stale lease is replaced when the terminal window cannot be focused", async () => {
  const { root, calls, manager } = await fixture({ focus: false });
  const workspace = "/tmp/workspace", session = "crewvane-stale";
  try {
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 16);
    const folder = join(root, "external-terminal");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(folder, "leases"), { recursive: true, mode: 0o700 });
    await writeFile(join(folder, "leases", `${hash(workspace)}-${hash(session)}.json`), JSON.stringify({
      id: "stale",
      terminal: "iterm2",
      session,
      workspaceHash: hash(workspace),
      openedAt: "2026-11-12T07:00:00.000Z",
    }), { mode: 0o600 });
    await writeFile(join(folder, "leases", `${hash(workspace)}-${hash(session)}.tty`),
      "/dev/ttys999\n", { mode: 0o600 });
    const opened = await manager.open({
      workspaceRoot: workspace,
      session,
      herdrExecutable: "/tmp/herdr",
    });
    assert.notEqual(opened.id, "stale");
    assert.ok(calls.some(call =>
      call.command === "/usr/bin/open" &&
      call.args[0] === "-a" &&
      call.args[1] === "Terminal"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("iTerm2 uses its native automation path when explicitly selected", async () => {
  const { root, calls, manager } = await fixture();
  try {
    await manager.save({ openWith: "external", terminal: "iterm2" });
    const opened = await manager.open({
      workspaceRoot: "/tmp/iterm-workspace",
      session: "crewvane-iterm",
      herdrExecutable: "/tmp/herdr",
    });
    assert.equal(opened.terminal, "iterm2");
    assert.equal(calls.at(-1)?.command, "/usr/bin/osascript");
    assert.ok(calls.at(-1)?.args.some(value => value.includes("create window")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a denied focus automation activates the terminal without opening a duplicate", async () => {
  const { root, calls, manager } = await fixture({ failFocus: true });
  const workspace = "/tmp/workspace-focus", session = "crewvane-focus",
    hash = (value: string) =>
      createHash("sha256").update(value).digest("hex").slice(0, 16);
  try {
    const folder = join(root, "external-terminal"),
      leaseRoot = join(folder, "leases"),
      id = `${hash(workspace)}-${hash(session)}`;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(leaseRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(leaseRoot, `${id}.json`), JSON.stringify({
      id: "existing",
      terminal: "terminal",
      session,
      workspaceHash: hash(workspace),
      openedAt: "2026-11-12T07:00:00.000Z",
    }), { mode: 0o600 });
    await writeFile(join(leaseRoot, `${id}.tty`), "/dev/ttys321\n", { mode: 0o600 });
    const reused = await manager.open({
      workspaceRoot: workspace,
      session,
      herdrExecutable: "/tmp/herdr",
    });
    assert.equal(reused.id, "existing");
    assert.ok(calls.some(call =>
      call.command === "/usr/bin/open" &&
      call.args[0] === "-a" &&
      call.args[1] === "Terminal"));
    assert.equal(calls.some(call =>
      call.command === "/usr/bin/open" &&
      call.args.some(value => /external-terminal\/launchers/.test(value))), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Ghostty receives the launcher as one -e command even when its path contains spaces", async () => {
  const { root, calls, manager } = await fixture({ installed: ["ghostty"] });
  try {
    await manager.save({ openWith: "external", terminal: "ghostty" });
    await manager.open({
      workspaceRoot: "/tmp/ghostty-workspace",
      session: "crewvane-ghostty",
      herdrExecutable: "/tmp/herdr",
    });
    const opened = calls.find(call => call.command === "open");
    assert.ok(opened);
    assert.deepEqual(opened.args.slice(0, 3), ["-na", "Ghostty", "--args"]);
    assert.equal(opened.args[3], "-e");
    assert.match(opened.args[4] ?? "", /\/external-terminal\/launchers\//);
    assert.equal(opened.args.length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid external session names never reach a launcher or shell", async () => {
  const { root, manager } = await fixture();
  try {
    await assert.rejects(manager.open({
      workspaceRoot: "/tmp/workspace",
      session: "bad; touch /tmp/should-not-exist",
      herdrExecutable: "/tmp/herdr",
    }), /Session 名称无效/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing selected terminal produces an actionable fallback message", async () => {
  const { root, manager } = await fixture({ installed: ["terminal"] });
  try {
    await manager.save({ openWith: "external", terminal: "iterm2" });
    await assert.rejects(manager.open({
      workspaceRoot: "/tmp/workspace",
      session: "crewvane-missing",
      herdrExecutable: "/tmp/herdr",
    }), /改用内嵌轻现场/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
