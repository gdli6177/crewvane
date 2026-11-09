import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewvaneSkillInstaller } from "../electron/skill-installer.ts";

test("installs only detected agent targets and never overwrites an unrelated skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-installer-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(join(source, "references"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".claude", "skills", "crewvane"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Crewvane\n");
    await writeFile(join(source, "references", "cli-protocol.md"), "# Protocol\n");
    await writeFile(join(home, ".claude", "skills", "crewvane", "SKILL.md"), "# User skill\n");

    const installer = new CrewvaneSkillInstaller(source, home, "0.6.0");
    let status = await installer.status();
    assert.deepEqual(status.targets.map(target => [target.id, target.phase]), [
      ["agents", "not-installed"],
      ["codex", "not-installed"],
      ["claude", "conflict"],
    ]);

    const result = await installer.install();
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.id, "claude");
    status = result.status;
    assert.equal(status.installed, 2);
    assert.equal(
      await readFile(join(home, ".agents", "skills", "crewvane", "references", "cli-protocol.md"), "utf8"),
      "# Protocol\n",
    );
    assert.equal(
      await readFile(join(home, ".claude", "skills", "crewvane", "SKILL.md"), "utf8"),
      "# User skill\n",
    );
    assert.equal(
      JSON.parse(await readFile(join(home, ".codex", "skills", "crewvane", ".crewvane-managed.json"), "utf8")).version,
      "0.6.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updates a Crewvane-managed skill in place and skips undetected agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-update-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(source, { recursive: true });
    await mkdir(join(home, ".codex", "skills", "crewvane"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# New skill\n");
    await writeFile(join(home, ".codex", "skills", "crewvane", "SKILL.md"), "# Old skill\n");
    await writeFile(
      join(home, ".codex", "skills", "crewvane", ".crewvane-managed.json"),
      JSON.stringify({ managedBy: "crewvane", version: "0.5.1" }),
    );

    const installer = new CrewvaneSkillInstaller(source, home, "0.6.0");
    let status = await installer.status();
    const codex = status.targets.find(target => target.id === "codex");
    assert.equal(codex?.phase, "outdated");
    assert.equal(status.targets.some(target => target.id === "claude"), false);

    const result = await installer.install();
    status = result.status;
    assert.equal(result.errors.length, 0);
    assert.equal(status.targets.find(target => target.id === "codex")?.phase, "installed");
    assert.equal(
      await readFile(join(home, ".codex", "skills", "crewvane", "SKILL.md"), "utf8"),
      "# New skill\n",
    );
    assert.equal(
      JSON.parse(await readFile(join(home, ".codex", "skills", "crewvane", ".crewvane-managed.json"), "utf8")).version,
      "0.6.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install status remains readable before the skills folder exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-status-"));
  try {
    const source = join(root, "source");
    const home = join(root, "home");
    await mkdir(source, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Crewvane\n");
    const installer = new CrewvaneSkillInstaller(source, home, "0.6.0");
    const status = await installer.status();
    assert.equal(status.targets[0]?.phase, "not-installed");
    await assert.rejects(access(join(home, ".agents", "skills", "crewvane")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protocol changes update managed skills even when the app version is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "crewvane-skill-protocol-"));
  try {
    const source = join(root, "source"), home = join(root, "home");
    await mkdir(join(source, "references"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "# Crewvane\n");
    await writeFile(join(source, "references/cli-protocol.md"), "# Previous protocol\n");
    const installer = new CrewvaneSkillInstaller(source, home, "0.6.4");
    await installer.install();
    assert.equal((await installer.status()).targets[0]!.phase, "installed");
    await writeFile(join(source, "references/cli-protocol.md"), "# Scene receipts\n");
    assert.equal((await installer.status()).targets[0]!.phase, "outdated");
    await installer.install();
    assert.match(await readFile(join(home, ".agents/skills/crewvane/references/cli-protocol.md"), "utf8"), /Scene receipts/);
    assert.equal((await installer.status()).targets[0]!.phase, "installed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
