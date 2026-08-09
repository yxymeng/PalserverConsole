import { AlertTriangle, CheckCircle2, Settings } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, ShellStatus } from "../../api/contracts";
import { requestJson } from "../../api/client";
import { serverStateLabel } from "../server/labels";
import { text } from "../../app/text";

export function Overview({ shell, auth, onAuthChanged }: { shell: ShellStatus | null; auth: AuthStatus; onAuthChanged: () => void }) {
  const [port, setPort] = useState(String(auth.port));
  const [portMessage, setPortMessage] = useState("");
  const [portError, setPortError] = useState("");

  useEffect(() => { setPort(String(auth.port)); }, [auth.port]);

  async function savePort(event: FormEvent) {
    event.preventDefault();
    setPortMessage("");
    setPortError("");
    try {
      const result = await requestJson<{ message: string }>("/api/settings/network", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ port: Number(port) }),
      });
      setPortMessage(result.message);
      onAuthChanged();
    } catch (caught) {
      setPortError(caught instanceof Error ? caught.message : "保存端口失败");
    }
  }

  return (
    <div className="page-stack">
      {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
      <section className="status-band">
        <div className="status-icon"><CheckCircle2 size={25} /></div>
        <div>
          <h2>{text.shellTitle}</h2>
          <p>{text.shellBody}</p>
        </div>
        <span className="badge">M2</span>
      </section>
      <section className="metric-grid" aria-label="基础状态">
        <article><span>控制台后端</span><strong>运行中</strong><small>FastAPI 单进程</small></article>
        <article><span>访问模式</span><strong>{auth.local ? "本机免登录" : "LAN 已认证"}</strong><small>{auth.adminPasswordConfigured ? "使用游戏管理员密码" : "仅监听 127.0.0.1"}</small></article>
        <article><span>PalServer</span><strong>{serverStateLabel(shell?.serverState)}</strong><small>{shell ? new Date(shell.observedAt * 1000).toLocaleTimeString("zh-CN") : "状态不可用"}</small></article>
      </section>
      <section className="settings-section overview-network-settings">
        <div className="section-heading"><div><h2>控制台监听端口</h2><p>当前端口：{auth.port}。修改后需重启控制台才会生效。</p></div></div>
        {auth.local ? <form className="settings-form port-form" onSubmit={savePort}>
          <label htmlFor="console-port">控制台监听端口</label>
          <input id="console-port" type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required />
          {portError && <p className="form-error" role="alert">{portError}</p>}
          {portMessage && <p className="form-success" role="status">{portMessage}</p>}
          <button className="primary-button" type="submit"><Settings size={18} />保存端口</button>
        </form> : <div className="notice-band"><AlertTriangle size={20} /><span>监听端口只能在服务器本机的总览页面修改。</span></div>}
      </section>
    </div>
  );
}
