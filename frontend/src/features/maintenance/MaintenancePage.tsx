import { Activity, ArchiveRestore, BellRing, Download, FileClock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, Operation, OperationalHealth, ShellStatus } from "../../api/contracts";
import { createIdempotencyKey, isAbortError, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { OperationStatusIsland } from "../../components/OperationStatusIsland";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { AuditPage } from "../audit/AuditPage";
import { BackupsPage } from "../backups/BackupsPage";
import { OperationalHealthPanel } from "../overview/OperationalHealthPanel";
import { MaintenanceNotificationsPanel, MaintenancePanel } from "./MaintenancePanel";
import { ApplicationUpdatePanel } from "./ApplicationUpdatePanel";

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
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [healthRefreshToken, setHealthRefreshToken] = useState(0);
  const [confirmForceStop, setConfirmForceStop] = useState(false);
  const tabPanelRef = useRef<HTMLDivElement | null>(null);
  const nextRequestSignal = useAbortableRequest();
  const nextHealthRequestSignal = useAbortableRequest();

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      setStatus(await requestJson<ShellStatus>("/api/shell/status", { signal }));
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "维护状态刷新失败");
    }
  }, [nextRequestSignal]);

  const refreshHealth = useCallback(async () => {
    const signal = nextHealthRequestSignal();
    try {
      const next = await requestJson<OperationalHealth>("/api/operations/health", { signal });
      setHealth(next);
      setHealthUnavailable(false);
    } catch (caught) {
      if (!isAbortError(caught)) setHealthUnavailable(true);
    }
  }, [nextHealthRequestSignal]);

  const handleHealthChange = useCallback((next: OperationalHealth) => {
    setHealth(next);
    setHealthUnavailable(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshHealth(); }, [refreshHealth]);
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
    if (!operation) return;
    try {
      setOperation(await requestJson<Operation>(`/api/server/operations/${operation.operationId}/force-stop`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": createIdempotencyKey() },
        body: "{}",
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "强制停止失败");
    }
  }

  function selectSection(section: MaintenanceSection) {
    setActiveSection(section);
    window.history.replaceState(null, "", `#maintenance-${section}`);
    window.requestAnimationFrame(() => tabPanelRef.current?.scrollIntoView({ block: "start" }));
  }

  const healthSummary = maintenanceHealthSummary(health, healthUnavailable);

  return <div className="page-stack maintenance-page">
    <section className="maintenance-intro">
      <div><p className="maintenance-kicker">低频运维工作区</p><h2>维护中心</h2><p>按任务进入健康、更新、备份、审计和通知；危险操作只在对应模块内确认。</p></div>
      <div className="maintenance-intro-actions">
        <Badge variant={healthSummary.variant}>{healthSummary.label}</Badge>
        <Button variant="outline" size="icon" type="button" title="刷新维护状态" aria-label="刷新维护状态" onClick={() => { void refresh(); void refreshHealth(); setHealthRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></Button>
      </div>
    </section>
    <div className="maintenance-section-nav" aria-label="维护分区" role="tablist">
      {MAINTENANCE_SECTIONS.map((item) => {
        const Icon = item.icon;
        return <button key={item.key} type="button" role="tab" aria-selected={activeSection === item.key} aria-controls={`maintenance-${item.key}`} className={activeSection === item.key ? "is-active" : ""} onClick={() => selectSection(item.key)}><Icon size={17} aria-hidden="true" />{item.label}</button>;
      })}
    </div>
    {operation && createPortal(<OperationStatusIsland operation={operation} onCancel={() => void cancel()} onForceStop={() => setConfirmForceStop(true)} />, document.body)}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    <div ref={tabPanelRef} className="maintenance-tab-panel" role="tabpanel" id={`maintenance-${activeSection}`}>
      {activeSection === "health" && <OperationalHealthPanel auth={auth} refreshToken={healthRefreshToken} onHealthChange={handleHealthChange} />}
      {activeSection === "update" && <div className="maintenance-update-stack">
        <ApplicationUpdatePanel auth={auth} />
        <MaintenancePanel auth={auth} status={status} onOperation={setOperation} />
      </div>}
      {activeSection === "backups" && <BackupsPage auth={auth} />}
      {activeSection === "audit" && <AuditPage auth={auth} />}
      {activeSection === "notifications" && <MaintenanceNotificationsPanel auth={auth} />}
    </div>
    <ConfirmActionDialog open={confirmForceStop} title="强制结束 PalServer？" description={`PalServer 未能优雅退出。确认后将强制结束 PID ${status?.pids.join(", ") || "未知"}。`} confirmLabel="确认强制停止" destructive onOpenChange={setConfirmForceStop} onConfirm={() => void forceStop()} />
  </div>;
}

function initialMaintenanceSection(): MaintenanceSection {
  if (typeof window === "undefined") return "health";
  const section = window.location.hash.replace("#maintenance-", "") as MaintenanceSection;
  return MAINTENANCE_SECTIONS.some((item) => item.key === section) ? section : "health";
}

function maintenanceHealthSummary(health: OperationalHealth | null, healthUnavailable: boolean): { label: string; variant: "success" | "warning" | "destructive" } {
  if (healthUnavailable) return { label: "需要关注", variant: "warning" };
  if (!health) return { label: "正在巡检", variant: "warning" };
  if (health.alerts.some((item) => item.severity === "critical") || health.capacity.state === "blocked") return { label: "需要处理", variant: "destructive" };
  if (health.alerts.length || health.capacity.state === "warning" || health.world.state !== "healthy" || health.backups.state !== "healthy") return { label: "需要关注", variant: "warning" };
  return { label: "运行正常", variant: "success" };
}
