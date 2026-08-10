import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("App.tsx 只保留应用壳，不再内嵌 feature 页面或 legacy 组件", () => {
  const appPath = fileURLToPath(new URL("./App.tsx", import.meta.url));
  const source = readFileSync(appPath, "utf8");

  expect(source.split("\n").length).toBeLessThan(80);
  expect(source).not.toContain("function ConfigPageLegacy");
  expect(source).not.toContain("function ServerManagement");
  expect(source).not.toContain("function WorldDataPage");
});
