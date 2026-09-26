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

for (const local of [true, false]) {
  test(`顶栏控件和内容始终位于背景内：${local ? "本机" : "LAN"}`, async ({ page }) => {
    await page.route("**/api/**", route => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith("/api/")) return route.continue();
      if (path === "/api/auth/status") return route.fulfill({ json: { ...auth, local } });
      if (path === "/api/shell/status") return route.fulfill({ json: shell });
      if (path === "/api/maintenance/application-update") return route.fulfill({ json: {
        currentVersion: "0.2.0", latestVersion: "0.3.0", updateAvailable: true, portable: true, releaseNotes: [],
      } });
      if (path === "/api/maintenance/application-update/progress") return route.fulfill({ json: { state: "idle", step: 0, message: "" } });
      return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "topbar fixture" } });
    });
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: /选择界面主题/ })).toBeVisible();
    await expect(page.locator(".psc-update-trigger")).toBeVisible();
    const failures: string[] = [];
    for (const name of ["轻爽极简", "灵动海岛", "深邃夜色"]) {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.getByRole("combobox", { name: /选择界面主题/ }).click();
      await page.getByRole("option", { name: new RegExp(name) }).click();
      for (const width of [1035, 768, 1100, 1101, 1180, 1181, 1280, 1281, 767, 431, 430, 390, 360, 320, 1440]) {
        await page.setViewportSize({ width, height: 960 });
        const problems = await page.locator(".psc-topbar-actions").evaluate(actions => {
          const errors: string[] = [];
          const outer = actions.getBoundingClientRect();
          const header = actions.closest("header")!.getBoundingClientRect();
          if (outer.left < header.left || outer.right > document.documentElement.clientWidth + .25) errors.push("actions outside header");
          for (const control of actions.querySelectorAll("button")) {
            const box = control.getBoundingClientRect();
            for (const child of control.children) {
              const rect = child.getBoundingClientRect();
              if (!rect.width || !rect.height) continue;
              if (rect.left < box.left - .25 || rect.right > box.right + .25 || rect.top < box.top - .25 || rect.bottom > box.bottom + .25) errors.push(`${control.getAttribute("aria-label") || control.textContent}: ${child.tagName} outside control`);
            }
          }
          const brand = document.querySelector(".psc-desktop-brand")!.getBoundingClientRect();
          if (brand.right > outer.left + .25) errors.push("actions overlap brand");
          const nav = document.querySelector(".psc-desktop-navigation")!.getBoundingClientRect();
          if (nav.width && (brand.right > nav.left + .25 || nav.right > outer.left + .25)) errors.push("navigation overlaps adjacent content");
          return errors;
        });
        failures.push(...problems.map(problem => `${name}, ${width}px: ${problem}`));
        if (width === 1035 || width === 320) {
          await page.getByRole("combobox", { name: /选择界面主题/ }).click();
          const menu = page.getByRole("listbox");
          await expect(menu).toBeVisible();
          await expect(menu.getByRole("option")).toHaveCount(3);
          const box = await menu.boundingBox();
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
          await menu.getByRole("option", { name: new RegExp(name) }).click();
          await expect(page.getByRole("combobox", { name: /选择界面主题/ })).toHaveAttribute("aria-expanded", "false");
        }
      }
    }
    expect(failures).toEqual([]);
  });
}

test("首次连接使用与首页同位的壳层骨架", async ({ page }, testInfo) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/status") {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fulfill({ json: auth });
    }
    if (path === "/api/shell/status") return route.fulfill({ json: shell });
    return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "initial loading fixture" } });
  });

  await page.goto("/");
  const skeleton = page.getByRole("status", { name: "正在连接本机控制台" });
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator(".psc-page-skeleton-media")).toBeVisible();
  const skeletonBox = await skeleton.boundingBox();
  if (!skeletonBox) throw new Error("首页壳层骨架未渲染");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("无法读取测试视口");
  expect(Math.abs(skeletonBox.x + skeletonBox.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: testInfo.outputPath(`initial-shell-skeleton-${testInfo.project.name}.png`), fullPage: true });

  await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
  const pageBox = await page.getByRole("main", { name: "首页页面" }).locator(".page-stack").boundingBox();
  if (!pageBox) throw new Error("首页未渲染");
  expect(Math.abs(pageBox.x - skeletonBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(pageBox.width - skeletonBox.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(pageBox.y - skeletonBox.y)).toBeLessThanOrEqual(2);
});

