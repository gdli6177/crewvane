import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SkillRegistry,
  WorkspaceService,
  type Goal,
} from "../src/index.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

async function fixture(prefix = "crewvane-skill-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(root);
  return {
    root,
    service: new WorkspaceService(root),
    registry: new SkillRegistry(root, "0.10.0"),
  };
}

async function createPack(
  root: string,
  options: {
    id?: string;
    roles?: Array<"owner" | "verifier">;
    body?: string;
    script?: string;
    scriptDigest?: string;
    version?: string;
    reference?: boolean;
  } = {},
) {
  const directory = join(root, "source-pack");
  await mkdir(join(directory, "references"), { recursive: true });
  await mkdir(join(directory, "scripts"), { recursive: true });
  const id = options.id ?? "acme.review",
    body = options.body ?? "先检查真实输入，再执行，并用可核对证据完成。",
    version = options.version ?? "1.0.0";
  await writeFile(join(directory, "SKILL.md"), `# 方法\n\n${body}\n`, { mode: 0o600 });
  await writeFile(
    join(directory, "references/checklist.md"),
    "# Checklist\n\n- 核对真实输入与可复现证据。\n",
    { mode: 0o600 },
  );
  let scripts: Array<{
    id: string;
    path: string;
    sha256: string;
    description: string;
  }> = [];
  if (options.script !== undefined) {
    const path = join(directory, "scripts/run.sh");
    await writeFile(path, options.script, { mode: 0o700 });
    await chmod(path, 0o700);
    scripts = [{
      id: "inspect",
      path: "scripts/run.sh",
      sha256: options.scriptDigest ??
        createHash("sha256").update(options.script).digest("hex"),
      description: "读取当前工作区的只读检查结果。",
    }];
  }
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: "发布前评审",
    description: "发布前需要复核真实边界和证据时使用。",
    version,
    minimumCrewvane: "0.10.0",
    kind: "process",
    roles: options.roles ?? ["owner", "verifier"],
    entry: "SKILL.md",
    ...(options.reference === false ? {} : { references: ["references/checklist.md"] }),
    scripts,
  }, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

async function createGoal(service: WorkspaceService, kind: "delivery" | "discovery" = "delivery") {
  return await service.execute({
    type: "goal.create",
    input: {
      title: "应用本地方法",
      description: "验证能力包安装、绑定与启动上下文。",
      projectId: "personal",
      kind,
      mode: "concierge",
    },
  }) as Goal;
}

test("built-in context is private from list output and resolves by role and goal process", async () => {
  const { root, service, registry } = await fixture(),
    source = await createPack(root, { roles: ["owner"] }),
    installed = await registry.install(source),
    goal = await createGoal(service, "discovery");
  await service.execute({
    type: "goal.skill.attach",
    goalId: goal.id,
    packId: installed.id,
    actor: "human",
  });

  const listed = await registry.list();
  assert.equal(JSON.stringify(listed).includes("Crewvane Core 约束"), false);
  assert.equal((await registry.show("crewvane.concierge") as { content?: string }).content?.includes("控制面管家"), true);
  const saved = (await service.read()).goals[0]!,
    owner = await registry.resolve(saved, "owner"),
    verifier = await registry.resolve(saved, "verifier");
  assert.match(owner.text, /全局|目标负责人|当前 Crewvane 目标的唯一独立负责人/);
  assert.match(owner.text, /探索研究流程/);
  assert.match(owner.text, /先检查真实输入/);
  assert.match(owner.text, /参考：references\/checklist\.md/);
  assert.match(owner.text, /核对真实输入与可复现证据/);
  assert.deepEqual(
    owner.packs.map(pack => pack.id),
    ["crewvane.owner", "crewvane.process.discovery", "acme.review"],
  );
  assert.doesNotMatch(verifier.text, /先检查真实输入/);
  assert.deepEqual(
    verifier.packs.map(pack => pack.id),
    ["crewvane.verifier", "crewvane.process.discovery"],
  );

  const concierge = await registry.resolve(saved, "concierge");
  assert.match(concierge.text, /你是 Crewvane 的控制面管家/);
  assert.match(concierge.text, /Agent 接入流程/);
  assert.match(concierge.text, /工作现场恢复/);
  assert.doesNotMatch(concierge.text, /标准交付流程|探索研究流程/);
  assert.deepEqual(
    concierge.packs.map(pack => pack.id),
    ["crewvane.concierge", "crewvane.agent-setup", "crewvane.herdr-recovery"],
  );
  const preview = await registry.validate(source);
  assert.deepEqual(
    preview.references.map(reference => reference.path),
    ["references/checklist.md"],
  );
  assert.match(preview.references[0]!.content, /核对真实输入与可复现证据/);
});

test("install is private, idempotent at the content level, and records resolutions through core", async () => {
  const { root, service, registry } = await fixture(),
    source = await createPack(root),
    first = await registry.install(source),
    second = await registry.install(source),
    goal = await createGoal(service);
  assert.equal(first.digest, second.digest);
  assert.equal(first.source, "local");
  assert.equal(first.status, "ready");

  const attached = await service.execute({
    type: "goal.skill.attach",
    goalId: goal.id,
    packId: first.id,
    actor: "concierge",
  }) as Goal;
  assert.equal(attached.skills?.[0]?.packId, first.id);
  assert.equal(attached.skills?.[0]?.digest, first.digest);
  assert.equal(attached.activities.at(-1)?.kind, "skill");

  const resolution = await registry.resolve(attached, "owner"),
    recorded = await service.execute({
      type: "goal.skill.resolve",
      goalId: goal.id,
      resolution: resolution.resolution,
    });
  assert.match(String((recorded as { id?: string }).id), /^skillres_/);
  const saved = (await service.read()).goals[0]!;
  assert.equal(saved.skillResolutions?.length, 1);
  assert.equal(saved.skillResolutions?.[0]?.digest, resolution.resolution.digest);

  const detached = await service.execute({
    type: "goal.skill.detach",
    goalId: goal.id,
    packId: first.id,
    actor: "human",
  }) as Goal;
  assert.equal(detached.skills, undefined);
});

