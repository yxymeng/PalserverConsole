import { expect, test } from "@playwright/test";

test("UX-03：常用配置保持精简，高级配置可搜索全部低频字段", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: true, adminPasswordConfigured: true,
    csrfToken: "ux03-csrf", lanWarning: null, port: 8223,
  } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true,
    pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "default",
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
  await page.route("**/api/config/draft", (route) => route.fulfill({ json: {
    path: "C:\\PalServer\\PalWorldSettings.ini", sourceHash: "ux03", rawText: "", adminPasswordConfigured: true, worldOptionPresent: false, draft: null,
    schema: ["ServerName", "ServerDescription", "ServerPassword", "AdminPassword", "ServerPlayerMaxNum", "PublicPort", "Difficulty", "ExpRate", "RCONEnabled", "AutoSaveSpan"],
    fields: { ServerName: "测试服务器", ServerDescription: "测试描述", ServerPassword: "", ServerPlayerMaxNum: "32", PublicPort: "8211", Difficulty: "Normal", ExpRate: "2", RCONEnabled: "True", AutoSaveSpan: "300", CustomLowFrequency: "keep" },
    unknownFields: { CustomLowFrequency: "keep" },
  } }));
  await page.route("**/api/config/diff", (route) => route.fulfill({ json: { hasDraft: false, conflict: null, text: "", fields: [] } }));

  await page.goto("/");
  await page.getByRole("button", { name: "查看实例与控制台" }).click();
  const instancePanel = page.getByRole("dialog");
  await expect(instancePanel).toContainText("test-world");
  await expect(instancePanel).toContainText("8223");
  await expect(instancePanel.getByText("运行目标", { exact: true })).toBeVisible();
  await expect(instancePanel.locator(".psc-instance-endpoints")).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({ path: testInfo.outputPath(`ux03-instance-${testInfo.project.name}.png`), fullPage: true });
  await instancePanel.getByRole("button", { name: "进入实例设置" }).click();
  await expect(page.getByRole("tab", { name: "实例与控制台" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "游戏配置" }).click();

  await expect(page.getByRole("tab", { name: "游戏配置" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("编辑 → 保存草稿 → 应用到服务器")).toBeVisible();
  await expect(page.getByRole("button", { name: "保存草稿" })).toBeDisabled();
  await expect(page.getByRole("tab", { name: "常用配置" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "日常服务器规则" })).toBeVisible();
  await expect(page.getByText("服务器名称")).toBeVisible();
  await expect(page.getByText("启用 RCON")).not.toBeVisible();

  await page.getByRole("tab", { name: "高级配置" }).click();
  await page.getByLabel("搜索名称或配置键").fill("RCON");
  await expect(page.getByText("启用 RCON")).toBeVisible();
  await expect(page.getByText("服务器名称")).not.toBeVisible();
  await page.getByLabel("搜索名称或配置键").fill("CustomLowFrequency");
  await expect(page.locator(".config-field-row")).toContainText("CustomLowFrequency");
  await page.getByRole("textbox", { name: "CustomLowFrequency" }).fill("changed");
  await expect(page.getByText("1 项未保存修改")).toBeVisible();
  await expect(page.locator('[data-config-key="CustomLowFrequency"]')).toContainText("已修改");
  await expect(page.getByRole("button", { name: "保存 1 项草稿" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath(`ux03-game-${testInfo.project.name}.png`), fullPage: true });
  await page.getByRole("tab", { name: "实例与控制台" }).click();
  await expect(page.getByRole("heading", { name: "实例运行环境" })).toBeVisible();
  await expect(page.locator(".config-instance-grid")).toBeVisible();
  await expect(page.locator(".instance-target-strip")).toContainText("test-world");
  await expect(page.locator(".console-port-summary")).toContainText("8223");
  await page.screenshot({ path: testInfo.outputPath(`ux03-${testInfo.project.name}.png`), fullPage: true });
});
