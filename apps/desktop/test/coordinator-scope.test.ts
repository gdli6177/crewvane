import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  coordinatorScopePath,
  writeCoordinatorScope,
} from "../electron/coordinator-scope.js";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("coordinator scope replaces atomically and keeps the latest case", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-coordinator-scope-"));
  fixtures.push(root);
  await mkdir(join(root, ".crewvane"));

  await writeCoordinatorScope(root, "goal_first", "request_first");
  await writeCoordinatorScope(root, "goal_latest", "request_latest", {
    id: "reply_1",
    attentionId: "attention_1",
    quote: "继续",
    summary: "用户确认继续",
    at: new Date().toISOString(),
    actor: "owner-a",
  });

  const path = coordinatorScopePath(root),
    value = JSON.parse(await readFile(path, "utf8")),
    entries = await readdir(join(root, ".crewvane"));
  assert.equal(value.goalId, "goal_latest");
  assert.equal(value.requestId, "request_latest");
  assert.equal(value.attentionId, "attention_1");
  assert.equal(value.sceneReplyId, "reply_1");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(entries.some(name => name.includes(".tmp")), false);
});

test("concurrent scope updates always leave one complete JSON document", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-coordinator-scope-"));
  fixtures.push(root);
  await mkdir(join(root, ".crewvane"));

  await Promise.all(Array.from({ length: 24 }, (_, index) =>
    writeCoordinatorScope(root, `goal_${index}`, `request_${index}`)));

  const value = JSON.parse(await readFile(coordinatorScopePath(root), "utf8"));
  assert.match(value.goalId, /^goal_\d+$/);
  assert.equal(value.requestId, value.goalId.replace("goal_", "request_"));
  const entries = await readdir(join(root, ".crewvane"));
  assert.equal(entries.some(name => name.includes(".tmp")), false);
});