test("script approval is bound to content, invalidates on upgrade, and never changes goal state", async () => {
  const { root, service, registry } = await fixture(),
    source = await createPack(root, { script: "#!/bin/sh\nprintf inspected\n" }),
    installed = await registry.install(source),
    goal = await createGoal(service);
  assert.equal(installed.status, "needs-approval");
  assert.equal(installed.scripts[0]?.approved, false);
  await service.execute({
    type: "goal.skill.attach",
    goalId: goal.id,
    packId: installed.id,
    actor: "human",
  });
  let saved = (await service.read()).goals[0]!;
  await assert.rejects(
    registry.scriptForGoal(saved, installed.id, "inspect"),
    /尚未获得/,
  );

  const approved = await registry.approveScripts(installed.id, ["inspect"]);
  assert.equal(approved.scripts[0]?.approved, true);
  const allowed = await registry.scriptForGoal(saved, installed.id, "inspect");
  assert.match(allowed.path, /scripts\/run\.sh$/);

  const changedScript = "#!/bin/sh\nprintf changed\n",
    changedSource = await createPack(root, {
      script: changedScript,
      version: "1.0.1",
    }),
    upgraded = await registry.install(changedSource);
  assert.equal(upgraded.status, "needs-approval");
  assert.notEqual(upgraded.digest, installed.digest);
  await assert.rejects(
    registry.scriptForGoal(saved, installed.id, "inspect"),
    /内容已变化/,
  );
  await assert.rejects(
    registry.resolve(saved, "owner"),
    /已变化/,
  );

  saved = await service.execute({
    type: "goal.skill.attach",
    goalId: goal.id,
    packId: upgraded.id,
    actor: "human",
  }) as Goal;
  await assert.rejects(
    registry.scriptForGoal(saved, upgraded.id, "inspect"),
    /尚未获得/,
  );
  await registry.approveScripts(upgraded.id, ["inspect"]);
  assert.equal((await registry.scriptForGoal(saved, upgraded.id, "inspect")).sha256,
    createHash("sha256").update(changedScript).digest("hex"));
  assert.equal((await service.read()).goals[0]?.status, "active");
});

test("manifest validation rejects reserved names, traversal, mismatched scripts, symlinks and oversized packs", async () => {
  const { root, registry } = await fixture(),
    reserved = await createPack(root, { id: "crewvane.custom" });
  await assert.rejects(registry.validate(reserved), /保留/);

  await rm(reserved, { recursive: true, force: true });
  const traversal = await createPack(root);
  const manifestPath = join(traversal, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.references = ["../outside.md"];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(registry.validate(traversal), /目录内/);

  const mismatchRoot = await fixture("crewvane-skill-mismatch-"),
    mismatch = await createPack(mismatchRoot.root, {
      script: "#!/bin/sh\nprintf ok\n",
      scriptDigest: "0".repeat(64),
    });
  await assert.rejects(mismatchRoot.registry.validate(mismatch), /SHA-256/);

  const linkRoot = await fixture("crewvane-skill-link-"),
    linked = await createPack(linkRoot.root);
  await symlink("/tmp/outside", join(linked, "references/outside"));
  await assert.rejects(linkRoot.registry.validate(linked), /符号链接/);

  const binaryRoot = await fixture("crewvane-skill-binary-"),
    binary = await createPack(binaryRoot.root);
  await writeFile(join(binary, "references/checklist.md"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(binaryRoot.registry.validate(binary), /必须是文本/);

  const oversizedRoot = await fixture("crewvane-skill-reference-size-"),
    oversized = await createPack(oversizedRoot.root);
  await writeFile(
    join(oversized, "references/checklist.md"),
    "a".repeat(12_001),
  );
  await assert.rejects(oversizedRoot.registry.validate(oversized), /引用文件.*字符/);

  const largeRoot = await fixture("crewvane-skill-large-"),
    large = await createPack(largeRoot.root);
  await writeFile(join(large, "large.bin"), Buffer.alloc(5 * 1024 * 1024 + 1));
  await assert.rejects(largeRoot.registry.validate(large), /5 MB/);
});

test("disabled and removed packs cannot be newly attached while existing bindings fail closed", async () => {
  const { root, service, registry } = await fixture(),
    source = await createPack(root),
    installed = await registry.install(source),
    goal = await createGoal(service);
  await service.execute({
    type: "goal.skill.attach",
    goalId: goal.id,
    packId: installed.id,
    actor: "human",
  });
  await registry.disable(installed.id, true);
  assert.equal((await registry.show(installed.id)).status, "disabled");
  await assert.rejects(registry.binding(installed.id), /不可用/);
  let saved = (await service.read()).goals[0]!;
  await assert.rejects(registry.resolve(saved, "owner"), /已停用/);
  await registry.disable(installed.id, false);
  await registry.remove(installed.id);
  await assert.rejects(registry.show(installed.id), /找不到能力包/);
  saved = (await service.read()).goals[0]!;
  assert.equal(saved.skills?.length, 1);
});
