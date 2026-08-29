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

test("UX-01：一级导航只保留首页、世界数据、世界法则配置和维护", () => {
  const markup = renderToStaticMarkup(
    <ConsoleShell
      auth={auth}
      shell={shell}
      onAuthChanged={() => undefined}
      theme="light"
      onThemeToggle={() => undefined}
    />,
  );
  const navigation = markup.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0] || "";

  expect(navigation).toContain("首页");
  expect(navigation).toContain("世界数据");
  expect(navigation).toContain("世界法则配置");
  expect(navigation).toContain("维护");
  expect(navigation).not.toContain("服务器管理");
  expect(navigation).not.toContain("官方备份");
  expect(navigation).not.toContain("运营审计");
  expect(navigation.match(/<button/g)).toHaveLength(4);
});
