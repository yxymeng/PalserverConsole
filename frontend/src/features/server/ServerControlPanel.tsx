import { CircleStop, Play, RefreshCw, RotateCw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AuthStatus, LiveSnapshot, Operation, ServerSettings, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { LiveMonitoring } from "../monitoring/LiveMonitoring";
import { serverStateLabel } from "./labels";

export function ServerControlPanel({ auth, initialStatus, onSnapshot }: { auth: AuthStatus; initialStatus: ShellStatus | null; onSnapshot?: (snapshot: LiveSnapshot) => void }) {
  const [status, setStatus] = useState(initialStatus);
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nextRequestSignal = useAbortableRequest();

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        requestJson<ShellStatus>("/api/shell/status", { signal }),
        requestJson<ServerSettings>("/api/server/settings", { signal }),
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "状态刷新失败");
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
        setError(caught instanceof Error ? caught.message : "操作状态查询失败");
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);

  async function begin(kind: "start" | "save" | "stop" | "restart") {
    const labels = { start: "启动", save: "保存世界", stop: "关闭", restart: "重启" };
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

  const operating = !!operation && ["queued", "running"].includes(operation.state);
  return <>
    <section className="section-heading server-control-heading">
      <div><h2>服务器控制</h2><p>日常启停、保存与实时状态都在首页完成。</p></div>
      <button className="icon-button bordered" type="button" title="刷新状态" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    <section className="server-status-row">
      <div><span>PalServer</span><strong>{serverStateLabel(status?.serverState)}</strong></div>
      <div><span>目标进程</span><strong>{status?.pids.length ? status.pids.join(", ") : "无"}</strong></div>
      <div><span>控制台实例</span><strong>{status?.instanceId || "default"}</strong></div>
    </section>
    <section className="action-toolbar" aria-label="服务器操作">
      <button disabled={busy || operating || status?.serverState === "running"} onClick={() => void begin("start")}><Play size={18} />启动</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("save")}><Save size={18} />保存世界</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("stop")}><CircleStop size={18} />关闭</button>
      <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("restart")}><RotateCw size={18} />重启</button>
    </section>
    {operation && <section className="operation-band" aria-live="polite">
      <div><span>当前操作</span><strong>{operation.kind} · {operation.stage}</strong><small>{operation.errorCode ? `${operation.errorCode}: ${operation.detail || ""}` : operation.state}</small></div>
      {operation.stage === "countdown" && <button className="quiet-button" type="button" onClick={() => void cancel()}>取消</button>}
      {operation.state === "awaiting_force_confirmation" && <button className="danger-button" type="button" onClick={() => void forceStop()}><CircleStop size={18} />确认强制停止</button>}
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    <LiveMonitoring auth={auth} embedded onSnapshot={onSnapshot} />
  </>;
}
