import { BellRing, CalendarClock, CheckCircle2, CircleX, Download, KeyRound, Play, Save, ShieldCheck, TriangleAlert, Webhook } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { AuthStatus, NotificationStatus, Operation, ShellStatus } from "../../api/contracts";
import { createIdempotencyKey, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";

type UpdateProps = {
  auth: AuthStatus;
  status: ShellStatus | null;
  onOperation: (operation: Operation) => void;
};

export function MaintenancePanel({ auth, status, onOperation }: UpdateProps) {
  const [steamcmdPath, setSteamcmdPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmUpdate, setConfirmUpdate] = useState(false);

  async function startUpdate() {
    if (!steamcmdPath.trim()) {
      setError("请填写 steamcmd.exe 路径。");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const operation = await requestJson<Operation>("/api/maintenance/steamcmd-update", {
        method: "POST",
        headers: {
          "X-CSRF-Token": auth.csrfToken || "",
          "Idempotency-Key": createIdempotencyKey(),
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

  const canCheckUpdate = status?.serverState === "running";
  return <section className="maintenance-section maintenance-update" id="maintenance-update" aria-labelledby="maintenance-update-title">
    <div className="section-heading">
      <div><h2 id="maintenance-update-title">服务器更新</h2><p>SteamCMD 检查与更新必须由本机管理员明确确认后执行。</p></div>
    </div>
    <div className="maintenance-update-summary"><span>当前实例：{status?.instanceId || "default"}</span><span>当前版本：由 SteamCMD 检查时读取</span><span>更新状态：{canCheckUpdate ? "可检查更新" : "等待服务器运行"}</span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    {!auth.local && <div className="notice-band"><ShieldCheck size={20} /><span>维护更新只能在控制台本机修改。</span></div>}
    {auth.local && <div className="settings-form server-form maintenance-update-form">
      <label htmlFor="steamcmd-path">steamcmd.exe 路径</label>
      <input id="steamcmd-path" value={steamcmdPath} onChange={(event) => setSteamcmdPath(event.target.value)} placeholder="例如 C:\\SteamCMD\\steamcmd.exe" />
      <p>只允许正在运行且在线玩家为零的服务器进入更新流程；停服超时不会自动强制结束进程。</p>
      <button className="primary-button" type="button" disabled={busy || !canCheckUpdate} onClick={() => { if (!steamcmdPath.trim()) setError("请填写 steamcmd.exe 路径。"); else setConfirmUpdate(true); }}><Download size={18} />检查并执行 SteamCMD 更新</button>
    </div>}
    <ConfirmActionDialog open={confirmUpdate} title="执行 SteamCMD 更新？" description="更新会检查在线玩家、保存世界并关闭服务器；停服超时不会自动强制结束进程。" confirmLabel="确认更新" destructive confirmationText="UPDATE" confirmationLabel="高风险操作" disabled={busy} onOpenChange={setConfirmUpdate} onConfirm={() => void startUpdate()} />
  </section>;
}

export function MaintenanceNotificationsPanel({ auth }: { auth: AuthStatus }) {
  const [notification, setNotification] = useState<NotificationStatus>({ enabled: false, configured: false });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
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

  return <section className="maintenance-section maintenance-notifications" id="maintenance-notifications" aria-labelledby="maintenance-notifications-title">
    <section className="notification-heading"><div><span className="notification-heading-icon"><BellRing aria-hidden="true" /></span><div><h2 id="maintenance-notifications-title">维护通知</h2><p>将关键维护节点发送到团队 Webhook，密钥写入后不会再次显示。</p></div></div><div className="notification-status" aria-label="通知状态" data-enabled={notification.enabled || undefined}><span aria-hidden="true" /><div><small>当前状态</small><strong>{notification.enabled ? "已启用" : notification.configured ? "已配置，等待启用" : "尚未配置"}</strong></div></div></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    {!auth.local && <div className="notice-band"><ShieldCheck size={20} /><span>通知密钥只能在控制台本机修改。</span></div>}
    <div className="notification-layout">
      <section className="notification-events" aria-label="通知覆盖事件"><header><div><span>发送范围</span><h3>维护生命周期</h3></div><small>5 类事件</small></header><div>
        <article><CalendarClock aria-hidden="true" /><span><strong>计划</strong><small>维护任务进入倒计时</small></span></article>
        <article><Play aria-hidden="true" /><span><strong>开始</strong><small>服务器进入维护流程</small></span></article>
        <article><CheckCircle2 aria-hidden="true" /><span><strong>完成</strong><small>维护操作成功结束</small></span></article>
        <article><CircleX aria-hidden="true" /><span><strong>取消</strong><small>维护在执行前被取消</small></span></article>
        <article><TriangleAlert aria-hidden="true" /><span><strong>失败</strong><small>附带可诊断错误信息</small></span></article>
      </div><p><ShieldCheck aria-hidden="true" />只发送维护事件，不包含玩家数据、配置内容或密钥。</p></section>
      {auth.local && <form className="notification-form" onSubmit={saveNotifications}>
        <div className="notification-form-title"><div><h3>Webhook 连接</h3><p>留空已配置字段，可保持现有值不变。</p></div><label className="notification-switch"><input type="checkbox" checked={notification.enabled} onChange={(event) => setNotification({ ...notification, enabled: event.target.checked })} /><span aria-hidden="true" /><strong>{notification.enabled ? "启用" : "停用"}</strong></label></div>
        <label htmlFor="notification-webhook"><Webhook aria-hidden="true" /><span>HTTPS Webhook 地址</span></label>
        <input id="notification-webhook" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder={notification.configured ? "已配置；留空可保持不变" : "https://..."} />
        <label htmlFor="notification-secret"><KeyRound aria-hidden="true" /><span>Webhook 密钥</span></label>
        <input id="notification-secret" type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={notification.configured ? "已配置；留空可保持不变" : "首次启用时必填"} />
        <button className="primary-button" type="submit" disabled={busy}><Save size={18} />保存通知设置</button>
      </form>}
    </div>
  </section>;
}
