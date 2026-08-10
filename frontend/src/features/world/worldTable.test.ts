import { expect, test } from "vitest";

import { worldCell, worldColumns } from "./worldTable";

test("玩家页保持稳定列顺序", () => {
  expect(worldColumns("players").map(({ key }) => key)).toEqual(["name", "level", "id", "guildId"]);
});

test("世界数据空绑定和库存归属使用中文语义", () => {
  expect(worldCell({ id: "base-1", guildId: null }, "guildId")).toBe("未分配");
  expect(worldCell({ ownerKind: "base_inventory" }, "ownerKind")).toBe("据点库存");
});
