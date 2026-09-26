import { expect, test, type Page } from "@playwright/test";

const auth = {
  local: true,
  authenticated: true,
  adminPasswordConfigured: true,
  csrfToken: "maintenance-health-csrf",
  lanWarning: null,
  port: 8223,
};

const shell = {
  source: "console",
  observedAt: 1_786_000_000,
  stale: false,
  errorCode: null,
  module: "M2",
  serverState: "stopped",
  configured: true,
  pids: [],
  executablePath: "C:\\PalServer\\PalServer.exe",
  instanceId: "world-1",
};

const health = {
  observedAt: 1_786_000_000,
  capacity: { state: "ok", freeBytes: 100, totalBytes: 200, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null },
  directories: [],
  world: { state: "healthy", lastSuccessAt: 1_786_000_000, snapshotId: "world", parsing: false, errorCode: null, cacheSizeBytes: 0 },
  backups: { state: "healthy", lastSuccessAt: 1_786_000_000, itemCount: 1, validCount: 1, invalidCount: 0, totalBytes: 128, errorCode: null },
  background: [],
  alerts: [],
};

type UpdateRouteOptions = {
  status?: Partial<{ currentVersion: string; latestVersion: string; updateAvailable: boolean; portable: boolean; releaseUrl: string | null }>;
  unavailableChecks?: number;
  statusByRequest?: (count: number) => Partial<{ latestVersion: string; updateAvailable: boolean; stale: boolean }>;
  progress?: { state: string; step: number; message: string; updateId?: string; errorCode?: string; updatedAt?: number };
};

async function routeMaintenanceApis(page: Page, healthFailure: boolean, onHealthRequest: () => void, update: UpdateRouteOptions = {}) {
  let updatePosted = false;
  let updateHandedOff = false;
  let updateStatusRequests = 0;
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/maintenance/notifications", route => route.fulfill({ json: { enabled: false, configured: false } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: shell }));
  await page.route("**/api/operations/health", (route) => {
    onHealthRequest();
    return healthFailure
      ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ errorCode: "HEALTH_UNAVAILABLE", message: "health unavailable" }) })
      : route.fulfill({ json: health });
  });
  await page.route("**/api/backups", (route) => route.fulfill({ json: {
    items: [], retention: null, worldPath: "C:\\PalServer\\world", backupRoot: "C:\\PalServer\\backup",
    restoreRecovery: { active: false, journal: null }, observedAt: 1, stale: false, errorCode: null,
  } }));
  await page.route("**/api/backups/restore/recovery", (route) => route.fulfill({ json: { active: false, journal: null } }));
  await page.route(/\/api\/maintenance\/application-update(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      updatePosted = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      updateHandedOff = true;
      return route.fulfill({ json: { message: "更新包已校验，控制台将退出并完成升级。", version: "0.3.0", restartScheduled: true } });
    }
    updateStatusRequests += 1;
    if (updateStatusRequests <= (update.unavailableChecks ?? 0)) {
      return route.fulfill({ json: { state: "unavailable", errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed" } });
    }
    return route.fulfill({ json: {
      currentVersion: "0.2.0",
      latestVersion: "0.3.0",
      updateAvailable: true,
      portable: true,
      releaseUrl: "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.3.0",
      publishedAt: "2026-08-27T00:00:00Z",
      assetSizeBytes: 123,
      releaseNotes: ["新增右上角升级入口", "优化升级状态反馈"],
      ...update.status,
      ...update.statusByRequest?.(updateStatusRequests),
    } });
  });
  await page.route("**/api/maintenance/application-update/progress", (route) => route.fulfill({ json: {
    ...(update.progress ?? (updatePosted
      ? updateHandedOff
        ? { state: "restart_scheduled", step: 4, message: "更新包已校验，控制台将退出并完成升级。" }
        : { state: "validating", step: 3, message: "正在解压并校验更新包结构。" }
      : { state: "idle", step: 0, message: "等待开始升级。" })),
  } }));
}

async function openMaintenance(page: Page) {
  await page.getByRole("button", { name: "维护", exact: true }).click();
}

async function expectHealthSummary(page: Page, label: string, mobile: boolean) {
  const summary = page.getByText(label, { exact: true });
  if (mobile) {
    await expect(summary).toBeAttached();
  } else {
    await expect(summary).toBeVisible();
  }
}

test("维护：服务运维入口保留更新弹窗，健康页支持刷新", async ({ page }, testInfo) => {
  let healthRequests = 0;
  await routeMaintenanceApis(page, false, () => { healthRequests += 1; });

  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "控制台版本更新" })).toBeVisible();
  const updateTrigger = page.getByRole("button", { name: "查看 PalServerConsole v0.3.0 更新详情" });
  const broadcastHeight = (await page.getByRole("button", { name: "发送全服广播" }).boundingBox())?.height;
  if (!broadcastHeight) throw new Error("广播入口未渲染");
  await expect.poll(async () => (await updateTrigger.boundingBox())?.height).toBe(broadcastHeight);
  await updateTrigger.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "PalServerConsole 控制台升级" })).toBeVisible();
  const closeButton = page.getByRole("button", { name: "关闭" });
  await expect.poll(async () => (await closeButton.boundingBox())?.width).toBeGreaterThanOrEqual(40);
  await expect.poll(async () => (await closeButton.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  if (testInfo.project.name === "mobile") {
    const titleBox = await page.getByRole("heading", { name: "PalServerConsole 控制台升级" }).boundingBox();
    const iconBox = await page.locator(".psc-update-icon").boundingBox();
    expect(titleBox && iconBox && titleBox.y < iconBox.y).toBeTruthy();
  }
  await expect(page.getByText("新增右上角升级入口", { exact: true })).toBeVisible();
  const installButton = page.getByRole("button", { name: "升级并重启" });
  await expect(installButton).toBeVisible();
  await expect.poll(async () => (await installButton.boundingBox())?.height).toBeGreaterThanOrEqual(40);
  const requiredBackup = page.getByRole("checkbox", { name: "升级前自动备份（强制启用）" });
  await expect(requiredBackup).toBeChecked();
  await expect(requiredBackup).toBeDisabled();
  await page.getByRole("button", { name: "升级并重启" }).click();
  await expect(page.getByText("正在准备控制台升级...", { exact: true })).toBeVisible();
  await expect(page.getByText("3. 解压并校验更新包结构", { exact: true })).toBeVisible();
  await expect(page.getByText("更新包已校验，控制台将退出并完成升级。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "知道了" }).click();
  await page.getByRole("tab", { name: "健康与容量" }).click();
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");

  const requestsBeforeRefresh = healthRequests;
  await page.getByRole("button", { name: "刷新维护状态" }).click();
  await expect.poll(() => healthRequests).toBeGreaterThan(requestsBeforeRefresh);
});

test("维护：备份入口与健康分区可切换", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, false, () => undefined);

  await page.goto("/#maintenance-backups");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
  await page.getByRole("tab", { name: "健康与容量" }).click();
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");
});

