import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("世界数据筛选与排序交给完整数据查询处理", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  expect(source).toContain('query.set("status", statusFilter)');
  expect(source).toContain('query.set("sort", sortKey)');
  expect(source).not.toContain("matchesRelationFilter");
  expect(source).toContain("entityStateCache.current[next]");
  expect(source).toContain("scrollPositions.current[workspace]");
  expect(source).toContain('label: "总览"');
  expect(source).toContain('label: "帕鲁名册"');
  expect(source).toContain('label: "仓库"');
  expect(source).toContain("InventoryWorkspace");
  expect(source).toContain("WorldOverviewLobby");
  expect(source).not.toContain('label: "未知物品"');
  expect(source).not.toContain('label: "未归属帕鲁"');
  expect(source).not.toContain('workspace="inventories"');
});

test("仓库默认使用持有库存并按存放分布两级展开", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const inventoryPath = fileURLToPath(new URL("./InventoryWorkspace.tsx", import.meta.url));
  const pageSource = readFileSync(pagePath, "utf8");
  const source = readFileSync(inventoryPath, "utf8");

  expect(pageSource).toContain('useState<InventoryContext>({ scope: "inventory" })');
  expect(source).toContain('["inventory", "全部持有"]');
  expect(source).toContain('["player", "玩家背包"]');
  expect(source).toContain('["base", "据点箱子"]');
  expect(source).not.toContain('["world", "世界"]');
  expect(source).toContain("持有总量");
  expect(source).toContain("世界宝箱和其他地图容器不计入仓库");
  expect(source).toContain("公会仓库");
  expect(source).not.toContain('["guild", "公会"]');
  expect(source).toContain("存放记录");
  expect(source).toContain("存放分布");
  expect(source).toContain("group.label");
  expect(source).toContain('group.locationType === "world"');
  expect(source).toContain('group.locationType === "unassigned"');
  expect(source).toContain("mapObjectType");
  expect(source).not.toContain("<small>位置</small>");
});

test("据点与公会详情复用照护和仓库关联语义", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const inventoryPath = fileURLToPath(new URL("./InventoryWorkspace.tsx", import.meta.url));
  const pageSource = readFileSync(pagePath, "utf8");
  const inventorySource = readFileSync(inventoryPath, "utf8");

  expect(pageSource).toContain("与帕鲁名册“需要关注”使用同一存档快照规则");
  expect(pageSource).toContain('scope="guild"');
  expect(pageSource).toContain("关联资料不可用");
  expect(pageSource).toContain("未创建猜测关系");
  expect(pageSource).toContain("Guild ID");
  expect(pageSource).toContain("Base ID");
  expect(inventorySource).toContain('query.set("guildId", context.guildId)');
});
