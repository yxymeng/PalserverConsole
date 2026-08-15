import { Activity, ArchiveRestore, BellRing, CircleStop, Download, FileClock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AuthStatus, Operation, OperationalHealth, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { AuditPage } from "../audit/AuditPage";
import { BackupsPage } from "../backups/BackupsPage";
import { OperationalHealthPanel } from "../overview/OperationalHealthPanel";
import { MaintenanceNotificationsPanel, MaintenancePanel } from "./MaintenancePanel";

type MaintenanceSection = "health" | "update" | "backups" | "audit" | "notifications";

const MAINTENANCE_SECTIONS = [
  { key: "health", label: "健康与容量", icon: Activity },
  { key: "update", label: "服务器更新", icon: Download },
  { key: "backups", label: "官方备份", icon: ArchiveRestore },
  { key: "audit", label: "运营审计", icon: FileClock },
  { key: "notifications", label: "维护通知", icon: BellRing },
] as const;

export function MaintenancePage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<ShellStatus | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [activeSection, setActiveSection] = useState<MaintenanceSection>(initialMaintenanceSection);
  const [health, setHealth] = useState<OperationalHealth | null>(null);
  const [healthRefreshToken, setHealthRefreshToken] = useState(0);
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

  function selectSection(section: MaintenanceSection) {
    setActiveSection(section);
    window.history.replaceState(null, "", `#maintenance-${section}`);
  }

  const healthSummary = maintenanceHealthSummary(health);

  return <div className="page-stack maintenance-page">
    <section className="maintenance-intro">
      <div><h2>维护中心</h2><p>健康巡检、服务器更新、官方备份、审计和维护通知按任务分区显示。</p></div>
      <div className="maintenance-intro-actions">
        <Badge variant={healthSummary.variant}>{healthSummary.label}</Badge>
        <Button variant="outline" size="icon" type="button" title="刷新维护状态" aria-label="刷新维护状态" onClick={() => { void refresh(); setHealthRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></Button>
      </div>
    </section>
    <div className="maintenance-section-nav" aria-label="维护分区" role="tablist">
      {MAINTENANCE_SECTIONS.map((item) => {
        const Icon = item.icon;
        return <button key={item.key} type="button" role="tab" aria-selected={activeSection === item.key} aria-controls={`maintenance-${item.key}`} className={activeSection === item.key ? "is-active" : ""} onClick={() => selectSection(item.key)}><Icon size={17} aria-hidden="true" />{item.label}</button>;
      })}
    </div>
    {operation && <section className="operation-band" aria-live="polite">
      <div><span>当前维护操作</span><strong>{operation.kind} · {operation.stage}</strong><small>{operation.errorCode ? `${operation.errorCode}: ${operation.detail || ""}` : operation.state}</small></div>
      {operation.stage === "countdown" && <button className="quiet-button" type="button" onClick={() => void cancel()}>取消</button>}
      {operation.state === "awaiting_force_confirmation" && <button className="danger-button" type="button" onClick={() => void forceStop()}><CircleStop size={18} />确认强制停止</button>}
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    <div className="maintenance-tab-panel" role="tabpanel" id={`maintenance-${activeSection}`}>
      {activeSection === "health" && <OperationalHealthPanel auth={auth} refreshToken={healthRefreshToken} onHealthChange={setHealth} />}
      {activeSection === "update" && <MaintenancePanel auth={auth} status={status} onOperation={setOperation} />}
      {activeSection === "backups" && <BackupsPage auth={auth} />}
      {activeSection === "audit" && <AuditPage auth={auth} />}
      {activeSection === "notifications" && <MaintenanceNotificationsPanel auth={auth} />}
    </div>
  </div>;
}

function initialMaintenanceSection(): MaintenanceSection {
  if (typeof window === "undefined") return "health";
  const section = window.location.hash.replace("#maintenance-", "") as MaintenanceSection;
  return MAINTENANCE_SECTIONS.some((item) => item.key === section) ? section : "health";
}

function maintenanceHealthSummary(health: OperationalHealth | null): { label: string; variant: "success" | "warning" | "destructive" } {
  if (!health) return { label: "正在巡检", variant: "warning" };
  if (health.alerts.some((item) => item.severity === "critical") || health.capacity.state === "blocked") return { label: "需要处理", variant: "destructive" };
  if (health.alerts.length || health.capacity.state === "warning" || health.world.state !== "healthy" || health.backups.state !== "healthy") return { label: "需要关注", variant: "warning" };
  return { label: "运行正常", variant: "success" };
}
