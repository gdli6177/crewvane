import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentHookManager } from "../electron/agent-hook-manager.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function fixture(commands: string[]) {
  const root = await mkdtemp(join(tmpdir(), "crewvane-agent-hooks-"));
  roots.push(root);
  const home = join(root, "home"), userData = join(root, "userData");
  const cli = join(home, ".local", "bin", "crewvane");
  await mkdir(dirname(cli), { recursive: true });
  await writeFile(cli, "#!/bin/sh\n", { mode: 0o700 });
  const manager = new AgentHookManager({
    home,
    userData,
    commandPath: async command =>
      commands.includes(command) ? join(root, "bin", command) : undefined,
    version: async path => {
      const name = path.split("/").at(-1);
      return {
        codex: "codex-cli 0.167.0",
        claude: "2.1.7",
        "cursor-agent": "1.4.0",
        qodercli: "1.0.2",
        omp: "omp/18.15.0",
      }[name ?? ""] ?? "1.0.0";
    },
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  return { root, home, userData, CLI: cli, manager };
}

async function json(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

function handlers(config: any, event: string) {
  return (config.hooks?.[event] ?? []).flatMap((group: any) =>
    Array.isArray(group.hooks) ? group.hooks : [group]);
}

test("all supported detected Agents install once, preserve user hooks, and expose real status", async () => {
  const { home, CLI, manager } = await fixture([
    "codex",
    "claude",
    "cursor-agent",
    "qodercli",
    "omp",
  ]);
  const codexPath = join(home, ".codex", "hooks.json"),
    claudePath = join(home, ".claude", "settings.json"),
    cursorPath = join(home, ".cursor", "hooks.json"),
    qoderPath = join(home, ".qoder", "settings.json");
  await mkdir(dirname(codexPath), { recursive: true });
  await writeFile(codexPath, JSON.stringify({
    custom: true,
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: "user-codex" }],
      }],
    },
  }));
  await mkdir(dirname(claudePath), { recursive: true });
  await writeFile(claudePath, JSON.stringify({
    theme: "dark",
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-claude" }] }],
    },
  }));
  await mkdir(dirname(cursorPath), { recursive: true });
  await writeFile(cursorPath, JSON.stringify({
    version: 1,
    other: "kept",
    hooks: { stop: [{ command: "user-cursor", timeout: 5 }] },
  }));
  await mkdir(dirname(qoderPath), { recursive: true });
  await writeFile(qoderPath, JSON.stringify({
    hooks: {
      SessionEnd: [{ hooks: [{ type: "command", command: "user-qoder" }] }],
    },
  }));

  const statuses = await manager.autoInstallDetected();
  assert.deepEqual(
    statuses.filter(status => status.command).map(status => status.id),
    ["codex", "claude-code", "cursor", "qoder", "omp"],
  );
  assert.equal(
    statuses.find(status => status.id === "codex")?.status,
    "waiting-trust",
    JSON.stringify(statuses),
  );
  for (const id of ["claude-code", "cursor", "qoder", "omp"] as const)
    assert.equal(statuses.find(status => status.id === id)?.status, "installed");

  const codex = await json(codexPath),
    claude = await json(claudePath),
    cursor = await json(cursorPath),
    qoder = await json(qoderPath);
  assert.equal(codex.custom, true);
  assert.equal(claude.theme, "dark");
  assert.equal(cursor.other, "kept");
  assert.ok(handlers(codex, "SessionStart").some((handler: any) => handler.command === "user-codex"));
  assert.ok(handlers(claude, "Stop").some((handler: any) => handler.command === "user-claude"));
  assert.ok(handlers(cursor, "stop").some((handler: any) => handler.command === "user-cursor"));
  assert.ok(handlers(qoder, "SessionEnd").some((handler: any) => handler.command === "user-qoder"));
  for (const [config, event] of [
    [codex, "UserPromptSubmit"],
    [claude, "UserPromptSubmit"],
    [cursor, "beforeSubmitPrompt"],
    [qoder, "UserPromptSubmit"],
  ] as const) {
    assert.equal(
      handlers(config, event).filter((handler: any) =>
        String(handler.command).includes("hook ingest --adapter")).length,
      1,
    );
  }
  const ompPath = join(home, ".omp", "agent", "extensions", "crewvane.js");
  const omp = await readFile(ompPath, "utf8");
  assert.match(omp, /Crewvane managed OMP extension/);
  assert.match(omp, /pi\.on\("turn_start"/);
  assert.doesNotMatch(omp, /tool_execution_start/);
  assert.equal((await stat(ompPath)).mode & 0o777, 0o600);

  await manager.autoInstallDetected();
  assert.equal(
    handlers(await json(codexPath), "UserPromptSubmit").filter((handler: any) =>
      String(handler.command).includes("hook ingest --adapter")).length,
    1,
  );

  await manager.markObserved("codex", "2030-01-01T00:01:00.000Z");
  assert.equal(
    (await manager.status()).find(status => status.id === "codex")?.status,
    "installed",
  );
  await manager.autoInstallDetected();
  assert.equal(
    (await manager.status()).find(status => status.id === "codex")?.status,
    "installed",
    "a routine re-check must not forget that Codex trusted the managed Hook",
  );
  assert.equal(CLI.endsWith("crewvane"), true);
});

