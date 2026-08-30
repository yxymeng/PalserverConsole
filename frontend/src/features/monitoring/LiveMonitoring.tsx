import { AlertTriangle, CheckCircle2, CircleStop, Clock3, Compass, Gauge, History, Radio, RefreshCw, Send, UserRoundX, Users, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthStatus, LiveSnapshot, LiveValue, ProcessMetrics, ShellStatus, WorldEntityListResponse, WorldPlayerListItem, WorldStatus } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { useLiveEvents } from "../../hooks/useLiveEvents";
import { formatByteRate, formatBytes, formatPercent, playerId, playerText } from "../../utils/format";
import { onlinePlayersSummary, playerDataState, playerLevelText, playerPingPresentation, playerSyncPresentation, processMemoryPercent, serverFrameSummary, worldPlayerId, worldStatusAfterResponse } from "./livePresentation";
import { PlayerExplorationDialog, type PlayerExplorationState } from "./PlayerExplorationDialog";

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
  const [exploration, setExploration] = useState<PlayerExplorationState | null>(null);
  const explorationSequence = useRef(0);
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
  useLiveEvents(
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

  const loadExploration = useCallback(async (playerId: string, playerName: string) => {
    const sequence = ++explorationSequence.current;
    setExploration({ playerId, playerName, status: "loading", detail: null, error: "" });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const status = await requestJson<WorldStatus>("/api/world/snapshots/current");
        if (!status.snapshotId) throw new Error("当前没有可用的世界存档快照，请先在“世界”页面完成只读解析。");
        try {
          const query = new URLSearchParams({ page: "1", pageSize: "200", sort: "id", snapshotId: status.snapshotId });
          const response = await requestJson<WorldEntityListResponse>(`/api/world/players?${query}`);
          const detail = response.items.find((item): item is WorldPlayerListItem => "progress" in item && (sameStablePlayerId(item.id, playerId) || sameStablePlayerId(item.instanceId, playerId)));
          if (!detail) throw new ApiRequestError("PLAYER_NOT_FOUND", "在线训练家的 Player ID 未在当前存档快照中找到。可能是玩家刚加入，而存档尚未记录。", true);
          if (sequence === explorationSequence.current) setExploration({ playerId, playerName, status: "ready", detail, error: "" });
          return;
        } catch (caught) {
          if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED" && attempt === 0) continue;
          throw caught;
        }
      }
    } catch (caught) {
      if (sequence !== explorationSequence.current) return;
      setExploration({
        playerId,
        playerName,
        status: "error",
        detail: null,
        error: caught instanceof Error ? caught.message : "玩家探索进度读取失败。",
      });
    }
  }, []);

  const players = playersFrom(snapshot?.players.data);
  const playerState = playerDataState(snapshot, dataError, players?.length ?? null);
  const process = snapshot?.metrics.data.process;
  const playerSummary = onlinePlayersSummary(players ?? [], playerState, snapshot?.players.stale);
  const playerSync = playerSyncPresentation(snapshot?.players);
  const frameSummary = serverFrameSummary(snapshot?.metrics.data.server);
  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    <section className="section-heading live-monitoring-heading"><div><h2>实时状态</h2></div></section>
    {dataError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时数据不可用</AlertTitle><AlertDescription>{dataError}</AlertDescription></Alert>}
    {actionError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时管理未完成</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
    {message && <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertTitle>操作已提交</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
    <section className="live-metric-group" aria-label="服务器运行指标">
      <div className="metric-grid live-status-grid" role="group" aria-label="实时服务器状态">
        <StatusMetric icon={Users} label="在线训练家" value={playerSummary.value} detail={playerSummary.detail} />
        <UptimeMetric state={shell?.serverState} startedAt={process?.startedAt} />
        <StatusMetric icon={Gauge} label="服务器帧率" value={frameSummary.value} detail="PalServer 实时采样" />
        <WorldTimeMetric status={worldStatus} error={worldError} />
      </div>
    </section>
    <div className="psc-home-detail-grid">
      <section className="live-metric-group psc-home-host-card" aria-labelledby="host-runtime-title">
        <div className="live-metric-group-heading"><div><h3 id="host-runtime-title">主机性能</h3><span>PalServer 进程占用</span></div></div>
        <div className="psc-host-resource-stack" role="group" aria-label="CPU 与内存状态">
          <HostResourceRow
            label="CPU"
            value={processCpuText(process)}
            progress={process?.pids.length && process.cpuReady !== false ? Math.min(100, Math.max(0, process.cpuPercent)) : null}
            detail={process?.cpuReady === false ? "首次采样后显示实时值" : ""}
          />
          <HostResourceRow
            label="内存"
            value={processMemoryText(process)}
            progress={processMemoryPercent(process)}
            detail={processMemoryDetail(process)}
          />
        </div>
        <div className="psc-host-io-grid" role="group" aria-label="磁盘读写状态">
          <article><span>磁盘读取</span><strong>{processRateText(process, process?.diskReadBytesPerSecond)}</strong>{process?.ioReady === false && <small>正在建立速率基线</small>}</article>
          <article><span>磁盘写入</span><strong>{processRateText(process, process?.diskWriteBytesPerSecond)}</strong>{process?.ioReady === false && <small>正在建立速率基线</small>}</article>
        </div>
      </section>
      <section className="live-metric-group psc-home-world-card" aria-labelledby="world-runtime-title">
        <div className="live-metric-group-heading"><div><h3 id="world-runtime-title">存档规模</h3><span>{worldError ? "世界快照暂不可用" : "只读快照，不代表实时状态"}</span></div></div>
        <div className="metric-grid live-status-grid world-status-grid" role="group" aria-label="存档规模">
          <article><strong>{worldCountText(worldStatus, "players")}</strong><span>玩家</span></article>
          <article><strong>{worldCountText(worldStatus, "pals")}</strong><span>帕鲁</span></article>
          <article><strong>{worldCountText(worldStatus, "guilds")}</strong><span>公会</span></article>
          <article><strong>{worldCountText(worldStatus, "bases")}</strong><span>据点</span></article>
        </div>
      </section>
    </div>
    <section className="live-section psc-online-players" aria-labelledby="online-players-title">
      <header className="psc-player-panel-heading">
        <div className="psc-player-panel-title">
          <span className="psc-player-panel-icon"><Users aria-hidden="true" /></span>
          <div><h2 id="online-players-title">在线训练家 <span>({players?.length ?? 0})</span></h2></div>
        </div>
        <span className="psc-player-sync" data-state={playerSync.state}><Radio aria-hidden="true" />{playerSync.label}</span>
      </header>
      {playerState === "loading" || playerState === "error" ? <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><RefreshCw aria-hidden="true" /></EmptyMedia><EmptyTitle>{playerState === "error" ? "在线训练家数据不可用" : "正在读取在线训练家"}</EmptyTitle><EmptyDescription>{playerState === "error" ? "请先检查上方错误信息，然后重新刷新。" : "连接完成后会显示当前在线训练家。"}</EmptyDescription></EmptyHeader></Empty> : playerState === "ready" ? <><div className="psc-player-table-wrap"><Table className="psc-player-table"><TableHeader><TableRow><TableHead>训练家</TableHead><TableHead>等级</TableHead><TableHead>连接地址</TableHead><TableHead>延迟 (Ping)</TableHead><TableHead>探索度</TableHead><TableHead className="psc-player-action-heading">快捷操作</TableHead></TableRow></TableHeader><TableBody>{(players ?? []).map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        const savePlayerId = worldPlayerId(player);
        const ping = playerPingPresentation(player, snapshot?.players.source);
        const name = playerText(player, ["name", "playerName", "accountName"], "未知训练家");
        return <TableRow key={`${id}-${index}`}><TableCell><span className="psc-player-identity"><span className="psc-player-online-dot" aria-hidden="true" /><span><strong>{name}</strong><small>{id}</small></span></span></TableCell><TableCell><span className="psc-player-level">{playerLevelText(player)}</span></TableCell><TableCell><span className="psc-player-ip">{playerText(player, ["ip", "ipAddress"], "不可用")}</span></TableCell><TableCell><span className="psc-player-ping" data-tone={ping.tone}><Wifi aria-hidden="true" />{ping.value}</span></TableCell><TableCell><Button className="psc-player-exploration-trigger" variant="ghost" size="sm" type="button" disabled={!savePlayerId} title={savePlayerId ? `查看 ${name} 的探索进度` : "实时数据未提供可关联存档的 Player ID"} onClick={() => void loadExploration(savePlayerId, name)}><Compass aria-hidden="true" />探索进度</Button></TableCell><TableCell><span className="psc-player-actions"><Button variant="outline" size="sm" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX aria-hidden="true" />移出</Button><Button variant="destructive" size="sm" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop aria-hidden="true" />封禁</Button></span></TableCell></TableRow>;
      })}</TableBody></Table></div><div className="psc-player-list">{(players ?? []).map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        const savePlayerId = worldPlayerId(player);
        const ping = playerPingPresentation(player, snapshot?.players.source);
        const name = playerText(player, ["name", "playerName", "accountName"], "未知训练家");
        return <article className="psc-player-card" key={`mobile-${id}-${index}`}><div className="psc-player-card-heading"><span className="psc-player-identity"><span className="psc-player-online-dot" aria-hidden="true" /><strong>{name}</strong></span><span className="psc-player-card-live">在线</span></div><div className="psc-player-card-stats"><span className="psc-player-level">{playerLevelText(player)}</span><span className="psc-player-ping" data-tone={ping.tone}><Wifi aria-hidden="true" />{ping.value}</span></div><dl><div><dt>Player ID</dt><dd>{id}</dd></div><div><dt>连接地址</dt><dd>{playerText(player, ["ip", "ipAddress"], "不可用")}</dd></div></dl><Button className="psc-player-exploration-trigger" variant="ghost" type="button" disabled={!savePlayerId} title={savePlayerId ? `查看 ${name} 的探索进度` : "实时数据未提供可关联存档的 Player ID"} onClick={() => void loadExploration(savePlayerId, name)}><Compass data-icon="inline-start" aria-hidden="true" />探索进度</Button><div className="psc-player-card-actions"><Button variant="outline" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX data-icon="inline-start" aria-hidden="true" />移出</Button><Button variant="destructive" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop data-icon="inline-start" aria-hidden="true" />封禁</Button></div></article>;
      })}</div></> : <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><Users aria-hidden="true" /></EmptyMedia><EmptyTitle>当前没有在线训练家</EmptyTitle><EmptyDescription>连接正常后，新加入的训练家会显示在这里。</EmptyDescription></EmptyHeader></Empty>}
      <form className="psc-player-broadcast" onSubmit={(event) => { event.preventDefault(); if (announcement.trim()) void action("/api/live/announce", { message: announcement.trim() }); }}><Input aria-label="服务器公告" maxLength={500} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="输入全服广播消息，例如：10 分钟后进行服务器维护" /><Button disabled={busy || !announcement.trim()} type="submit"><Send data-icon="inline-start" aria-hidden="true" />发送广播</Button></form>
    </section>
    <section className="live-actions psc-live-actions" aria-label="封禁管理">
      <FieldGroup className="psc-live-action-grid psc-live-action-grid-single">
        <form onSubmit={(event) => { event.preventDefault(); if (unbanId.trim()) void action(`/api/live/players/${encodeURIComponent(unbanId.trim())}/unban`); }}><Field><FieldLabel htmlFor="unban-id">解除封禁 User ID</FieldLabel><div className="psc-field-action"><Input id="unban-id" maxLength={256} value={unbanId} onChange={(event) => setUnbanId(event.target.value)} placeholder="输入 User ID" /><Button variant="outline" disabled={busy || !unbanId.trim()} type="submit">解除封禁</Button></div></Field></form>
      </FieldGroup>
    </section>
    <ConfirmActionDialog
      open={pendingPlayerAction !== null}
      title={pendingPlayerAction?.kind === "ban" ? "封禁此训练家？" : "踢出此训练家？"}
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
    <PlayerExplorationDialog
      state={exploration}
      onClose={() => { explorationSequence.current += 1; setExploration(null); }}
      onRetry={() => { if (exploration) void loadExploration(exploration.playerId, exploration.playerName); }}
    />
  </div>;
}

