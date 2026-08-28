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

test("大型世界数据与配置页面由应用壳按需加载", () => {
  const shellPath = fileURLToPath(new URL("./app/ConsoleShell.tsx", import.meta.url));
  const source = readFileSync(shellPath, "utf8");

  expect(source).toContain('import { lazy, Suspense');
  expect(source).toContain('import("../features/world/WorldDataPage")');
  expect(source).toContain('import("../features/config/ConfigPage")');
  expect(source).not.toContain('import { WorldDataPage } from "../features/world/WorldDataPage"');
  expect(source).not.toContain('import { ConfigPage } from "../features/config/ConfigPage"');
});
