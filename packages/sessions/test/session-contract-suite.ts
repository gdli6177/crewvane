import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionAdapter, CreateSceneResult } from "../src/index.js";

export function sessionContract(name: string, fixture: (t: test.TestContext) => Promise<{
  adapter: SessionAdapter; create(): Promise<CreateSceneResult>; counts(): { sends: number; creates: number }; restart(): void;
}>) {
  test(`${name} shared contract: one request creates and sends once, focus never creates, foreign runtime cannot receive`, async t => {
    const f = await fixture(t);
    const created = await f.create(), scene = created.scene;
    assert.equal(created.status, "created");
    assert(scene);
    assert.equal((await f.create()).scene?.bindingId, scene.bindingId);
    assert.equal(f.counts().creates, 1);
    const text = "中文 request payload";
    const send = { deliveryId: "contract-delivery", scene, text,
      payloadSha256: createHash("sha256").update(text).digest("hex") };
    const receipt = await f.adapter.send(send);
    assert(["accepted", "started"].includes(receipt.status));
    assert.deepEqual(await f.adapter.send(send), receipt);
    assert.equal(f.counts().sends, 1);
    assert.deepEqual(await f.adapter.focus(scene), { status: "focused", navigated: true });
    assert.equal(f.counts().creates, 1);
    const observed = await f.adapter.inspectMany([scene]);
    assert.equal(observed[0]?.identity, "match");
    assert.equal(observed[0]?.state, "idle");
    assert(!JSON.stringify(observed).includes("PRIVATE_"));
    f.restart();
    assert.equal((await f.adapter.inspect(scene)).identity, "mismatch");
    assert.equal((await f.adapter.send({ ...send, deliveryId: "late-delivery" })).status, "rejected");
    assert.equal((await f.adapter.focus(scene)).status, "missing");
    assert.equal(f.counts().sends, 1);
  });
  test(`${name} shared contract: close has a verified stopped result and never closes foreign identity`, async t => {
    const f = await fixture(t), scene = (await f.create()).scene!;
    const foreign = { ...scene, runtimeGeneration: "foreign-generation" };
    const foreignResult = await f.adapter.close(foreign).catch(() => undefined);
    assert(!foreignResult || foreignResult.status === "unknown");
    const receipt = await f.adapter.close(scene);
    assert.equal(receipt.status, "stopped");
    assert.equal(receipt.identityVerified, true);
    assert.equal((await f.adapter.close(scene)).status, "already_stopped");
  });
}
