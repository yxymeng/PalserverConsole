import { Activity, AlertTriangle, CheckCircle2, CircleStop, Compass, Cpu, Gamepad2, Globe, History, LogIn, LogOut, MessageCircle, Radio, RefreshCw, ShieldBan, UserRoundX, Users, Wifi } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuditItem, AuditResponse, AuthStatus, BannedPlayer, BanListResponse, LiveSnapshot, LiveValue, ProcessMetrics, WorldEntityListResponse, WorldPlayerListItem, WorldStatus } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { ConfirmActionDialog } from "../../components/ConfirmActionDialog";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../components/ui/empty";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../../components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { useLiveEvents } from "../../hooks/useLiveEvents";
import { formatBytes, playerId, playerText } from "../../utils/format";
import { gameActivityPresentation, gameActivityTime, isGameActivity, playerDataState, playerLevelText, playerPingPresentation, playerSyncPresentation, processMemoryPercent, serverFrameSummary, worldPlayerId, worldStatusAfterResponse } from "./livePresentation";
import { PlayerExplorationDialog, type PlayerExplorationState } from "./PlayerExplorationDialog";

export function LiveMonitoring({
  auth,
  embedded = false,
  onSnapshot,
}: {
  auth: AuthStatus;
  embedded?: boolean;
  onSnapshot?: (snapshot: LiveSnapshot) => void;
}) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [worldStatus, setWorldStatus] = useState<WorldStatus | null>(null);
  const [worldError, setWorldError] = useState("");
  const [message, setMessage] = useState("");
  const [dataError, setDataError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPlayerAction, setPendingPlayerAction] = useState<{ kind: "kick" | "ban"; id: string } | null>(null);
  const [banSheetOpen, setBanSheetOpen] = useState(false);
  const [bannedPlayers, setBannedPlayers] = useState<BannedPlayer[] | null>(null);
  const [banListError, setBanListError] = useState("");
  const [pendingUnbanId, setPendingUnbanId] = useState<string | null>(null);
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

  async function action(path: string, body?: object): Promise<boolean> {
    setBusy(true); setActionError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>(path, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(body || {}),
      });
      setMessage(result.message);
      void refresh();
      return true;
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "管理操作失败");
      return false;
    } finally { setBusy(false); }
  }

  const loadBanList = useCallback(async () => {
    setBannedPlayers(null);
    setBanListError("");
    try {
      const response = await requestJson<BanListResponse>("/api/live/bans");
      setBannedPlayers(response.items);
    } catch (caught) {
      setBanListError(caught instanceof Error ? caught.message : "封禁名单读取失败");
    }
  }, []);

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
  const playerSync = playerSyncPresentation(snapshot?.players);
  const frameSummary = serverFrameSummary(snapshot?.metrics.data.server);
  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    <section className="section-heading live-monitoring-heading"><div><h2>实时状态</h2></div></section>
    {dataError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时数据不可用</AlertTitle><AlertDescription>{dataError}</AlertDescription></Alert>}
    {actionError && <Alert variant="destructive"><AlertTriangle aria-hidden="true" /><AlertTitle>实时管理未完成</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
    {message && <Alert variant="success" role="status"><CheckCircle2 aria-hidden="true" /><AlertTitle>操作已提交</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>}
    <section className="live-metric-group" aria-label="服务器运行指标">
      <div className="metric-grid live-status-grid" role="group" aria-label="实时服务器状态">
        <StatusMetric icon={Activity} tone="lagoon" label="服务器帧率" value={frameSummary.value} detail="PalServer 实时采样" />
        <MemoryMetric process={process} />
        <WorldTimeMetric status={worldStatus} error={worldError} />
        <WorldEcologyMetric status={worldStatus} error={worldError} />
      </div>
    </section>
    <div className="psc-home-player-grid">
    <section className="live-section psc-online-players" aria-labelledby="online-players-title">
      <div className="psc-player-panel-heading">
        <div className="psc-player-panel-title">
          <span className="psc-player-panel-icon"><Users aria-hidden="true" /></span>
          <div>
            <h2 id="online-players-title">在线训练家 <span>({players?.length ?? 0})</span></h2>
            <p>等级与延迟实时同步，探索档案来自只读存档</p>
          </div>
        </div>
        <div className="psc-player-heading-actions">
          <span className="psc-player-sync" data-state={playerSync.state}><Radio aria-hidden="true" />{playerSync.label}</span>
          <Button className="psc-ban-list-trigger" variant="outline" size="icon-sm" type="button" aria-label="封禁名单" title="封禁名单" onClick={() => { setBanSheetOpen(true); void loadBanList(); }}><ShieldBan aria-hidden="true" /></Button>
        </div>
      </div>
      {playerState === "loading" || playerState === "error" ? <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><RefreshCw aria-hidden="true" /></EmptyMedia><EmptyTitle>{playerState === "error" ? "在线训练家数据不可用" : "正在读取在线训练家"}</EmptyTitle><EmptyDescription>{playerState === "error" ? "请先检查上方错误信息，然后重新刷新。" : "连接完成后会显示当前在线训练家。"}</EmptyDescription></EmptyHeader></Empty> : playerState === "ready" ? <><div className="psc-player-table-wrap"><Table className="psc-player-table"><TableHeader><TableRow><TableHead>玩家名称</TableHead><TableHead>等级</TableHead><TableHead>存档关联</TableHead><TableHead>延迟 (PING)</TableHead><TableHead className="psc-player-action-heading">快捷操作</TableHead></TableRow></TableHeader><TableBody>{(players ?? []).map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        const savePlayerId = worldPlayerId(player);
        const ping = playerPingPresentation(player, snapshot?.players.source);
        const name = playerText(player, ["name", "playerName", "accountName"], "未知训练家");
        return <TableRow key={`desktop-${id}-${index}`}>
          <TableCell><span className="psc-player-identity"><span className="psc-player-online-dot" aria-hidden="true" /><strong>{name}</strong></span></TableCell>
          <TableCell><span className="psc-player-level">{playerLevelText(player)}</span></TableCell>
          <TableCell><span className="psc-player-archive-state" data-available={Boolean(savePlayerId)}><Compass aria-hidden="true" />{savePlayerId ? "已关联" : "不可用"}</span></TableCell>
          <TableCell><span className="psc-player-ping" data-tone={ping.tone}><Wifi aria-hidden="true" />{ping.value}</span></TableCell>
          <TableCell><span className="psc-player-actions"><Button className="psc-player-exploration-trigger" variant="ghost" size="sm" type="button" disabled={!savePlayerId} title={savePlayerId ? `查看 ${name} 的探索档案` : "实时数据未提供可关联存档的 Player ID"} onClick={() => void loadExploration(savePlayerId, name)}><Compass aria-hidden="true" />档案</Button><Button className="psc-player-kick" variant="outline" size="sm" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX aria-hidden="true" />移出</Button><Button variant="destructive" size="sm" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop aria-hidden="true" />封禁</Button></span></TableCell>
        </TableRow>;
      })}</TableBody></Table></div><div className="psc-player-list">{(players ?? []).map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        const savePlayerId = worldPlayerId(player);
        const ping = playerPingPresentation(player, snapshot?.players.source);
        const name = playerText(player, ["name", "playerName", "accountName"], "未知训练家");
        return <article className="psc-player-card" key={`${id}-${index}`}>
          <div className="psc-player-card-heading">
            <div className="psc-player-profile">
              <span className="psc-player-avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
              <div>
                <span className="psc-player-name-row"><strong>{name}</strong><span className="psc-player-level">{playerLevelText(player)}</span></span>
                <span className="psc-player-ping" data-tone={ping.tone}><Wifi aria-hidden="true" />{ping.value}</span>
              </div>
            </div>
            <span className="psc-player-card-live">在线</span>
          </div>
          <div className="psc-player-adventure">
            <div><Compass aria-hidden="true" /><strong>海岛探险档案</strong><span>只读快照</span></div>
            <p>查看帕鲁图鉴、传送点、高塔与地下城等真实存档进度。</p>
            <Button className="psc-player-exploration-trigger" variant="ghost" type="button" disabled={!savePlayerId} title={savePlayerId ? `查看 ${name} 的探索进度` : "实时数据未提供可关联存档的 Player ID"} onClick={() => void loadExploration(savePlayerId, name)}><Compass data-icon="inline-start" aria-hidden="true" />查看探索进度</Button>
          </div>
          <dl><div><dt>Player ID</dt><dd>{id}</dd></div></dl>
          <div className="psc-player-card-actions"><Button variant="outline" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "kick", id })}><UserRoundX data-icon="inline-start" aria-hidden="true" />移出服务器</Button><Button variant="destructive" type="button" disabled={busy || id.startsWith("unknown-")} onClick={() => setPendingPlayerAction({ kind: "ban", id })}><CircleStop data-icon="inline-start" aria-hidden="true" />封禁</Button></div>
        </article>;
      })}</div></> : <Empty className="psc-empty"><EmptyHeader><EmptyMedia variant="icon"><Users aria-hidden="true" /></EmptyMedia><EmptyTitle>当前没有在线训练家</EmptyTitle><EmptyDescription>连接正常后，新加入的训练家会显示在这里。</EmptyDescription></EmptyHeader></Empty>}
    </section>
    <GameActivityCard />
    </div>
    <Sheet open={banSheetOpen} onOpenChange={setBanSheetOpen}>
      <SheetContent className="psc-ban-sheet" side="right">
        <SheetHeader>
          <SheetTitle>封禁名单</SheetTitle>
          <SheetDescription>读取 PalServer 当前封禁记录，可按 User ID 逐项解除。</SheetDescription>
        </SheetHeader>
        <div className="psc-ban-list" aria-live="polite">
          {banListError ? <div className="psc-ban-state" role="alert"><AlertTriangle aria-hidden="true" /><strong>封禁名单暂不可用</strong><p>{banListError}</p><Button variant="outline" size="sm" type="button" onClick={() => void loadBanList()}><RefreshCw aria-hidden="true" />重试</Button></div>
            : bannedPlayers === null ? <div className="psc-ban-state" role="status"><RefreshCw className="psc-activity-loading" aria-hidden="true" /><strong>正在读取封禁名单</strong></div>
              : bannedPlayers.length ? bannedPlayers.map(({ userId }) => <article className="psc-ban-item" key={userId}><div><span>User ID</span><strong>{userId}</strong></div><Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => setPendingUnbanId(userId)}>解除封禁</Button></article>)
                : <div className="psc-ban-state"><ShieldBan aria-hidden="true" /><strong>当前没有封禁记录</strong><p>新的封禁记录会在这里显示。</p></div>}
        </div>
        <SheetFooter><Button variant="outline" type="button" disabled={busy || bannedPlayers === null} onClick={() => void loadBanList()}><RefreshCw aria-hidden="true" />刷新名单</Button></SheetFooter>
      </SheetContent>
    </Sheet>
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
    <ConfirmActionDialog
      open={pendingUnbanId !== null}
      title="解除此 User ID 的封禁？"
      description={pendingUnbanId ? `将允许 User ID ${pendingUnbanId} 再次加入服务器。` : "请确认解除封禁操作。"}
      confirmLabel="确认解除"
      disabled={busy}
      onOpenChange={(open) => { if (!open) setPendingUnbanId(null); }}
      onConfirm={() => {
        if (!pendingUnbanId) return;
        const userId = pendingUnbanId;
        void action(`/api/live/players/${encodeURIComponent(userId)}/unban`).then((succeeded) => { if (succeeded) void loadBanList(); });
      }}
    />
    <PlayerExplorationDialog
      state={exploration}
      onClose={() => { explorationSequence.current += 1; setExploration(null); }}
      onRetry={() => { if (exploration) void loadExploration(exploration.playerId, exploration.playerName); }}
    />
  </div>;
}

