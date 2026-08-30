import { expect, test } from "@playwright/test";

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "status-csrf", lanWarning: null, port: 8223 };
const stopped = { observedAt: 1, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "default" };
const running = { ...stopped, observedAt: 2, serverState: "running", pids: [1234] };

test("首页控制模块刷新运行状态后，顶栏状态同步更新", async ({ page }) => {
  let shellReads = 0;
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => {
    shellReads += 1;
    return route.fulfill({ json: shellReads === 1 ? stopped : running });
  });
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: stopped.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: { alerts: [] } }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1, stale: false, errorCode: null, error: null,
    snapshotId: "world", parsing: false, parseDurationMs: 1, gameTimeTicks: 0,
    counts: { players: 0, pals: 0, guilds: 0, bases: 0 },
  } }));
  const live = {
    info: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
    players: { data: [], source: "rest", observedAt: 1, stale: false, errorCode: null },
    metrics: { data: { process: { pids: [1234], cpuPercent: 1, memoryBytes: 1, diskReadBytes: 0, diskWriteBytes: 0, startedAt: 1 } }, source: "rest", observedAt: 1, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
  };
  for (const kind of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${kind}`, (route) => route.fulfill({ json: live[kind] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));

  await page.goto("/");
  await expect(page.locator(".psc-home-state")).toHaveText("运行中");
  await expect(page.locator(".psc-server-status")).toHaveText("运行中");
});

test("在线训练家的探索进度使用 Player ID 关联只读存档并展示真实字段", async ({ page }) => {
  const savePlayerId = "11111111-2222-3333-4444-555555555555";
  let playerListRequest = "";
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: running }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: stopped.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: { alerts: [] } }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1, stale: false, errorCode: null, error: null,
    snapshotId: "world-real", parsing: false, parseDurationMs: 1, gameTimeTicks: 0,
    counts: { players: 1, pals: 0, guilds: 0, bases: 0 },
  } }));
  await page.route("**/api/world/players?**", (route) => {
    playerListRequest = route.request().url();
    return route.fulfill({ json: {
      items: [{
        id: savePlayerId, instanceId: "instance-1", name: "Arthur King", level: 55,
        guildId: null, inventoryIds: [], partyContainerId: null, storageContainerId: null,
        lastRecordedAt: "2026-08-30T06:00:00Z",
        progress: {
          state: "partial",
          values: { discoveredPalSpecies: 61, capturedPals: 1840, fastTravel: 48, relics: 173, memos: 24, fieldBosses: 58, towerBosses: 6, dungeonClears: 62, oilRigClears: 18, technologyPoints: 92, ancientTechnologyPoints: 12, recipes: 140 },
          unavailable: ["exploredAreas"],
          totals: { fastTravel: 174, exploredAreas: 123, towerBosses: 13, oilRigLocations: 3 },
          totalsDataVersion: "2026.08.30.2",
        },
      }],
      page: 1, pageSize: 200, total: 1, source: "save-snapshot", observedAt: 1,
      snapshotId: "world-real", stale: false, errorCode: null,
    } });
  });
  const live = {
    info: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
    players: { data: [{ name: "Arthur King", playerId: savePlayerId.replaceAll("-", ""), userId: "management-user-id", ip: "203.0.113.8", ping: 36, level: 55 }], source: "rest", observedAt: 1, stale: false, errorCode: null },
    metrics: { data: { process: { pids: [1234], cpuPercent: 1, memoryBytes: 1, diskReadBytes: 0, diskWriteBytes: 0, startedAt: 1 } }, source: "rest", observedAt: 1, stale: false, errorCode: null },
    settings: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null },
  };
  for (const kind of ["info", "players", "metrics", "settings"] as const) {
    await page.route(`**/api/live/${kind}`, (route) => route.fulfill({ json: live[kind] }));
  }
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));

  await page.goto("/");
  await page.getByRole("button", { name: "探索进度" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Arthur King");
  await expect(dialog).toContainText("地图区域");
  await expect(dialog).toContainText("已发现帕鲁种类");
  await expect(dialog).toContainText("61");
  await expect(dialog).toContainText("48/ 174");
  await expect(dialog).toContainText("6/ 13");
  await expect(dialog).toContainText("18次");
  await expect(dialog).toContainText("累计通关次数 · 游戏共 3 处油田");
  await expect(dialog.locator(".psc-exploration-metrics article").first().locator("strong")).toHaveText("不可用");
  await expect(dialog).toContainText("累计捕获帕鲁数量");
  await expect(dialog).toContainText("1,840");
  await expect(dialog).toContainText("未显示不可确认的字段：已探索区域");
  await expect(dialog).not.toContainText("100%");
  await expect(dialog).not.toContainText("61/61");
  if ((page.viewportSize()?.width ?? 0) > 700) {
    await expect(dialog).toHaveCSS("width", "672px");
    await expect(dialog.locator(".psc-exploration-body")).toHaveCSS("padding", "24px");
    await expect(dialog.locator(".psc-exploration-metrics article").first()).toHaveCSS("padding", "16px");
  } else {
    await expect(dialog).toHaveCSS("width", "390px");
    await expect(dialog.locator(".psc-exploration-metrics article").first()).toHaveCSS("padding", "14px");
  }
  expect(new URL(playerListRequest).searchParams.get("snapshotId")).toBe("world-real");
});
