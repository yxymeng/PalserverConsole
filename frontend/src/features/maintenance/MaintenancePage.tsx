import { ArchiveRestore, BellRing, CircleStop, Download, FileClock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AuthStatus, Operation, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { AuditPage } from "../audit/AuditPage";
import { BackupsPage } from "../backups/BackupsPage";
import { MaintenanceNotificationsPanel, MaintenancePanel } from "./MaintenancePanel";

export function MaintenancePage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const nextRequestSignal = useAbortableRequest();

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      setStatus(await requestJson<ShellStatus>("/api/shell/status", { signal }));
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "维护状态刷新失败");
    }
  }, [nextRequestSignal]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!operation || !["queued", "running"].includes(operation.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await requestJson<Operation>(`/api/server/operations/${operation.operationId}`);
        setOperation(next);
        if (!["queued", "running"].includes(next.state)) void refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "维护操作状态查询失败");
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);

  async function cancel() {
    if (!operation) return;
    try {
      await requestJson(`/api/server/operations/${operation.operationId}/cancel`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: "{}",
      });
      setMessage("取消请求已提交。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "取消失败");
    }
  }

  async function forceStop() {
    if (!operation || !window.confirm(`PalServer 未能优雅退出。确认强制结束 PID ${status?.pids.join(", ") || "未知"}？`)) return;
    try {
      setOperation(await requestJson<Operation>(`/api/server/operations/${operation.operationId}/force-stop`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "强制停止失败");
    }
  }

  return <div className="page-stack maintenance-page">
    <section className="maintenance-intro">
      <div><p className="maintenance-kicker">低频运维 · 本机明确操作</p><h2>维护中心</h2><p>服务器更新、官方备份、审计和维护通知集中在这里；高风险操作仍需要单独确认。</p></div>
      <button className="icon-button bordered" type="button" title="刷新维护状态" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    <nav className="maintenance-section-nav" aria-label="维护分区">
      <a href="#maintenance-update"><Download size={17} />服务器更新</a>
      <a href="#maintenance-backups"><ArchiveRestore size={17} />官方备份</a>
      <a href="#maintenance-audit"><FileClock size={17} />运营审计</a>
      <a href="#maintenance-notifications"><BellRing size={17} />维护通知</a>
    </nav>
    {operation && <section className="operation-band" aria-live="polite">
      <div><span>当前维护操作</span><strong>{operation.kind} · {operation.stage}</strong><small>{operation.errorCode ? `${operation.errorCode}: ${operation.detail || ""}` : operation.state}</small></div>
      {operation.stage === "countdown" && <button className="quiet-button" type="button" onClick={() => void cancel()}>取消</button>}
      {operation.state === "awaiting_force_confirmation" && <button className="danger-button" type="button" onClick={() => void forceStop()}><CircleStop size={18} />确认强制停止</button>}
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    <MaintenancePanel auth={auth} status={status} onOperation={setOperation} />
    <BackupsPage auth={auth} />
    <AuditPage auth={auth} />
    <MaintenanceNotificationsPanel auth={auth} />
  </div>;
}
