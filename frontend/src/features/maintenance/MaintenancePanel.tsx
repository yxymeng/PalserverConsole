import { BellRing, Download, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, NotificationStatus, Operation, ShellStatus } from "../../api/contracts";
import { requestJson } from "../../api/client";

type Props = {
  auth: AuthStatus;
  status: ShellStatus | null;
  onOperation: (operation: Operation) => void;
};

export function MaintenancePanel({ auth, status, onOperation }: Props) {
  const [notification, setNotification] = useState<NotificationStatus>({ enabled: false, configured: false });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [steamcmdPath, setSteamcmdPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void requestJson<NotificationStatus>("/api/maintenance/notifications")
      .then(setNotification)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : "维护通知状态读取失败"));
  }, []);

  async function saveNotifications(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const payload: { enabled: boolean; webhookUrl?: string; secret?: string } = { enabled: notification.enabled };
      if (webhookUrl.trim()) payload.webhookUrl = webhookUrl.trim();
      if (secret) payload.secret = secret;
      const next = await requestJson<NotificationStatus>("/api/maintenance/notifications", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(payload),
      });
      setNotification(next);
      setSecret("");
      setMessage(next.enabled ? "维护通知已启用。" : "维护通知已保存为关闭状态。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "维护通知保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function startUpdate() {
    if (!steamcmdPath.trim()) {
      setError("请填写 steamcmd.exe 路径。");
      return;
    }
    if (!window.confirm("更新会检查在线玩家、保存世界并关闭服务器。确认继续吗？")) return;
    if (window.prompt("请输入 UPDATE 确认 SteamCMD 更新：", "") !== "UPDATE") {
      setMessage("未输入 UPDATE，更新未开始。");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const operation = await requestJson<Operation>("/api/maintenance/steamcmd-update", {
        method: "POST",
        headers: {
          "X-CSRF-Token": auth.csrfToken || "",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          steamCmdPath: steamcmdPath.trim(),
          confirmation: "UPDATE",
          countdownSeconds: 30,
          message: "服务器将在 30 秒后进行维护更新，请及时返回安全地点。",
        }),
      });
      onOperation(operation);
      setMessage("SteamCMD 更新已排队；倒计时期间可取消。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "SteamCMD 更新提交失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section embedded-settings" aria-label="安全更新与维护通知">
      <div className="section-heading">
        <div>
          <h2>安全更新与维护通知</h2>
          <p>当前实例：{status?.instanceId || "default"}。更新只能从本机明确确认后执行。</p>
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      {!auth.local && <div className="notice-band"><ShieldCheck size={20} /><span>维护更新和通知密钥只能在控制台本机修改。</span></div>}
      {auth.local && <>
        <form className="settings-form server-form" onSubmit={saveNotifications}>
          <label className="maintenance-toggle"><input type="checkbox" checked={notification.enabled} onChange={(event) => setNotification({ ...notification, enabled: event.target.checked })} /><span>启用维护 Webhook 通知</span></label>
          <p>仅发送维护计划、开始、完成、取消和失败事件。密钥不会再次显示。</p>
          <label htmlFor="notification-webhook">HTTPS Webhook 地址</label>
          <input id="notification-webhook" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder={notification.configured ? "已配置；留空可保持不变" : "https://..."} />
          <label htmlFor="notification-secret">Webhook 密钥</label>
          <input id="notification-secret" type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={notification.configured ? "已配置；留空可保持不变" : "首次启用时必填"} />
          <button className="primary-button" type="submit" disabled={busy}><Save size={18} />保存通知设置</button>
        </form>
        <div className="settings-form server-form">
          <label htmlFor="steamcmd-path">steamcmd.exe 路径</label>
          <input id="steamcmd-path" value={steamcmdPath} onChange={(event) => setSteamcmdPath(event.target.value)} placeholder="例如 C:\\SteamCMD\\steamcmd.exe" />
          <p>只允许正在运行且在线玩家为零的服务器进入更新流程；停服超时不会自动强制结束进程。</p>
          <button type="button" disabled={busy || status?.serverState !== "running"} onClick={() => void startUpdate()}><Download size={18} />检查并执行 SteamCMD 更新</button>
        </div>
      </>}
      <div className="notice-band"><BellRing size={20} /><span>通知状态：{notification.enabled ? "已启用" : notification.configured ? "已配置但未启用" : "未配置"}</span></div>
    </section>
  );
}
