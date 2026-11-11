import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HerdrHostBridge } from "../electron/herdr-host-bridge.ts";
import { runHostHerdr } from "../../../cli/src/host-bridge.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-host-bridge-"));
  const executable = join(root, "fake-herdr.cjs");
  await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("fail")) {
  process.stderr.write("fixture failure\\n");
  process.exit(7);
}
process.stdout.write(JSON.stringify(args));
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const bridge = new HerdrHostBridge(
    root,
    "crewvane-test",
    async () => executable,
  );
  await bridge.start();
  return {
    root,
    bridge,
    async close() {
      await bridge.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("Host Bridge accepts its token and preserves Herdr stdout", async () => {
  const context = await fixture();
  try {
    const output = await runHostHerdr(
      context.bridge.socketPath,
      context.bridge.token,
      ["agent", "list"],
    );
    assert.deepEqual(JSON.parse(output), [
      "--session",
      "crewvane-test",
      "agent",
      "list",
    ]);
  } finally {
    await context.close();
  }
});

test("Host Bridge keeps socket paths short and isolated for deeply nested workspaces", () => {
  const deepRoot = `/tmp/${"very-long-workspace/".repeat(12)}project`;
  const first = new HerdrHostBridge(
    deepRoot,
    "crewvane-a",
    async () => "/bin/true",
  );
  const second = new HerdrHostBridge(
    `${deepRoot}-other`,
    "crewvane-b",
    async () => "/bin/true",
  );
  assert.ok(Buffer.byteLength(first.socketPath) < 104);
  assert.notEqual(first.socketPath, second.socketPath);
  assert.notEqual(first.requestDirectory, second.requestDirectory);
});

test("Host Bridge rejects a missing token and illegal command roots", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      runHostHerdr(context.bridge.socketPath, "wrong", ["agent", "list"]),
      /未获授权/,
    );
    await assert.rejects(
      runHostHerdr(
        context.bridge.socketPath,
        context.bridge.token,
        ["shell", "rm", "-rf", "/"],
      ),
      /未获授权/,
    );
  } finally {
    await context.close();
  }
});

test("Host Bridge returns non-zero subprocess stderr without hiding the error", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      runHostHerdr(
        context.bridge.socketPath,
        context.bridge.token,
        ["pane", "fail"],
      ),
      /fixture failure/,
    );
  } finally {
    await context.close();
  }
});

test("Host Bridge falls back to a private workspace file channel when sockets are denied", async () => {
  const context = await fixture();
  try {
    await unlink(context.bridge.socketPath);
    const output = await runHostHerdr(
      context.bridge.socketPath,
      context.bridge.token,
      ["pane", "list"],
      2_000,
    );
    assert.deepEqual(JSON.parse(output), [
      "--session",
      "crewvane-test",
      "pane",
      "list",
    ]);
  } finally {
    await context.close();
  }
});

test("the file channel rejects an invalid token without touching the workspace", async () => {
  const context = await fixture();
  try {
    await unlink(context.bridge.socketPath);
    await assert.rejects(
      runHostHerdr(
        context.bridge.socketPath,
        "wrong-token",
        ["tab", "close", "foreign-tab"],
        2_000,
      ),
      /未获授权/,
    );
  } finally {
    await context.close();
  }
});

test("a request claimed by a previous bridge is reported unconfirmed instead of replayed", async () => {
  const context = await fixture();
  const marker = join(context.root, "executed.txt");
  const executable = join(context.root, "claim-check.cjs");
  await writeFile(executable, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");
process.stdout.write("should-not-run");
`, { mode: 0o700 });
  await context.bridge.stop();
  const bridge = new HerdrHostBridge(
    context.root,
    "crewvane-test",
    async () => executable,
  );
  try {
    const requestDirectory = bridge.requestDirectory;
    const id = "claimed-before-restart";
    const requestPath = join(requestDirectory, `${id}.request.json`);
    const claimPath = join(requestDirectory, `${id}.claimed.json`);
    const responsePath = join(requestDirectory, `${id}.response.json`);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    await writeFile(requestPath, `${JSON.stringify({
      id,
      version: 1,
      token: bridge.token,
      args: ["pane", "list"],
    })}\n`, { mode: 0o600 });
    await writeFile(claimPath, "{\"claimedAt\":\"before-restart\"}\n", {
      mode: 0o600,
    });
    await bridge.start();
    let response = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      response = await readFile(responsePath, "utf8").catch(() => "");
      if (response) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.match(response, /结果未确认，未自动重放/);
    assert.equal(await readFile(marker, "utf8").catch(() => ""), "");
  } finally {
    await bridge.stop();
    await rm(context.root, { recursive: true, force: true });
  }
});

test("CLI Host Bridge reports unavailable and silent sockets promptly", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-host-bridge-empty-"));
  try {
    await assert.rejects(
      runHostHerdr(join(root, "missing.sock"), "token", ["agent", "list"], 100),
      /未连接|响应超时/,
    );

    const { createServer } = await import("node:net");
    const socketPath = join(root, "silent.sock");
    const server = createServer(socket => {
      socket.on("data", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await assert.rejects(
        runHostHerdr(socketPath, "token", ["agent", "list"], 30),
        /响应超时/,
      );
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
