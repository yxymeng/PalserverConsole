import type { LiveValue } from "../api/contracts";

export function playerText(player: Record<string, unknown>, keys: string[], fallback: string) { return displayValue(player, keys, fallback); }
export function playerId(player: Record<string, unknown>) { return displayValue(player, ["userId", "userid", "playerId", "id"], ""); }
export function displayValue(value: Record<string, unknown> | undefined, keys: string[], fallback = "不可用") {
  if (!value) return fallback;
  const entries = Object.entries(value);
  for (const key of keys) {
    const direct = value[key];
    const item = direct ?? entries.find(([actual]) => actual.toLowerCase() === key.toLowerCase())?.[1];
    if (item !== undefined && item !== null && String(item)) return String(item);
  }
  return fallback;
}
export function formatBytes(value: number | undefined) { if (typeof value !== "number" || !Number.isFinite(value)) return "不可用"; const units = ["B", "KB", "MB", "GB", "TB"]; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`; }
export function formatPercent(value: number | undefined, ready?: boolean) { if (ready === false) return "正在校准"; return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "不可用"; }
export function formatByteRate(value: number | undefined, ready?: boolean) { if (ready === false) return "正在校准"; return typeof value === "number" && Number.isFinite(value) ? `${formatBytes(value)}/秒` : "不可用"; }
export function formatObservedAt(value?: number) { return value ? new Date(value * 1000).toLocaleTimeString("zh-CN") : "尚未采集"; }
export function sourceLabel(value?: LiveValue<unknown>) { if (!value) return "尚未采集"; return value.stale ? "实时数据暂不可用" : "实时数据"; }
export function liveStatus(value?: LiveValue<unknown>) { return value ? `${sourceLabel(value)} · ${formatObservedAt(value.observedAt)}` : "尚未采集"; }
