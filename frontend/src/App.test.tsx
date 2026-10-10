import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import App from "./App";
import { THEME_OPTIONS } from "./app/theme";

test("renders the M1 connection state without exposing credentials", () => {
  const markup = renderToStaticMarkup(<App />);

  expect(markup).toContain("PalServerConsole");
  expect(markup).toContain("正在连接本机控制台");
  expect(markup).not.toContain("AdminPassword");
});

test("主题选择器提供极简浅色、海岛帕鲁世界与夜间三种风格", () => {
  expect(THEME_OPTIONS.map(({ id }) => id)).toEqual(["light", "island", "dark"]);
  expect(THEME_OPTIONS.every(({ description }) => description.length > 0)).toBe(true);
});
