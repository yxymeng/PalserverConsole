import { AlertTriangle, ArrowRight, HardDrive, Network, ServerCog } from "lucide-react";
import { useEffect, useState } from "react";

import type { AuthStatus, ServerSettings, ShellStatus } from "../api/contracts";
import { requestJson } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { Spinner } from "../components/ui/spinner";

export function InstanceQuickPanel({
  auth,
  shell,
  onOpenSettings,
}: {
  auth: AuthStatus;
  shell: ShellStatus | null;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    requestJson<ServerSettings>("/api/server/settings")
      .then((result) => { if (active) setSettings(result); })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "实例设置读取失败");
      });
    return () => { active = false; };
  }, [open]);

  return (
    <>
      <Button
        className="psc-instance-trigger"
        variant="outline"
        type="button"
        aria-label="查看实例与控制台"
        title="查看实例与控制台"
        onClick={() => setOpen(true)}
      >
        <ServerCog aria-hidden="true" />
        <span>实例</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="psc-instance-sheet" side="right">
          <SheetHeader>
            <div className="psc-instance-title-row">
              <SheetTitle>实例与控制台</SheetTitle>
              <Badge variant={shell?.configured ? "success" : "warning"}>
                {shell?.configured ? "已绑定" : "待配置"}
              </Badge>
            </div>
            <SheetDescription>快速核对当前目标；编辑操作仍在配置页面完成。</SheetDescription>
          </SheetHeader>
          <div className="psc-instance-summary" aria-live="polite">
            {!settings && !error ? <div className="psc-instance-loading"><Spinner />正在读取实例设置</div> : null}
            {error ? <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实例信息不可用</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
            {settings ? (
              <dl>
                <div><dt><ServerCog aria-hidden="true" />当前实例</dt><dd>{shell?.instanceId || "default"}</dd></div>
                <div><dt><HardDrive aria-hidden="true" />World ID</dt><dd>{settings.worldId || "尚未绑定"}</dd></div>
                <div><dt>PalServer 路径</dt><dd>{settings.executablePath || "尚未选择 PalServer.exe"}</dd></div>
                <div><dt>启动参数</dt><dd>{settings.launchArguments || "未设置"}</dd></div>
                <div><dt><Network aria-hidden="true" />控制台端口</dt><dd>{auth.port}</dd></div>
              </dl>
            ) : null}
            {settings?.bindingErrorCode ? <Alert variant="warning"><AlertTriangle aria-hidden="true" /><AlertTitle>世界绑定需要处理</AlertTitle><AlertDescription>{settings.bindingErrorCode}</AlertDescription></Alert> : null}
          </div>
          <SheetFooter>
            <Button type="button" onClick={() => { setOpen(false); onOpenSettings(); }}>
              进入实例设置<ArrowRight data-icon="inline-end" aria-hidden="true" />
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}
