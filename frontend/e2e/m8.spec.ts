import { expect, test } from "@playwright/test";

test("M8 operation contract、错误码和移动端交互", async ({ page }, testInfo) => {
  let startCalls = 0;
  await page.on("dialog", async (dialog) => dialog.accept());
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: true, adminPasswordConfigured: false,
    csrfToken: "m8-csrf", lanWarning: null, port: 8223,
  } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: {
    source: "console", observedAt: 1786000000, stale: false, errorCode: null,
    module: "M2", serverState: "stopped", configured: true, pids: [],
    executablePath: "F:\\SteamLibrary\\steamapps\\common\\PalServer\\PalServer.exe",
    instanceId: "default",
  } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000,
    capacity: { state: "ok", freeBytes: 100_000_000, totalBytes: 200_000_000, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null },
    directories: [],
    world: { state: "healthy", lastSuccessAt: 1_786_000_000, snapshotId: null, parsing: false, errorCode: null, cacheSizeBytes: 0 },
    backups: { state: "healthy", lastSuccessAt: 1_786_000_000, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null },
    background: [],
    alerts: [],
  } }));
  const liveSnapshot = {
    info: { data: { version: "v0.6.1", worldName: "测试世界" }, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    players: { data: [], source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    metrics: { data: { server: { serverFps: 60 }, process: { pids: [], cpuPercent: 0, memoryBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, startedAt: 1_786_000_000 } }, source: "rest+process", observedAt: 1_786_000_000, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null, error: null,
    snapshotId: "m8-world", parsing: false, parseDurationMs: 100, gameTimeTicks: null,
    counts: { players: 0, pals: 0, guilds: 0, bases: 0 },
  } }));
  await page.route("**/api/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `event: snapshot\ndata: ${JSON.stringify(liveSnapshot)}\n\n`,
  }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: {
    executablePath: "F:\\SteamLibrary\\steamapps\\common\\PalServer\\PalServer.exe", launchArguments: "",
  } }));
  await page.route("**/api/maintenance/notifications", (route) =>
    route.fulfill({ json: { enabled: false, configured: false } }),
  );
  await page.route("**/api/server/operations/start", (route) => {
    startCalls += 1;
    if (startCalls === 1) {
      return route.fulfill({ status: 409, json: {
        errorCode: "OPERATION_IN_PROGRESS", message: "已有服务器操作正在进行。", retryable: true,
      } });
    }
    return route.fulfill({ json: {
      operationId: "m8-operation", kind: "start", state: "queued",
      stage: "queued", errorCode: null, detail: null,
    } });
  });
  await page.route("**/api/server/operations/m8-operation", (route) => route.fulfill({ json: {
    operationId: "m8-operation", kind: "start", state: "succeeded",
    stage: "process_running", errorCode: null, detail: null,
  } }));

  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  const primaryNavigation = page.getByRole("navigation", { name: "主导航" });
  await expect(primaryNavigation.getByRole("button")).toHaveCount(4);
  await expect(primaryNavigation).toContainText("首页");
  await expect(primaryNavigation).toContainText("世界数据");
  await expect(primaryNavigation).toContainText("配置");
  await expect(primaryNavigation).toContainText("维护");
  await expect(primaryNavigation).not.toContainText("服务器管理");
  await expect(primaryNavigation).not.toContainText("官方备份");
  await expect(primaryNavigation).not.toContainText("运营审计");
  await page.getByRole("button", { name: "首页" }).click();
  const hero = page.getByLabel("首页服务器控制");
  await expect(hero).toBeVisible();
  await expect(hero.locator(".hero-character")).toHaveAttribute("src", "/zoe-character.png");
  expect(await hero.locator(".hero-character").evaluate((image) => {
    const imageRect = image.getBoundingClientRect();
    const stageRect = image.parentElement?.getBoundingClientRect();
    return !!stageRect && imageRect.top >= stageRect.top && imageRect.bottom <= stageRect.bottom;
  })).toBe(true);
  await expect(page.getByRole("heading", { name: "服务器控制" })).toBeVisible();
  const liveStatus = page.getByLabel("实时服务器状态");
  await expect(page.getByLabel("PalServer 当前状态")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "服务器状态" })).toHaveCount(0);
  await expect(liveStatus).toContainText("服务器状态");
  await expect(liveStatus).toContainText("在线玩家");
  const hostStatus = page.getByLabel("主机性能状态");
  await expect(hostStatus).toContainText("CPU 使用率");
  await expect(hostStatus).toContainText("内存使用");
  await expect(hostStatus).toContainText("磁盘读取");
  await expect(hostStatus).toContainText("磁盘写入");

  const startButton = page.getByRole("button", { name: "启动" });
  if (testInfo.project.name === "mobile") await startButton.tap();
  else await startButton.click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("F:\\SteamLibrary\\steamapps\\common\\PalServer\\PalServer.exe");
  await expect(confirmation).toHaveCSS("opacity", "1");
  expect(await confirmation.evaluate((element) => {
    const root = element.getBoundingClientRect();
    return element.scrollWidth <= element.clientWidth && [...element.querySelectorAll("*")].every((child) => {
      const rect = child.getBoundingClientRect();
      return rect.left >= root.left - 1 && rect.right <= root.right + 1;
    });
  })).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`confirmation-dialog-${testInfo.project.name}.png`) });
  const confirmStart = confirmation.getByRole("button", { name: "确认启动" });
  if (testInfo.project.name === "mobile") await confirmStart.tap();
  else await confirmStart.click();
  await expect(page.getByText("OPERATION_IN_PROGRESS")).toBeVisible();
  const feedback = page.getByRole("alert").filter({ hasText: "OPERATION_IN_PROGRESS" });
  const actions = page.locator(".psc-control-actions");
  const feedbackBox = await feedback.boundingBox();
  const actionsBox = await actions.boundingBox();
  expect(feedbackBox && actionsBox && feedbackBox.y - (actionsBox.y + actionsBox.height) >= 16).toBe(true);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath(`operation-error-${testInfo.project.name}.png`) });
  if (testInfo.project.name === "mobile") await startButton.tap();
  else await startButton.click();
  const confirmRetry = page.getByRole("alertdialog").getByRole("button", { name: "确认启动" });
  if (testInfo.project.name === "mobile") await confirmRetry.tap();
  else await confirmRetry.click();
  const operationIsland = page.getByLabel("当前操作状态");
  await expect(operationIsland).toContainText("启动服务器", { timeout: 5_000 });
  await expect(operationIsland).toContainText("服务器已启动。");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`m8-operation-${testInfo.project.name}.png`), fullPage: true });
});
