import { expect, test } from "@playwright/test";

test("UX-06：清爽浅色为默认主题且仍可切换柔和深色界面", async ({ page }, testInfo) => {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: {
    local: true, authenticated: false, adminPasswordConfigured: true, csrfToken: "ux06-csrf", lanWarning: null, port: 8223,
  } }));

  await page.goto("/");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await expect.poll(() => page.evaluate(() => ({ palette: document.documentElement.dataset.palette ?? null, stored: localStorage.getItem("palserver-console-palette") }))).toEqual({ palette: null, stored: null });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("#fafaf8");
  await expect(page.locator('link[rel="icon"][href="/favicon.ico"]')).toHaveCount(1);
  await expect(page.locator('.brand-mark img[src="/zoe-console-icon.png"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "局域网管理员登录" })).toBeVisible();
  await page.getByRole("button", { name: "切换到深色界面" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("#1e2222");
  await page.getByRole("button", { name: "切换到浅色界面" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.screenshot({ path: testInfo.outputPath(`ux06-${testInfo.project.name}.png`), fullPage: true });
});
