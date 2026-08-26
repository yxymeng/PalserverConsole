import type { WorldEntityListItem, WorldResource } from "../../api/contracts";
import { palTraitLabels, resolvePal } from "./palCatalog";
import { playerProgressCoverage, playerProgressOf, playerProgressSummary } from "./playerProgress";

export type PrimaryWorldResource = Extract<WorldResource, "players" | "pals" | "guilds" | "bases">;

export function worldColumns(resource: PrimaryWorldResource) {
  const definitions: Record<PrimaryWorldResource, { key: string; label: string }[]> = {
    players: [{ key: "name", label: "玩家" }, { key: "level", label: "等级" }, { key: "guildName", label: "公会" }, { key: "progressOverview", label: "主要进度 / 数据覆盖" }],
    pals: [{ key: "displayName", label: "帕鲁" }, { key: "traits", label: "属性" }, { key: "level", label: "等级" }, { key: "ownerName", label: "主人" }, { key: "baseName", label: "据点" }],
    guilds: [{ key: "name", label: "公会" }, { key: "memberCount", label: "成员" }, { key: "baseCount", label: "据点" }, { key: "id", label: "Guild ID" }],
    bases: [{ key: "name", label: "据点" }, { key: "id", label: "Base ID" }, { key: "guildName", label: "公会" }, { key: "workerContainerId", label: "工作容器" }],
  };
  return definitions[resource];
}

export function worldCell(item: WorldEntityListItem, key: string): string {
  if (key === "progressOverview") {
    if (!("progress" in item)) return "玩家进度不可用";
    const progress = playerProgressOf(item);
    return `${playerProgressSummary(progress)} · ${playerProgressCoverage(progress)}`;
  }
  if (key === "displayName") return "characterId" in item ? resolvePal(item).displayName : "不可用";
  if (key === "traits") return "characterId" in item ? palTraitLabels(item).join(" · ") || "普通" : "不可用";
  if (key === "ownerName") return "ownerPlayerId" in item ? item.ownerName || (item.ownerPlayerId ? "玩家资料不可用" : "未分配") : "不可用";
  if (key === "baseName") return "baseId" in item ? item.baseName || (item.baseId ? "据点资料不可用" : "未分配") : "不可用";
  if (key === "guildName") return "guildId" in item ? item.guildName || (item.guildId ? "公会资料不可用" : "未加入公会") : "不可用";
  if (key === "name") return "name" in item ? item.name : "不可用";
  if (key === "level") return "level" in item && item.level !== null ? String(item.level) : "不可用";
  if (key === "memberCount") return "memberCount" in item ? String(item.memberCount) : "不可用";
  if (key === "baseCount") return "baseCount" in item ? String(item.baseCount) : "不可用";
  if (key === "workerContainerId") return "workerContainerId" in item && item.workerContainerId ? item.workerContainerId : "不可用";
  if (key === "id") return item.id;
  return "不可用";
}

export function formatWorldTime(value?: number): string {
  return value ? new Date(value * 1000).toLocaleString("zh-CN") : "尚无成功结果";
}
