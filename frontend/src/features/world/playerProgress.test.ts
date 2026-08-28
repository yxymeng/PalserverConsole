import { describe, expect, it } from "vitest";

import type { WorldPlayerProgress } from "../../api/contracts";
import { playerProgressCoverage, playerProgressSummary, playerProgressUnavailable, playerProgressValue } from "./playerProgress";

describe("玩家主要进度呈现", () => {
  it("明确区分发现种类、累计捕获和完成项目/累计次数", () => {
    const progress: WorldPlayerProgress = {
      state: "complete",
      values: {
        discoveredPalSpecies: 12,
        capturedPals: 3456,
        fastTravel: 38,
        relics: 12,
        memos: 6,
        fieldBosses: 7,
        towerBosses: 3,
        dungeonClears: 21,
        oilRigClears: 4,
      },
      unavailable: [],
    };

    expect(playerProgressSummary(progress)).toBe("发现 12 种 · 捕获 3,456 只");
    expect(playerProgressCoverage(progress)).toBe("完整数据");
    expect(playerProgressValue(progress, "fieldBosses")).toBe("7");
    expect(playerProgressValue(progress, "dungeonClears")).toBe("21");
  });

  it("部分字段与玩家存档缺失时不补零", () => {
    const partial: WorldPlayerProgress = {
      state: "partial",
      values: { technologyPoints: 0 },
      unavailable: ["towerBosses", "dungeonClears"],
    };
    const unavailable: WorldPlayerProgress = {
      state: "unavailable",
      values: {},
      unavailable: ["discoveredPalSpecies", "capturedPals"],
    };

    expect(playerProgressCoverage(partial)).toBe("部分数据");
    expect(playerProgressSummary(partial)).toBe("当前科技点 0");
    expect(playerProgressUnavailable(partial)).toEqual(["已完成高塔", "地下城通关次数"]);
    expect(playerProgressCoverage(unavailable)).toBe("玩家进度不可用");
    expect(playerProgressSummary(unavailable)).toBe("玩家进度不可用");
  });
});