function UptimeMetric({ state, startedAt }: { state?: ShellStatus["serverState"]; startedAt?: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <StatusMetric icon={Clock3} label="本次启动时长" value={uptimeText(state, startedAt, now)} detail={state === "running" && startedAt ? `自 ${new Date(startedAt * 1_000).toLocaleString("zh-CN")}` : state === "running" ? "进程启动时间不可用" : "服务器停止时不计时"} />;
}

function WorldTimeMetric({ status, error }: { status: WorldStatus | null; error: string }) {
  const formatted = formatWorldGameTime(status?.gameTimeTicks);
  const detail = formatted === "不可用" ? error || (status ? "存档未提供游戏时钟" : "正在读取世界时间") : "来自只读存档快照";
  return <StatusMetric icon={History} label="世界累计游戏时间" value={formatted} detail={detail} />;
}

function StatusMetric({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return <article className="psc-status-metric">
    <div className="psc-status-metric-heading"><span>{label}</span><span className="psc-status-metric-icon" aria-hidden="true"><Icon /></span></div>
    <strong>{value}</strong>
    <small>{detail}</small>
  </article>;
}

function formatWorldGameTime(ticks: number | null | undefined): string {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return "不可用";
  const ticksPerDay = 864_000_000_000;
  const ticksPerHour = 36_000_000_000;
  const ticksPerMinute = 600_000_000;
  const days = Math.floor(ticks / ticksPerDay);
  const remainder = ticks % ticksPerDay;
  const hours = Math.floor(remainder / ticksPerHour);
  const minutes = Math.floor(remainder % ticksPerHour / ticksPerMinute);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

function worldCountText(status: WorldStatus | null, key: keyof WorldStatus["counts"]): string {
  if (!status) return "读取中";
  return String(status.counts[key] ?? "-");
}

function HostResourceRow({ label, value, progress, detail }: { label: string; value: string; progress: number | null; detail: string }) {
  return <div className="psc-host-resource">
    <div><span>{label}</span><strong>{value}</strong></div>
    {progress !== null && <div
      className="psc-host-resource-track"
      role="progressbar"
      aria-label={`${label} 使用率`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    ><span style={{ width: `${progress}%` }} /></div>}
    {detail && <small>{detail}</small>}
  </div>;
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

function processMemoryDetail(process?: ProcessMetrics): string {
  if (!process?.pids.length) return "未检测到 PalServer 进程";
  if (!process.hostMemoryTotalBytes) return "主机内存容量暂不可用";
  const available = process.hostMemoryAvailableBytes;
  return available === undefined
    ? `主机总计 ${formatBytes(process.hostMemoryTotalBytes)}`
    : `主机可用 ${formatBytes(available)} / 总计 ${formatBytes(process.hostMemoryTotalBytes)}`;
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

function playersFrom(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      ? data
      : null;
  }
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return playersFrom((data as Record<string, unknown>).players);
  return null;
}

function sameStablePlayerId(left: string, right: string): boolean {
  return left.replace(/-/g, "").toLowerCase() === right.replace(/-/g, "").toLowerCase();
}
