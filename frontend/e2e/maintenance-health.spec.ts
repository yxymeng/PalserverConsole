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
  statusFailures?: number;
  progress?: { state: string; step: number; message: string; updateId?: string; errorCode?: string; updatedAt?: number };
};

async function routeMaintenanceApis(page: Page, healthFailure: boolean, onHealthRequest: () => void, update: UpdateRouteOptions = {}) {
  let updatePosted = false;
  let updateHandedOff = false;
  let updateStatusRequests = 0;
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
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
  await page.route("**/api/maintenance/application-update", async (route) => {
    if (route.request().method() === "POST") {
      updatePosted = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      updateHandedOff = true;
      return route.fulfill({ json: { message: "更新包已校验，控制台将退出并完成升级。", version: "0.3.0", restartScheduled: true } });
    }
    updateStatusRequests += 1;
    if (updateStatusRequests <= (update.statusFailures ?? 0)) {
      return route.fulfill({ status: 502, json: { errorCode: "RELEASE_CHECK_FAILED", message: "GitHub Release check failed" } });
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

test("Block 3：非 health hash 加载顶部健康状态并支持刷新", async ({ page }, testInfo) => {
  let healthRequests = 0;
  await routeMaintenanceApis(page, false, () => { healthRequests += 1; });

  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeVisible();
  const updateTrigger = page.getByRole("button", { name: "升级 PalServerConsole 至 v0.3.0" });
  await expect.poll(async () => (await updateTrigger.boundingBox())?.height).toBeGreaterThanOrEqual(40);
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
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");

  const requestsBeforeRefresh = healthRequests;
  await page.getByRole("button", { name: "刷新维护状态" }).click();
  await expect.poll(() => healthRequests).toBeGreaterThan(requestsBeforeRefresh);
});

test("Block 3：直接进入 backups hash 也加载顶部健康状态", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, false, () => undefined);

  await page.goto("/#maintenance-backups");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");
});

test("Block 3：health 请求失败时非 health Tab 仍可用并显示需要关注", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, true, () => undefined);

  await page.goto("/#maintenance-update");
  await openMaintenance(page);
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeVisible();
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
  await page.getByRole("button", { name: "升级 PalServerConsole 至 v0.3.0" }).click();
  await expect(page.getByRole("link", { name: "查看 Release" })).toHaveAttribute(
    "href",
    "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.3.0",
  );
});

test("更新检查失败：显示错误并支持重新检查", async ({ page }) => {
  // React StrictMode runs the mount effect twice in development.
  await routeMaintenanceApis(page, false, () => undefined, { statusFailures: 2 });

  await page.goto("/");
  await page.getByRole("button", { name: "PalServerConsole 更新检查失败" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("RELEASE_CHECK_FAILED");
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("目标: 0.3.0", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "升级并重启" })).toBeVisible();
});
