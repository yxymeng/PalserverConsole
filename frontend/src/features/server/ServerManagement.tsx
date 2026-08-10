import { CircleStop, FolderSearch, RefreshCw, RotateCw, Save, Server, ShieldCheck, Play } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, ShellStatus, ServerSettings, DiscoveryCandidate, Operation } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { LiveMonitoring } from "../monitoring/LiveMonitoring";
import { MaintenancePanel } from "../maintenance/MaintenancePanel";
import { serverStateLabel } from "./labels";

export function ServerManagement({ auth, initialStatus }: { auth: AuthStatus; initialStatus: ShellStatus | null }) {
  const [status, setStatus] = useState(initialStatus);
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
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

  async function discover() {
    setBusy(true); setError("");
    try { setCandidates(await requestJson<DiscoveryCandidate[]>("/api/server/discovery")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Steam 发现失败"); }
    finally { setBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>("/api/server/settings", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(settings),
      });
      setMessage(result.message); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function begin(kind: "start" | "save" | "stop" | "restart") {
    const labels = { start: "启动", save: "保存世界", stop: "关闭", restart: "重启" };
    if (!window.confirm(`确认对 ${settings.executablePath || "当前 PalServer"} 执行“${labels[kind]}”？`)) return;
    setBusy(true); setError(""); setMessage("");
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作提交失败"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!operation) return;
    try {
      await requestJson(`/api/server/operations/${operation.operationId}/cancel`, {
        method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}",
      });
      setMessage("取消请求已提交。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "取消失败"); }
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : "强制停止失败"); }
  }

  const operating = !!operation && ["queued", "running"].includes(operation.state);
  return (
    <div className="page-stack server-page">
      <section className="server-status-row">
        <div><span>PalServer</span><strong>{serverStateLabel(status?.serverState)}</strong></div>
        <div><span>目标进程</span><strong>{status?.pids.length ? status.pids.join(", ") : "无"}</strong></div>
        <div><span>控制台实例</span><strong>{status?.instanceId || "default"}</strong></div>
        <button className="icon-button bordered" title="刷新状态" onClick={() => void refresh()}><RefreshCw size={19} /></button>
      </section>
      <section className="action-toolbar" aria-label="服务器操作">
        <button disabled={busy || operating || status?.serverState === "running"} onClick={() => void begin("start")}><Play size={18} />启动</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("save")}><Save size={18} />保存世界</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("stop")}><CircleStop size={18} />关闭</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("restart")}><RotateCw size={18} />重启</button>
      </section>
      {operation && <section className="operation-band" aria-live="polite">
        <div><span>当前操作</span><strong>{operation.kind} · {operation.stage}</strong><small>{operation.errorCode ? `${operation.errorCode}: ${operation.detail || ""}` : operation.state}</small></div>
        {operation.stage === "countdown" && <button className="quiet-button" onClick={() => void cancel()}>取消</button>}
        {operation.state === "awaiting_force_confirmation" && <button className="danger-button" onClick={() => void forceStop()}><CircleStop size={18} />确认强制停止</button>}
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      <MaintenancePanel auth={auth} status={status} onOperation={setOperation} />
      <section className="settings-section embedded-settings">
        <div className="section-heading"><div><h2>PalServer 安装</h2><p>{settings.executablePath || "尚未选择 PalServer.exe"}</p></div>{auth.local && <button className="quiet-button" disabled={busy} onClick={() => void discover()}><FolderSearch size={18} />扫描 Steam</button>}</div>
        {candidates.length > 0 && <div className="candidate-list">{candidates.map((candidate) => <button key={candidate.executablePath} onClick={() => setSettings({ ...settings, executablePath: candidate.executablePath, worldId: null, worldCandidates: candidate.worldCandidates })}><Server size={18} /><span><strong>{candidate.installPath}</strong><small>{candidate.manifestValid ? "manifest 已验证" : "manifest 未验证"}</small></span></button>)}</div>}
        {auth.local ? <form className="settings-form server-form" onSubmit={saveSettings}>
          <label htmlFor="server-executable">PalServer.exe 路径</label>
          <input id="server-executable" value={settings.executablePath || ""} onChange={(event) => setSettings({ ...settings, executablePath: event.target.value })} required />
          {(settings.worldCandidates?.length || 0) > 0 && <>
            <label htmlFor="server-world">World ID（必须明确选择）</label>
            <select id="server-world" value={settings.worldId || ""} onChange={(event) => setSettings({ ...settings, worldId: event.target.value || null })} required>
              <option value="">请选择世界</option>
              {settings.worldCandidates?.map((world) => <option key={world.worldId} value={world.worldId}>{world.worldId}</option>)}
            </select>
          </>}
          {settings.bindingErrorCode && <p className="form-error" role="alert">世界绑定不可用：{settings.bindingErrorCode}</p>}
          <label htmlFor="launch-arguments">启动参数</label>
          <input id="launch-arguments" value={settings.launchArguments} onChange={(event) => setSettings({ ...settings, launchArguments: event.target.value })} />
          <button className="primary-button" disabled={busy} type="submit"><Save size={18} />保存设置</button>
        </form> : <div className="notice-band"><ShieldCheck size={20} /><span>安装路径和启动参数只能在服务器本机修改。</span></div>}
      </section>
      <LiveMonitoring auth={auth} embedded />
    </div>
  );
}
