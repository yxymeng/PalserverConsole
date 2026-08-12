import { expect, test } from "@playwright/test";

test("UX-06：深色 HUD 为默认主题且仍可切换浅色界面", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: false, adminPasswordConfigured: true, csrfToken: "ux06-csrf", lanWarning: null, port: 8223,
  } }));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect(page.getByRole("heading", { name: "局域网管理员登录" })).toBeVisible();
  await page.getByRole("button", { name: "切换到浅色界面" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.getByRole("button", { name: "切换到深色界面" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await page.screenshot({ path: testInfo.outputPath(`ux06-${testInfo.project.name}.png`), fullPage: true });
});
