import { AlertTriangle, Wrench } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthStatus, ConfigDocument, LiveSnapshot, OperationalHealth, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { displayValue } from "../../utils/format";
import { LiveMonitoring } from "../monitoring/LiveMonitoring";
import { serverStateLabel } from "../server/labels";
import { ServerControlPanel } from "../server/ServerControlPanel";

export function Overview({ shell, auth, onOpenMaintenance, onShellStatusChange }: { shell: ShellStatus | null; auth: AuthStatus; onOpenMaintenance: () => void; onShellStatusChange: (status: ShellStatus) => void }) {
  const [config, setConfig] = useState<ConfigDocument | null>(null);
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null);
  const nextConfigSignal = useAbortableRequest();

  useEffect(() => {
    requestJson<ConfigDocument>("/api/config/current", { signal: nextConfigSignal() })
      .then(setConfig)
      .catch((caught) => { if (!isAbortError(caught)) setConfig(null); });
  }, [nextConfigSignal]);

  return (
    <div className="page-stack">
      {!auth.local && (
        <Alert variant="warning">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>当前为局域网会话</AlertTitle>
          <AlertDescription>仅在可信内网使用，禁止将 PalServerConsole 暴露到公网。</AlertDescription>
        </Alert>
      )}
      <HomeHero status={shell} config={config} snapshot={liveSnapshot}>
        <ServerControlPanel auth={auth} initialStatus={shell} onStatusChange={onShellStatusChange} />
      </HomeHero>
      <LiveMonitoring auth={auth} embedded shell={shell} onSnapshot={setLiveSnapshot} />
      <OperationalHealthNotice onOpenMaintenance={onOpenMaintenance} />
    </div>
  );
}

function OperationalHealthNotice({ onOpenMaintenance }: { onOpenMaintenance: () => void }) {
  const [health, setHealth] = useState<OperationalHealth | null>(null);
  const nextRequestSignal = useAbortableRequest();
  const load = useCallback(async () => {
    try {
      setHealth(await requestJson<OperationalHealth>("/api/operations/health", { signal: nextRequestSignal() }));
    } catch (caught) {
      if (!isAbortError(caught)) return;
    }
  }, [nextRequestSignal]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (!health?.alerts.length) return null;
  const critical = health.alerts.some((item) => item.severity === "critical");
  return (
    <Alert className="psc-maintenance-notice" variant={critical ? "destructive" : "warning"}>
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>维护中心有 {health.alerts.length} 项需要处理</AlertTitle>
      <AlertDescription>{health.alerts[0].message}</AlertDescription>
      <Button variant="outline" type="button" onClick={onOpenMaintenance}>
        <Wrench data-icon="inline-start" aria-hidden="true" />查看维护
      </Button>
    </Alert>
  );
}

function HomeHero({ children, status, config, snapshot }: { children: ReactNode; status: ShellStatus | null; config: ConfigDocument | null; snapshot: LiveSnapshot | null }) {
  const serverName = configText(config?.fields.ServerName)
    || displayValue(snapshot?.info.data, ["servername", "serverName", "ServerName"], "未命名的帕鲁世界");
  const description = configText(config?.fields.ServerDescription) || "这个世界还没有介绍，可在“世界法则配置”中填写。";
  const version = displayValue(snapshot?.info.data, ["version", "Version"], "");
  return (
    <Card className="psc-home-command" role="region" aria-label="首页服务器控制">
      <div className="psc-home-command-grid">
        <div className="psc-home-command-copy">
          <CardHeader>
            <div className="psc-home-command-meta">
              <span className="psc-home-state" data-state={status?.serverState || "loading"}>
                <span aria-hidden="true" />
                {status ? serverStateLabel(status.serverState) : "读取中"}
              </span>
              {version && <span className="psc-home-version">v{version.replace(/^v/i, "")}</span>}
            </div>
            <CardTitle role="heading" aria-level={2}>{serverName}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </div>
        <div className="hero-character-stage" aria-hidden="true">
          <img className="hero-character" src="/zoe-character.png" alt="" />
        </div>
      </div>
    </Card>
  );
}

function configText(value: string | undefined): string {
  const text = value?.trim() || "";
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) as string; } catch { return text.slice(1, -1); }
  }
  return text;
}
