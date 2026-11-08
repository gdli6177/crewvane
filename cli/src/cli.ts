import {
  WorkspaceService,
  attentionGoals,
  importAttachmentFiles,
  type CrewvaneCommand,
  type GoalAttachment,
  type HighRiskCategory,
} from "../../packages/core/src/index.js";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runBoard } from "./board.js";
import { launchOwner } from "./owner-launch.js";
const exec = promisify(execFile);
const usage = `Crewvane — 把所有事整理成清晰的下一步

人的消息入口（只追加原话，不改变目标状态）：
  crewvane status [--json]
  crewvane attention [--json]
  crewvane board [--new] [--once]
  crewvane ask TEXT [--project ID] [--attachment PATH ...]
  crewvane direct TEXT [--new] [--goal ID] [--project ID]
    [--attachment PATH ...]
  crewvane goal list [--all] [--json]
  crewvane goal show ID [--json]
  crewvane goal message ID --text TEXT [--attachment PATH ...]

Agent 状态协议（仅在明确事实发生后使用）：
  crewvane event herdr [--json]
  crewvane goal create --title TEXT [--project ID] [--description TEXT]
    [--mode concierge|manual]
  crewvane goal update ID [--title TEXT] [--description TEXT] [--next TEXT]
    [--owner TEXT] [--status active|waiting] [--remind-at ISO]
  crewvane goal progress ID --summary TEXT [--next TEXT] [--owner NAME]
  crewvane goal wait ID --reason TEXT [--owner TEXT] [--remind-at ISO]
  crewvane goal decide ID --question TEXT [--next TEXT] [--key KEY]
  crewvane goal risk ID --category CATEGORY --summary TEXT [--key KEY]
  crewvane goal ship ID --operation merge|deploy --checks passed|failed
  crewvane goal review ID --summary TEXT [--location TEXT] [--url URL]
    --check "名称::命令或操作::passed::说明"（可重复）
  crewvane goal accept ID [--note TEXT]
  crewvane goal complete ID --note "用户明确确认完成的原话"
  crewvane goal rework ID --note TEXT
  crewvane goal resolve ID --note TEXT [--outcome approved|rejected]
  crewvane goal drop ID --reason TEXT
  crewvane goal remind ID --at ISO [--note TEXT]
  crewvane session set ID [--workspace ID] [--tab ID] [--pane ID] [--agent NAME]
    [--transport pane --process-id PID]（自定义 CLI）
  crewvane owner launch ID --name NAME [--task TEXT | --task-file FILE]
    创建隔离的负责人现场；省略任务内容时读取目标详情与下一步

使用 --root DIR 或 CREWVANE_WORKSPACE 指定工作区。所有读写与桌面共用状态。
goal message 与 direct 不修改 status、next、等待对象或提醒；禁止用正文猜测批准、验收或完成。
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
    if (["json", "all", "help", "new", "once", "current"].includes(name)) { values.set(name, ["true"]); continue; }
    const value = inline ?? argv[++index];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new Error(`--${name} 需要一个值`);
    if (values.has(name) && !["check", "attachment"].includes(name)) throw new Error(`--${name} 不能重复`);
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
function textArg(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`${label} 不能为空`);
  return value.trim();
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
  return value.goalId;
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
    const service = new WorkspaceService(args.one("root") ?? (process.env.CREWVANE_WORKSPACE?.trim() || process.cwd())),
      coordinatorMode = process.env.CREWVANE_COORDINATOR === "1",
      coordinatorCase = await coordinatorCaseId(group === "direct" && args.has("new")),
      actor = args.one("actor") ?? (process.env.CREWVANE_AGENT_NAME?.trim() || undefined);
    if (group === "board" && !coordinatorCase) {
      await runBoard(service, io, { once: args.has("once"), startWithNewGoal: args.has("new") });
      return 0;
    }
    let command: CrewvaneCommand | undefined, result: unknown, coordinatorRead = false,
      ownerLaunch: { name: string; task?: string; taskFile?: string } | undefined;
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
        "accept", "complete", "rework", "drop", "resolve", "remind",
      ].includes(action ?? "")) {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "session" && action === "set") {
        assertCoordinatorCase(coordinatorCase, target);
      } else if (group === "owner" && action === "launch") {
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
    if (!coordinatorRead) {
      if (group === "status") result = await service.read();
      else if (group === "attention") result = attentionGoals((await service.read()).goals);
      else if (group === "ask") {
        const attachments = await importAttachmentFiles(service.root, args.all("attachment"));
        command = { type: "goal.intake", text: args.positional.slice(1).join(" "), projectId: args.one("project"), ...(attachments.length ? { attachments } : {}) };
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
      else if (group === "goal" && action === "create") {
        if (args.has("workflow")) throw new Error("工序已移除；请在目标说明中直接写清工作要求");
        command = { type: "goal.create", input: { title: args.one("title")!, projectId: args.one("project") ?? "personal", description: args.one("description"), mode: (args.one("mode") ?? "concierge") as "concierge" | "manual", next: args.one("next"), waitingFor: args.one("owner"), remindAt: args.one("remind-at") } };
      }
      else if (group === "goal" && action === "update") command = { type: "goal.update", goalId: target!, patch: {
        ...(args.has("stage") ? (() => { throw new Error("工序已移除；请直接更新目标下一步"); })() : {}),
        title: args.one("title"), description: args.one("description"), next: args.one("next"),
        owner: args.one("owner"),
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
      else if (group === "goal" && action === "review") command = { type: "goal.review", goalId: target!, delivery: { summary: args.one("summary")!, location: args.one("location"), url: args.one("url"), checks: checks(args.all("check")) }, actor };
      else if (group === "goal" && action === "rework")
        command = {
          type: "goal.rework",
          goalId: target!,
          note: textArg(args.one("note"), "--note"),
          actor,
        };
      else if (group === "goal" && ["accept", "complete", "drop"].includes(action ?? ""))
        command = {
          type: `goal.${action}` as "goal.accept" | "goal.complete" | "goal.drop",
          goalId: target!,
          note: args.one("note") ?? args.one("reason") ?? undefined,
          actor,
        };
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
      else if (group === "owner" && action === "launch")
        ownerLaunch = {
          name: textArg(args.one("name"), "--name"),
          ...(args.one("task")
            ? { task: textArg(args.one("task"), "--task") }
            : {}),
          ...(args.one("task-file")
            ? { taskFile: textArg(args.one("task-file"), "--task-file") }
            : {}),
        };
      else throw new Error(`不支持的命令：${args.positional.join(" ")}\n\n${usage}`);
    }
    if (ownerLaunch) {
      if (!target) throw new Error("owner launch 必须指定当前目标 ID");
      result = await launchOwner(service, { goalId: target, ...ownerLaunch });
    } else if (command) result = await service.execute(command);
    if (coordinatorMode && group === "direct" && args.has("new") && command?.type === "goal.direct")
      await advanceCoordinatorCase(result as import("../../packages/core/src/index.js").Goal);
    if (args.has("json")) io.out(JSON.stringify(result, null, 2));
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
      io.out(`${state.name} · ${state.goals.filter((goal) => !["completed", "dropped"].includes(goal.status)).length} 个进行中目标 · ${attentionGoals(state.goals).length} 项需要处理`);
    }
    else { const goal = result as import("../../packages/core/src/index.js").Goal; io.out(goal?.id ? `${goal.id} · ${goal.status}\n${goal.next}` : JSON.stringify(result)); }
    return 0;
  } catch (error) { io.error(`crewvane: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}