test("维护：健康请求失败时服务运维与其他分区仍可用", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, true, () => undefined);

  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "控制台版本更新" })).toBeVisible();
  await page.getByRole("tab", { name: "健康与容量" }).click();
  await expectHealthSummary(page, "需要关注", testInfo.project.name === "mobile");

  await page.getByRole("tab", { name: "官方备份" }).click();
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
});

test("升级结果：控制台重启后恢复已完成状态", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, {
    status: { currentVersion: "0.3.0", latestVersion: "0.3.0", updateAvailable: false },
    progress: { state: "completed", step: 4, message: "控制台已完成升级并重新启动。", updateId: "completed-update" },
  });

  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("控制台已完成升级并重新启动。", { exact: true })).toBeVisible();
  await expect(page.locator(".psc-update-progress li[data-state='done']")).toHaveCount(4);
});

test("升级结果：有可用更新时仍显示上次失败原因", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, {
    progress: {
      state: "failed",
      step: 0,
      message: "升级任务已中断，请重新发起升级。",
      updateId: "failed-update",
      errorCode: "APPLICATION_UPDATE_INTERRUPTED",
    },
  });

  await page.goto("/");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "升级失败" })).toBeVisible();
  await expect(page.getByText("APPLICATION_UPDATE_INTERRUPTED", { exact: true })).toBeVisible();
  await expect(page.getByText("新增右上角升级入口", { exact: true })).not.toBeVisible();
});

test("源码模式：升级弹窗保留 Release 下载入口", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, { status: { portable: false } });

  await page.goto("/");
  await page.getByRole("button", { name: "查看 PalServerConsole v0.3.0 更新详情" }).click();
  await expect(page.getByRole("link", { name: "查看 Release" })).toHaveAttribute(
    "href",
    "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.3.0",
  );
});