test("every JSON adapter preserves pre-existing hooks and uninstall restores them exactly", async () => {
  const { home, manager } = await fixture([
    "codex",
    "claude",
    "cursor-agent",
    "qodercli",
    "omp",
  ]);
  const codexPath = join(home, ".codex", "hooks.json");
  const claudePath = join(home, ".claude", "settings.json");
  const cursorPath = join(home, ".cursor", "hooks.json");
  const qoderPath = join(home, ".qoder", "settings.json");
  const grouped = {
    SessionStart: [{ hooks: [{ type: "command", command: "openviking-session-start" }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "openviking-prompt" }] }],
    Stop: [{ hooks: [{ type: "command", command: "openviking-stop" }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "openviking-session-end" }] }],
  };
  const originals: Record<string, any> = {
    codex: { custom: "codex", hooks: { ...grouped,
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "openviking-pre-tool" }],
      }],
    } },
    claude: { theme: "dark", hooks: { ...grouped,
      Notification: [{ matcher: "", hooks: [{ type: "command", command: "openviking-notification" }] }],
      PreToolUse: [{
        matcher: "Edit",
        hooks: [{ type: "command", command: "openviking-pre-tool" }],
      }],
    } },
    cursor: {
      version: 1,
      userSetting: "cursor",
      hooks: {
        sessionStart: [{ command: "openviking-1", timeout: 5 }],
        beforeSubmitPrompt: [{ command: "openviking-2", timeout: 5 }],
        afterAgentResponse: [{ command: "openviking-3", timeout: 5 }],
        stop: [{ command: "openviking-4", timeout: 5 }],
        sessionEnd: [{ command: "openviking-5", timeout: 5 }],
        beforeShellExecution: [{ command: "openviking-6", timeout: 5 }],
        afterFileEdit: [{ command: "openviking-7", timeout: 5 }],
      },
    },
    qoder: { approvalMode: "ask", hooks: { ...grouped,
      PermissionRequest: [{ hooks: [{ type: "command", command: "openviking-permission" }] }],
    } },
  };
  for (const [id, path] of [
    ["codex", codexPath],
    ["claude", claudePath],
    ["cursor", cursorPath],
    ["qoder", qoderPath],
  ] as const) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(originals[id]));
  }
  const ompDirectory = join(home, ".omp", "agent", "extensions");
  await mkdir(ompDirectory, { recursive: true });
  await writeFile(join(ompDirectory, "user-extension.js"), "// unrelated OMP extension\n");

  await manager.autoInstallDetected();
  const installedCodex = await json(codexPath),
    installedClaude = await json(claudePath),
    installedCursor = await json(cursorPath),
    installedQoder = await json(qoderPath);
  assert.equal(installedCodex.custom, "codex");
  assert.equal(installedClaude.theme, "dark");
  assert.equal(installedCursor.userSetting, "cursor");
  assert.equal(installedQoder.approvalMode, "ask");
  for (const [config, event, command] of [
    [installedCodex, "SessionStart", "openviking-session-start"],
    [installedCodex, "PreToolUse", "openviking-pre-tool"],
    [installedClaude, "Stop", "openviking-stop"],
    [installedClaude, "Notification", "openviking-notification"],
    [installedClaude, "PreToolUse", "openviking-pre-tool"],
    [installedQoder, "SessionEnd", "openviking-session-end"],
    [installedQoder, "PermissionRequest", "openviking-permission"],
  ] as const) {
    assert.equal(
      handlers(config, event).filter((handler: any) =>
        handler.command === command).length,
      1,
      `${event} must retain ${command}`,
    );
  }
  assert.ok(handlers(installedCursor, "beforeShellExecution")
    .some((handler: any) => handler.command === "openviking-6"));
  assert.ok(handlers(installedCursor, "afterFileEdit")
    .some((handler: any) => handler.command === "openviking-7"));
  assert.equal(handlers(installedCodex, "PreToolUse").length, 1);
  assert.equal(handlers(installedClaude, "PreToolUse").length, 1);
  assert.equal(await readFile(join(ompDirectory, "user-extension.js"), "utf8"),
    "// unrelated OMP extension\n");

  for (const id of ["codex", "claude-code", "cursor", "qoder", "omp"] as const)
    await manager.uninstall(id);

  assert.deepEqual(await json(codexPath), originals.codex);
  assert.deepEqual(await json(claudePath), originals.claude);
  assert.deepEqual(await json(cursorPath), originals.cursor);
  assert.deepEqual(await json(qoderPath), originals.qoder);
  assert.equal(await readFile(join(ompDirectory, "user-extension.js"), "utf8"),
    "// unrelated OMP extension\n");
  assert.equal(await stat(join(ompDirectory, "crewvane.js")).then(() => true).catch(() => false),
    false);
});

