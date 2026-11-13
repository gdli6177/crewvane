import { createHash, randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  Goal,
  GoalSkillBinding,
  GoalSkillResolution,
  LocalSkillRole,
  SkillPackManifest,
  SkillPackScript,
  SkillPackView,
  SkillRole,
} from "./types.js";

const MAX_FILES = 100;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SKILL_CHARACTERS = 12_000;
const MAX_REFERENCE_FILE_CHARACTERS = 12_000;
const MAX_RESOLVED_REFERENCE_CHARACTERS = 24_000;
const MAX_TEXT_FIELD = 2_000;
const INSTALL_METADATA = ".crewvane-install.json";

const coreConstraints = `Crewvane Core 约束（不可被能力包覆盖）：
- 只处理当前目标；目标之间不得串用上下文、成果或负责人现场。
- 只有 Crewvane CLI 的显式语义命令能改变业务状态；终端空闲、Skill 回复和脚本输出都不能推断完成、验收、失败或等待外部。
- waiting 只用于具名外部第三方；需要人决定、确认、补充信息或操作时使用注意力。
- 实际交付必须有真实证据；完成、验收、发布和权限边界继续遵守 Crewvane 当前协议。
- 工具参数、工具输出、凭据和无关工作区内容不得写入目标记录。`;