test("更新检查失败：隐藏入口并稍后自动重试", async ({ page }) => {
  // React StrictMode runs the mount effect twice in development.
  await routeMaintenanceApis(page, false, () => undefined, { unavailableChecks: 2 });

  let failedChecks = 0;
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/maintenance/application-update" && (await response.json()).state === "unavailable") failedChecks += 1;
  });
  await page.clock.install();
  await page.goto("/");
  await expect.poll(() => failedChecks).toBe(2);
  await expect(page.getByRole("button", { name: /PalServerConsole.*更新/ })).toHaveCount(0);
  await page.waitForTimeout(100);
  await page.clock.fastForward(15 * 60 * 1000);
  const update = page.getByRole("button", { name: "查看 PalServerConsole v0.3.0 更新详情" });
  await expect(update.locator(".psc-update-label")).toHaveText("更新");
  const broadcast = page.getByRole("button", { name: "发送全服广播" });
  const theme = page.getByRole("combobox", { name: /选择界面主题/ });
  const updateBox = await update.boundingBox();
  const broadcastBox = await broadcast.boundingBox();
  const themeBox = await theme.boundingBox();
  if (!updateBox || !broadcastBox || !themeBox) throw new Error("顶栏操作未完整渲染");
  expect(updateBox.x + updateBox.width).toBeLessThanOrEqual(broadcastBox.x);
  expect(updateBox.height).toBe(broadcastBox.height);
  expect(updateBox.height).toBe(themeBox.height);
  await page.locator(".psc-topbar").screenshot({ path: test.info().outputPath("update-available-topbar.png") });
  await update.click();
  await expect(page.getByRole("dialog").getByText("目标: 0.3.0", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "升级并重启" })).toBeVisible();
  await page.getByRole("dialog").screenshot({ path: test.info().outputPath("update-dialog.png") });
});

test("控制台长期打开：暂无更新和旧缓存之后仍定期检查", async ({ page }) => {
  let latestVersion = "0.2.0";
  let stale = false;
  let checks = 0;
  await routeMaintenanceApis(page, false, () => undefined, {
    statusByRequest: () => ({ latestVersion, updateAvailable: latestVersion !== "0.2.0", stale }),
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/maintenance/application-update") checks += 1;
  });
  await page.clock.install();
  await page.goto("/");
  await expect.poll(() => checks).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(100);
  await expect(page.getByRole("button", { name: /PalServerConsole.*更新/ })).toHaveCount(0);

  const initialChecks = checks;
  stale = true;
  await page.clock.fastForward(15 * 60 * 1000);
  await page.waitForTimeout(100);
  expect(checks).toBe(initialChecks);
  await page.clock.fastForward(24 * 60 * 60 * 1000 - 15 * 60 * 1000);
  await expect.poll(() => checks).toBeGreaterThan(initialChecks);
  await expect(page.getByRole("button", { name: /PalServerConsole.*更新/ })).toHaveCount(0);

  const staleChecks = checks;
  latestVersion = "0.3.0";
  stale = false;
  await page.clock.fastForward(15 * 60 * 1000);
  await expect.poll(() => checks).toBeGreaterThan(staleChecks);
  await expect(page.getByRole("button", { name: "查看 PalServerConsole v0.3.0 更新详情" })).toBeVisible();
  await page.waitForTimeout(100);
  const successfulChecks = checks;
  await page.clock.fastForward(15 * 60 * 1000);
  await page.waitForTimeout(100);
  expect(checks).toBe(successfulChecks);
  await page.clock.fastForward(24 * 60 * 60 * 1000 - 15 * 60 * 1000);
  await expect.poll(() => checks).toBeGreaterThan(successfulChecks);
});

test("已发现更新：后续检查不可用时保留上次结果", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined);
  let mode: "ready" | "unavailable" | "network-failure" = "ready";
  let unavailableChecks = 0;
  let networkFailures = 0;
  await page.route("**/api/maintenance/application-update", (route) => {
    if (route.request().method() !== "GET" || mode === "ready") return route.fallback();
    if (mode === "network-failure") return route.abort("failed");
    return route.fulfill({ json: { state: "unavailable", errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed" } });
  });
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/maintenance/application-update" && (await response.json()).state === "unavailable") unavailableChecks += 1;
  });
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === "/api/maintenance/application-update") networkFailures += 1;
  });
  await page.clock.install();
  await page.goto("/");
  const update = page.getByRole("button", { name: "查看 PalServerConsole v0.3.0 更新详情" });
  await expect(update).toBeVisible();
  await page.waitForTimeout(100);

  mode = "unavailable";
  await page.clock.fastForward(24 * 60 * 60 * 1000);
  await expect.poll(() => unavailableChecks).toBeGreaterThan(0);
  await expect(update).toBeVisible();
  await update.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("暂时无法确认最新版本，当前显示上次检查结果；升级前会重新核对版本。")).toBeVisible();

  mode = "network-failure";
  await page.clock.fastForward(15 * 60 * 1000);
  await expect.poll(() => networkFailures).toBeGreaterThan(0);
  await page.waitForTimeout(100);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "稍后提醒" }).click();
  await expect(update).toBeVisible();
});

