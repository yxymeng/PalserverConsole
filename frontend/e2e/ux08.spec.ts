import { expect, test } from "@playwright/test";

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux08-csrf", lanWarning: null, port: 8223 };
const shell = { source: "console", observedAt: 1_786_000_000, stale: false, errorCode: null, module: "M2", serverState: "running", configured: true, pids: [8211], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-1" };

test("UX-08：低频维护能力集中并保留备份危险操作确认", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: shell }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: shell.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: {
    observedAt: 1, capacity: { state: "ok", freeBytes: 100, totalBytes: 200, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null }, directories: [], world: { state: "healthy", lastSuccessAt: 1, snapshotId: "world", parsing: false, errorCode: null, cacheSizeBytes: 0 }, backups: { state: "healthy", lastSuccessAt: 1, itemCount: 1, validCount: 1, invalidCount: 0, totalBytes: 128, errorCode: null }, background: [], alerts: [],
  } }));
  await page.route("**/api/maintenance/notifications", (route) => route.fulfill({ json: { enabled: true, configured: true } }));
  await page.route("**/api/backups", (route) => route.fulfill({ json: {
    items: [{ id: "backup-1", observedAt: 1_786_000_000, sizeBytes: 128, valid: true, missing: [] }], retention: null, worldPath: "C:\\PalServer\\world", backupRoot: "C:\\PalServer\\backup", restoreRecovery: { active: false, journal: null }, observedAt: 1, stale: false, errorCode: null,
  } }));
  await page.route("**/api/backups/restore/recovery", (route) => route.fulfill({ json: { active: false, journal: null } }));
  await page.route(/\/api\/audit(?:\?.*)?$/, (route) => route.fulfill({ json: {
    items: [{ id: 1, eventType: "server.operation", result: "success", source: "console", detail: { kind: "start" }, createdAt: 1_786_000_000, parserVersion: "v1" }], page: 1, pageSize: 25, total: 1, observedAt: 1,
  } }));
  await page.route("**/api/audit/settings", (route) => route.fulfill({ json: { retentionDays: 30 } }));
  await page.route("**/api/audit/capabilities", (route) => route.fulfill({ json: { chatSupported: true, commandSupported: true, message: "审计能力可用" } }));
  const liveSnapshot = {
    info: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
    players: { data: [], source: "rest", observedAt: 1, stale: false, errorCode: null },
    metrics: { data: { process: { pids: [], cpuPercent: 0, memoryBytes: 0, diskReadBytes: 0, diskWriteBytes: 0, startedAt: null } }, source: "rest", observedAt: 1, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));

  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "维护" }).click();

  const sections = page.getByRole("tablist", { name: "维护分区" });
  await expect(sections.getByRole("tab")).toHaveCount(5);
  await expect(sections.getByRole("tab", { name: "健康与容量" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "运维健康与容量" })).toBeVisible();
  await sections.getByRole("tab", { name: "服务器更新" }).click();
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeHidden();
  await sections.getByRole("tab", { name: "官方备份" }).click();
  await expect(page.getByRole("heading", { name: "官方备份" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "服务器更新" })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "保留数量" })).toBeVisible();
  await expect(page.getByText("infinite", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复" })).toBeVisible();
  await page.getByRole("button", { name: "删除" }).click();
  const deleteDialog = page.getByRole("alertdialog");
  await expect(deleteDialog).toContainText("删除历史备份 backup-1");
  await deleteDialog.getByRole("button", { name: "取消" }).click();
  await sections.getByRole("tab", { name: "运营审计" }).click();
  await expect(page.getByRole("heading", { name: "运营审计" })).toBeVisible();
  await expect(page.locator(".audit-table-row")).toBeVisible();
  expect(await page.locator(".audit-table-row").evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true);
  await sections.getByRole("tab", { name: "维护通知" }).click();
  await expect(page.getByRole("heading", { name: "维护通知" })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`ux08-${testInfo.project.name}.png`), fullPage: true });
});
