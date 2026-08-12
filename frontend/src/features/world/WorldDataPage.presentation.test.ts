import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("帕鲁名称排序使用当前展示名称而非原始字段", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8");

  expect(source).toContain('sortKey === "name" && resource === "pals" ? resolvePal(item).displayName');
});
