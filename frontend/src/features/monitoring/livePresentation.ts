import type { LiveSnapshot, WorldStatus } from "../../api/contracts";
import type { LiveConnectionStatus } from "../../hooks/useLiveEvents";
import { playerText } from "../../utils/format";

export type PlayerDataState = "loading" | "error" | "empty" | "ready";

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

export function playerDataState(snapshot: LiveSnapshot | null, error: string, playerCount: number): PlayerDataState {
  if (!snapshot) return error ? "error" : "loading";
  if (error || snapshot.players?.errorCode) return "error";
  return playerCount ? "ready" : "empty";
}

export function onlinePlayersSummary(
  players: readonly Record<string, unknown>[],
  state: PlayerDataState,
  stale = false,
): { value: string; detail: string } {
  if (state === "loading") return { value: "读取中", detail: "正在读取在线玩家" };
  if (state === "error") return { value: "—", detail: "在线数据不可用" };
  if (state === "empty") return { value: "0 人", detail: stale ? "上次在线：当前无人在线" : "当前无人在线" };

  const names = players.map((player) => playerText(player, ["name", "playerName", "accountName"], "未知玩家"));
  const visibleNames = names.slice(0, 3).join("、");
  const detail = names.length > 3 ? `${visibleNames} 等 ${names.length} 人` : visibleNames;
  return { value: `${players.length} 人`, detail: stale ? `上次在线：${detail}` : detail };
}

export function worldStatusAfterResponse(status: WorldStatus | null, error: string): WorldStatus | null {
  return error ? null : status;
}
