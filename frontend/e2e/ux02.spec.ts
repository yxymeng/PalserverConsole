import { expect, test } from "@playwright/test";

test("UX-02：首页合并实时状态，关闭操作使用中文动态岛并在完成后隐去", async ({ page }, testInfo) => {
  let operationPoll = 0;
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined });
  });
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
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null, error: null,
    snapshotId: "ux02-world", parsing: false, parseDurationMs: 120, gameTimeTicks: 110_628_000_000_000,
    counts: { players: 8, pals: 797, guilds: 3, bases: 8 },
  } }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/server/operations/stop", (route) => {
    expect(route.request().headers()["idempotency-key"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    return route.fulfill({ json: {
      operationId: "ux02-stop", kind: "stop", state: "queued", stage: "queued", errorCode: null, detail: null,
    } });
  });
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
  expect(await page.evaluate(() => typeof globalThis.crypto.randomUUID)).toBe("undefined");

  const control = page.getByLabel("首页服务器控制");
  const liveStatus = page.getByLabel("实时服务器状态");
  const hostStatus = page.getByLabel("主机性能状态");
  if (testInfo.project.name === "desktop") {
    await expect(page.locator('.brand-mark img[src="/zoe-console-icon.png"]')).toBeVisible();
  }
  await expect(control).toBeVisible();
  await expect(control.getByRole("button", { name: "关闭" })).toBeEnabled();
  await expect(liveStatus).toBeVisible();
  await expect(page.getByLabel("PalServer 当前状态")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "服务器状态" })).toHaveCount(0);
  await expect(page.getByText("实时监控", { exact: true })).toHaveCount(0);
  await expect(hostStatus).toContainText("12.5%");
  await expect(hostStatus).toContainText("4.0 MB");
  await expect(hostStatus).toContainText("1.0 KB/秒");
  await expect(hostStatus).toContainText("2.0 KB/秒");
  const worldStatus = page.getByLabel("游戏世界状态");
  await expect(worldStatus).not.toContainText("世界存档");
  await expect(worldStatus).toContainText("在线玩家");
  await expect(worldStatus).toContainText("1 人");
  await expect(worldStatus).toContainText("测试玩家");
  await expect(worldStatus).toContainText("128 天 1 小时");
  await expect(worldStatus).toContainText("797 / 8");
  await expect(page.getByText("实时数据正在重连", { exact: true })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await expect(page.locator(".psc-player-card")).toBeVisible();
    await expect(page.locator(".psc-player-table-wrap")).toBeHidden();
    await page.getByRole("button", { name: "打开菜单" }).click();
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await expect(page.locator('.brand-mark img[src="/zoe-console-icon.png"]')).toBeVisible();
    await expect(navigation.getByRole("button")).toHaveCount(4);
    await navigation.getByRole("button", { name: "首页" }).click();
    await expect(navigation).toBeHidden();
  } else {
    await expect(page.locator(".psc-player-table-wrap")).toBeVisible();
    await expect(page.locator(".psc-player-list")).toBeHidden();
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  if (testInfo.project.name === "desktop") {
    await expect(page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "首页" })).toHaveCSS("color", "rgb(45, 49, 50)");
  }
  await expect(control.getByRole("button", { name: "保存" })).toHaveCSS("color", "rgb(61, 105, 115)");
  await page.screenshot({ path: testInfo.outputPath(`overview-light-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "切换到深色界面" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect(control.getByRole("button", { name: "关闭" })).toHaveCSS("background-color", "rgb(39, 44, 43)");
  await page.screenshot({ path: testInfo.outputPath(`overview-dark-${testInfo.project.name}.png`) });
  await page.getByRole("button", { name: "切换到浅色界面" }).click();

  for (const action of ["保存", "重启"] as const) {
    const button = control.getByRole("button", { name: action });
    if (testInfo.project.name === "mobile") await button.tap();
    else await button.click();
    const actionDialog = page.getByRole("alertdialog");
    await expect(actionDialog).toBeVisible();
    const cancel = actionDialog.getByRole("button", { name: "取消" });
    const confirm = actionDialog.getByRole("button", { name: `确认${action}` });
    const [cancelBox, confirmBox] = await Promise.all([cancel.boundingBox(), confirm.boundingBox()]);
    expect(Math.round(cancelBox?.width || 0)).toBe(Math.round(confirmBox?.width || 0));
    expect(Math.round(cancelBox?.height || 0)).toBe(Math.round(confirmBox?.height || 0));
    if (testInfo.project.name === "mobile") await cancel.tap();
    else await cancel.click();
    await expect(page.getByRole("alertdialog")).toBeHidden();
  }
  const stopButton = control.getByRole("button", { name: "关闭" });
  if (testInfo.project.name === "mobile") await stopButton.tap();
  else await stopButton.click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText("将先通知并保存世界");
  const confirmStop = confirmation.getByRole("button", { name: "确认关闭" });
  if (testInfo.project.name === "mobile") await confirmStop.tap();
  else await confirmStop.click();
  const operationIsland = page.getByLabel("当前操作状态");
  await expect(operationIsland).toContainText("关闭服务器");
  await expect(operationIsland).toContainText("维护倒计时中，仍可取消。", { timeout: 2_500 });
  await expect(operationIsland.getByRole("progressbar")).toBeVisible();
  await expect(operationIsland).toContainText(/剩余 \d+ 秒/);
  await expect(operationIsland.getByRole("button", { name: "取消" })).toBeVisible();
  await expect(operationIsland).not.toContainText("countdown");
  await page.screenshot({ path: testInfo.outputPath(`ux02-${testInfo.project.name}.png`) });
  await expect(operationIsland).toContainText("正在请求服务器关闭。", { timeout: 2_500 });
  await expect(operationIsland).toContainText("服务器已完全关闭。", { timeout: 2_500 });
  await expect(operationIsland).toBeHidden({ timeout: 5_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
