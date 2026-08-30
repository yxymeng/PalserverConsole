import { expect, test } from "@playwright/test";

test("UX-09：加载、错误重试和 LAN 登录在桌面与窄屏均可用", async ({ page }, testInfo) => {
  let resolveAuth: (() => void) | undefined;
  const authReady = new Promise<void>((resolve) => { resolveAuth = resolve; });
  await page.route("**/api/auth/status", async (route) => {
    await authReady;
    await route.fulfill({ json: {
      local: false, authenticated: false, adminPasswordConfigured: true, csrfToken: null,
      lanWarning: "仅可信内网使用，请输入游戏设置中的管理员密码。", port: 8223,
    } });
  });

  const navigation = page.goto("/");
  await expect(page.getByRole("status", { name: "正在连接本机控制台" })).toBeVisible();
  resolveAuth?.();
  await navigation;
  await expect(page.getByRole("heading", { name: "局域网管理员登录" })).toBeVisible();
  await expect(page.getByLabel("游戏管理员密码")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`ux09-login-${testInfo.project.name}.png`), fullPage: true });
});

test("UX-09：连接错误可显示并通过重试恢复", async ({ page }) => {
  let allowSuccess = false;
  await page.route("**/api/auth/status", (route) => {
    return allowSuccess
      ? route.fulfill({ json: {
        local: true, authenticated: false, adminPasswordConfigured: true, csrfToken: null, lanWarning: null, port: 8223,
      } })
      : route.fulfill({ status: 503, json: { errorCode: "SERVICE_UNAVAILABLE", message: "模拟后端不可用" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "无法连接控制台" })).toBeVisible();
  await expect(page.getByText("SERVICE_UNAVAILABLE: 模拟后端不可用")).toBeVisible();
  allowSuccess = true;
  await page.getByRole("button", { name: "重新连接" }).click();
  await expect(page.getByRole("heading", { name: "局域网管理员登录" })).toBeVisible();
});
