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
});
