import { expect, test } from "@playwright/test";

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux04-csrf", lanWarning: null, port: 8223 };
const shell = { observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-1" };
const player = { id: "player-1", name: "Alice", level: 20, guildId: "guild-1", guildName: "测试工会" };
const pal = { id: "pal-1", nickname: "小羊", characterId: "SheepBall", level: 18, ownerPlayerId: "player-1", ownerName: "Alice", baseId: "base-1", baseName: "据点一号", containerId: "container-1", slotIndex: 2, assignment: "base_worker", detail: { gender: "Female", rank: 1, isLucky: true } };
const unknownPal = { id: "pal-2", nickname: "", characterId: "FuturePal", level: 1, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned" };
const sortPal = { id: "pal-3", nickname: "阿帕", characterId: "SheepBall", level: 6, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned" };
const guild = { id: "guild-1", name: "测试工会", memberCount: 1, baseCount: 1 };
const base = { id: "base-1", name: "据点一号", guildId: "guild-1", workerContainerId: "container-1", x: 1, y: 2, z: 3 };

test("UX-04：四类实体统一列表详情模式并支持关联跳转", async ({ page }, testInfo) => {
  const worldListUrls: URL[] = [];
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
      counts: { players: 1, pals: 3, guilds: 1, bases: 1, inventory_items: 1, work_pals: 1 },
    } });
    const lists: Record<string, object[]> = { "/api/world/players": [player], "/api/world/pals": [pal, unknownPal, sortPal], "/api/world/guilds": [guild], "/api/world/bases": [base] };
    if (path in lists) {
      worldListUrls.push(new URL(route.request().url()));
      return route.fulfill({ json: { items: lists[path], page: 1, pageSize: 50, total: lists[path].length, source: "save-snapshot", observedAt: 1, stale: false, errorCode: null } });
    }
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

  await expect(page.locator(".world-command-deck")).toContainText("存档缓存可用");
  await expect(page.locator(".world-command-counts")).toContainText("3");

  const tabs = page.getByRole("tablist", { name: "世界实体分类" });
  await expect(tabs.getByRole("tab")).toHaveCount(4);
  await expect(tabs).toContainText("玩家");
  await expect(tabs).toContainText("帕鲁");
  await expect(tabs).toContainText("工会");
  await expect(tabs).toContainText("据点");
  await expect(tabs).not.toContainText("库存");
  await expect(tabs).not.toContainText("工作帕鲁");
  await expect(page.locator(".world-player-avatar")).toHaveText("A");
  await expect(page.locator(".world-list-heading")).toContainText("玩家名册");
  await expect(page.locator(".world-entity-list")).toBeVisible();
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
  await expect(page.locator('.world-browser[data-resource="pals"]')).toBeVisible();
  await expect(page.locator(".pal-collection-summary")).toContainText("帕鲁总数");
  await expect(page.getByRole("group", { name: "归属" })).toContainText("玩家持有");
  await expect(page.locator(".pal-roster-head")).toContainText("主人");
  await expect(page.locator(".world-list-panel")).toContainText("FuturePal");
  await expect(page.locator(".world-list-panel")).toContainText("Alice");
  const palRow = page.locator(".world-table-row").filter({ hasText: "小羊" });
  await expect(palRow.locator(".world-pal-gender")).toHaveText("♀");
  await expect(palRow.locator(".world-pal-gender")).toHaveAttribute("title", "雌性");
  await expect(palRow.locator('[data-label="属性"]')).toHaveText("闪光 · 浓缩等级 1");
  await expect(palRow.locator('[data-label="据点"]')).toHaveText("据点一号");
  await expect(palRow).not.toContainText("base-1");
  await expect(page.locator('[data-icon-key="pal-placeholder"]')).toHaveCount(1);
  await page.locator(".pal-sort-segments").getByRole("button", { name: "名称", exact: true }).click();
  await expect.poll(() => worldListUrls.at(-1)?.searchParams.get("sort")).toBe("name");
  await page.getByRole("button", { name: "小羊" }).click();
  await expect(drawer).toHaveAttribute("data-resource", "pals");
  await expect(drawer.locator(".world-pal-detail-hero")).toContainText("Lv.18");
  await expect(drawer).toContainText("种族");
  await expect(drawer).toContainText("棉悠悠");
  await expect(drawer.locator(".world-pal-gender")).toHaveText("♀");
  await expect(drawer).toContainText("闪光 · 浓缩等级 1");
  await page.screenshot({ path: testInfo.outputPath(`ux05-${testInfo.project.name}.png`), fullPage: true });
  await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "工会" }).click();
  await page.getByRole("button", { name: "测试工会" }).click();
  await expect(drawer).toContainText("成员");
  await expect(drawer).toContainText("关联据点");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "据点" }).click();
  await page.getByRole("button", { name: "据点一号" }).click();
  await expect(drawer).toContainText("工作帕鲁");
  await expect(drawer).toContainText("可明确关联的库存");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();
  await page.getByLabel("状态筛选").selectOption("guilded");
  await page.getByLabel("排序方式").selectOption("id");
  await expect.poll(() => worldListUrls.at(-1)?.searchParams.get("status")).toBe("guilded");
  await expect.poll(() => worldListUrls.at(-1)?.searchParams.get("sort")).toBe("id");
  await expect(page.getByRole("button", { name: "清除筛选条件" })).toBeVisible();
  await expect(page.locator(".world-active-filters")).toContainText("已归属工会");
  await page.screenshot({ path: testInfo.outputPath(`ux04-${testInfo.project.name}.png`), fullPage: true });
});