test("手动检查控制台更新：加载、无更新、失败与发现新版本", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, {
    status: { latestVersion: "0.2.0", updateAvailable: false },
  });
  let mode: "latest" | "failed" | "available" = "latest";
  let forcedChecks = 0;
  let finishCheck: (() => void) | undefined;
  await page.route("**/api/maintenance/application-update?force=true", async (route) => {
    forcedChecks += 1;
    await new Promise<void>((resolve) => { finishCheck = resolve; });
    if (mode === "failed") return route.fulfill({ json: {
      state: "unavailable", errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed",
    } });
    return route.fulfill({ json: {
      currentVersion: "0.2.0", latestVersion: mode === "available" ? "0.3.0" : "0.2.0",
      updateAvailable: mode === "available", portable: true, releaseNotes: ["手动检查发现新版本"],
    } });
  });

  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  const check = page.getByRole("button", { name: "检查控制台更新", exact: true });
  await expect(check).toBeVisible();
  await page.getByRole("combobox", { name: /选择界面主题/ }).click();
  await page.getByRole("option", { name: /灵动海岛/ }).click();
  await check.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("manual-update-page.png"), fullPage: true });
  await page.screenshot({ path: test.info().outputPath("manual-update-viewport.png") });
  await check.screenshot({ path: test.info().outputPath("manual-update-button-island.png") });
  await page.getByRole("combobox", { name: /选择界面主题/ }).click();
  await page.getByRole("option", { name: /深邃夜色/ }).click();
  await expect(check).toHaveCSS("background-color", "rgb(49, 69, 72)");
  await check.screenshot({ path: test.info().outputPath("manual-update-button-dark.png") });
  await page.getByRole("combobox", { name: /选择界面主题/ }).click();
  await page.getByRole("option", { name: /极简/ }).click();
  await expect(check).toHaveCSS("background-color", "oklch(0.546 0.245 262.881)");
  await check.screenshot({ path: test.info().outputPath("manual-update-button-light.png") });

  await check.click();
  const loading = page.getByRole("button", { name: "正在检查控制台更新..." });
  await expect(loading).toBeDisabled();
  await expect.poll(() => forcedChecks).toBe(1);
  await loading.screenshot({ path: test.info().outputPath("manual-update-button-loading.png") });
  finishCheck?.();
  await expect(page.getByText("PalServerConsole v0.2.0 已是最新版本。", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /查看 PalServerConsole.*更新/ })).toHaveCount(0);

  mode = "failed";
  await check.click();
  await expect.poll(() => forcedChecks).toBe(2);
  finishCheck?.();
  await expect(page.getByRole("alert")).toHaveText("RELEASE_CHECK_FAILED: GitHub Release check failed");
  await expect(page.getByRole("button", { name: /查看 PalServerConsole.*更新/ })).toHaveCount(0);

  mode = "available";
  await check.click();
  await expect.poll(() => forcedChecks).toBe(3);
  finishCheck?.();
  await expect(page.getByRole("dialog").getByText("手动检查发现新版本", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByText("目标: 0.3.0", { exact: true })).toBeVisible();
});

