import { FolderSearch, Save, Server, ShieldCheck } from "lucide-react";
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
    <div className="section-heading">
      <div><h2>PalServer 安装与世界</h2><p>{settings.executablePath || "尚未选择 PalServer.exe"}</p></div>
      {auth.local && <button className="quiet-button" type="button" disabled={busy} onClick={() => void discover()}><FolderSearch size={18} />扫描 Steam</button>}
    </div>
    {candidates.length > 0 && <div className="candidate-list">{candidates.map((candidate) => <button type="button" key={candidate.executablePath} onClick={() => setSettings({ ...settings, executablePath: candidate.executablePath, worldId: null, worldCandidates: candidate.worldCandidates })}><Server size={18} /><span><strong>{candidate.installPath}</strong><small>{candidate.manifestValid ? "manifest 已验证" : "manifest 未验证"}</small></span></button>)}</div>}
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
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </section>;
}
