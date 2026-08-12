import { AlertTriangle, CheckCircle2, CircleStop, LoaderCircle, Play, RefreshCw, RotateCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, Operation, ServerSettings, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";

const ACTIVE_OPERATION_STATES = new Set(["queued", "running", "awaiting_force_confirmation"]);
const TERMINAL_OPERATION_STATES = new Set(["succeeded", "failed", "cancelled"]);

export function ServerControlPanel({ auth, initialStatus, onStatusChange }: { auth: AuthStatus; initialStatus: ShellStatus | null; onStatusChange?: (status: ShellStatus) => void }) {
  const [status, setStatus] = useState(initialStatus);
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
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

  async function begin(kind: "start" | "save" | "stop" | "restart") {
    const labels = { start: "启动", save: "保存", stop: "关闭", restart: "重启" };
    if (!window.confirm(`确认对 ${settings.executablePath || "当前 PalServer"} 执行“${labels[kind]}”？`)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await requestJson<Operation>(`/api/server/operations/${kind}`, {
        method: "POST",
        headers: {
          "X-CSRF-Token": auth.csrfToken || "",
          "Idempotency-Key": crypto.randomUUID(),
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
    if (!operation || !window.confirm(`PalServer 未能优雅退出。确认强制结束 PID ${status?.pids.join(", ") || "未知"}？`)) return;
    try {
      const next = await requestJson<Operation>(`/api/server/operations/${operation.operationId}/force-stop`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      });
      setOperation(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "强制停止失败");
    }
  }

  const operating = !!operation && ACTIVE_OPERATION_STATES.has(operation.state);
  return <>
    <section className="action-toolbar" aria-label="服务器操作">
      <button disabled={busy || operating || status?.serverState === "running"} onClick={() => void begin("start")}><Play size={18} />启动</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("save")}><Save size={18} />保存</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("stop")}><CircleStop size={18} />关闭</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("restart")}><RotateCw size={18} />重启</button>
      <button className="icon-button bordered control-refresh" type="button" title="刷新服务器状态" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    {operation && createPortal(<OperationIsland operation={operation} onCancel={cancel} onForceStop={forceStop} />, document.body)}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </>;
}

function OperationIsland({ operation, onCancel, onForceStop }: { operation: Operation; onCancel: () => void; onForceStop: () => void }) {
  const canCancel = operation.stage === "countdown" && ["queued", "running"].includes(operation.state);
  const needsForceConfirmation = operation.state === "awaiting_force_confirmation";
  const completed = TERMINAL_OPERATION_STATES.has(operation.state);
  const islandClass = `operation-island${needsForceConfirmation || operation.state === "failed" ? " warning" : ""}${completed ? " completed" : ""}`;

  return <section className={islandClass} aria-label="当前操作状态" aria-live="polite">
    <span className="operation-island-icon" aria-hidden="true">{operationIcon(operation)}</span>
    <div className="operation-island-copy"><span>当前操作</span><strong>{operationKindLabel(operation.kind)}</strong><small>{operationDescription(operation)}</small></div>
    {canCancel && <button className="quiet-button operation-island-action" type="button" onClick={onCancel}>取消</button>}
    {needsForceConfirmation && <button className="danger-button operation-island-action" type="button" onClick={onForceStop}><CircleStop size={16} />确认强制停止</button>}
  </section>;
}

function operationIcon(operation: Operation) {
  if (operation.state === "succeeded") return <CheckCircle2 size={21} />;
  if (operation.state === "failed" || operation.state === "awaiting_force_confirmation") return <AlertTriangle size={21} />;
  if (operation.state === "cancelled") return <CircleStop size={21} />;
  return <LoaderCircle className="spin" size={21} />;
}

function operationKindLabel(kind: string) {
  return ({ start: "启动服务器", save: "保存世界", stop: "关闭服务器", restart: "重启服务器", force_stop: "强制停止服务器" } as Record<string, string>)[kind] || "服务器操作";
}

function operationDescription(operation: Operation) {
  if (operation.state === "succeeded") return ({ start: "服务器已启动。", save: "世界数据已保存。", stop: "服务器已完全关闭。", restart: "服务器已重启。", force_stop: "服务器已强制停止。" } as Record<string, string>)[operation.kind] || "操作已完成。";
  if (operation.state === "cancelled") return "操作已取消，服务器保持当前状态。";
  if (operation.state === "failed") return "操作未完成，请检查服务器状态或日志。";
  if (operation.state === "awaiting_force_confirmation") return "服务器尚未退出，确认后才会强制停止。";
  return ({ queued: "正在等待服务器执行。", countdown: "维护倒计时中，仍可取消。", saving: "正在保存世界数据。", stopping: "正在请求服务器关闭。", restarting: "正在重新启动服务器。", health_check: "正在检查服务器启动状态。", force_stopping: "正在强制停止服务器。" } as Record<string, string>)[operation.stage] || "正在执行，请稍候。";
}

function operationFailureText(operation: Operation) {
  return `操作失败（${operation.errorCode || "UNKNOWN_ERROR"}），请检查服务器状态或日志。`;
}
