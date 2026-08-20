import { AlertTriangle, ArrowRight, Database, HardDrive, Network, ServerCog, Terminal } from "lucide-react";
import { motion } from "motion/react";
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
              <motion.div className="psc-instance-content" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}>
                <section className="psc-instance-overview">
                  <div className="psc-instance-orb" data-state={shell?.serverState || "not_configured"}><span aria-hidden="true" /></div>
                  <div><small>运行目标</small><strong>{shell?.instanceId || "default"}</strong><p>{shell?.serverState === "running" ? "PalServer 正在运行，控制台正在监测此实例。" : shell?.serverState === "stopped" ? "实例已绑定，PalServer 当前处于停止状态。" : "尚未完成实例与世界绑定。"}</p></div>
                  <Badge variant={shell?.serverState === "running" ? "success" : shell?.configured ? "secondary" : "warning"}>{shell?.serverState === "running" ? "运行中" : shell?.configured ? "已停止" : "待配置"}</Badge>
                </section>
                <section className="psc-instance-endpoints" aria-label="实例端点">
                  <article><Database aria-hidden="true" /><span>World ID</span><strong>{settings.worldId || "尚未绑定"}</strong></article>
                  <article><Network aria-hidden="true" /><span>控制台端口</span><strong>{auth.port}</strong></article>
                </section>
                <section className="psc-instance-runtime" aria-label="启动目标">
                  <header><HardDrive aria-hidden="true" /><div><span>PalServer 可执行文件</span><small>启动、关闭和健康检查均以此路径为目标</small></div></header>
                  <code>{settings.executablePath || "尚未选择 PalServer.exe"}</code>
                  <div className="psc-instance-arguments"><Terminal aria-hidden="true" /><div><span>启动参数</span><code>{settings.launchArguments || "未设置额外参数"}</code></div></div>
                </section>
              </motion.div>
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
