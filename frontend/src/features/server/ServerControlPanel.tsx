import { AlertTriangle, CheckCircle2, CircleStop, Play, RefreshCw, RotateCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, Operation, ServerSettings, ShellStatus } from "../../api/contracts";
import { createIdempotencyKey, isAbortError, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { OperationStatusIsland } from "../../components/OperationStatusIsland";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";

const ACTIVE_OPERATION_STATES = new Set(["queued", "running", "awaiting_force_confirmation"]);
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled"]);
type ControlAction = "start" | "save" | "stop" | "restart";

export function ServerControlPanel({ auth, initialStatus, onStatusChange }: { auth: AuthStatus; initialStatus: ShellStatus | null; onStatusChange?: (status: ShellStatus) => void }) {
  const [status, setStatus] = useState(initialStatus);
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<ControlAction | "force" | null>(null);
  const nextRequestSignal = useAbortableRequest();

  const publishStatus = useCallback((nextStatus: ShellStatus) => {
    setStatus(nextStatus);
    onStatusChange?.(nextStatus);
  }, [onStatusChange]);

  useEffect(() => setStatus(initialStatus), [initialStatus]);

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        requestJson<ShellStatus>("/api/shell/status", { signal }),
        requestJson<ServerSettings>("/api/server/settings", { signal }),
      ]);
      publishStatus(nextStatus);
      setSettings(nextSettings);
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "状态刷新失败");
    }
  }, [nextRequestSignal, publishStatus]);

  const refreshStatus = useCallback(async () => {
    try {
      publishStatus(await requestJson<ShellStatus>("/api/shell/status"));
    } catch {
      return;
    }
  }, [publishStatus]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshStatus(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);
  useEffect(() => {
    if (!operation || !["queued", "running"].includes(operation.state)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await requestJson<Operation>(`/api/server/operations/${operation.operationId}`);
        setOperation(next);
        if (next.state === "failed") setError(operationFailureText(next));
        if (!ACTIVE_OPERATION_STATES.has(next.state)) void refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "操作状态查询失败");
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);
  useEffect(() => {
    if (!operation || !TERMINAL_OPERATION_STATES.has(operation.state)) return;
    const timer = window.setTimeout(() => setOperation(null), 3_200);
    return () => window.clearTimeout(timer);
  }, [operation]);

  async function begin(kind: ControlAction) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await requestJson<Operation>(`/api/server/operations/${kind}`, {
        method: "POST",
        headers: {
          "X-CSRF-Token": auth.csrfToken || "",
          "Idempotency-Key": createIdempotencyKey(),
        },
        body: JSON.stringify({
          countdownSeconds: 30,
          message: "服务器将在 30 秒后维护，请及时返回安全地点。",
        }),
      });
      setOperation(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作提交失败");
    } finally {
      setBusy(false);
    }
  }

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
      const next = await requestJson<Operation>(`/api/server/operations/${operation.operationId}/force-stop`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": createIdempotencyKey() },
        body: "{}",
      });
      setOperation(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "强制停止失败");
    }
  }

  const operating = !!operation && ACTIVE_OPERATION_STATES.has(operation.state);
  const confirmation = controlConfirmation(pendingAction, settings.executablePath, status?.pids || []);
  return <>
    <section className="psc-control-actions" aria-label="服务器操作">
      <Button disabled={busy || operating || status?.serverState === "running"} onClick={() => setPendingAction("start")}><Play data-icon="inline-start" aria-hidden="true" />启动</Button>
      <Button variant={status?.serverState === "running" ? "default" : "secondary"} disabled={busy || operating || status?.serverState !== "running"} onClick={() => setPendingAction("save")}><Save data-icon="inline-start" aria-hidden="true" />保存</Button>
      <Button variant="outline" disabled={busy || operating || status?.serverState !== "running"} onClick={() => setPendingAction("stop")}><CircleStop data-icon="inline-start" aria-hidden="true" />关闭</Button>
      <Button variant="outline" disabled={busy || operating || status?.serverState !== "running"} onClick={() => setPendingAction("restart")}><RotateCw data-icon="inline-start" aria-hidden="true" />重启</Button>
      <Button variant="ghost" size="icon" type="button" title="刷新服务器状态" aria-label="刷新服务器状态" onClick={() => void refresh()}>{busy ? <Spinner /> : <RefreshCw aria-hidden="true" />}</Button>
    </section>
    {operation && createPortal(<OperationStatusIsland operation={operation} onCancel={cancel} onForceStop={() => setPendingAction("force")} />, document.body)}
    {error && <Alert className="psc-control-feedback" variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>服务器操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
    {message && <Alert className="psc-control-feedback" variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertTitle>请求已提交</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
    <ConfirmActionDialog
      open={pendingAction !== null}
      title={confirmation.title}
      description={confirmation.description}
      confirmLabel={confirmation.confirmLabel}
      destructive={pendingAction === "stop" || pendingAction === "restart" || pendingAction === "force"}
      disabled={busy}
      onOpenChange={(open) => { if (!open) setPendingAction(null); }}
      onConfirm={() => {
        if (pendingAction === "force") void forceStop();
        else if (pendingAction) void begin(pendingAction);
      }}
    />
  </>;
}

function controlConfirmation(action: ControlAction | "force" | null, executablePath: string | null, pids: number[]) {
  const target = executablePath || "当前 PalServer";
  if (action === "start") return { title: "启动 PalServer？", description: `将启动 ${target}。启动完成前请保留当前页面。`, confirmLabel: "确认启动" };
  if (action === "save") return { title: "保存当前世界？", description: `将请求 ${target} 保存世界数据，不会停止服务器。`, confirmLabel: "确认保存" };
  if (action === "stop") return { title: "关闭 PalServer？", description: `将先通知并保存世界，然后进入 30 秒可取消倒计时，再关闭 ${target}。`, confirmLabel: "确认关闭" };
  if (action === "restart") return { title: "重启 PalServer？", description: `将先保存并关闭 ${target}，完成后重新启动；不会隐式应用配置草稿。`, confirmLabel: "确认重启" };
  if (action === "force") return { title: "强制结束 PalServer？", description: `PalServer 未能优雅退出。确认后将强制结束 PID ${pids.join(", ") || "未知"}。`, confirmLabel: "确认强制停止" };
  return { title: "确认服务器操作", description: "请确认目标和影响后再继续。", confirmLabel: "确认" };
}

function operationFailureText(operation: Operation) {
  return `操作失败（${operation.errorCode || "UNKNOWN_ERROR"}），请检查服务器状态或日志。`;
}
