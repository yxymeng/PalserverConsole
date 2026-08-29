import { BellRing, CalendarClock, CheckCircle2, CircleX, Download, KeyRound, Play, Save, ShieldCheck, TriangleAlert, Webhook } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { AuthStatus, NotificationStatus, Operation, ShellStatus } from "../../api/contracts";
import { createIdempotencyKey, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { BlurFade } from "../../components/ui/blur-fade";

type UpdateProps = {
  auth: AuthStatus;
  status: ShellStatus | null;
  onOperation: (operation: Operation) => void;
};

const NOTIFICATION_EVENTS = [
  { key: "planned", label: "计划", detail: "维护任务进入倒计时", icon: CalendarClock },
  { key: "started", label: "开始", detail: "服务器进入维护流程", icon: Play },
  { key: "completed", label: "完成", detail: "维护操作成功结束", icon: CheckCircle2 },
  { key: "cancelled", label: "取消", detail: "维护在执行前被取消", icon: CircleX },
  { key: "failed", label: "失败", detail: "附带可诊断的错误信息", icon: TriangleAlert },
] as const;

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
  return <section className="maintenance-section maintenance-update" id="maintenance-server-update" aria-labelledby="maintenance-server-update-title">
    <div className="section-heading maintenance-card-heading">
      <span className="maintenance-card-icon"><Download aria-hidden="true" /></span>
      <div><h2 id="maintenance-server-update-title">服务器更新</h2><p>SteamCMD 检查与更新必须由本机管理员明确确认后执行。</p></div>
    </div>
    <div className="maintenance-update-summary"><span><small>当前实例</small><strong>{status?.instanceId || "default"}</strong></span><span><small>版本来源</small><strong>SteamCMD 检查</strong></span><span><small>更新状态</small><strong>{canCheckUpdate ? "可检查更新" : "等待服务器运行"}</strong></span></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    {!auth.local && <div className="notice-band"><ShieldCheck size={20} /><span>维护更新只能在控制台本机修改。</span></div>}
    {auth.local && <div className="settings-form server-form maintenance-update-form">
      <label htmlFor="steamcmd-path">steamcmd.exe 路径</label>
      <input id="steamcmd-path" value={steamcmdPath} onChange={(event) => setSteamcmdPath(event.target.value)} placeholder="例如 C:\\SteamCMD\\steamcmd.exe" />
      <p>只允许正在运行且在线训练家为零的服务器进入更新流程；停服超时不会自动强制结束进程。</p>
      <button className="primary-button" type="button" disabled={busy || !canCheckUpdate} onClick={() => { if (!steamcmdPath.trim()) setError("请填写 steamcmd.exe 路径。"); else setConfirmUpdate(true); }}><Download size={18} />检查并执行 SteamCMD 更新</button>
    </div>}
    <ConfirmActionDialog open={confirmUpdate} title="执行 SteamCMD 更新？" description="更新会检查在线训练家、保存世界并关闭服务器；停服超时不会自动强制结束进程。" confirmLabel="确认更新" destructive confirmationText="UPDATE" confirmationLabel="高风险操作" disabled={busy} onOpenChange={setConfirmUpdate} onConfirm={() => void startUpdate()} />
  </section>;
}

export function MaintenanceNotificationsPanel({ auth }: { auth: AuthStatus }) {
  const [notification, setNotification] = useState<NotificationStatus>({ enabled: false, configured: false });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [selectedEvent, setSelectedEvent] = useState(0);

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

  const activeEvent = NOTIFICATION_EVENTS[selectedEvent];
  const ActiveEventIcon = activeEvent.icon;
  const notificationState = notification.enabled ? "已启用" : notification.configured ? "已配置，当前停用" : "尚未配置";

  return <section className="maintenance-section maintenance-notifications" id="maintenance-notifications" aria-labelledby="maintenance-notifications-title">
    <BlurFade duration={0.24} offset={5}><header className="notification-heading"><div><span className="notification-heading-icon"><BellRing aria-hidden="true" /></span><div><h2 id="maintenance-notifications-title">维护通知</h2><p>把维护进度发送到一个 HTTPS Webhook；玩家数据、配置内容和密钥不会进入通知。</p></div></div><div className="notification-status" aria-label="通知状态" data-enabled={notification.enabled || undefined} data-configured={notification.configured || undefined}><span aria-hidden="true" /><div><small>发送状态</small><strong>{notificationState}</strong></div></div></header></BlurFade>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    {!auth.local && <div className="notice-band"><ShieldCheck size={20} /><span>通知密钥只能在控制台本机修改。</span></div>}
    <div className="notification-layout">
      <BlurFade className="notification-events-motion" delay={0.04} duration={0.24} offset={5}><section className="notification-events" aria-label="通知覆盖事件"><header><div><h3>发送范围</h3><p>选择阶段查看对应通知内容。</p></div><small>固定 5 类</small></header><div className="notification-event-tabs" role="tablist" aria-label="维护通知阶段">
        {NOTIFICATION_EVENTS.map((item, index) => { const Icon = item.icon; return <button key={item.key} type="button" role="tab" aria-selected={selectedEvent === index} aria-controls="notification-event-detail" onClick={() => setSelectedEvent(index)}><Icon aria-hidden="true" /><span>{item.label}</span></button>; })}
      </div><div className="notification-event-detail" id="notification-event-detail" role="tabpanel"><ActiveEventIcon aria-hidden="true" /><div><strong>{activeEvent.label}</strong><p>{activeEvent.detail}</p></div></div><footer><ShieldCheck aria-hidden="true" /><span>只发送阶段、结果与必要的错误标识。</span></footer></section></BlurFade>
      {auth.local && <BlurFade className="notification-form-motion" delay={0.08} duration={0.24} offset={5}><form className="notification-form" onSubmit={saveNotifications}>
        <header className="notification-form-title"><div><h3>Webhook 连接</h3><p>{notification.configured ? "连接已保存；地址或密钥留空时保持现有值。" : "填写接收地址和密钥，然后启用发送。"}</p></div><label className="notification-switch"><input type="checkbox" checked={notification.enabled} onChange={(event) => setNotification({ ...notification, enabled: event.target.checked })} /><span aria-hidden="true" /><strong>{notification.enabled ? "发送已开启" : "发送已停用"}</strong></label></header>
        <div className="notification-fields"><label htmlFor="notification-webhook"><span><Webhook aria-hidden="true" /><strong>HTTPS Webhook 地址</strong></span><small>{notification.configured ? "留空保持已保存的地址" : "必须使用 HTTPS 地址"}</small></label><input id="notification-webhook" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder={notification.configured ? "已配置；无需重复填写" : "https://..."} />
        <label htmlFor="notification-secret"><span><KeyRound aria-hidden="true" /><strong>Webhook 密钥</strong></span><small>保存后不会再次显示</small></label><input id="notification-secret" type="password" autoComplete="new-password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={notification.configured ? "已配置；无需重复填写" : "首次启用时填写"} /></div>
        <footer className="notification-action"><span><ShieldCheck aria-hidden="true" />设置只保存在本机后端</span><button className="primary-button" type="submit" disabled={busy}><Save size={18} />{busy ? "正在保存" : "保存通知设置"}</button></footer>
      </form></BlurFade>}
    </div>
  </section>;
}