test("disable and uninstall remove only Crewvane entries and stay suppressed across auto-install", async () => {
  const { home, manager } = await fixture(["cursor-agent"]);
  const path = join(home, ".cursor", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: "user-command" }] },
  }));
  await manager.install("cursor");
  const disabled = await manager.disable("cursor");
  assert.equal(disabled.status, "disabled");
  const config = await json(path);
  assert.deepEqual(
    handlers(config, "stop").filter((handler: any) =>
      String(handler.command).includes("hook ingest --adapter")),
    [],
  );
  assert.equal(
    handlers(config, "stop").some((handler: any) =>
      handler.command === "user-command"),
    true,
  );

  await manager.install("cursor");
  const uninstalled = await manager.uninstall("cursor");
  assert.equal(uninstalled.status, "disabled");
  await manager.autoInstallDetected();
  assert.equal(
    (await manager.status()).find(status => status.id === "cursor")?.status,
    "disabled",
  );
});

test("grouped adapters preserve empty user groups and commands that merely mention the protocol", async () => {
  for (const [command, id, directory, filename] of [
    ["codex", "codex", ".codex", "hooks.json"],
    ["claude", "claude-code", ".claude", "settings.json"],
    ["qodercli", "qoder", ".qoder", "settings.json"],
  ] as const) {
    const { home, manager } = await fixture([command]);
    const path = join(home, directory, filename);
    const original = {
      custom: { enabled: true },
      hooks: {
        Stop: [
          { matcher: "user-empty", hooks: [] },
          { hooks: [{
            type: "command",
            command: `echo 'hook ingest --adapter ${id}'`,
          }] },
        ],
      },
    };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(original));
    await manager.install(id);
    assert.deepEqual((await json(path)).hooks.Stop.slice(0, 2), original.hooks.Stop);
    await manager.install(id);
    await manager.disable(id);
    assert.deepEqual(await json(path), original);
    await manager.uninstall(id);
    assert.deepEqual(await json(path), original);
  }
});

test("uninstall without managed entries is a byte-for-byte no-op for every JSON adapter", async () => {
  for (const [command, id, directory, filename] of [
    ["codex", "codex", ".codex", "hooks.json"],
    ["claude", "claude-code", ".claude", "settings.json"],
    ["cursor-agent", "cursor", ".cursor", "hooks.json"],
    ["qodercli", "qoder", ".qoder", "settings.json"],
  ] as const) {
    const { home, manager } = await fixture([command]);
    const path = join(home, directory, filename);
    const body = '{ "hooks": { "Stop": [] }, "custom": "untouched" }\n';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    await manager.uninstall(id);
    assert.equal(await readFile(path, "utf8"), body);
  }
});

test("upgrades keep hooks added after first install and mixed-group metadata for every JSON adapter", async () => {
  for (const [command, id, directory, filename, event] of [
    ["codex", "codex", ".codex", "hooks.json", "Stop"],
    ["claude", "claude-code", ".claude", "settings.json", "Stop"],
    ["cursor-agent", "cursor", ".cursor", "hooks.json", "stop"],
    ["qodercli", "qoder", ".qoder", "settings.json", "Stop"],
  ] as const) {
    const { home, manager } = await fixture([command]);
    const path = join(home, directory, filename);
    await manager.install(id);
    const config = await json(path);
    const user = { command: `echo hook ingest --adapter ${id}`, timeout: 7 };
    config.hooks[event] = id === "cursor"
      ? [...config.hooks[event], user]
      : [{ matcher: "user-matcher", hooks: [user, ...handlers(config, event)] }];
    config.latestUserSetting = true;
    await writeFile(path, JSON.stringify(config));
    await manager.install(id);
    assert.ok(handlers(await json(path), event).some((entry: any) => entry.command === user.command));
    await manager.uninstall(id);
    const remaining = await json(path);
    assert.equal(remaining.latestUserSetting, true);
    assert.deepEqual(remaining.hooks[event], id === "cursor"
      ? [user] : [{ matcher: "user-matcher", hooks: [user] }]);
  }
});

