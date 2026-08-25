import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("世界数据筛选与排序交给完整数据查询处理", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  expect(source).toContain('query.set("status", statusFilter)');
  expect(source).toContain('query.set("sort", sortKey)');
  expect(source).not.toContain("matchesRelationFilter");
  expect(source).toContain("setResource(next);\n    setResult(null);");
  expect(source).toContain('label: "总览"');
  expect(source).toContain('label: "帕鲁名册"');
  expect(source).toContain('label: "仓库"');
  expect(source).toContain("InventoryWorkspace");
  expect(source).not.toContain('workspace="inventories"');
});

test("仓库默认使用持有库存并按存放分布两级展开", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const inventoryPath = fileURLToPath(new URL("./InventoryWorkspace.tsx", import.meta.url));
  const pageSource = readFileSync(pagePath, "utf8");
  const source = readFileSync(inventoryPath, "utf8");

  expect(pageSource).toContain('useState<InventoryContext>({ scope: "inventory" })');
  expect(source).toContain('["inventory", "库存"]');
  expect(source).toContain('["world", "世界"]');
  expect(source).toContain("库存总量");
  expect(source).toContain("世界容器总量");
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