const builtinDefinitions: Array<{
  id: string;
  name: string;
  description: string;
  kind: "role" | "process" | "setup";
  roles: SkillRole[];
  content: string;
}> = [
  {
    id: "crewvane.concierge",
    name: "全局管家",
    description: "当前唯一案卷的协调、分发、核对和向人交接。",
    kind: "role",
    roles: ["concierge"],
    content: `你是 Crewvane 的控制面管家。用户只需要一个入口，每次通知只处理一个明确案卷。
- 只负责分发、协调、核对和交接；任何实际执行都交给独立负责人。
- 首次派发优先使用 crewvane owner launch；已有负责人复用原现场。
- owner launch 已自动发送首次任务；receipt 为 accepted 或 started 后，不再用 owner send 重复或追加同一任务。owner send 用于之后收到的真实新要求。
- 确认负责人启动后，记录一次协调结果即结束。dispatch 与 backendHandoff 的传输状态由应用核对，不轮询等待其变化，不因 pending 重复派发。
- 用户直接发来的新事项先用 direct --new 保存；已有目标的新补充先用 direct --goal 保存。
- 阅读 crewvane skill list --json。目标确实匹配某个本地方法时，用 crewvane skill attach GOAL_ID PACK_ID 挂载；说明型方法可由你直接挂载，运行脚本仍需单独授权。
- 只在明确事实发生后使用 progress、wait、decide、review 等语义命令。普通回复、idle、done 和脚本成功都不是业务完成。
- 结束、批准或验收必须保留用户明确原话，并遵守自主目标和人工验收规则。
- 同一工作区只处理一个案卷；处理完立即结束回合，不等待负责人整项工程完成。`,
  },
  {
    id: "crewvane.owner",
    name: "目标负责人",
    description: "在独立现场完成当前目标、计划执行、验证和结构化回写。",
    kind: "role",
    roles: ["owner"],
    content: `你是当前 Crewvane 目标的唯一独立负责人。
- 先制定可执行计划，再开始修改；只使用当前目标和项目规则相关的上下文。
- 用户在本现场的新要求先通过 crewvane direct 保存，再继续工作。
- 实际运行检查后才提交成果；不得把打算、推测或终端空闲当作完成。
- 已识别的咨询答案和阶段进展使用 goal progress 写回完整内容。
- 只有等待具名外部第三方时用 goal wait；等待用户处理、决定或确认时用 goal decide。
- 每回合结束前给出结构化结果、证据和下一步。`,
  },
  {
    id: "crewvane.verifier",
    name: "独立复核者",
    description: "独立检查真实交付、候选版本与完成条件，不负责实现。",
    kind: "role",
    roles: ["verifier"],
    content: `你是当前目标的独立复核者，不是实现者，也不代表用户最终验收。
- 独立读取委托摘要、候选版本和证据，并运行必要的真实检查。
- 每项必选条件必须引用可核对证据，失败就明确失败。
- 不复用负责人现场，不采信只有文字声明而没有证据的结论。
- 通过或失败都通过 crewvane goal verify 写回，然后结束。`,
  },
  {
    id: "crewvane.process.delivery",
    name: "标准交付",
    description: "默认交付流程：先理解和计划，再执行、验证并提交证据。",
    kind: "process",
    roles: ["owner", "verifier"],
    content: `标准交付流程：
1. 明确结果、范围、约束、风险和完成条件；缺少关键依据时只问一个最具体的问题。
2. 先写实施计划，再按可验证步骤执行。
3. 运行与交付直接相关的真实检查，保留命令、结果和位置。
4. 提交成果前复核目标原文、最新用户消息和未完成条件。
5. 只提交实际观察到的证据；未验证部分明确列为限制。`,
  },
  {
    id: "crewvane.process.discovery",
    name: "探索研究",
    description: "默认探索流程：先证据后结论，区分事实、推断与建议。",
    kind: "process",
    roles: ["owner", "verifier"],
    content: `探索研究流程：
1. 先列出要回答的问题、信息源和停止条件。
2. 优先使用一手资料和可复现实验，记录来源、时间与反例。
3. 区分已观察事实、推断和待决定事项。
4. 交付候选方案时同时给出依据、风险、替代方案和推荐理由。
5. 不把研究结论当成产品方向或外部动作授权。`,
  },
  {
    id: "crewvane.process.release",
    name: "发布检查",
    description: "发布目标默认流程：候选版本、环境、批准、执行和真实结果绑定。",
    kind: "process",
    roles: ["owner", "verifier"],
    content: `发布检查流程：
1. 先确认候选版本、目标环境、变更范围和回滚方式。
2. 发布前真实执行构建、安装或部署检查，并记录候选 revision / digest。
3. 生产发布必须由人逐次批准；候选变化会使旧批准失效。
4. 执行后核对真实下载物、服务状态或运行结果，不把命令退出码单独当作发布成功。
5. 保留失败结果、恢复动作和仍未确认的风险。`,
  },
  {
    id: "crewvane.agent-setup",
    name: "Agent 接入",
    description: "发现本机 Agent CLI、启动命令和官方 Hook / Extension 能力。",
    kind: "setup",
    roles: ["concierge"],
    content: `Agent 接入流程：只检测本机实际存在的 CLI；启动命令原样保留可执行文件、参数和模型；不借用某个 Agent 的专属沙箱参数。优先使用官方 Hook / Extension，无法确认时回退当前会话后端与巡检。`,
  },
  {
    id: "crewvane.herdr-recovery",
    name: "工作现场恢复",
    description: "启动未确认时核对当前后端的原请求与身份，避免重复派发。",
    kind: "setup",
    roles: ["concierge"],
    content: `当 owner launch 无法确认环境注入或投递时：
1. 读取当前目标的 scene、sceneLaunch 与 backendHandoff，核对当前 backend、epoch 与原请求；不重复发送业务任务。
2. 使用 crewvane owner launch 核对原启动意图；它只重发现原请求，不自动重复创建。已有负责人用 owner send，不手工调用后端来绕过身份或送达检查。
3. Herdr 的旧现场只有经过真实进程核实才能 owner attach；Orca 没有此手工认领入口。不要把屏幕标题或输出当成握手。
4. 无法核实就保留未确认状态并说明具体恢复操作，不手工编辑 state.json。`,
  },
];

export interface ResolvedSkillContext {
  text: string;
  packs: SkillPackView[];
  resolution: Omit<GoalSkillResolution, "id" | "resolvedAt">;
}

interface StoredInstallMetadata {
  schemaVersion: 1;
  installedAt: string;
  sourcePath: string;
  disabledAt?: string;
  approvals: Record<string, string>;
}