test("separate manager instances serialize changes to the same Agent config", async () => {
  const { home, manager, root } = await fixture(["cursor-agent"]);
  const second = new AgentHookManager({
    home,
    userData: join(root, "second-installation"),
    commandPath: async command => command === "cursor-agent" ? "/fixture/cursor-agent" : undefined,
    version: async () => "1.4.0",
  });
  const path = join(home, ".cursor", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    version: 1,
    hooks: { stop: [{ command: "user-hook" }] },
  }));
  await Promise.all([manager.install("cursor"), second.install("cursor")]);
  const stop = handlers(await json(path), "stop");
  assert.equal(stop.filter((entry: any) => entry.command === "user-hook").length, 1);
  assert.equal(stop.length, 2, "Concurrent installs must retain one managed handler.");
});

test("configuration symlinks and unrelated OMP marker comments are never replaced", async () => {
  const { home, manager, root } = await fixture(["cursor-agent", "omp"]);
  const target = join(root, "shared-user-hooks.json");
  const body = '{"version":1,"hooks":{"stop":[{"command":"openviking"}]}}\n';
  await writeFile(target, body);
  const path = join(home, ".cursor", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
  await assert.rejects(manager.install("cursor"), /真实文件/);
  assert.equal(await readFile(target, "utf8"), body);
  const ompPath = join(home, ".omp", "agent", "extensions", "crewvane.js");
  const extension = "// user extension\n// mentions Crewvane managed OMP extension\n";
  await mkdir(dirname(ompPath), { recursive: true });
  await writeFile(ompPath, extension);
  await assert.rejects(manager.install("omp"), /同名文件/);
  await manager.uninstall("omp");
  assert.equal(await readFile(ompPath, "utf8"), extension);
});

test("malformed JSON and a future Cursor schema are protected and reported as incompatible", async () => {
  const malformed = await fixture(["claude"]);
  const claudePath = join(malformed.home, ".claude", "settings.json");
  await mkdir(dirname(claudePath), { recursive: true });
  await writeFile(claudePath, "{ broken");
  await malformed.manager.autoInstallDetected();
  assert.equal(await readFile(claudePath, "utf8"), "{ broken");
  assert.equal(
    (await malformed.manager.status()).find(status => status.id === "claude-code")?.status,
    "conflict",
  );

  const future = await fixture(["cursor-agent"]);
  const cursorPath = join(future.home, ".cursor", "hooks.json");
  await mkdir(dirname(cursorPath), { recursive: true });
  const body = JSON.stringify({ version: 2, hooks: { stop: [] } });
  await writeFile(cursorPath, body);
  await future.manager.autoInstallDetected();
  assert.equal(await readFile(cursorPath, "utf8"), body);
  const status = (await future.manager.status())
    .find(item => item.id === "cursor");
  assert.equal(status?.status, "unsupported");
  assert.match(status?.detail ?? "", /版本不支持/);
  await assert.rejects(future.manager.uninstall("cursor"), /版本不支持/);
  assert.equal(await readFile(cursorPath, "utf8"), body);
});

test("OMP never overwrites an unrelated same-name extension", async () => {
  const { home, manager } = await fixture(["omp"]);
  const path = join(home, ".omp", "agent", "extensions", "crewvane.js");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "// user extension\n");
  await manager.autoInstallDetected();
  assert.equal(await readFile(path, "utf8"), "// user extension\n");
  assert.equal(
    (await manager.status()).find(status => status.id === "omp")?.status,
    "conflict",
  );
});

test("agents that are not installed remain untouched", async () => {
  const { home, manager } = await fixture([]);
  const statuses = await manager.autoInstallDetected();
  assert.equal(statuses.every(status => status.status === "not-installed"), true);
  await assert.rejects(
    manager.install("codex"),
    /尚未安装/,
  );
  assert.equal(
    await stat(join(home, ".codex", "hooks.json")).then(() => true).catch(() => false),
    false,
  );
});

