import { expect, test } from "@playwright/test";

test("UX-03：世界法则使用目标三段框架与八类配置导航", async ({ page }, testInfo) => {
  let worldOptionSaveCount = 0;
  await page.addInitScript(() => window.localStorage.setItem("palserver-console-theme", "island"));
  if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1244, height: 900 });
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: true, adminPasswordConfigured: true,
    csrfToken: "ux03-csrf", lanWarning: null, port: 8223,
  } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000, module: "M2", serverState: "running", configured: true,
    pids: [701], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "default",
  } }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: {
    executablePath: "C:\\PalServer\\PalServer.exe", launchArguments: "-useperfthreads",
    worldId: "test-world", worldCandidates: [{ worldId: "test-world", worldPath: "C:\\PalServer\\test-world", modifiedAt: 1_786_000_000 }],
  } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000,
    capacity: { state: "ok", freeBytes: 100, totalBytes: 200, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null },
    directories: [],
    world: { state: "healthy", lastSuccessAt: 1_786_000_000, snapshotId: null, parsing: false, errorCode: null, cacheSizeBytes: 0 },
    backups: { state: "healthy", lastSuccessAt: 1_786_000_000, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null },
    background: [], alerts: [],
  } }));
  const liveSnapshot = {
    info: { data: {}, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    players: { data: [], source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    metrics: { data: { process: { pids: [], cpuPercent: 0, memoryBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, startedAt: null } }, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/config/current", (route) => route.fulfill({ json: {
    path: "C:\\PalServer\\Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini", sourceHash: "ux03", rawText: "", adminPasswordConfigured: true, worldOptionPresent: false, effectiveSource: "ini", worldOptionPath: "C:\\PalServer\\Pal\\Saved\\SaveGames\\0\\test-world\\WorldOption.sav", pendingApply: null,
    schema: ["ServerName", "ServerDescription", "ServerPassword", "AdminPassword", "ServerPlayerMaxNum", "PublicPort", "Difficulty", "ExpRate", "RCONEnabled", "AutoSaveSpan", "PalStomachDecreaceRate", "PalStaminaDecreaceRate", "PalDamageRateAttack", "PalAutoHpRegeneRateInSleep"],
    fields: { ServerName: "测试服务器", ServerDescription: "测试描述", ServerPassword: "", ServerPlayerMaxNum: "32", PublicPort: "8211", Difficulty: "Normal", ExpRate: "2", RCONEnabled: "True", AutoSaveSpan: "300", PalStomachDecreaceRate: "0.8", PalStaminaDecreaceRate: "0.8", PalDamageRateAttack: "1", PalAutoHpRegeneRateInSleep: "2", CustomLowFrequency: "keep" },
    worldOptionSchema: ["Difficulty", "ServerName", "ServerDescription", "ServerPassword", "AdminPassword", "ServerPlayerMaxNum", "PublicPort", "ExpRate", "AutoSaveSpan", "PalStomachDecreaceRate", "PalStaminaDecreaceRate", "PalDamageRateAttack", "PalAutoHpRegeneRateInSleep"],
    worldOptionFields: { Difficulty: "Custom", ServerName: "测试服务器", ServerDescription: "测试描述", ServerPassword: "", ServerPlayerMaxNum: "32", PublicPort: "8211", ExpRate: "2", AutoSaveSpan: "300", PalStomachDecreaceRate: "0.8", PalStaminaDecreaceRate: "0.8", PalDamageRateAttack: "1", PalAutoHpRegeneRateInSleep: "2" },
    worldOptionAdminPasswordConfigured: false,
    unknownFields: { CustomLowFrequency: "keep" },
  } }));
  await page.route("**/api/config/world-option", (route) => {
    worldOptionSaveCount += 1;
    return route.fulfill({ json: { message: "配置已保存，等待 PalServer 自动应用。", pending: true, serverRunning: true } });
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "查看实例与控制台" })).toHaveCount(0);
  await page.getByRole("button", { name: "配置", exact: true }).click();
  await page.getByRole("tab", { name: "实例与控制台" }).click();
  await expect(page.getByRole("tab", { name: "实例与控制台" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".instance-target-strip")).toContainText("test-world");
  await expect(page.locator(".console-port-summary")).toContainText("8223");
  await page.getByRole("tab", { name: "世界法则配置" }).click();

  await expect(page.getByRole("tab", { name: "世界法则配置" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "世界法则配置 (PalWorldSettings.ini & WorldOption.sav)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存并应用法则" })).toBeDisabled();
  await expect(page.getByRole("radio", { name: "当前有效配置（推荐）" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("radio", { name: "WorldOption.sav 注入模式" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "仅 PalWorldSettings.ini" })).toBeVisible();
  await page.getByRole("tab", { name: "原始配置文本" }).click();
  await expect(page.getByLabel("原始配置文本")).toHaveAttribute("readonly", "");
  await page.getByRole("tab", { name: "可视化调节" }).click();
  await expect(page.getByRole("button", { name: "基础与连接" })).toHaveClass(/is-active/);
  await expect(page.getByRole("heading", { name: "服务器基础信息与连接" })).toBeVisible();
  await expect(page.getByText("服务器名称")).toBeVisible();
  await expect(page.getByText("经验值倍率")).not.toBeVisible();
  await page.getByRole("button", { name: "战斗与生存" }).click();
  await expect(page.locator(".config-law-field-grid .config-field-row")).toHaveCount(4);
  if (testInfo.project.name === "desktop") await page.locator(".config-law-form").screenshot({ path: testInfo.outputPath("ux03-reference-1244.png") });

  await page.getByRole("radio", { name: "WorldOption.sav 注入模式" }).click();
  await expect(page.getByRole("radio", { name: "WorldOption.sav 注入模式" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "时间与成长" }).click();
  await page.getByRole("spinbutton", { name: "经验值倍率" }).fill("3");
  const rangeBox = await page.getByRole("slider", { name: "经验值倍率" }).boundingBox();
  if (!rangeBox) throw new Error("经验值倍率滑块未渲染");
  expect(rangeBox.height).toBeGreaterThanOrEqual(15);
  await expect(page.getByRole("button", { name: "保存并应用法则" })).toBeEnabled();
  if (testInfo.project.name === "mobile") {
    const [sidebar, panel] = await Promise.all([
      page.locator(".config-law-sidebar").boundingBox(),
      page.locator(".config-law-panel").boundingBox(),
    ]);
    if (!sidebar || !panel) throw new Error("手机端配置分类或参数面板未渲染");
    expect(sidebar.y + sidebar.height).toBeLessThanOrEqual(panel.y);
  }
  await page.screenshot({ path: testInfo.outputPath(`ux03-world-option-${testInfo.project.name}.png`), fullPage: true });
  const dialogPromise = page.waitForEvent("dialog");
  await page.getByRole("button", { name: "保存并应用法则" }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("关闭、重启或下次启动前自动应用");
  await dialog.dismiss();
  await expect(page.getByText("配置已保存，等待 PalServer 自动应用。")).toBeVisible();
  expect(worldOptionSaveCount).toBe(1);
  await page.getByRole("radio", { name: "仅 PalWorldSettings.ini" }).click();

  await page.getByLabel("搜索名称或配置键").fill("RCON");
  await expect(page.getByText("启用 RCON")).toBeVisible();
  await expect(page.getByText("服务器名称")).not.toBeVisible();
  await page.getByLabel("搜索名称或配置键").fill("CustomLowFrequency");
  await expect(page.locator(".config-field-row")).toContainText("CustomLowFrequency");
  await page.getByRole("textbox", { name: "CustomLowFrequency" }).fill("changed");
  await expect(page.getByText("（1 项已暂存修改）")).toBeVisible();
  await expect(page.locator('[data-config-key="CustomLowFrequency"]')).toContainText("已修改");
  await expect(page.getByRole("button", { name: "保存并应用法则" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath(`ux03-game-${testInfo.project.name}.png`), fullPage: true });
  await page.getByRole("tab", { name: "实例与控制台" }).click();
  await expect(page.getByRole("heading", { name: "实例运行环境" })).toBeVisible();
  await expect(page.locator(".config-instance-grid")).toBeVisible();
  await expect(page.locator(".instance-target-strip")).toContainText("test-world");
  await expect(page.locator(".console-port-summary")).toContainText("8223");
  await page.screenshot({ path: testInfo.outputPath(`ux03-${testInfo.project.name}.png`), fullPage: true });
});