interface LoadedLocalPack {
  directory: string;
  manifest: SkillPackManifest;
  digest: string;
  entryText: string;
  references: Array<{ path: string; content: string }>;
  files: string[];
  totalBytes: number;
}

export class SkillRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRegistryError";
  }
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value: unknown, label: string, limit = MAX_TEXT_FIELD) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    throw new SkillRegistryError(`${label}无效`);
  return value.trim();
}

function safeRelativePath(value: unknown, label: string) {
  const path = cleanText(value, label, 500).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    path.startsWith("../") ||
    path.includes("/../") ||
    path === ".." ||
    path.includes("\0")
  )
    throw new SkillRegistryError(`${label}必须位于能力包目录内`);
  return path;
}

function validPackId(value: unknown) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(value) || value.length > 100)
    throw new SkillRegistryError("能力包 ID 必须使用小写字母、数字、点、下划线或短横线");
  return value;
}

function validVersion(value: unknown) {
  const version = cleanText(value, "能力包版本", 80);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new SkillRegistryError("能力包版本必须使用 semver，例如 1.0.0");
  return version;
}

function semverParts(value: string) {
  return value.split("-")[0]!.split(".").map(part => Number(part));
}

export function versionAtLeast(actual: string, minimum: string) {
  const left = semverParts(actual), right = semverParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

function localRoles(value: unknown): LocalSkillRole[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2)
    throw new SkillRegistryError("本地能力包至少选择一个适用角色");
  const roles = [...new Set(value.map(role => {
    if (role !== "owner" && role !== "verifier")
      throw new SkillRegistryError("本地能力包只能声明 owner 或 verifier 角色");
    return role;
  }))];
  return roles;
}

function scriptEntries(value: unknown): SkillPackScript[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20)
    throw new SkillRegistryError("能力包脚本列表无效，最多 20 个");
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new SkillRegistryError(`第 ${index + 1} 个脚本无效`);
    const raw = item as Partial<SkillPackScript>,
      id = cleanText(raw.id, "脚本 ID", 80),
      path = safeRelativePath(raw.path, "脚本路径"),
      digest = cleanText(raw.sha256, "脚本 SHA-256", 64).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || seen.has(id))
      throw new SkillRegistryError("脚本 ID 必须唯一并使用小写字母、数字、下划线或短横线");
    if (!path.startsWith("scripts/"))
      throw new SkillRegistryError("脚本必须放在 scripts/ 目录");
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new SkillRegistryError(`脚本 ${id} 的 SHA-256 无效`);
    seen.add(id);
    return {
      id,
      path,
      sha256: digest,
      description: cleanText(raw.description, `脚本 ${id} 的用途`, 500),
    };
  });
}

export function parseSkillManifest(
  value: unknown,
  currentVersion = "0.11.0",
): SkillPackManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SkillRegistryError("manifest.json 必须是对象");
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1)
    throw new SkillRegistryError("仅支持 schemaVersion: 1");
  const id = validPackId(raw.id);
  if (id.startsWith("crewvane."))
    throw new SkillRegistryError("crewvane. 前缀保留给内置能力包");
  const minimumCrewvane = validVersion(raw.minimumCrewvane);
  if (!versionAtLeast(currentVersion, minimumCrewvane))
    throw new SkillRegistryError(`该能力包需要 Crewvane ${minimumCrewvane} 或更高版本`);
  if (raw.kind !== "process")
    throw new SkillRegistryError("本地能力包类型只能是 process");
  const references = raw.references === undefined
    ? []
    : Array.isArray(raw.references)
      ? raw.references.map(path => safeRelativePath(path, "引用文件路径"))
      : (() => { throw new SkillRegistryError("references 必须是数组"); })();
  if (references.length > 50 || new Set(references).size !== references.length)
    throw new SkillRegistryError("引用文件最多 50 个且不能重复");
  return {
    schemaVersion: 1,
    id,
    name: cleanText(raw.name, "能力包名称", 120),
    description: cleanText(raw.description, "能力包用途", 600),
    version: validVersion(raw.version),
    minimumCrewvane,
    kind: "process",
    roles: localRoles(raw.roles),
    entry: safeRelativePath(raw.entry ?? "SKILL.md", "入口文件"),
    ...(references.length ? { references } : {}),
    ...(raw.scripts === undefined ? {} : { scripts: scriptEntries(raw.scripts) }),
  };
}

