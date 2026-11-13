import { useState, type ReactNode } from "react";
import {
  ArrowRight,
  Check,
  CircleAlert,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { api, type BackendControlStatus } from "../../api.js";
import { Button, LoadingState, Modal, SettingsSection } from "../../ui/index.js";

const phaseLabels: Record<string, string> = {
  preflight: "检查兼容性与现场",
  prepared: "已准备交接",
  quiescing: "等待负责人完成当前回合",
  old_stopped: "旧现场已停止",
  committing: "保存新后端选择",
  resuming: "恢复管家与目标现场",
  ready: "已生效",
  cancelled: "交接已取消",
  recovery_required: "交接需要恢复",
};

export function BackendSelectionCard({
  status,
  onStatusChange,
}: {
  status?: BackendControlStatus;
  onStatusChange(status: BackendControlStatus): void;
}) {
  const [target, setTarget] = useState<"herdr" | "orca">();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(backend: "herdr" | "orca") {
    setError(undefined);
    if (backend === status?.control.selected && status.control.phase === "ready") return;
    if (backend === "orca" && status?.orca.detection.status !== "compatible") {
      setError("请先在下方安装并验证 Orca，安装完成后再切换。当前后端和目标不会改变。");
      return;
    }
    setTarget(backend);
  }

  async function confirmSwitch() {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.switchBackend(target);
      onStatusChange(result.status);
      if (result.journal?.phase === "recovery_required" || result.journal?.phase === "cancelled")
        setError(result.journal.detail ?? "交接没有完成，请检查现场后重试。");
      else setTarget(undefined);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.retryBackendSwitch();
      onStatusChange(result.status);
      if (result.journal?.phase === "recovery_required")
        setError(result.journal.detail ?? "恢复仍未完成，请先打开对应现场核对。");
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.restoreBackend();
      onStatusChange(result.status);
      if (result.journal?.phase !== "ready") setError(result.journal?.detail ?? "恢复仍需核对现场。");
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function endUpdate() {
    setBusy(true);
    setError(undefined);
    try {
      await api.orcaAction("cancel");
      onStatusChange(await api.backendStatus());
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }

  if (!status) return (
    <SettingsSection wide icon={<ShieldCheck />} title="执行现场"
      description="整个 Crewvane 安装一次只使用一套会话后端。">
      <LoadingState label="正在检查会话后端…" />
    </SettingsSection>
  );

  const switching = status.control.phase !== "ready" || !!status.control.maintenance;
  const journal = status.journal;
  return <>
    <SettingsSection wide icon={<ShieldCheck />} title="执行现场"
      description="整个 Crewvane 安装一次只使用一套后端。切换会先核实并停止旧受管现场，再按目标记录恢复；完整终端历史不会搬移。">
      <div className="backend-choice-grid" role="radiogroup" aria-label="会话后端">
        <BackendChoice
          name="Herdr"
          detail="熟悉的终端、内嵌轻现场与 Herdr 原生快捷键。"
          selected={status.control.selected === "herdr"}
          disabled={busy || switching}
          onSelect={() => void choose("herdr")}
          icon={<SquareTerminal size={20} />}
        />
        <BackendChoice
          name="Orca"
          detail="原生工作现场、代码与 Diff；Crewvane 聚焦注意力与验收。"
          selected={status.control.selected === "orca"}
          disabled={busy || switching}
          available={status.orca.detection.status === "compatible"}
          onSelect={() => void choose("orca")}
          icon={<span className="backend-orca-mark" aria-hidden="true">O</span>}
        />
      </div>
      <div className="backend-facts" role="status" aria-live="polite" aria-atomic="true">
        <span><strong>{status.workspaces.length}</strong> 个工作区</span>
        <span><strong>{status.impact.goals}</strong> 个未结束目标</span>
        <span><strong>{status.impact.scenes}</strong> 个受管现场</span>
        <span>{status.control.selected === "orca" ? "Orca" : "Herdr"} 当前生效</span>
      </div>
      {switching && <div className={`backend-switch-state ${status.control.phase}`}>
        <RefreshCw size={16} className={busy ? "spin" : ""} />
        <div>
          <strong>{status.control.maintenance ? "Orca 更新期间暂停派发" :
            phaseLabels[journal?.phase ?? status.control.phase] ?? "正在交接现场"}</strong>
          <p>{status.control.maintenance ? "完成安装后点击“重新检测”恢复派发；取消更新可解除暂停。目标和消息仍会保存。" :
            journal?.detail ?? "内容会继续保存；交接完成前不会向新旧两套后端同时派发业务任务。"}</p>
        </div>
        {status.control.phase === "recovery_required" && <Button size="sm" variant="secondary"
          disabled={busy} onClick={() => void retry()}>恢复交接</Button>}
        {status.control.phase === "recovery_required" && <Button size="sm" variant="secondary"
          disabled={busy} onClick={() => void restore()}>恢复原后端</Button>}
        {status.control.maintenance && <Button size="sm" variant="secondary"
          disabled={busy} onClick={() => void endUpdate()}>结束更新</Button>}
      </div>}
      {error && <div className="backend-error" role="alert">
        <CircleAlert size={16} /><span>{error}</span>
      </div>}
    </SettingsSection>
    {target && <Modal
      title={`切换到 ${target === "orca" ? "Orca" : "Herdr"}？`}
      description="这会作用于本安装的所有工作区。"
      error={error}
      onClose={() => { if (!busy) setTarget(undefined); }}
    >
      <div className="backend-confirm">
        <div><Check size={17} /><span>目标、消息、附件、决定和验收记录保持不变。</span></div>
        <div><Check size={17} /><span>先核实并停止旧受管现场，再创建新的管家运行实例。</span></div>
        <div><Check size={17} /><span>活动目标按保存的案卷恢复；原生会话只在后端明确支持时沿用。</span></div>
        <div><CircleAlert size={17} /><span>正在执行或结果未确认的目标会阻止自动切换，避免重复工作。</span></div>
      </div>
      <div className="modal-actions">
        {busy && ["preflight", "prepared"].includes(journal?.phase ?? "preflight") &&
          <Button variant="secondary" onClick={() => void api.cancelBackendSwitch()}>取消准备</Button>}
        <Button variant="secondary" disabled={busy} onClick={() => setTarget(undefined)}>保留当前后端</Button>
        <Button disabled={busy} onClick={() => void confirmSwitch()}>
          {busy ? "正在交接…" : <>切换到 {target === "orca" ? "Orca" : "Herdr"} <ArrowRight size={15} /></>}
        </Button>
      </div>
    </Modal>}
  </>;
}

function BackendChoice({
  name,
  detail,
  icon,
  selected,
  disabled,
  available = true,
  onSelect,
}: {
  name: string;
  detail: string;
  icon: ReactNode;
  selected: boolean;
  disabled: boolean;
  available?: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      className={`backend-choice ${selected ? "selected" : ""} ${!available ? "unavailable" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="backend-choice__icon">{icon}</span>
      <span className="backend-choice__copy">
        <strong>{name}</strong>
        <span>{detail}</span>
      </span>
      <span className="backend-choice__state">
        {selected ? <><Check size={14} /> 当前使用</> : !available ? "先安装" : "可切换"}
      </span>
    </button>
  );
}

function message(reason: unknown) {
  return (reason instanceof Error ? reason.message : String(reason))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
