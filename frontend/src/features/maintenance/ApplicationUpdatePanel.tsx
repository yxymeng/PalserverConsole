import { CheckCircle2, Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type {
  ApplicationUpdateResult,
  ApplicationUpdateStatus,
  AuthStatus,
} from "../../api/contracts";
import { requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";

export function ApplicationUpdatePanel({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<ApplicationUpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);

  async function check() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await requestJson<ApplicationUpdateStatus>(
        "/api/maintenance/application-update",
      );
      setStatus(next);
      setMessage(next.updateAvailable ? "发现新版本 v" + next.latestVersion + "。" : "当前已是最新版本。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "检查 PalServerConsole 更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function install() {
    if (!status?.updateAvailable) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await requestJson<ApplicationUpdateResult>(
        "/api/maintenance/application-update",
        {
          method: "POST",
          headers: { "X-CSRF-Token": auth.csrfToken || "" },
          body: JSON.stringify({ expectedVersion: status.latestVersion }),
        },
      );
      setMessage(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "安装 PalServerConsole 更新失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="maintenance-section maintenance-update"
      id="maintenance-console-update"
      aria-labelledby="maintenance-console-update-title"
    >
      <div className="section-heading maintenance-card-heading">
        <span className="maintenance-card-icon"><Download aria-hidden="true" /></span>
        <div>
          <h2 id="maintenance-console-update-title">PalServerConsole 更新</h2>
          <p>只检查项目维护者发布到 GitHub Releases 的 Windows portable 版本。</p>
        </div>
      </div>
      <div className="maintenance-update-summary">
        <span><small>当前版本</small><strong>{status ? "v" + status.currentVersion : "等待检查"}</strong></span>
        <span><small>最新版本</small><strong>{status ? "v" + status.latestVersion : "等待检查"}</strong></span>
        <span><small>更新状态</small><strong>{status
            ? status.updateAvailable
              ? "有可用更新"
              : "已是最新"
            : "尚未检查"}</strong></span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && (
        <p className="form-success" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          {message}
        </p>
      )}
      {!auth.local && (
        <div className="notice-band">
          <ShieldCheck size={20} aria-hidden="true" />
          <span>可从 LAN 检查版本；安装更新只能在控制台本机执行。</span>
        </div>
      )}
      {status && !status.portable && (
        <div className="notice-band">
          <ShieldCheck size={20} aria-hidden="true" />
          <span>当前为源码运行模式；自动安装仅支持 Windows portable。</span>
        </div>
      )}
      <div className="maintenance-update-actions">
        <Button variant="outline" type="button" disabled={busy} onClick={() => void check()}>
          {busy ? <Spinner /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}
          检查更新
        </Button>
        {status?.releaseUrl && (
          <Button render={<a href={status.releaseUrl} target="_blank" rel="noreferrer" />} variant="outline">
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            查看 Release
          </Button>
        )}
        {auth.local && status?.portable && status.updateAvailable && (
          <Button type="button" disabled={busy} onClick={() => setConfirmInstall(true)}>
            <Download data-icon="inline-start" aria-hidden="true" />
            更新至 v{status.latestVersion}
          </Button>
        )}
      </div>
      <p className="muted">
        安装时会校验 portable 包结构，退出控制台后调用内置升级脚本；PalServer 和真实存档不会被修改。
      </p>
      <ConfirmActionDialog
        open={confirmInstall}
        title={"更新 PalServerConsole 至 v" + (status?.latestVersion || "") + "？"}
        description="控制台会下载并校验维护者发布的 portable 包，然后退出、保留 data 并完成升级，最后重新启动当前实例。"
        confirmLabel="下载并更新"
        disabled={busy}
        onOpenChange={setConfirmInstall}
        onConfirm={() => void install()}
      />
    </section>
  );
}
