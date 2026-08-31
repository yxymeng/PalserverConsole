import { expect, test } from "@playwright/test";

test("UX-06：保留极简浅色与夜间主题，并可切换海岛帕鲁世界主题", async ({ page }, testInfo) => {
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
  const themeSelector = page.getByRole("combobox", { name: /选择界面主题/ });
  await themeSelector.click();
  const themeMenu = page.getByRole("listbox");
  await expect(themeMenu.getByRole("option")).toHaveCount(3);
  await expect(themeMenu).toContainText("暖白留白与克制蓝绿色，适合长时间值守");
  await expect(themeMenu).toContainText("晴空、海水与阳光点缀的轻快帕鲁世界");
  await expect(themeMenu).toContainText("低眩光炭灰界面，适合暗光环境操作");
  await page.getByRole("option", { name: /灵动海岛/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("island");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("#f4f9ff");
  await themeSelector.click();
  await page.getByRole("option", { name: /深邃夜色/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim())).toBe("#1e2222");
  await themeSelector.click();
  await page.getByRole("option", { name: /轻爽极简/ }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.screenshot({ path: testInfo.outputPath(`ux06-${testInfo.project.name}.png`), fullPage: true });
});
