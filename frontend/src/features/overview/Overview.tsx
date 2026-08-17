import { AlertTriangle, Wrench } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthStatus, OperationalHealth, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { LiveMonitoring } from "../monitoring/LiveMonitoring";
import { ServerControlPanel } from "../server/ServerControlPanel";

export function Overview({ shell, auth, onOpenMaintenance }: { shell: ShellStatus | null; auth: AuthStatus; onOpenMaintenance: () => void }) {
  const [shellStatus, setShellStatus] = useState(shell);

  useEffect(() => setShellStatus(shell), [shell]);

  return (
    <div className="page-stack">
      {!auth.local && (
        <Alert variant="warning">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>当前为局域网会话</AlertTitle>
          <AlertDescription>仅在可信内网使用，禁止将 PalServerConsole 暴露到公网。</AlertDescription>
        </Alert>
      )}
      <HomeHero>
        <ServerControlPanel auth={auth} initialStatus={shellStatus} onStatusChange={setShellStatus} />
      </HomeHero>
      <LiveMonitoring auth={auth} embedded shell={shellStatus} />
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

function HomeHero({ children }: { children: ReactNode }) {
  return (
    <Card className="psc-home-command" aria-label="首页服务器控制">
      <div className="psc-home-command-grid">
        <div className="psc-home-command-copy">
          <CardHeader>
            <CardTitle role="heading" aria-level={2}>服务器控制</CardTitle>
            <CardDescription>操作会先确认目标与影响；关闭和重启会进入可取消的维护倒计时。</CardDescription>
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
