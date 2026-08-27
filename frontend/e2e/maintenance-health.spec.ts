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

async function routeMaintenanceApis(page: Page, healthFailure: boolean, onHealthRequest: () => void) {
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
  await page.route("**/api/maintenance/application-update", (route) => route.fulfill({ json: {
    currentVersion: "0.2.0",
    latestVersion: "0.3.0",
    updateAvailable: true,
    portable: true,
    releaseUrl: "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.3.0",
    publishedAt: "2026-08-27T00:00:00Z",
    assetSizeBytes: 123,
  } }));
}

async function openMaintenance(page: Page, mobile: boolean) {
  if (mobile) await page.getByTitle("打开菜单").click();
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
  await openMaintenance(page, testInfo.project.name === "mobile");
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "PalServerConsole 更新" })).toBeVisible();
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.getByText("发现新版本 v0.3.0。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "更新至 v0.3.0" })).toBeVisible();
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");

  const requestsBeforeRefresh = healthRequests;
  await page.getByRole("button", { name: "刷新维护状态" }).click();
  await expect.poll(() => healthRequests).toBeGreaterThan(requestsBeforeRefresh);
});

test("Block 3：直接进入 backups hash 也加载顶部健康状态", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, false, () => undefined);

  await page.goto("/#maintenance-backups");
  await openMaintenance(page, testInfo.project.name === "mobile");
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
  await expectHealthSummary(page, "运行正常", testInfo.project.name === "mobile");
});

test("Block 3：health 请求失败时非 health Tab 仍可用并显示需要关注", async ({ page }, testInfo) => {
  await routeMaintenanceApis(page, true, () => undefined);

  await page.goto("/#maintenance-update");
  await openMaintenance(page, testInfo.project.name === "mobile");
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeVisible();
  await expectHealthSummary(page, "需要关注", testInfo.project.name === "mobile");

  await page.getByRole("tab", { name: "官方备份" }).click();
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
});
