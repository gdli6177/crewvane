import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { localAdapter, OrcaAdapter, type CreateSceneRequest } from "../src/index.js";
import { orcaEnvelope, orcaPrograms } from "../src/orca/parser.js";
import type { SceneReferenceV1 } from "../../core/src/index.js";
import { sessionContract } from "./session-contract-suite.js";

function envelope(result: unknown, runtimeId = "runtime-one") {
  return JSON.stringify({ ok: true, result, _meta: { runtimeId } });
}
async function fixture(t: test.TestContext, options: {
  lostCreate?: boolean; malformedSend?: boolean; unverifiableClose?: boolean;
  unsupportedObserver?: boolean; afterSendState?: string; orphaned?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "cv-orca-parser-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptPath = join(root, "environment-ready.json");
  const input: CreateSceneRequest = {
    requestId: "launch-one", installationId: "installation-one", bindingId: "binding-one",
    attemptId: "attempt-one", backendEpoch: 0, role: "owner", goalId: "goal-one",
    cwd: "/tmp/个人 事项", title: "owned fixture", launcherPath: "/tmp/private-launcher.zsh", receiptPath,
  };
  let alive = true, runtimeId = "runtime-one", created = false, sends = 0, creates = 0, closed = false;
  let orphaned = options.orphaned ?? false;
  let focusDisconnectedResponses = 0;
  const calls: string[][] = [];
  const terminal = () => ({
    handle: "term-one", worktreeId: "repo-one::/tmp/个人 事项",
    executionHostId: "local", incarnationId: "incarnation-one", connected: !closed, writable: true,
    tabId: "tab-one", leafId: "leaf-one", orphaned,
    // These sensitive upstream fields must not reach the returned observations.
    preview: "PRIVATE_TERMINAL_TEXT", toolInput: "PRIVATE_TOOL_INPUT",
  });
  const adapter = new OrcaAdapter({
    appPath: "/mock/Orca.app", directory: root,
    detect: async () => ({
      id: "orca", status: "compatible", version: "1.4.258",
      capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false },
    }),
    processes: {
      identity: async pid => ({ pid, bornAt: "birth-one" }),
      alive: async () => alive,
      hasChild: async () => alive,
    },
    wait: async () => {},
    run: async args => {
      calls.push(args);
      const command = args.slice(0, 2).join(" ");
      if (args[0] === "status") return envelope({
        app: { pid: 100 },
        runtime: { reachable: true, runtimeId, appVersion: "1.4.258", capabilities: [
          "terminal.prompt-delivery.v1", "terminal.create-idempotency.v2", "workspace-selector.folder-match.v1",
        ] },
        graph: { state: "ready" },
      }, runtimeId);
      if (command === "worktree show") return envelope({ worktree: { id: terminal().worktreeId, path: input.cwd } }, runtimeId);
      if (command === "terminal create") {
        creates++;
        created = true;
        await writeFile(receiptPath, JSON.stringify({
          version: 1, requestId: input.requestId, installationId: input.installationId,
          bindingId: input.bindingId, attemptId: input.attemptId, backendEpoch: input.backendEpoch,
          pid: 200, bornAt: "birth-one", terminalHandle: "term-one",
        }));
        return options.lostCreate ? "" : envelope({ terminal: terminal() }, runtimeId);
      }
      if (command === "terminal show") {
        const result = focusDisconnectedResponses > 0
          ? { ...terminal(), connected: false }
          : terminal();
        if (focusDisconnectedResponses > 0) focusDisconnectedResponses--;
        return envelope({ terminal: result }, runtimeId);
      }
      if (command === "terminal list") return envelope({
        terminals: created && !closed ? [terminal()] : [], truncated: false,
        hostScope: { hostIds: ["local"], omittedHostIds: [] },
      }, runtimeId);
      if (command === "worktree ps") return envelope({ worktrees: [{ agents: [{
        paneKey: "tab-one:leaf-one", state: sends ? options.afterSendState ?? "done" : "done",
        prompt: "PRIVATE_PROMPT", toolInput: "PRIVATE_TOOL_INPUT",
      }] }] }, runtimeId);
      if (command === "terminal switch") {
        orphaned = false;
        return envelope({ focus: { navigated: true } }, runtimeId);
      }
      if (command === "terminal send") {
        sends++;
        if (options.malformedSend) return "not a JSON response";
        return envelope({ send: {
          handle: "term-one", accepted: true,
          prompt: { requestId: "upstream-one", stages: ["input_accepted"], processIncarnation: "incarnation-one",
            ...(options.unsupportedObserver ? { observation: "unsupported" } : {}) },
        } }, runtimeId);
      }
      if (command === "terminal close") {
        if (!options.unverifiableClose) { closed = true; alive = false; }
        return envelope({ close: { ptyKilled: !options.unverifiableClose } }, runtimeId);
      }
      throw new Error(`Unexpected mock command ${command}`);
    },
  });
  await adapter.connect({ installationId: input.installationId, cwd: input.cwd });
  const create = () => adapter.create(input);
  return {
    root, input, adapter, create, calls,
    counts: () => ({ sends, creates }),
    restart: () => { runtimeId = "runtime-two"; },
    disconnectNextFocus: (count = 1) => { focusDisconnectedResponses = count; },
  };
}
test("unknown or mixed JSON is never accepted as success", () => {
  for (const raw of ["", "text\n{}", "{}", '{"ok":true,"result":{}}', '{"ok":true,"result":{},"_meta":{}}'])
    assert.throws(() => orcaEnvelope(raw));
  assert.throws(() => orcaEnvelope('{"ok":false,"error":{"code":"permission","message":"blocked"}}'), /permission/);
});
sessionContract("Orca", fixture);
test("start-if-missing launches an isolated profile as a new Orca instance", async t => {
  const root = await mkdtemp(join(tmpdir(), "cv-orca-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  let reachable = false, launchedProfile: string | undefined, statusCalls = 0;
  const adapter = new OrcaAdapter({
    appPath: "/mock/Orca.app", directory: root,
    environment: { ORCA_USER_DATA_PATH: profile },
    detect: async () => ({
      id: "orca", status: "compatible", version: "1.4.258",
      capabilities: { create: true, inspect: true, send: true, focus: true, close: true, discover: true, nativeResume: false },
    }),
    processes: {
      identity: async pid => ({ pid, bornAt: "birth-one" }),
      alive: async () => true,
      hasChild: async () => true,
    },
    launchApplication: async selected => {
      launchedProfile = selected;
      reachable = true;
    },
    wait: async () => {},
    run: async args => {
      assert.deepEqual(args, ["status", "--environment", "local", "--json"]);
      statusCalls++;
      // Cold launches may need several probes while Orca initializes its
      // runtime graph. A single immediate retry is not enough on loaded hosts.
      if (!reachable || statusCalls < 5)
        return JSON.stringify({
          ok: true,
          result: {
            app: { pid: null },
            runtime: { reachable: false, state: "not_running" },
            graph: { state: "not_running" },
          },
          _meta: { runtimeId: "none" },
        });
      return envelope({
        app: { pid: 100 },
        runtime: { reachable: true, runtimeId: "runtime-one", appVersion: "1.4.258", capabilities: [
          "terminal.prompt-delivery.v1", "terminal.create-idempotency.v2", "workspace-selector.folder-match.v1",
        ] },
        graph: { state: "ready" },
      });
    },
  });
  const runtime = await adapter.connect({
    installationId: "installation-one", cwd: "/tmp/workspace", startIfMissing: true,
  });
  assert.equal(runtime.id, "runtime-one");
  assert.equal(launchedProfile, profile);
  assert.equal(statusCalls, 5);
});
test("isolated Orca profiles keep the explicit host HOME for runtime launch and probes", async () => {
  const adapter = localAdapter({
    backend: "orca",
    workspace: "/tmp/workspace",
    control: {
      version: 1, installationId: "installation-one", selected: "orca",
      epoch: 0, scopeGeneration: "scope-one", phase: "ready",
    },
    directory: "/tmp/session-control",
    environment: {
      HOME: "/tmp/isolated-home",
      ORCA_USER_DATA_PATH: "/tmp/isolated-profile",
      CREWVANE_ORCA_HOST_HOME: "/Users/host-user",
    },
  }) as OrcaAdapter;
  assert.equal(adapter.options.environment?.HOME, "/Users/host-user");
  assert.equal(adapter.options.environment?.ORCA_USER_DATA_PATH, "/tmp/isolated-profile");
});
test("public worktree Agent states are runtime observations, not goal completion", () => {
  const states = ["working", "done", "blocked", "waiting", "unknown-new-state"];
  assert.deepEqual(orcaPrograms([{ agents: states.map(state => ({ paneKey: state, state })) }]),
    states.map((paneKey, i) => ({
      paneKey, state: ["working", "idle", "blocked", "blocked", "unknown"][i],
    })));
});
test("lost create stdout recovers only through private process/terminal receipts; repeated and concurrent creates do not replay", async t => {
  const f = await fixture(t, { lostCreate: true });
  const result = await f.create();
  assert.equal(result.status, "created");
  assert(result.scene);
  const found = await f.adapter.discover({
    installationId: f.input.installationId, runtimeId: result.scene.runtimeId, requestId: f.input.requestId,
  });
  assert.equal(found[0]?.scene.bindingId, f.input.bindingId);
  assert.deepEqual((await f.create()).scene, result.scene);
  assert.equal(f.counts().creates, 1);
  assert.equal((await f.adapter.discover({ installationId: "another-installation", runtimeId: result.scene.runtimeId })).length, 0);
});
test("send accepted is distinct from started; one delivery ID is sent only once", async t => {
  const f = await fixture(t), scene = (await f.create()).scene!;
  const input = { deliveryId: "delivery-one", scene, text: "test payload", payloadSha256: createHash("sha256").update("test payload").digest("hex") };
  const receipt = await f.adapter.send(input);
  assert.equal(receipt.status, "accepted");
  assert.equal(receipt.upstreamRequestId, "upstream-one");
  assert.deepEqual(await f.adapter.send(input), receipt);
  assert.equal(f.counts().sends, 1);
  await assert.rejects(f.adapter.send({ ...input, text: "changed" }), /摘要/);
});
test("unsupported native prompt observation can confirm an identity-bound idle to working transition without resending", async t => {
  const f = await fixture(t, { unsupportedObserver: true, afterSendState: "working" });
  const scene = (await f.create()).scene!;
  const input = { deliveryId: "omp-once", scene, text: "follow-up",
    payloadSha256: createHash("sha256").update("follow-up").digest("hex") };
  assert.equal((await f.adapter.send(input)).status, "started");
  assert.equal((await f.adapter.send(input)).status, "started");
  assert.equal(f.counts().sends, 1);
});
test("an unsupported observer reporting blocked does not become started or retry input", async t => {
  const f = await fixture(t, { unsupportedObserver: true, afterSendState: "blocked" });
  const scene = (await f.create()).scene!;
  const result = await f.adapter.send({ deliveryId: "blocked-once", scene, text: "follow-up",
    payloadSha256: createHash("sha256").update("follow-up").digest("hex") });
  assert.equal(result.status, "accepted");
  assert.equal(f.counts().sends, 1);
});
test("response loss persists unknown and cannot be retried under a replacement identity", async t => {
  const f = await fixture(t, { malformedSend: true }), scene = (await f.create()).scene!;
  const input = { deliveryId: "delivery-one", scene, text: "payload", payloadSha256: createHash("sha256").update("payload").digest("hex") };
  const receipt = await f.adapter.send(input);
  assert.equal(receipt.status, "unknown");
  assert.equal((await f.adapter.send(input)).status, "unknown");
  assert.equal(f.counts().sends, 1);
  await assert.rejects(f.adapter.send({ ...input, retry: { requestId: "invented", incarnationId: "incarnation-one", payloadSha256: input.payloadSha256 } }), /原请求/);
});
test("runtime restart and foreign incarnation reject sends and focus without creating a scene", async t => {
  const f = await fixture(t), scene = (await f.create()).scene!;
  f.restart();
  assert.equal((await f.adapter.inspect(scene)).identity, "mismatch");
  const sent = await f.adapter.send({ deliveryId: "late-one", scene, text: "late", payloadSha256: createHash("sha256").update("late").digest("hex") });
  assert.equal(sent.status, "rejected");
  assert.equal(f.counts().sends, 0);
  assert.equal((await f.adapter.focus(scene)).status, "missing");
  assert.equal(f.counts().creates, 1);
});
test("focus retries the same terminal while Orca connects it and never requires writable input", async t => {
  const f = await fixture(t), scene = (await f.create()).scene!;
  f.disconnectNextFocus();
  assert.deepEqual(await f.adapter.focus(scene), { status: "focused", navigated: true });
  assert.equal(f.counts().creates, 1);
});
test("background orphaned terminals stay reachable, receive input, and reattach on focus", async t => {
  const f = await fixture(t, { orphaned: true }), scene = (await f.create()).scene!;
  const before = await f.adapter.inspect(scene);
  assert.equal(before.identity, "match");
  assert.equal(before.reachable, true);
  const payload = "background owner follow-up";
  const sent = await f.adapter.send({
    deliveryId: "background-owner",
    scene,
    text: payload,
    payloadSha256: createHash("sha256").update(payload).digest("hex"),
  });
  assert(["accepted", "started"].includes(sent.status), sent.detail);
  assert.equal(f.counts().sends, 1);
  assert.deepEqual(await f.adapter.focus(scene), { status: "focused", navigated: true });
  assert.equal(f.counts().creates, 1);
});
test("exit zero without a stop verdict remains unknown", async t => {
  const f = await fixture(t, { unverifiableClose: true }), scene = (await f.create()).scene!;
  const receipt = await f.adapter.close(scene);
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.identityVerified, true);
});
test("verified stop requires both a PTY receipt and the original process gone", async t => {
  const f = await fixture(t), scene = (await f.create()).scene!;
  assert.equal((await f.adapter.close(scene)).status, "stopped");
  assert.equal((await f.adapter.close(scene)).status, "already_stopped");
});
test("batch inspection strips upstream terminal previews, prompts and tool inputs", async t => {
  const f = await fixture(t), scene = (await f.create()).scene!;
  const observations = await f.adapter.inspectMany([scene]);
  assert.equal(observations[0]?.state, "idle");
  assert(!JSON.stringify(observations).includes("PRIVATE_"));
  assert.equal((await f.adapter.captureResume(scene)).status, "unsupported");
});
