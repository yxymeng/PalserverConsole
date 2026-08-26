import { expect, test } from "vitest";

import { worldCell, worldColumns } from "./worldTable";

const pal = {
  id: "pal-1", ownerPlayerId: "player-1", characterId: "BOSS_ChickenPal", nickname: "", level: 10,
  containerId: null, slotIndex: null, baseId: "base-1", assignment: "base_worker",
  ownerName: "Alice", baseName: "据点一号", gender: "Male", isLucky: true,
};

const player = {
  id: "player-1", instanceId: "instance-1", name: "Alice", level: 20, guildId: "guild-1",
  guildName: "测试工会", inventoryIds: [], partyContainerId: null, storageContainerId: null,
  lastRecordedAt: null, progress: { state: "unavailable" as const, values: {}, unavailable: [] },
};

test("玩家页保持稳定列顺序", () => {
    expect(worldColumns("players").map(({ key }) => key)).toEqual(["name", "level", "guildName", "progressOverview"]);
  expect(worldColumns("pals").map(({ key }) => key)).toEqual(["displayName", "traits", "level", "ownerName", "baseName"]);
  expect(worldColumns("bases").map(({ key }) => key)).toEqual(["name", "id", "guildName", "workerContainerId"]);
});

test("类型化世界资产行使用中文关系语义", () => {
  expect(worldCell(pal, "displayName")).toBe("皮皮鸡");
  expect(worldCell(pal, "traits")).toBe("闪光 · 头目");
  expect(worldCell(pal, "ownerName")).toBe("Alice");
  expect(worldCell({ ...pal, ownerPlayerId: "missing-player", ownerName: undefined }, "ownerName")).toBe("玩家资料不可用");
  expect(worldCell(pal, "baseName")).toBe("据点一号");
  expect(worldCell({ ...pal, baseId: "missing-base", baseName: undefined }, "baseName")).toBe("据点资料不可用");
  expect(worldCell(player, "guildName")).toBe("测试工会");
  expect(worldCell({ ...player, guildName: undefined }, "guildName")).toBe("公会资料不可用");
});
