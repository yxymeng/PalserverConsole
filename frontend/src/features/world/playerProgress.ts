import type { WorldPlayerProgress, WorldPlayerProgressField } from "../../api/contracts";

export const PLAYER_PROGRESS_LABELS: Record<WorldPlayerProgressField, string> = {
  discoveredPalSpecies: "已发现帕鲁种类",
  capturedPals: "累计捕获帕鲁数量",
  fastTravel: "已解锁传送点",
  relics: "已收集翠叶鼠雕像",
  memos: "已收集手记",
  exploredAreas: "已探索区域",
  fieldBosses: "已完成野外头目项目",
  towerBosses: "已完成高塔",
  dungeonClears: "地下城通关次数",
  oilRigClears: "油田通关次数",
  technologyPoints: "当前科技点",
  ancientTechnologyPoints: "当前古代科技点",
  recipes: "已解锁配方数量",
};

export const PLAYER_PROGRESS_GROUPS: Array<{
  title: string;
  fields: WorldPlayerProgressField[];
}> = [
  { title: "探索与收集", fields: ["discoveredPalSpecies", "fastTravel", "relics", "memos", "exploredAreas", "recipes"] },
  { title: "战斗与通关", fields: ["fieldBosses", "towerBosses", "dungeonClears", "oilRigClears"] },
  { title: "捕获与科技", fields: ["capturedPals", "technologyPoints", "ancientTechnologyPoints"] },
];

export function playerProgressOf(row: { progress: WorldPlayerProgress }): WorldPlayerProgress {
  return row.progress;
}

export function playerProgressCoverage(progress: WorldPlayerProgress): string {
  if (progress.state === "complete") return "完整数据";
  if (progress.state === "partial") return "部分数据";
  return "玩家进度不可用";
}

export function playerProgressSummary(progress: WorldPlayerProgress): string {
  if (progress.state === "unavailable") return "玩家进度不可用";
  const discovered = progress.values.discoveredPalSpecies;
  const captured = progress.values.capturedPals;
  if (discovered !== undefined && captured !== undefined) return `发现 ${number(discovered)} 种 · 捕获 ${number(captured)} 只`;
  const first = (Object.keys(PLAYER_PROGRESS_LABELS) as WorldPlayerProgressField[]).find((key) => progress.values[key] !== undefined);
  return first ? `${PLAYER_PROGRESS_LABELS[first]} ${number(progress.values[first] as number)}` : "玩家进度不可用";
}

export function playerProgressUnavailable(progress: WorldPlayerProgress): string[] {
  return progress.unavailable.map((key) => PLAYER_PROGRESS_LABELS[key]).filter(Boolean);
}

export function playerProgressValue(progress: WorldPlayerProgress, field: WorldPlayerProgressField): string | null {
  const value = progress.values[field];
  return value === undefined ? null : number(value);
}

function number(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}