test("手动检查后：失败改为15分钟重试，成功恢复24小时", async ({ page }) => {
  let normalChecks = 0;
  let failed = true;
  await routeMaintenanceApis(page, false, () => undefined, {
    statusByRequest: () => {
      normalChecks += 1;
      return { latestVersion: "0.2.0", updateAvailable: false };
    },
  });
  await page.route("**/api/maintenance/application-update?force=true", (route) => route.fulfill({ json: failed
    ? { state: "unavailable", errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed" }
    : { currentVersion: "0.2.0", latestVersion: "0.2.0", updateAvailable: false, portable: true, releaseNotes: [] },
  }));
  await page.clock.install();
  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect.poll(() => normalChecks).toBeGreaterThan(0);
  await page.clock.fastForward(60 * 60 * 1000);
  const check = page.getByRole("button", { name: "检查控制台更新", exact: true });
  await check.click();
  await expect(page.getByRole("alert")).toHaveText("RELEASE_CHECK_FAILED: GitHub Release check failed");
  await page.waitForTimeout(100);
  const beforeRetry = normalChecks;
  await page.clock.fastForward(15 * 60 * 1000);
  await expect.poll(() => normalChecks).toBeGreaterThan(beforeRetry);

  failed = false;
  await page.clock.fastForward(45 * 60 * 1000);
  await check.click();
  await expect(page.getByText("PalServerConsole v0.2.0 已是最新版本。", { exact: true })).toBeVisible();
  await page.waitForTimeout(100);
  const beforeDailyCheck = normalChecks;
  await page.clock.fastForward(23 * 60 * 60 * 1000 + 15 * 60 * 1000);
  await page.waitForTimeout(100);
  expect(normalChecks).toBe(beforeDailyCheck);
  await page.clock.fastForward(45 * 60 * 1000);
  await expect.poll(() => normalChecks).toBeGreaterThan(beforeDailyCheck);
});
test("服务运维：后台检查同步手动提示，失败后恢复不残留错误", async ({ page }) => {
  let latestVersion = "0.2.0";
  let failed = false;
  await routeMaintenanceApis(page, false, () => undefined, {
    statusByRequest: () => ({ latestVersion, updateAvailable: latestVersion !== "0.2.0" }),
  });
  await page.route("**/api/maintenance/application-update?force=true", route => route.fulfill({ json: failed
    ? { state: "unavailable", errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed" }
    : { currentVersion: "0.2.0", latestVersion, updateAvailable: latestVersion !== "0.2.0", portable: true, releaseNotes: [] },
  }));
  await page.clock.install();
  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  const check = page.getByRole("button", { name: "检查控制台更新", exact: true });
  await check.click();
  const oldConclusion = page.getByText("PalServerConsole v0.2.0 已是最新版本。", { exact: true });
  await expect(oldConclusion).toBeVisible();
  latestVersion = "0.3.0";
  await page.clock.fastForward(24 * 60 * 60 * 1000);
  await expect(page.locator(".maintenance-version-summary")).toContainText("v0.3.0（可更新）");
  await expect(oldConclusion).toHaveCount(0);
  await expect(page.getByText("发现控制台新版本 v0.3.0。", { exact: true })).toBeVisible();
  failed = true;
  await check.click();
  await expect(page.getByRole("alert")).toHaveText("RELEASE_CHECK_FAILED: GitHub Release check failed");
  await expect(page.getByText("发现控制台新版本 v0.3.0。", { exact: true })).toHaveCount(0);
  await page.clock.fastForward(15 * 60 * 1000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("发现控制台新版本 v0.3.0。", { exact: true })).toBeVisible();
});

test("服务运维：保存通知设置、使用已保存连接测试并保留失败信息", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, { status: { latestVersion: "0.2.0", updateAvailable: false } });
  const saved: object[] = [];
  let testRequests = 0;
  let failTest = false;
  await page.route("**/api/maintenance/notifications", async route => {
    if (route.request().method() === "PUT") {
      expect(route.request().headers()["x-csrf-token"]).toBe(auth.csrfToken);
      saved.push(route.request().postDataJSON());
      return route.fulfill({ json: { enabled: route.request().postDataJSON().enabled, configured: true } });
    }
    return route.fulfill({ json: { enabled: false, configured: false } });
  });
  await page.route("**/api/maintenance/notifications/test", route => {
    testRequests += 1;
    expect(route.request().headers()["x-csrf-token"]).toBe(auth.csrfToken);
    expect(route.request().postDataJSON()).toEqual({});
    return failTest
      ? route.fulfill({ status: 502, json: { errorCode: "NOTIFICATION_TEST_FAILED", message: "Test notification delivery failed." } })
      : route.fulfill({ json: { message: "测试告警消息已发送。" } });
  });
  await page.goto("/#maintenance-notifications");
  await openMaintenance(page);
  await expect(page.getByRole("tab", { name: "服务运维与告警" })).toHaveAttribute("aria-selected", "true");
  const sendTest = page.getByRole("button", { name: "发送测试告警消息", exact: true });
  await expect(sendTest).toBeDisabled();
  await page.getByLabel("HTTPS Webhook 地址").fill("https://notify.example.test/maintenance");
  await page.getByLabel("Webhook 密钥").fill("synthetic-test-secret");
  await page.getByLabel("启用服务器运维事件推送").check();
  await page.getByRole("button", { name: "保存通知设置", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("运维事件推送已启用。");
  expect(saved[0]).toEqual({ enabled: true, webhookUrl: "https://notify.example.test/maintenance", secret: "synthetic-test-secret" });
  await expect(page.getByLabel("Webhook 密钥")).toHaveValue("");
  await expect(page.getByLabel("HTTPS Webhook 地址")).toHaveValue("");
  await sendTest.click();
  await expect(page.getByRole("status")).toHaveText("测试告警消息已发送。");
  expect(testRequests).toBe(1);
  await page.getByLabel("HTTPS Webhook 地址").fill("https://changed.example.test/webhook");
  await expect(sendTest).toBeDisabled();
  await page.getByLabel("HTTPS Webhook 地址").fill("");
  failTest = true;
  await sendTest.click();
  await expect(page.getByRole("alert")).toHaveText("NOTIFICATION_TEST_FAILED: Test notification delivery failed.");
  await page.getByLabel("启用服务器运维事件推送").uncheck();
  await page.getByRole("button", { name: "保存通知设置", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("自动推送已停用");
  expect(saved[1]).toEqual({ enabled: false });
  await expect(sendTest).toBeEnabled();
});

test("服务运维：LAN 可检查版本，通知配置和测试只读", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined, { status: { latestVersion: "0.2.0", updateAvailable: false } });
  await page.route("**/api/auth/status", route => route.fulfill({ json: { ...auth, local: false } }));
  await page.route("**/api/maintenance/notifications", route => route.fulfill({ json: { enabled: true, configured: true } }));
  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("button", { name: "检查控制台更新", exact: true })).toBeEnabled();
  await expect(page.getByLabel("HTTPS Webhook 地址")).toBeDisabled();
  await expect(page.getByLabel("Webhook 密钥")).toBeDisabled();
  await expect(page.getByRole("button", { name: "保存通知设置", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "发送测试告警消息", exact: true })).toBeDisabled();
});

test("服务运维：通知读取失败禁止覆盖设置，并可重试", async ({ page }) => {
  await routeMaintenanceApis(page, false, () => undefined);
  let failed = true;
  await page.route("**/api/maintenance/notifications", route => failed
    ? route.fulfill({ status: 503, json: { errorCode: "NOTIFICATION_UNAVAILABLE", message: "Notification settings unavailable" } })
    : route.fulfill({ json: { enabled: true, configured: true } }));
  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("alert")).toContainText("NOTIFICATION_UNAVAILABLE");
  await expect(page.getByRole("button", { name: "保存通知设置", exact: true })).toBeDisabled();
  failed = false;
  await page.getByRole("button", { name: "重试读取通知设置" }).click();
  await expect(page.getByLabel("启用服务器运维事件推送")).toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("服务运维：参考双栏布局、手机单栏与三种主题", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, false, () => undefined, { status: { latestVersion: "0.2.0", updateAvailable: false } });
  await page.route("**/api/maintenance/notifications", route => route.fulfill({ json: { enabled: true, configured: true } }));
  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("tablist", { name: "维护分区" }).getByRole("tab")).toHaveCount(4);
  await expect(page.getByRole("heading", { name: "控制台版本更新" })).toBeVisible();
  await expect(page.getByLabel("启用服务器运维事件推送")).toBeChecked();
  await expect(page.getByText("低频运维工作区")).toHaveCount(0);
  await expect(page.getByText(/SteamCMD|steamcmd.exe/)).toHaveCount(0);
  const cards = page.locator(".maintenance-services-grid > section");
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(first && second && (testInfo.project.name === "mobile" ? second.y > first.y + first.height : second.y === first.y)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const [theme, label] of [["island", /灵动海岛/], ["dark", /深邃夜色/], ["light", /极简/]] as const) {
    await page.getByRole("combobox", { name: /选择界面主题/ }).click();
    await page.getByRole("option", { name: label }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: testInfo.outputPath(`services-${theme}-${testInfo.project.name}.png`), fullPage: true });
    await page.locator(".maintenance-page").screenshot({ path: testInfo.outputPath(`services-module-${theme}-${testInfo.project.name}.png`), style: ".psc-topbar, .psc-mobile-navigation { visibility: hidden !important; }" });
  }
});
