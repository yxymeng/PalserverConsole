import { expect, test } from "@playwright/test";

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux04-csrf", lanWarning: null, port: 8223 };
const shell = { observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-1" };
const player = { id: "player-1", name: "Alice", level: 20, guildId: "guild-1", guildName: "测试工会" };
const pal = { id: "pal-1", nickname: "小羊", characterId: "SheepBall", level: 18, ownerPlayerId: "player-1", ownerName: "Alice", baseId: "base-1", baseName: "据点一号", containerId: "container-1", slotIndex: 2, assignment: "base_worker", detail: { gender: "Female", rank: 1, isLucky: true } };
const unknownPal = { id: "pal-2", nickname: "", characterId: "FuturePal", level: 1, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned" };
const sortPal = { id: "pal-3", nickname: "阿帕", characterId: "SheepBall", level: 6, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned" };
const guild = { id: "guild-1", name: "测试工会", memberCount: 1, baseCount: 1 };
const base = { id: "base-1", name: "据点一号", guildId: "guild-1", workerContainerId: "container-1", x: 1, y: 2, z: 3 };
let reparseRequests = 0;

test("UX-04：四类实体统一列表详情模式并支持关联跳转", async ({ page }, testInfo) => {
  reparseRequests = 0;
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: shell }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: shell.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: {
    observedAt: 1_786_000_000,
    capacity: { state: "ok", freeBytes: 100, totalBytes: 200, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null },
    directories: [], world: { state: "healthy", lastSuccessAt: 1, snapshotId: "world", parsing: false, errorCode: null, cacheSizeBytes: 0 },
    backups: { state: "healthy", lastSuccessAt: 1, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null }, background: [], alerts: [],
  } }));
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
  await page.route("**/api/world/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/world/snapshots/current") return route.fulfill({ json: {
      source: "save-snapshot", observedAt: 1_786_000_000, stale: false, errorCode: null, error: null, snapshotId: "world", parsing: false, parseDurationMs: 42,
      sourceObservedAt: 1_786_000_000, collectedAt: 1_786_000_000, parsedAt: 1_786_000_042, parseStatus: "ready",
      dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
      counts: { players: 1, pals: 3, guilds: 1, bases: 1, inventory_items: 1, work_pals: 1 },
    } });
    if (path === "/api/world/reparse") {
      if (route.request().method() === "POST") reparseRequests += 1;
      return route.fulfill({ json: { message: "已开始只读重新解析" } });
    }
    const lists: Record<string, object[]> = { "/api/world/players": [player], "/api/world/pals": [pal, unknownPal, sortPal], "/api/world/guilds": [guild], "/api/world/bases": [base] };
    if (path in lists) return route.fulfill({ json: { items: lists[path], page: 1, pageSize: 50, total: lists[path].length, source: "save-snapshot", observedAt: 1, snapshotId: "world", stale: false, errorCode: null } });
    const details: Record<string, object> = {
      "/api/world/players/player-1": { ...player, guild, pals: [pal], partyPals: [pal], storagePals: [], inventory: [{ id: "item-1", itemId: "Wood", quantity: 3, containerId: "bag-1" }] },
      "/api/world/pals/pal-1": { ...pal, owner: player, base, container: { id: "container-1", kind: "base_workers", slotCount: 20 } },
      "/api/world/guilds/guild-1": { ...guild, members: [player], bases: [base], detail: { adminPlayerId: "player-1" } },
      "/api/world/bases/base-1": { ...base, guild, workers: [pal], inventory: [{ id: "item-2", itemId: "Stone", quantity: 8, containerId: "base-bag" }], detail: { state: 1 } },
    };
    if (path in details) return route.fulfill({ json: details[path] });
    return route.fulfill({ status: 404, json: { errorCode: "WORLD_ENTITY_NOT_FOUND", message: path } });
  });

  await page.goto("/");
  if (testInfo.project.name === "mobile") await page.getByTitle("打开菜单").click();
  await page.getByRole("button", { name: "世界数据" }).click();

  const tabs = page.getByRole("tablist", { name: "世界资产工作区" });
  await expect(tabs.getByRole("tab")).toHaveCount(6);
  await expect(tabs).toContainText("总览");
  await expect(tabs).toContainText("玩家");
  await expect(tabs).toContainText("帕鲁名册");
  await expect(tabs).toContainText("仓库");
  await expect(tabs).toContainText("公会");
  await expect(tabs).toContainText("据点");
  await expect(page.getByRole("heading", { name: "总览聚合将在后续 ticket 交付" })).toBeVisible();
  await expect(page.locator(".world-snapshot-bar")).toContainText("存档记录");
  await expect(page.locator(".world-snapshot-bar")).toContainText("解析完成");
  await expect(page.locator(".world-snapshot-bar")).toContainText("不会修改真实 .sav");
  await tabs.getByRole("tab", { name: "玩家" }).click();
  await expect(page.locator(".world-player-avatar")).toHaveText("A");
  await expect(page.locator(".world-list-panel")).toContainText("测试工会");
  await expect(page.locator(".world-list-panel")).toContainText("已加入工会");

  await page.getByRole("button", { name: "Alice" }).click();
  const drawer = page.getByLabel("世界实体详情");
  await expect(page.locator('.world-table-row[data-selected="true"]')).toContainText("Alice");
  if (testInfo.project.name === "mobile") await expect(drawer).toHaveAttribute("role", "dialog");
  await expect(drawer).toContainText("拥有帕鲁");
  await drawer.locator(".world-relation-section").filter({ hasText: "拥有帕鲁" }).getByRole("button", { name: /小羊/ }).click();
  await expect(drawer).toContainText("Character ID");
  await expect(drawer).toContainText("主人");
  await drawer.getByRole("button", { name: /Alice/ }).click();
  await expect(drawer).toContainText("队伍帕鲁");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "帕鲁" }).click();
  await expect(page.locator(".world-list-panel")).toContainText("FuturePal");
  await expect(page.locator(".world-list-panel")).toContainText("Alice");
  const palRow = page.locator(".world-table-row").filter({ hasText: "小羊" });
  await expect(palRow.locator(".world-pal-gender")).toHaveText("♀");
  await expect(palRow.locator(".world-pal-gender")).toHaveAttribute("title", "雌性");
  await expect(palRow.locator('[data-label="属性"]')).toHaveText("闪光 · 浓缩等级 1");
  await expect(palRow.locator('[data-label="据点"]')).toHaveText("据点一号");
  await expect(palRow).not.toContainText("base-1");
  await expect(page.locator('[data-icon-key="pal-placeholder"]')).toHaveCount(1);
  await page.getByLabel("排序方式").selectOption("name");
  await expect(page.locator(".world-table-row").first()).toContainText("阿帕");
  await page.getByRole("button", { name: "小羊" }).click();
  await expect(drawer).toContainText("种族");
  await expect(drawer).toContainText("棉悠悠");
  await expect(drawer.locator(".world-pal-gender")).toHaveText("♀");
  await expect(drawer).toContainText("闪光 · 浓缩等级 1");
  await page.screenshot({ path: testInfo.outputPath(`ux05-${testInfo.project.name}.png`), fullPage: true });
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "公会" }).click();
  await page.getByRole("button", { name: "测试工会" }).click();
  await expect(drawer).toContainText("成员");
  await expect(drawer).toContainText("关联据点");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "据点" }).click();
  await page.getByRole("button", { name: "据点一号" }).click();
  await expect(drawer).toContainText("工作帕鲁");
  await expect(drawer).toContainText("可明确关联的库存");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();
  await page.getByLabel("关联筛选").selectOption("linked");
  await page.getByLabel("排序方式").selectOption("id");
  await expect(page.getByRole("button", { name: "清除筛选条件" })).toBeVisible();
  await page.getByRole("button", { name: "重新解析" }).click();
  await expect.poll(() => reparseRequests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`ux04-${testInfo.project.name}.png`), fullPage: true });
});
