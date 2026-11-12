import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function call(root: string, argv: string[]) {
  let stdout = "", stderr = "";
  const code = await run([...argv, "--root", root, "--json"], {
    out: text => {
      stdout += text;
    },
    error: text => {
      stderr += text;
    },
  });
  return {
    code,
    stdout,
    stderr,
    json: stdout ? JSON.parse(stdout) : undefined,
  };
}

test("real CLI creates, validates, installs, lists and binds a local method pack", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-cli-"));
  fixtures.push(root);
  const draft = join(root, "draft");
  const created = await call(root, [
    "skill",
    "draft",
    draft,
    "--id",
    "acme.review",
    "--name",
    "发布评审",
    "--description",
    "交付发布前使用。",
    "--role",
    "owner",
    "--role",
    "verifier",
  ]);
  assert.equal(created.code, 0, created.stderr);

  const validated = await call(root, ["skill", "validate", draft]);
  assert.equal(validated.code, 0, validated.stderr);
  assert.equal(validated.json.manifest.id, "acme.review");
  assert.deepEqual(validated.json.manifest.roles, ["owner", "verifier"]);

  const installed = await call(root, ["skill", "install", draft]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(installed.json.status, "ready");
  assert.equal(
    JSON.stringify((await call(root, ["skill", "list"])).json)
      .includes("Crewvane Core 约束"),
    false,
  );
  assert.match(
    (await call(root, ["skill", "show", "crewvane.concierge"])).json.content,
    /控制面管家/,
  );

  const goal = await call(root, [
    "goal",
    "create",
    "--title",
    "使用本地方法",
    "--project",
    "personal",
  ]);
  assert.equal(goal.code, 0, goal.stderr);
  const attached = await call(root, [
    "skill",
    "attach",
    goal.json.id,
    "acme.review",
  ]);
  assert.equal(attached.code, 0, attached.stderr);
  assert.equal(attached.json.skills[0].packId, "acme.review");

  const resolved = await call(root, [
    "skill",
    "resolve",
    goal.json.id,
    "--role",
    "owner",
  ]);
  assert.equal(resolved.code, 0, resolved.stderr);
  assert.match(resolved.json.text, /发布评审/);
  assert.deepEqual(
    resolved.json.packs.map((pack: { id: string }) => pack.id),
    ["crewvane.owner", "crewvane.process.delivery", "acme.review"],
  );
});

test("managed Agents can inspect available methods but cannot change another goal's methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-scope-"));
  fixtures.push(root);
  const first = await call(root, [
      "goal",
      "create",
      "--title",
      "目标一",
      "--project",
      "personal",
    ]),
    second = await call(root, [
      "goal",
      "create",
      "--title",
      "目标二",
      "--project",
      "personal",
    ]);
  const previousGoal = process.env.CREWVANE_GOAL_ID,
    previousCoordinator = process.env.CREWVANE_COORDINATOR;
  process.env.CREWVANE_GOAL_ID = first.json.id;
  delete process.env.CREWVANE_COORDINATOR;
  try {
    assert.equal((await call(root, ["skill", "list"])).code, 0);
    const denied = await call(root, [
      "skill",
      "attach",
      second.json.id,
      "acme.review",
    ]);
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /当前目标|scope|权限|能力包/);
  } finally {
    if (previousGoal === undefined) delete process.env.CREWVANE_GOAL_ID;
    else process.env.CREWVANE_GOAL_ID = previousGoal;
    if (previousCoordinator === undefined) delete process.env.CREWVANE_COORDINATOR;
    else process.env.CREWVANE_COORDINATOR = previousCoordinator;
  }
});
