import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { ArrowLeft, ChevronRight, ExternalLink, FileText, Grip, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { api } from "./api.js";
import type { GoalSceneContext } from "./features/goals/goalPresentation.js";
import "@xterm/xterm/css/xterm.css";

type TerminalGeometry = { x: number; y: number; width: number; height: number };
const geometryKey = "crewvane.terminal.geometry";
const minWidth = 480, minHeight = 260;
function savedGeometry(): TerminalGeometry | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(geometryKey) ?? "null") as Partial<TerminalGeometry> | null;
    if (
      value &&
      Number.isFinite(value.x) &&
      Number.isFinite(value.y) &&
      Number.isFinite(value.width) &&
      Number.isFinite(value.height)
    )
      return value as TerminalGeometry;
  } catch {
    // Invalid local layout falls back to the panel's responsive default.
  }
}
function boundedGeometry(input: TerminalGeometry): TerminalGeometry {
  const width = Math.min(Math.max(minWidth, input.width), Math.max(minWidth, window.innerWidth - 16));
  const height = Math.min(Math.max(minHeight, input.height), Math.max(minHeight, window.innerHeight - 16));
  return {
    x: Math.min(Math.max(8, input.x), Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(Math.max(8, input.y), Math.max(8, window.innerHeight - height - 8)),
    width,
    height,
  };
}
export function HerdrTerminal({ session, title, goal, theme, visible, onClose, onOpenGoal, onReturnToAttention }: {
  session: string; title: string; goal?: GoalSceneContext; theme: string; visible: boolean; onClose: () => void;
  onOpenGoal: (goalId: string) => void;
  onReturnToAttention: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | undefined>(undefined);
  const noticeTimer = useRef<number | undefined>(undefined);
  const lastPaste = useRef<{ text: string; at: number } | undefined>(undefined);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [error, setError] = useState(""), [expanded, setExpanded] = useState(false);
  const [externalBusy, setExternalBusy] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState("");
  const [geometry, setGeometry] = useState<TerminalGeometry | undefined>(savedGeometry);
  const [attempt, setAttempt] = useState(0);
  function announceClipboardNotice(message: string) {
    window.clearTimeout(noticeTimer.current);
    setClipboardNotice(message);
    noticeTimer.current = window.setTimeout(() => setClipboardNotice(""), 2200);
  }
  function pasteText(text: string) {
    const terminal = term.current;
    if (!terminal) return;
    if (!text) {
      announceClipboardNotice("剪贴板里没有可粘贴的文字");
      terminal.focus();
      return;
    }
    const now = performance.now(), previous = lastPaste.current;
    if (previous?.text === text && now - previous.at < 250) {
      terminal.focus();
      return;
    }
    lastPaste.current = { text, at: now };
    terminal.focus();
    terminal.paste(text);
    announceClipboardNotice(`已粘贴 ${Array.from(text).length} 个字符`);
  }
  function pasteSystemClipboard() {
    void api.readClipboardContent()
      .then(content => {
        if (content.kind === "text") {
          pasteText(content.text);
          return;
        }
        if (content.kind === "image") {
          const terminal = term.current;
          terminal?.focus();
          void api.writeTerminal(session, "\x16")
            .then(() => announceClipboardNotice("已把剪贴板图片交给当前 Agent"))
            .catch(reason => {
              announceClipboardNotice("图片粘贴失败");
              setError(String(reason).replace(/^Error: /, ""));
            });
          return;
        }
        announceClipboardNotice("剪贴板是空的");
        term.current?.focus();
      })
      .catch((reason) => {
        announceClipboardNotice("读取剪贴板失败");
        setError(String(reason).replace(/^Error: /, ""));
      });
  }
  function handlePaste(event: ReactClipboardEvent<HTMLElement>) {
    const text = event.clipboardData.getData("text/plain");
    event.preventDefault();
    event.stopPropagation();
    if (text) pasteText(text);
    else pasteSystemClipboard();
  }
  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      event.stopPropagation();
      pasteSystemClipboard();
    }
  }
  useEffect(() => {
    const terminal = new Terminal({
      cursorBlink: true, fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      fontSize: 13, lineHeight: 1.25, scrollback: 3000,
      allowProposedApi: false, screenReaderMode: true,
      rightClickSelectsWord: true,
      cols: 120, rows: 32, theme: terminalTheme(theme),
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const copyShortcut = (event.metaKey && key === "c") ||
        (event.ctrlKey && event.shiftKey && key === "c");
      if (copyShortcut) {
        const selection = terminal.getSelection();
        if (!selection) return true;
        event.preventDefault();
        void api.writeClipboardText(selection)
          .then(() => announceClipboardNotice(`已复制 ${Array.from(selection).length} 个字符`))
          .catch(report);
        return false;
      }
      return true;
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const clipboard = new ClipboardAddon(undefined, {
      // OSC 52 clipboard reads would expose the host clipboard to terminal
      // applications. Herdr only needs writes for copy-on-select.
      readText: () => "",
      async writeText(selection, text) {
        if (selection !== "c") return;
        try {
          await api.writeClipboardText(text);
          announceClipboardNotice(`已复制 ${Array.from(text).length} 个字符`);
        } catch (reason) {
          report(reason);
        }
      },
    });
    terminal.loadAddon(clipboard);
    terminal.open(container.current!);
    term.current = terminal;
    let active = true, hydrated = false, queued: { data: string; sequence: number }[] = [];
    const report = (reason: unknown) => { if (active) setError(String(reason).replace(/^Error: /, "")); };
    const resize = () => {
      if (!active || !hydrated || !container.current?.clientWidth || !container.current.clientHeight) return;
      fit.fit();
      void api.resizeTerminal(session, terminal.cols, terminal.rows).catch(report);
    };
    const unsubscribe = api.subscribe((event) => {
      if (event.session !== session) return;
      if (event.type === "terminal-data") {
        if (hydrated) terminal.write(event.data);
        else queued.push({ data: event.data, sequence: event.sequence });
      }
      if (event.type === "terminal-exit") setError(event.error || "终端连接已断开。目标和会话记录仍然保留，可重新连接。");
    });
    setError("");
    void api.terminalSnapshot().then((snapshot) => {
      if (!active) return;
      if (!snapshot || snapshot.session !== session) throw new Error("当前工作区没有已连接的 Herdr 终端");
      terminal.resize(snapshot.cols, snapshot.rows);
      terminal.write(snapshot.data, () => {
        if (!active) return;
        for (const chunk of queued) if (chunk.sequence > snapshot.sequence) terminal.write(chunk.data);
        queued = [];
        hydrated = true;
        if (!snapshot.running) report(snapshot.error || "终端已断开，请重新连接");
        resize();
        if (visibleRef.current) terminal.focus();
      });
    }).catch(report);
    const input = terminal.onData((data) => { void api.writeTerminal(session, data).catch(report); });
    const observer = new ResizeObserver(resize);
    observer.observe(container.current!);
    return () => {
      active = false;
      observer.disconnect(); unsubscribe(); input.dispose(); clipboard.dispose(); terminal.dispose();
      term.current = undefined;
    };
    // Theme is updated in-place below so changing it never reconnects a session.
  }, [session, attempt]);
  useEffect(() => { if (term.current) term.current.options.theme = terminalTheme(theme); }, [theme]);
  useEffect(() => { if (visible) term.current?.focus(); else term.current?.blur(); }, [visible]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    if (!expanded) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [expanded]);
  useEffect(() => {
    const resize = () => {
      setGeometry(current => current ? boundedGeometry(current) : current);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  function beginDrag(event: ReactPointerEvent<HTMLElement>) {
    if (expanded || event.button !== 0 || (event.target as HTMLElement).closest("button"))
      return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    setGeometry(boundedGeometry({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }));
    const move = (current: PointerEvent) => {
      setGeometry(boundedGeometry({
        x: rect.left + current.clientX - start.x,
        y: rect.top + current.clientY - start.y,
        width: rect.width,
        height: rect.height,
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setGeometry(current => {
        if (current) localStorage.setItem(geometryKey, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }
  function beginResize(event: ReactPointerEvent<HTMLElement>) {
    if (expanded) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.parentElement!.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    const move = (current: PointerEvent) => {
      setGeometry(boundedGeometry({
        x: rect.left,
        y: rect.top,
        width: rect.width + current.clientX - start.x,
        height: rect.height + current.clientY - start.y,
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      setGeometry(current => {
        if (current) localStorage.setItem(geometryKey, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }
  return (
    <section
      className={`terminal-panel ${expanded ? "expanded" : ""} ${geometry ? "has-geometry" : ""} ${visible ? "" : "terminal-hidden"}`}
      style={!expanded && geometry ? {
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height,
      } : undefined}
      aria-label="Herdr 工作现场"
      aria-hidden={!visible}
      inert={!visible}
      onKeyDownCapture={handleKeyDown}
      onPasteCapture={handlePaste}
    >
      <header className="terminal-heading terminal-drag-handle" onPointerDown={beginDrag} onDoubleClick={() => setExpanded(value => !value)}>
        <div>
          <span className={`terminal-dot ${error ? "offline" : ""}`} />
          <strong>{title}</strong>
          <small>轻现场</small>
          <small className="terminal-clipboard-status" role="status" aria-live="polite">
            {clipboardNotice || (
              title === "全局管家"
                ? "拖动文本自动复制"
                : "HERDR · 拖动文本自动复制"
            )}
          </small>
        </div>
        <div>
          <button
            className="icon-button"
            aria-label="在外部终端打开"
            title="在外部终端打开同一现场"
            disabled={externalBusy}
            onClick={() => {
              setExternalBusy(true);
              void api.openExternalScene(goal?.id)
                .then(lease => announceClipboardNotice(
                  `已在 ${lease.terminal === "iterm2" ? "iTerm2" : lease.terminal === "terminal" ? "Terminal" : "Ghostty"} 打开`,
                ))
                .catch(reason => setError(String(reason).replace(/^Error: /, "")))
                .finally(() => setExternalBusy(false));
            }}
          >
            <ExternalLink size={16} />
          </button>
          <button className="icon-button" aria-label={expanded ? "退出全屏现场" : "全屏显示现场"} title={expanded ? "退出全屏（Esc）" : "全屏显示"} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          <button className="secondary terminal-hide" title="隐藏面板，Agent 继续执行" onClick={onClose}><X size={15} />隐藏终端</button>
        </div>
      </header>
      {goal && (
        <div className="scene-context" role="region" aria-label={`现场目标：${goal.title}`}>
          <button type="button" className="scene-attention" onClick={onReturnToAttention}>
            <ArrowLeft size={14} />回到注意力
          </button>
          <span className="scene-context-divider" />
          <div className="scene-goal-copy">
            <small>{goal.projectName} · {goal.label}</small>
            <strong title={goal.title}>{goal.title}</strong>
          </div>
          <div className="scene-current-action" title={goal.currentAction}>
            <small>当前事项</small>
            <span>{goal.currentAction}</span>
          </div>
          <button
            type="button"
            className="scene-record"
            aria-label="目标记录"
            title="目标记录"
            onClick={() => onOpenGoal(goal.id)}
          >
            <FileText size={14} /><span>目标记录</span><ChevronRight size={13} />
          </button>
        </div>
      )}
      {error && <div className="terminal-error" role="alert"><span>{error}</span><button className="secondary" onClick={async () => {
        try { await api.openHerdr(goal?.id); setAttempt((value) => value + 1); }
        catch (reason) { setError(String(reason)); }
      }}><RefreshCw size={14} />重新连接</button></div>}
      <div className="terminal-surface" ref={container} />
      {!expanded && <span className="terminal-resize" aria-label="拖动调整现场大小" title="拖动调整大小" onPointerDown={beginResize}><Grip size={13} /></span>}
    </section>
  );
}
function terminalTheme(_theme: string) {
  // Herdr and CLI agents render their own ANSI palette. Keep their canvas dark
  // in both app themes so hard-coded light text remains readable.
  return { background: "#111420", foreground: "#dce1f0", cursor: "#b4a2ff", selectionBackground: "#383250" };
}
