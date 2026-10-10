import { Activity, ArchiveRestore, FileClock, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { ApplicationUpdateStatus, AuthStatus, OperationalHealth } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { AuditPage } from "../audit/AuditPage";
import { BackupsPage } from "../backups/BackupsPage";
import { OperationalHealthPanel } from "../overview/OperationalHealthPanel";
import { MaintenancePanel } from "./MaintenancePanel";

type MaintenanceSection = "health" | "update" | "backups" | "audit";

const MAINTENANCE_SECTIONS = [
  { key: "health", label: "健康与容量", icon: Activity },
  { key: "update", label: "服务运维与告警", icon: Wrench },
  { key: "backups", label: "官方备份", icon: ArchiveRestore },
  { key: "audit", label: "运营审计", icon: FileClock },
] as const;

export function MaintenancePage({ auth, applicationUpdateStatus, onCheckApplicationUpdate }: { auth: AuthStatus; applicationUpdateStatus: ApplicationUpdateStatus | null; onCheckApplicationUpdate: () => Promise<ApplicationUpdateStatus> }) {
  const [activeSection, setActiveSection] = useState<MaintenanceSection>(initialMaintenanceSection);
  const [health, setHealth] = useState<OperationalHealth | null>(null);
  const [healthUnavailable, setHealthUnavailable] = useState(false);
  const [healthRefreshToken, setHealthRefreshToken] = useState(0);
  const nextHealthRequestSignal = useAbortableRequest();

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

  useEffect(() => { void refreshHealth(); }, [refreshHealth]);
  function selectSection(section: MaintenanceSection) {
    setActiveSection(section);
    window.history.replaceState(null, "", `#maintenance-${section}`);
  }

  const healthSummary = maintenanceHealthSummary(health, healthUnavailable);

  return <div className="page-stack maintenance-page maintenance-reference">
    <div className="maintenance-reference-card maintenance-system-navigation">
      <div className="maintenance-section-nav" aria-label="维护分区" role="tablist">
        {MAINTENANCE_SECTIONS.map((item) => {
          const Icon = item.icon;
          return <button key={item.key} type="button" role="tab" aria-selected={activeSection === item.key} aria-controls={`maintenance-${item.key}`} className={activeSection === item.key ? "is-active" : ""} onClick={() => selectSection(item.key)}><Icon aria-hidden="true" />{item.label}</button>;
        })}
      </div>
      <div className="maintenance-system-summary"><span className="maintenance-system-dot" aria-hidden="true" />系统运维中心 · 守护海岛稳定运行</div>
      {activeSection === "health" && <div className="maintenance-health-actions"><Badge variant={healthSummary.variant}>{healthSummary.label}</Badge><Button variant="outline" size="icon" type="button" title="刷新维护状态" aria-label="刷新维护状态" onClick={() => { void refreshHealth(); setHealthRefreshToken((value) => value + 1); }}><RefreshCw aria-hidden="true" /></Button></div>}
    </div>
    <div className="maintenance-tab-panel" role="tabpanel" id={`maintenance-${activeSection}`}>
      {activeSection === "health" && <OperationalHealthPanel auth={auth} refreshToken={healthRefreshToken} onHealthChange={handleHealthChange} />}
      {activeSection === "update" && <MaintenancePanel auth={auth} applicationUpdateStatus={applicationUpdateStatus} onCheckApplicationUpdate={onCheckApplicationUpdate} />}
      {activeSection === "backups" && <BackupsPage auth={auth} />}
      {activeSection === "audit" && <AuditPage auth={auth} />}
    </div>
  </div>;
}

function initialMaintenanceSection(): MaintenanceSection {
  if (typeof window === "undefined") return "health";
  if (window.location.hash === "#maintenance-notifications") return "update";
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
