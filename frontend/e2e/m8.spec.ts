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
    executablePath: "C:\\PalServer\\PalServer.exe",
  } }));
  const liveSnapshot = {
    info: { data: { version: "v0.6.1", worldName: "测试世界" }, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    players: { data: [], source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
    metrics: { data: { server: { serverFps: 60 }, process: { pids: [], cpuPercent: 0, memoryBytes: 0, diskReadBytes: 0, diskWriteBytes: 0 } }, source: "rest+process", observedAt: 1_786_000_000, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1_786_000_000, stale: false, errorCode: null },
  };
  for (const key of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${key}`, (route) => route.fulfill({ json: liveSnapshot[key] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `event: snapshot\ndata: ${JSON.stringify(liveSnapshot)}\n\n`,
  }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: {
    executablePath: "C:\\PalServer\\PalServer.exe", launchArguments: "",
  } }));
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
  await page.getByRole("button", { name: "服务器管理" }).click();
  await expect(page.getByRole("heading", { name: "PalServer 安装" })).toBeVisible();

  await page.getByRole("button", { name: "启动" }).click();
  await expect(page.getByRole("alert")).toContainText("OPERATION_IN_PROGRESS");
  await page.getByRole("button", { name: "启动" }).click();
  await expect(page.getByText("start · process_running")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("succeeded")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`m8-operation-${testInfo.project.name}.png`), fullPage: true });
});