test("桌面四个一级页面共用同一层品牌、导航与状态顶栏", async ({ page }, testInfo) => {
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
  const topbar = page.locator(".psc-topbar");
  const navigation = page.locator(".psc-desktop-navigation");
  await expect(topbar).toHaveCSS("position", "sticky");
  await expect(page.locator(".psc-desktop-brand")).toBeVisible();
  await expect(page.locator(".psc-server-status")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看实例与控制台" })).toHaveCount(0);
  await expect(navigation.getByRole("button")).toHaveCount(4);
  await expect(page.locator(".psc-mobile-navigation")).toBeHidden();
  const initialTopbar = await topbar.boundingBox();
  if (!initialTopbar) throw new Error("桌面顶栏未渲染");
  const brandBox = await page.locator(".psc-desktop-brand").boundingBox();
  const broadcastBox = await page.getByRole("button", { name: "发送全服广播" }).boundingBox();
  const themeBox = await page.getByRole("combobox", { name: "选择界面主题，当前极简" }).boundingBox();
  const navigationBox = await navigation.boundingBox();
  const navigationButtonBox = await navigation.getByRole("button", { name: "首页", exact: true }).boundingBox();
  const heroBox = await page.locator(".psc-home-command").boundingBox();
  if (!brandBox || !broadcastBox || !themeBox || !navigationBox || !navigationButtonBox || !heroBox) throw new Error("无法校验壳层左右对齐");
  expect(Math.abs(heroBox.x - brandBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(heroBox.x + heroBox.width - (themeBox.x + themeBox.width))).toBeLessThanOrEqual(2);
  expect(broadcastBox.height).toBe(themeBox.height);
  expect(navigationBox.height).toBe(52);
  expect(navigationButtonBox.height).toBe(38);

  for (const name of ["首页", "世界", "配置", "维护"]) {
    await navigation.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("main", { name: `${name}页面` })).toBeVisible();
    const currentTopbar = await topbar.boundingBox();
    if (!currentTopbar) throw new Error(`${name}页面顶栏未渲染`);
    expect(currentTopbar.y, `${name}页面顶栏纵向位置`).toBe(initialTopbar.y);
    expect(currentTopbar.height, `${name}页面顶栏高度`).toBe(initialTopbar.height);
  }
});

test("手机顶部只保留页面标题与状态操作，底部固定四项一级导航", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "手机壳层回归");
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/status") return route.fulfill({ json: auth });
    if (path === "/api/shell/status") return route.fulfill({ json: shell });
    return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "mobile shell fixture" } });
  });

  await page.goto("/");
  const navigation = page.locator(".psc-mobile-navigation");
  await expect(page.locator(".psc-desktop-brand")).toBeVisible();
  await expect(page.locator(".psc-brand-copy > strong")).toBeHidden();
  await expect(page.locator(".psc-desktop-navigation")).toBeHidden();
  await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();
  await expect(page.locator(".psc-server-status")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看实例与控制台" })).toHaveCount(0);
  await expect(navigation).toHaveCSS("position", "fixed");
  await expect(navigation.getByRole("button")).toHaveCount(4);
  expect((await navigation.boundingBox())?.height).toBeLessThanOrEqual(56);

  for (const name of ["首页", "世界", "配置", "维护"]) {
    const button = navigation.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await navigation.getByRole("button", { name: "配置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "配置", exact: true })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "配置工作区" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "世界法则配置" })).toBeVisible();
  await expect(navigation).toBeVisible();
});

test("按需页面在主框架内使用稳定骨架并原位替换", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "桌面加载布局回归");
  await page.setViewportSize({ width: 2048, height: 1000 });
  let configCurrentCalls = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/status") return route.fulfill({ json: auth });
    if (path === "/api/shell/status") return route.fulfill({ json: shell });
    if (path === "/api/config/current") configCurrentCalls += 1;
    return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "loading fixture" } });
  });

  await page.goto("/");
  await expect(page.locator(".psc-desktop-navigation")).toBeVisible();
  await page.route("**/src/features/config/ConfigPage.tsx*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });
  await page.locator(".psc-desktop-navigation").getByRole("button", { name: "配置", exact: true }).dispatchEvent("click");
  const main = page.getByRole("main", { name: "配置页面" });
  const skeleton = main.getByRole("status", { name: "正在加载配置界面" });
  await expect(skeleton).toBeVisible();
  await expect(skeleton.locator(".psc-page-skeleton-media")).toBeVisible();
  const skeletonBox = await skeleton.boundingBox();
  if (!skeletonBox) throw new Error("配置骨架未渲染");
  expect(Math.abs(skeletonBox.x + skeletonBox.width / 2 - 1024)).toBeLessThanOrEqual(2);

  const pageSurface = main.locator(".config-page");
  await expect(pageSurface).toBeVisible();
  const pageBox = await pageSurface.boundingBox();
  if (!pageBox) throw new Error("配置页面未渲染");
  expect(Math.abs(pageBox.x - skeletonBox.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(pageBox.width - skeletonBox.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(pageBox.y - skeletonBox.y)).toBeLessThanOrEqual(2);
  const error = main.getByRole("alert");
  await expect(error).toContainText("世界法则读取失败");
  const callsBeforeRetry = configCurrentCalls;
  await error.getByRole("button", { name: "重新读取世界法则" }).click();
  await expect.poll(() => configCurrentCalls).toBeGreaterThan(callsBeforeRetry);
});

test("按需页面加载失败后在主框架内显示错误和重试", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "桌面加载失败回归");
  let chunkRequests = 0;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    if (path === "/api/auth/status") return route.fulfill({ json: auth });
    if (path === "/api/shell/status") return route.fulfill({ json: shell });
    return route.fulfill({ status: 503, json: { errorCode: "TEST_OFFLINE", message: "retry fixture" } });
  });

  await page.goto("/");
  await expect(page.locator(".psc-desktop-navigation")).toBeVisible();
  await page.route("**/src/features/config/ConfigPage.tsx*", async (route) => {
    chunkRequests += 1;
    if (chunkRequests === 1) return route.abort("failed");
    return route.continue();
  });
  await page.locator(".psc-desktop-navigation").getByRole("button", { name: "配置", exact: true }).click();
  const main = page.getByRole("main", { name: "配置页面" });
  const error = main.getByRole("alert");
  await expect(error).toContainText("配置界面加载失败");
  await expect(main.getByRole("status", { name: "正在加载配置界面" })).toHaveCount(0);
  await expect(page.locator(".psc-topbar")).toBeVisible();
  await error.getByRole("button", { name: "重试加载配置" }).click();
  await expect(page.getByRole("main", { name: "配置页面" }).locator(".config-page")).toBeVisible();
});
