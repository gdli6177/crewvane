import type { HerdrReference } from "../../packages/core/src/types.js";
import { WorkspaceService } from "../../packages/core/src/index.js";
import {
  createRunner,
  type HerdrCommandRunner,
} from "./owner-launch.js";

export interface OwnerAttachInput {
  goalId: string;
  name: string;
  session: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  agent?: string;
  recoveryId?: string;
}

function payload(raw: string): any {
  const parsed = JSON.parse(raw);
  return parsed?.result ?? parsed;
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function tabInfo(value: unknown) {
  if (!record(value)) return undefined;
  return record(value.tab) ? value.tab : value;
}

function paneInfo(value: unknown) {
  if (!record(value)) return undefined;
  return record(value.pane) ? value.pane : value;
}

function foregroundProcessId(value: unknown): number | undefined {
  if (!record(value)) return undefined;
  const info = record(value.process_info) ? value.process_info : value,
    shellPid = Number(info.shell_pid),
    foreground = Array.isArray(info.foreground_processes)
      ? info.foreground_processes
      : [];
  const candidates = foreground.filter(process =>
    record(process) && Number.isSafeInteger(process.pid));
  const candidate = candidates.find(process =>
    Number(process.pid) !== shellPid) ??
    candidates.find(process => {
      if (Number(process.pid) !== shellPid) return false;
      // A launcher may intentionally use exec so the Agent replaces the
      // pane's shell. Herdr then reports that live Agent as shell_pid. Accept
      // it only when the executable is not itself a shell; an idle shell is
      // still not a verifiable Agent scene.
      const executable = String(
        process.name ?? process.argv0 ?? process.argv?.[0] ?? "",
      );
      return executable.length > 0 &&
        !/^(?:ba|da|fi|k|z)?sh$/i.test(executable.split("/").at(-1) ?? "");
    });
  return candidate && Number.isSafeInteger(candidate.pid)
    ? Number(candidate.pid)
    : undefined;
}

export async function attachOwner(
  service: WorkspaceService,
  input: OwnerAttachInput,
  options: {
    environment?: NodeJS.ProcessEnv;
    run?: HerdrCommandRunner;
  } = {},
) {
  const environment = options.environment ?? process.env;
  if (environment.HERDR_ENV !== "1")
    throw new Error("owner attach 只能从 Herdr 管家的受管现场执行");
  const currentSession = environment.HERDR_SESSION?.trim();
  if (!currentSession || currentSession !== input.session)
    throw new Error("owner attach 的 Session 必须与当前 Herdr Session 一致");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.session))
    throw new Error("Herdr Session 无效");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name))
    throw new Error("负责人名称只能使用小写字母、数字、下划线或短横线，并以字母开头");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.workspaceId))
    throw new Error("Workspace ID 无效");
  if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(input.tabId) ||
    !input.tabId.startsWith(`${input.workspaceId}:`))
    throw new Error("Tab ID 无效");
  if (!/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(input.paneId) ||
    !input.paneId.startsWith(`${input.workspaceId}:`))
    throw new Error("Pane ID 无效");
  if (input.agent && !/^[a-z][a-z0-9_-]{0,31}$/.test(input.agent))
    throw new Error("Agent 名称无效");

  const state = await service.read(),
    goal = state.goals.find(item => item.id === input.goalId);
  if (!goal) throw new Error("找不到当前案卷");
  if (goal.mode !== "concierge" || ["completed", "dropped", "backlog"].includes(goal.status))
    throw new Error("当前目标不能绑定负责人现场");
  if (goal.herdr && goal.herdr.paneId !== input.paneId)
    throw new Error("当前目标已经绑定其他负责人现场，未覆盖原绑定");
  const recovery = goal.ownerLaunchRecovery;
  if (input.recoveryId) {
    if (!recovery || recovery.id !== input.recoveryId)
      throw new Error("恢复 ID 与当前目标记录不一致");
    if (recovery.session !== input.session)
      throw new Error("恢复 ID 不属于当前 Herdr Session");
    if (recovery.status === "superseded")
      throw new Error("该恢复 ID 已被新的负责人启动记录取代");
    if (recovery.status === "attached" && goal.herdr)
      throw new Error("该恢复 ID 已经完成绑定");
  } else if (!goal.herdr) {
    throw new Error("绑定新现场需要提供 owner launch 生成的 recovery ID");
  }

  const run = options.run ?? createRunner(environment),
    tabPayload = payload(await run(["tab", "get", input.tabId])),
    tab = tabInfo(tabPayload),
    tabWorkspace = String(tab?.workspace_id ?? tab?.workspaceId ?? "");
  if (tabWorkspace && tabWorkspace !== input.workspaceId)
    throw new Error("Tab 不属于指定的 Workspace");
  if (tab?.tab_id && tab.tab_id !== input.tabId)
    throw new Error("Herdr 返回了不同的 Tab");

  const panePayload = payload(await run(["pane", "get", input.paneId])),
    pane = paneInfo(panePayload),
    paneTab = String(pane?.tab_id ?? pane?.tabId ?? ""),
    paneWorkspace = String(pane?.workspace_id ?? pane?.workspaceId ?? "");
  if (paneTab && paneTab !== input.tabId)
    throw new Error("Pane 不属于指定的 Tab");
  if (paneWorkspace && paneWorkspace !== input.workspaceId)
    throw new Error("Pane 不属于指定的 Workspace");

  let processId: number | undefined;
  if (input.agent) {
    const agentPayload = payload(await run(["agent", "get", input.agent])),
      agent = record(agentPayload?.agent) ? agentPayload.agent : agentPayload;
    if (
      !record(agent) ||
      (agent.name ?? agent.agent_name ?? agent.agent) !== input.agent
    )
      throw new Error("Herdr 没有返回匹配的 Agent 身份");
    const agentPane = String(agent.pane_id ?? agent.paneId ?? "");
    if (agentPane && agentPane !== input.paneId)
      throw new Error("该 Agent 不在指定 Pane 中");
  } else {
    processId = foregroundProcessId(
      payload(await run(["pane", "process-info", "--pane", input.paneId])),
    );
    if (!processId)
      throw new Error("Pane 没有可核实的 Agent 或前台进程，不能登记为负责人现场");
  }

  const reference: HerdrReference = {
    session: input.session,
    workspaceId: input.workspaceId,
    tabId: input.tabId,
    paneId: input.paneId,
    agent: input.agent ?? input.name,
    ...(!input.agent && processId ? { transport: "pane" as const, processId } : {}),
  };
  const updated = await service.execute({
    type: "session.set",
    goalId: goal.id,
    reference,
  });
  if (recovery) {
    await service.execute({
      type: "goal.owner-launch.recovery",
      goalId: goal.id,
      recovery: {
        ...recovery,
        status: "attached",
        tabId: input.tabId,
        paneId: input.paneId,
        attachedAt: new Date().toISOString(),
      },
    });
  }
  return { goal: updated, reference };
}
