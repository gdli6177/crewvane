import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { runHostHerdr } from "./host-bridge.js";
import { ownerSceneReplyInstructions } from "./owner-instructions.js";
import {
  agentRuntimeCapabilities,
  agentRuntimeSocketPath,
  parseAgentCommand,
  resumeAgentArgs,
  newId,
  WorkspaceService,
  type AgentRuntimeAdapterId,
  type HerdrReference,
  type OwnerResume,
} from "../../packages/core/src/index.js";

const exec = promisify(execFile);

export type HerdrCommandRunner = (args: string[]) => Promise<string>;

export interface OwnerLaunchInput {
  goalId: string;
  name: string;
  role?: "owner" | "verifier";
  task?: string;
  taskFile?: string;
  resume?: OwnerResume;
}

export interface OwnerLaunchResult {
  goalId: string;
  runtime: string;
  reference: HerdrReference;
  warning?: string;
}

export async function startAgentWhenPaneReady(
  run: HerdrCommandRunner,
  args: string[],
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let retryDelay = 100;
  for (;;) {
    try {
      return await run(args);
    } catch (error) {
      // The pane initialization marker is emitted while the shell may still
      // be finishing its command. Herdr reports agent_pane_busy before it
      // launches the agent, so retrying the same pane is safe. Other startup
      // errors can happen after process creation and must not be replayed.
      if (!/\bagent_pane_busy\b/.test(String(error)) || Date.now() >= deadline)
        throw error;
      await wait(retryDelay);
      retryDelay = Math.min(1_000, Math.round(retryDelay * 1.6));
    }
  }
}

function payload(raw: string): any {
  const value = JSON.parse(raw);
  return value?.result ?? value;
}

export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// pane run sends text, not an argv array. On macOS a shell without bracketed
// paste accepts at most 1024 bytes per canonical input line. Keep environment
// setup and custom-CLI messages below that boundary without splitting a code
// point. Environment exports are separate commands so no quoted string is cut.
export function terminalText(value: string, limit = 768): string {
  return value.split("\n").map(line => {
    const lines: string[] = [];
    let current = "", bytes = 0;
    for (const character of line) {
      const size = Buffer.byteLength(character);
      if (current && bytes + size > limit) {
        lines.push(current);
        current = "";
        bytes = 0;
      }
      current += character;
      bytes += size;
    }
    return [...lines, current].join("\n");
  }).join("\n");
}

function pathExports(executableDirectory: string, inherited: string): string[] {
  const directories = [...new Set([executableDirectory, ...inherited.split(":")]
    .filter(value => value.length > 0))];
  const commands: string[] = [];
  for (let index = 0; index < directories.length;) {
    const batch: string[] = [];
    let length = 0;
    while (index < directories.length) {
      const directory = directories[index]!;
      const addition = (batch.length ? 1 : 0) + Buffer.byteLength(quoteShell(directory));
      if (batch.length && length + addition > 560) break;
      batch.push(directory);
      length += addition;
      index += 1;
      // An unusual single executable path still has to be carried verbatim.
      if (Buffer.byteLength(quoteShell(directory)) > 560) break;
    }
    commands.push(`export PATH=${batch.map(quoteShell).join(":")}${batch.length ? ":$PATH" : ""}`);
  }
  return commands;
}

async function sendShellCommand(run: HerdrCommandRunner, paneId: string, command: string) {
  for (const line of terminalText(command).split("\n")) {
    if (!line) continue;
    if (Buffer.byteLength(line) > 768)
      throw new Error("终端初始化包含超过 768 字节的单个路径，请改用较短的启动路径");
    await run(["pane", "run", paneId, line]);
  }
}

