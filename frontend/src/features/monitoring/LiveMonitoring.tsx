import { AlertTriangle, CheckCircle2, CircleStop, RefreshCw, Send, UserRoundX, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AuthStatus, LiveSnapshot, LiveValue, ProcessMetrics, ShellStatus, WorldStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { liveConnectionLabel, useLiveEvents } from "../../hooks/useLiveEvents";
import { displayValue, formatByteRate, formatBytes, formatPercent, liveStatus, playerId, playerText, sourceLabel } from "../../utils/format";
import { serverStateLabel } from "../server/labels";
import { liveTitleText, onlinePlayersSummary, playerDataState, worldStatusAfterResponse } from "./livePresentation";

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
  const [worldStatus, setWorldStatus] = useState<WorldStatus | null>(null);
  const [worldError, setWorldError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [unbanId, setUnbanId] = useState("");
  const [message, setMessage] = useState("");
  const [dataError, setDataError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPlayerAction, setPendingPlayerAction] = useState<{ kind: "kick" | "ban"; id: string } | null>(null);
  const nextRequestSignal = useAbortableRequest();

  const publishSnapshot = useCallback((nextSnapshot: LiveSnapshot) => {
    setSnapshot(nextSnapshot);
    onSnapshot?.(nextSnapshot);
  }, [onSnapshot]);

  const refresh = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const worldRequest = requestJson<WorldStatus>("/api/world/snapshots/current", { signal })
        .then((value) => ({ value, error: "" }))
        .catch((caught) => ({
          value: null,
          error: isAbortError(caught) ? "" : caught instanceof Error ? caught.message : "世界状态读取失败",
        }));
      const [info, players, metrics, settings, world] = await Promise.all([
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/info", { signal }),
        requestJson<LiveValue<unknown>>("/api/live/players", { signal }),
        requestJson<LiveValue<LiveSnapshot["metrics"]["data"]>>("/api/live/metrics", { signal }),
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/settings", { signal }),
        worldRequest,
      ]);
      publishSnapshot({ info, players, metrics, settings });
      if (world.value || world.error) {
        setWorldStatus(worldStatusAfterResponse(world.value, world.error));
        setWorldError(world.error);
      }
      setDataError("");
    } catch (caught) {
      if (isAbortError(caught)) return;
      setDataError(caught instanceof Error ? caught.message : "实时数据刷新失败");
    }
  }, [nextRequestSignal, publishSnapshot]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    let active = true;
    const timer = window.setInterval(async () => {
      try {
        const nextWorldStatus = await requestJson<WorldStatus>("/api/world/snapshots/current");
        if (active) {
          setWorldStatus(nextWorldStatus);
          setWorldError("");
        }
      } catch (caught) {
        if (active) {
          setWorldStatus(null);
          setWorldError(caught instanceof Error ? caught.message : "世界状态读取失败");
        }
      }
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  const handleSnapshot = useCallback((nextSnapshot: LiveSnapshot) => {
    publishSnapshot(nextSnapshot);
    setDataError("");
  }, [publishSnapshot]);
  const handleMalformedSnapshot = useCallback(() => setDataError("实时数据格式无效。"), []);
  const connectionStatus = useLiveEvents(
    "/api/events",
    "snapshot",
    handleSnapshot,
    handleMalformedSnapshot,
  );

  async function action(path: string, body?: object) {
    setBusy(true); setActionError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>(path, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(body || {}),
      });
      setMessage(result.message);
      void refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "管理操作失败");
    } finally { setBusy(false); }
  }

  const players = playersFrom(snapshot?.players.data);
  const playerState = playerDataState(snapshot, dataError, players.length);
  const onlinePlayers = onlinePlayersSummary(players, playerState, snapshot?.players.stale === true);
  const process = snapshot?.metrics.data.process;
  const liveTitle = liveTitleText(snapshot, dataError, connectionStatus);
  const liveDotClass = connectionStatus === "open" && snapshot && !snapshot.info.stale ? "status-dot" : "status-dot stale-dot";

  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    <section className="section-heading live-monitoring-heading"><div><h2>实时状态</h2><p>服务器状态、性能与在线玩家集中显示。</p></div></section>
    <section className="live-toolbar">
      <div className="live-status-summary"><span className={liveDotClass} /><strong>{liveTitle}</strong><small>{liveStatus(snapshot?.info)} · {liveConnectionLabel(connectionStatus)}</small></div>
      <Button variant="outline" size="icon" type="button" title="立即刷新实时数据" aria-label="立即刷新实时数据" onClick={() => void refresh()}><RefreshCw aria-hidden="true" /></Button>
    </section>
    {dataError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时数据不可用</AlertTitle><AlertDescription>{dataError}</AlertDescription></Alert>}
    {actionError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时管理未完成</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
    {message && <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertTitle>操作已提交</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
    <section className="live-metric-group" aria-labelledby="server-runtime-title">
      <div className="live-metric-group-heading"><h3 id="server-runtime-title">服务器运行</h3><span>进程与在线状态</span></div>
      <div className="metric-grid live-status-grid" aria-label="实时服务器状态">
        <article><span>服务器状态</span><strong>{shell ? serverStateLabel(shell.serverState) : "读取中"}</strong><small>{shell ? `检测于 ${new Date(shell.observedAt * 1_000).toLocaleTimeString("zh-CN")}` : "正在读取服务器状态"}</small></article>
        <article><span>在线玩家</span><strong>{snapshot ? players.length : "读取中"}</strong><small>{sourceLabel(snapshot?.players)}</small></article>
        <UptimeMetric state={shell?.serverState} startedAt={process?.startedAt} />
        <article><span>服务器帧率</span><strong>{displayValue(snapshot?.metrics.data.server, ["serverfps", "serverFps", "ServerFPS", "fps"])}</strong><small>{sourceLabel(snapshot?.metrics)}</small></article>
      </div>
    </section>
    <section className="live-metric-group" aria-labelledby="world-runtime-title">
      <div className="live-metric-group-heading"><h3 id="world-runtime-title">游戏世界</h3><span>{worldError ? "世界快照暂不可用" : "存档数据只读 · 在线玩家来自实时接口"}</span></div>
      <div className="metric-grid live-status-grid world-status-grid" aria-label="游戏世界状态">
        <WorldTimeMetric status={worldStatus} error={worldError} />
        <article><span>在线玩家</span><strong>{onlinePlayers.value}</strong><small>{onlinePlayers.detail}</small></article>
        <article><span>玩家 / 公会</span><strong>{worldCountsText(worldStatus, "players", "guilds")}</strong><small>存档实体数量</small></article>
        <article><span>帕鲁 / 据点</span><strong>{worldCountsText(worldStatus, "pals", "bases")}</strong><small>存档实体数量</small></article>
      </div>
    </section>
    <section className="live-metric-group" aria-labelledby="host-runtime-title">
      <div className="live-metric-group-heading"><h3 id="host-runtime-title">主机性能</h3><span>PalServer 进程树</span></div>
      <div className="metric-grid live-status-grid" aria-label="主机性能状态">
        <article><span>CPU 使用率</span><strong>{processCpuText(process)}</strong><small>{process?.cpuReady === false ? "首次采样后显示实时值" : "PalServer 进程树的整机占比"}</small></article>
        <article><span>内存使用</span><strong>{processMemoryText(process)}</strong><small>{process?.pids.length ? "PalServer 进程树内存" : "未检测到 PalServer 进程"}</small></article>
        <article><span>磁盘读取</span><strong>{processRateText(process, process?.diskReadBytesPerSecond)}</strong><small>{process?.ioReady === false ? "正在建立速率基线" : "PalServer 进程树读取速度"}</small></article>
        <article><span>磁盘写入</span><strong>{processRateText(process, process?.diskWriteBytesPerSecond)}</strong><small>{process?.ioReady === false ? "正在建立速率基线" : "PalServer 进程树写入速度"}</small></article>
      </div>
    </section>
    <section className="live-info-row" aria-label="服务器附加信息">
      <span><small>服务器</small><strong>{displayValue(snapshot?.info.data, ["servername", "serverName", "ServerName"])}</strong></span>
      <span><small>版本</small><strong>{displayValue(snapshot?.info.data, ["version", "Version"])}</strong></span>
    </section>
    <section className="live-section">
      <div className="section-heading"><div><h2>在线玩家</h2><p>{sourceLabel(snapshot?.players)}。完整 IP 按管理需求显示。</p></div><Users size={22} /></div>
      {playerState === "loading" || playerState === "error" ? <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><RefreshCw aria-hidden="true" /></EmptyMedia><EmptyTitle>{playerState === "error" ? "在线玩家数据不可用" : "正在读取在线玩家"}</EmptyTitle><EmptyDescription>{playerState === "error" ? "请先检查上方错误信息，然后重新刷新。" : "连接完成后会显示当前在线玩家。"}</EmptyDescription></EmptyHeader></Empty> : playerState === "ready" ? <><div className="psc-player-table-wrap"><Table className="psc-player-table"><TableHeader><TableRow><TableHead>玩家</TableHead><TableHead>Player ID</TableHead><TableHead>IP</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>{players.map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        return <TableRow key={`${id}-${index}`}><TableCell>{playerText(player, ["name", "playerName", "accountName"], "未知玩家")}</TableCell><TableCell>{id}</TableCell><TableCell>{playerText(player, ["ip", "ipAddress"], "不可用")}</TableCell><TableCell><span className="psc-player-actions"><Button variant="outline" size="icon" type="button" title="踢出玩家" aria-label={`踢出玩家 ${id}`} disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX aria-hidden="true" /></Button><Button variant="destructive" size="icon" type="button" title="封禁玩家" aria-label={`封禁玩家 ${id}`} disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop aria-hidden="true" /></Button></span></TableCell></TableRow>;
      })}</TableBody></Table></div><div className="psc-player-list">{players.map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        return <article className="psc-player-card" key={`mobile-${id}-${index}`}><div><strong>{playerText(player, ["name", "playerName", "accountName"], "未知玩家")}</strong><small>在线玩家</small></div><dl><div><dt>Player ID</dt><dd>{id}</dd></div><div><dt>IP</dt><dd>{playerText(player, ["ip", "ipAddress"], "不可用")}</dd></div></dl><div className="psc-player-card-actions"><Button variant="outline" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX data-icon="inline-start" aria-hidden="true" />踢出</Button><Button variant="destructive" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop data-icon="inline-start" aria-hidden="true" />封禁</Button></div></article>;
      })}</div></> : <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><Users aria-hidden="true" /></EmptyMedia><EmptyTitle>当前没有在线玩家</EmptyTitle><EmptyDescription>连接正常后，新加入的玩家会显示在这里。</EmptyDescription></EmptyHeader></Empty>}
    </section>
    <section className="live-actions psc-live-actions">
      <FieldGroup className="psc-live-action-grid">
        <form onSubmit={(event) => { event.preventDefault(); if (announcement.trim()) void action("/api/live/announce", { message: announcement.trim() }); }}><Field><FieldLabel htmlFor="announcement">服务器公告</FieldLabel><div className="psc-field-action"><Input id="announcement" maxLength={500} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="输入公告内容" /><Button disabled={busy || !announcement.trim()} type="submit"><Send data-icon="inline-start" aria-hidden="true" />发送</Button></div></Field></form>
        <form onSubmit={(event) => { event.preventDefault(); if (unbanId.trim()) void action(`/api/live/players/${encodeURIComponent(unbanId.trim())}/unban`); }}><Field><FieldLabel htmlFor="unban-id">解除封禁 User ID</FieldLabel><div className="psc-field-action"><Input id="unban-id" maxLength={256} value={unbanId} onChange={(event) => setUnbanId(event.target.value)} placeholder="输入 User ID" /><Button variant="outline" disabled={busy || !unbanId.trim()} type="submit">解除封禁</Button></div></Field></form>
      </FieldGroup>
    </section>
    <ConfirmActionDialog
      open={pendingPlayerAction !== null}
      title={pendingPlayerAction?.kind === "ban" ? "封禁此玩家？" : "踢出此玩家？"}
      description={pendingPlayerAction ? `${pendingPlayerAction.kind === "ban" ? "将封禁" : "将踢出"} Player ID ${pendingPlayerAction.id}。${pendingPlayerAction.kind === "ban" ? "之后可用 User ID 解除封禁。" : "该玩家之后仍可重新加入。"}` : "请确认玩家操作。"}
      confirmLabel={pendingPlayerAction?.kind === "ban" ? "确认封禁" : "确认踢出"}
      destructive={pendingPlayerAction?.kind === "ban"}
      disabled={busy}
      onOpenChange={(open) => { if (!open) setPendingPlayerAction(null); }}
      onConfirm={() => {
        if (!pendingPlayerAction) return;
        const { kind, id } = pendingPlayerAction;
        void action(`/api/live/players/${encodeURIComponent(id)}/${kind}`, { message: kind === "ban" ? "管理员已封禁此账号。" : "管理员已将你踢出服务器。" });
      }}
    />
  </div>;
}

