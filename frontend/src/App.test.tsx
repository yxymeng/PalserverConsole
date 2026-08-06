import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import App from "./App";

test("renders the M1 connection state without exposing credentials", () => {
  const markup = renderToStaticMarkup(<App />);

  expect(markup).toContain("PalServerConsole");
  expect(markup).toContain("正在连接本机控制台");
  expect(markup).not.toContain("AdminPassword");
});
