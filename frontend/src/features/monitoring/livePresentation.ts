import type { LiveSnapshot } from "../../api/contracts";
import type { LiveConnectionStatus } from "../../hooks/useLiveEvents";

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

export function playerDataState(snapshot: LiveSnapshot | null, error: string, playerCount: number): "loading" | "error" | "empty" | "ready" {
  if (!snapshot) return error ? "error" : "loading";
  return playerCount ? "ready" : "empty";
}
