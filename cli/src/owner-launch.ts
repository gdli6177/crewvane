import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ownerSceneReplyInstructions } from "./owner-instructions.js";
import {
  parseAgentCommand,
  WorkspaceService,
  type HerdrReference,
} from "../../packages/core/src/index.js";

const exec = promisify(execFile);

export type HerdrCommandRunner = (args: string[]) => Promise<string>;

export interface OwnerLaunchInput {
  goalId: string;
  name: string;
  task?: string;
  taskFile?: string;
}

export interface OwnerLaunchResult {
  goalId: string;
  runtime: string;
  reference: HerdrReference;
  warning?: string;
}

function payload(raw: string): any {
  const value = JSON.parse(raw);
  return value?.result ?? value;
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function createRunner(environment: NodeJS.ProcessEnv): HerdrCommandRunner {
  const session = environment.HERDR_SESSION?.trim();
  if (!session)
    throw new Error("负责人启动需要当前 Herdr Session");
  const binary =
    environment.CREWVANE_HERDR_BINARY?.trim() ||
    environment.HERDR_BIN_PATH?.trim() ||
    "herdr";
  return async (args) => {
    const { stdout } = await exec(
      binary,
      ["--session", session, ...args],
      { timeout: 190_000, maxBuffer: 1_000_000 },
    );
    return stdout;
  };
}

async function supportedKinds(run: HerdrCommandRunner): Promise<string[]> {
  const help = await run(["agent", "start", "--help"]);
  return /\[possible values:\s*([^\]]+)\]/
    .exec(help)?.[1]
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) =>
      /^[a-z][a-z0-9_-]{0,31}$/.test(value)
    ) ?? [];
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

async function closeTab(run: HerdrCommandRunner, tabId?: string) {
  if (!tabId) return;
  await run(["tab", "close", tabId]).catch(() => {});
}

function automaticTask(goal: {
  id: string;
  title: string;
  description: string;
  next: string;
}) {
  return [
    `你是目标「${goal.title}」的独立负责人。只处理这个目标，其他目标的内容与本次任务无关。`,
    `目标 ID：${goal.id}`,
    `完整目标原文：\n${goal.description}`,
    goal.next.trim() ? `当前下一步：\n${goal.next}` : "",
    `实际执行由你完成；咨询用 crewvane goal progress ${goal.id} --summary "<具体答案>" 写回，等待用 crewvane goal wait ${goal.id} --reason "<实际等待>"，需要人选择用 crewvane goal decide ${goal.id} --question "<具体问题>" 提出问题并结束本回合。只有有实际可验收成果时才运行真实检查并用 crewvane goal review 提交成果摘要、位置与检查记录；不要为等待或咨询伪造交付。`,
  ].filter(Boolean).join("\n\n");
}

async function resolveTask(
  service: WorkspaceService,
  goal: {
    id: string;
    title: string;
    description: string;
    next: string;
  },
  input: OwnerLaunchInput,
) {
  if (input.task?.trim() && input.taskFile)
    throw new Error("--task 与 --task-file 不能同时使用");
  let task = input.task?.trim();
  if (input.taskFile) {
    const root = await realpath(service.root);
    const path = await realpath(input.taskFile);
    const relativePath = relative(root, path);
    if (
      !relativePath ||
      relativePath.startsWith("..") ||
      resolve(root, relativePath) !== path
    )
      throw new Error("负责人任务文件必须位于当前工作区内");
    if (!(await stat(path)).isFile())
      throw new Error("负责人任务文件不是普通文件");
    if ((await stat(path)).size > 100_000)
      throw new Error("负责人任务文件不能超过 100000 字节");
    task = (await readFile(path, "utf8")).trim();
  }
  task ||= automaticTask(goal);
  if (task.length > 100_000)
    throw new Error("负责人任务不能超过 100000 字符");
  return task;
}

