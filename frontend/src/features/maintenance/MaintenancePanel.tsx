import { Bell, DownloadCloud, Save, Send } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import type { ApplicationUpdateStatus, AuthStatus, NotificationStatus } from "../../api/contracts";
import { ApiRequestError, requestJson } from "../../api/client";

type Props = {
  auth: AuthStatus;
  applicationUpdateStatus: ApplicationUpdateStatus | null;
  onCheckApplicationUpdate: () => Promise<ApplicationUpdateStatus>;
};

function notificationError(caught: unknown, fallback: string) {
  return caught instanceof ApiRequestError ? caught.message.slice(caught.code.length + 2) : fallback;
}

export function MaintenancePanel({ auth, applicationUpdateStatus: status, onCheckApplicationUpdate }: Props) {
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (status && !status.stale) setError(""); }, [status]);
  const message = checked && !checking && status && !status.stale && !error
    ? status.updateAvailable ? `发现控制台新版本 v${status.latestVersion}。` : `PalServerConsole v${status.currentVersion} 已是最新版本。`
    : "";

  async function checkUpdate() {
    setChecking(true); setChecked(true); setError("");
    try {
      await onCheckApplicationUpdate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "检查控制台更新失败，请稍后重试。");
    } finally { setChecking(false); }
  }

  return <div className="maintenance-services">
    <header className="maintenance-reference-card maintenance-services-banner">
      <div><span aria-hidden="true">🛠️</span><h2>服务端运维工具与告警推送</h2></div>
      <p>检查 PalServerConsole 版本更新，配置运维事件告警推送。</p>
    </header>
    <div className="maintenance-services-grid">
      <section className="maintenance-reference-card maintenance-service-card" aria-labelledby="maintenance-console-update-title">
        <header className="maintenance-service-heading"><span className="maintenance-service-icon"><DownloadCloud aria-hidden="true" /></span><div><h3 id="maintenance-console-update-title">控制台版本更新</h3><p className="maintenance-service-product">PalServerConsole · Windows portable</p></div></header>
        <div className="maintenance-service-box maintenance-version-summary">
          <div><span>当前控制台版本:</span><strong>{status ? `v${status.currentVersion}` : "等待检查"}</strong></div>
          <div><span>最新稳定版本:</span><strong data-available={status?.updateAvailable || undefined}>{status ? `v${status.latestVersion}${status.stale ? "（上次结果）" : status.updateAvailable ? "（可更新）" : "（已是最新）"}` : "尚未取得检查结果"}</strong></div>
        </div>
        <button className="maintenance-application-check-button" type="button" disabled={checking} onClick={() => void checkUpdate()}>{checking ? <span className="maintenance-application-check-spinner" aria-hidden="true" /> : <DownloadCloud aria-hidden="true" />}<span>{checking ? "正在检查控制台更新..." : "检查控制台更新"}</span></button>
        {status?.stale && <p className="maintenance-service-note">暂时无法确认最新版本；当前显示上次检查结果，更新前会重新核对版本。</p>}
        {status && !status.portable && <p className="maintenance-service-note">源码模式可检查版本；自动安装需要 Windows portable 发行包。</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      <MaintenanceNotifications auth={auth} />
    </div>
  </div>;
}

function MaintenanceNotifications({ auth }: { auth: AuthStatus }) {
  const [notification, setNotification] = useState<NotificationStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void requestJson<NotificationStatus>("/api/maintenance/notifications").then(next => {
      if (active) { setNotification(next); setEnabled(next.enabled); setError(""); }
    }).catch((caught: unknown) => {
      if (active) setError(notificationError(caught, "维护通知状态读取失败，请稍后重试。"));
    });
    return () => { active = false; };
  }, [retry]);

  async function saveNotifications(event: FormEvent) {
    event.preventDefault();
    setBusy("save"); setError(""); setMessage("");
    try {
      const payload: { enabled: boolean; webhookUrl?: string; secret?: string } = { enabled };
      if (webhookUrl.trim()) payload.webhookUrl = webhookUrl.trim();
      if (secret) payload.secret = secret;
      const next = await requestJson<NotificationStatus>("/api/maintenance/notifications", {
        method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify(payload),
      });
      setNotification(next); setEnabled(next.enabled); setWebhookUrl(""); setSecret("");
      setMessage(next.enabled ? "运维事件推送已启用。" : "通知设置已保存，自动推送已停用。");
    } catch (caught) {
      setError(notificationError(caught, "维护通知保存失败，请稍后重试。"));
    } finally { setBusy(null); }
  }

  async function testNotification() {
    setBusy("test"); setError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>("/api/maintenance/notifications/test", {
        method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}",
      });
      setMessage(result.message);
    } catch (caught) {
      setError(notificationError(caught, "测试告警消息发送失败，请稍后重试。"));
    } finally { setBusy(null); }
  }

  const dirty = Boolean(webhookUrl || secret || (notification && enabled !== notification.enabled));
  const editable = auth.local && Boolean(notification) && !busy;

  return <section className="maintenance-reference-card maintenance-service-card" aria-labelledby="maintenance-notifications-title">
    <header className="maintenance-service-heading"><span className="maintenance-service-icon maintenance-service-alert-icon"><Bell aria-hidden="true" /></span><div><h3 id="maintenance-notifications-title">运维事件告警推送</h3><p>通用 HTTPS Webhook · HMAC-SHA256 签名</p></div></header>
    <form className="maintenance-notification-form" onSubmit={saveNotifications}>
      <div><label htmlFor="notification-webhook">HTTPS Webhook 地址</label><input id="notification-webhook" type="url" disabled={!editable} value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} placeholder={notification?.configured ? "已配置；留空保持已保存的地址" : "https://..."} /></div>
      <div><label htmlFor="notification-secret">Webhook 密钥</label><input id="notification-secret" type="password" autoComplete="new-password" disabled={!editable} value={secret} onChange={event => setSecret(event.target.value)} placeholder={notification?.configured ? "已配置；留空保持已保存的密钥" : "首次配置时填写，保存后不回显"} /></div>
      <div className="maintenance-notification-options">
        <div className="maintenance-service-box maintenance-notification-option"><label htmlFor="notification-enabled">启用服务器运维事件推送</label><input id="notification-enabled" type="checkbox" disabled={!editable} checked={enabled} onChange={event => setEnabled(event.target.checked)} /></div>
      </div>
      <button className="maintenance-secondary-button" type="button" disabled={!auth.local || !notification?.configured || Boolean(busy) || dirty} onClick={() => void testNotification()}>{busy === "test" ? <span className="maintenance-application-check-spinner" aria-hidden="true" /> : <Send aria-hidden="true" />}{busy === "test" ? "正在发送测试告警..." : "发送测试告警消息"}</button>
      <button className="maintenance-secondary-button" type="submit" disabled={!editable}><Save aria-hidden="true" />{busy === "save" ? "正在保存通知设置..." : "保存通知设置"}</button>
    </form>
    {!auth.local && <p className="maintenance-service-note">通知设置与测试告警仅限控制台本机操作。</p>}
    {dirty && notification?.configured && <p className="maintenance-service-note">保存当前设置后再发送测试告警。</p>}
    {!notification && !error && <p className="maintenance-service-note" role="status">正在读取通知设置...</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!notification && error && <button className="maintenance-secondary-button" type="button" onClick={() => setRetry(value => value + 1)}>重试读取通知设置</button>}
    {message && <p className="form-success" role="status">{message}</p>}
  </section>;
}