function UptimeMetric({ state, startedAt }: { state?: ShellStatus["serverState"]; startedAt?: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <article><span>本次启动时长</span><strong>{uptimeText(state, startedAt, now)}</strong><small>{state === "running" && startedAt ? `自 ${new Date(startedAt * 1_000).toLocaleString("zh-CN")}` : state === "running" ? "进程启动时间不可用" : "服务器停止时不计时"}</small></article>;
}

function WorldTimeMetric({ status, error }: { status: WorldStatus | null; error: string }) {
  const formatted = formatWorldGameTime(status?.gameTimeTicks);
  return <article><span>世界累计游戏时间</span><strong>{formatted.value}</strong><small>{formatted.detail || error || (status ? "存档未提供游戏时钟" : "正在读取世界时间")}</small></article>;
}

function formatWorldGameTime(ticks: number | null | undefined): { value: string; detail: string } {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return { value: "不可用", detail: "" };
  const ticksPerDay = 864_000_000_000;
  const ticksPerHour = 36_000_000_000;
  const ticksPerMinute = 600_000_000;
  const days = Math.floor(ticks / ticksPerDay);
  const remainder = ticks % ticksPerDay;
  const hours = Math.floor(remainder / ticksPerHour);
  const minutes = Math.floor(remainder % ticksPerHour / ticksPerMinute);
  return {
    value: `${days} 天 ${hours} 小时`,
    detail: `存档游戏时钟 · 第 ${days} 天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
  };
}

function worldCountsText(
  status: WorldStatus | null,
  left: keyof WorldStatus["counts"],
  right: keyof WorldStatus["counts"],
): string {
  if (!status) return "读取中";
  return `${status.counts[left] ?? "-"} / ${status.counts[right] ?? "-"}`;
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