function createRunner(environment: NodeJS.ProcessEnv): HerdrCommandRunner {
  const session = environment.HERDR_SESSION?.trim();
  if (!session)
    throw new Error("负责人启动需要当前 Herdr Session");
  const hostSocket = environment.CREWVANE_HOST_SOCKET?.trim();
  const hostToken = environment.CREWVANE_HOST_TOKEN?.trim();
  if (hostSocket && hostToken)
    return args => runHostHerdr(hostSocket, hostToken, args);
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
function runtimeAdapter(kind: string | undefined, executable: string): AgentRuntimeAdapterId | undefined {
  const value = `${kind ?? ""} ${basename(executable)}`.toLowerCase();
  if (/\bcodex\b/.test(value)) return "codex";
  if (/\bclaude(?:-code)?\b/.test(value)) return "claude-code";
  if (/\bcursor(?:-agent)?\b/.test(value)) return "cursor";
  if (/\bqoder(?:cli)?\b/.test(value)) return "qoder";
  if (/\bomp\b|\boh-my-pi\b/.test(value)) return "omp";
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
    `实际执行由你完成；咨询用 crewvane goal progress ${goal.id} --summary "<具体答案>" 写回。只有等待用户和所有 Agent 之外的具名外部第三方时，才用 crewvane goal wait ${goal.id} --reason "<外部等待原因>" --owner "<外部联系人或机构>"；需要用户选择、确认、提供信息或操作时，用 crewvane goal decide ${goal.id} --question "<具体问题>" 提出问题并结束本回合，不得记为 waiting。你、管家、工人和其他 Agent 之间的内部协调保持 active，通过 progress 写回实际结果；不要把终端空闲或结束一回合当成等待。remind 只设置提醒，不改变生命周期。只有有实际可验收成果时才运行真实检查并用 crewvane goal review 提交成果摘要、位置与检查记录；不要为等待或咨询伪造交付。`,
  ].filter(Boolean).join("\n\n");
}
function automaticVerificationTask(goal: {
  id: string;
  title: string;
  description: string;
  next: string;
  delivery?: { id?: string; candidate?: { revision: string }; evidence?: Array<{ id: string }> };
  brief?: {
    criteria: Array<{ id: string; statement: string; required: boolean }>;
    verificationPlan: { requiredEvidenceKinds: string[] };
  };
}) {
  const required = goal.brief?.criteria.filter(criterion => criterion.required) ?? [],
    evidenceIds = (goal.delivery?.evidence ?? []).map(evidence => evidence.id),
    exampleCriterion = required[0]?.id ?? "criterion-id";
  return [
    `你是目标「${goal.title}」的独立复核者，不负责实现、不修改代码、不代表用户验收。`,
    `目标 ID：${goal.id}`,
    `运行 crewvane goal show ${goal.id} --json，读取委托摘要、候选版本和交付证据；再独立读取实际成果并运行必要的真实检查。`,
    "不得复用原负责人现场，不得让原负责人自检代替本次复核，不得相信只有文字声明而没有可定位证据的结论。",
    `必选完成条件：${required.map(criterion => `${criterion.id}：${criterion.statement}`).join("；") || "未提供"}`,
    `交付证据 ID：${evidenceIds.join("、") || "未提供"}`,
    `每项必选条件都要给出 passed 或 failed，并引用真实证据 ID。所有必选条件通过时才可提交 --outcome passed。`,
    `提交示例：crewvane goal verify ${goal.id} --delivery ${goal.delivery?.id ?? "<delivery-id>"} --outcome passed --summary "<具体复核结论>" --criterion "${exampleCriterion}::passed::<evidence-id>"`,
    "若证据不足、候选不一致、无法确认独立性或检查失败，使用 --outcome failed，并写明缺失证据和复现结果。提交后结束，不轮询，不进入实现返工。",
  ].join("\n\n");
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
    wait?: (ms: number) => Promise<void>;
  } = {},
): Promise<OwnerLaunchResult> {
  const environment = options.environment ?? process.env;
  const verifier = input.role === "verifier";
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
  if (verifier) {
    if (goal.status !== "review" || !goal.delivery?.id || !goal.brief)
      throw new Error("只有提交交付和委托摘要的待复核目标可以启动独立复核者");
  } else if (!["active", "waiting"].includes(goal.status))
    throw new Error("已结束的目标不能启动负责人");
  if (goal.mode !== "concierge")
    throw new Error("这件事由人安排，请先明确交给管家再启动负责人");
  if (!verifier && goal.herdr)
    throw new Error("该目标已经有负责人现场；请直接联系原负责人");
  const project = state.projects.find((item) => item.id === goal.projectId);
  const cwd = await realpath(input.resume?.cwd || project?.path?.trim() || service.root);
  if (!(await stat(cwd)).isDirectory())
    throw new Error("目标关联项目不是有效目录");

  const run = options.run ?? createRunner(environment);
  const task = verifier
    ? input.task?.trim() || automaticVerificationTask(goal)
    : `${await resolveTask(service, goal, input)}\n\n${ownerSceneReplyInstructions(goal.id)}`;
  const restoredArgs = resumeAgentArgs(input.resume?.agentSession);
  const configured = state.agents?.owner?.trim() || state.agents?.concierge?.trim() || "codex";
  const command = restoredArgs
    ? {
        executable: input.resume!.agentSession!.agent,
        kind: input.resume!.agentSession!.agent,
        args: restoredArgs,
      }
    : parseAgentCommand(configured, await supportedKinds(run));
  const executable = expandHome(
    command.executable,
    environment.HOME || "",
  );
  const adapter = runtimeAdapter(command.kind, executable) ?? "custom";
  const attemptId = verifier ? undefined : newId("attempt"),
    hookToken = verifier ? undefined : randomBytes(32).toString("hex"),
    hookTokenHash = hookToken
      ? createHash("sha256").update(hookToken).digest("hex")
      : undefined;
  if (!verifier) {
    await service.execute({
      type: "agent.runtime.register",
      goalId: goal.id,
      attempt: {
        goalId: goal.id,
        attemptId: attemptId!,
        agent: input.name,
        adapter,
        startedAt: new Date().toISOString(),
      },
      hookTokenHash: hookTokenHash!,
      capabilities: agentRuntimeCapabilities(adapter),
    });
  }
  const executableDirectory = executable.includes("/")
    ? dirname(executable)
    : "";
  const label = `Crewvane · ${goal.title.trim().slice(0, 60)}`;

  let tabId: string | undefined;
  let verifierReference: HerdrReference | undefined;
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

    const ownerEnvironment = [
      "unset CREWVANE_COORDINATOR CREWVANE_COORDINATOR_SCOPE_FILE",
      `export CREWVANE_ROLE=${verifier ? "verifier" : "owner"} CREWVANE_AGENT_NAME=${quoteShell(input.name)}`,
      `export CREWVANE_GOAL_ID=${quoteShell(goal.id)}`,
      ...(!verifier ? [
        `export CREWVANE_ATTEMPT_ID=${quoteShell(attemptId!)}`,
        `export CREWVANE_HOOK_TOKEN=${quoteShell(hookToken!)}`,
      ] : []),
      `export CREWVANE_WORKSPACE=${quoteShell(await realpath(service.root))}`,
      ...(!verifier ? [
        `export CREWVANE_HOOK_SOCKET=${quoteShell(agentRuntimeSocketPath(await realpath(service.root)))}`,
        `export CREWVANE_HOOK_SPOOL=${quoteShell(join(await realpath(service.root), ".crewvane", "runtime", "spool"))}`,
      ] : []),
      `export CREWVANE_HERDR_BINARY=${quoteShell(
        environment.CREWVANE_HERDR_BINARY?.trim() ||
        environment.HERDR_BIN_PATH?.trim() ||
        "herdr",
      )}`,
      ...(environment.CREWVANE_HOST_SOCKET?.trim()
        ? [`export CREWVANE_HOST_SOCKET=${quoteShell(environment.CREWVANE_HOST_SOCKET.trim())}`]
        : []),
      ...(environment.CREWVANE_HOST_TOKEN?.trim()
        ? [`export CREWVANE_HOST_TOKEN=${quoteShell(environment.CREWVANE_HOST_TOKEN.trim())}`]
        : []),
      `export HERDR_ENV=1 HERDR_SESSION=${quoteShell(session)}`,
      `export HERDR_WORKSPACE_ID=${quoteShell(workspaceId)}`,
      `export HERDR_TAB_ID=${quoteShell(tabId)}`,
      `export HERDR_PANE_ID=${quoteShell(paneId)}`,
      ...pathExports(executableDirectory, environment.PATH || ""),
      "printf '\\n__CREWVANE_OWNER_ENV_READY__\\n'",
    ].join("\n");
    await sendShellCommand(run, paneId, ownerEnvironment);
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
    if (verifier) verifierReference = reference;
    if (verifier) {
      await service.execute({
        type: "goal.verification.site",
        goalId: goal.id,
        reference,
        status: "launching",
        actor: input.name,
      });
    }
    let managedByHerdr = false;
    if (command.kind) {
      try {
        await startAgentWhenPaneReady(
          run,
          [
            "agent",
            "start",
            input.name,
            "--kind",
            command.kind,
            "--pane",
            paneId,
            ...(command.args.length ? ["--", ...command.args] : []),
          ],
          options.wait,
        );
      } catch (error) {
        if (!/\bagent_not_ready\b/.test(String(error))) throw error;
        // Herdr keeps this live Agent at its startup dialog. Preserve the
        // scene so a person can review Hook/repository trust in the Agent UI.
        // Never answer that dialog, retry startup or submit the task through it.
        if (verifier) {
          await service.execute({
            type: "goal.verification.site",
            goalId: goal.id,
            reference,
            status: "blocked",
            detail: String(error),
            actor: input.name,
          });
        } else {
          await service.execute({ type: "session.set", goalId: goal.id, reference });
          bound = true;
          await service.execute({
            type: "goal.progress", goalId: goal.id, actor: "管家",
            summary: "负责人已启动，正在等待现场交互确认；目标任务尚未发送。",
            next: "在原负责人现场审核启动或 Hook 信任提示，确认就绪后请管家向同一负责人发送目标。",
          });
          await service.execute({
            type: "live.sync", presences: { [goal.id]: {
              state: "blocked", reachable: true, checkedAt: new Date().toISOString(),
            } },
          });
        }
        return {
          goalId: goal.id, runtime: input.resume?.agentSession?.agent || configured,
          reference,
          warning: "负责人正在等待启动确认，现场已保留；请在原 Agent 中审核信任提示，禁止自动确认或重复启动。目标任务尚未发送。",
        };
      }
    } else {
      await sendShellCommand(run, paneId, [executable, ...command.args].map(quoteShell).join(" "));
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
      // Custom CLIs are intentionally not limited to Herdr's known kinds.
      // Herdr can see the foreground process before the CLI has entered raw
      // terminal input mode, so wait through that handshake before sending the
      // first prompt. Otherwise an interactive CLI may discard buffered input
      // and exit (observed with a Codex launcher wrapper).
      await (options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(1_200);
      const readyInfo = payload(await run([
        "pane",
        "process-info",
        "--pane",
        paneId,
      ])).process_info;
      const readyForeground = Array.isArray(readyInfo?.foreground_processes)
        ? readyInfo.foreground_processes.filter(
          (process: any) => process?.pid !== readyInfo.shell_pid,
        )
        : [];
      if (!readyForeground.some((process: any) => process?.pid === processId))
        throw new Error("自定义 Agent 在准备输入时退出，请核对启动命令、登录和现场输出");
      reference = {
        ...reference,
        transport: "pane",
        processId,
      };
      try {
        const listed = payload(await run(["agent", "list"]));
        const detected = Array.isArray(listed.agents)
          ? listed.agents.find((agent: any) => agent?.pane_id === paneId)
          : undefined;
        if (detected) {
          if (detected.name !== input.name)
            await run(["agent", "rename", paneId, input.name]);
          managedByHerdr = true;
        }
      } catch {
        // Unknown CLIs stay on Pane transport; supported CLIs that Herdr has
        // already detected get a stable governed name and lifecycle prompting.
      }
    }

    if (!verifier) {
      await service.execute({
        type: "session.set",
        goalId: goal.id,
        reference,
      });
      bound = true;
    }

    if (command.kind || managedByHerdr) {
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
        if (verifier) {
          await service.execute({
            type: "goal.verification.site",
            goalId: goal.id,
            reference,
            status: "ready",
            detail: "Herdr 已接收复核任务，但未及时观察到 working；请先核对现场，禁止重复发送。",
            actor: input.name,
          });
        }
        return {
          goalId: goal.id,
          runtime: input.resume?.agentSession?.agent || configured,
          reference,
          warning:
            "Herdr 已接收任务，但没有及时观察到 working；现场已保留，请先核对，禁止重复发送。",
        };
      }
    } else {
      await run(["pane", "run", paneId, terminalText(task)]);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    bound = true;

    if (verifier) {
      await service.execute({
        type: "goal.verification.site",
        goalId: goal.id,
        reference,
        status: "ready",
        actor: input.name,
      });
    }
    return {
      goalId: goal.id,
      runtime: input.resume?.agentSession?.agent || configured,
      reference,
    };
  } catch (error) {
    if (verifier && verifierReference) {
      await service.execute({
        type: "goal.verification.site",
        goalId: goal.id,
        reference: verifierReference,
        status: "failed",
        detail: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
        actor: input.name,
      }).catch(() => {});
    }
    if (!bound) {
      await closeTab(run, tabId);
      // A failed launch is a real coordination result. Do not leave the goal
      // showing only an optimistic "assign an owner" next step.
      if (!verifier) {
        const detail = String(error instanceof Error ? error.message : error).slice(0, 1000);
        await service.execute({
          type:"goal.progress", goalId:goal.id, actor:"管家",
          summary:`负责人启动未完成：${detail}`,
          next:"核对启动命令与真实现场后重试；目标尚未开始执行。",
        }).catch(() => {});
      }
    }
    throw error;
  }
}