async function collectFiles(root: string) {
  const files: string[] = [];
  let totalBytes = 0;
  async function visit(directory: string, prefix: string) {
    for (const entry of (await readdir(directory)).sort((a, b) => a.localeCompare(b))) {
      const absolute = join(directory, entry),
        relativePath = prefix ? `${prefix}/${entry}` : entry,
        info = await lstat(absolute);
      if (info.isSymbolicLink())
        throw new SkillRegistryError(`能力包不能包含符号链接：${relativePath}`);
      if (info.isDirectory()) {
        await visit(absolute, relativePath);
      } else if (info.isFile()) {
        // Install metadata belongs to this workspace and must not change the
        // method's content digest when the same source is reinstalled.
        if (relativePath === INSTALL_METADATA) continue;
        if (files.length >= MAX_FILES)
          throw new SkillRegistryError(`能力包最多包含 ${MAX_FILES} 个文件`);
        totalBytes += info.size;
        if (totalBytes > MAX_BYTES)
          throw new SkillRegistryError("能力包不能超过 5 MB");
        files.push(relativePath);
      } else {
        throw new SkillRegistryError(`能力包包含不支持的文件类型：${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return { files, totalBytes };
}

async function directoryDigest(directory: string, files: string[]) {
  const hash = createHash("sha256");
  for (const path of files) {
    hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
  }
  return hash.digest("hex");
}

async function loadLocalPack(directory: string, currentVersion = "0.11.0"): Promise<LoadedLocalPack> {
  const owner = await resolve(directory);
  if (!(await stat(owner)).isDirectory())
    throw new SkillRegistryError("能力包路径必须是目录");
  const { files, totalBytes } = await collectFiles(owner);
  if (!files.includes("manifest.json"))
    throw new SkillRegistryError("能力包缺少 manifest.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(owner, "manifest.json"), "utf8"));
  } catch (error) {
    throw new SkillRegistryError(`manifest.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  const manifest = parseSkillManifest(parsed, currentVersion);
  for (const required of [
    "manifest.json",
    manifest.entry,
    ...(manifest.references ?? []),
    ...(manifest.scripts ?? []).map(script => script.path),
  ]) {
    if (!files.includes(required))
      throw new SkillRegistryError(`能力包缺少声明文件：${required}`);
  }
  const entryText = await readFile(join(owner, manifest.entry), "utf8");
  if (entryText.length > MAX_SKILL_CHARACTERS)
    throw new SkillRegistryError(`入口说明不能超过 ${MAX_SKILL_CHARACTERS} 字符`);
  const references: Array<{ path: string; content: string }> = [];
  let referenceCharacters = 0;
  for (const path of manifest.references ?? []) {
    const bytes = await readFile(join(owner, path));
    if (bytes.includes(0))
      throw new SkillRegistryError(`引用文件必须是文本：${path}`);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SkillRegistryError(`引用文件必须是 UTF-8 文本：${path}`);
    }
    const characters = Array.from(content).length;
    if (characters > MAX_REFERENCE_FILE_CHARACTERS)
      throw new SkillRegistryError(
        `引用文件 ${path} 不能超过 ${MAX_REFERENCE_FILE_CHARACTERS} 字符`,
      );
    referenceCharacters += characters;
    if (referenceCharacters > MAX_RESOLVED_REFERENCE_CHARACTERS)
      throw new SkillRegistryError(
        `能力包引用内容合计不能超过 ${MAX_RESOLVED_REFERENCE_CHARACTERS} 字符`,
      );
    references.push({ path, content });
  }
  for (const script of manifest.scripts ?? []) {
    const digest = sha256(await readFile(join(owner, script.path)));
    if (digest !== script.sha256)
      throw new SkillRegistryError(`脚本 ${script.id} 的 SHA-256 与 manifest 不一致`);
  }
  return {
    directory: owner,
    manifest,
    digest: await directoryDigest(owner, files),
    entryText,
    references,
    files,
    totalBytes,
  };
}

function builtinView(definition: (typeof builtinDefinitions)[number], version: string): SkillPackView & { content: string } {
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    version,
    kind: definition.kind,
    roles: definition.roles,
    source: "builtin",
    digest: sha256(definition.content),
    status: "builtin",
    entry: "SKILL.md",
    referenceCount: 0,
    scripts: [],
    content: definition.content,
  };
}

function publicBuiltinView(value: SkillPackView & { content: string }): SkillPackView {
  const { content: _content, ...view } = value;
  return view;
}

function validateStoredMetadata(value: unknown): StoredInstallMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SkillRegistryError("安装元数据无效");
  const raw = value as Partial<StoredInstallMetadata>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.installedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.installedAt)) ||
    typeof raw.sourcePath !== "string" ||
    !raw.approvals ||
    typeof raw.approvals !== "object" ||
    Array.isArray(raw.approvals)
  )
    throw new SkillRegistryError("安装元数据无效");
  return raw as StoredInstallMetadata;
}

