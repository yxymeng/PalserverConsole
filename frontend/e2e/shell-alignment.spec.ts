import { expect, test } from "@playwright/test";

const auth = {
  local: true,
  authenticated: true,
  adminPasswordConfigured: false,
  csrfToken: "shell-alignment-csrf",
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
  executablePath: "F:\\PalServer\\PalServer.exe",
  instanceId: "default",
};

test("桌面四个一级页面共用同一条侧栏与顶栏接缝", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "桌面壳层回归");
  await page.setViewportSize({ width: 2048, height: 1000 });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/status") return route.fulfill({ json: auth });
    if (path === "/api/shell/status") return route.fulfill({ json: shell });
    return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "shell alignment fixture" } });
  });

  await page.goto("/");
  const sidebar = page.locator(".psc-sidebar");
  await expect(sidebar).toHaveCSS("position", "sticky");
  await expect(page.locator('[data-slot="sidebar-gap"]')).toHaveCount(0);

  for (const name of ["首页", "世界数据", "配置", "维护"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("main", { name: `${name}页面` })).toBeVisible();
    const junction = await page.evaluate(() => {
      const sidebarRect = document.querySelector(".psc-sidebar")?.getBoundingClientRect();
      const topbarRect = document.querySelector(".psc-topbar")?.getBoundingClientRect();
      if (!sidebarRect || !topbarRect) throw new Error("共享壳层未渲染");
      return Math.abs(sidebarRect.right - topbarRect.left);
    });
    expect(junction, `${name}的侧栏与顶栏接缝`).toBeLessThan(0.5);
  }
});
