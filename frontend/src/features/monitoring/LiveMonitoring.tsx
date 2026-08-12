import { AlertTriangle, CircleStop, RefreshCw, Send, UserRoundX, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { AuthStatus, LiveValue, LiveSnapshot } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { liveConnectionLabel, useLiveEvents } from "../../hooks/useLiveEvents";
import { playerText, playerId, displayValue, formatBytes, formatObservedAt, sourceLabel, liveStatus } from "../../utils/format";

export function LiveMonitoring({ auth, embedded = false, onSnapshot }: { auth: AuthStatus; embedded?: boolean; onSnapshot?: (snapshot: LiveSnapshot) => void }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [unbanId, setUnbanId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nextRequestSignal = useAbortableRequest();

  const publishSnapshot = useCallback((nextSnapshot: LiveSnapshot) => {
    setSnapshot(nextSnapshot);
    onSnapshot?.(nextSnapshot);
  }, [onSnapshot]);

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const [info, players, metrics, settings] = await Promise.all([
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/info", { signal }),
        requestJson<LiveValue<unknown>>("/api/live/players", { signal }),
        requestJson<LiveValue<LiveSnapshot["metrics"]["data"]>>("/api/live/metrics", { signal }),
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/settings", { signal }),
      ]);
      publishSnapshot({ info, players, metrics, settings });
      setError("");
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(caught instanceof Error ? caught.message : "实时数据刷新失败");
    }
  }, [nextRequestSignal, publishSnapshot]);

  useEffect(() => { void refresh(); }, [refresh]);
  const handleSnapshot = useCallback((nextSnapshot: LiveSnapshot) => {
    publishSnapshot(nextSnapshot);
    setError("");
  }, [publishSnapshot]);
  const handleMalformedSnapshot = useCallback(() => setError("实时数据格式无效。"), []);
  const connectionStatus = useLiveEvents(
    "/api/events",
    "snapshot",
    handleSnapshot,
    handleMalformedSnapshot,
  );

  async function action(path: string, body?: object) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>(path, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(body || {}),
      });
      setMessage(result.message);
      void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "管理操作失败");
    } finally { setBusy(false); }
  }

  const players = playersFrom(snapshot?.players.data);
  const process = snapshot?.metrics.data.process;
  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    {embedded && <section className="section-heading live-monitoring-heading"><div><h2>实时监控</h2><p>在线玩家、服务器状态和进程指标</p></div></section>}
    {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
    <section className="live-toolbar">
      <div><span className={connectionStatus === "open" && !snapshot?.info.stale ? "status-dot" : "status-dot stale-dot"} /><strong>{snapshot?.info.stale ? "实时数据已过期" : "实时数据正常"}</strong><small>{liveStatus(snapshot?.info)} · {liveConnectionLabel(connectionStatus)}</small></div>
      <button className="icon-button bordered" title="立即刷新实时数据" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    <section className="metric-grid live-metrics" aria-label="实时服务器指标">
      <article><span>在线玩家</span><strong>{players.length}</strong><small>{sourceLabel(snapshot?.players)}</small></article>
      <article><span>Server FPS</span><strong>{displayValue(snapshot?.metrics.data.server, ["serverfps", "serverFps", "ServerFPS", "fps"])}</strong><small>{sourceLabel(snapshot?.metrics)}</small></article>
      <article><span>进程 CPU</span><strong>{process ? `${process.cpuPercent}%` : "不可用"}</strong><small>{process ? `内存 ${formatBytes(process.memoryBytes)}` : sourceLabel(snapshot?.metrics)}</small></article>
    </section>
    <section className="live-section">
      <div className="section-heading"><div><h2>服务器状态</h2><p>{sourceLabel(snapshot?.info)} · {formatObservedAt(snapshot?.info.observedAt)}</p></div><span className={snapshot?.info.stale ? "badge warning" : "badge success"}>{snapshot?.info.stale ? "已过期" : "最新"}</span></div>
      <dl className="live-detail-grid">
        <div><dt>服务器</dt><dd>{displayValue(snapshot?.info.data, ["servername", "serverName", "ServerName"] )}</dd></div>
        <div><dt>版本</dt><dd>{displayValue(snapshot?.info.data, ["version", "Version"])}</dd></div>
        <div><dt>世界</dt><dd>{displayValue(snapshot?.info.data, ["worldguid", "worldName", "WorldName", "worldId"] )}</dd></div>
        <div><dt>磁盘读取</dt><dd>{process ? formatBytes(process.diskReadBytes) : "不可用"}</dd></div>
        <div><dt>磁盘写入</dt><dd>{process ? formatBytes(process.diskWriteBytes) : "不可用"}</dd></div>
      </dl>
    </section>
    <section className="live-section">
      <div className="section-heading"><div><h2>在线玩家</h2><p>{sourceLabel(snapshot?.players)}。完整 IP 按管理需求显示。</p></div><Users size={22} /></div>
      {players.length ? <div className="player-table" role="table"><div className="player-head" role="row"><span>玩家</span><span>Player ID</span><span>IP</span><span>操作</span></div>{players.map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        return <div className="player-row" role="row" key={`${id}-${index}`}><span>{playerText(player, ["name", "playerName", "accountName"], "未知玩家")}</span><span>{id}</span><span>{playerText(player, ["ip", "ipAddress"], "不可用")}</span><span className="player-actions"><button title="踢出玩家" disabled={busy || id.startsWith("unknown-")} onClick={() => { if (window.confirm(`确认踢出 ${id}？`)) void action(`/api/live/players/${encodeURIComponent(id)}/kick`, { message: "管理员已将你踢出服务器。" }); }}><UserRoundX size={16} /></button><button className="danger-icon" title="封禁玩家" disabled={busy || id.startsWith("unknown-")} onClick={() => { if (window.confirm(`确认封禁 ${id}？`)) void action(`/api/live/players/${encodeURIComponent(id)}/ban`, { message: "管理员已封禁此账号。" }); }}><CircleStop size={16} /></button></span></div>;
      })}</div> : <p className="empty-state">当前没有可用的在线玩家数据。</p>}
    </section>
    <section className="live-actions">
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (announcement.trim()) void action("/api/live/announce", { message: announcement.trim() }); }}><label htmlFor="announcement">服务器公告</label><input id="announcement" maxLength={500} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="输入公告内容" /><button className="primary-button" disabled={busy} type="submit"><Send size={18} />发送</button></form>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (unbanId.trim()) void action(`/api/live/players/${encodeURIComponent(unbanId.trim())}/unban`); }}><label htmlFor="unban-id">解除封禁 User ID</label><input id="unban-id" maxLength={256} value={unbanId} onChange={(event) => setUnbanId(event.target.value)} placeholder="输入 User ID" /><button className="quiet-button" disabled={busy} type="submit">解除封禁</button></form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
    </section>
  </div>;
}

function playersFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return playersFrom((data as Record<string, unknown>).players);
  return [];
}
