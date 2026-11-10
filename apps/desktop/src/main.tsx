import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Folder,
  Inbox,
  LayoutDashboard,
  LayoutList,
  Moon,
  NotebookPen,
  Copy,
  Plus,
  Settings2,
  Sparkles,
  SquareTerminal,
  Sun,
  X,
  Zap,
} from "lucide-react";
import {
  attentionGoals,
  attentionKind,
  initialState,
  newId,
} from "../../../packages/core/src/model.js";
import { taskPoolGoals } from "../../../packages/core/src/task-pool.js";
import type {
  CrewvaneCommand,
  AgentPreferences,
  Goal,
  GoalAttachment,
  IntakeHandling,
  LiveState,
  Project,
  ShipPolicy,
  WorkspaceState,
} from "../../../packages/core/src/types.js";
import { api } from "./api.js";
import { GoalIntakeForm } from "./features/intake/GoalIntakeForm.js";
import { TaskPool } from "./features/tasks/TaskPool.js";
import { TaskDetail } from "./features/tasks/TaskDetail.js";
import { useReminderClock } from "./features/tasks/useReminderClock.js";
import { GoalDetail } from "./features/goals/GoalDetail.js";
import { GoalAttentionCard } from "./features/goals/GoalAttentionCard.js";
import { goalEntryDestination } from "./features/goals/goalEntry.js";
import { goalProgressLabel, presentSceneContext, sceneSyncPresentation } from "./features/goals/goalPresentation.js";
import type { GoalDetailService } from "./features/goals/goalService.js";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  IconButton,
  LoadingState,
  Modal,
  SectionHeading,
  Select,
  SettingsSection,
  StatusPill,
  TextArea,
  TextInput,
  Toggle,
} from "./ui/index.js";
import type { BadgeTone } from "./ui/index.js";
import type { WebhookSettings } from "../electron/webhook-notifications.js";
import pixelMark from "../assets/brand/crewvane-mage.png";
import "./style.css";
const HerdrTerminal = lazy(() => import("./terminal.js").then((module) => ({ default: module.HerdrTerminal })));
const pages = {
  home: "注意力",
  tasks: "待办池",
  goals: "全部目标",
  settings: "设置",
} as const;
const statusLabel = {
  backlog: "暂存",
  active: "跟进中",
  waiting: "等待外部",
  review: "待验收",
  completed: "已完成",
  dropped: "已放弃",
};
const goalStatusOptions = Object.entries(statusLabel) as [Goal["status"], string][];
const goalStatusTone: Record<Goal["status"], BadgeTone> = {
  backlog: "neutral",
  active: "mint",
  waiting: "warm",
  review: "accent",
  completed: "neutral",
  dropped: "neutral",
};
function goalRowTone(item: Goal): BadgeTone {
  const kind = attentionKind(item);
  if (kind === "decision") return "accent";
  if (kind === "review") return "mint";
  if (kind === "follow_up") return "warm";
  if (kind === "intervention") return "danger";
  if (item.recovery || item.watchdog?.contactedAt) return "warm";
  return goalStatusTone[item.status];
}
const attentionLabel = {
  decision: "需要你决定",
  review: "等待你验收",
  follow_up: "到点该跟进",
  intervention: "会话需要介入",
};
const conciergeLiveLabel: Record<LiveState, string> = {
  working: "管家处理中",
  idle: "管家在线",
  done: "管家已完成回合",
  blocked: "管家等待处理",
  unknown: "管家状态未知",
};
const time = (value?: string) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "";
function App() {
  const [state, setState] = useState<WorkspaceState>(initialState),
    [workspace, setWorkspace] = useState<string>(),
    [version, setVersion] = useState(""),
    [page, setPage] = useState<keyof typeof pages>("home");
  const [theme, setTheme] = useState<string>(
      localStorage.getItem("crewvane.theme") === "light" ? "light" : "dark",
    ),
    [collapsed, setCollapsed] = useState(() => localStorage.getItem("crewvane.sidebar-collapsed") === "true");
  const [projectId, setProjectId] = useState(""),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all");
  const [modal, setModal] = useState<
      "new" | "project" | "attention" | "goal" | "task" | "edit" | "delivery" | "workspace" | "webhook" | ""
    >(""),
    [goalId, setGoalId] = useState("");
  const [intakeHandling, setIntakeHandling] = useState<IntakeHandling>("concierge");
  const [taskSection, setTaskSection] = useState<"later" | "self">("later");
  const [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [pickingWorkspace, setPickingWorkspace] = useState(false),
    [herdr, setHerdr] = useState<any>(),
    [cli, setCli] = useState<any>(),
    [skills, setSkills] = useState<any>(),
    [webhook, setWebhook] = useState<WebhookSettings>({
      enabled: false,
      configured: false,
      tokenConfigured: false,
      statuses: goalStatusOptions.map(([value]) => value),
    });
  const [agentOptions, setAgentOptions] = useState<{ kind: string; installed: boolean }[]>([]);
  const [terminal, setTerminal] = useState<{ session: string; title: string; goalId?: string; visible: boolean }>();
  const stateRef = useRef(state);
  stateRef.current = state;
  useReminderClock(state.goals);
  const pendingState = useRef<{ state: WorkspaceState; signature: string } | undefined>(undefined);
  const stateFrame = useRef<number | undefined>(undefined);
  const lastStateSignature = useRef("");
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function applyState(next: WorkspaceState) {
    const signature = JSON.stringify(next);
    if (signature === lastStateSignature.current) return;
    pendingState.current = { state: next, signature };
    if (stateFrame.current !== undefined) return;
    stateFrame.current = requestAnimationFrame(() => {
      stateFrame.current = undefined;
      const pending = pendingState.current;
      if (!pending || pending.signature === lastStateSignature.current) return;
      lastStateSignature.current = pending.signature;
      setState(pending.state);
    });
  }
  const goal = state.goals.find((item) => item.id === goalId),
    project = state.projects.find((item) => item.id === projectId),
    hasConciergeReference = Boolean(state.concierge.tabId || state.concierge.agent),
    conciergeAvailable = state.concierge.status === "ready" && state.concierge.live?.reachable !== false,
    conciergeLive = state.concierge.status === "ready" ? state.concierge.live?.state : undefined,
    conciergeStatus = state.concierge.status === "ready"
      ? conciergeLive ? conciergeLiveLabel[conciergeLive] : "管家在线"
      : state.concierge.status === "error" ? "管家需要恢复" : "管家已离线";
  const attention = attentionGoals(state.goals),
    taskPoolCount = taskPoolGoals(state.goals, "later").length + taskPoolGoals(state.goals, "self").length,
    waiting = state.goals.filter(
      (item) => item.status === "waiting" && !attention.includes(item),
    );
  const active = state.goals.filter((item) => item.status === "active" && item.mode === "concierge"),
    selectedGoals = state.goals.filter(
      (item) =>
        (!projectId || item.projectId === projectId) &&
        (filter === "all" ||
          (filter === "attention"
            ? attention.includes(item)
            : item.status === filter)) &&
        `${item.title} ${item.next}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    );
  const sceneGoal = terminal?.goalId ? state.goals.find(item => item.id === terminal.goalId) : undefined;
  const sceneContext = sceneGoal ? presentSceneContext(sceneGoal, state) : undefined;
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("crewvane.theme", theme);
  }, [theme]);
  useEffect(() => { localStorage.setItem("crewvane.sidebar-collapsed", String(collapsed)); }, [collapsed]);
  useEffect(() => {
    api
      .environment()
      .then((env) => {
        setWorkspace(env.workspace);
        setVersion(env.version);
        if (env.workspace)
          return api.command({ type: "snapshot" }).then(applyState);
      })
      .catch(showError);
    const unsubscribe = api.subscribe((event) => {
      if (event.state) applyState(event.state);
      if (event.workspace) setWorkspace(event.workspace);
      if (event.type === "refresh") {
        setTerminal(undefined);
        void api.command({ type: "snapshot" }).then(applyState).catch(showError);
      }
      if (event.type === "diagnostic") setError(event.message);
      if (event.type === "herdr-status") setHerdr(event.status);
      if (event.type === "cli-status") setCli(event.status);
      if (event.type === "open-goal") openGoal(event.goalId);
      if (event.type === "terminal-available") {
        setTerminal(current => current?.session === event.session ? current : { session: event.session, title: event.title, visible: false });
      }
      if (event.type === "terminal-open") {
        setTerminal({ session: event.session, title: event.title, goalId: event.goalId, visible: true });
      }
    });
    void api.herdrStatus().then(setHerdr).catch(showError);
    return () => {
      unsubscribe();
      if (stateFrame.current !== undefined) cancelAnimationFrame(stateFrame.current);
      if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    };
  }, []);
  useEffect(() => {
    if (page === "settings") {
      void api.herdrStatus().then(setHerdr).catch(showError);
      void api.cliStatus().then(setCli).catch(showError);
      void api.skillsStatus().then(setSkills).catch(showError);
      void api.agentChoices().then(setAgentOptions).catch(showError);
      void api.webhookSettings().then(setWebhook).catch(showError);
    }
  }, [page]);
  useEffect(() => {
    if (!error || modal) return;
    const timer = window.setTimeout(() => setError(""), 8_000);
    return () => window.clearTimeout(timer);
  }, [error, modal]);
  function showError(reason: unknown) {
    setError(String(reason).replace(/^Error: /, "")
      .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  }
  async function openScene(id?: string, terminalOnly = false) {
    if (busy) return;
    setModal("");
    setBusy(true); setError("");
    try { if (terminalOnly) await api.openTerminal(); else await api.openHerdr(id); }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  }
  function notify(text: string) {
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }
  async function execute(command: CrewvaneCommand) {
    setBusy(true);
    setError("");
    try {
      const result = await api.command(command);
      applyState(await api.command({ type: "snapshot" }));
      return result;
    } catch (reason) {
      showError(reason);
      throw reason;
    } finally {
      setBusy(false);
    }
  }
  const goalDetailService = useMemo<GoalDetailService>(() => ({
    command: execute,
    importAttachments: (inputs) => api.importAttachments(inputs),
    previewAttachment: (currentGoalId, attachmentId) =>
      api.attachmentPreview(currentGoalId, attachmentId),
    openAttachment: async (currentGoalId, attachmentId) => {
      try {
        await api.openAttachment(currentGoalId, attachmentId);
      } catch (reason) {
        showError(reason);
      }
    },
    openHerdr: async (currentGoalId) => {
      await openScene(currentGoalId);
    },
    openUrl: async (url) => {
      try {
        await api.openUrl(url);
      } catch (reason) {
        showError(reason);
      }
    },
    retryDispatch: async (currentGoalId) => {
      setBusy(true);
      setError("");
      try {
        await api.dispatchGoal(currentGoalId);
        applyState(await api.command({ type: "snapshot" }));
      } catch (reason) {
        showError(reason);
        throw reason;
      } finally {
        setBusy(false);
      }
    },
    restartGoal: async (currentGoalId, note) => {
      setBusy(true);
      setError("");
      try {
        const result = await api.restartGoal(currentGoalId, note);
        applyState(await api.command({ type: "snapshot" }));
        return result;
      } catch (reason) {
        showError(reason);
        throw reason;
      } finally {
        setBusy(false);
      }
    },
  }), [busy]);
  async function pickWorkspace() {
    if (pickingWorkspace) return;
    setPickingWorkspace(true);
    setError("");
    try {
      const selected = await api.selectWorkspace();
      if (selected) {
        setProjectId("");
        setGoalId("");
        setModal("");
        setPage("home");
        setWorkspace(selected);
        applyState(await api.command({ type: "snapshot" }));
        notify(selected === workspace ? "你已在这个工作区。" : `已打开工作区：${selected.split("/").filter(Boolean).at(-1)}`);
      }
    } catch (reason) {
      showError(reason);
    } finally {
      setPickingWorkspace(false);
    }
  }
  function openGoal(id: string) {
    const item = stateRef.current.goals.find(goal => goal.id === id);
    if (!item) return;
    const destination = goalEntryDestination(item);
    if (destination === "scene") {
      void openScene(item.id);
      return;
    }
    setGoalId(item.id);
    setModal(destination === "task" ? "task" : destination === "attention" ? "attention" : "goal");
  }
  function attentionActionLabel(item: Goal) {
    const kind = attentionKind(item);
    if (kind === "review") return "查看并验收";
    if (kind === "decision") return "作出决定";
    if (kind === "follow_up") return "处理跟进";
    if (item.attention?.source === "dispatch") return "恢复联系";
    if (goalEntryDestination(item) === "attention") return "查看并处理";
    return "进入现场";
  }
  function goalRowLabel(item: Goal) {
    const destination = goalEntryDestination(item);
    if (destination === "task") return ["completed", "dropped"].includes(item.status)
      ? "查看记录" : item.status === "backlog" ? "尚未开始" : "我来做";
    if (destination === "details" && (item.status === "completed" || item.status === "dropped")) return "查看记录";
    if (destination === "scene") return goalProgressLabel(item);
    if (destination === "attention") return attentionActionLabel(item);
    return "查看目标";
  }
  function createIntake(handling: IntakeHandling = "concierge") {
    setIntakeHandling(handling);
    setError("");
    setModal("new");
  }
  async function saveGoal(text: string, files: File[], handling: IntakeHandling) {
    setBusy(true);
    setError("");
    try {
      const inputs = await Promise.all(files.map(async file => ({
        name: file.name,
        bytes: await file.arrayBuffer(),
      })));
      const attachments = inputs.length ? await api.importAttachments(inputs) : [];
      const created = await api.command({
        type: "goal.intake",
        text,
        handling,
        projectId: projectId || undefined,
        ...(attachments.length ? { attachments } : {}),
      }) as Goal;
      applyState(await api.command({ type: "snapshot" }));
      setGoalId(created.id);
      setModal(handling === "concierge" ? "goal" : "");
      if (handling !== "concierge") {
        setTaskSection(handling === "later" ? "later" : "self");
        setProjectId("");
        setPage("tasks");
      }
      notify(handling === "later" ? "已记下，不会启动 Agent。" : handling === "self"
        ? "已记到我来做，做完即可标记完成。" : "目标已保存，正在联系管家。");
    } catch (reason) {
      showError(reason);
      throw reason;
    } finally {
      setBusy(false);
    }
  }
  const taskModal = Boolean(goal && (modal === "task" ||
    modal === "goal" && goal.mode === "manual" && goal.status !== "review"));
  return (
    <div className={`app ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src={pixelMark} alt="Crewvane" />
          <div>
            <strong>Crewvane</strong>
            <span>协 航</span>
          </div>
        </div>
        <button
          className={`workspace-switch ${page === "home" && !projectId ? "active" : ""}`}
          aria-label="我的工作台"
          aria-current={page === "home" && !projectId ? "page" : undefined}
          title="查看所有项目和个人事项"
          onClick={() => {
            setPage("home");
            setProjectId("");
            setModal("");
            document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
          }}
        >
          <span className="workspace-icon" aria-hidden="true">
            <LayoutDashboard />
          </span>
          <span className="workspace-copy">
            <strong>{state.name}</strong>
            <small>
              {page === "home" && !projectId
                ? "当前：注意力总览"
                : "所有项目与个人事项"}
            </small>
          </span>
          <ChevronRight size={14} />
        </button>
        <nav aria-label="主导航">
          <button
            aria-label="注意力"
            className={page === "home" ? "active" : ""}
            onClick={() => {
              setPage("home");
              setProjectId("");
            }}
          >
            <Inbox />
            <span>注意力</span>
            {attention.length > 0 && <b>{attention.length}</b>}
          </button>
          <button
            className={page === "tasks" ? "active" : ""}
            aria-label="待办池"
            title={`${taskPoolCount} 件待办`}
            onClick={() => { setPage("tasks"); setProjectId(""); }}
          >
            <NotebookPen />
            <span>待办池</span>
            <b>{taskPoolCount}</b>
          </button>
          <button
            className={page === "goals" && !projectId ? "active" : ""}
            aria-label="全部目标"
            onClick={() => {
              setPage("goals");
              setProjectId("");
            }}
          >
            <LayoutList />
            <span>全部目标</span>
          </button>
          <button
            className={page === "settings" ? "active" : ""}
            aria-label="设置"
            onClick={() => setPage("settings")}
          >
            <Settings2 />
            <span>设置</span>
          </button>
        </nav>
        <div className="projects">
          <small>我的空间</small>
          {state.projects.map((item) => (
            <button
              key={item.id}
              className={projectId === item.id ? "active" : ""}
              onClick={() => {
                setProjectId(item.id);
                setPage("goals");
              }}
            >
              <Folder />
              <span>{item.name}</span>
              <small>
                {
                  state.goals.filter(
                    (goal) =>
                      goal.projectId === item.id &&
                      !["completed", "dropped"].includes(goal.status),
                  ).length
                }
              </small>
            </button>
          ))}
          <button className="add-project" onClick={() => setModal("project")}>
            <Plus />
            <span>添加项目</span>
          </button>
        </div>
        <div className="concierge">
          <div className="concierge-orb">
            <img src={pixelMark} alt="" />
            <i />
          </div>
          <strong>所有事，找管家。</strong>
          <p>你负责方向，管家负责条理。</p>
          <button disabled={!workspace || busy} aria-label="找管家" onClick={() => void openScene()}>
            <SquareTerminal size={15} />
            <span>{busy ? "正在处理…" : conciergeAvailable ? "回到现场" : hasConciergeReference ? "恢复管家" : "找管家"}</span>
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-footer">
          <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Sun /> : <Moon />}
            <span>{theme === "dark" ? "浅色模式" : "深色模式"}</span>
          </button>
          <button
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            <ChevronRight className="collapse-icon" />
            <span>收起</span>
          </button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div>
            <span className="tiny-star">✦</span>
            <span>{project?.name ?? state.name}</span>
            <span className="slash">/</span>
            <strong>{pages[page]}</strong>
          </div>
          <div className="top-actions">
            <span className={`live-status ${conciergeLive ?? state.concierge.status}`}>
              <i />
              {conciergeStatus}
            </span>
            <Button
              variant="primary"
              onClick={() => createIntake(page === "tasks" ? taskSection : "concierge")}
              disabled={!workspace}
              icon={<Plus size={16} />}
            >
              {page === "tasks" ? "记一件事" : "新目标"}
            </Button>
          </div>
        </header>
        <main>
        {error && (
          <div className="error" role="alert">
            <CircleAlert size={16} />
            <span>{error}</span>
            <IconButton label="关闭提示" onClick={() => setError("")}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        {state.recovery && (
          <div className="recovery-notice" role="status" aria-live="polite">
            <CircleAlert size={18} />
            <div>
              <strong>旧版工作区已自动保护</strong>
              <p>{state.recovery.detail} 已创建兼容的新工作区，旧数据没有被删除。</p>
              <code title={state.recovery.archivedPath}>{state.recovery.archivedPath}</code>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void api.openRecoveryBackup().catch(showError)} icon={<Folder size={14} />}>
              打开备份
            </Button>
            <IconButton
              label="关闭恢复提示"
              onClick={() => void execute({ type: "workspace.recovery.dismiss" })
                .then(() => notify("旧版数据继续保留在备份目录中。"))
                .catch(showError)}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}
        {herdr && (herdr.phase === "checking" || herdr.phase === "downloading" || herdr.phase === "error") && (
          <div className={`setup-status ${herdr.phase}`} role="status" aria-live="polite">
            <SquareTerminal size={16} />
            <span>{herdr.detail || "正在检查 Herdr…"}</span>
            {herdr.phase === "error" && <Button variant="secondary" size="sm" onClick={() => {
              void api.installHerdr().catch(showError);
            }}>重试准备 Herdr</Button>}
          </div>
        )}
          {!workspace ? (
            <section className="welcome">
              <img src={pixelMark} alt="Crewvane" />
              <span className="eyebrow">YOUR MIND, CLEARER</span>
              <h1>
                把事情放下，
                <br />
                把方向留住。
              </h1>
              <p>
                一位管家，整理所有项目与个人事项。
                <br />
                只有真正需要你的时刻，才打扰你。
              </p>
              <Button
                variant="primary"
                disabled={pickingWorkspace}
                onClick={() => void pickWorkspace()}
                trailing={<ArrowRight size={17} />}
              >
                {pickingWorkspace ? "正在准备工作区…" : "选择存储位置并开始"}
              </Button>
            </section>
          ) : page === "home" ? (
            <div className="content home">
              <section className="intro">
                <div>
                  <span className="eyebrow">
                    {new Intl.DateTimeFormat("zh-CN", {
                      month: "long",
                      day: "numeric",
                      weekday: "long",
                    }).format(new Date())}
                  </span>
                  <h1>
                    {attention.length ? (
                      <>
                        把注意力，<em>留给真正重要的事。</em>
                      </>
                    ) : (
                      <>
                        现在，<em>可以安心了。</em>
                      </>
                    )}
                  </h1>
                  <p>
                    {attention.length
                      ? `有 ${attention.length} 件事需要你。其余的事，管家会继续推进。`
                      : "该你处理的事已经清零。去专注于你想做的事吧。"}
                  </p>
                </div>
                <div className="pixel-scene" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <img src={pixelMark} alt="" />
                </div>
              </section>
              <section className="attention-section">
                <SectionHeading
                  title="需要你处理"
                  count={attention.length}
                  description={
                    attention.length
                      ? "不必盯着其他会话"
                      : "内部进展不会打扰你"
                  }
                />
                {attention.length ? (
                  <div className="attention-list">
                    {attention.map((item) => {
                      const kind = attentionKind(item)!;
                      const sceneSync = sceneSyncPresentation(item);
                      return (
                        <button
                          className={`attention-card ${kind}`}
                          key={item.id}
                          onClick={() => openGoal(item.id)}
                        >
                          <span className="attention-symbol">
                            {kind === "review" ? (
                              <Check />
                            ) : kind === "follow_up" ? (
                              <Clock3 />
                            ) : (
                              <Zap />
                            )}
                          </span>
                          <div>
                            <span className="card-label">
                              {
                                state.projects.find(
                                  (p) => p.id === item.projectId,
                                )?.name
                              }{" "}
                              · {sceneSync?.label || (kind === "intervention" && !item.herdr ? "需要你处理" : attentionLabel[kind])}
                            </span>
                            <h3>{item.title}</h3>
                            <p>{sceneSync?.summary || item.attention?.summary || item.next}</p>
                          </div>
                          <span className="card-link">
                            <span className="card-link-label">
                              {attentionActionLabel(item)}
                            </span>
                            <ArrowRight size={15} />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <EmptyState
                    inline
                    tone="mint"
                    icon={<Sparkles size={18} />}
                    title="此刻，没有等你处理的事。"
                    description={`${waiting.length ? `${waiting.length} 件等待外部` : "没有被搁置的事项"}${active.length ? `，${active.length} 件由管家跟进` : ""}。到了该出现的时候再告诉你。`}
                  />
                )}
              </section>
              {waiting.length > 0 && (
                <section className="waiting-section">
                  <SectionHeading
                    title="等待外部"
                    description="等外部联系人或机构处理，不用一直记着"
                  />
                  {waiting.map((item) => (
                    <button
                      className="waiting-row"
                      key={item.id}
                      onClick={() => openGoal(item.id)}
                    >
                      <Clock3 />
                      <div>
                        <strong>{item.title}</strong>
                        <span>
                          {item.waitingFor} · {item.next}
                        </span>
                      </div>
                      <small>
                        {item.remindAt
                          ? `${time(item.remindAt)} 跟进`
                          : "未设提醒"}
                      </small>
                      <ChevronRight />
                    </button>
                  ))}
                </section>
              )}
              {active.length > 0 && (
                <div className="running">
                  <span className="pulse" />
                  <span>
                    <strong>{active.length} 个目标</strong>由管家跟进
                  </span>
                  <span>·</span>
                  <span>{active.some(item => item.recovery) ? "空闲结果正在核对" : "有需要时再打扰你"}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    trailing={<ArrowUpRight size={13} />}
                    onClick={() => {
                      setFilter("active");
                      setPage("goals");
                    }}
                  >
                    查看进展
                  </Button>
                </div>
              )}
            </div>
          ) : page === "tasks" ? (
            <TaskPool goals={state.goals} open={openGoal} create={createIntake}
              section={taskSection} onSection={setTaskSection} />
          ) : page === "goals" ? (
            <div className="content">
              <section className="intro">
                <div>
                  <span className="eyebrow">
                    {project ? "项目视角" : "全局视角"}
                  </span>
                  <h1>{project?.name ?? "每件事，都有下一步。"}</h1>
                  <p>
                    {project
                      ? "同一个管家，继续统筹这里的一切。"
                      : "不用记住哪个会话在做什么，这里保留下一步。"}
                  </p>
                </div>
              </section>
              <div className="filter-bar">
                {(
                  [
                    ["all", "全部"],
                    ["attention", "需要处理"],
                    ["waiting", "等待外部"],
                    ["active", "跟进中"],
                    ["backlog", "暂存"],
                    ["completed", "已完成"],
                    ["dropped", "已放弃"],
                  ] as [string, string][]
                ).map(([value, label]) => (
                  <button
                    className={filter === value ? "active" : ""}
                    key={value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
                <TextInput
                  aria-label="搜索目标"
                  className="filter-search"
                  placeholder="搜索目标…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="goal-list">
                {selectedGoals.length ? (
                  selectedGoals.map((item) => (
                    <button
                      className="goal-row"
                      key={item.id}
                      onClick={() => openGoal(item.id)}
                    >
                      <span className={`goal-dot ${item.status}`} />
                      <div>
                        <strong>{item.title}</strong>
                        <p>{item.next}</p>
                      </div>
                      <StatusPill tone={goalRowTone(item)}>
                        {goalRowLabel(item)}
                      </StatusPill>
                      <ChevronRight />
                    </button>
                  ))
                ) : state.goals.length === 0 ? (
                  <EmptyState
                    className="goal-empty"
                    icon={<Sparkles size={19} />}
                    title="这里还没有目标"
                    description="记录一件事，或把它交给管家。每一步都会留在这里。"
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Plus size={14} />}
                        onClick={() => createIntake()}
                      >
                        记录第一个目标
                      </Button>
                    }
                  />
                ) : projectId && !state.goals.some((goal) => goal.projectId === projectId) ? (
                  <EmptyState
                    className="goal-empty"
                    icon={<Folder size={19} />}
                    title="这个项目还没有目标"
                    description="把第一件事交给管家，项目会从这里开始积累。"
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Plus size={14} />}
                        onClick={() => createIntake()}
                      >
                        记录第一个目标
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    className="goal-empty"
                    icon={<Sparkles size={19} />}
                    title="没有符合条件的目标"
                    description="换个关键词，或清除筛选查看全部目标。"
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setQuery("");
                          setFilter("all");
                          setProjectId("");
                        }}
                      >
                        清除筛选
                      </Button>
                    }
                  />
                )}
              </div>
            </div>
          ) : (
            <Settings
              busy={busy}
              state={state}
              herdr={herdr}
              cli={cli}
              skills={skills}
              agentOptions={agentOptions}
              webhook={webhook}
              saveAgents={async (preferences: AgentPreferences) => {
                await execute({ type: "agents.configure", preferences });
                notify("Agent 偏好已保存，将用于新启动的会话。");
              }}
              savePolicy={async (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => {
                await execute({ type: "project.policy.set", projectId, policy, actor: "你" });
                notify("项目上线策略已更新。");
              }}
              theme={theme}
              setTheme={(value: string) => setTheme(value)}
              onAction={async (action: string) => {
                setBusy(true);
                setError("");
                try {
                  if (action === "herdr") await api.installHerdr();
                  if (action === "cli") {
                    const result = await api.installCli();
                    notify(result.output);
                  }
                  if (action === "skills") {
                    const result = await api.installSkills();
                    setSkills(result.status);
                    notify(result.errors.length
                      ? `Skills 已更新；${result.errors.length} 个目录因已有同名技能而跳过。`
                      : "Crewvane Skills 已安装到检测到的 Agent。");
                  }
                  if (action === "concierge") await api.prepareConcierge();
                  setHerdr(await api.herdrStatus());
                  setAgentOptions(await api.agentChoices());
                  setCli(await api.cliStatus());
                  applyState(await api.command({ type: "snapshot" }));
                  const ready = await api.herdrStatus();
                  notify(action === "herdr" && ready.phase === "error"
                    ? "本机版本可用，更新检查未完成，可稍后重试。"
                    : action === "herdr" ? `Herdr ${ready.version ?? ""} 已就绪` : "已准备就绪");
                } catch (reason) {
                  showError(reason);
                } finally {
                  setBusy(false);
                }
              }}
              openWebhook={() => setModal("webhook")}
              version={version}
              workspace={workspace ?? ""}
              pickWorkspace={() => setModal("workspace")}
              openHerdr={() => void openScene(undefined, true)}
            />
          )}
        </main>
      </div>
      {terminal && <Suspense fallback={null}><HerdrTerminal
        session={terminal.session}
        title={terminal.title}
        goal={sceneContext}
        theme={theme}
        visible={terminal.visible && !modal}
        onClose={() => setTerminal(current => current ? { ...current, visible: false } : current)}
        onOpenGoal={id => {
          setGoalId(id);
          setModal("goal");
        }}
        onReturnToAttention={() => {
          setPage("home");
          setProjectId("");
          setTerminal(current => current ? { ...current, visible: false } : current);
        }}
      /></Suspense>}
      {modal === "workspace" && <Modal title="工作区存储位置" description="这里只设置所有目标、提醒和管家的保存位置，不是选择项目。" error={error} onClose={() => setModal("")}>
        <div className="workspace-location">
          <Folder size={22} />
          <div><strong>{workspace ? "当前工作区" : "先选择一个工作区文件夹"}</strong><p>{workspace || "建议创建一个专门的文件夹，例如 Documents/Crewvane。"}</p></div>
        </div>
        <p className="workspace-help">要处理某个代码项目，请在左侧「项目」旁点 + 添加。切换工作区后，将显示所选目录自己的目标和管家。</p>
        <div className="form-actions">
          <Button variant="secondary" onClick={() => setModal("")}>返回设置</Button>
          <Button variant="primary" disabled={pickingWorkspace} onClick={() => void pickWorkspace()}>
            {pickingWorkspace ? "正在打开工作区…" : workspace ? "选择其他工作区文件夹" : "选择工作区文件夹"}
          </Button>
        </div>
      </Modal>}
      {modal === "webhook" && (
        <Modal
          title="Webhook 通知"
          description="目标状态变化会发送；首次进入「需要你处理」时会另发注意力通知，去重记录跨重启保留。"
          error={error}
          onClose={() => setModal("")}
        >
          <form
            className="ui-form webhook-form"
            onSubmit={async event => {
              event.preventDefault();
              setBusy(true);
              setError("");
              const data = new FormData(event.currentTarget);
              try {
                const saved = await api.saveWebhook({
                  enabled: data.get("enabled") === "on",
                  url: String(data.get("url") || ""),
                  token: String(data.get("token") || ""),
                  clearToken: data.get("clearToken") === "on",
                  statuses: data
                    .getAll("statuses")
                    .filter((value): value is string => typeof value === "string") as Goal["status"][],
                });
                const verified = saved.enabled ? await api.testWebhook() : saved;
                setWebhook(verified);
                setModal("");
                notify(saved.enabled ? "Webhook 已保存，测试通知已送达。" : "Webhook 通知已暂停。");
              } catch (reason) {
                showError(reason);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Toggle
              name="enabled"
              defaultChecked={webhook.enabled}
              disabled={busy}
              label="状态更新和需要你处理时发送"
              description="目标状态变化会通知；决定、验收、到期跟进和升级事项另有注意力通知。普通聊天不会触发。"
            />
            <fieldset className="webhook-statuses">
              <legend>订阅这些状态变化</legend>
              <div>
                {goalStatusOptions.map(([value, label]) => (
                  <Checkbox
                    name="statuses"
                    value={value}
                    defaultChecked={webhook.statuses.includes(value)}
                    disabled={busy}
                    label={label}
                    key={value}
                  />
                ))}
              </div>
              <small>全部取消后仍会接收“需要你处理”的注意力通知。</small>
            </fieldset>
            <Field
              label="Webhook 地址"
              hint={
                webhook.configured
                  ? `已配置 ${webhook.endpoint ?? ""}，留空保持不变`
                  : "远程地址必须使用 HTTPS，本机 localhost 可使用 HTTP。"
              }
            >
              <TextInput
                name="url"
                type="url"
                required={!webhook.configured}
                disabled={busy}
                placeholder={webhook.configured
                  ? "留空保持不变"
                  : "https://hooks.example.com/crewvane"}
              />
            </Field>
            <Field
              label="Bearer 令牌（可选）"
              hint={webhook.tokenConfigured ? "令牌已保存，留空保持不变。" : "留空则不添加 Authorization。"}
            >
              <TextInput
                name="token"
                type="password"
                autoComplete="new-password"
                disabled={busy}
                placeholder={webhook.tokenConfigured ? "留空保持不变" : "留空则不添加 Authorization"}
              />
            </Field>
            {webhook.tokenConfigured && (
              <Checkbox name="clearToken" disabled={busy} label="清除已保存的令牌" />
            )}
            <p className="ui-form__note">
              通用 Webhook 收到 JSON；飞书、Lark 和企业微信机器人地址会自动使用文本消息格式。内容仅含工作区名称、目标标题、状态、摘要和 `goalId`，不包含聊天历史、附件或本机路径。
            </p>
            <div className="modal-actions webhook-actions">
              <Button
                variant="secondary"
                disabled={busy || !webhook.configured}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setWebhook(await api.testWebhook());
                    notify("测试通知已送达 Webhook。");
                  } catch (reason) {
                    showError(reason);
                    setWebhook(await api.webhookSettings().catch(() => webhook));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                测试当前配置
              </Button>
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "正在保存…" : "保存设置"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "new" && (
        <GoalIntakeForm
          error={error}
          busy={busy}
          initialHandling={intakeHandling}
          onClose={() => setModal("")}
          onSubmit={saveGoal}
        />
      )}
      {taskModal && goal && goalEntryDestination(goal) !== "attention" && (
        <TaskDetail key={goal.id} goal={goal} service={goalDetailService} busy={busy} error={error}
          close={() => setModal("")} notify={notify} delegated={() => setModal("goal")} />
      )}
      {(modal === "attention" || taskModal && goal && goalEntryDestination(goal) === "attention") && goal && (
        <GoalAttentionCard
          key={goal.id}
          goal={goal}
          state={state}
          service={goalDetailService}
          busy={busy}
          error={error}
          onClose={() => setModal("")}
          openDetails={() => setModal("goal")}
          notify={notify}
        />
      )}
      {modal === "project" && (
        <Modal
          error={error}
          title="添加项目"
          description="在这里创建项目并关联本机目录；目录可留空，仍由同一位管家统筹。"
          onClose={() => setModal("")}
        >
          <form
            className="ui-form"
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                await execute({
                  type: "project.add",
                  name: String(data.get("name")),
                  path: String(data.get("path")) || undefined,
                });
                setModal("");
                notify("项目已添加");
              } catch {
                /* execute reports the error in the modal. */
              }
            }}
          >
            <Field label="项目名称">
              <TextInput
                name="name"
                required
                autoFocus
                placeholder="例如：数据平台"
              />
            </Field>
            <Field
              label="项目目录（可选）"
              htmlFor="project-path"
              connect={false}
              hint="可留空，仍由同一位管家统筹。"
            >
              <div className="file-input">
                <TextInput
                  id="project-path"
                  name="path"
                  readOnly
                  placeholder="选择本机目录"
                  aria-describedby="project-path-message"
                />
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const selected = await api.selectProject();
                    const input =
                      document.querySelector<HTMLInputElement>(
                        'input[name="path"]',
                      );
                    if (input && selected) input.value = selected;
                  }}
                >
                  选择目录
                </Button>
              </div>
            </Field>
            <div className="modal-actions">
              <Button type="submit" variant="primary" disabled={busy}>
                添加项目
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "goal" && !taskModal && goal && (
        <GoalDetail
          key={goal.id}
          goal={goal}
          error={error}
          state={state}
          onClose={() => setModal("")}
          service={goalDetailService}
          busy={busy}
          removeAttachment={(attachmentId) => void execute({
            type: "goal.attachment.remove",
            goalId: goal.id,
            attachmentId,
            actor: "你",
          }).then(() => notify("图片已删除，相关元数据也已清理。")).catch(() => {})}
          deleteGoal={() => {
            if (!window.confirm(`永久删除目标「${goal.title}」及其图片？项目决定账本会保留。`)) return;
            void execute({ type: "goal.delete", goalId: goal.id, actor: "你" })
              .then(() => {
                setGoalId("");
                setModal("");
                notify("目标与关联图片已永久删除。");
              })
              .catch(() => {});
          }}
          edit={() => setModal("edit")}
          submit={() => setModal("delivery")}
          notify={notify}
        />
      )}
      {modal === "edit" && goal && (
        <GoalEditor
          goal={goal}
          error={error}
          busy={busy}
          execute={execute}
          onClose={() => setModal("goal")}
          onSaved={() => {
            setModal("goal");
            notify("下一步已更新");
          }}
        />
      )}
      {modal === "delivery" && goal && (
        <DeliveryEditor
          goal={goal}
          error={error}
          busy={busy}
          execute={execute}
          onClose={() => setModal("goal")}
          onSaved={() => {
            setModal("goal");
            notify("成果已记录，请核对后验收");
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
type GoalFormProps = {
  goal: Goal;
  error: string;
  busy: boolean;
  execute: (command: CrewvaneCommand) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
};
function GoalEditor({
  goal,
  error,
  busy,
  execute,
  onClose,
  onSaved,
}: GoalFormProps) {
  const [arrangement, setArrangement] = useState(goal.status === "waiting" ? "waiting" : "active");
  const localReminder = goal.remindAt
    ? (() => {
        const date = new Date(goal.remindAt);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16);
      })()
    : "";
  return (
    <Modal
      title="编辑目标"
      description="修改目标说明或接下来的安排。等待外部只适用于你和 Agent 之外的联系人或机构。"
      error={error}
      onClose={onClose}
    >
      <form
        className="ui-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await execute({
              type: "goal.update",
              goalId: goal.id,
              patch: {
                title: String(data.get("title")),
                description: String(data.get("description")),
                next: String(data.get("next")),
                owner: String(data.get("owner")),
                ...(arrangement === "waiting" ? { waitingFor: String(data.get("waitingFor")) } : {}),
                status:
                  goal.status === "review"
                    ? undefined
                    : (arrangement as "active" | "waiting"),
                remindAt: data.get("remindAt")
                  ? new Date(String(data.get("remindAt"))).toISOString()
                  : null,
              },
            });
            onSaved();
          } catch {
            /* execute reports the error. */
          }
        }}
      >
        <Field label="目标名称" hint="改标题不会改变目标状态或验收记录。">
          <TextInput
            name="title"
            defaultValue={goal.title}
            maxLength={160}
            required
          />
        </Field>
        <Field label="背景与完成标准">
          <TextArea
            name="description"
            defaultValue={goal.description}
            required
          />
        </Field>
        <div className="ui-form__grid">
          {goal.status !== "review" && (
            <Field label="当前安排">
              <Select name="status" value={arrangement} onChange={event => setArrangement(event.target.value)}>
                <option value="active">继续推进</option>
                <option value="waiting">等待外部</option>
              </Select>
            </Field>
          )}
          <Field label="负责人">
            <TextInput name="owner" defaultValue={goal.owner} required />
          </Field>
          {arrangement === "waiting" && (
            <Field label="外部等待对象" hint="例如 YR、法务或供应商；需要你处理或 Agent 协调不属于等待外部。">
              <TextInput name="waitingFor" defaultValue={goal.waitingFor} maxLength={120} required />
            </Field>
          )}
          <Field label="跟进提醒" hint="到提醒时间会进入注意力面板。">
            <TextInput
              name="remindAt"
              type="datetime-local"
              defaultValue={localReminder}
            />
          </Field>
        </div>
        <Field label="下一步">
          <TextArea name="next" defaultValue={goal.next} required />
        </Field>
        <div className="modal-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            保存更新
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function DeliveryEditor({
  goal,
  error,
  busy,
  execute,
  onClose,
  onSaved,
}: GoalFormProps) {
  return (
    <Modal
      title="提交成果"
      description="写下实际成果与已完成的检查，供最终验收。"
      error={error}
      onClose={onClose}
    >
      <form
        className="ui-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await execute({
              type: "goal.review",
              goalId: goal.id,
              actor: "你",
              delivery: {
                summary: String(data.get("summary")),
                location: String(data.get("location")) || undefined,
                checks: [
                  {
                    name: String(data.get("checkName")),
                    command: String(data.get("checkCommand")),
                    result: "passed",
                    note: String(data.get("checkNote")),
                  },
                ],
              },
            });
            onSaved();
          } catch {
            /* execute reports the error. */
          }
        }}
      >
        <Field label="成果摘要">
          <TextArea name="summary" placeholder="实际完成了什么？" required />
        </Field>
        <Field label="成果位置（可选）">
          <TextInput
            name="location"
            placeholder="文件位置、文档或其他可核对的位置"
          />
        </Field>
        <div className="ui-form__grid">
          <Field label="检查名称">
            <TextInput
              name="checkName"
              placeholder="例如：人工核对审批结果"
              required
            />
          </Field>
          <Field label="实际检查操作">
            <TextInput
              name="checkCommand"
              placeholder="实际执行的命令或人工检查步骤"
              required
            />
          </Field>
        </div>
        <Field label="通过依据" hint="未检查通过时请继续处理，不要提交验收。">
          <TextArea
            name="checkNote"
            placeholder="写下实际观察到的结果"
            required
          />
        </Field>
        <div className="modal-actions">
          <Button type="submit" variant="primary" disabled={busy}>
            提交验收
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function Settings({
  busy,
  state,
  herdr,
  cli,
  skills,
  theme,
  setTheme,
  onAction,
  workspace,
  pickWorkspace,
  openHerdr,
  agentOptions,
  webhook,
  saveAgents,
  savePolicy,
  openWebhook,
  version,
}: any) {
  const [attachCopyState, setAttachCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const attachCopyTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    setAttachCopyState("idle");
    window.clearTimeout(attachCopyTimer.current);
  }, [herdr?.session]);
  useEffect(() => () => window.clearTimeout(attachCopyTimer.current), []);
  async function copyAttachCommand() {
    if (!herdr?.session) return;
    try {
      await api.writeClipboardText(`herdr session attach ${herdr.session}`);
      setAttachCopyState("copied");
      window.clearTimeout(attachCopyTimer.current);
      attachCopyTimer.current = window.setTimeout(() => setAttachCopyState("idle"), 2200);
    } catch {
      setAttachCopyState("failed");
    }
  }
  return (
    <div className="content settings">
      <section className="intro">
        <div>
          <span className="eyebrow">YOUR MIND, CLEARER</span>
          <h1>只设置必要的。</h1>
          <p>没有运行时管理。你已有的工具，在 Herdr 里自然相遇。</p>
        </div>
      </section>
      <div className="ui-settings-grid">
        <AgentPreferencesEditor
          key={workspace}
          preferences={state.agents ?? { concierge: "codex" }}
          options={agentOptions}
          busy={busy}
          onSave={saveAgents}
        />
        <GovernanceEditor
          projects={state.projects}
          decisions={state.decisions ?? []}
          busy={busy}
          onSave={savePolicy}
        />
        <SettingsSection
          wide
          icon={<SquareTerminal />}
          title="Herdr 与全局管家"
          description="会话由 Herdr 托管，关闭 Crewvane 窗口也不会终止；启动时自动检查最新版，并接入 Crewvane 注意力面板。"
        >
          <div className="settings-facts">
            {herdr?.session && (
              <div className="external-herdr-command" role="group" aria-label="在外部终端打开同一 Herdr 会话">
                <div>
                  <strong>在 iTerm2 / Terminal 中打开同一现场</strong>
                  <p>裸跑 herdr 默认连接 default Session，不会自动显示这个工作区；复制下面的命令才能进入 Crewvane 当前 Session。</p>
                  <code>herdr session attach {herdr.session}</code>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Copy size={14} />}
                  aria-label="复制外部终端 attach 命令"
                  onClick={() => void copyAttachCommand()}
                >
                  {attachCopyState === "copied" ? "已复制" : attachCopyState === "failed" ? "复制失败" : "复制命令"}
                </Button>
              </div>
            )}
            {herdr?.executable && <code>{herdr.executable}</code>}
          </div>
          <div className="settings-inline">
            {herdr?.installed ? (
              <span className="settings-status ready">
                <i />
                已安装 {herdr.version}
                {herdr.plugin?.phase === "ready" ? " · 注意力面板已接入" : ""}
              </span>
            ) : (
              <LoadingState label={herdr?.detail || "正在检测运行环境…"} />
            )}
            {herdr?.plugin?.phase === "error" && (
              <span className="ui-field__error">{herdr.plugin.detail}</span>
            )}
          </div>
          <div className="ui-settings-card__actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || herdr?.phase === "checking" || herdr?.phase === "downloading"}
              onClick={() => void onAction("herdr")}
            >
              {herdr?.phase === "downloading" ? "正在自动安装…" : herdr?.phase === "checking" ? "正在检查…" : herdr?.installed ? "检查更新" : "重试准备"}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAction("concierge")}
            >
              {busy ? "正在准备…" : "准备管家"}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={openHerdr}>
              打开 Herdr
            </Button>
          </div>
        </SettingsSection>
        <SettingsSection
          icon={<Zap />}
          title="Crewvane 命令行"
          description="管家通过它读写当前案卷，不能列出或修改其他目标。应用内置，无需另外安装 Node。"
        >
          <div className="settings-facts">
            <code>{cli?.path}</code>
          </div>
          <div className="ui-settings-card__actions">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAction("cli")}
            >
              {cli?.installed ? "重新安装" : "安装到 ~/.local/bin"}
            </Button>
          </div>
        </SettingsSection>
        <SettingsSection
          icon={<Bot />}
          title="让外部 Agent 会使用 Crewvane"
          description="安装随应用打包的 Crewvane Skill。Codex、Claude Code、Cursor 或其他读取通用 Agent Skills 目录的工具，可以直接提交目标、查看目标并追加说明。"
        >
          {skills?.targets?.length ? (
            <div className="skill-targets">
              {skills.targets.map((target: any) => (
                <small
                  key={target.id}
                  className={target.phase === "conflict" ? "conflict" : target.phase}
                  title={target.path}
                >
                  {target.label}
                  <i />
                  {target.phase === "installed" ? "已安装"
                    : target.phase === "outdated" ? `可更新 ${target.managedVersion ?? ""}`
                      : target.phase === "conflict" ? "已有同名 Skill，已保护"
                        : "未安装"}
                </small>
              ))}
            </div>
          ) : (
            <LoadingState label="正在检测 Agent Skills 目录…" />
          )}
          <div className="ui-settings-card__actions">
            <span className="settings-status">
              {skills ? `${skills.installed}/${skills.available} 已就绪` : ""}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void onAction("skills")}
            >
              {skills?.targets?.length && skills.installed === skills.available
                ? "重新安装 Skills"
                : "安装 / 更新 Skills"}
            </Button>
          </div>
        </SettingsSection>
        <SettingsSection
          icon={<Folder />}
          title="工作区存储位置"
          description="目标保存在此目录的 .crewvane 中。切换工作区后，界面会显示该目录自己的目标。"
        >
          <div className="settings-facts">
            <code>{workspace}</code>
          </div>
          <div className="ui-settings-card__actions">
            <Button variant="secondary" size="sm" onClick={() => void pickWorkspace()}>
              更换工作区
            </Button>
          </div>
        </SettingsSection>
        <SettingsSection
          icon={theme === "dark" ? <Moon /> : <Sun />}
          title="外观"
          description="深夜像素或清爽日光，任务始终清晰。"
        >
          <div className="settings-inline">
            <span className="settings-status">
              <i />
              当前：{theme === "dark" ? "深色" : "浅色"}
            </span>
          </div>
          <div className="ui-settings-card__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? "切换到浅色" : "切换到深色"}
            </Button>
          </div>
        </SettingsSection>
        <SettingsSection
          wide
          icon={<Bell />}
          title="需要你时，主动通知"
          description="系统通知默认开启；可接一个 Webhook，同步目标状态变化，并把决定、验收、到期跟进和真正需要介入的事项推到你的工作流。"
        >
          <div className="settings-facts">
            {webhook.configured && (
              <p>
                {webhook.endpoint} · {webhook.enabled ? "已启用" : "已暂停"}
                {webhook.tokenConfigured ? " · Bearer 认证" : ""}
                {" · "}
                {webhook.statuses.length ? `${webhook.statuses.length} 种状态` : "不订阅状态变化"}
              </p>
            )}
            {webhook.lastSuccessAt && <p>最近送达：{time(webhook.lastSuccessAt)}</p>}
            {webhook.lastError && (
              <p className="ui-field__error">
                上次发送失败：{webhook.lastError}
                {webhook.lastErrorAt ? ` · ${time(webhook.lastErrorAt)}` : ""}
              </p>
            )}
          </div>
          <div className="ui-settings-card__actions">
            <Button variant="secondary" size="sm" onClick={openWebhook}>
              {webhook.configured ? "管理 Webhook" : "配置 Webhook"}
            </Button>
          </div>
        </SettingsSection>
        <p className="settings-foot">
          Crewvane {version} · 一位管家 · {state.projects.length} 个空间 ·{" "}
          {state.goals.length} 个目标
        </p>
      </div>
    </div>
  );
}
const shipPolicyLabels: Record<ShipPolicy, string> = {
  "external-approval": "外部审批（默认）",
  auto: "检查通过后自动合并与上线",
  "auto-merge-manual-deploy": "自动合并，上线前审批",
};
function GovernanceEditor({
  projects,
  decisions,
  busy,
  onSave,
}: {
  projects: Project[];
  decisions: WorkspaceState["decisions"];
  busy: boolean;
  onSave: (projectId: string, policy: { shipPolicy: ShipPolicy; approvers: string[] }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string>();
  return (
    <SettingsSection
      wide
      icon={<Settings2 />}
      title="上线策略与决定账本"
      description="默认要求外部审批。自动策略只跳过审批，不跳过检查；删数据、停服、花钱、外部发消息、改产品方向、新建或轮换密钥、改权限、修改上线策略始终会进入注意力。"
    >
      <span className="settings-status">{decisions.length} 条已记住的决定</span>
      <div className="policy-list">
        {projects.map(project => {
          const open = editing === project.id;
          return (
            <div className="policy-row" key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <span>{shipPolicyLabels[project.policy.shipPolicy]}</span>
                {project.policy.approvers.length > 0 && (
                  <small>审批人：{project.policy.approvers.join("、")}</small>
                )}
              </div>
              {!open ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditing(project.id)}
                >
                  配置
                </Button>
              ) : (
                <form
                  key={`${project.id}-${project.policy.revision}`}
                  onSubmit={async event => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    try {
                      await onSave(project.id, {
                        shipPolicy: String(data.get("shipPolicy")) as ShipPolicy,
                        approvers: String(data.get("approvers"))
                          .split(/[\n,，、]/).map(value => value.trim()).filter(Boolean),
                      });
                      setEditing(undefined);
                    } catch {
                      /* The parent shows the server error. */
                    }
                  }}
                >
                  <Field label="上线策略">
                    <Select name="shipPolicy" defaultValue={project.policy.shipPolicy} disabled={busy}>
                      {Object.entries(shipPolicyLabels).map(([value, label]) => (
                        <option value={value} key={value}>{label}</option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="外部审批人（可选）">
                    <TextInput
                      name="approvers"
                      defaultValue={project.policy.approvers.join("、")}
                      placeholder="例如：YR、平台组"
                      disabled={busy}
                    />
                  </Field>
                  <div className="policy-actions">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(undefined)}>
                      取消
                    </Button>
                    <Button type="submit" variant="primary" size="sm" disabled={busy}>
                      保存策略
                    </Button>
                  </div>
                </form>
              )}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}
function AgentPreferencesEditor({ preferences, options, busy, onSave }: {
  preferences: AgentPreferences;
  options: { kind: string; installed: boolean }[];
  busy: boolean;
  onSave: (preferences: AgentPreferences) => Promise<void>;
}) {
  const [commands, setCommands] = useState(preferences);
  useEffect(() => { setCommands(preferences); }, [preferences.concierge, preferences.owner, preferences.worker]);
  const installed = options.filter(option => option.installed);
  return (
    <SettingsSection
      wide
      icon={<Bot />}
      title="Agent 启动命令"
      description="填写每个角色的启动命令，可附带模型等原生参数。Crewvane 不替换 CLI，也不借用 Codex 等运行时专属的沙箱参数；已有会话继续工作，新会话使用保存后的命令。"
    >
      <form
        className="ui-form"
        onSubmit={async event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            await onSave({
              concierge: String(data.get("concierge")),
              owner: String(data.get("owner")) || undefined,
              worker: String(data.get("worker")) || undefined,
            });
          } catch {
            /* Parent keeps the existing preferences and displays the error. */
          }
        }}
      >
        <div className="agent-role-grid ui-form__grid">
          {(["concierge", "owner", "worker"] as const).map((role, index) => (
            <Field label={`${["管家", "负责人", "工人"][index]}启动命令`} key={role}>
              <TextInput
                name={role}
                list="installed-agent-commands"
                value={commands[role] ?? ""}
                onChange={event => setCommands(current => ({ ...current, [role]: event.target.value }))}
                placeholder={role === "concierge" ? "codex" : role === "owner" ? "留空跟随管家" : "留空跟随负责人"}
                required={role === "concierge"}
                maxLength={2000}
                disabled={busy}
                spellCheck={false}
              />
            </Field>
          ))}
        </div>
        <datalist id="installed-agent-commands">
          {installed.map(option => <option key={option.kind} value={option.kind} />)}
        </datalist>
        <div className="ui-form__footer">
          <p className="ui-form__note">
            填写本机任意交互式 CLI 和参数，例如 codex --model gpt-5、npx --yes my-agent。支持绝对路径与 ~/ 路径；自定义 CLI 直接在终端启动，无需 Herdr 类型适配。管家案卷边界由 Crewvane CLI 约束，不是操作系统文件沙箱。环境变量和 shell 表达式请放入自己的启动脚本。
          </p>
          <Button type="submit" variant="secondary" disabled={busy}>
            保存偏好
          </Button>
        </div>
      </form>
    </SettingsSection>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
