import { expect, test } from "@playwright/test";

const health = {
  observedAt: 1_786_000_000,
  capacity: {
    state: "blocked",
    freeBytes: 640 * 1024 * 1024,
    totalBytes: 2 * 1024 * 1024 * 1024,
    minimumFreeBytes: 512 * 1024 * 1024,
    copyBytes: 256 * 1024 * 1024,
    requiredFreeBytes: 768 * 1024 * 1024,
    warningFreeBytes: 1024 * 1024 * 1024,
    sourceErrorCode: null,
    errorCode: null,
  },
  directories: [
    { name: "runtime-data", label: "运行数据", path: "C:\\data", state: "ok", sizeBytes: 512, fileCount: 4, freeBytes: 640 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, errorCode: null },
    { name: "application-logs", label: "应用日志", path: "C:\\data\\logs", state: "ok", sizeBytes: 256, fileCount: 2, freeBytes: 640 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, errorCode: null },
    { name: "cache", label: "解析缓存", path: "C:\\data\\cache", state: "warning", sizeBytes: 1024, fileCount: 1, freeBytes: 640 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, errorCode: "REPARSE_POINT_SKIPPED" },
    { name: "snapshots", label: "存档快照", path: "C:\\data\\snapshots", state: "no_data", sizeBytes: 0, fileCount: 0, freeBytes: 640 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, errorCode: null },
    { name: "official-backups", label: "官方备份", path: "C:\\world\\backup\\world", state: "ok", sizeBytes: 2048, fileCount: 3, freeBytes: 640 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, errorCode: null },
  ],
  world: { state: "failed", lastSuccessAt: 1_785_900_000, snapshotId: "old", parsing: false, errorCode: "PARSER_CRASHED", cacheSizeBytes: 1024 },
  backups: { state: "stale", lastSuccessAt: 1_785_000_000, itemCount: 2, validCount: 2, invalidCount: 0, totalBytes: 2048, errorCode: null },
  background: [
    { name: "live-monitor", state: "healthy", alive: true, startedAt: 1_786_000_000, lastSuccessAt: 1_786_000_000, lastRunAt: 1_786_000_000, errorCode: null },
    { name: "audit-log", state: "stopped", alive: false, startedAt: 1_785_000_000, lastSuccessAt: 1_785_900_000, lastRunAt: 1_785_900_000, errorCode: null },
    { name: "world-snapshot", state: "failed", alive: true, startedAt: 1_786_000_000, lastSuccessAt: 1_785_900_000, lastRunAt: 1_786_000_000, errorCode: "PARSER_CRASHED" },
  ],
  alerts: [{ severity: "critical", code: "DISK_SPACE_LOW", message: "运行数据磁盘空间不足，下次存档快照复制将被阻止。" }],
};

test("OPT-13 总览展示容量风险并要求清理预览", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: true, adminPasswordConfigured: false,
    csrfToken: "opt13-csrf", lanWarning: null, port: 8223,
  } }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: {
    source: "console", observedAt: 1_786_000_000, stale: false, errorCode: null,
    module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer.exe",
  } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: health }));
  await page.route("**/api/world/storage/cleanup-preview", (route) => route.fulfill({ json: {
    state: "ready", previewToken: "preview-token-123456", expiresAt: 1_786_000_300,
    candidateCount: 2, totalBytes: 1024, errors: 0,
    candidates: [{ kind: "temporary", name: ".world-cache.tmp.sqlite", sizeBytes: 1024 }],
  } }));

  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "维护" }).click();

  await expect(page.getByRole("heading", { name: "运维健康与容量" })).toBeVisible();
  await expect(page.getByText("运行数据磁盘空间不足，下次存档快照复制将被阻止。")).toBeVisible();
  await expect(page.getByText("后台已停止", { exact: true })).toBeVisible();
  await expect(page.getByText("解析失败").first()).toBeVisible();
  await page.getByRole("button", { name: "预览清理" }).click();
  await expect(page.getByText("已生成清理预览，确认前不会删除任何文件。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认清理 2 项" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`opt13-overview-${testInfo.project.name}.png`), fullPage: true });
});
