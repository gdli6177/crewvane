import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HerdrAdapter, type CreateSceneRequest } from "../src/index.js";
import { sessionContract } from "./session-contract-suite.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "cv-herdr-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input: CreateSceneRequest = {
    requestId: "launch-one", installationId: "installation-one", bindingId: "binding-one",
    attemptId: "attempt-one", backendEpoch: 0, role: "owner", goalId: "goal-one",
    cwd: "/tmp/个人 事项", title: "owned fixture", launcherPath: "/tmp/launch.zsh",
    receiptPath: join(root, "environment-ready.json"),
  };
  let alive = true, generation = "one", creates = 0, sends = 0, focused = false, stallNextPrompt = false;
  let focusTabSelectsPane = true;
  let stallError = 'Command failed: herdr agent prompt {"error":{"code":"agent_prompt_stalled","message":"accepted, but no working state was observed"}}';
  const commands: string[][] = [];
  const envelope = (result: unknown) => JSON.stringify({ result });
  const adapter = new HerdrAdapter({
    executable: "/mock/herdr", session: "cv-owned", directory: root,
    socketIdentity: async () => generation,
    processes: { identity: async pid => ({ pid, bornAt: "birth" }),
      alive: async () => alive, hasChild: async () => alive },
    run: async args => {
      commands.push(args);
      if (args[0] === "--version") return "herdr 0.9.5";
      if (args[0] === "status") return envelope({
        server: { running: true, compatible: true, session: "cv-owned", socket: "/tmp/herdr.sock", version: "0.9.5" },
      });
      const command = args.slice(0, 2).join(" ");
      if (command === "workspace list") return envelope({ workspaces: [{ workspace_id: "w1" }] });
      if (command === "tab create") { creates++; return envelope({ root_pane: { pane_id: "w1:p1" } }); }
      if (command === "pane run") {
        await writeFile(input.receiptPath, JSON.stringify({
          version: 1, ...input, pid: 200, bornAt: "birth",
          herdr: { session: "cv-owned", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1" },
        }));
        return "";
      }
      if (command === "pane list") return envelope({ panes: alive ? [
        { pane_id: "w1:p1", tab_id: "w1:t1", focused },
        { pane_id: "w1:p-user", tab_id: "w1:t1", focused: false },
      ] : [{ pane_id: "w1:p-user", tab_id: "w1:t1", focused: false }] });
      if (command === "agent list") return envelope({ agents: alive ? [{
        pane_id: "w1:p1", name: "owner-one", agent: "Omp", agent_status: "idle", terminal_title: "PRIVATE_TERMINAL_TEXT",
      }] : [] });
      if (command === "agent prompt") {
        sends++;
        if (stallNextPrompt) {
          stallNextPrompt = false;
          throw new Error(stallError);
        }
        return "";
      }
      if (command === "tab focus") { focused = focusTabSelectsPane; return ""; }
      if (command === "agent focus") {
        assert.equal(args[2], "w1:p1");
        focused = true;
        return "";
      }
      // pane focus accepts a direction, not a positional pane ID in 0.9.5.
      if (command === "pane focus") throw new Error("usage: herdr pane focus --direction left|right|up|down");
      if (command === "pane close") {
        assert.equal(args[2], "w1:p1", "Never close another pane sharing the managed tab.");
        alive = false; return "";
      }
      throw new Error(`Unexpected ${command}`);
    },
  });
  await adapter.connect({ installationId: input.installationId, cwd: input.cwd });
  return { adapter, create: () => adapter.create(input),
    counts: () => ({ creates, sends }), restart: () => { generation = "two"; }, commands,
    stallNextPrompt: (error = stallError) => { stallNextPrompt = true; stallError = error; },
    otherPaneFocused: () => { focusTabSelectsPane = false; focused = false; } };
}
sessionContract("Herdr", fixture);

