import { expect, test } from "@playwright/test";

test("M2 本机应用壳与服务器管理无横向溢出", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        local: true,
        authenticated: true,
        lanPasswordConfigured: false,
        csrfToken: "e2e-csrf-token",
        lanWarning: null,
        port: 8223,
      },
    }),
  );
  await page.route("**/api/shell/status", (route) =>
    route.fulfill({
      json: {
        source: "console",
        observedAt: 1_786_000_000,
        stale: false,
        errorCode: null,
        module: "M2",
        serverState: "stopped",
        configured: true,
        pids: [],
        executablePath: "C:\\SteamLibrary\\steamapps\\common\\PalServer\\PalServer.exe",
      },
    }),
  );
  await page.route("**/api/server/settings", (route) =>
    route.fulfill({
      json: {
        executablePath: "C:\\SteamLibrary\\steamapps\\common\\PalServer\\PalServer.exe",
        launchArguments: "-useperfthreads",
      },
    }),
  );
  const liveSnapshot = {
    info: { data: { version: "v0.6.1", worldName: "测试世界" }, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    players: { data: [{ name: "测试玩家", userId: "player-1", ip: "203.0.113.9" }], source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    metrics: { data: { server: { serverFps: 60 }, process: { pids: [701], cpuPercent: 12.5, memoryBytes: 1048576, diskReadBytes: 10, diskWriteBytes: 20 } }, source: "rest+process", observedAt: 1_786_000_000, stale: false, errorCode: null },
    settings: { data: { difficulty: "Normal" }, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `event: snapshot\ndata: ${JSON.stringify(liveSnapshot)}\n\n`,
  }));
  await page.route("**/api/audit?**", (route) => route.fulfill({ json: {
    items: [{ id: 1, eventType: "player.joined", peerIp: "203.0.113.9", result: "success", detail: { playerId: "player-1" }, createdAt: 1_786_000_000, source: "player-diff", parserVersion: null }], page: 1, pageSize: 25, total: 1, observedAt: 1_786_000_000,
  } }));
  await page.route("**/api/audit/settings", (route) => route.fulfill({ json: { retentionDays: 30 } }));
  await page.route("**/api/audit/capabilities", (route) => route.fulfill({ json: { chatSupported: false, commandSupported: false, message: "当前数据源不支持聊天或命令事件。" } }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null, error: null, snapshotId: "fixture", parsing: false, parseDurationMs: 4312,
    counts: { players: 3, pals: 1626, guilds: 1, bases: 4, inventory_items: 13060, work_pals: 76 },
  } }));
  await page.route("**/api/world/players/player-1", (route) => route.fulfill({ json: {
    id: "player-1", name: "测试玩家", level: 55, guildId: "guild-1", inventory: [{ itemId: "Wood", quantity: 20 }], pals: [{ id: "pal-1" }], source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null,
  } }));
  await page.route("**/api/world/players?**", (route) => route.fulfill({ json: {
    items: [{ id: "player-1", name: "测试玩家", level: 55, guildId: "guild-1" }], page: 1, pageSize: 50, total: 1, source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null,
  } }));
  await page.route("**/api/world/bases?**", (route) => route.fulfill({ json: {
    items: [
      { id: "base-1", name: "雪原据点", guildId: "guild-1", workerContainerId: "workers-1" },
      { id: "base-2", name: "火山据点", guildId: "guild-1", workerContainerId: "workers-2" },
    ], page: 1, pageSize: 50, total: 2, source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null,
  } }));
  await page.route("**/api/backups", (route) => route.fulfill({ json: {
    items: [{ id: "2026.08.01-01.02.03", observedAt: 1_786_000_000, sizeBytes: 2048, valid: true, missing: [] }], retention: null,
    worldPath: "C:\\PalServer\\Pal\\Saved\\SaveGames\\0\\world-guid", backupRoot: "C:\\PalServer\\Pal\\Saved\\SaveGames\\0\\world-guid\\backup\\world",
  } }));
  const configFixture = {
    path: "C:\\PalServer\\Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini",
    sourceHash: "fixture-hash",
    sourceMtimeNs: 1_786_000_000_000_000_000,
    fields: { ServerName: '"测试世界, 01"', AdminPassword: "已配置", AutoSaveSpan: "600.000000", UnknownFlag: "(A=1,B=2)" },
    unknownFields: { UnknownFlag: "(A=1,B=2)" },
    schema: ["ServerName", "AdminPassword", "AutoSaveSpan"],
    fieldOrder: ["ServerName", "AdminPassword", "AutoSaveSpan", "UnknownFlag"],
    rawText: "OptionSettings=(ServerName=\"测试世界, 01\",AdminPassword=<已隐藏>,AutoSaveSpan=600.000000,UnknownFlag=(A=1,B=2))",
    adminPasswordConfigured: true,
    worldOptionPresent: true,
    draft: null,
  };
  await page.route("**/api/config/draft", (route) => route.fulfill({ json: configFixture }));
  await page.route("**/api/config/current", (route) => route.fulfill({ json: configFixture }));
  await page.route("**/api/config/diff", (route) => route.fulfill({ json: { hasDraft: false, conflict: null, text: "", fields: [] } }));
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "总览" })).toBeVisible();
  await expect(page.getByText("生命周期控制已就绪")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: testInfo.outputPath(`m2-shell-${testInfo.project.name}.png`),
    fullPage: true,
  });

  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "服务器配置" }).click();
  await page.waitForTimeout(220);
  await expect(page.getByRole("heading", { name: "PalWorldSettings.ini" })).toBeVisible();
  await expect(page.getByText("检测到当前世界存在 WorldOption.sav")).toBeVisible();
  await expect(page.getByRole("tab", { name: "面板设置" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "世界设置" }).click();
  await expect(page.getByRole("tab", { name: "世界设置" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "高级字段" })).toBeVisible();
  await page.getByRole("tab", { name: "面板设置" }).click();
  await expect(page.getByRole("heading", { name: "基本信息" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m7-config-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") await page.locator(".menu-button").click();
  await page.locator("nav button").nth(5).click();
  await page.waitForTimeout(220);
  await expect(page.getByText("官方备份").first()).toBeVisible();
  await expect(page.getByText("2026.08.01-01.02.03")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m6-backups-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "服务器管理" }).click();
  await page.waitForTimeout(220);
  await expect(page.getByRole("heading", { name: "PalServer 安装" })).toBeVisible();
  await expect(page.getByRole("button", { name: "启动" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m2-server-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "实时监控" }).click();
  await page.waitForTimeout(220);
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  await expect(page.getByRole("heading", { name: "实时监控" })).toBeVisible();
  await expect(page.getByText("203.0.113.9")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m3-live-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "运营审计" }).click();
  await page.waitForTimeout(220);
  await expect(page.getByRole("heading", { name: "运营审计", level: 2 })).toBeVisible();
  await expect(page.getByText("当前数据源不支持聊天或命令事件。")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m4-audit-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "世界数据" }).click();
  await page.waitForTimeout(220);
  await expect(page.getByRole("heading", { name: "存档缓存可用" })).toBeVisible();
  await page.getByRole("button", { name: "测试玩家" }).click();
  await expect(page.getByRole("heading", { name: "测试玩家", level: 2 })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`m5-world-player-${testInfo.project.name}.png`), fullPage: true });
  await page.getByRole("tab", { name: "据点" }).click();
  await expect(page.getByText("雪原据点")).toBeVisible();
  await expect(page.getByText("火山据点")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m5-world-${testInfo.project.name}.png`), fullPage: true });

  if (testInfo.project.name === "mobile") {
    await page.getByTitle("打开菜单").click();
  }
  await page.getByRole("button", { name: "访问安全" }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/open/);
  await page.waitForTimeout(220);
  await expect(page.getByRole("heading", { name: "局域网管理员密码" })).toBeVisible();
  await expect(page.getByLabel("端口")).toHaveValue("8223");
  await page.screenshot({
    path: testInfo.outputPath(`m1-settings-${testInfo.project.name}.png`),
    fullPage: true,
  });
});

test("M1 LAN 登录页无横向溢出", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) =>
    route.fulfill({
      json: {
        local: false,
        authenticated: false,
        lanPasswordConfigured: true,
        csrfToken: null,
        lanWarning: "仅可信内网使用，禁止公网暴露。",
        port: 8223,
      },
    }),
  );
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "局域网管理员登录" })).toBeVisible();
  await expect(page.getByLabel("管理员密码")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.screenshot({
    path: testInfo.outputPath(`m1-login-${testInfo.project.name}.png`),
    fullPage: true,
  });
});
