import { describe, expect, it } from "vitest";

import { playerInitial, resolvePal } from "./palCatalog";

describe("Pal catalog presentation", () => {
  it("uses a nickname first and keeps the known Chinese species name", () => {
    expect(resolvePal({ characterId: "SheepBall", nickname: "咩咩" })).toMatchObject({
      characterId: "SheepBall",
      displayName: "咩咩",
      speciesName: "棉悠悠",
      iconKey: "sheepball",
      known: true,
    });
  });

  it("uses the Chinese species name without a nickname and falls back to an unknown ID", () => {
    expect(resolvePal({ characterId: "CatMage" }).displayName).toBe("捣蛋猫");
    expect(resolvePal({ characterId: "FuturePal", nickname: "" })).toMatchObject({
      displayName: "FuturePal",
      speciesName: "FuturePal",
      iconKey: "pal-placeholder",
      known: false,
    });
  });

  it("uses the first visible character for player text avatars", () => {
    expect(playerInitial("Alice")).toBe("A");
    expect(playerInitial("520Player")).toBe("5");
    expect(playerInitial("小明")).toBe("小");
    expect(playerInitial("   ")).toBe("?");
  });
});
