import { useEffect, useState } from "react";
import { Download, FolderOpen, RefreshCw, SquareTerminal } from "lucide-react";
import { api } from "../../api.js";
import { Button, LoadingState, SettingsSection } from "../../ui/index.js";
import type { OrcaInstallationStatus } from "../../../electron/orca-install.js";

export function OrcaInstallationCard() {
  const [status, setStatus] = useState<OrcaInstallationStatus>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void api.orcaStatus().then(value => { if (active) setStatus(value); })
      .catch(e => { if (active) setError(String(e)); });
    const unsubscribe = api.subscribe(event => {
      if (event.type === "orca-installation") setStatus(event.status);
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  const downloading = status?.phase === "downloading";
  const busy = pending || ["checking", "downloading", "verifying"].includes(status?.phase ?? "");
  async function act(action: "check" | "install" | "refresh" | "select") {
    setPending(true);
    setError(undefined);
    try {
      const result = action === "select" ? await api.selectOrcaApplication() : await api.orcaAction(action);
      if (result) setStatus(result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  }
  const installed = !!status?.detection.version;
  const compatible = status?.detection.status === "compatible";
  const newer = status?.detection.version && status.verifiedVersion &&
    status.detection.version.split(".").map(Number).reduce((order, part, index) =>
      order || Math.sign(part - Number(status.verifiedVersion.split(".")[index] ?? 0)), 0) > 0;
  return (
    <SettingsSection wide icon={<SquareTerminal />} title="Orca"
      description="使用官方原生工作现场。更新安装与切换后端分开进行，现有目标和终端保持原安排。">
      {status ? <>
        <div className="settings-inline">
          <span className={`settings-status ${compatible ? "ready" : ""}`}>
            <i />{installed ? `已安装 ${status.detection.version}` : "尚未安装"}
          </span>
          <span className="muted">本版已验证 {status.verifiedVersion}</span>
          {status.latestVersion && status.latestVersion !== status.verifiedVersion &&
            <span className="muted">官方最新 {status.latestVersion} · 待兼容验证</span>}
        </div>
        {status.detection.appPath && <div className="settings-facts"><code>{status.detection.appPath}</code></div>}
        <p className={status.phase === "error" ? "ui-field__error" : "muted"}
          role={status.phase === "error" ? "alert" : "status"} aria-live="polite">{status.detail}</p>
        {downloading && <progress aria-label="Orca 安装包下载进度"
          max={status.totalBytes || 1} value={status.receivedBytes || 0} className="orca-download-progress" />}
        <div className="ui-settings-card__actions">
          <Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} disabled={busy}
            onClick={() => void act("check")}>检查更新</Button>
          {(!compatible || status.updateAvailable) && <Button size="sm" icon={<Download size={14} />}
            disabled={busy || !!newer}
            onClick={() => void act("install")}>{!installed ? "安装 Orca" :
              status.updateAvailable ? "更新 Orca" : "重新安装 Orca"}</Button>}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act("refresh")}>重新检测</Button>
          <Button variant="ghost" size="sm" icon={<FolderOpen size={14} />} disabled={busy}
            onClick={() => void act("select")}>选择已有 Orca</Button>
          <Button variant="ghost" size="sm"
            onClick={() => void api.openUrl("https://github.com/stablyai/orca/releases")}>官方发布页</Button>
          {downloading && <Button variant="ghost" size="sm"
            onClick={() => void api.orcaAction("cancel").catch(e => setError(String(e)))}>取消下载</Button>}
          {status.phase === "awaiting_installation" && <Button variant="ghost" size="sm"
            onClick={() => void api.orcaAction("cancel").then(value => { if (value) setStatus(value); })
              .catch(e => setError(String(e)))}>取消更新</Button>}
        </div>
      </> : <LoadingState label="正在检测 Orca…" />}
      {error && <p role="alert" className="ui-field__error">{error}</p>}
    </SettingsSection>
  );
}