export async function launchOwner(
  service: WorkspaceService,
  input: OwnerLaunchInput,
  options: {
    environment?: NodeJS.ProcessEnv;
    run?: HerdrCommandRunner;
  } = {},
): Promise<OwnerLaunchResult> {
  const environment = options.environment ?? process.env;
  if (environment.HERDR_ENV !== "1")
    throw new Error("负责人只能从 Herdr 管家的受管现场启动");
  const session = environment.HERDR_SESSION?.trim() ?? "";
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(session))
    throw new Error("当前 Herdr Session 无效");
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name))
    throw new Error("负责人名称只能使用小写字母、数字、下划线或短横线，并以字母开头");
  const state = await service.read();
  const goal = state.goals.find((item) => item.id === input.goalId);
  if (!goal) throw new Error("找不到当前案卷");
  if (!["active", "waiting"].includes(goal.status))
    throw new Error("已结束的目标不能启动负责人");
  if (goal.herdr)
    throw new Error("该目标已经有负责人现场；请直接联系原负责人");
  const project = state.projects.find((item) => item.id === goal.projectId);
  const cwd = await realpath(project?.path?.trim() || service.root);
  if (!(await stat(cwd)).isDirectory())
    throw new Error("目标关联项目不是有效目录");

  const run = options.run ?? createRunner(environment);
  const task = `${await resolveTask(service, goal, input)}\n\n${ownerSceneReplyInstructions(goal.id)}`;
  const configured =
    state.agents?.owner?.trim() ||
    state.agents?.concierge?.trim() ||
    "codex";
  const kinds = await supportedKinds(run);
  const command = parseAgentCommand(configured, kinds);
  const executable = expandHome(
    command.executable,
    environment.HOME || "",
  );
  const executableDirectory = executable.includes("/")
    ? dirname(executable)
    : "";
  const label = `Crewvane · ${goal.title.trim().slice(0, 60)}`;

  let tabId: string | undefined;
  let bound = false;
  try {
    const created = payload(await run([
      "tab",
      "create",
      "--cwd",
      cwd,
      "--label",
      label,
      "--no-focus",
    ]));
    const workspace = created.workspace ?? created.created_workspace;
    const tab = created.tab ?? created.created_tab;
    const rootPane =
      created.root_pane ??
      created.created_pane ??
      created.pane;
    const workspaceId =
      workspace?.workspace_id ??
      workspace?.id ??
      tab?.workspace_id ??
      rootPane?.workspace_id ??
      created.workspace_id;
    tabId =
      tab?.tab_id ??
      tab?.id ??
      rootPane?.tab_id ??
      created.tab_id;
    const paneId =
      rootPane?.pane_id ??
      rootPane?.id ??
      tab?.root_pane?.pane_id ??
      tab?.root_pane?.id ??
      created.root_pane_id;
    if (!workspaceId || !tabId || !paneId)
      throw new Error("Herdr 没有返回负责人所需的真实 Workspace、Tab 和 Pane ID");

    const path = [
      executableDirectory,
      environment.PATH || "",
    ].filter(Boolean).join(":");
    const ownerEnvironment = [
      "unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE",
      `export CREWVANE_ROLE=owner CREWVANE_AGENT_NAME=${quoteShell(input.name)}`,
      `export CREWVANE_GOAL_ID=${quoteShell(goal.id)}`,
      `export CREWVANE_WORKSPACE=${quoteShell(await realpath(service.root))}`,
      `export CREWVANE_HERDR_BINARY=${quoteShell(
        environment.CREWVANE_HERDR_BINARY?.trim() ||
        environment.HERDR_BIN_PATH?.trim() ||
        "herdr",
      )}`,
      `export HERDR_ENV=1 HERDR_SESSION=${quoteShell(session)}`,
      `export HERDR_WORKSPACE_ID=${quoteShell(workspaceId)}`,
      `export HERDR_TAB_ID=${quoteShell(tabId)}`,
      `export HERDR_PANE_ID=${quoteShell(paneId)}`,
      `export PATH=${quoteShell(path)}:"$PATH"`,
      "printf '\\n__CREWVANE_OWNER_ENV_READY__\\n'",
    ].join("; ");
    await run(["pane", "run", paneId, ownerEnvironment]);
    await run([
      "pane",
      "wait-output",
      paneId,
      "--match",
      "__CREWVANE_OWNER_ENV_READY__",
      "--timeout",
      "10000",
    ]);

    let reference: HerdrReference = {
      session,
      workspaceId,
      tabId,
      paneId,
      agent: input.name,
    };
    if (command.kind) {
      await run([
        "agent",
        "start",
        input.name,
        "--kind",
        command.kind,
        "--pane",
        paneId,
        ...(command.args.length ? ["--", ...command.args] : []),
      ]);
    } else {
      await run([
        "pane",
        "run",
        paneId,
        [executable, ...command.args].map(quoteShell).join(" "),
      ]);
      const deadline = Date.now() + 20_000;
      let processId = 0;
      while (Date.now() < deadline) {
        const info = payload(await run([
          "pane",
          "process-info",
          "--pane",
          paneId,
        ])).process_info;
        const foreground = Array.isArray(info?.foreground_processes)
          ? info.foreground_processes.filter(
            (process: any) => process?.pid !== info.shell_pid,
          )
          : [];
        if (foreground[0]?.pid) {
          processId = foreground[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!processId)
        throw new Error("自定义 Agent 未保持运行");
      reference = {
        ...reference,
        transport: "pane",
        processId,
      };
    }

    await service.execute({
      type: "session.set",
      goalId: goal.id,
      reference,
    });
    bound = true;

    if (command.kind) {
      try {
        await run([
          "agent",
          "prompt",
          input.name,
          task,
          "--wait",
          "--until",
          "working",
        ]);
      } catch (error) {
        if (!/\bagent_prompt_stalled\b/.test(String(error))) throw error;
        return {
          goalId: goal.id,
          runtime: configured,
          reference,
          warning:
            "Herdr 已接收任务，但没有及时观察到 working；现场已保留，请先核对，禁止重复发送。",
        };
      }
    } else {
      await run(["pane", "run", paneId, task]);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }

    return { goalId: goal.id, runtime: configured, reference };
  } catch (error) {
    if (!bound) await closeTab(run, tabId);
    throw error;
  }
}
