import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import type { AuthStatus, ShellStatus } from "../api/contracts";
import { ConsoleShell } from "./ConsoleShell";

const auth: AuthStatus = {
  local: true,
  authenticated: true,
  adminPasswordConfigured: false,
  csrfToken: "test-csrf",
  lanWarning: null,
  port: 8223,
};

const shell: ShellStatus = {
  observedAt: 0,
  module: "M2",
  serverState: "stopped",
  configured: false,
  pids: [],
  executablePath: null,
  instanceId: "default",
};

test("UX-01：桌面与手机一级导航都只保留首页、世界、配置和维护", () => {
  const markup = renderToStaticMarkup(
    <ConsoleShell
      auth={auth}
      shell={shell}
      onAuthChanged={() => undefined}
      theme="light"
      onThemeToggle={() => undefined}
    />,
  );
  const navigations = markup.match(/<nav[^>]*aria-label="主导航"[^>]*>[\s\S]*?<\/nav>/g) || [];

  expect(navigations).toHaveLength(2);
  navigations.forEach((navigation) => {
    expect(navigation).toContain("首页");
    expect(navigation).toContain("世界");
    expect(navigation).toContain("配置");
    expect(navigation).toContain("维护");
    expect(navigation).not.toContain("世界数据");
    expect(navigation).not.toContain("世界法则配置");
    expect(navigation.match(/<button/g)).toHaveLength(4);
  });
});