test("Herdr focuses a registered Agent pane with the official agent focus command", async t => {
  const f = await fixture(t), { scene } = await f.create();
  assert(scene);
  f.otherPaneFocused();
  assert.deepEqual(await f.adapter.focus(scene), { status: "focused", navigated: true });
  assert(f.commands.some(args => args[0] === "agent" && args[1] === "focus" && args[2] === "w1:p1"));
  assert(!f.commands.some(args => args[0] === "pane" && args[1] === "focus"));
  assert.equal(f.counts().creates, 1);
});

test("a long OMP message is submitted once as a private exact-payload reference", async t => {
  const f = await fixture(t);
  const { scene } = await f.create();
  assert(scene);
  const text = "完整目标与唯一案卷🚢\n".repeat(2_000);
  const payloadSha256 = createHash("sha256").update(text).digest("hex");
  const receipt = await f.adapter.send({ scene, text, deliveryId: "omp-long", payloadSha256 });
  assert.equal(receipt.status, "started", receipt.detail);
  const command = f.commands.find(args => args[0] === "agent" && args[1] === "prompt");
  assert(command);
  assert.equal(command[3]?.includes("完整目标与唯一案卷"), false);
  assert.match(command[3] ?? "", /投递 ID：omp-long/);
  const path = /完整读取 (\S+)，再按其中/.exec(command[3] ?? "")?.[1];
  assert(path);
  assert.equal(await readFile(path, "utf8"), text);
  assert.equal(f.commands.filter(args => args[0] === "agent" && args[1] === "prompt").length, 1);
});

test("a multiline OMP case below 12 KB bypasses the interactive paste menu", async t => {
  const f = await fixture(t);
  const { scene } = await f.create();
  assert(scene);
  const text = "目标事实与下一步\n".repeat(120);
  assert(Buffer.byteLength(text) < 12_000);
  const payloadSha256 = createHash("sha256").update(text).digest("hex");
  const request = { scene, text, deliveryId: "omp-multiline", payloadSha256 };
  const receipt = await f.adapter.send(request);
  assert.equal(receipt.status, "started", receipt.detail);
  const command = f.commands.find(args => args[0] === "agent" && args[1] === "prompt");
  assert(command);
  assert.equal(command[3]?.includes("目标事实与下一步"), false);
  const path = /完整读取 (\S+)，再按其中/.exec(command[3] ?? "")?.[1];
  assert(path);
  assert.equal(await readFile(path, "utf8"), text);
  assert.deepEqual(await f.adapter.send(request), receipt);
  assert.equal(f.counts().sends, 1);
});

test("Herdr stalled observation preserves accepted input without retrying its delivery", async t => {
  const f = await fixture(t);
  const { scene } = await f.create();
  assert(scene);
  f.stallNextPrompt();
  const text = "请核对当前案卷";
  const payloadSha256 = createHash("sha256").update(text).digest("hex");
  const first = await f.adapter.send({ scene, text, deliveryId: "stalled-once", payloadSha256 });
  assert.equal(first.status, "accepted", first.detail);
  assert.match(first.detail ?? "", /agent_prompt_stalled/);
  assert.deepEqual(await f.adapter.send({ scene, text, deliveryId: "stalled-once", payloadSha256 }), first);
  assert.equal(f.counts().sends, 1, "The same accepted prompt is never sent twice.");
});

test("Herdr delivery receipts never persist prompt or full command diagnostics", async t => {
  const f = await fixture(t);
  const { scene } = await f.create();
  assert(scene);
  const text = `PRIVATE_PROMPT_${"敏感正文".repeat(400)}`;
  f.stallNextPrompt(`Command failed: herdr agent prompt ${text} {"code":"agent_prompt_stalled"}`);
  const payloadSha256 = createHash("sha256").update(text).digest("hex");
  const receipt = await f.adapter.send({
    scene,
    text,
    deliveryId: "private-error",
    payloadSha256,
  });
  assert.equal(receipt.status, "accepted");
  assert.match(receipt.detail ?? "", /agent_prompt_stalled/);
  assert.doesNotMatch(receipt.detail ?? "", /PRIVATE_PROMPT|敏感正文/);
  assert.ok((receipt.detail ?? "").length < 240);
});