function GameActivityCard() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [chatSupported, setChatSupported] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const [events, capabilities] = await Promise.all([
        requestJson<AuditResponse>("/api/audit?page=1&pageSize=50", { signal }),
        requestJson<{ chatSupported: boolean }>("/api/audit/capabilities", { signal }),
      ]);
      setItems(events.items.filter(isGameActivity).slice(0, 5));
      setChatSupported(capabilities.chatSupported);
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "游戏内动态读取失败");
    }
  }, [nextRequestSignal]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  return <section className="psc-game-activity" aria-labelledby="game-activity-title">
    <div className="psc-player-panel-heading">
      <div className="psc-player-panel-title">
        <span className="psc-player-panel-icon"><Gamepad2 aria-hidden="true" /></span>
        <div><h2 id="game-activity-title">游戏内动态</h2><p>训练家进出与聊天消息</p></div>
      </div>
      <span className="psc-activity-sync"><Radio aria-hidden="true" />自动刷新</span>
    </div>
    <div className="psc-activity-feed" aria-live="polite">
      {error ? <div className="psc-activity-state" role="alert"><AlertTriangle aria-hidden="true" /><strong>动态暂不可用</strong><p>{error}</p><Button variant="outline" size="sm" type="button" onClick={() => void load()}><RefreshCw aria-hidden="true" />重试</Button></div>
        : items === null ? <div className="psc-activity-state" role="status"><RefreshCw className="psc-activity-loading" aria-hidden="true" /><strong>正在读取游戏动态</strong></div>
          : items.length ? items.map((item) => <GameActivityItem key={item.id} item={item} />)
            : <div className="psc-activity-state"><Gamepad2 aria-hidden="true" /><strong>暂无最近动态</strong><p>训练家进入、退出或发言后会显示在这里。</p></div>}
    </div>
    <footer className="psc-activity-capability">
      <span aria-hidden="true" />
      {chatSupported === false ? "玩家进出可用；当前日志源尚未识别聊天事件" : chatSupported ? "玩家进出与聊天事件已接入" : "正在确认日志事件能力"}
    </footer>
  </section>;
}

