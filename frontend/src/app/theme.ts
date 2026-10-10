import type { Theme } from "../api/contracts";

export const THEME_OPTIONS: Array<{ id: Theme; name: string; shortName: string; description: string }> = [
  { id: "light", name: "轻爽极简 (Console)", shortName: "极简", description: "暖白留白与克制蓝绿色，适合长时间值守" },
  { id: "island", name: "灵动海岛 (Island)", shortName: "海岛", description: "晴空、海水与阳光点缀的轻快帕鲁世界" },
  { id: "dark", name: "深邃夜色 (Dark)", shortName: "夜色", description: "低眩光炭灰界面，适合暗光环境操作" },
];
