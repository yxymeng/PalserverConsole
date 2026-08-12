import { describe, expect, it } from "vitest";

import { palTraitLabels, playerInitial, resolvePal } from "./palCatalog";

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

  it("presents gender, lucky, boss and other parsed traits", () => {
    expect(palTraitLabels({
      characterId: "BOSS_ChickenPal",
      detail: { gender: "EPalGenderType::Female", rank: 3, isLucky: true, isAwakened: true },
    })).toEqual(["雌性", "闪光", "头目", "觉醒", "浓缩等级 3"]);
    expect(palTraitLabels({ characterId: "GrassBoss" })).toContain("头目");
  });

  it("uses the first visible character for player text avatars", () => {
    expect(playerInitial("Alice")).toBe("A");
    expect(playerInitial("520Player")).toBe("5");
    expect(playerInitial("小明")).toBe("小");
    expect(playerInitial("   ")).toBe("?");
  });
});