export class SkillRegistry {
  constructor(
    readonly root: string,
    readonly currentVersion = "0.11.0",
  ) {}

  get installedRoot() {
    return join(this.root, ".crewvane", "skills");
  }

  builtins() {
    return builtinDefinitions.map(definition =>
      publicBuiltinView(builtinView(definition, this.currentVersion)));
  }

  private async readInstalled(): Promise<SkillPackView[]> {
    let entries;
    try {
      entries = await readdir(this.installedRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const packs: SkillPackView[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const directory = join(this.installedRoot, entry.name);
      try {
        const loaded = await loadLocalPack(directory, this.currentVersion),
          metadata = validateStoredMetadata(JSON.parse(await readFile(join(directory, INSTALL_METADATA), "utf8"))),
          approvals = metadata.approvals;
        const scripts = (loaded.manifest.scripts ?? []).map(script => {
          const approvedDigest = approvals[script.id];
          return {
            ...script,
            approved: approvedDigest === script.sha256,
            ...(approvedDigest && approvedDigest !== script.sha256 ? { approvalInvalidated: true } : {}),
          };
        });
        packs.push({
          id: loaded.manifest.id,
          name: loaded.manifest.name,
          description: loaded.manifest.description,
          version: loaded.manifest.version,
          kind: loaded.manifest.kind,
          roles: loaded.manifest.roles,
          source: "local",
          digest: loaded.digest,
          status: metadata.disabledAt
            ? "disabled"
            : scripts.some(script => !script.approved)
              ? "needs-approval"
              : "ready",
          entry: loaded.manifest.entry,
          referenceCount: loaded.manifest.references?.length ?? 0,
          scripts,
          installedAt: metadata.installedAt,
          ...(metadata.disabledAt ? { disabledAt: metadata.disabledAt } : {}),
        });
      } catch (error) {
        packs.push({
          id: entry.name,
          name: entry.name,
          description: "",
          version: "0.0.0",
          kind: "process",
          roles: ["owner"],
          source: "local",
          digest: "",
          status: "missing",
          entry: "SKILL.md",
          referenceCount: 0,
          scripts: [],
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return packs;
  }

  async list() {
    return [...this.builtins(), ...(await this.readInstalled())];
  }

  async show(packId: string) {
    const found = (await this.list()).find(pack => pack.id === packId);
    if (!found) throw new SkillRegistryError(`找不到能力包：${packId}`);
    const definition = builtinDefinitions.find(item => item.id === packId);
    return definition
      ? { ...found, content: definition.content }
      : found;
  }

  async validate(source: string) {
    const loaded = await loadLocalPack(source, this.currentVersion);
    return {
      manifest: loaded.manifest,
      digest: loaded.digest,
      files: loaded.files,
      totalBytes: loaded.totalBytes,
      entryPreview: loaded.entryText.slice(0, 600),
      references: loaded.references.map(reference => ({
        path: reference.path,
        content: reference.content,
        characters: Array.from(reference.content).length,
      })),
    };
  }

  async install(
    source: string,
    options: { approveScripts?: string[] } = {},
  ) {
    const loaded = await loadLocalPack(source, this.currentVersion),
      approvals: Record<string, string> = {},
      requested = new Set(options.approveScripts ?? []);
    for (const id of requested) {
      if (!(loaded.manifest.scripts ?? []).some(script => script.id === id))
        throw new SkillRegistryError(`能力包没有声明脚本 ${id}`);
    }
    for (const script of loaded.manifest.scripts ?? []) {
      if (requested.has(script.id)) approvals[script.id] = script.sha256;
    }
    const target = join(this.installedRoot, loaded.manifest.id),
      staging = join(this.installedRoot, `.staging-${randomUUID()}`),
      backup = `${target}.backup-${randomUUID()}`;
    await mkdir(this.installedRoot, { recursive: true, mode: 0o700 });
    try {
      await cp(loaded.directory, staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: path => basename(path) !== INSTALL_METADATA,
      });
      await writeFile(join(staging, INSTALL_METADATA), `${JSON.stringify({
        schemaVersion: 1,
        installedAt: new Date().toISOString(),
        sourcePath: loaded.directory,
        approvals,
      } satisfies StoredInstallMetadata, null, 2)}\n`, { mode: 0o600 });
      let replaced = false;
      try {
        await lstat(target);
        await rename(target, backup);
        replaced = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(staging, target);
        if (replaced) await rm(backup, { recursive: true, force: true });
      } catch (error) {
        if (replaced) await rename(backup, target).catch(() => {});
        throw error;
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return this.show(loaded.manifest.id);
  }

  async approveScripts(packId: string, scriptIds: string[]) {
    const directory = join(this.installedRoot, validPackId(packId)),
      loaded = await loadLocalPack(directory, this.currentVersion),
      metadataPath = join(directory, INSTALL_METADATA),
      metadata = validateStoredMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
    for (const id of scriptIds) {
      const script = (loaded.manifest.scripts ?? []).find(item => item.id === id);
      if (!script) throw new SkillRegistryError(`能力包没有声明脚本 ${id}`);
      metadata.approvals[id] = script.sha256;
    }
    const temporary = `${metadataPath}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, metadataPath);
    return this.show(packId);
  }

  async disable(packId: string, disabled = true) {
    const directory = join(this.installedRoot, validPackId(packId)),
      metadataPath = join(directory, INSTALL_METADATA),
      metadata = validateStoredMetadata(JSON.parse(await readFile(metadataPath, "utf8")));
    if (disabled) metadata.disabledAt = new Date().toISOString();
    else delete metadata.disabledAt;
    const temporary = `${metadataPath}.${process.pid}-${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, metadataPath);
    return this.show(packId);
  }

  async remove(packId: string) {
    const directory = join(this.installedRoot, validPackId(packId));
    try {
      await access(directory);
    } catch {
      throw new SkillRegistryError(`找不到本地能力包：${packId}`);
    }
    await rm(directory, { recursive: true, force: true });
  }

  async binding(packId: string): Promise<GoalSkillBinding & { view: SkillPackView }> {
    const view = await this.show(packId);
    if (view.source !== "local")
      throw new SkillRegistryError("内置能力包由 Crewvane 自动解析，不需要挂载");
    if (view.status === "disabled" || view.status === "missing")
      throw new SkillRegistryError(`能力包当前不可用：${view.status}`);
    return {
      packId: view.id,
      version: view.version,
      digest: view.digest,
      roles: view.roles.filter((role): role is LocalSkillRole => role !== "concierge"),
      attachedAt: new Date().toISOString(),
      attachedBy: "human",
      view,
    };
  }

  async resolve(goal: Goal, role: SkillRole, attemptId?: string): Promise<ResolvedSkillContext> {
    const builtins = this.builtins(),
      rolePack = builtins.find(pack => pack.kind === "role" && pack.roles.includes(role)),
      roleDefinition = rolePack
        ? builtinDefinitions.find(definition => definition.id === rolePack.id)
        : undefined,
      processId = goal.kind === "discovery"
        ? "crewvane.process.discovery"
        : goal.kind === "release"
          ? "crewvane.process.release"
          : "crewvane.process.delivery",
      processPack = builtins.find(pack => pack.id === processId),
      processDefinition = processPack?.roles.includes(role)
        ? builtinDefinitions.find(definition => definition.id === processPack.id)
        : undefined,
      setupPacks = builtins.filter(pack =>
        pack.kind === "setup" && pack.roles.includes(role)),
      localViews = await this.readInstalled(),
      selected: Array<SkillPackView & { content: string }> = [];
    if (rolePack && roleDefinition)
      selected.push({ ...rolePack, content: roleDefinition.content });
    if (processPack && processDefinition)
      selected.push({ ...processPack, content: processDefinition.content });
    for (const pack of setupPacks) {
      const definition = builtinDefinitions.find(item => item.id === pack.id);
      if (definition) selected.push({ ...pack, content: definition.content });
    }
    for (const binding of [...(goal.skills ?? [])].sort((a, b) => a.packId.localeCompare(b.packId))) {
      if (!binding.roles.includes(role as LocalSkillRole)) continue;
      const view = localViews.find(pack => pack.id === binding.packId);
      if (!view || view.status === "missing")
        throw new SkillRegistryError(`目标引用的本地能力包 ${binding.packId} 缺失；请重新安装或从目标移除`);
      if (view.status === "disabled")
        throw new SkillRegistryError(`目标引用的本地能力包 ${binding.packId} 已停用；请启用或从目标移除`);
      if (view.digest !== binding.digest)
        throw new SkillRegistryError(`本地能力包 ${binding.packId} 已变化；重新挂载后才能启动负责人`);
      const loaded = await loadLocalPack(join(this.installedRoot, binding.packId), this.currentVersion);
      selected.push({
        ...view,
        content: [
          loaded.entryText.trim(),
          ...loaded.references.map(reference =>
            `\n### 参考：${reference.path}\n${reference.content.trim()}`),
        ].join("\n"),
      });
    }
    const parts = [
      coreConstraints,
      ...selected.map(pack => `\n## ${pack.name} (${pack.id}@${pack.version})\n${pack.content.trim()}`),
    ];
    const packs = selected.map(({ content, ...view }) => view),
      digest = sha256(parts.join("\n"));
    return {
      text: parts.join("\n"),
      packs,
      resolution: {
        role,
        ...(attemptId ? { attemptId } : {}),
        digest,
        packs: packs.map(pack => ({
          id: pack.id,
          version: pack.version,
          digest: pack.digest,
          source: pack.source,
          roles: pack.roles,
        })),
      },
    };
  }

  async scriptForGoal(goal: Goal, packId: string, scriptId: string) {
    const binding = (goal.skills ?? []).find(item => item.packId === packId);
    if (!binding) throw new SkillRegistryError("该脚本所属能力包未挂载到当前目标");
    const view = await this.show(packId);
    if (view.source !== "local" || view.status === "missing" || view.status === "disabled")
      throw new SkillRegistryError("当前能力包不可运行");
    if (view.digest !== binding.digest)
      throw new SkillRegistryError("能力包内容已变化，请重新挂载并授权");
    const script = view.scripts.find(item => item.id === scriptId);
    if (!script) throw new SkillRegistryError(`能力包没有脚本 ${scriptId}`);
    if (!script.approved) throw new SkillRegistryError(`脚本 ${scriptId} 尚未获得当前内容的脚本授权`);
    const directory = join(this.installedRoot, packId),
      path = resolve(directory, script.path),
      pathWithinPack = relative(directory, path);
    if (pathWithinPack.startsWith("..") || isAbsolute(pathWithinPack) || !(await stat(path)).isFile())
      throw new SkillRegistryError("脚本路径无效");
    return { ...script, path, cwd: this.root };
  }
}

export const crewvaneCoreConstraints = coreConstraints;
