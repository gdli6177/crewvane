import test from "node:test";
import assert from "node:assert/strict";
import { resumeAgentArgs } from "../src/agent-resume.js";

test("builds native resume arguments for recognized Herdr Agent sessions", () => {
  assert.deepEqual(resumeAgentArgs({
    source: "herdr:codex",
    agent: "codex",
    kind: "id",
    value: "codex-session",
  }), ["resume", "codex-session"]);
  assert.deepEqual(resumeAgentArgs({
    source: "herdr:omp",
    agent: "omp",
    kind: "path",
    value: "/tmp/omp-session.json",
  }), ["--resume=/tmp/omp-session.json"]);
  assert.deepEqual(resumeAgentArgs({
    source: "herdr:cursor",
    agent: "cursor",
    kind: "id",
    value: "cursor-session",
  }), ["--resume", "cursor-session"]);
  assert.deepEqual(resumeAgentArgs({
    source: "herdr:antigravity_cli",
    agent: "agy",
    kind: "id",
    value: "antigravity-session",
  }), ["--conversation", "antigravity-session"]);
});

test("does not invent a resume command for unknown or invalid session identities", () => {
  assert.equal(resumeAgentArgs({
    source: "custom-plugin",
    agent: "codex",
    kind: "id",
    value: "session",
  }), undefined);
  assert.equal(resumeAgentArgs({
    source: "herdr:codex",
    agent: "codex",
    kind: "path",
    value: "/tmp/session",
  }), undefined);
  assert.equal(resumeAgentArgs(undefined), undefined);
});
