import { ArrowRight, Check, DownloadCloud, Rocket, RotateCw, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ApplicationUpdateProgress, ApplicationUpdateResult, ApplicationUpdateStatus, AuthStatus } from "../../api/contracts";
import { requestJson } from "../../api/client";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../../components/ui/dialog";

const UPDATE_STEPS = [
  "校验运行环境与目标版本",
  "下载 Windows portable 更新包",
  "解压并校验更新包结构",
  "交接安全更新脚本并重启控制台",
];
const ACTIVE_UPDATE_STATES = new Set<ApplicationUpdateProgress["state"]>([
  "checking", "downloading", "validating", "handoff", "restart_scheduled", "waiting_for_exit", "installing", "restarting",
]);
const TERMINAL_UPDATE_STATES = new Set<ApplicationUpdateProgress["state"]>(["completed", "failed"]);

export function ApplicationUpdatePanel({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<ApplicationUpdateStatus | null>(null);
  const [progress, setProgress] = useState<ApplicationUpdateProgress>({ state: "idle", step: 0, message: "等待开始升级。" });
  const [open, setOpen] = useState(false);
  const [requestPending, setRequestPending] = useState(false);
  const [statusPending, setStatusPending] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [dismissedProgress, setDismissedProgress] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const checkStatus = useCallback(async () => {
    setStatusPending(true);
    setStatusError("");
    try {
      setStatus(await requestJson<ApplicationUpdateStatus>("/api/maintenance/application-update"));
    } catch (caught) {
      setStatusError(caught instanceof Error ? caught.message : "检查 PalServerConsole 更新失败");
    } finally {
      setStatusPending(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void checkStatus();
    void requestJson<ApplicationUpdateProgress>("/api/maintenance/application-update/progress")
      .then((next) => {
        if (!active) return;
        setProgress(next);
        if (next.state !== "idle" && !wasProgressDismissed(next)) setOpen(true);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [checkStatus]);

  async function refreshProgress() {
    try {
      const next = await requestJson<ApplicationUpdateProgress>("/api/maintenance/application-update/progress");
      setProgress(next);
    } catch {
      // The console intentionally becomes unreachable while the helper restarts it.
    }
  }

  useEffect(() => {
    if (!ACTIVE_UPDATE_STATES.has(progress.state)) return;
    const timer = window.setInterval(() => {
      void requestJson<ApplicationUpdateProgress>("/api/maintenance/application-update/progress")
        .then(setProgress)
        .catch(() => undefined);
    }, 500);
    return () => window.clearInterval(timer);
  }, [progress.state]);

  async function install() {
    if (!status) return;
    setRequestPending(true);
    setError("");
    setMessage("");
    setProgress({ state: "checking", step: 1, message: "正在校验运行环境与目标版本。" });
    try {
      const result = await requestJson<ApplicationUpdateResult>("/api/maintenance/application-update", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ expectedVersion: status.latestVersion }),
      });
      await refreshProgress();
      setProgress({ state: "restart_scheduled", step: 4, message: result.message });
      setMessage(result.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "安装 PalServerConsole 更新失败");
      await refreshProgress();
    } finally {
      setRequestPending(false);
    }
  }

  const updateAvailable = Boolean(status?.updateAvailable);
  const hasVisibleProgress = progress.state !== "idle" && !dismissedProgress;
  const hasStatusError = Boolean(statusError && !status);
  if (!updateAvailable && !hasVisibleProgress && !hasStatusError) return null;

  const releaseNotes = status?.releaseNotes ?? [];
  const installAllowed = Boolean(auth.local && status?.portable && updateAvailable);
  const busy = requestPending || (ACTIVE_UPDATE_STATES.has(progress.state) && progress.state !== "restart_scheduled");
  const showProgress = busy || Boolean(message) || hasVisibleProgress;
  const latestVersion = status?.latestVersion;

  function changeOpen(next: boolean) {
    if (!next && busy) return;
    setOpen(next);
    if (!next && TERMINAL_UPDATE_STATES.has(progress.state)) {
      rememberDismissedProgress(progress);
      setDismissedProgress(true);
    }
  }

  return <>
    <Button className="psc-update-trigger" data-state={hasStatusError ? "error" : undefined} type="button" title={hasStatusError ? "更新检查失败，点击查看并重试" : updateAvailable ? `检测到新版本 v${latestVersion}，点击查看更新详情并一键升级` : "查看最近一次控制台升级结果"} aria-label={hasStatusError ? "PalServerConsole 更新检查失败" : updateAvailable ? `升级 PalServerConsole 至 v${latestVersion}` : "查看 PalServerConsole 升级结果"} onClick={() => setOpen(true)}>
      {hasStatusError ? <RotateCw aria-hidden="true" /> : <Rocket aria-hidden="true" />}<span className="psc-update-label">{hasStatusError ? "更新检查失败" : updateAvailable ? "升级" : "升级结果"}</span>{latestVersion && <span>v{latestVersion}</span>}{!hasStatusError && <span className="psc-update-alert-dot" aria-hidden="true"><span /></span>}
    </Button>

    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="psc-update-dialog" overlayClassName="psc-update-overlay" showCloseButton={!busy}>
        <header className="psc-update-header">
          <span className="psc-update-icon"><Rocket aria-hidden="true" /></span>
          <DialogTitle className="psc-update-title">PalServerConsole 控制台升级</DialogTitle>
          <span className="psc-update-stable"><Sparkles aria-hidden="true" />官方稳定版推送</span>
          <DialogDescription className="psc-update-versions">
            {status && <><span>当前: {status.currentVersion}</span><ArrowRight aria-hidden="true" /><strong>目标: {status.latestVersion}</strong></>}
            {status?.publishedAt && <time dateTime={status.publishedAt}>· 发布于 {formatReleaseDate(status.publishedAt)}</time>}
          </DialogDescription>
        </header>

        <div className="psc-update-body">
          {hasStatusError ? <section className="psc-update-load-error" role="alert"><RotateCw aria-hidden="true" /><div><strong>暂时无法检查控制台更新</strong><p>{statusError}</p></div></section> : showProgress ? <UpdateProgress progress={progress} message={message} /> : <>
            <section className="psc-update-notes" aria-labelledby="psc-update-notes-title">
              <div className="psc-update-section-title"><span id="psc-update-notes-title"><Zap aria-hidden="true" />更新亮点与变更日志</span><small>{releaseNotes.length} 项变更</small></div>
              <div className="psc-update-note-list">{releaseNotes.length ? releaseNotes.map((note, index) => <p key={`${index}-${note}`}><span aria-hidden="true" />{note}</p>) : <p className="psc-update-empty">本次 Release 未提供变更说明。</p>}</div>
            </section>
            <div className="psc-update-safety"><ShieldCheck aria-hidden="true" /><div><strong>升级前强制备份控制台数据库</strong><small>此安全步骤固定启用；用户数据与实例配置会保留，真实存档不会被修改。</small></div><input className="psc-update-check" type="checkbox" checked disabled aria-label="升级前自动备份（强制启用）" /></div>
          </>}
          {updateAvailable && !installAllowed && <p className="psc-update-notice" role="note">{auth.local ? "当前为源码运行模式；自动安装仅支持 Windows portable。" : "可从 LAN 查看更新；安装只能在控制台本机执行。"}</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>

        <DialogFooter className="psc-update-footer">
          <Button variant="outline" type="button" disabled={busy} onClick={() => changeOpen(false)}>{hasStatusError ? "关闭" : hasVisibleProgress ? "知道了" : "稍后提醒"}</Button>
          {hasStatusError && <Button className="psc-update-install" type="button" disabled={statusPending} onClick={() => void checkStatus()}>{statusPending && <RotateCw className="psc-update-spin" aria-hidden="true" />}{statusPending ? "正在重新检查" : "重新检查"}</Button>}
          {updateAvailable && !status?.portable && status?.releaseUrl && <a className="psc-update-release" href={status.releaseUrl} target="_blank" rel="noreferrer">查看 Release</a>}
          {installAllowed && <Button className="psc-update-install" type="button" disabled={busy || Boolean(message)} onClick={() => void install()}>{busy ? <RotateCw className="psc-update-spin" aria-hidden="true" /> : <DownloadCloud aria-hidden="true" />}{busy ? "正在准备升级" : "升级并重启"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function UpdateProgress({ progress, message }: { progress: ApplicationUpdateProgress; message: string }) {
  return <section className="psc-update-progress" aria-live="polite">
    <div><h3>{progress.state === "completed" ? "升级已完成" : progress.state === "failed" ? "升级失败" : message ? "更新任务已交接" : "正在准备控制台升级..."}</h3><p>{message || progress.message}</p>{progress.errorCode && <code>{progress.errorCode}</code>}</div>
    <progress max={4} value={progress.step} aria-label={`升级准备进度 ${progress.step}/4`} />
    <ol>{UPDATE_STEPS.map((label, index) => {
      const step = index + 1;
      const done = progress.step > step || progress.state === "restart_scheduled" || progress.state === "completed";
      const current = progress.step === step && !done;
      return <li key={label} data-state={done ? "done" : current ? "current" : "pending"}>{done ? <Check aria-hidden="true" /> : current ? <RotateCw className="psc-update-spin" aria-hidden="true" /> : <span aria-hidden="true" />}{step}. {label}</li>;
    })}</ol>
  </section>;
}

function progressKey(progress: ApplicationUpdateProgress): string {
  return `psc-update-result:${progress.updateId ?? `${progress.state}:${progress.errorCode ?? progress.message}`}`;
}

function wasProgressDismissed(progress: ApplicationUpdateProgress): boolean {
  return TERMINAL_UPDATE_STATES.has(progress.state) && window.sessionStorage.getItem(progressKey(progress)) === "dismissed";
}

function rememberDismissedProgress(progress: ApplicationUpdateProgress): void {
  if (TERMINAL_UPDATE_STATES.has(progress.state)) window.sessionStorage.setItem(progressKey(progress), "dismissed");
}

function formatReleaseDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}
