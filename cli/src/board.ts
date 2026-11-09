import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { emitKeypressEvents } from "node:readline";
import { promisify } from "node:util";
import {
  attentionGoals,
  attentionKind,
  type AttentionKind,
  type Goal,
  type IntakeHandling,
  type WorkspaceService,
  type WorkspaceState,
} from "../../packages/core/src/index.js";

const exec = promisify(execFile);
const ESC = "\x1b[";
const kindLabel: Record<AttentionKind, string> = {
  decision: "决定",
  review: "验收",
  follow_up: "跟进",
  intervention: "介入",
};

export interface BoardOptions {
  once?: boolean;
  startWithNewGoal?: boolean;
}

export interface BoardSink {
  out(text: string): void;
  error(text: string): void;
}

function openGoals(state: WorkspaceState) {
  const priority = new Map<string, number>();
  for (const goal of attentionGoals(state.goals))
    priority.set(goal.id, 0);
  return state.goals
    .filter(goal => !["completed", "dropped"].includes(goal.status))
    .sort((left, right) =>
      (priority.get(left.id) ?? (left.status === "waiting" ? 1 : 2)) -
      (priority.get(right.id) ?? (right.status === "waiting" ? 1 : 2)) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function truncate(value: string, width: number) {
  const plain = value.replace(/\s+/g, " ").trim();
  return plain.length <= width ? plain : `${plain.slice(0, Math.max(0, width - 1))}…`;
}

function attentionMarker(goal: Goal) {
  const kind = attentionKind(goal);
  if (kind) return kindLabel[kind];
  if (goal.status === "backlog") return "暂";
  if (goal.mode === "manual") return "我";
  return goal.status === "waiting" ? "等" : "行";
}

export function renderBoard(state: WorkspaceState, selectedId?: string, message?: string) {
  const goals = openGoals(state), attention = attentionGoals(state.goals);
  const waiting = goals.filter(goal => goal.status === "waiting" && !goal.attention).length;
  const deferred = goals.filter(goal => goal.status === "backlog").length;
  const personal = goals.filter(goal => goal.mode === "manual" && goal.status !== "backlog").length;
  const active = goals.filter(goal => goal.mode === "concierge" && goal.status === "active" && !attention.includes(goal)).length;
  const lines = [
    `${ESC}38;5;111m╭────────────────────────────────────────────────────────────╮${ESC}0m`,
    `${ESC}38;5;111m│${ESC}0m  ${ESC}1mCREWVANE${ESC}0m  ${ESC}38;5;79m注意力控制台${ESC}0m  ${ESC}2mHerdr plugin${ESC}0m                 ${ESC}38;5;111m│${ESC}0m`,
    `${ESC}38;5;111m╰────────────────────────────────────────────────────────────╯${ESC}0m`,
    `  ${ESC}38;5;214m${attention.length} 件需要你${ESC}0m   ${ESC}38;5;110m${waiting} 件在等${ESC}0m   ${ESC}2m${active} 件推进中 · ${deferred} 件暂存 · ${personal} 件我来做${ESC}0m`,
    "",
  ];
  if (!goals.length) {
    lines.push(`${ESC}2m还没有目标。按 n 用一句话交给 Crewvane。${ESC}0m`);
  } else {
    for (const goal of goals) {
      const selected = goal.id === selectedId;
      const color = goal.attention
        ? (goal.attention.kind === "intervention" ? "203" : goal.attention.kind === "review" ? "214" : "111")
        : goal.status === "waiting" ? "110" : "244";
      lines.push(
        ` ${selected ? `${ESC}38;5;${color}m▶${ESC}0m` : " "} ${ESC}38;5;${color}m[${attentionMarker(goal)}]${ESC}0m  ${selected ? `${ESC}1m` : ""}${truncate(goal.title, 48)}${selected ? `${ESC}0m` : ""}`,
        `       ${ESC}2m${truncate(goal.attention?.summary || goal.next, 70)}${ESC}0m`,
      );
    }
  }
  const selected = goals.find(goal => goal.id === selectedId);
  if (selected) {
    const projectRecord = state.projects.find(item => item.id === selected.projectId),
      project = projectRecord?.name ?? "个人事项";
    const owner = selected.owner || "待分配负责人";
    lines.push(
      "",
      `${ESC}38;5;111m── 当前事项 ────────────────────────────────────────────────${ESC}0m`,
      `  ${selected.title}`,
      `  ${ESC}2m${project} · ${selected.status} · ${owner} · 上线 ${projectRecord?.policy?.shipPolicy ?? "external-approval"} · 审查 ${selected.reviewRounds ?? 0}/${selected.reviewLimit ?? 3}${ESC}0m`,
      `  ${selected.next}`,
    );
    if (selected.risk)
      lines.push(`  ${ESC}38;5;203m风险${ESC}0m ${selected.risk.summary}`);
    if (selected.delivery) {
      lines.push(`  ${ESC}38;5;214m交付${ESC}0m ${selected.delivery.summary}`);
      for (const check of selected.delivery.checks.slice(0, 3))
        lines.push(`  ${check.result === "passed" ? `${ESC}38;5;79m✓` : `${ESC}38;5;203m✗`} ${check.name}${ESC}0m ${ESC}2m${check.command}${ESC}0m`);
    }
  }
  const contextual = [
    ...(selected?.status === "waiting" || selected?.status === "backlog" || selected?.mode === "manual"
      ? ["u 交给管家推进", "m 我来处理"] : []),
    ...(selected?.status === "review" ? ["a 验收通过", "r 退回修改"] : []),
    ...(selected?.mode === "manual" && selected.status !== "backlog" && selected.status !== "review" ? ["a 标记完成"] : []),
  ];
  lines.push("", ...(message ? [`  ${ESC}38;5;79m${message}${ESC}0m`, ""] : []),
    `${ESC}2m↑↓ 选择  enter 详情  n 新目标  c 补充/决定  f 跟进  o 打开现场  g 回到管家${ESC}0m`,
    `${ESC}2mt 先记下  p 我来做${ESC}0m`,
    `${ESC}2m${contextual.length ? `${contextual.join("  ")}  ` : ""}q 关闭${ESC}0m`);
  return lines.join("\n");
}

export function renderBoardPlain(state: WorkspaceState, selectedId?: string) {
  return renderBoard(state, selectedId).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function prompt(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  label: string,
  raw: () => void,
) {
  input.setRawMode?.(false);
  output.write(`\n${label}`);
  const readline = createInterface({ input, output, terminal: true });
  try {
    return await new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      readline.once("SIGINT", () => { readline.close(); finish(null); });
      readline.question("", (value) => { readline.close(); finish(value.trim() || null); });
      readline.once("close", () => finish(null));
    });
  } finally {
    readline.close();
    raw();
  }
}

export async function runBoard(
  service: WorkspaceService,
  sink: BoardSink,
  options: BoardOptions = {},
  input = process.stdin,
  output = process.stdout,
) {
  if (options.once || !input.isTTY || !output.isTTY) {
    let state = await service.read();
    const selected = attentionGoals(state.goals)[0] ?? openGoals(state)[0];
    sink.out(renderBoardPlain(state, selected?.id));
    return;
  }

  let state = await service.read();
  let selectedId = (attentionGoals(state.goals)[0] ?? openGoals(state)[0])?.id;
  let message = "";
  let paused = Boolean(options.startWithNewGoal);
  let busy = false;
  let finished = false;
  let resolveFinished!: () => void;
  const done = new Promise<void>(resolve => { resolveFinished = resolve; });
  const selected = () => openGoals(state).find(goal => goal.id === selectedId);
  const setMessage = (value: string) => { message = value; redraw(); };
  const enableRaw = () => {
    input.setRawMode?.(true);
    input.resume();
  };
  const redraw = () => {
    if (finished || paused) return;
    output.write(`${ESC}?25l${ESC}H${ESC}2J${renderBoard(state, selectedId, message)}\n`);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    input.off("keypress", onKeypress);
    input.setRawMode?.(false);
    output.write(`${ESC}?25h${ESC}?1049l`);
    resolveFinished();
  };
  const act = async (task: () => Promise<string>) => {
    if (busy) return;
    busy = true;
    try {
      message = await task();
      state = await service.read();
      if (!selected()) selectedId = (attentionGoals(state.goals)[0] ?? openGoals(state)[0])?.id;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      redraw();
    }
  };
  const askText = (label: string) => prompt(input, output, label, () => {
    paused = false;
    enableRaw();
    redraw();
  });
  const createGoal = async (handling: IntakeHandling = "concierge") => {
    const text = await askText(`${ESC}38;5;111m${handling === "concierge" ? "要处理什么？" : "记下什么？"}${ESC}0m `);
    if (!text) return;
    await act(async () => {
      const goal = await service.execute({ type: "goal.intake", text, handling }) as Goal;
      selectedId = goal.id;
      return handling === "concierge" ? "已交给管家。Crewvane 打开时会自动派发，桌面未运行时请求会保留。"
        : handling === "later" ? "已暂存，不会启动 Agent。" : "已记录，由你安排，做完即可标记完成。";
    });
  };
  const comment = async () => {
    const goal = selected();
    if (!goal) return;
    const decision = goal.attention?.kind === "decision";
    const text = await askText(decision
      ? "你的决定（以“拒绝”开头会记入拒绝账本）： "
      : "补充意见： ");
    if (!text) return;
    await act(async () => {
      if (decision) {
        const rejected = /^(?:拒绝|拒绝执行|不要|不批准|不通过|reject|deny|\bno\b)/i.test(text);
        await service.execute({
          type: "goal.resolve", goalId: goal.id, note: text,
          outcome: rejected ? "rejected" : "approved", actor: "你", source: "herdr",
        });
      }
      else
        await service.execute({ type: "goal.message", goalId: goal.id, text, actor: "你" });
      return decision ? "决定已写入账本，正在交给管家。" : goal.mode === "concierge"
        ? "补充意见已保存，正在交给管家。" : "补充说明已记录，不会启动 Agent。";
    });
  };
  const followUp = async () => {
    const goal = selected();
    if (!goal) return;
    if (goal.status !== "waiting") return setMessage("只有等待中的事项可以请管家跟进。");
    const note = await askText("要请管家核查什么？可直接回车： ");
    await act(async () => {
      await service.execute({ type: "goal.followup", goalId: goal.id, note: note ?? undefined });
      return "跟进请求已保存，正在交给管家。";
    });
  };
  const resume = async (mode: "concierge" | "manual") => {
    const goal = selected();
    if (!goal) return;
    if (goal.status === "backlog" || goal.mode === "manual" && goal.status !== "waiting") {
      paused = false;
      await act(async () => {
        await service.execute({ type: mode === "concierge" ? "goal.delegate" : "goal.takeover", goalId: goal.id });
        return mode === "concierge" ? "已交给管家。" : "已记到我来做。";
      });
      return;
    }
    if (goal.status !== "waiting")
      return setMessage("只有等待中的事项可以继续推进。");
    const note = await askText("最新结果与下一步： ");
    if (!note) return;
    await act(async () => {
      await service.execute({ type: "goal.resume", goalId: goal.id, note, mode });
      return mode === "concierge" ? "已写回结果，正在交给管家继续。" : "已转为由你推进。";
    });
  };
  const accept = async () => {
    const goal = selected();
    if (!goal) return;
    if (goal.mode === "manual" && goal.status !== "backlog" && goal.status !== "review") {
      await act(async () => {
        await service.execute({ type: "goal.complete", goalId: goal.id, note: "你在 Herdr 注意力控制台确认完成。" });
        return "已完成。";
      });
      return;
    }
    if (goal.status !== "review")
      return setMessage("只有待验收事项可以验收通过。");
    await act(async () => {
      await service.execute({ type: "goal.accept", goalId: goal.id });
      return "成果已验收通过。";
    });
  };
  const rework = async () => {
    const goal = selected();
    if (!goal) return;
    if (goal.status !== "review")
      return setMessage("只有待验收事项可以退回修改。");
    const note = await askText("退回原因与要补齐的内容： ");
    if (!note) return;
    await act(async () => {
      await service.execute({ type: "goal.rework", goalId: goal.id, note });
      return "已退回修改，问题已写入下一步。";
    });
  };
  const openScene = async () => {
    const goal = selected();
    if (!goal) return;
    if (goal.mode === "manual" && !goal.herdr)
      return setMessage("这件事没有 Agent 现场；需要 Agent 执行时，请先交给管家。");
    if (process.env.HERDR_ENV !== "1")
      return setMessage("请从 Herdr 中的 Crewvane 面板打开现场。");
    const reference = goal.herdr ?? state.concierge;
    if (!reference.tabId) return setMessage("这个事项还没有可打开的 Herdr 现场。");
    await act(async () => {
      await exec(process.env.HERDR_BIN_PATH || "herdr", ["tab", "focus", reference.tabId!], { timeout: 10_000 });
      return "已切换到负责人现场。";
    });
  };
  const focusConcierge = async () => {
    if (!state.concierge.agent && state.concierge.transport !== "pane")
      return setMessage("管家还没有启动，请先在桌面点击「找管家」。");
    if (process.env.HERDR_ENV !== "1")
      return setMessage("请从 Herdr 中的 Crewvane 面板回到管家。");
    await act(async () => {
      await exec(process.env.HERDR_BIN_PATH || "herdr", ["agent", "focus", "concierge"], { timeout: 10_000 });
      return "已切换到全局管家。";
    });
  };
  const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }) => {
    if (paused || busy) return;
    const goals = openGoals(state);
    const current = Math.max(0, goals.findIndex(goal => goal.id === selectedId));
    if (key.name === "q" || (key.ctrl && key.name === "c")) return finish();
    if (key.name === "down" || key.name === "j") {
      selectedId = goals[Math.min(goals.length - 1, current + 1)]?.id;
      message = "";
      return redraw();
    }
    if (key.name === "up" || key.name === "k") {
      selectedId = goals[Math.max(0, current - 1)]?.id;
      message = "";
      return redraw();
    }
    if (key.name === "n") { paused = true; void createGoal(); return; }
    if (key.name === "t") { paused = true; void createGoal("later"); return; }
    if (key.name === "p") { paused = true; void createGoal("self"); return; }
    if (key.name === "c") { paused = true; void comment(); return; }
    if (key.name === "f") { paused = true; void followUp(); return; }
    if (key.name === "u") { paused = true; void resume("concierge"); return; }
    if (key.name === "m") { paused = true; void resume("manual"); return; }
    if (key.name === "a") { void accept(); return; }
    if (key.name === "r") { paused = true; void rework(); return; }
    if (key.name === "o") { void openScene(); return; }
    if (key.name === "g") { void focusConcierge(); return; }
    if (key.name === "return") {
      message = "";
      redraw();
    }
  };

  output.write(`${ESC}?1049h`);
  enableRaw();
  emitKeypressEvents(input);
  input.on("keypress", onKeypress);
  const timer = setInterval(() => {
    if (paused || busy) return;
    void service.read().then(next => {
      state = next;
      if (!selected()) selectedId = (attentionGoals(state.goals)[0] ?? openGoals(state)[0])?.id;
      redraw();
    }).catch(error => {
      message = error instanceof Error ? error.message : String(error);
      redraw();
    });
  }, 2_000);
  redraw();
  if (options.startWithNewGoal) {
    paused = false;
    await createGoal();
    if (!finished) redraw();
  }
  await done;
}
