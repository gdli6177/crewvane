import {
  WorkspaceService,
  SkillRegistry,
  attentionGoals,
  attentionRequest,
  importAttachmentFiles,
  type CrewvaneCommand,
  type GoalAttachment,
  type HerdrReference,
  type IntakeHandling,
  type HighRiskCategory,
} from "../../packages/core/src/index.js";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { runBoard } from "./board.js";
import { launchOwner } from "./owner-launch.js";
import { attachOwner } from "./owner-attach.js";
import { ingestAgentHook } from "./hook-ingest.js";
const exec = promisify(execFile);
const usage = `Crewvane — 把所有事整理成清晰的下一步

人的消息入口（保存原话，不从文本推断批准或完成）：
  crewvane status [--json]
  crewvane attention [--json]
  crewvane board [--new] [--once]
  crewvane ask TEXT [--project ID] [--attachment PATH ...]
  crewvane capture TEXT [--self] [--project ID] [--remind-at ISO]
    [--attachment PATH ...]（只记录；--self 表示由你执行）
  crewvane goal start ID --by self|concierge
  crewvane goal restore ID（将移出的个人事项恢复到待办池）
  crewvane direct TEXT [--new] [--goal ID] [--project ID]
    [--handling concierge|later|self]（只适用于新事项）
    [--attachment PATH ...]
  crewvane goal list [--all] [--json]
  crewvane goal show ID [--json]
  crewvane goal message ID --text TEXT [--attachment PATH ...]
  crewvane goal scene-reply ID --attention-id ID --quote "用户现场原话"
    --summary "现场已如何处理" [--json]

Agent 状态协议（仅在明确事实发生后使用）：
  crewvane hook ingest --adapter codex|claude-code|cursor|qoder|omp
    （由受管 Agent Hook 调用；普通 Agent 会话无目标环境时 no-op）
  crewvane event herdr [--json]
  crewvane goal create --title TEXT [--project ID] [--description TEXT]
    [--kind delivery|discovery] [--mode concierge|manual]
  crewvane goal kind ID --kind delivery|discovery
  crewvane goal update ID [--title TEXT] [--description TEXT] [--next TEXT]
    [--owner TEXT] [--status active|waiting] [--waiting-for 外部第三方] [--remind-at ISO]
  crewvane goal progress ID --summary TEXT [--next TEXT] [--owner NAME]
  crewvane goal wait ID --reason TEXT --owner 外部第三方 [--remind-at ISO]
  crewvane goal decide ID --question TEXT [--next TEXT] [--key KEY]
  crewvane goal risk ID --category CATEGORY --summary TEXT [--key KEY]
  crewvane goal ship ID --operation merge|deploy --checks passed|failed
  crewvane goal brief ID --file PATH [--expected-revision N]
  crewvane goal checkpoint ID --summary TEXT --next TEXT [--due-at ISO]
  crewvane goal verify ID --delivery ID --outcome passed|failed
    --summary TEXT --criterion ID::passed|failed::EVIDENCE_ID
    [--criterion ... | --criteria-file PATH] [--reviewer NAME]
  crewvane goal boundary ID --file PATH
  crewvane goal review ID --summary TEXT [--location TEXT] [--url URL]
    --check "名称::命令或操作::passed::说明"（可重复）
    [--candidate-revision REV] [--candidate-digest SHA256] [--evidence-file PATH]
  crewvane goal accept ID [--note TEXT]
  crewvane goal complete ID --note "用户明确确认完成的原话"
  crewvane goal rework ID --note TEXT
  crewvane goal resolve ID --note TEXT [--outcome approved|rejected]
  crewvane goal drop ID --reason TEXT
  crewvane goal remind ID --at ISO [--note TEXT]
    状态命令可用 --attention-id ID --scene-reply-id ID 防止旧回执覆盖新问题
  crewvane session set ID [--workspace ID] [--tab ID] [--pane ID] [--agent NAME]
    [--transport pane --process-id PID]（自定义 CLI）
  crewvane owner launch ID --name NAME [--task TEXT | --task-file FILE]
    创建隔离的负责人现场；省略任务内容时读取目标详情与下一步
  crewvane owner attach ID --name NAME --session SESSION
    --workspace ID --tab ID --pane ID [--agent NAME] [--recovery-id ID]
    在核对 Herdr 真实现场后，恢复并绑定 owner launch 未确认的负责人
  crewvane verifier launch ID --name NAME [--task TEXT]
    为待复核交付创建不复用负责人现场的独立复核者

本地工作方法（能力包）：
  crewvane skill list|show [PACK_ID] [--json]
  crewvane skill draft DIRECTORY --id ID --name NAME
    [--description TEXT] [--role owner|verifier ...]
  crewvane skill validate DIRECTORY [--json]
  crewvane skill install DIRECTORY [--approve-script ID ...] [--json]
  crewvane skill approve PACK_ID --approve-script ID [...]
  crewvane skill disable|enable|remove PACK_ID
  crewvane skill attach GOAL_ID PACK_ID [--json]
  crewvane skill detach GOAL_ID PACK_ID [--json]
  crewvane skill resolve GOAL_ID --role concierge|owner|verifier [--json]
  crewvane skill run PACK_ID SCRIPT_ID --goal GOAL_ID [--arg VALUE ...]

人用自主目标与发布协议：
  crewvane autonomy set [--acceptance human-review|auto-with-verification]
    [--paused yes|no] [--max-recovery-attempts N] [--no-progress-minutes N]
    [--initialize]
  crewvane project autonomy PROJECT_ID [--acceptance inherit|human-review|auto-with-verification]
    [--release-on-merge never|production|unknown]
  crewvane goal autonomy pause|resume ID
  crewvane goal autonomy acceptance ID
    --acceptance inherit|human-review|auto-with-verification
  crewvane goal boundary-resolve ID --boundary ID --outcome approved|rejected --note TEXT
  crewvane goal reopen ID --note TEXT
  crewvane release create --from GOAL_ID [--from GOAL_ID ...] --environment production
    --revision REV [--digest SHA256] [--version VERSION]
  crewvane release approve ID --note TEXT
  crewvane release reject ID --note TEXT
  crewvane release result ID --outcome succeeded|failed
    --evidence "真实结果"（可重复）| --evidence-file PATH

本地 Bot 发起方协议：
  crewvane bot call --file ENVELOPE.json
  crewvane bot bind --id ID --name NAME --role initiator
    --project ID（可重复）--operation OPERATION（可重复）--expires-at ISO
  crewvane bot revoke ID

内部续跑调度（应用主进程使用）：
  crewvane autonomy inspect [--at ISO]
  crewvane autonomy claim ID --continuation ID [--at ISO]
  crewvane autonomy report ID --continuation ID --outcome sent|failed|settled
    [--lease LEASE_ID] [--detail TEXT] [--at ISO]

使用 --root DIR 或 CREWVANE_WORKSPACE 指定工作区。所有读写与桌面共用状态。
goal message 与 direct 不按正文推断状态。交给管家处理的外部等待会恢复 active，待管家重新核定；next 保留。
waiting 只表示等待用户和所有 Agent 之外的具名外部第三方。需要用户处理请用 decide；内部协调保持 active。remind 不改变生命周期。
高风险动作类别：delete-data、stop-service、spend-money、external-message、
product-direction、create-secret、rotate-secret、change-permissions、change-ship-policy。
goal ship 只按项目策略给出放行或审批判断；外部动作仍由负责人执行并核实。
`;
function parse(argv: string[]) {
  const positional: string[] = [], values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [name, inline] = token.slice(2).split(/=(.*)/s);
    if (!name) throw new Error("无效参数");
    if (["json", "all", "help", "new", "once", "current", "self", "initialize"].includes(name)) { values.set(name, ["true"]); continue; }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`--${name} 需要一个值`);
    if (values.has(name) && !["check", "attachment", "criterion", "from", "project", "operation", "evidence", "role", "arg", "approve-script"].includes(name)) throw new Error(`--${name} 不能重复`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positional, one: (name: string) => values.get(name)?.[0], all: (name: string) => values.get(name) ?? [], has: (name: string) => values.has(name) };
}
function checks(values: string[]) {
  if (!values.length) throw new Error("至少提供一个 --check，记录实际运行的检查");
  return values.map((value) => {
    const [name, command, result, ...note] = value.split("::");
    if (!name || !command || !["passed", "failed"].includes(result ?? "")) throw new Error("--check 格式：名称::命令或操作::passed|failed::说明");
    return { name, command, result: result as "passed" | "failed", ...(note.length ? { note: note.join("::") } : {}) };
  });
}
async function createSkillDraft(
  directory: string,
  options: { id: string; name: string; description?: string; roles: string[] },
) {
  const root = resolve(directory),
    id = options.id.trim(),
    name = options.name.trim();
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(id) || id.startsWith("crewvane."))
    throw new Error("能力包 ID 必须带命名空间，例如 acme.design-review；crewvane. 前缀保留");
  if (!name || name.length > 120) throw new Error("请输入有效的能力包名称");
  const roles = [...new Set(options.roles.length ? options.roles : ["owner"])];
  if (roles.some(role => role !== "owner" && role !== "verifier"))
    throw new Error("能力包角色只能是 owner 或 verifier");
  const description = options.description?.trim() || "说明这个工作方法何时使用、希望 Agent 如何做。";
  await mkdir(root, { recursive: true });
  for (const file of ["manifest.json", "SKILL.md"]) {
    try {
      await access(join(root, file));
      throw new Error(`草稿目录已包含 ${file}，拒绝覆盖`);
    } catch (error) {
      if (error instanceof Error && /拒绝覆盖/.test(error.message)) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const manifest = {
    schemaVersion: 1,
    id,
    name,
    description,
    version: "1.0.0",
    minimumCrewvane: "0.10.0",
    kind: "process",
    roles,
    entry: "SKILL.md",
    references: [],
    scripts: [],
  };
  const skill = `---
name: ${id}
description: ${JSON.stringify(description.replaceAll("\n", " "))}
---

# ${name}

## 何时使用

${description}

## 执行方法

1. 根据当前目标和用户最新消息补充这里的步骤。
2. 明确要求 Agent 先检查什么、如何执行、如何验证。
3. 只保留可复用的方法，不写入某个目标的隐私信息。

## 完成前检查

- 实际结果已经验证。
- 证据和下一步已经通过 Crewvane CLI 写回。
`;
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(root, "SKILL.md"), skill, { mode: 0o600 });
  return { directory: root, manifest };
}
function textArg(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
}
function currentHerdrReference(agent?: string): HerdrReference | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;
  const session = process.env.HERDR_SESSION?.trim();
  if (!session || !/^[a-zA-Z0-9_-]{1,80}$/.test(session)) return undefined;
  const reference: HerdrReference = {
    session,
    ...(process.env.HERDR_WORKSPACE_ID?.trim()
      ? { workspaceId: process.env.HERDR_WORKSPACE_ID.trim() }
      : {}),
    ...(process.env.HERDR_TAB_ID?.trim()
      ? { tabId: process.env.HERDR_TAB_ID.trim() }
      : {}),
    ...(process.env.HERDR_PANE_ID?.trim()
      ? { paneId: process.env.HERDR_PANE_ID.trim() }
      : {}),
    ...(agent ? { agent } : {}),
  };
  return reference.paneId || reference.tabId ? reference : undefined;
}
async function jsonFile(path: string | undefined, label: string): Promise<unknown> {
  if (!path?.trim()) throw new Error(`需要 ${label} 文件路径`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}
async function verificationCriteria(values: string[], file?: string) {
  if (values.length && file) throw new Error("--criterion 与 --criteria-file 不能同时使用");
  if (file) {
    const parsed = await jsonFile(file, "复核条件");
    if (!Array.isArray(parsed)) throw new Error("复核条件文件必须是数组");
    return parsed;
  }
  if (!values.length) throw new Error("至少提供一个 --criterion");
  return values.map(value => {
    const [criterionId, result, evidenceIds, ...note] = value.split("::");
    if (!criterionId || !["passed", "failed"].includes(result ?? "") || !evidenceIds)
      throw new Error("--criterion 格式：完成条件ID::passed|failed::证据ID[,证据ID]::说明");
    return {
      criterionId: criterionId.trim(),
      result,
      evidenceIds: evidenceIds.split(",").map(id => id.trim()).filter(Boolean),
      ...(note.length ? { note: note.join("::") } : {}),
    };
  });
}
async function coordinatorCaseId(allowMissing = false) {
  if (process.env.CREWVANE_COORDINATOR !== "1") return;
  const file = process.env.CREWVANE_COORDINATOR_SCOPE_FILE;
  if (!file) throw new Error("管家缺少当前案卷范围，请重新准备管家");
  const raw = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return;
    if (error.code === "ENOENT")
      throw new Error("管家当前没有案卷范围；只有 crewvane direct --new 可以直接建立新目标");
    throw error;
  });
  if (!raw) return;
  const value = JSON.parse(raw) as { goalId?: unknown };
  if (typeof value.goalId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.goalId))
    throw new Error("管家当前案卷范围无效，请重新准备管家");
  const context = value as { goalId: string; attentionId?: string; sceneReplyId?: string };
  for (const token of [context.attentionId, context.sceneReplyId])
    if (token !== undefined && (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(token)))
      throw new Error("管家现场回执范围无效，请重新派发");
  return context;
}
async function advanceCoordinatorCase(goal: { id: string; dispatch?: { id?: string } }) {
  const file = process.env.CREWVANE_COORDINATOR_SCOPE_FILE;
  if (!file) throw new Error("管家缺少案卷范围文件，无法继续直接新建的目标");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    goalId: goal.id,
    requestId: goal.dispatch?.id,
    setAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
function assertCoordinatorCase(caseId: string, target: string | undefined) {
  if (!target) throw new Error("管家操作必须指定当前案卷目标 ID");
  if (target !== caseId) throw new Error(`管家当前只处理目标 ${caseId}，不能读取或修改其他目标`);
}
function herdrLiveEvent() {
  const raw = process.env.HERDR_PLUGIN_EVENT_JSON;
  if (!raw) throw new Error("缺少 Herdr 插件事件");
  let value: any;
  try { value = JSON.parse(raw); }
  catch { throw new Error("Herdr 插件事件不是有效 JSON"); }
  const data = value?.data;
  if (!data || typeof data !== "object") throw new Error("Herdr 插件事件缺少 data");
  const rawKind = String(value.event ?? value.type ?? "").trim();
  const legacyKinds: Record<string, string> = {
    pane_agent_status_changed: "pane.agent_status_changed",
    pane_exited: "pane.exited",
    pane_closed: "pane.closed",
    pane_moved: "pane.moved",
    tab_closed: "tab.closed",
    workspace_closed: "workspace.closed",
  };
  const kind = legacyKinds[rawKind] ?? rawKind;
  const targetId = (name: "pane" | "tab" | "workspace") => {
    const id = data[`${name}_id`];
    if (typeof id !== "string" || !id)
      throw new Error(`Herdr 插件事件缺少有效 ${name === "pane" ? "Pane" : name === "tab" ? "Tab" : "Workspace"} ID`);
    return id;
  };
  const paneId = typeof data.pane_id === "string" ? data.pane_id : "";
  const workspaceId = typeof data.workspace_id === "string" ? data.workspace_id : undefined;
  const checkedAt = new Date().toISOString();
  if (kind === "pane.agent_status_changed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    const state = typeof data.agent_status === "string" ? data.agent_status.toLowerCase() : "";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(state))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    const agentName = typeof data.agent_name === "string" ? data.agent_name : undefined;
    return {
      kind,
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      ...(agentName ? { reference: { paneId, ...(workspaceId ? { workspaceId } : {}), agent: agentName } } : {}),
      presence: { state: state as "working" | "idle" | "done" | "blocked" | "unknown", checkedAt, reachable: true },
    };
  }
  if (kind === "pane.exited" || kind === "pane.closed") {
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(paneId))
      throw new Error("Herdr 插件事件缺少有效 Pane ID");
    return {
      kind,
      target: { paneId, ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  }
  if (kind === "pane.moved") {
    const previousPaneId = typeof data.previous_pane_id === "string" ? data.previous_pane_id : "";
    const previousWorkspaceId = typeof data.previous_workspace_id === "string" ? data.previous_workspace_id : undefined;
    const pane = data.pane;
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(previousPaneId) ||
      !pane || typeof pane !== "object")
      throw new Error("Herdr 插件事件缺少有效的 Pane 移动信息");
    const newPaneId = typeof pane.pane_id === "string" ? pane.pane_id : "";
    if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(newPaneId))
      throw new Error("Herdr 插件事件缺少有效的新 Pane ID");
    const status = typeof pane.agent_status === "string" ? pane.agent_status.toLowerCase() : "unknown";
    if (!["working", "idle", "done", "blocked", "unknown"].includes(status))
      throw new Error("Herdr 插件事件包含无效 Agent 状态");
    return {
      kind,
      target: { paneId: previousPaneId, ...(previousWorkspaceId ? { workspaceId: previousWorkspaceId } : {}) },
      reference: {
        paneId: newPaneId,
        ...(typeof pane.workspace_id === "string" ? { workspaceId: pane.workspace_id } : {}),
        ...(typeof pane.tab_id === "string" ? { tabId: pane.tab_id } : {}),
        ...(typeof pane.agent === "string" ? { agent: pane.agent } : {}),
      },
      presence: {
        state: status as "working" | "idle" | "done" | "blocked" | "unknown",
        checkedAt, reachable: true,
      },
    };
  }
  if (kind === "tab.closed")
    return {
      kind,
      target: { tabId: targetId("tab"), ...(workspaceId ? { workspaceId } : {}) },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  if (kind === "workspace.closed")
    return {
      kind,
      target: { workspaceId: targetId("workspace") },
      presence: { state: "unknown" as const, checkedAt, reachable: false },
    };
  throw new Error(`不支持的 Herdr 插件事件：${kind}`);
}
async function currentHerdrAgent(paneId: string) {
  const injected = process.env.CREWVANE_HERDR_PLUGIN_AGENT?.trim();
  if (injected) return injected;
  const session = process.env.HERDR_SESSION?.trim();
  if (!session) return undefined;
  const binary = process.env.CREWVANE_HERDR_BINARY?.trim() ||
    process.env.HERDR_BIN_PATH?.trim() || "herdr";
  try {
    const { stdout } = await exec(binary, ["--session", session, "agent", "list"], {
      timeout: 5_000,
      maxBuffer: 512_000,
    });
    const value = JSON.parse(stdout) as any;
    const list = value.result?.agents ?? value.agents ?? value;
    const entry = Array.isArray(list)
      ? list.find((agent: any) => agent?.pane_id === paneId)
      : undefined;
    const name = entry?.name ?? entry?.agent_name ?? entry?.agent;
    return typeof name === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(name)
      ? name
      : undefined;
  } catch {
    return undefined;
  }
}
export async function run(argv: string[], io = { out: console.log, error: console.error }): Promise<number> {
  try {
    const args = parse(argv), [group, action, target] = args.positional;
    if (args.has("help") || !group) { io.out(usage); return 0; }
    if (group === "hook" && action === "ingest") {
      try {
        await ingestAgentHook({
          adapter: args.one("adapter") ?? "",
          stdin: () => new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            let size = 0;
            process.stdin.on("data", chunk => {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += buffer.length;
              if (size > 512_000) {
                reject(new Error("Hook payload too large"));
                process.stdin.destroy();
                return;
              }
              chunks.push(buffer);
            });
            process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            process.stdin.once("error", reject);
          }),
        });
      } catch {
        // Agent lifecycle observation must never make the Agent turn fail.
      }
      // Agent lifecycle Hooks are observational. Failure is fail-open and
      // must never prevent the Agent from starting, running or stopping.
      return 0;
    }
    const managedAgentName = process.env.CREWVANE_AGENT_NAME?.trim(),
      verifierMode = process.env.CREWVANE_ROLE?.trim() === "verifier",
      verifierGoalId = process.env.CREWVANE_GOAL_ID?.trim(),
      service = new WorkspaceService(args.one("root") ?? (process.env.CREWVANE_WORKSPACE?.trim() || process.cwd())),
      coordinatorMode = process.env.CREWVANE_COORDINATOR === "1",
      coordinatorContext = await coordinatorCaseId(group === "direct" && args.has("new")),
      coordinatorCase = coordinatorContext?.goalId,
      actor = args.one("actor") ?? (managedAgentName || undefined);
    const managedAgent = coordinatorMode || Boolean(managedAgentName);
    const requireHumanCli = () => {
      if (managedAgent)
        throw new Error("该命令只能由人通过桌面或普通终端执行，受管 Agent 不能调用");
    };
    if (verifierMode) {
      if (!managedAgentName)
        throw new Error("独立复核者必须由 Crewvane 启动并登记身份");
      if (!verifierGoalId)
        throw new Error("独立复核者缺少当前复核目标");
      const allowed = group === "status" ||
        (group === "goal" && ["show", "verify"].includes(action ?? ""));
      if (!allowed)
        throw new Error("独立复核者只能查看当前目标或提交复核结果");
      if (group === "goal" && action === "show" &&
        (target ?? args.one("id")) !== verifierGoalId)
        throw new Error("独立复核者只能查看当前复核目标");
      if (group === "goal" && action === "verify" && target !== verifierGoalId)
        throw new Error("独立复核者只能提交当前复核目标的复核结果");
    }
    let command: CrewvaneCommand | undefined, result: unknown, coordinatorRead = false,
      verifierRead = false,
      ownerLaunch: {
        name: string;
        task?: string;
        taskFile?: string;
        role?: "owner" | "verifier";
      } | undefined;
    if (verifierMode && group === "status") {
      const state = await service.read(),
        goal = state.goals.find(item => item.id === verifierGoalId);
      if (!goal) throw new Error("当前复核目标不存在");
      result = {
        name: state.name,
        agents: state.agents ?? { concierge: "codex" },
        project: state.projects.find(project => project.id === goal.projectId),
        goal: {
          id: goal.id,
          title: goal.title,
          kind: goal.kind,
          mode: goal.mode,
          status: goal.status,
          next: goal.next,
          attention: goal.attention ?? null,
        },
      };
      verifierRead = true;
    }
    if (group === "board" && !coordinatorCase) {
      await runBoard(service, io, { once: args.has("once"), startWithNewGoal: args.has("new") });
      return 0;
    }
    if (coordinatorMode && !coordinatorCase) {
      if (group !== "direct" || !args.has("new"))
        throw new Error("管家当前没有案卷范围；只有 crewvane direct --new 可以直接建立新目标");
    } else if (coordinatorCase) {
      if (group === "status") {
        const state = await service.read(), goal = state.goals.find(item => item.id === coordinatorCase);
        if (!goal) throw new Error("当前案卷不存在或已结束");
        result = { name: state.name, agents: state.agents ?? { concierge: "codex" },
          project: state.projects.find(project => project.id === goal.projectId) };
        coordinatorRead = true;
      } else if (group === "goal" && action === "show") {
        const goalId = target ?? args.one("id");
        assertCoordinatorCase(coordinatorCase, goalId);
        result = (await service.read()).goals.find(goal => goal.id === goalId);
        if (!result) throw new Error("找不到当前案卷");
        coordinatorRead = true;
      } else if (group === "goal" && [
        "update", "progress", "wait", "decide", "risk", "ship",
        "brief", "checkpoint", "boundary", "kind",
        "complete", "rework", "drop", "resolve", "remind", "scene-reply",
      ].includes(action ?? "")) {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "session" && action === "set") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "launch") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "attach") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "verifier" && action === "launch") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "skill" && ["list", "show"].includes(action ?? "")) {
        // Available method metadata is read-only and scoped to the current
        // workspace. It does not expose other goals.
      } else if (group === "skill" && ["attach", "detach", "resolve", "run"].includes(action ?? "")) {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "direct") {
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (!args.has("new"))
          assertCoordinatorCase(coordinatorCase, args.one("goal") ?? coordinatorCase);
      } else throw new Error("管家当前只能查看或更新自己的案卷，不能执行该命令");
    }
    if (!coordinatorRead && !verifierRead) {
      if (group === "status") result = await service.read();
      else if (group === "attention") result = attentionGoals((await service.read()).goals);
      else if (group === "ask") {
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = { type: "goal.intake", text: args.positional.slice(1).join(" "), projectId: args.one("project"), ...(attachments.length ? { attachments } : {}) };
      }
      else if (group === "capture") {
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = { type: "goal.intake", text: args.positional.slice(1).join(" "),
          projectId: args.one("project"), handling: args.has("self") ? "self" : "later",
          remindAt: args.one("remind-at"), ...(attachments.length ? { attachments } : {}) };
      }
      else if (group === "direct") {
        const directText = args.positional.slice(1).join(" ").trim();
        if (!directText) throw new Error("需要一个要同步给管家的终端消息");
        if (args.has("next"))
          throw new Error("direct 只同步人的原话，不修改下一步；状态更新请使用明确命令");
        if (args.has("new") && args.one("goal"))
          throw new Error("--new 不能与 --goal 同时使用");
        if (args.has("current") && (args.has("new") || args.one("goal")))
          throw new Error("--current 不能与 --new 或 --goal 同时使用");
        if (args.has("current") && !coordinatorCase)
          throw new Error("--current 只能由当前受管管家使用");
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = {
          type: "goal.direct",
          text: directText,
          goalId: args.has("new") ? undefined
            : args.has("current") ? coordinatorCase : args.one("goal") ?? coordinatorCase,
          projectId: args.one("project"),
          handling: args.one("handling") as IntakeHandling | undefined,
          ...(attachments.length ? { attachments } : {}),
        };
      }
      else if (group === "event" && action === "herdr") {
        const { kind, ...event } = herdrLiveEvent();
        void kind;
        const target = event.target as { paneId?: string; workspaceId?: string };
        if (
          event.presence.reachable !== false &&
          !event.reference?.agent &&
          target.paneId
        ) {
          const agent = await currentHerdrAgent(target.paneId);
          if (agent)
            event.reference = {
              ...(event.reference ?? {}),
              paneId: target.paneId,
              agent,
            };
        }
        result = await service.execute({ type: "live.event", ...event });
      }
      else if (group === "goal" && action === "list") { const state = await service.read(); result = args.has("all") ? state.goals : state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)); }
      else if (group === "goal" && action === "show") { const goalId = target ?? args.one("id"); if (!goalId) throw new Error("需要目标 ID"); result = (await service.read()).goals.find((goal) => goal.id === goalId); if (!result) throw new Error("找不到目标"); }
      else if (group === "goal" && action === "start") {
        const by = args.one("by");
        if (by !== "self" && by !== "concierge") throw new Error("--by 必须是 self 或 concierge");
        command = { type: by === "self" ? "goal.takeover" : "goal.delegate", goalId: target! };
      }
      else if (group === "goal" && action === "restore") command = { type: "goal.restore", goalId: target! };
      else if (group === "goal" && action === "create") {
        if (args.has("workflow")) throw new Error("工序已移除；请在目标说明中直接写清工作要求");
        command = {
          type: "goal.create",
          input: {
            title: args.one("title")!,
            projectId: args.one("project") ?? "personal",
            description: args.one("description"),
            kind: args.one("kind") as "delivery" | "discovery" | undefined,
            mode: (args.one("mode") ?? "concierge") as "concierge" | "manual",
            next: args.one("next"),
            waitingFor: args.one("owner"),
            remindAt: args.one("remind-at"),
          },
        };
      }
      else if (group === "goal" && action === "kind")
        command = {
          type: "goal.kind.set",
          goalId: target!,
          kind: textArg(args.one("kind"), "--kind") as "delivery" | "discovery",
          actor,
        };
      else if (group === "goal" && action === "brief") {
        const brief = await jsonFile(args.one("file"), "委托摘要");
        if (!brief || typeof brief !== "object" || Array.isArray(brief))
          throw new Error("委托摘要文件必须是 JSON 对象");
        command = {
          type: "goal.brief",
          goalId: target!,
          brief: brief as import("../../packages/core/src/index.js").GoalBriefInput,
          expectedRevision: args.one("expected-revision")
            ? Number(args.one("expected-revision"))
            : undefined,
          actor,
        };
      }
      else if (group === "goal" && action === "checkpoint")
        command = {
          type: "goal.checkpoint",
          goalId: target!,
          summary: args.one("summary")!,
          next: args.one("next")!,
          dueAt: args.one("due-at"),
          actor,
        };
      else if (group === "goal" && action === "verify") {
        const explicitReviewer = args.one("reviewer");
        if (managedAgentName && explicitReviewer &&
          explicitReviewer !== managedAgentName)
          throw new Error("受管 Agent 不能用 --reviewer 冒用其他复核人身份");
        const criteria = await verificationCriteria(
          args.all("criterion"),
          args.one("criteria-file"),
        ) as import("../../packages/core/src/index.js").VerificationCriterion[];
        const reviewer = managedAgentName ?? explicitReviewer ?? actor,
          reviewerHerdr = currentHerdrReference(reviewer);
        command = {
          type: "goal.verify",
          goalId: target!,
          deliveryId: args.one("delivery")!,
          outcome: args.one("outcome") as "passed" | "failed",
          summary: args.one("summary")!,
          criteria,
          reviewer,
          ...(reviewerHerdr ? { reviewerHerdr } : {}),
        };
      }
      else if (group === "goal" && action === "boundary") {
        const change = await jsonFile(args.one("file"), "边界变更");
        if (!change || typeof change !== "object" || Array.isArray(change))
          throw new Error("边界变更文件必须是 JSON 对象");
        command = {
          type: "goal.boundary",
          goalId: target!,
          change: change as Extract<
            CrewvaneCommand,
            { type: "goal.boundary" }
          >["change"],
          actor,
        };
      }
      else if (group === "goal" && action === "update") command = { type: "goal.update", goalId: target!, patch: {
        ...(args.has("stage") ? (() => { throw new Error("工序已移除；请直接更新目标下一步"); })() : {}),
        title: args.one("title"), description: args.one("description"), next: args.one("next"),
        owner: args.one("owner"),
        waitingFor: args.one("waiting-for"),
        status: args.one("status") as "active" | "waiting" | undefined,
        remindAt: args.one("remind-at"),
      } };
      else if (group === "goal" && action === "progress") {
        if (args.has("stage")) throw new Error("工序已移除；请直接写清当前实际结果和下一步");
        command = { type: "goal.progress", goalId: target!, summary: args.one("summary")!, next: args.one("next"), actor: actor ?? args.one("owner") };
      }
      else if (group === "goal" && action === "message") {
        const message = textArg(args.one("text"), "--text");
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = {
          type: "goal.message", goalId: target!, text: message,
          ...(attachments.length ? { attachments } : {}),
        };
      }
      else if (group === "goal" && action === "scene-reply") command = {
        type: "goal.scene-reply", goalId: target!,
        attentionId: textArg(args.one("attention-id"), "--attention-id"),
        quote: textArg(args.one("quote"), "--quote"),
        summary: textArg(args.one("summary"), "--summary"),
        actor: textArg(actor, "已登记的 Agent 身份"),
      };
      else if (group === "goal" && action === "wait") command = { type: "goal.wait", goalId: target!, reason: args.one("reason")!, owner: args.one("owner"), remindAt: args.one("remind-at"), actor };
      else if (group === "goal" && action === "decide") command = { type: "goal.decide", goalId: target!, question: args.one("question")!, next: args.one("next"), actor, key: args.one("key") };
      else if (group === "goal" && action === "risk") command = {
        type: "goal.risk", goalId: target!, category: args.one("category") as HighRiskCategory,
        summary: args.one("summary")!, actionKey: args.one("key"), actor,
      };
      else if (group === "goal" && action === "ship") {
        const checksPassed = args.one("checks");
        if (checksPassed !== "passed" && checksPassed !== "failed")
          throw new Error("--checks 必须是 passed 或 failed");
        command = {
          type: "goal.ship", goalId: target!, operation: args.one("operation") as "merge" | "deploy",
          checksPassed: checksPassed === "passed", actor,
        };
      }
      else if (group === "goal" && action === "review") {
        const evidence = args.one("evidence-file")
          ? await jsonFile(args.one("evidence-file"), "交付证据")
          : undefined;
        if (evidence !== undefined && !Array.isArray(evidence))
          throw new Error("交付证据文件必须是数组");
        const revision = args.one("candidate-revision");
        command = {
          type: "goal.review",
          goalId: target!,
          delivery: {
            summary: args.one("summary")!,
            location: args.one("location"),
            url: args.one("url"),
            checks: checks(args.all("check")),
            ...(revision
              ? {
                  candidate: {
                    revision,
                    digest: args.one("candidate-digest"),
                    version: args.one("candidate-version"),
                  },
                }
              : {}),
            ...(evidence ? { evidence: evidence as import("../../packages/core/src/index.js").Evidence[] } : {}),
          },
          actor,
        };
      }
      else if (group === "goal" && action === "rework")
        command = {
          type: "goal.rework",
          goalId: target!,
          note: textArg(args.one("note"), "--note"),
          actor,
        };
      else if (group === "goal" && ["accept", "complete", "drop"].includes(action ?? "")) {
        if (action === "accept") requireHumanCli();
        command = {
          type: `goal.${action}` as "goal.accept" | "goal.complete" | "goal.drop",
          goalId: target!,
          note: args.one("note") ?? args.one("reason") ?? undefined,
          actor: action === "accept" ? "你" : actor,
        };
      }
      else if (group === "goal" && action === "autonomy") {
        requireHumanCli();
        const goalId = args.positional[3];
        if (!goalId) throw new Error("需要目标 ID");
        if (target === "acceptance") {
          command = {
            type: "goal.autonomy.acceptance",
            goalId,
            acceptance: textArg(
              args.one("acceptance"),
              "--acceptance",
            ) as "inherit" | "human-review" | "auto-with-verification",
            actor: "你",
          };
        } else if (target === "pause" || target === "resume") {
          command = {
            type: target === "pause"
              ? "goal.autonomy.pause"
              : "goal.autonomy.resume",
            goalId,
            actor: "你",
          };
        } else {
          throw new Error("goal autonomy 只支持 pause、resume 或 acceptance");
        }
      }
      else if (group === "goal" && action === "boundary-resolve") {
        requireHumanCli();
        command = {
          type: "goal.boundary.resolve",
          goalId: target!,
          boundaryId: args.one("boundary")!,
          outcome: args.one("outcome") as "approved" | "rejected",
          note: args.one("note")!,
          actor: "你",
        };
      }
      else if (group === "goal" && action === "reopen") {
        requireHumanCli();
        command = {
          type: "goal.reopen",
          goalId: target!,
          note: args.one("note")!,
          actor: "你",
        };
      }
      else if (group === "autonomy" && action === "set") {
        requireHumanCli();
        const pausedValue = args.one("paused");
        if (pausedValue !== undefined && !["yes", "no", "true", "false"].includes(pausedValue))
          throw new Error("--paused 必须是 yes 或 no");
        command = {
          type: "workspace.autonomy.set",
          acceptance: args.one("acceptance") as
            | "human-review"
            | "auto-with-verification"
            | undefined,
          paused: pausedValue === undefined
            ? undefined
            : ["yes", "true"].includes(pausedValue),
          maxRecoveryAttempts: args.one("max-recovery-attempts")
            ? Number(args.one("max-recovery-attempts"))
            : undefined,
          noProgressMinutes: args.one("no-progress-minutes")
            ? Number(args.one("no-progress-minutes"))
            : undefined,
          initialize: args.has("initialize"),
          actor: "你",
        };
      }
      else if (group === "autonomy" && action === "inspect") {
        command = {
          type: "autonomy.inspect",
          at: args.one("at") ?? new Date().toISOString(),
        };
      }
      else if (group === "autonomy" && action === "claim") {
        if (!target) throw new Error("需要目标 ID");
        command = {
          type: "autonomy.claim",
          goalId: target,
          continuationId: args.one("continuation")!,
          at: args.one("at") ?? new Date().toISOString(),
        };
      }
      else if (group === "autonomy" && action === "report") {
        if (!target) throw new Error("需要目标 ID");
        command = {
          type: "autonomy.report",
          goalId: target,
          continuationId: args.one("continuation")!,
          outcome: args.one("outcome") as "sent" | "failed" | "settled",
          detail: args.one("detail"),
          leaseId: args.one("lease"),
          at: args.one("at") ?? new Date().toISOString(),
        };
      }
      else if (group === "project" && action === "autonomy") {
        requireHumanCli();
        if (!target) throw new Error("需要项目 ID");
        const project = (await service.read()).projects.find(item => item.id === target);
        if (!project) throw new Error("找不到项目");
        command = {
          type: "project.autonomy.set",
          projectId: target,
          acceptance: (args.one("acceptance") ??
            project.autonomy?.acceptance ??
            "inherit") as "inherit" | "human-review" | "auto-with-verification",
          releaseOnMerge: (args.one("release-on-merge") ??
            project.releaseOnMerge ??
            "unknown") as "never" | "production" | "unknown",
          actor: "你",
        };
      }
      else if (group === "release" && action === "create") {
        requireHumanCli();
        const sourceGoalIds = args.all("from");
        if (!sourceGoalIds.length) throw new Error("发布目标至少需要一个 --from");
        command = {
          type: "release.create",
          sourceGoalIds,
          environment: args.one("environment") ?? "production",
          candidate: {
            revision: args.one("revision")!,
            digest: args.one("digest"),
            version: args.one("version"),
          },
          actor: "你",
        };
      }
      else if (group === "release" && ["approve", "reject"].includes(action ?? "")) {
        requireHumanCli();
        if (!target) throw new Error("需要发布目标 ID");
        command = {
          type: `release.${action}` as "release.approve" | "release.reject",
          goalId: target,
          note: args.one("note")!,
          actor: "你",
        };
      }
      else if (group === "release" && action === "result") {
        if (!target) throw new Error("需要发布目标 ID");
        const evidence = args.one("evidence-file")
          ? await jsonFile(args.one("evidence-file"), "发布证据")
          : args.all("evidence");
        if (!Array.isArray(evidence) || !evidence.every(item => typeof item === "string"))
          throw new Error("发布证据必须是字符串数组");
        command = {
          type: "release.result",
          goalId: target,
          outcome: args.one("outcome") as "succeeded" | "failed",
          evidence,
          actor,
        };
      }
      else if (group === "bot" && action === "bind") {
        requireHumanCli();
        command = {
          type: "bot.binding.set",
          binding: {
            id: args.one("id")!,
            name: args.one("name")!,
            role: args.one("role") as "initiator" | "executor",
            projectIds: args.all("project"),
            operations: args.all("operation") as import("../../packages/core/src/index.js").BotOperation[],
            expiresAt: args.one("expires-at")!,
          },
          actor: "你",
        };
      }
      else if (group === "bot" && action === "revoke") {
        requireHumanCli();
        if (!target) throw new Error("需要 Bot 绑定 ID");
        command = { type: "bot.binding.revoke", botId: target, actor: "你" };
      }
      else if (group === "bot" && action === "call") {
        const envelope = await jsonFile(args.one("file"), "Bot 请求");
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
          throw new Error("Bot 请求必须是 JSON 对象");
        const value = envelope as Record<string, unknown>;
        command = {
          type: "bot.request",
          schema: value.schema as "crewvane.bot.v1",
          requestId: value.requestId as string,
          operation: value.operation as import("../../packages/core/src/index.js").BotOperation,
          botId: value.botId as string,
          payload: value.payload,
        };
      }
      else if (group === "goal" && action === "resolve") command = {
        type: "goal.resolve", goalId: target!, note: args.one("note") ?? args.one("reason"), actor,
        outcome: (args.one("outcome") ?? "approved") as "approved" | "rejected",
        source: "cli",
      };
      else if (group === "goal" && action === "remind") command = { type: "goal.remind", goalId: target!, at: args.one("at")!, note: args.one("note") };
      else if (group === "session" && action === "set") {
        if (!target)
          throw new Error("session set 必须指定目标 ID；全局管家现场由桌面应用管理。");
        command = { type: "session.set", goalId: target, reference: { session: args.one("session") ?? process.env.HERDR_SESSION ?? "crewvane", workspaceId: args.one("workspace"), tabId: args.one("tab"), paneId: args.one("pane"), agent: args.one("agent"),
          ...(args.has("transport") ? { transport: args.one("transport") as "pane", processId: Number(args.one("process-id")) } : {}) } };
      }
      else if (group === "skill" && action === "list") {
        result = await new SkillRegistry(service.root).list();
      }
      else if (group === "skill" && action === "show") {
        if (!target) throw new Error("需要能力包 ID");
        result = await new SkillRegistry(service.root).show(target);
      }
      else if (group === "skill" && action === "draft") {
        requireHumanCli();
        if (!target) throw new Error("需要草稿目录");
        result = await createSkillDraft(target, {
          id: textArg(args.one("id"), "--id"),
          name: textArg(args.one("name"), "--name"),
          description: args.one("description"),
          roles: args.all("role"),
        });
      }
      else if (group === "skill" && action === "validate") {
        if (!target) throw new Error("需要能力包目录");
        result = await new SkillRegistry(service.root).validate(target);
      }
      else if (group === "skill" && action === "install") {
        requireHumanCli();
        if (!target) throw new Error("需要能力包目录");
        result = await new SkillRegistry(service.root).install(target, {
          approveScripts: args.all("approve-script"),
        });
      }
      else if (group === "skill" && action === "approve") {
        requireHumanCli();
        if (!target) throw new Error("需要能力包 ID");
        const scripts = args.all("approve-script");
        if (!scripts.length) throw new Error("至少提供一个 --approve-script ID");
        result = await new SkillRegistry(service.root).approveScripts(target, scripts);
      }
      else if (group === "skill" && action === "disable") {
        requireHumanCli();
        if (!target) throw new Error("需要能力包 ID");
        result = await new SkillRegistry(service.root).disable(target, true);
      }
      else if (group === "skill" && action === "enable") {
        requireHumanCli();
        if (!target) throw new Error("需要能力包 ID");
        result = await new SkillRegistry(service.root).disable(target, false);
      }
      else if (group === "skill" && action === "remove") {
        requireHumanCli();
        if (!target) throw new Error("需要能力包 ID");
        await new SkillRegistry(service.root).remove(target);
        result = { removed: target };
      }
      else if (group === "skill" && action === "attach") {
        if (!target) throw new Error("需要目标 ID");
        const packId = args.positional[3];
        if (!packId) throw new Error("需要能力包 ID");
        command = {
          type: "goal.skill.attach",
          goalId: target,
          packId,
          actor: coordinatorMode ? "concierge" : "human",
        };
      }
      else if (group === "skill" && action === "detach") {
        if (!target) throw new Error("需要目标 ID");
        const packId = args.positional[3];
        if (!packId) throw new Error("需要能力包 ID");
        command = {
          type: "goal.skill.detach",
          goalId: target,
          packId,
          actor: coordinatorMode ? "concierge" : "human",
        };
      }
      else if (group === "skill" && action === "resolve") {
        if (!target) throw new Error("需要目标 ID");
        const role = args.one("role") ?? "owner";
        if (!["concierge", "owner", "verifier"].includes(role))
          throw new Error("--role 只能是 concierge、owner 或 verifier");
        const state = await service.read(),
          item = state.goals.find(goal => goal.id === target);
        if (!item) throw new Error("找不到目标");
        result = await new SkillRegistry(service.root).resolve(
          item,
          role as "concierge" | "owner" | "verifier",
        );
      }
      else if (group === "skill" && action === "run") {
        if (!target) throw new Error("需要能力包 ID");
        const scriptId = args.positional[3],
          goalId = args.one("goal");
        if (!scriptId || !goalId) throw new Error("skill run 需要 SCRIPT_ID 与 --goal GOAL_ID");
        if (managedAgent) {
          const currentGoal = process.env.CREWVANE_GOAL_ID?.trim();
          if (!currentGoal || currentGoal !== goalId)
            throw new Error("受管 Agent 只能运行当前目标挂载的能力包脚本");
        }
        const state = await service.read(),
          item = state.goals.find(goal => goal.id === goalId);
        if (!item) throw new Error("找不到目标");
        const registry = new SkillRegistry(service.root),
          script = await registry.scriptForGoal(item, target, scriptId);
        if (!((await stat(script.path)).mode & 0o111))
          throw new Error(`脚本 ${scriptId} 没有可执行权限`);
        const environment: NodeJS.ProcessEnv = {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
          CREWVANE_GOAL_ID: item.id,
          CREWVANE_SKILL_PACK: target,
          CREWVANE_SKILL_SCRIPT: scriptId,
        };
        const execution = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolvePromise, reject) => {
          const child = spawn(script.path, args.all("arg"), {
            cwd: script.cwd,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "", stderr = "", settled = false;
          const finish = (code: number | null, error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolvePromise({
              code,
              stdout: stdout.slice(0, 60_000),
              stderr: stderr.slice(0, 60_000),
            });
          };
          child.stdout.on("data", chunk => {
            if (stdout.length < 120_000) stdout += String(chunk);
          });
          child.stderr.on("data", chunk => {
            if (stderr.length < 120_000) stderr += String(chunk);
          });
          child.once("error", error => finish(null, error));
          child.once("close", code => finish(code));
          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
            finish(null, new Error("能力包脚本超过 120 秒，已终止"));
          }, 120_000);
        });
        const succeeded = execution.code === 0,
          summary = [
            `退出码：${execution.code ?? "无"}`,
            execution.stdout.trim() ? `stdout：${execution.stdout.trim()}` : "",
            execution.stderr.trim() ? `stderr：${execution.stderr.trim()}` : "",
          ].filter(Boolean).join("\n").slice(0, 8_000);
        await service.execute({
          type: "goal.skill.audit",
          goalId,
          packId: target,
          scriptId,
          outcome: succeeded ? "succeeded" : "failed",
          summary: summary || (succeeded ? "脚本执行成功且没有输出。" : "脚本执行失败且没有输出。"),
          actor: managedAgentName || "你",
        });
        if (!succeeded)
          throw new Error(`能力包脚本失败（退出码 ${execution.code ?? "无"}）：${execution.stderr.trim() || execution.stdout.trim()}`);
        result = { packId: target, scriptId, goalId, ...execution };
      }
      else if (group === "owner" && action === "attach") {
        if (!target) throw new Error("需要目标 ID");
        result = await attachOwner(service, {
          goalId: target,
          name: textArg(args.one("name"), "--name"),
          session: textArg(args.one("session"), "--session"),
          workspaceId: textArg(args.one("workspace"), "--workspace"),
          tabId: textArg(args.one("tab"), "--tab"),
          paneId: textArg(args.one("pane"), "--pane"),
          ...(args.one("agent") ? { agent: textArg(args.one("agent"), "--agent") } : {}),
          ...(args.one("recovery-id") ? { recoveryId: textArg(args.one("recovery-id"), "--recovery-id") } : {}),
        });
      }
      else if (group === "owner" && action === "launch")
        ownerLaunch = {
          name: textArg(args.one("name"), "--name"),
          role: "owner",
          ...(args.one("task")
            ? { task: textArg(args.one("task"), "--task") }
            : {}),
          ...(args.one("task-file")
            ? { taskFile: textArg(args.one("task-file"), "--task-file") }
            : {}),
        };
      else if (group === "verifier" && action === "launch")
        ownerLaunch = {
          name: textArg(args.one("name"), "--name"),
          role: "verifier",
          ...(args.one("task")
            ? { task: textArg(args.one("task"), "--task") }
            : {}),
        };
      else throw new Error(`不支持的命令：${args.positional.join(" ")}\n\n${usage}`);
    }
    if (command && "goalId" in command && command.type !== "goal.scene-reply") {
      const attentionId = args.one("attention-id") ?? coordinatorContext?.attentionId;
      const sceneReplyId = args.one("scene-reply-id") ?? coordinatorContext?.sceneReplyId;
      if (coordinatorContext?.attentionId && attentionId !== coordinatorContext.attentionId)
        throw new Error("不能替换当前案卷绑定的待处理事项");
      if (coordinatorContext?.sceneReplyId && sceneReplyId !== coordinatorContext.sceneReplyId)
        throw new Error("不能替换当前案卷绑定的现场回执");
      command = { ...command, ...(attentionId ? { attentionId } : {}), ...(sceneReplyId ? { sceneReplyId } : {}) };
    }
    if (ownerLaunch) {
      if (!target) throw new Error("owner launch 必须指定当前目标 ID");
      result = await launchOwner(service, { goalId: target, ...ownerLaunch });
    } else if (command) result = await service.execute(command);
    if (coordinatorMode && group === "direct" && args.has("new") && command?.type === "goal.direct")
      await advanceCoordinatorCase(result as import("../../packages/core/src/index.js").Goal);
    if (group === "goal" && action === "show") {
      const goal = result as import("../../packages/core/src/index.js").Goal;
      result = { ...goal, attentionRequest: attentionRequest(goal) };
    }
    if (args.has("json")) io.out(JSON.stringify(result, null, 2));
    else if (group === "status" && verifierRead) {
      const current = result as {
        name: string;
        project?: { name?: string };
        goal: { status: string; next: string };
      };
      io.out(`${current.name} · ${current.project?.name ?? "个人事项"} · 当前复核目标 · ${current.goal.status}\n${current.goal.next}`);
    }
    else if (group === "status" && coordinatorRead) {
      const current = result as { name: string; project?: { name?: string } };
      io.out(`${current.name} · ${current.project?.name ?? "个人事项"} · 当前案卷`);
    }
    else if (group === "event" && action === "herdr") {
      const current = result as { matched: number };
      io.out(current.matched ? `已同步 ${current.matched} 个目标的现场状态。` : "没有需要同步的 Crewvane 目标。");
    }
    else if (group === "goal" && action === "show") {
      const goal = result as import("../../packages/core/src/index.js").Goal,
        images = (goal.attachments ?? []).map((item: GoalAttachment) =>
          `\n图片：${item.name}\n${join(service.root, item.path)}`).join("\n");
      io.out(`${goal.title}\n${goal.status} · ${goal.next}\n\n${goal.description}${images}`);
    }
    else if (Array.isArray(result)) io.out(result.length ? result.map((item) => `${item.id}  ${item.title ?? item.name}  ${item.next ?? ""}`).join("\n") : "暂无记录");
    else if (group === "status") {
      const state = result as import("../../packages/core/src/index.js").WorkspaceState;
      if (state.recovery)
        io.out(`旧版工作区已自动保护：${state.recovery.detail} 备份位于 ${state.recovery.archivedPath}`);
      io.out(`${state.name} · ${state.goals.filter((goal) => !["backlog", "completed", "dropped"].includes(goal.status)).length} 个未结束事项 · ${state.goals.filter(goal => goal.status === "backlog").length} 件暂存 · ${attentionGoals(state.goals).length} 项需要处理`);
    }
    else { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(goal?.id ? `${goal.id} · ${goal.status}\n${goal.next}` : JSON.stringify(result)); }
    return 0;
  } catch (error) { io.error(`crewvane: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
