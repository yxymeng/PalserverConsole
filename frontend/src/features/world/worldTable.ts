import type { WorldResource, WorldRow } from "../../api/contracts";
import { palTraitLabels, resolvePal } from "./palCatalog";

export type PrimaryWorldResource = Extract<WorldResource, "players" | "pals" | "guilds" | "bases">;

export function worldColumns(resource: PrimaryWorldResource) {
  const definitions: Record<PrimaryWorldResource, { key: string; label: string }[]> = {
    players: [{ key: "name", label: "玩家" }, { key: "level", label: "等级" }, { key: "guildName", label: "工会" }, { key: "membershipStatus", label: "状态" }],
    pals: [{ key: "displayName", label: "帕鲁" }, { key: "traits", label: "属性" }, { key: "level", label: "等级" }, { key: "ownerName", label: "主人" }, { key: "baseId", label: "据点" }],
    guilds: [{ key: "name", label: "工会" }, { key: "memberCount", label: "成员" }, { key: "baseCount", label: "据点" }, { key: "id", label: "Guild ID" }],
    bases: [{ key: "name", label: "据点" }, { key: "id", label: "Base ID" }, { key: "guildId", label: "工会" }, { key: "workerContainerId", label: "工作容器" }],
  };
  return definitions[resource];
}

export function worldCell(item: WorldRow, key: string): string {
  if (key === "displayName") return resolvePal(item).displayName;
  if (key === "traits") return palTraitLabels(item).join(" · ") || "普通";
  if (key === "ownerName") return item.ownerName ? String(item.ownerName) : item.ownerPlayerId ? "玩家资料不可用" : "未分配";
  if (key === "guildName") return item.guildName ? String(item.guildName) : item.guildId ? "已加入工会" : "未加入工会";
  if (key === "membershipStatus") return item.guildId ? "已加入工会" : "未加入工会";
  const value = item[key];
  if (value === undefined || value === null || value === "") return key === "baseId" || key === "guildId" ? "未分配" : "不可用";
  if (key === "ownerKind") return ({ player_inventory: "玩家背包", base_inventory: "据点库存", unassigned: "未分配" } as Record<string, string>)[String(value)] || String(value);
  return String(value);
}

export function formatWorldTime(value?: number): string {
  return value ? new Date(value * 1000).toLocaleString("zh-CN") : "尚无成功结果";
}
