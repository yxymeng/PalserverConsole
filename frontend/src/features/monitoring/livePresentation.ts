import type { AuditItem, LiveSnapshot, LiveValue, ProcessMetrics, WorldStatus } from "../../api/contracts";
import type { LiveConnectionStatus } from "../../hooks/useLiveEvents";
import { playerText } from "../../utils/format";

export type PlayerDataState = "loading" | "error" | "empty" | "ready";
export type PlayerPingTone = "good" | "medium" | "high" | "unavailable";

const GAME_ACTIVITY_TYPES = new Set(["player.joined", "player.left", "chat.message"]);

export function isGameActivity(item: AuditItem): boolean {
  return GAME_ACTIVITY_TYPES.has(item.eventType);
}

export function gameActivityPresentation(item: AuditItem): { title: string; detail: string } {
  const detail = item.detail;
  if (item.eventType === "chat.message") {
    const name = text(detail.name, "未知训练家");
    return { title: `${name} 发言`, detail: text(detail.message, "消息内容不可用") };
  }
  const player = detail.player && typeof detail.player === "object" ? detail.player as Record<string, unknown> : undefined;
  const name = playerText(player || {}, ["name", "playerName", "accountName"], "")
    || text(detail.subject, "") || text(detail.playerId, "未知训练家");
  return {
    title: item.eventType === "player.joined" ? `${name} 进入了服务器` : `${name} 离开了服务器`,
    detail: item.source === "player-diff" ? "来自在线训练家状态变化" : "来自 PalServer 日志",
  };
}

export function gameActivityTime(createdAt: number, now = Date.now() / 1_000): string {
  const seconds = Math.max(0, Math.floor(now - createdAt));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function worldPlayerId(player: Record<string, unknown>): string {
  return playerText(player, ["playerId", "playerUid"], "");
}

export function liveTitleText(snapshot: LiveSnapshot | null, error: string, connectionStatus: LiveConnectionStatus): string {
  if (error) return "实时数据不可用";
  if (!snapshot) return "正在连接实时数据";
  if (snapshot.info.stale) return "实时数据已过期";
  return {
    open: "实时数据正常",
    reconnecting: "实时数据正在重连",
    closed: "实时事件已关闭",
    connecting: "实时事件正在连接",
  }[connectionStatus];
}

export function playerDataState(snapshot: LiveSnapshot | null, error: string, playerCount: number | null): PlayerDataState {
  if (!snapshot) return error ? "error" : "loading";
  if (error || snapshot.players?.errorCode) return "error";
  if (playerCount === null) return "error";
  return playerCount ? "ready" : "empty";
}

export function onlinePlayersSummary(
  players: readonly Record<string, unknown>[],
  state: PlayerDataState,
  stale = false,
): { value: string; detail: string } {
  if (state === "loading") return { value: "读取中", detail: "正在读取在线训练家" };
  if (state === "error") return { value: "—", detail: "在线数据不可用" };
  if (state === "empty") return { value: "0 人", detail: stale ? "上次在线：当前无人在线" : "当前无人在线" };

  const names = players.map((player) => playerText(player, ["name", "playerName", "accountName"], "未知训练家"));
  const visibleNames = names.slice(0, 3).join("、");
  const detail = names.length > 3 ? `${visibleNames} 等 ${names.length} 人` : visibleNames;
  return { value: `${players.length} 人`, detail: stale ? `上次在线：${detail}` : detail };
}

export function playerLevelText(player: Record<string, unknown>): string {
  const level = playerNumber(player, ["level", "playerLevel"]);
  return level !== null && level > 0 ? `Lv.${Math.trunc(level)}` : "不可用";
}

export function playerPingPresentation(
  player: Record<string, unknown>,
  source?: string,
): { value: string; tone: PlayerPingTone } {
  if (source?.toLowerCase() !== "rest") return { value: "不可用", tone: "unavailable" };
  const ping = playerNumber(player, ["ping", "latency"]);
  if (ping === null || ping < 0) return { value: "不可用", tone: "unavailable" };
  const value = `${ping.toLocaleString("zh-CN", { maximumFractionDigits: 1 })} ms`;
  return { value, tone: ping < 50 ? "good" : ping < 100 ? "medium" : "high" };
}

export function playerSyncPresentation(value?: LiveValue<unknown>): { label: string; state: string } {
  if (!value) return { label: "正在连接", state: "loading" };
  if (value.stale || value.errorCode) return { label: "数据不可用", state: "error" };
  if (value.source.toLowerCase() === "rest") return { label: "实时同步", state: "live" };
  if (value.source.toLowerCase() === "rcon") return { label: "RCON 降级", state: "fallback" };
  return { label: "实时数据", state: "live" };
}

export function worldStatusAfterResponse(status: WorldStatus | null, error: string): WorldStatus | null {
  return error ? null : status;
}

export function processMemoryPercent(process?: ProcessMetrics): number | null {
  if (!process?.pids.length || !process.hostMemoryTotalBytes || process.hostMemoryTotalBytes <= 0) return null;
  return Math.min(100, Math.max(0, process.memoryBytes / process.hostMemoryTotalBytes * 100));
}

export function serverFrameSummary(server?: Record<string, unknown>): { value: string } {
  if (!server) return { value: "不可用" };
  const entries = Object.entries(server);
  const keys = ["serverfps", "serverFps", "ServerFPS", "fps"];
  const raw = keys.map((key) => server[key] ?? entries.find(([actual]) => actual.toLowerCase() === key.toLowerCase())?.[1])
    .find((value) => value !== undefined && value !== null && String(value).trim());
  const fps = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(fps) || fps <= 0) return { value: "不可用" };
  const precision = Number.isInteger(fps) ? 0 : 1;
  return { value: `${fps.toFixed(precision)} fps` };
}

function playerNumber(player: Record<string, unknown>, keys: string[]): number | null {
  const entries = Object.entries(player);
  for (const key of keys) {
    const raw = player[key] ?? entries.find(([actual]) => actual.toLowerCase() === key.toLowerCase())?.[1];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
