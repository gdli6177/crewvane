import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type {
  HerdrReference,
  LivePresence,
  AgentPreferences,
  Goal,
} from "../../../packages/core/src/types.js";
import { attachmentAbsolutePath } from "../../../packages/core/src/attachments.js";
import { attentionRequest } from "../../../packages/core/src/model.js";
import { ownerSceneReplyInstructions } from "../../../cli/src/owner-instructions.js";
const exec = promisify(execFile);
export const CONCIERGE_LAUNCH_POLICY = "control-plane-v1" as const;
export interface HerdrRunner {
  run(args: string[], timeout?: number): Promise<string>;
}
export interface ConciergeSite {
  reference: HerdrReference;
  live: LivePresence;
}
export class ConciergeBlockedError extends Error {
  constructor() {
    super("管家正在等待交互输入。请打开管家现场，完成或关闭当前提示后再重试。");
    this.name = "ConciergeBlockedError";
  }
}
export const herdrRunner = (
  executable: string,
  session = "crewvane",
): HerdrRunner => ({
  async run(args, timeout = 30_000) {
    try {
      const result = await exec(executable, args, {
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, HERDR_SESSION: session },
      });
      return result.stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      let detail = stderr.trim();
      try {
        const data = JSON.parse(stderr);
        detail = JSON.stringify(data.error ?? data);
      } catch {
        /* keep stderr */
      }
      throw new Error(
        `Herdr ${args.slice(0, 2).join(" ")}：${detail || (error as Error).message}`,
      );
    }
  },
});
function payload(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Herdr 返回了无法读取的结果：${raw.slice(0, 300)}`);
  }
}
function named(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
export const quoteShell = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;
// Unknown CLIs can use canonical TTY input (macOS MAX_CANON is 1024 bytes).
// Keep each line below the limit without breaking a Unicode code point.
export function terminalPrompt(text: string) {
  return text.split("\n").map(line => {
    const lines: string[] = [];
    let current = "", bytes = 0;
    for (const character of line) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 768) { lines.push(current); current = ""; bytes = 0; }
      current += character; bytes += length;
    }
    return [...lines, current].join("\n");
  }).join("\n");
}
function agents(raw: string): any[] {
  const data = payload(raw),
    list = data.result?.agents ?? data.agents ?? data;
  if (!Array.isArray(list)) throw new Error("Herdr 没有返回 Agent 列表");
  return list;
}
function livePresence(agent: any, checkedAt: string): LivePresence {
  const state =
    agent?.agent_status ?? agent?.state ?? agent?.status ?? agent?.lifecycle;
  return {
    state: ["working", "idle", "done", "blocked", "unknown"].includes(state)
      ? state
      : "unknown",
    checkedAt,
    reachable: true,
  };
}
const conciergeRole = "管家是控制面角色，只负责当前案卷的目标分发、协调跟进和向人交接，不亲自执行目标。所有需要执行的目标，无论大小，都必须交给独立负责人；已有负责人时复用原现场。首次创建负责人必须使用 crewvane owner launch <目标ID> --name <负责人名称> --json；它会读取已保存的目标详情和下一步，隔离环境、启动用户配置的 Agent、绑定现场并发送任务，禁止手工串联 Herdr 命令。命令行单次输入通常只有约 1 KB；不要把完整任务塞进 --task，确有必要补充长说明时先写入当前工作区内文件并使用 --task-file。给已有负责人发送后续任务时使用 herdr agent prompt <名称> \"<完整任务>\" --wait --until working，只等到负责人开始工作；返回 agent_prompt_stalled 时先核对现场与会话，禁止未经核对就重复发送。你可以读取当前案卷和目标关联项目信息，记录下一步、等待与提醒，创建或联系负责人，核对负责人提供的成果和检查记录，按决定账本避免重复打扰，并通过唯一出口向人汇总或请求决定。用户明确说出完成、结束、放弃、验收通过、批准或拒绝后，你可以依据原话执行当前目标的状态命令；结束类命令必须把用户原话原样写入 --note 或 --reason。用户语义含糊时只问一个具体问题，禁止猜测或擅自结束。禁止调查业务代码、编写或修改目标成果、运行项目命令或测试，也不得在负责人阻塞或失败时替其补做任务。用户提问和负责人答复不是普通进度；负责人回复咨询时必须把完整、具体的答案通过 crewvane goal progress 写回当前目标。你向人转述时也必须写回答案正文，不得只写「已回答」「已回复」或空洞摘要。即使无需执行，也要让人在目标详情直接读懂答案、依据和下一步。";
export function conciergeInstructions(root: string, preferences: AgentPreferences = { concierge: "codex" }, session = "crewvane"): string {
  return `这是 Crewvane 管家的身份初始化，不是案卷任务。现在没有当前案卷；不要运行 goal list、attention、status 或任何 Crewvane 写命令，不要创建负责人，也不要猜测、汇总或处理任何目标。只记住以下长期职责，回复 CREWVANE_CONCIERGE_READY，然后立即结束本回合。

你是 Crewvane 的控制面管家。用户只需要一个入口，但你的每次案卷通知只处理一个明确案卷。

${conciergeRole}

工作区：${root}
不要主动运行 goal list、attention，也不要搜索、比较或汇总其他目标。每次通知会给出唯一案卷 ID、当前状态和本次变化；只处理这个 ID。历史消息只用于理解系统协议，不能作为当前目标事实；案卷之间出现相似标题、相同项目或顺承措辞也不是同一件事。拿不准时停止切换目标，通过当前目标请求人澄清。Crewvane CLI 会在受管模式拒绝访问其他目标，不要尝试绕过。
用户只需用自然语言交代事情；桌面会先保存案卷再通知你，不需要你创建。目标事实只以当前案卷快照和 crewvane goal show <当前ID> --json 为准。你和负责人负责写回下一步、等待对象和提醒，不得要求人去桌面填写这些表单。
用户在 Herdr 终端直接对你说、且消息不以 [CREWVANE_CASE_BEGIN] 开头的也是用户输入。收到这类直接消息后，必须先把它同步回 Crewvane 再执行或回复：明确的新事项运行 crewvane direct --new "<用户原话>"；补充或修改已有目标运行 crewvane direct --goal <真实目标ID> "<用户原话>"，当前 scope 已指向该目标时可用 crewvane direct --current "<用户原话>"。direct 只追加人的原话，不改变状态或下一步；协调后确有状态变化时再单独使用明确的结构化命令。不能在终端里处理完却不写回 App。若无法判断是新事项还是某个已有目标，先通过对话让用户明确，不猜测归属。
用户在 Herdr 直接消息中粘贴图片时，先把终端提供的本地图片文件保留或复制到工作区，并立即在上面的 direct 命令后追加 --attachment <真实图片路径>；CLI 会校验格式、复制到 .crewvane/attachments 并把元数据写回 App。不能只把图片留在聊天上下文里，也不能把 Base64 写进 state.json。若当前 Agent 无法取得可复制的本地文件，明确请用户回到 Crewvane 新目标输入框从本机粘贴或选择图片，不静默丢图。
Agent 默认启动命令：管家 ${preferences.concierge}，负责人 ${preferences.owner || preferences.concierge}，工人 ${preferences.worker || preferences.owner || preferences.concierge}。分工前运行 crewvane status --json 读取最新 agents 偏好；未设置的角色继承上一级。用户明确指定的启动命令优先。必须执行用户配置的 CLI 与完整原生参数，保留模型等选项，不得因为不在 Herdr kind 名单而拒绝或换工具。Herdr 识别的 CLI 可用 agent start --kind，参数放在 -- 后；绝对路径须将该目录放在 Pane 的 PATH 首位。不识别的自定义交互式 CLI 则用 pane run <真实PaneID> "<正确转义后的启动命令>" 启动，用 pane process-info --pane <ID> 核实前台 PID，在 crewvane session set 时额外传 --transport pane --process-id <真实PID>。后续发消息前再次核实原进程仍在前台，再用 pane run <ID> "<任务文本>" 原子发送文本和 Enter；程序退出后禁止将任务发送给 shell。自定义 CLI 无生命周期报告时状态为 unknown，不伪造 idle、working 或完成。没有指定模型时沿用该 CLI 自身配置。
创建独立负责人时必须调用 crewvane owner launch <目标ID> --name <负责人名称> --json。这条受控命令会在当前 Herdr Session 创建独立 Tab，读取已保存的完整目标原文与下一步，清除管家继承的案卷限制，设置负责人署名与真实工作区/Pane 环境，按用户保存的 Agent 启动命令和全部原生参数启动 CLI，核实进程或 Agent 已就绪，把真实现场原子绑定到目标，再发送完整任务并等到 working。命令行输入通常只有约 1 KB，不要把完整任务放进 --task；需要追加长背景时，先用文件工具写入当前工作区内文件，再传 --task-file。不要手工串联 tab create、pane run、agent start、session set；它们容易继承错误环境并把任务送进错误工作区。命令返回 agent_prompt_stalled 时表示任务已经提交但未及时观察到 working，现场已保留，必须先核对 Agent 输出，禁止重复发送。不要给任何 Agent CLI 注入 Codex 或其他运行时专属的沙箱参数；权限取决于用户配置的 CLI 和该 CLI 自身机制。Crewvane 的案卷边界只约束 Crewvane CLI 可读取和写入的目标，不是操作系统文件隔离，不要宣称它已阻止负责人直接访问文件系统。

你的职责：
1. 把目标整理成清晰的下一步；需要执行时，必须在当前 Herdr Session 的对应目标 Tab 中创建或复用独立负责人。给已识别的 Agent 发送任务时使用 herdr agent prompt <名称> "<完整任务>" --wait --until working，只等到负责人开始工作，不等待整个工程结束。不能因为任务简单而自己执行。若返回 agent_prompt_stalled，Herdr 可能已经把内容写入现场，先读取 Agent 状态、会话与现场输出，禁止未经核对就重复发送同一任务。
2. 一个目标对应一个 Herdr Tab。首次派发只调用 crewvane owner launch；已有负责人时复用原现场，不再创建 Tab 或覆盖绑定。
3. 只把当前案卷的项目规则和完整任务上下文交给负责人，不向其他负责人复制或转述其他案卷内容。负责人遇到问题先自己解决；解决不了由你澄清要求、调整分工或联系其他负责人，不能接手执行。只有协调后仍需要人的决定时，才通过 crewvane goal decide <ID> --question "<具体问题>" 请求人决定；调用的 CLI 会先查共享决定账本，命中即可直接沿用，不再提问。常规实现选择不要反复向人确认。
4. 每次实质进展用 crewvane goal progress <ID> --summary "<实际结果>" --next "<下一步>"。用户问的是解释、咨询或判断而无需执行时，负责人仍须把完整答案当作实际结果写回；不得只写「已回答」。等待他人用 crewvane goal wait <ID> --reason "<等待事项>" --owner "<对象>" [--remind-at <ISO时间>]。人在桌面或 Herdr 面板发来的自由回复由 Crewvane 通过 goal.message 写回；你收到 event=feedback 时必须读取新增消息并据此协调。只有用户明确表达继续推进、继续等待、验收通过、批准、拒绝、完成或放弃时，才可执行对应的 progress、wait、accept、complete、rework、drop、resolve 或 remind 命令；把用户原话完整写入结束或决定命令的 --note / --reason。自由文本不会自动改状态，语义含糊时先问一个具体问题，禁止从顺承词或一般认可中猜测。
5. 由负责人产出真实成果、实际运行检查并用 crewvane goal review <ID> --summary "<成果>" [--location <位置>] [--url <https链接>] --check "名称::实际命令或操作::passed::真实结果" 提交交付。你核对交付是否附有成果位置和真实检查记录，缺失则退回负责人补齐，齐备后向人交接验收；不得代写成果、代跑检查或代替人验收。Herdr 的 done/idle 不表示目标完成。
6. 合并或部署前运行 crewvane goal ship <ID> --operation merge|deploy --checks passed|failed，并严格服从返回的 allowed 与 requiresHuman。项目默认 external-approval；Agent 不得直接修改项目上线策略。删除数据、停服、花钱、向外部发消息、改变产品方向、新建或轮换密钥、修改权限或建议修改上线策略时，即使项目 policy=auto 也必须先运行 crewvane goal risk <ID> --category <类型> --summary "<动作>"，等人在 Crewvane 决定。所有找人消息只从当前案子经你发出。
7. verifier 对同一 PR 最多审 3 轮，只报会导致错误的问题，不报风格建议；第四轮必须升级给人。请人决定前必须用 crewvane goal decide，它会自动查决定账本；命中时不得再次提问。不得伪造 CLI、审查、检查或上线结果。
8. owner launch 已原子保存真实现场并发送任务，不要再运行 session set 或覆盖绑定。给已有负责人发消息不要长时间阻塞等待整项工程完成；确认消息已被接收后继续统筹其他目标，通过 crewvane 状态和 Herdr agent get 检查进展。负责人遇到问题或交付时也及时用 crewvane 写回。

每个通知回合完成当前案卷的分发、写回或交接后必须立即结束。不要创建后台任务、长等待命令、循环轮询或等待负责人完成；负责人后续进展由新的巡检通知或现场事件唤醒。同一个管家会按案卷串行接收通知，悬挂的旧回合会让下一条通知串入错误的案卷范围。

身份初始化只回复 CREWVANE_CONCIERGE_READY。后续只有收到带 case_id 的案卷通知时才执行分发、跟进或交接，不需要用户再次确认常规分工。`;
}
export class HerdrClient {
  constructor(
    readonly runner: HerdrRunner,
    readonly session = "crewvane",
    readonly workspaceRoot = "",
    readonly startSession?: () => Promise<void>,
  ) {}
  private async foreground(paneId: string) {
    const data = payload(await this.runner.run(["pane", "process-info", "--pane", paneId]));
    const info = data.result?.process_info ?? data.process_info;
    if (!info || !Array.isArray(info.foreground_processes)) throw new Error("无法核实自定义 CLI 的前台进程");
    return info.foreground_processes.filter((process: any) => process.pid !== info.shell_pid) as { pid: number }[];
  }
  private async rawAlive(reference: HerdrReference) {
    return !!reference.paneId && !!reference.processId &&
      (await this.foreground(reference.paneId)).some(process => process.pid === reference.processId);
  }
  private async prompt(reference: HerdrReference, text: string, waitForSettlement = true, timeout?: number) {
    if (reference.transport === "pane") {
      if (!await this.rawAlive(reference))
        throw new Error("自定义 Agent 已退出或现场已更换，未发送任务。请重新准备管家。");
      // pane run submits literal text + Enter atomically (including bracketed
      // paste handling). Never fall back to sending a task to an idle shell.
      await this.runner.run(["pane", "run", reference.paneId!, terminalPrompt(text)]);
      // An arbitrary CLI has no trustworthy lifecycle signal. Give its
      // terminal input loop a short turn before the next case is queued.
      await delay(750);
    } else {
      if (!reference.agent) throw new Error("管家尚未准备好");
      try {
        await this.runner.run([
          "agent", "prompt", reference.agent, text,
          ...(waitForSettlement ? ["--wait"] : []),
          ...(timeout ? ["--timeout", String(timeout)] : []),
        ], timeout ? timeout + 5000 : waitForSettlement ? 0 : undefined);
      } catch (error) {
        if (/\bagent_blocked\b/.test(String(error)))
          throw new ConciergeBlockedError();
        // Herdr can submit the prompt before its five-second lifecycle probe
        // observes the agent transition. Retrying would duplicate the task.
        // Treat only this known case as delivered; later plugin events and the
        // watchdog still decide whether work progressed or needs recovery.
        if (/\bagent_prompt_stalled\b/.test(String(error))) {
          await delay(750);
          return;
        }
        throw error;
      }
    }
  }
  async inspectConcierge(existing?: HerdrReference): Promise<ConciergeSite | undefined> {
    await this.ensureSession();
    const checkedAt = new Date().toISOString();
    const sameSession = existing?.session === this.session;
    if (sameSession && existing.transport === "pane" &&
      existing.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      try {
        if (await this.rawAlive(existing))
          return {
            reference: existing,
            live: { state: "unknown", checkedAt, reachable: true },
          };
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error))) throw error;
      }
    }
    const listed = agents(await this.runner.run(["agent", "list"]));
    if (sameSession && existing?.launchPolicy === CONCIERGE_LAUNCH_POLICY) {
      // Pane and tab IDs survive an agent exit. They identify a terminal
      // location, not the concierge process. Require the exact governed agent
      // name and preserve the new IDs when Herdr reports a pane move.
      const live = listed.find(agent => agent.name === existing.agent);
      if (!live) return;
      const paneId = named(live.pane_id) ?? existing.paneId;
      let processId = existing.processId;
      if (paneId) {
        try {
          const running = await this.foreground(paneId);
          if (processId) {
            if (!running.some(process => process.pid === processId)) return;
          } else {
            processId = running[0]?.pid;
          }
        } catch {
          // A persisted PID is the stronger identity. If it cannot be verified,
          // recover instead of sending a command to a possibly replaced pane.
          if (processId) return;
        }
      }
      return {
        reference: {
          ...existing,
          workspaceId: named(live.workspace_id) ?? existing.workspaceId,
          tabId: named(live.tab_id) ?? existing.tabId,
          paneId,
          ...(processId === undefined ? {} : { processId }),
        },
        live: livePresence(live, checkedAt),
      };
    }
    // Without a persisted control-plane reference, provenance is unknown.
    // Never close or reuse a same-named process the user may have started.
    return;
  }
  async findConcierge(existing?: HerdrReference): Promise<HerdrReference | undefined> {
    return (await this.inspectConcierge(existing))?.reference;
  }
  async ensureSession(): Promise<void> {
    try {
      agents(await this.runner.run(["agent", "list"]));
      return;
    } catch (error) {
      if (!String(error).includes("server_not_running") || !this.startSession)
        throw error;
    }
    await this.startSession();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        agents(await this.runner.run(["agent", "list"], 2000));
        return;
      } catch (error) {
        if (!String(error).includes("server_not_running")) throw error;
      }
      await delay(250);
    }
    throw new Error(
      "Herdr 会话未能启动。请在应用内重新连接现场，再点「准备管家」重试。",
    );
  }
  async ensureWorkspace() {
    const listed = payload(await this.runner.run(["workspace", "list"])),
      workspaces = listed.result?.workspaces ?? listed.workspaces;
    if (Array.isArray(workspaces) && workspaces.length) return;
    await this.runner.run([
      "workspace", "create",
      "--cwd", this.workspaceRoot,
      "--label", "Crewvane",
      "--focus",
    ], 60_000);
  }
  async prepareConcierge(
    root: string,
    existing?: HerdrReference,
    kind = "codex",
    cliDirectory = "",
    localBin = "/usr/local/bin",
    agentBin = "/usr/local/bin",
    onReference?: (reference: HerdrReference) => Promise<void>,
    preferences?: AgentPreferences,
    nativeArgs: string[] = [],
    executable?: string,
    cliBin = "",
  ): Promise<HerdrReference> {
    const concierge = await this.findConcierge(existing);
    if (concierge) return concierge;
    let workspaceId: string | undefined,
      tabId: string | undefined,
      paneId: string | undefined;
    if (existing?.session === this.session && existing.paneId) {
      try {
        const current = payload(
          await this.runner.run(["pane", "get", existing.paneId]),
        );
        const pane = current.result?.pane ?? current.pane;
        if (pane?.pane_id === existing.paneId) {
          // A closed concierge can leave its tab and shell behind. Reuse only
          // that empty shell pane; never replace a manual agent in the same pane.
          if ((await this.foreground(existing.paneId)).length === 0) {
            workspaceId = existing.workspaceId;
            tabId = existing.tabId;
            paneId = existing.paneId;
          }
        }
      } catch (error) {
        if (!/not_found|invalid_pane|unknown_pane/.test(String(error)))
          throw error;
      }
    }
    if (!workspaceId || !tabId || !paneId) {
      const controlRoot = join(this.workspaceRoot, ".crewvane");
      const created = payload(
        await this.runner.run(
          [
            "workspace",
            "create",
            "--cwd",
            controlRoot,
            "--label",
            "Crewvane · 全局工作台",
            "--no-focus",
          ],
          60_000,
        ),
      );
      const result = created.result ?? created;
      workspaceId =
        named(result.workspace?.workspace_id) ?? named(result.workspace?.id);
      tabId = named(result.tab?.tab_id) ?? named(result.tab?.id);
      paneId = named(result.root_pane?.pane_id) ?? named(result.root_pane?.id);
    }
    if (!workspaceId || !tabId || !paneId)
      throw new Error("Herdr 没有返回管家所需的真实会话 ID");
    const reference: HerdrReference = {
      session: this.session,
      workspaceId,
      tabId,
      paneId,
      agent: "concierge",
      launchPolicy: CONCIERGE_LAUNCH_POLICY,
      ...(!kind && executable ? { transport: "pane" as const } : {}),
    };
    await onReference?.(reference);
    await this.runner.run(["tab", "focus", tabId]);
    const cliRoot = cliBin || cliDirectory || `${root}/.crewvane/bin`;
    const cliPath = `${cliRoot}:${localBin}:${agentBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
    const environment = `export HOME=${quoteShell(process.env.HOME || "")} XDG_CONFIG_HOME=${quoteShell(process.env.XDG_CONFIG_HOME || "")} XDG_STATE_HOME=${quoteShell(process.env.XDG_STATE_HOME || "")} CREWVANE_AGENT_NAME=concierge CREWVANE_WORKSPACE=${quoteShell(root)} CREWVANE_COORDINATOR=1 CREWVANE_COORDINATOR_SCOPE_FILE=${quoteShell(join(root, ".crewvane", "coordinator-scope.json"))} HERDR_SESSION=${quoteShell(this.session)} HERDR_ENV=1 HERDR_WORKSPACE_ID=${quoteShell(workspaceId)} HERDR_TAB_ID=${quoteShell(tabId)} HERDR_PANE_ID=${quoteShell(paneId)} PATH=${quoteShell(cliPath)}:"$PATH"; printf '\\n__CREWVANE_ENV_READY__\\n'`;
    await this.runner.run(["pane", "run", paneId, environment]);
    await this.runner.run(["pane", "wait-output", paneId, "--match", "__CREWVANE_ENV_READY__", "--timeout", "10000"], 15_000);
    if (!kind && executable) {
      await this.runner.run(["pane", "run", paneId, [executable, ...nativeArgs].map(quoteShell).join(" ")]);
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const running = await this.foreground(paneId);
        if (running.length) {
          reference.transport = "pane";
          reference.processId = running[0]!.pid;
          await onReference?.(reference);
          await this.prompt(reference, conciergeInstructions(root, preferences, this.session), true);
          return reference;
        }
        await delay(200);
      }
      throw new Error("自定义 Agent 未保持运行。请打开现场检查启动命令、登录或配置。");
    }
    await this.runner.run(
      [
        "agent",
        "start",
        "concierge",
        "--kind",
        kind,
        "--pane",
        paneId,
        ...(nativeArgs.length ? ["--", ...nativeArgs] : []),
      ],
      60_000,
    );
    await this.prompt(reference, conciergeInstructions(root, preferences, this.session), true, 180_000);
    const running = await this.foreground(paneId).catch(() => []);
    if (running[0]) {
      reference.processId = running[0].pid;
      await onReference?.(reference);
    }
    return reference;
  }
  async notifyGoal(
    reference: HerdrReference | undefined,
    goalId: string,
    title: string,
    goal?: Goal,
    workspaceRoot?: string,
  ) {
    if (!reference?.agent && reference?.transport !== "pane")
      throw new Error("管家尚未准备好，请先在设置中准备管家");
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    await this.prompt(reference,
      `${conciergeRole}
[CREWVANE_CASE_BEGIN]
case_id: ${goalId}
event: ${goal?.dispatch?.kind ?? "goal_update"}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal?.dispatch?.kind === "resume" ? `resume_note: ${goal.dispatch.note ?? ""}` : ""}
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, description: goal.description, projectId: goal.projectId, status: goal.status, next: goal.next, attentionRequest: attentionRequest(goal), sceneReply: goal.sceneReply, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : `title: ${title}`}
[CREWVANE_CASE_END]
${attachments.length ? `用户附带的图片是目标证据。把下列真实绝对路径连同任务交给负责人；负责人使用的 CLI 支持图片时，应实际查看图片再判断。不要声称看过图片，除非现场确有读取记录。\n${attachments.map(item => `attachment: ${item.absolutePath}`).join("\n")}\n` : ""}
${goal?.dispatch?.kind === "scene_reply" ? `这是负责人现场回执，不是新任务。用户已经在负责人会话中给出 sceneReply.quote；不要要求用户再回 App 重复回答，也不要重新派发已经执行的任务。
先重新读取 goal show，核对 attentionRequest.id 与 sceneReply.attentionId。若编号不一致，旧回执不得清除新问题。语义含糊则只追问缺少的信息。
若原问题已经有明确答复，根据原话调用 resolve（批准或拒绝）、accept（验收通过）、rework（退回）、complete（用户明确结束）、drop（放弃），或在确有新事实时 progress / wait / remind。结束或决定命令的 --note 必须使用 sceneReply.quote 原文；普通问题处理不能冒充成果验收。当前 CLI 自动绑定本回执编号，拒绝迟到或被替换的回执。单纯补充进展不能关闭旧决定；请明确解决对应事项。核对完成后结束本回合，不轮询等待。` : ""}
请用 crewvane goal show ${goalId} --json 读取当前案卷，并用 crewvane status --json 查看 Agent 默认偏好与当前关联项目。若目标尚未登记负责人现场，根据 description 中的完整原文整理标题、背景、完成标准与下一步；没有充分依据则保留个人事项，不猜测范围。整理后交给本目标独立负责人；退回修改转交原负责人；交付齐备则向人交接。若本次是 feedback，先读取新增的人发消息，再按原话协调负责人；自由回复不会自动改状态，只有明确语义才可执行当前案卷的 progress、wait、accept、complete、rework、drop、resolve 或 remind，并在结束或决定命令中保留用户原话。若人已经验收或放弃，请通知负责人停止该目标的工作，不再派发。`,
    );
  }
  async notifyFollowUp(reference: HerdrReference, goalId: string, note: string, goal?: Goal, workspaceRoot?: string) {
    const attachments = (goal?.attachments ?? []).map(item => ({
      ...item,
      absolutePath: workspaceRoot ? attachmentAbsolutePath(workspaceRoot, item) : item.path,
    }));
    await this.prompt(reference,
      `${conciergeRole}
[CREWVANE_CASE_BEGIN]
case_id: ${goalId}
event: follow_up
note: ${note}
policy: 只允许处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标
${goal ? `snapshot:
${JSON.stringify({ id: goal.id, title: goal.title, projectId: goal.projectId, next: goal.next, waitingFor: goal.waitingFor, remindAt: goal.remindAt, attachments, latestActivities: goal.activities.slice(-8) }, null, 2)}` : ""}
[CREWVANE_CASE_END]
请用 crewvane goal show ${goalId} --json 读取实际等待对象与提醒安排，联系原负责人核查进展并写回结果。保持等待状态和跟进提醒，不把催办当作等待已结束；没有真实新结果时不得用 goal progress 恢复执行。需要人决定时提出具体问题，不亲自执行业务，也不自动向外部人员发送消息。`,
    );
  }
  async refreshConcierge(reference: HerdrReference, root: string, preferences?: AgentPreferences) {
    await this.prompt(reference, conciergeInstructions(root, preferences, this.session), true);
  }
  async requestSceneReply(goal: Goal): Promise<boolean> {
    const reference = goal.herdr, question = attentionRequest(goal);
    if (!reference?.agent || reference.session !== this.session ||
      reference.transport === "pane" || !question) return false;
    const listed = agents(await this.runner.run(["agent", "list"]));
    const entry = listed.find(candidate =>
      (candidate.name ?? candidate.agent) === reference.agent &&
      candidate.pane_id === reference.paneId);
    const state = entry?.agent_status ?? entry?.state ?? entry?.status ?? entry?.lifecycle;
    if (!entry || !["idle", "done"].includes(state)) return false;
    await this.prompt(reference, `[CREWVANE_SCENE_CHECK]
这是系统协议核对，不是用户的新回复，不是继续执行的授权。
当前目标 ${goal.id}，待处理事项 ${question.id}：${question.summary}
用户曾打开本目标现场，随后观察到一次工作回合结束。这个事实不证明用户已经回答问题。
请只核对你自己会话中最近的真实用户交互：若已明确回答当前事项且尚未写回，保存原话和结果；若没有、含糊或无法确认，保留待处理并立即结束，不凭空生成回执。不要重复提问，不做额外业务工作。
${ownerSceneReplyInstructions(goal.id)}
[/CREWVANE_SCENE_CHECK]`, true, 120_000);
    return true;
  }
  async open(reference: HerdrReference) {
    if (reference.tabId)
      await this.runner.run(["tab", "focus", reference.tabId]);
    else if (reference.agent)
      await this.runner.run(["agent", "focus", reference.agent]);
  }
  async closeGoal(reference: HerdrReference) {
    if (reference.session !== this.session)
      throw new Error("负责人现场属于其他 Herdr Session，不能自动关闭");
    const close = async (tabId: string) => {
      try {
        await this.runner.run(["tab", "close", tabId]);
        return true;
      } catch (error) {
        if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return false;
        throw error;
      }
    };
    if (reference.tabId && await close(reference.tabId)) return;
    const live = agents(await this.runner.run(["agent", "list"])).find(agent =>
      (!!reference.paneId && agent.pane_id === reference.paneId) ||
      (!!reference.workspaceId && agent.workspace_id === reference.workspaceId &&
        !!reference.agent && (agent.name === reference.agent || agent.agent === reference.agent)));
    if (!live?.tab_id) return;
    try {
      await this.runner.run(["tab", "close", live.tab_id]);
    } catch (error) {
      if (/not_found|invalid_tab|unknown_tab/.test(String(error))) return;
      throw error;
    }
  }
  async notifyWatchdog(reference: HerdrReference, issues: { goalId: string; reason: string }[]) {
    if (!reference.agent && reference.transport !== "pane") throw new Error("管家尚未准备好，请先连接管家");
    const reasons: Record<string, string> = { blocked: "负责人正在等待输入或批准", missing: "负责人会话暂时不可达", stale: "目标 30 分钟没有写回实质进展", unassigned: "目标尚未登记独立负责人现场，请先创建并启动负责人，保存真实现场再发送任务" };
    for (const issue of issues) await this.prompt(reference,
      `${conciergeRole}\n[CREWVANE_CASE_BEGIN]\ncase_id: ${issue.goalId}\nevent: watchdog\nissue: ${reasons[issue.reason] ?? issue.reason}\npolicy: 只处理上方案卷；忽略此前案卷的内容；不得读取或修改其他目标\n[CREWVANE_CASE_END]\n这是后台巡检，不是用户新增任务。请先用 crewvane goal show ${issue.goalId} 读取实际记录，检查真实负责人现场并主动联系负责人，通过澄清要求、调整分工或联系其他负责人协调恢复，不能自己接手执行。写回实际协调进展，不把终端安静或 idle 当作失败或完成。确实必须由人决定时才用 goal decide 提出具体问题；不要让人填写进度表。已等待他人、已交付或已结束的目标不要重新启动。`,
    );
  }
  async presences(
    goals: { id: string; herdr?: HerdrReference }[],
  ): Promise<Record<string, LivePresence>> {
    const entries = agents(await this.runner.run(["agent", "list"]));
    const result: Record<string, LivePresence> = {};
    for (const goal of goals) {
      if (goal.herdr?.transport === "pane") {
        const reachable = await this.rawAlive(goal.herdr).catch(() => false);
        result[goal.id] = { state: "unknown", checkedAt: new Date().toISOString(), reachable };
        continue;
      }
      if (!goal.herdr?.agent) continue;
      const agent = entries.find(
        (entry) =>
          entry.name === goal.herdr?.agent ||
          entry.agent === goal.herdr?.agent ||
          entry.pane_id === goal.herdr?.paneId,
      );
      if (!agent) {
        result[goal.id] = { state: "unknown", checkedAt: new Date().toISOString(), reachable: false };
        continue;
      }
      const state =
        agent.agent_status ?? agent.state ?? agent.status ?? agent.lifecycle;
      if (["working", "idle", "done", "blocked", "unknown"].includes(state))
        result[goal.id] = { state, checkedAt: new Date().toISOString(), reachable: true };
    }
    return result;
  }
}
