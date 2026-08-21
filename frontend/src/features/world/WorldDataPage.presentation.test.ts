import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("帕鲁名称排序使用当前展示名称而非原始字段", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  expect(source).toContain('sortKey === "name" && resource === "pals" ? resolvePal(item).displayName');
  expect(source).toContain("setResource(next);\n    setResult(null);");
  expect(source).toContain('label: "总览"');
  expect(source).toContain('label: "帕鲁名册"');
  expect(source).toContain('label: "仓库"');
});