function GameActivityItem({ item }: { item: AuditItem }) {
  const content = gameActivityPresentation(item);
  const Icon = item.eventType === "chat.message" ? MessageCircle : item.eventType === "player.joined" ? LogIn : LogOut;
  return <article className="psc-activity-item" data-kind={item.eventType}>
    <span className="psc-activity-icon" aria-hidden="true"><Icon /></span>
    <div><strong>{content.title}</strong><p>{content.detail}</p></div>
    <time dateTime={new Date(item.createdAt * 1_000).toISOString()}>{gameActivityTime(item.createdAt)}</time>
  </article>;
}

function StatusMetric({ icon: Icon, tone, label, value, detail }: { icon: LucideIcon; tone: "lagoon" | "sky"; label: string; value: string; detail: string }) {
  return <article className="psc-status-metric" data-tone={tone}>
    <div className="psc-status-metric-heading"><span>{label}</span><span className="psc-status-metric-icon" aria-hidden="true"><Icon /></span></div>
    <strong>{value}</strong>
    <div className="psc-status-metric-detail"><small>{detail}</small></div>
  </article>;
}

function WorldTimeMetric({ status, error }: { status: WorldStatus | null; error: string }) {
  const value = formatWorldGameTime(status?.gameTimeTicks);
  const detail = value === "不可用" ? error || (status ? "存档未提供游戏时钟" : "正在读取世界时间") : "来自只读存档快照";
  return <StatusMetric icon={History} tone="sky" label="世界累计游戏时间" value={value} detail={detail} />;
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

function MemoryMetric({ process }: { process?: ProcessMetrics }) {
  const progress = processMemoryPercent(process);
  return <article className="psc-status-metric psc-memory-metric" data-tone="sunshine">
    <div className="psc-status-metric-heading"><span>内存占用负载</span><span className="psc-status-metric-icon" aria-hidden="true"><Cpu /></span></div>
    <strong>{processMemoryText(process)}</strong>
    <div className="psc-status-metric-detail"><small>{processMemoryDetail(process)}</small>{progress !== null && <div className="psc-memory-track" role="progressbar" aria-label="PalServer 内存占主机总内存比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>}</div>
  </article>;
}

function WorldEcologyMetric({ status, error }: { status: WorldStatus | null; error: string }) {
  const count = (key: keyof WorldStatus["counts"]) => status ? String(status.counts[key] ?? "-") : "—";
  return <article className="psc-status-metric psc-world-ecology-metric" data-tone="ocean">
    <div className="psc-status-metric-heading"><span>世界生态图鉴</span><span className="psc-status-metric-icon" aria-hidden="true"><Globe /></span></div>
    <strong>{status ? `${count("pals")} 只帕鲁` : "读取中"}</strong>
    <div className="psc-status-metric-detail"><small>{error ? "世界快照暂不可用" : status ? `${count("players")} 训练家 · ${count("bases")} 据点 · ${count("guilds")} 公会（只读快照）` : "正在读取只读世界快照"}</small></div>
  </article>;
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
