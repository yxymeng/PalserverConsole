import { AlertTriangle, CircleStop, RefreshCw, Send, UserRoundX, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AuthStatus, LiveSnapshot, LiveValue, ProcessMetrics, ShellStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { liveConnectionLabel, useLiveEvents } from "../../hooks/useLiveEvents";
import { displayValue, formatByteRate, formatBytes, formatPercent, liveStatus, playerId, playerText, sourceLabel } from "../../utils/format";
import { serverStateLabel } from "../server/labels";

export function LiveMonitoring({
  auth,
  embedded = false,
  shell,
  onSnapshot,
}: {
  auth: AuthStatus;
  embedded?: boolean;
  shell?: ShellStatus | null;
  onSnapshot?: (snapshot: LiveSnapshot) => void;
}) {
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
  const liveTitle = !snapshot ? "正在连接实时数据" : snapshot.info.stale ? "实时数据已过期" : "实时数据正常";
  const liveDotClass = connectionStatus === "open" && snapshot && !snapshot.info.stale ? "status-dot" : "status-dot stale-dot";

  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    <section className="section-heading live-monitoring-heading"><div><h2>实时状态</h2><p>服务器状态、性能与在线玩家集中显示。</p></div></section>
    {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
    <section className="live-toolbar">
      <div className="live-status-summary"><span className={liveDotClass} /><strong>{liveTitle}</strong><small>{liveStatus(snapshot?.info)} · {liveConnectionLabel(connectionStatus)}</small></div>
      <button className="icon-button bordered" title="立即刷新实时数据" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    <section className="metric-grid live-status-grid" aria-label="实时服务器状态">
      <article><span>服务器状态</span><strong>{shell ? serverStateLabel(shell.serverState) : "读取中"}</strong><small>{shell ? `检测于 ${new Date(shell.observedAt * 1_000).toLocaleTimeString("zh-CN")}` : "正在读取服务器状态"}</small></article>
      <article><span>在线玩家</span><strong>{snapshot ? players.length : "读取中"}</strong><small>{sourceLabel(snapshot?.players)}</small></article>
      <UptimeMetric state={shell?.serverState} startedAt={process?.startedAt} />
      <article><span>服务器帧率</span><strong>{displayValue(snapshot?.metrics.data.server, ["serverfps", "serverFps", "ServerFPS", "fps"])}</strong><small>{sourceLabel(snapshot?.metrics)}</small></article>
      <article><span>CPU 使用率</span><strong>{processCpuText(process)}</strong><small>{process?.cpuReady === false ? "首次采样后显示实时值" : "PalServer 进程树的整机占比"}</small></article>
      <article><span>内存使用</span><strong>{processMemoryText(process)}</strong><small>{process?.pids.length ? "PalServer 进程树内存" : "未检测到 PalServer 进程"}</small></article>
      <article><span>磁盘读取</span><strong>{processRateText(process, process?.diskReadBytesPerSecond)}</strong><small>{process?.ioReady === false ? "正在建立速率基线" : "PalServer 进程树读取速度"}</small></article>
      <article><span>磁盘写入</span><strong>{processRateText(process, process?.diskWriteBytesPerSecond)}</strong><small>{process?.ioReady === false ? "正在建立速率基线" : "PalServer 进程树写入速度"}</small></article>
    </section>
    <section className="live-info-row" aria-label="服务器附加信息">
      <span><small>服务器</small><strong>{displayValue(snapshot?.info.data, ["servername", "serverName", "ServerName"])}</strong></span>
      <span><small>版本</small><strong>{displayValue(snapshot?.info.data, ["version", "Version"])}</strong></span>
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

function UptimeMetric({ state, startedAt }: { state?: ShellStatus["serverState"]; startedAt?: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <article><span>运行时间</span><strong>{uptimeText(state, startedAt, now)}</strong><small>{state === "running" && startedAt ? `自 ${new Date(startedAt * 1_000).toLocaleString("zh-CN")}` : state === "running" ? "进程启动时间不可用" : "服务器停止时不计时"}</small></article>;
}

function processCpuText(process?: ProcessMetrics) {
  if (!process) return "不可用";
  if (!process.pids.length) return "未运行";
  return formatPercent(process.cpuPercent, process.cpuReady);
}

function processMemoryText(process?: ProcessMetrics) {
  if (!process) return "不可用";
  return process.pids.length ? formatBytes(process.memoryBytes) : "未运行";
}

function processRateText(process: ProcessMetrics | undefined, value: number | undefined) {
  if (!process) return "不可用";
  if (!process.pids.length) return "未运行";
  return formatByteRate(value, process.ioReady);
}

function uptimeText(state: ShellStatus["serverState"] | undefined, startedAt: number | null | undefined, now: number): string {
  if (!state) return "读取中";
  if (state !== "running") return "未运行";
  if (!startedAt) return "不可用";
  const seconds = Math.max(0, Math.floor(now / 1_000 - startedAt));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function playersFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return playersFrom((data as Record<string, unknown>).players);
  return [];
}
