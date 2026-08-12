import { AlertTriangle, Settings } from "lucide-react";
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
    <div className="section-heading"><div><h2>控制台监听端口</h2><p>当前端口：{auth.port}。修改后需重启控制台才会生效。</p></div></div>
    {auth.local ? <form className="settings-form port-form" onSubmit={savePort}>
      <label htmlFor="console-port">控制台监听端口</label>
      <input id="console-port" type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required />
      <button className="primary-button" type="submit"><Settings size={18} />保存端口</button>
    </form> : <div className="notice-band"><AlertTriangle size={20} /><span>监听端口只能在服务器本机的配置页面修改。</span></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
  </section>;
}
