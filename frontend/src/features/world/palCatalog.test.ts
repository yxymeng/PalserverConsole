import { describe, expect, it } from "vitest";

import { matchingPalCharacterIds, palTraitLabels, playerInitial, resolvePal } from "./palCatalog";

describe("Pal catalog presentation", () => {
  it("uses a nickname first and keeps the known Chinese species name", () => {
    expect(resolvePal({ characterId: "SheepBall", nickname: "咩咩" })).toMatchObject({
      characterId: "SheepBall",
      displayName: "咩咩",
      speciesName: "棉悠悠",
      icon: "/assets/pals/T_SheepBall_icon_normal.webp",
      known: true,
    });
  });

  it("uses the Chinese species name without a nickname and falls back to an unknown ID", () => {
    expect(resolvePal({ characterId: "CatMage" }).displayName).toBe("暗巫猫");
    expect(resolvePal({ characterId: "BOSS_ChickenPal" }).displayName).toBe("皮皮鸡");
    expect(resolvePal({ characterId: "Alpaca" }).displayName).toBe("美露帕");
    expect(resolvePal({ characterId: "BerryGoat" }).displayName).toBe("灌木羊");
    expect(resolvePal({ characterId: "BadCatgirl" }).displayName).toBe("妮瞅莎");
    expect(resolvePal({ characterId: "BOSS_Believer_CrossBow" })).toMatchObject({
      displayName: "通缉犯 埃戈",
      icon: "/assets/pals/T_icon_unknown.webp",
      known: true,
    });
    expect(resolvePal({ characterId: "FuturePal", nickname: "" })).toMatchObject({
      displayName: "FuturePal",
      speciesName: "FuturePal",
      icon: "/assets/pals/T_icon_unknown.webp",
      known: false,
    });
  });

  it("keeps gender separate from lucky, boss and other parsed traits", () => {
    expect(palTraitLabels({
      characterId: "BOSS_ChickenPal",
      gender: "EPalGenderType::Female", rank: 3, isLucky: true, isAwakened: true,
    })).toEqual(["闪光", "头目", "觉醒", "浓缩等级 2"]);
    expect(resolvePal({ characterId: "SheepBall", gender: "EPalGenderType::Female" }).gender).toBe("female");
    expect(palTraitLabels({ characterId: "GrassBoss" })).toContain("头目");
    expect(resolvePal({ characterId: "SheepBall", rank: null }).rank).toBe(0);
  });

  it("maps sparse save Rank 1–5 to the game's 0–4 condensation stars", () => {
    for (const [rank, stars] of [[null, 0], [1, 0], [2, 1], [3, 2], [4, 3], [5, 4]] as const) {
      expect(resolvePal({ characterId: "SheepBall", rank }).rank).toBe(stars);
    }
    expect(resolvePal({ characterId: "SheepBall", rank: 0 }).rank).toBeNull();
    expect(resolvePal({ characterId: "SheepBall", rank: 6 }).rank).toBeNull();
  });

  it("uses the first visible character for player text avatars", () => {
    expect(playerInitial("Alice")).toBe("A");
    expect(playerInitial("520Player")).toBe("5");
    expect(playerInitial("小明")).toBe("小");
    expect(playerInitial("   ")).toBe("?");
  });

  it("maps an exact localized species name to every matching Character ID", () => {
    expect(matchingPalCharacterIds("美露帕")).toEqual(["Alpaca", "BOSS_Alpaca"]);
    expect(matchingPalCharacterIds("  棉悠悠  ")).toEqual(["BOSS_SheepBall", "Quest_Farmer03_SheepBall", "SheepBall"]);
    expect(matchingPalCharacterIds("不存在的帕鲁")).toEqual([]);
  });
});
