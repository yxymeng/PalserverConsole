import type { WorldResource, WorldRow } from "../../api/contracts";

export function worldColumns(resource: WorldResource) {
  const definitions: Record<WorldResource, { key: string; label: string }[]> = {
    players: [{ key: "name", label: "玩家" }, { key: "level", label: "等级" }, { key: "id", label: "Player ID" }, { key: "guildId", label: "工会" }],
    pals: [{ key: "nickname", label: "昵称" }, { key: "characterId", label: "帕鲁" }, { key: "level", label: "等级" }, { key: "ownerPlayerId", label: "主人" }, { key: "baseId", label: "据点" }],
    guilds: [{ key: "name", label: "工会" }, { key: "memberCount", label: "成员" }, { key: "baseCount", label: "据点" }, { key: "id", label: "Guild ID" }],
    bases: [{ key: "name", label: "据点" }, { key: "id", label: "Base ID" }, { key: "guildId", label: "工会" }, { key: "workerContainerId", label: "工作容器" }],
    inventories: [{ key: "itemId", label: "物品" }, { key: "quantity", label: "数量" }, { key: "containerId", label: "容器" }, { key: "ownerKind", label: "归属" }, { key: "baseId", label: "据点" }],
    "work-pals": [{ key: "nickname", label: "昵称" }, { key: "characterId", label: "帕鲁" }, { key: "level", label: "等级" }, { key: "baseId", label: "据点" }, { key: "id", label: "Instance ID" }],
  };
  return definitions[resource];
}

export function worldCell(item: WorldRow, key: string): string {
  const value = item[key];
  if (value === undefined || value === null || value === "") return key === "baseId" || key === "guildId" || key === "ownerPlayerId" ? "未分配" : "不可用";
  if (key === "ownerKind") return ({ player_inventory: "玩家背包", base_inventory: "据点库存", unassigned: "未分配" } as Record<string, string>)[String(value)] || String(value);
  return String(value);
}

export function formatWorldTime(value?: number): string {
  return value ? new Date(value * 1000).toLocaleString("zh-CN") : "尚无成功结果";
}