test("valid JSON with an unknown root shape is never overwritten", async () => {
  const { home, manager } = await fixture(["codex"]);
  const path = join(home, ".codex", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '["user-owned"]');
  await manager.autoInstallDetected();
  assert.equal(await readFile(path, "utf8"), '["user-owned"]');
  assert.equal((await manager.status()).find(item => item.id === "codex")?.status, "conflict");
  await manager.uninstall("codex");
  assert.equal(await readFile(path, "utf8"), '["user-owned"]');
});

test("concurrent automatic install, manual install and observation preserve hooks and trust", async () => {
  const { home, userData, manager } = await fixture(["codex"]);
  const path = join(home, ".codex", "hooks.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "user-owned" }] }] },
  }));
  await Promise.all([
    manager.autoInstallDetected(),
    manager.install("codex"),
    manager.markObserved("codex", "2030-01-01T00:01:00.000Z"),
    manager.install("codex"),
  ]);
  const config = await json(path);
  assert.equal(handlers(config, "Stop").filter((handler: any) =>
    handler.command === "user-owned").length, 1);
  assert.equal(handlers(config, "Stop").filter((handler: any) =>
    handler.command.includes("hook ingest --adapter codex")).length, 1);
  const status = (await manager.status()).find(item => item.id === "codex")!;
  assert.equal(status.status, "installed");
  assert.equal(status.lastEventAt, "2030-01-01T00:01:00.000Z");
  assert.equal((await json(join(userData, "agent-hooks.json"))).adapters.codex.installed, true);
});

test("the installed OMP extension uses official logical-turn events and excludes tool content", async () => {
  const { root, home, manager } = await fixture(["omp"]);
  await manager.install("omp");
  const extension = join(home, ".omp/agent/extensions/crewvane.js");
  const capture = join(root, "events.jsonl"), cli = join(root, "capture-hook");
  await writeFile(cli, `#!${process.execPath}
const fs = require("node:fs");
let body = ""; process.stdin.on("data", chunk => body += chunk);
process.stdin.on("end", () => fs.appendFileSync(${JSON.stringify(capture)}, body+"\\n"));
`, { mode: 0o700 });
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
import extension from ${JSON.stringify(pathToFileURL(extension).href)};
import { readFile } from "node:fs/promises";
const handlers = new Map();
extension({on(name, handler) { handlers.set(name, handler); }});
const ctx = { sessionManager: { getSessionId: () => "official-session" } };
const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
fire("session_start");
fire("input", {text: "一个用户回合"});
fire("turn_start", {turnIndex: 0});
fire("turn_end", {turnIndex: 0, message: {role: "toolResult", content: "PRIVATE_TOOL_OUTPUT"}});
fire("turn_start", {turnIndex: 1});
fire("turn_end", {turnIndex: 1, message: {role: "assistant", content: [{type: "text", text: "真实回复"}]}});
fire("agent_end", {willContinue: true, messages: []});
fire("agent_end", {awaitingAsyncWork: true, messages: []});
fire("agent_end", {messages: [{role: "assistant", content: "本轮结束"}]});
fire("tool_approval_requested", {toolName: "shell", toolInput: "PRIVATE_TOOL_ARGUMENT"});
fire("session_shutdown");
// Wait for the actual asynchronous writes, including on a loaded CI runner.
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const body = await readFile(${JSON.stringify(capture)}, "utf8").catch(() => "");
  if (body.trim().split("\\n").filter(Boolean).length === 7) break;
  await new Promise(resolve => setTimeout(resolve, 20));
}
`], {
    env: {
      ...process.env, CREWVANE_CLI_BIN: cli, CREWVANE_GOAL_ID: "goal-fixture",
      CREWVANE_ATTEMPT_ID: "attempt-fixture", CREWVANE_HOOK_TOKEN: "fixture",
    },
    timeout: 12_000,
  });
  const body = await readFile(capture, "utf8");
  const events = body.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.hook_event_name === "TurnStart").length, 1);
  assert.equal(events.filter(event => event.hook_event_name === "AgentEnd").length, 1);
  const turn = events.find(event => event.hook_event_name === "TurnStart").turn_id;
  assert.ok(events.filter(event => ["TurnStart", "TurnEnd", "AgentEnd"].includes(event.hook_event_name))
    .every(event => event.turn_id === turn));
  assert.ok(events.some(event => event.text === "真实回复"));
  assert.ok(events.some(event => event.hook_event_name === "ToolApprovalRequested"));
  assert.doesNotMatch(body, /PRIVATE_TOOL/);
});
