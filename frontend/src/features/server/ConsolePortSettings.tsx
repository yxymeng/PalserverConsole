import { AlertTriangle, Network, RotateCw, Save } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { AuthStatus } from "../../api/contracts";
import { requestJson } from "../../api/client";

export function ConsolePortSettings({ auth, onAuthChanged }: { auth: AuthStatus; onAuthChanged: () => void }) {
  const [port, setPort] = useState(String(auth.port));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { setPort(String(auth.port)); }, [auth.port]);

  async function savePort(event: FormEvent) {
    event.preventDefault();
    setMessage("");
    setError("");
    try {
      const result = await requestJson<{ message: string }>("/api/settings/network", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ port: Number(port) }),
      });
      setMessage(result.message);
      onAuthChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存端口失败");
    }
  }

  return <section className="settings-section embedded-settings console-port-settings">
    <header className="instance-panel-heading"><div><span className="instance-panel-icon"><Network aria-hidden="true" /></span><div><h2>控制台连接</h2><p>管理界面的 Web 监听入口，与游戏端口相互独立。</p></div></div></header>
    <div className="console-port-summary" aria-label="当前控制台端口"><span><small>当前监听</small><strong>{auth.port}</strong></span><span><RotateCw aria-hidden="true" /><small>生效方式</small><strong>重启控制台</strong></span></div>
    <div className="console-scope-note"><AlertTriangle aria-hidden="true" /><p><strong>修改不会立即断开当前页面。</strong><span>保存后仍由当前端口提供服务，直到你手动重启 PalServerConsole。</span></p></div>
    {auth.local ? <form className="console-port-form" onSubmit={savePort}>
      <label htmlFor="console-port"><span>新的监听端口</span><small>有效范围 1–65535，请避开 PalServer 游戏与 RCON 端口。</small></label>
      <div><input id="console-port" type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required /><button className="primary-button" type="submit"><Save size={18} />保存端口</button></div>
    </form> : <div className="notice-band"><AlertTriangle size={20} /><span>监听端口只能在服务器本机的配置页面修改。</span></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </section>;
}
