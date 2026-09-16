import { expect, test } from "@playwright/test";

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "status-csrf", lanWarning: null, port: 8223 };
const stopped = { observedAt: 1, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "default" };
const running = { ...stopped, observedAt: 2, serverState: "running", pids: [1234] };

test("首页控制模块刷新运行状态后，顶栏状态同步更新", async ({ page }, testInfo) => {
  let shellReads = 0;
  let banListReads = 0;
  let unbannedUserId = "";
  let broadcastRequest: { message?: string; csrf?: string } = {};
  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => {
    shellReads += 1;
    return route.fulfill({ json: shellReads === 1 ? stopped : running });
  });
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: stopped.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: { alerts: [] } }));
  await page.route("**/api/world/snapshots/current", (route) => route.fulfill({ json: {
    source: "save-snapshot", observedAt: 1, stale: false, errorCode: null, error: null,
    snapshotId: "world", parsing: false, parseDurationMs: 1, gameTimeTicks: 900_000_000_000,
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
  await page.route("**/api/live/bans", (route) => {
    banListReads += 1;
    return route.fulfill({ json: {
      items: banListReads === 1 ? [{ userId: "steam_111" }] : [],
      source: "palserver-banlist", observedAt: 1, stale: false, errorCode: null,
    } });
  });
  await page.route("**/api/live/players/steam_111/unban", (route) => {
    unbannedUserId = "steam_111";
    return route.fulfill({ json: { message: "管理操作已发送。" } });
  });
  await page.route("**/api/live/announce", (route) => {
    broadcastRequest = { ...(route.request().postDataJSON() as { message: string }), csrf: route.request().headers()["x-csrf-token"] };
    return route.fulfill({ json: { message: "广播已发送。" } });
  });
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));

  await page.goto("/");
  await expect(page.locator(".psc-home-state")).toHaveText("运行中");
  await expect(page.locator(".psc-server-status")).toHaveText("运行中");
  await expect(page.locator(".psc-brand-copy > strong")).toHaveText("PalServerConsole");
  await expect(page.locator(".psc-desktop-brand .psc-server-status")).toHaveCount(1);
  await expect(page.locator(".psc-topbar-actions .psc-server-status")).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    const brandNameBox = await page.locator(".psc-brand-copy > strong").boundingBox();
    const statusBox = await page.locator(".psc-server-status").boundingBox();
    if (!brandNameBox || !statusBox) throw new Error("顶栏品牌或服务器状态未渲染。");
    expect(brandNameBox.y + brandNameBox.height).toBeLessThanOrEqual(statusBox.y);
  }
  await expect(page.locator(".psc-home-uptime")).toContainText("连续运行");
  await expect(page.getByLabel("实时服务器状态")).toContainText("世界累计游戏时间");
  await expect(page.getByLabel("实时服务器状态")).toContainText("1 天 1 小时");
  await expect(page.getByLabel("实时服务器状态")).not.toContainText("在线训练家");
  await expect(page.getByLabel("实时服务器状态")).toContainText("内存占用负载");
  await expect(page.locator(".live-status-grid .psc-status-metric-heading > span:first-child")).toHaveText([
    "服务器帧率",
    "内存占用负载",
    "世界累计游戏时间",
    "世界生态图鉴",
  ]);
  if (testInfo.project.name === "desktop") {
    const metricRows = await page.locator(".live-status-grid .psc-status-metric").evaluateAll((cards) => cards.map((card) => {
      const top = card.getBoundingClientRect().top;
      const position = (selector: string) => Math.round((card.querySelector(selector)?.getBoundingClientRect().top ?? top) - top);
      return [position(".psc-status-metric-heading"), position(":scope > strong"), position(".psc-status-metric-detail")];
    }));
    expect(new Set(metricRows.map((row) => row.join(","))).size).toBe(1);
  }
  await expect(page.getByText("解除封禁 User ID", { exact: true })).toHaveCount(0);
  await expect(page.locator(".psc-player-broadcast")).toHaveCount(0);

  if (testInfo.project.name === "mobile") {
    for (const action of ["保存", "关闭", "重启"]) {
      await page.getByRole("button", { name: action, exact: true }).click();
      const confirmation = page.getByRole("alertdialog");
      const box = (await confirmation.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
      await expect(confirmation.getByRole("button", { name: "调整抽屉高度" })).toHaveCount(0);
      await expect(confirmation.getByRole("button", { name: `确认${action}` })).toBeInViewport();
      await confirmation.getByRole("button", { name: "取消" }).click();
    }
  }

  await page.getByRole("button", { name: "发送全服广播" }).click();
  const broadcastDialog = page.getByRole("dialog", { name: "全服广播系统" });
  await expect(broadcastDialog).toContainText("快捷预设模板");
  await broadcastDialog.getByLabel("广播内容正文").fill("今晚八点集合挑战高塔。");
  await broadcastDialog.getByRole("button", { name: "立即发送广播" }).click();
  await expect.poll(() => broadcastRequest).toEqual({ message: "今晚八点集合挑战高塔。", csrf: "status-csrf" });
  await expect(broadcastDialog).toContainText("广播已发送");
  await expect(broadcastDialog).toHaveCSS("opacity", "1");
  await broadcastDialog.evaluate(element => { element.scrollTop = 0; });
  if ((page.viewportSize()?.width ?? 0) <= 767) {
    const box = (await broadcastDialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(broadcastDialog.getByRole("button", { name: "调整抽屉高度" })).toHaveCount(0);
    await expect(broadcastDialog.getByRole("heading", { name: "全服广播系统" })).toBeInViewport();
    await expect(broadcastDialog.getByRole("button", { name: "取消" })).toBeInViewport();
  }
  await page.screenshot({ path: test.info().outputPath("broadcast-sheet.png") });
  await broadcastDialog.getByRole("button", { name: "取消" }).click();

  await page.getByRole("button", { name: "封禁名单" }).click();
  const banSheet = page.getByRole("dialog", { name: "封禁名单" });
  await expect(banSheet).toContainText("steam_111");
  if (testInfo.project.name === "mobile") {
    await expect.poll(async () => {
      const box = (await banSheet.boundingBox())!;
      return box.x + box.width;
    }).toBeLessThanOrEqual(page.viewportSize()!.width);
    const box = (await banSheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(banSheet.getByRole("button", { name: "调整抽屉高度" })).toHaveCount(0);
  }
  await banSheet.getByRole("button", { name: "解除封禁" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "确认解除" }).click();
  await expect.poll(() => unbannedUserId).toBe("steam_111");
  await expect(banSheet).toContainText("当前没有封禁记录");
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
          values: { discoveredPalSpecies: 61, capturedPals: 1840, exploredAreas: 87, fastTravel: 48, relics: 173, memos: 24, fieldBosses: 58, towerBosses: 6, dungeonClears: 62, oilRigClears: 18, technologyPoints: 92, ancientTechnologyPoints: 12, recipes: 140 },
          unavailable: [],
          totals: { fastTravel: 174, exploredAreas: 100, towerBosses: 13, oilRigLocations: 3 },
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
  await expect(page.getByRole("heading", { name: /在线训练家/ })).toBeVisible();
  await expect(page.locator(".psc-home-player-grid")).toHaveCSS("align-items", "start");
  if ((page.viewportSize()?.width ?? 0) > 700) {
    const table = page.locator(".psc-player-table-wrap");
    await expect(table).toBeVisible();
    await expect(page.locator(".psc-player-list")).toBeHidden();
    await expect(table).toContainText("Arthur King");
    await expect(table).toContainText("Lv.55");
    await expect(table).toContainText("已关联");
    await expect(table).toContainText("36 ms");
    await table.getByRole("button", { name: "档案" }).click();
  } else {
    const playerCard = page.locator(".psc-player-card");
    await expect(page.locator(".psc-player-table-wrap")).toBeHidden();
    await expect(playerCard).toBeVisible();
    await expect(playerCard).toContainText("Arthur King");
    await expect(playerCard).toContainText("Lv.55");
    await expect(playerCard).toContainText("36 ms");
    await expect(playerCard).toContainText("海岛探险档案");
    await expect(playerCard).toContainText("只读快照");
    await playerCard.getByRole("button", { name: "查看探索进度" }).click();
  }
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Arthur King");
  await expect(dialog).toContainText(`Player ID：${savePlayerId}`);
  await expect(dialog).toContainText("全图探索度");
  await expect(dialog).toContainText("巨鹫之像");
  await expect(dialog).toContainText("87%");
  await expect(dialog).toContainText("已发现帕鲁种类");
  await expect(dialog).toContainText("61");
  await expect(dialog).toContainText("48/ 174");
  await expect(dialog).toContainText("6/ 13");
  await expect(dialog).toContainText("18次");
  await expect(dialog).toContainText("累计通关次数 · 游戏共 3 处油田");
  await expect(dialog.locator(".psc-exploration-metrics article").first().locator("strong")).toHaveText("87%");
  await expect(dialog).toContainText("累计捕获帕鲁数量");
  await expect(dialog).toContainText("1,840");
  await expect(dialog).not.toContainText("100%");
  await expect(dialog).not.toContainText("61/61");
  if ((page.viewportSize()?.width ?? 0) > 700) {
    await expect(dialog).toHaveCSS("width", "780px");
    await expect(dialog.locator(".psc-exploration-body")).toHaveCSS("padding", "24px");
    await expect(dialog.locator(".psc-exploration-metrics article").first()).toHaveCSS("padding", "16px");
  } else {
    await expect(dialog).toHaveCSS("width", "390px");
    await expect(dialog.locator(".psc-exploration-metrics article").first()).toHaveCSS("padding", "14px");
  }
  expect(new URL(playerListRequest).searchParams.get("snapshotId")).toBe("world-real");
  if ((page.viewportSize()?.width ?? 0) <= 760) {
    await expect(dialog.getByRole("button", { name: "调整抽屉高度" })).toBeVisible();
    await dialog.locator(".psc-exploration-footer").scrollIntoViewIfNeeded();
    await expect(dialog.locator(".psc-exploration-footer")).toBeInViewport();
    await dialog.evaluate(element => { element.scrollTop = 0; });
  }
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: test.info().outputPath("exploration-sheet.png") });
});
