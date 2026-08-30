import { expect, test, type Page } from "@playwright/test";

const worldContract = { queryVersion: 1, cacheSchema: "world-asset-cache", cacheSchemaVersion: 15, metadataSchema: "palserver-console-world-metadata", metadataSchemaVersion: 1, metadataDataVersion: "2026.08.25.3" };

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux11-csrf", lanWarning: null, port: 8223 };
const shell = { observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-ux11" };
const status = {
  contract: worldContract, source: "save-snapshot", observedAt: 1_786_000_000, sourceObservedAt: 1_786_000_000, collectedAt: 1_786_000_000, parsedAt: 1_786_000_042,
  snapshotId: "world-ux11", stale: false, errorCode: null, error: null, parsing: false, parseStatus: "ready", reparseGeneration: 0, parseDurationMs: 42, peakMemoryBytes: null, cacheSizeBytes: null, gameTimeTicks: null,
  dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
  counts: { players: 1, pals: 0, guilds: 0, bases: 0, containers: 0, inventory_items: 0, work_pals: 0 },
  overview: { assets: { players: 1, pals: 0, palSpecies: 0, itemTypes: 0, itemQuantity: 0, bases: 0, guilds: 0 }, actions: { attentionPals: 0, luckyPals: 0, bossPals: 0, unassignedPals: 0, unknownItems: 0, unknownPalMetadata: 0, careUnavailable: 0 } },
};

async function routeShell(page: Page) {
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: shell }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: shell.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: { observedAt: 1, capacity: { state: "ok", freeBytes: 1, totalBytes: 1, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null }, directories: [], world: { state: "healthy", lastSuccessAt: 1, snapshotId: "world-ux11", parsing: false, errorCode: null, cacheSizeBytes: 0 }, backups: { state: "healthy", lastSuccessAt: 1, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null }, background: [], alerts: [] } }));
  await page.route("**/api/live/**", (route) => route.fulfill({ json: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null } }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
}

async function openWorldData(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
}

test("UX-11：无可用快照时六个工作区都明确说明影响", async ({ page }) => {
  await routeShell(page);
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: { ...status, snapshotId: null, parseStatus: "unavailable", overview: null } }));

  await openWorldData(page);
  await expect(page.getByRole("heading", { name: "存档快照不可用" })).toBeVisible();
  await expect(page.locator(".world-overview-empty")).toContainText("总览等待可用快照");

  const tabs = page.getByRole("tablist", { name: "世界资产工作区" });
  for (const label of ["玩家", "帕鲁名册", "仓库", "据点", "公会"]) {
    await tabs.getByRole("tab", { name: label }).click();
    await expect(page.locator(".world-workspace")).toContainText("当前没有可用世界快照");
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("UX-11：请求失败保留英文标识并可重试", async ({ page }) => {
  await routeShell(page);
  let failSnapshot = true;
  let failPlayerList = true;
  await page.route("**/api/world/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/world/snapshots/current") {
      if (failSnapshot) return route.fulfill({ status: 503, json: { errorCode: "WORLD_SNAPSHOT_UNAVAILABLE", message: "snapshot service unavailable" } });
      return route.fulfill({ json: status });
    }
    if (path === "/api/world/players") {
      if (failPlayerList) return route.fulfill({ status: 503, json: { errorCode: "WORLD_PLAYER_LIST_UNAVAILABLE", message: "player query unavailable" } });
      return route.fulfill({ json: { items: [{ id: "player-ux11", name: "状态测试玩家", level: 12, guildName: null, progress: { state: "unavailable", values: {}, unavailable: [] } }], page: 1, pageSize: 50, total: 1, source: "save-snapshot", observedAt: 1, snapshotId: status.snapshotId, stale: false, errorCode: null } });
    }
    return route.fulfill({ status: 404, json: { errorCode: "WORLD_TEST_UNROUTED", message: path } });
  });

  await openWorldData(page);
  const failure = page.locator(".world-request-failure");
  await expect(failure).toContainText("WORLD_SNAPSHOT_UNAVAILABLE");
  failSnapshot = false;
  await failure.getByRole("button", { name: "重新尝试" }).click();
  await expect(page.getByRole("heading", { name: "世界资产总览" })).toBeVisible();

  await page.getByRole("tab", { name: "玩家" }).click();
  await expect(failure).toContainText("WORLD_PLAYER_LIST_UNAVAILABLE");
  failPlayerList = false;
  await failure.getByRole("button", { name: "重新尝试" }).click();
  await expect(page.getByRole("button", { name: "状态测试玩家" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test("UX-11：stale 或失败的在线玩家显示为不可用", async ({ page }) => {
  await routeShell(page);
  let livePlayers: { data: unknown; source: string; observedAt: number; stale: boolean; errorCode: string | null } = { data: [{}, {}, {}], source: "rest", observedAt: 1, stale: false, errorCode: null };
  await page.route("**/api/live/players", (route) => route.fulfill({ json: livePlayers }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: status }));

  const playerMetric = () => page.locator(".world-overview-assets > button").filter({ has: page.getByText("玩家", { exact: true }) }).locator(".world-overview-asset-value");
  await openWorldData(page);
  await expect(playerMetric()).toContainText("3 / 1");

  livePlayers = { ...livePlayers, stale: true };
  await page.reload();
  await openWorldData(page);
  await expect(playerMetric()).toContainText("— / 1");

  livePlayers = { ...livePlayers, stale: false, errorCode: "LIVE_PLAYERS_UNAVAILABLE" };
  await page.reload();
  await openWorldData(page);
  await expect(playerMetric()).toContainText("— / 1");

  livePlayers = { ...livePlayers, data: [], errorCode: null };
  await page.reload();
  await openWorldData(page);
  await expect(playerMetric()).toContainText("0 / 1");

  livePlayers = { ...livePlayers, data: { raw: "name,playeruid,steamid" } };
  await page.reload();
  await openWorldData(page);
  await expect(playerMetric()).toContainText("— / 1");
});

test("UX-11：总览保持打开时在线玩家持续刷新", async ({ page }) => {
  await routeShell(page);
  let playerCount = 1;
  await page.route("**/api/live/players", (route) => route.fulfill({
    json: {
      data: Array.from({ length: playerCount }, () => ({})),
      source: "rest",
      observedAt: 1,
      stale: false,
      errorCode: null,
    },
  }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: status }));

  const playerMetric = () => page.locator(".world-overview-assets > button").filter({ has: page.getByText("玩家", { exact: true }) }).locator(".world-overview-asset-value");
  await openWorldData(page);
  await expect(playerMetric()).toContainText("1 / 1");
  playerCount = 2;
  await expect(playerMetric()).toContainText("2 / 1", { timeout: 7_000 });
});
