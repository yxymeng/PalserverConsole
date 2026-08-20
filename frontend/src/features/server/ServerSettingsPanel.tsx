import { Box, Command, FolderSearch, HardDrive, Save, Server, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import type { AuthStatus, DiscoveryCandidate, ServerSettings } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";

export function ServerSettingsPanel({ auth }: { auth: AuthStatus }) {
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      setSettings(await requestJson<ServerSettings>("/api/server/settings", { signal }));
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "服务器设置读取失败");
    }
  }, [nextRequestSignal]);

  useEffect(() => { void load(); }, [load]);

  async function discover() {
    setBusy(true);
    setError("");
    try {
      setCandidates(await requestJson<DiscoveryCandidate[]>("/api/server/discovery"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Steam 发现失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await requestJson<{ message: string }>("/api/server/settings", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(settings),
      });
      setMessage(result.message);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="settings-section embedded-settings server-settings-panel">
    <header className="instance-panel-heading"><div><span className="instance-panel-icon"><Server aria-hidden="true" /></span><div><h2>PalServer 运行实例</h2><p>控制进程实际从哪里启动，以及它绑定哪个世界。</p></div></div>{auth.local && <button className="quiet-button" type="button" disabled={busy} onClick={() => void discover()}><FolderSearch size={17} />扫描 Steam</button>}</header>
    <div className="instance-target-strip" aria-label="当前运行目标">
      <span><HardDrive aria-hidden="true" /><small>可执行文件</small><strong>{settings.executablePath ? settings.executablePath.split(/[\\/]/).pop() : "尚未选择"}</strong></span>
      <span><Box aria-hidden="true" /><small>绑定世界</small><strong>{settings.worldId || "等待明确选择"}</strong></span>
    </div>
    {candidates.length > 0 && <div className="candidate-list instance-candidate-list"><div><strong>发现的 Steam 安装</strong><small>选择后仍需确认 World 绑定并保存。</small></div>{candidates.map((candidate) => <button type="button" key={candidate.executablePath} onClick={() => setSettings({ ...settings, executablePath: candidate.executablePath, worldId: null, worldCandidates: candidate.worldCandidates })}><Server size={18} /><span><strong>{candidate.installPath}</strong><small>{candidate.manifestValid ? "manifest 已验证" : "manifest 未验证"}</small></span></button>)}</div>}
    {auth.local ? <form className="instance-settings-form" onSubmit={saveSettings}>
      <label className="instance-field" htmlFor="server-executable"><span><HardDrive aria-hidden="true" /><strong>PalServer.exe 路径</strong></span><small>服务器启动、停止与状态识别使用的唯一进程目标。</small><input id="server-executable" value={settings.executablePath || ""} onChange={(event) => setSettings({ ...settings, executablePath: event.target.value })} required /></label>
      {(settings.worldCandidates?.length || 0) > 0 && <label className="instance-field" htmlFor="server-world"><span><Box aria-hidden="true" /><strong>World 绑定</strong></span><small>必须显式选择，避免对错误存档执行读取或维护操作。</small><select id="server-world" value={settings.worldId || ""} onChange={(event) => setSettings({ ...settings, worldId: event.target.value || null })} required><option value="">请选择世界</option>{settings.worldCandidates?.map((world) => <option key={world.worldId} value={world.worldId}>{world.worldId}</option>)}</select></label>}
      {settings.bindingErrorCode && <p className="form-error" role="alert">世界绑定不可用：{settings.bindingErrorCode}</p>}
      <label className="instance-field" htmlFor="launch-arguments"><span><Command aria-hidden="true" /><strong>启动参数</strong></span><small>仅随下次启动传递，不会修改 PalWorldSettings.ini。</small><input id="launch-arguments" value={settings.launchArguments} onChange={(event) => setSettings({ ...settings, launchArguments: event.target.value })} /></label>
      <div className="instance-form-action"><span>保存只更新控制台实例设置，不会自动启动或重启服务器。</span><button className="primary-button" disabled={busy} type="submit"><Save size={18} />{busy ? "正在保存…" : "保存运行实例"}</button></div>
    </form> : <div className="notice-band"><ShieldCheck size={20} /><span>安装路径和启动参数只能在服务器本机修改。</span></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </section>;
}
