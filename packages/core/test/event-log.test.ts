import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactEventLogIfNeeded,
  readEvents,
  WorkspaceService,
} from "../src/index.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "crewvane-event-log-"));
  fixtures.push(root);
  return root;
}

test("workspace changes append a state digest instead of another full snapshot", async () => {
  const root = await fixture(),
    service = new WorkspaceService(root);
  await service.execute({
    type: "goal.intake",
    text: "记录一个不会在事件日志中复制完整快照的目标",
    projectId: "personal",
  });
  const events = await readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "workspace_changed");
  assert.match(String(events[0]?.state_sha256), /^[a-f0-9]{64}$/);
  assert.equal(typeof events[0]?.state_bytes, "number");
  assert.equal(events[0]?.state, undefined);
  assert.ok((await stat(join(root, ".crewvane/events.jsonl"))).size < 2_000);
});

test("an oversized legacy event log is compacted from complete tail records", async () => {
  const root = await fixture(),
    directory = join(root, ".crewvane"),
    path = join(directory, "events.jsonl");
  await mkdir(directory, { recursive: true });
  const records = Array.from({ length: 4 }, (_, index) => ({
    id: `evt_${index}`,
    type: "workspace_changed",
    sequence: index + 1,
    title: `旧事件 ${index}`,
    state: { version: 2, payload: `${index}`.repeat(10_000) },
  }));
  await writeFile(path, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
  const before = (await stat(path)).size,
    result = await compactEventLogIfNeeded(directory, {
      maxBytes: 1_000,
      tailBytes: 300_000,
      keepEvents: 2,
    }),
    compacted = await readEvents(root);

  assert.equal(result.compacted, true);
  assert.ok(result.after < before / 100);
  assert.deepEqual(compacted.map(event => event.id), ["evt_2", "evt_3"]);
  assert.ok(compacted.every(event => event.state === undefined && event.compacted === true));
  assert.ok(compacted.every(event => /^[a-f0-9]{64}$/.test(String(event.state_sha256))));
});
