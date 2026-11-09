import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const marker = ".crewvane-managed.json";
const managedBy = "crewvane";

export type SkillTargetPhase =
  | "installed"
  | "outdated"
  | "not-installed"
  | "conflict";

export interface SkillTargetStatus {
  id: "agents" | "codex" | "claude" | "cursor";
  label: string;
  path: string;
  detected: boolean;
  phase: SkillTargetPhase;
  managedVersion?: string;
}

export interface SkillsStatus {
  version: string;
  targets: SkillTargetStatus[];
  installed: number;
  available: number;
  conflicts: number;
}

export interface SkillsInstallResult {
  status: SkillsStatus;
  errors: { id: SkillTargetStatus["id"]; message: string }[];
}

const targetDefinitions = [
  { id: "agents" as const, label: "通用 Agent Skills", parent: ".agents", always: true },
  { id: "codex" as const, label: "Codex", parent: ".codex", always: false },
  { id: "claude" as const, label: "Claude Code", parent: ".claude", always: false },
  { id: "cursor" as const, label: "Cursor", parent: ".cursor", always: false },
];

async function exists(path: string) {
  return access(path).then(() => true).catch(() => false);
}

async function managedVersion(path: string) {
  try {
    const value = JSON.parse(await readFile(join(path, marker), "utf8")) as {
      managedBy?: unknown;
      version?: unknown;
    };
    return value.managedBy === managedBy && typeof value.version === "string"
      ? value.version
      : undefined;
  } catch {
    return undefined;
  }
}
async function sourceDigest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string) {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === marker) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
    }
  }
  await visit("");
  return hash.digest("hex");
}

export class CrewvaneSkillInstaller {
  constructor(
    readonly sourceDirectory: string,
    readonly homeDirectory: string,
    readonly version: string,
  ) {}

  targetPath(parent: string) {
    return join(this.homeDirectory, parent, "skills", "crewvane");
  }

  async status(): Promise<SkillsStatus> {
    const targets: SkillTargetStatus[] = [];
    const digest = await sourceDigest(this.sourceDirectory);
    for (const target of targetDefinitions) {
      const detected = target.always || await exists(join(this.homeDirectory, target.parent));
      if (!detected) continue;
      const path = this.targetPath(target.parent);
      const present = await exists(path);
      const storedVersion = present ? await managedVersion(path) : undefined;
      const storedDigest = present ? await readFile(join(path, marker), "utf8").then(text => JSON.parse(text).sourceDigest).catch(() => undefined) : undefined;
      const phase: SkillTargetPhase = !present
        ? "not-installed"
        : storedVersion === undefined
          ? "conflict"
          : storedVersion === this.version && storedDigest === digest ? "installed" : "outdated";
      targets.push({
        id: target.id,
        label: target.label,
        path,
        detected,
        phase,
        ...(storedVersion ? { managedVersion: storedVersion } : {}),
      });
    }
    return {
      version: this.version,
      targets,
      installed: targets.filter(target => target.phase === "installed").length,
      available: targets.filter(target => target.phase !== "conflict").length,
      conflicts: targets.filter(target => target.phase === "conflict").length,
    };
  }

  async install(): Promise<SkillsInstallResult> {
    const errors: SkillsInstallResult["errors"] = [];
    const initial = await this.status();
    for (const target of initial.targets) {
      if (target.phase === "conflict") {
        errors.push({
          id: target.id,
          message: `${target.label} 已有同名且非 Crewvane 管理的 skill，已跳过。`,
        });
        continue;
      }
      if (target.phase === "installed") continue;
      try {
        await this.installTarget(target.path);
      } catch (error) {
        errors.push({
          id: target.id,
          message: `${target.label}：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { status: await this.status(), errors };
  }

  private async installTarget(target: string) {
    const parent = join(target, "..");
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, ".crewvane-skill-"));
    try {
      await cp(this.sourceDirectory, staging, { recursive: true });
      await writeFile(
        join(staging, marker),
        `${JSON.stringify({
          managedBy,
          version: this.version,
          sourceDigest: await sourceDigest(this.sourceDirectory),
          installedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        { mode: 0o600 },
      );
      if (await exists(target)) {
        const previousVersion = await managedVersion(target);
        if (previousVersion === undefined)
          throw new Error("同名 skill 不是 Crewvane 安装的，拒绝覆盖");
        await rm(target, { recursive: true, force: true });
      }
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
}
