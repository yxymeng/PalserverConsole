import { expect, test } from "@playwright/test";

test("UX-02：首页合并实时状态，关闭操作使用中文动态岛并在完成后隐去", async ({ page }, testInfo) => {
  let operationPoll = 0;
  await page.on("dialog", async (dialog) => dialog.accept());
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: true, adminPasswordConfigured: true,
    csrfToken: "ux02-csrf", lanWarning: null, port: 8223,
  } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000,
    module: "M2",
    serverState: "running",
    configured: true,
    pids: [4242],
    executablePath: "C:\\PalServer\\PalServer.exe",
    instanceId: "default",
  } }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: {
    executablePath: "C:\\PalServer\\PalServer.exe", launchArguments: "",
  } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000,
    capacity: { state: "ok", freeBytes: 100, totalBytes: 200, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null },
    directories: [],
    world: { state: "healthy", lastSuccessAt: 1_786_000_000, snapshotId: null, parsing: false, errorCode: null, cacheSizeBytes: 0 },
    backups: { state: "healthy", lastSuccessAt: 1_786_000_000, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null },
    background: [],
    alerts: [],
  } }));
  const liveSnapshot = {
    info: { source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null, data: { serverName: "测试服务器", version: "v0.6.1" } },
    players: { source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null, data: [{ name: "测试玩家", userId: "player-1", ip: "203.0.113.9" }] },
    metrics: { source: "rest+process", observedAt: 1_786_000_000, stale: false, errorCode: null, data: { server: { serverFps: 60 }, process: { pids: [4242], cpuPercent: 12.5, cpuReady: true, memoryBytes: 4 * 1024 * 1024, diskReadBytes: 1_024, diskWriteBytes: 2_048, diskReadBytesPerSecond: 1_024, diskWriteBytesPerSecond: 2_048, ioReady: true, startedAt: 1_786_000_000 } } },
    settings: { source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null, data: {} },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/server/operations/stop", (route) => route.fulfill({ json: {
    operationId: "ux02-stop", kind: "stop", state: "queued", stage: "queued", errorCode: null, detail: null,
  } }));
  await page.route("**/api/server/operations/ux02-stop", (route) => {
    const states = [
      { state: "running", stage: "countdown" },
      { state: "running", stage: "stopping" },
      { state: "succeeded", stage: "stopped" },
    ];
    const current = states[Math.min(operationPoll, states.length - 1)];
    operationPoll += 1;
    return route.fulfill({ json: { operationId: "ux02-stop", kind: "stop", errorCode: null, detail: null, ...current } });
  });

  await page.goto("/");

  const control = page.getByLabel("首页服务器控制");
  const liveStatus = page.getByLabel("实时服务器状态");
  await expect(control).toBeVisible();
  await expect(control.getByRole("button", { name: "关闭" })).toBeEnabled();
  await expect(liveStatus).toBeVisible();
  await expect(page.getByLabel("PalServer 当前状态")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "服务器状态" })).toHaveCount(0);
  await expect(page.getByText("实时监控", { exact: true })).toHaveCount(0);
  await expect(liveStatus).toContainText("12.5%");
  await expect(liveStatus).toContainText("4.0 MB");
  await expect(liveStatus).toContainText("1.0 KB/秒");
  await expect(liveStatus).toContainText("2.0 KB/秒");

  await control.getByRole("button", { name: "关闭" }).click();
  const operationIsland = page.getByLabel("当前操作状态");
  await expect(operationIsland).toContainText("关闭服务器");
  await expect(operationIsland).toContainText("维护倒计时中，仍可取消。", { timeout: 2_500 });
  await expect(operationIsland.getByRole("button", { name: "取消" })).toBeVisible();
  await expect(operationIsland).not.toContainText("countdown");
  await page.screenshot({ path: testInfo.outputPath(`ux02-${testInfo.project.name}.png`) });
  await expect(operationIsland).toContainText("正在请求服务器关闭。", { timeout: 2_500 });
  await expect(operationIsland).toContainText("服务器已完全关闭。", { timeout: 2_500 });
  await expect(operationIsland).toBeHidden({ timeout: 5_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
