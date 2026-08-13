import { expect, test } from "vitest";

import { worldCell, worldColumns } from "./worldTable";

test("玩家页保持稳定列顺序", () => {
  expect(worldColumns("players").map(({ key }) => key)).toEqual(["name", "level", "guildName", "membershipStatus"]);
  expect(worldColumns("pals").map(({ key }) => key)).toEqual(["displayName", "traits", "level", "ownerName", "baseName"]);
  expect(worldColumns("bases").map(({ key }) => key)).toEqual(["name", "id", "guildName", "workerContainerId"]);
});

test("世界数据空绑定和库存归属使用中文语义", () => {
  expect(worldCell({ id: "base-1", guildId: null }, "guildId")).toBe("未分配");
  expect(worldCell({ ownerKind: "base_inventory" }, "ownerKind")).toBe("据点库存");
  expect(worldCell({ characterId: "SheepBall", nickname: "" }, "displayName")).toBe("棉悠悠");
  expect(worldCell({ characterId: "BOSS_ChickenPal", detail: { gender: "Male", isLucky: true } }, "traits")).toBe("闪光 · 头目");
  expect(worldCell({ ownerPlayerId: "player-1", ownerName: "Alice" }, "ownerName")).toBe("Alice");
  expect(worldCell({ ownerPlayerId: "missing-player" }, "ownerName")).toBe("玩家资料不可用");
  expect(worldCell({ baseId: "base-1", baseName: "据点一号" }, "baseName")).toBe("据点一号");
  expect(worldCell({ baseId: "missing-base" }, "baseName")).toBe("据点资料不可用");
  expect(worldCell({ guildId: "guild-1", guildName: "测试工会" }, "guildName")).toBe("测试工会");
  expect(worldCell({ guildId: "guild-1" }, "membershipStatus")).toBe("已加入工会");
});
