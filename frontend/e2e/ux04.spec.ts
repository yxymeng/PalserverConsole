import { expect, test } from "@playwright/test";

const worldContract = { queryVersion: 1, cacheSchema: "world-asset-cache", cacheSchemaVersion: 15, metadataSchema: "palserver-console-world-metadata", metadataSchemaVersion: 1, metadataDataVersion: "2026.08.25.3" };

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux04-csrf", lanWarning: null, port: 8223 };
const shell = { observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-1" };
const playerProgress = { state: "complete", values: { discoveredPalSpecies: 12, capturedPals: 3456, fastTravelPoints: 18, exploredAreas: 7, fieldBosses: 4, towerBosses: 2, dungeonClears: 9, oilRigClears: 3, technologyPoints: 14, ancientTechnologyPoints: 5, recipes: 62 }, unavailable: [] };
const player = { id: "player-1", instanceId: "instance-player-1", name: "Alice", level: 20, guildId: "guild-1", guildName: "测试工会", lastRecordedAt: "2026-08-25T12:00:00+00:00", progress: playerProgress };
const care = { currentHp: 0, hunger: 12, hungerRaw: null, hungerStatus: null, sanity: 40, physicalHealth: null, disease: "EPalStatus::Cold", activity: "EPalActivity::Working", diseaseRecorded: true, activityRecorded: true, reasons: ["zero_hp", "disease", "hunger_low", "san_low"], unavailable: [], severity: "critical", attention: true };
const unavailableCare = { currentHp: null, hunger: null, hungerRaw: null, hungerStatus: null, sanity: null, physicalHealth: null, disease: null, activity: null, diseaseRecorded: false, activityRecorded: false, reasons: [], unavailable: ["currentHp", "hunger", "sanity", "disease", "activity"], severity: "unavailable", attention: false };
const aptitude = { speciesRarity: 1, ivs: { hp: 90, attack: 80, defense: 70, average: 80 }, workSuitabilities: [{ type: "Handcraft", level: 1 }, { type: "Transport", level: 1 }], metadataKnown: true, metadataLabel: null };
const unknownAptitude = { speciesRarity: null, ivs: { hp: null, attack: null, defense: null, average: null }, workSuitabilities: [], metadataKnown: false, metadataLabel: "资料未收录" };
const palSkills = {
  passive: [{ id: "Legend", name: "传说", description: "攻击 +20%，防御 +20%", sourceName: "Legend", rank: 4, element: null, power: null, cooldown: null, metadataKnown: true }],
  equipped: [{ id: "AirCanon", name: null, description: null, sourceName: "Air Cannon", rank: null, element: "Normal", power: 40, cooldown: 2, metadataKnown: true }],
  learned: [{ id: "PowerShot", name: null, description: null, sourceName: "Power Shot", rank: null, element: "Normal", power: 80, cooldown: 4, metadataKnown: true }],
  partner: { id: "Fluffy Shield", name: null, description: "装备到玩家身上并成为盾牌。", sourceName: "Fluffy Shield", rank: null, element: null, power: null, cooldown: null, metadataKnown: true },
};
const noSkills = { passive: [], equipped: [], learned: [], partner: null };
const pal = { id: "pal-1", nickname: "小羊", characterId: "SheepBall", level: 18, ownerPlayerId: "player-1", ownerName: "Alice", baseId: "base-1", baseName: "据点一号", containerId: "container-1", slotIndex: 2, assignment: "base_worker", gender: "Female", rank: 1, isLucky: true, aptitude, skills: palSkills, care };
const unknownPal = { id: "pal-2", nickname: "", characterId: "FuturePal", level: 1, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned", aptitude: unknownAptitude, skills: noSkills, care: unavailableCare };
const sortPal = { id: "pal-3", nickname: "阿帕", characterId: "SheepBall", level: 6, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned", aptitude, skills: noSkills, care: unavailableCare };
const guild = { id: "guild-1", name: "测试工会", memberCount: 1, baseCount: 1, adminPlayerId: "player-1", adminPlayerName: "Alice", members: [{ id: "player-1", name: "Alice", level: 20, role: "leader" }] };
const base = { id: "base-1", name: "据点一号", guildId: "guild-1", guildName: "测试工会", workerContainerId: "container-1", x: 1, y: 2, z: 3, workerCount: 1, maxWorkerCount: 15, workers: [pal] };
let reparseRequests = 0;

test("UX-04：训练家与帕鲁详情、公会据点卡片及关联跳转", async ({ page }, testInfo) => {
  reparseRequests = 0;
  await page.addInitScript(() => window.localStorage.setItem("palserver-console-theme", "island"));
  const worldListUrls: URL[] = [];
  const rosterUrls: URL[] = [];
  const inventoryUrls: URL[] = [];
  let reparseStatusReads = 0;
  let activeSnapshotId = "world";
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
    if (path === "/api/world/snapshots/current") {
      if (reparseRequests > 0) reparseStatusReads += 1;
      const firstAttempt = reparseRequests === 1;
      const parsing = firstAttempt && reparseStatusReads === 2;
      const incompatible = firstAttempt && reparseStatusReads === 1;
      const failed = reparseRequests === 2 && reparseStatusReads >= 1;
      if (firstAttempt && reparseStatusReads >= 3) activeSnapshotId = "world-new";
      const parseStatus = parsing ? "parsing" : incompatible ? "incompatible" : failed ? "failed" : "ready";
      const errorCode = incompatible ? "CACHE_SCHEMA_INCOMPATIBLE" : failed ? "SNAPSHOT_PARSE_FAILED" : null;
      return route.fulfill({ json: {
      contract: worldContract, source: "save-snapshot", observedAt: activeSnapshotId === "world-new" ? 1_786_000_100 : 1_786_000_000, stale: incompatible || failed, errorCode, error: errorCode, snapshotId: activeSnapshotId, parsing, parseDurationMs: 42, gameTimeTicks: 122_688_000_000_000,
      sourceObservedAt: activeSnapshotId === "world-new" ? 1_786_000_100 : 1_786_000_000, collectedAt: 1_786_000_000, parsedAt: parsing ? null : 1_786_000_042, parseStatus,
      reparseGeneration: incompatible ? 0 : reparseRequests,
      dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
      counts: { players: 1, pals: 3, guilds: 1, bases: 1, inventory_items: 1, work_pals: 1 },
      overview: { assets: { players: 1, pals: 3, palSpecies: 2, itemTypes: 2, itemQuantity: 26, bases: 1, guilds: 1 }, actions: { attentionPals: 1, luckyPals: 1, bossPals: 0, unassignedPals: 2, unknownItems: 1, unknownPalMetadata: 1, careUnavailable: 2 } },
    } });
    }
    if (path === "/api/world/reparse") {
      if (route.request().method() === "POST") {
        reparseRequests += 1;
        reparseStatusReads = 0;
      }
      return route.fulfill({ json: { message: "已开始只读重新解析", reparseGeneration: reparseRequests } });
    }
    if (path === "/api/world/pals/roster") {
      rosterUrls.push(new URL(route.request().url()));
      const sort = new URL(route.request().url()).searchParams.get("sort");
      const marker = new URL(route.request().url()).searchParams.get("marker");
      const careFilter = new URL(route.request().url()).searchParams.get("care");
      const rosterPals = [{ ...pal, gender: "Female", rank: 1, isBoss: false, isLucky: true, locationType: "base" }, { ...unknownPal, gender: null, rank: null, isBoss: false, isLucky: false, locationType: "unassigned" }, { ...sortPal, gender: null, rank: null, isBoss: false, isLucky: false, locationType: "unassigned" }];
      const sorted = sort === "name" ? [rosterPals[2], rosterPals[0], rosterPals[1]] : rosterPals;
      const location = new URL(route.request().url()).searchParams.get("location");
      const items = careFilter === "attention" ? [rosterPals[0]] : marker === "lucky" ? [rosterPals[0]] : marker === "boss" ? [] : location === "unassigned" ? rosterPals.slice(1) : sorted;
      return route.fulfill({ json: { items, page: 1, pageSize: 60, total: items.length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null, careSummary: { total: 3, critical: 1, warning: 0, attention: 1, unavailable: 2 }, passiveSkills: palSkills.passive, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    if (path === "/api/world/inventory-items") {
      const requestUrl = new URL(route.request().url());
      inventoryUrls.push(requestUrl);
      const scope = requestUrl.searchParams.get("scope") || "all";
      const wood = (totalQuantity: number, locationCount: number) => ({ itemId: "Wood", name: "木材", category: "材料", rarity: "普通", metadataKnown: true, metadataLabel: null, totalQuantity, locationCount });
      const unknown = { itemId: "FutureOre", name: null, category: null, rarity: null, metadataKnown: false, metadataLabel: "资料未收录", totalQuantity: 4, locationCount: 1 };
      const metadata = requestUrl.searchParams.get("metadata");
      const scopedItems = scope === "player" ? [wood(3, 1)] : scope === "base" ? [wood(9, 2), unknown] : scope === "world" ? [wood(6, 3)] : scope === "inventory" ? [wood(12, 3), unknown] : [wood(22, 7), unknown];
      const items = metadata === "unknown" ? scopedItems.filter((item) => !item.metadataKnown) : scopedItems;
      return route.fulfill({ json: { items, categories: ["材料"], page: 1, pageSize: 60, total: items.length, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, snapshotId: activeSnapshotId, stale: false, parsing: false, parseStatus: "ready", errorCode: null, dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    if (path === "/api/world/inventory-items/Wood") {
      const requestUrl = new URL(route.request().url());
      const scope = requestUrl.searchParams.get("scope") || "all";
      const selectedType = requestUrl.searchParams.get("locationType");
      const playerLocation = { id: 1, locationType: "player", locationLabel: "玩家：Alice", ownerId: "player-1", ownerName: "Alice", baseId: null, baseName: null, slotIndex: 0, quantity: 3, containerId: "bag-1", mapObjectType: null, mapObjectInstanceId: null, worldPosition: null };
      const baseLocations = [{ id: 2, locationType: "base", locationLabel: "据点：据点一号", ownerId: null, ownerName: null, baseId: "base-1", baseName: "据点一号", slotIndex: 1, quantity: 7, containerId: "base-bag", mapObjectType: null, mapObjectInstanceId: null, worldPosition: null }, { id: 3, locationType: "base", locationLabel: "据点：据点一号", ownerId: null, ownerName: null, baseId: "base-1", baseName: "据点一号", slotIndex: 2, quantity: 2, containerId: "base-bag", mapObjectType: null, mapObjectInstanceId: null, worldPosition: null }];
      const worldLocations = [{ id: 4, locationType: "world", locationLabel: "世界宝箱", ownerId: null, ownerName: null, baseId: null, baseName: null, slotIndex: 1, quantity: 2, containerId: "world-box-1", mapObjectType: "TreasureBox", mapObjectInstanceId: "map-object-1", worldPosition: { x: 1, y: 2, z: 3 } }, { id: 5, locationType: "world", locationLabel: "世界宝箱", ownerId: null, ownerName: null, baseId: null, baseName: null, slotIndex: 2, quantity: 3, containerId: "world-box-1", mapObjectType: "TreasureBox", mapObjectInstanceId: "map-object-1", worldPosition: { x: 1, y: 2, z: 3 } }, { id: 6, locationType: "world", locationLabel: "世界宝箱", ownerId: null, ownerName: null, baseId: null, baseName: null, slotIndex: 0, quantity: 1, containerId: "world-box-2", mapObjectType: "TreasureBox_RequiredLongHold", mapObjectInstanceId: "map-object-2", worldPosition: null }];
      const unassignedLocation = { id: 7, locationType: "unassigned", locationLabel: "未关联容器", ownerId: null, ownerName: null, baseId: null, baseName: null, slotIndex: 0, quantity: 4, containerId: "unknown-box", mapObjectType: null, mapObjectInstanceId: null, worldPosition: null };
      const allGroups = [{ locationType: "player", groupId: "player-1", label: "玩家：Alice", quantitySum: 3, locationCount: 1, containerCount: 1 }, { locationType: "base", groupId: "base-1", label: "据点：据点一号", quantitySum: 9, locationCount: 2, containerCount: 1 }, { locationType: "world", groupId: null, label: "其他位置", quantitySum: 6, locationCount: 3, containerCount: 2 }, { locationType: "unassigned", groupId: null, label: "未识别位置", quantitySum: 4, locationCount: 1, containerCount: 1 }];
      const groups = scope === "player" ? allGroups.slice(0, 1) : scope === "base" ? allGroups.slice(1, 2) : scope === "world" ? allGroups.slice(2, 3) : scope === "inventory" ? allGroups.slice(0, 2) : allGroups;
      const locationsByType: Record<string, object[]> = { player: [playerLocation], base: baseLocations, world: worldLocations, unassigned: [unassignedLocation] };
      const locations = selectedType ? locationsByType[selectedType] || [] : [];
      const total = selectedType ? locations.length : groups.reduce((sum, group) => sum + group.locationCount, 0);
      return route.fulfill({ json: { itemId: "Wood", groups, locations, page: 1, pageSize: selectedType ? 100 : 1, total, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, snapshotId: activeSnapshotId, stale: false, parsing: false, parseStatus: "ready", errorCode: null, dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } } } });
    }
    const lists: Record<string, object[]> = { "/api/world/players": [player], "/api/world/pals": [pal, unknownPal, sortPal], "/api/world/guilds": [guild], "/api/world/bases": [base] };
    if (path in lists) {
      worldListUrls.push(new URL(route.request().url()));
      const page = Number(new URL(route.request().url()).searchParams.get("page") || 1);
      return route.fulfill({ json: { items: lists[path], page, pageSize: 50, total: path === "/api/world/guilds" ? 51 : lists[path].length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null } });
    }
    const details: Record<string, object> = {
      "/api/world/players/player-1": { ...player, guild, pals: [pal], partyPals: [pal], storagePals: [], inventory: [{ id: "item-1", itemId: "Wood", quantity: 3, containerId: "bag-1" }] },
      "/api/world/pals/pal-1": { ...pal, snapshotId: "world", owner: player, base, container: { id: "container-1", kind: "base_workers", slotCount: 20 }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } },
      "/api/world/guilds/guild-1": { ...guild, members: [player], bases: [base], pals: [pal], assetSummary: { memberCount: 1, baseCount: 1, palCount: 1, inventory: { itemTypeCount: 2, totalQuantity: 12, locationCount: 3 } }, missingMemberIds: ["missing-player"], missingBaseIds: [] },
      "/api/world/bases/base-1": { ...base, guild, guildAssociation: "linked", workers: [pal], workerCount: 1, careSummary: { total: 1, critical: 1, warning: 0, attention: 1, unavailable: 0 }, inventorySummary: { itemTypeCount: 2, totalQuantity: 9, locationCount: 2 } },
    };
    if (path in details) return route.fulfill({ json: details[path] });
    return route.fulfill({ status: 404, json: { errorCode: "WORLD_ENTITY_NOT_FOUND", message: path } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();

  const tabs = page.getByRole("tablist", { name: "世界资产工作区" });
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(tabs).toContainText("世界资产总览");
  await expect(tabs).toContainText("训练家档案");
  await expect(tabs).toContainText("帕鲁图鉴花名册");
  await expect(tabs).toContainText("公会与据点");
  await expect(tabs).toContainText("全服物资检索");
  await expect(page.getByRole("heading", { name: "世界资产总览" })).toBeVisible();
  await expect(page.locator(".world-overview-assets")).toContainText("覆盖 2 种帕鲁");
  await expect(page.locator(".world-overview-assets")).toContainText("玩家、据点与公会合计 26 件");
  await expect(page.locator(".world-overview-assets button").filter({ hasText: "登记训练家" })).toContainText("当前在线 0 名");
  await expect(page.locator(".world-overview-assets button").filter({ hasText: "全服物资" })).toContainText("2种");
  await expect(page.locator(".world-overview-assets button").filter({ hasText: "游戏历法" })).toContainText("Day 142");
  await expect(page.locator(".world-overview-progress-note")).toContainText("不会用当前分页结果推算");
  await expect(page.locator(".world-overview-actions")).not.toContainText("未知物品");
  await expect(page.locator(".world-overview-actions")).not.toContainText("未归属帕鲁");
  await page.waitForTimeout(500);
  await page.screenshot({ path: `../.impeccable/review/${testInfo.project.name}.png`, fullPage: true });
  await page.locator(".world-snapshot-status summary").click();
  await expect(page.locator(".world-snapshot-popover")).toContainText("存档记录");
  await expect(page.locator(".world-snapshot-popover")).toContainText("解析完成");
  await expect(page.locator(".world-snapshot-popover")).toContainText("不会修改真实 .sav");
  await page.getByRole("button", { name: "关闭快照状态" }).click();
  await tabs.getByRole("tab", { name: "全服物资检索" }).click();
  await expect(page.locator(".inventory-workspace")).toContainText("世界宝箱和其他地图容器不计入仓库");
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "inventory")).toBeTruthy();
  await expect(page.getByLabel("仓库范围").getByRole("button", { name: "全部持有" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".inventory-workspace")).toContainText("木材");
  for (const scope of ["玩家背包", "据点箱子"] as const) {
    const beforeScopeChange = inventoryUrls.length;
    await page.getByLabel("仓库范围").getByRole("button", { name: scope }).click();
    await expect.poll(() => inventoryUrls.slice(beforeScopeChange).some((url) => url.searchParams.get("scope") === ({ "玩家背包": "player", "据点箱子": "base" } as const)[scope])).toBeTruthy();
    const beforeClear = inventoryUrls.length;
    await page.locator(".inventory-toolbar").getByRole("button", { name: "清除筛选" }).click();
    await expect.poll(() => inventoryUrls.slice(beforeClear).some((url) => url.searchParams.get("scope") === "inventory" && !url.searchParams.has("ownerId") && !url.searchParams.has("baseId") && !url.searchParams.has("guildId") && !url.searchParams.has("metadata"))).toBeTruthy();
    await expect(page.getByLabel("仓库范围").getByRole("button", { name: "全部持有" })).toHaveAttribute("aria-pressed", "true");
  }
  const woodSummary = page.locator(".inventory-item-summary").filter({ hasText: "木材" });
  await expect(woodSummary).toContainText("持有总量");
  await expect(woodSummary).toContainText("存放记录");
  await expect(woodSummary).toContainText("12");
  await woodSummary.click();
  await expect(page.locator(".inventory-locations")).toContainText("玩家：Alice");
  await expect(page.locator(".inventory-locations")).toContainText("据点：据点一号");
  await expect(page.locator(".inventory-locations")).not.toContainText("其他位置");
  await page.locator(".inventory-location-group-summary").filter({ hasText: "玩家：Alice" }).click();
  await expect(page.locator(".inventory-locations")).toContainText("槽位 1");
  await expect(page.locator(".inventory-locations details").first()).not.toHaveAttribute("open", "");
  await expect(page.locator(".inventory-locations details code").first()).not.toBeVisible();
  await page.locator(".inventory-locations").getByText("技术信息").first().click();
  await expect(page.locator(".inventory-locations")).toContainText("bag-1");
  await expect(page.getByLabel("仓库范围").getByRole("button", { name: "世界" })).toHaveCount(0);
  await expect(page.getByLabel("仓库范围").getByRole("button", { name: "全部", exact: true })).toHaveCount(0);
  await expect(page.locator(".inventory-workspace")).not.toContainText("<characterName");
  await page.getByLabel("仓库范围").getByRole("button", { name: "玩家背包" }).click();
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "player")).toBeTruthy();
  await expect(page.locator(".inventory-item-summary")).toHaveCount(1);
  await expect(page.locator(".inventory-item-summary")).toContainText("3");
  await tabs.getByRole("tab", { name: "训练家档案" }).click();
  await expect(page.locator(".world-player-card-avatar")).toHaveText("A");
  await expect(page.locator(".world-list-panel")).toContainText("测试工会");
  await expect(page.locator(".world-list-panel")).toContainText("累计捕获 3,456 只");
  await expect(page.locator(".world-list-panel")).toContainText("完整数据");
  await page.screenshot({ path: `../.impeccable/review/${testInfo.project.name}-players.png`, fullPage: true });

  const playerCard = page.locator(".world-player-card").filter({ hasText: "Alice" });
  await playerCard.getByRole("button", { name: "查看完整训练家档案" }).click();
  const drawer = page.getByLabel("世界实体详情");
  await expect(page.locator('.world-player-card[data-selected="true"]')).toContainText("Alice");
  if (testInfo.project.name === "mobile") {
    await expect(drawer).toHaveAttribute("role", "dialog");
    await expect(drawer).toHaveAttribute("aria-modal", "true");
    await expect(drawer.getByRole("button", { name: "关闭详情" })).toBeFocused();
  }
  await expect(drawer).toContainText("已发现帕鲁种类");
  await expect(drawer).toContainText("累计捕获帕鲁数量");
  await expect(drawer).toContainText("已完成野外头目项目");
  await expect(drawer).toContainText("已完成高塔");
  await expect(drawer).toContainText("地下城通关次数");
  await expect(drawer).toContainText("油田通关次数");
  await expect(drawer).not.toContainText("累计击杀");
  await expect(drawer.getByText("Player ID")).toBeHidden();
  await drawer.getByText("技术信息", { exact: true }).click();
  await expect(drawer.getByText("Player ID")).toBeVisible();
  await expect(drawer).toContainText("拥有帕鲁");
  await drawer.locator(".world-relation-section").filter({ hasText: "拥有帕鲁" }).getByRole("button", { name: /小羊/ }).click();
  await expect(drawer).toContainText("编号:");
  await expect(drawer).toContainText("所属训练家:");
  await drawer.getByRole("button", { name: "关闭帕鲁详情" }).click();
  await expect(drawer).toContainText("队伍帕鲁");
  await drawer.getByRole("button", { name: "在仓库中查看" }).click();
  await expect(page.locator(".inventory-context")).toContainText("玩家库存：Alice");
  await expect(page.locator(".inventory-workspace")).toContainText("3");
  await page.locator(".inventory-toolbar").getByRole("button", { name: "清除筛选" }).click();
  await expect.poll(() => inventoryUrls.at(-1)?.searchParams.get("scope")).toBe("inventory");
  await expect(inventoryUrls.at(-1)?.searchParams.has("ownerId")).toBeFalsy();
  await expect(page.locator(".inventory-context")).toHaveCount(0);
  await tabs.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();

  await expect(page.locator(".pal-roster")).toContainText("FuturePal");
  await expect(page.locator(".pal-roster")).toContainText("据点工作");
  const palRow = page.locator(".pal-roster-row").filter({ hasText: "小羊" });
  await expect(palRow.locator(".world-pal-gender")).toHaveText("♀");
  await expect(palRow.locator(".world-pal-gender")).toHaveAttribute("title", "雌性");
  await expect(palRow.locator('[data-label="等级 / 星级"]')).toContainText("1 星");
  await expect(palRow.locator('[data-label="资质"]')).toContainText("稀有度 1");
  await expect(palRow.locator('[data-label="工作适应性"]')).toContainText("手工作业 1");
  await expect(palRow.locator('[data-label="个体标记"]')).toHaveText("闪光");
  await expect(palRow.locator('[data-label="归属"]')).toContainText("据点一号");
  await expect(palRow.locator('[data-label="照护状态"]')).toContainText("需立即处理");
  await expect(palRow).not.toContainText("base-1");
  await expect(page.locator('[data-icon-key="pal-placeholder"]')).toHaveCount(1);
  await page.getByText("资质、工作与被动技能", { exact: true }).click();
  if (testInfo.project.name === "mobile") {
    const aptitudeDialog = page.getByRole("dialog", { name: "资质、工作与被动技能" });
    await expect(aptitudeDialog).toHaveAttribute("aria-modal", "true");
    await expect(aptitudeDialog).toHaveCSS("position", "fixed");
    await expect(aptitudeDialog.getByRole("button", { name: "关闭高级筛选" })).toBeFocused();
  }
  await page.getByLabel("最低物种稀有度").fill("1");
  await page.getByLabel("最低工作等级").selectOption("1");
  await page.getByLabel("手工作业", { exact: true }).check();
  await page.getByLabel("搬运", { exact: true }).check();
  await page.getByRole("checkbox", { name: /传说/ }).check();
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.some((url) => url.searchParams.get("minRarity") === "1" && url.searchParams.get("workSuitability") === "Handcraft,Transport" && url.searchParams.get("minWorkLevel") === "1" && url.searchParams.get("passiveSkill") === "Legend")).toBeTruthy();
  if (testInfo.project.name === "mobile") await expect(page.getByRole("button", { name: /资质、工作与被动技能/ })).toBeFocused();
  await expect(page.getByLabel("已应用筛选")).toContainText("手工作业 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("搬运 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("传说");
  const requestCount = rosterUrls.length;
  await page.getByLabel("已应用筛选").getByRole("button", { name: "传说" }).click();
  await expect.poll(() => rosterUrls.slice(requestCount).some((url) => !url.searchParams.has("passiveSkill"))).toBeTruthy();
  await page.getByLabel("帕鲁图鉴花名册排序").selectOption("name");
  await expect(page.locator(".pal-roster-row").first()).toContainText("阿帕");
  await page.getByRole("button", { name: "小羊" }).click();
  const palDrawer = page.getByRole("dialog", { name: "帕鲁详情" });
  await expect(palDrawer).toContainText("编号:");
  await expect(palDrawer).toContainText("棉悠悠");
  await expect(palDrawer).toContainText("稀有闪光");
  await expect(palDrawer).toContainText("帕鲁六维基础与强化数值");
  await expect(palDrawer).toContainText("SAN 理智值");
  await expect(palDrawer).toContainText("饱食与负荷储备");
  await expect(palDrawer).toContainText("综合 IV");
  await expect(palDrawer).toContainText("工作适应性技能");
  await expect(palDrawer).toContainText("被动特性词条");
  await expect(palDrawer).toContainText("配备主动战斗技能");
  await expect(palDrawer).toContainText("传说");
  await expect(palDrawer).toContainText("威力 40");
  await expect(palDrawer).toContainText("所属训练家:");
  const closePalDrawer = palDrawer.getByRole("button", { name: "关闭帕鲁详情" });
  await expect(closePalDrawer).toBeFocused();
  const passiveTrigger = palDrawer.locator(".pal-passive-grid button").first();
  await passiveTrigger.click();
  const passiveDialog = palDrawer.getByRole("dialog", { name: "被动词条详情" });
  await expect(passiveDialog).toContainText("攻击 +20%，防御 +20%");
  await expect(passiveDialog.getByRole("button", { name: "关闭被动词条详情" })).toBeFocused();
  await passiveDialog.getByRole("button", { name: "关闭被动词条详情" }).click();
  await expect(passiveTrigger).toBeFocused();
  const palDrawerControls = palDrawer.locator("button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])");
  const firstPalDrawerControl = palDrawerControls.first();
  const lastPalDrawerControl = palDrawerControls.last();
  await firstPalDrawerControl.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(lastPalDrawerControl).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstPalDrawerControl).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`ux05-${testInfo.project.name}.png`), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(palDrawer).toBeHidden();
  await expect(page.getByRole("button", { name: "小羊" })).toBeFocused();
  await page.getByRole("button", { name: "需要关注" }).click();
  await expect(page.locator(".pal-roster-row")).toHaveCount(1);

  await page.getByRole("tab", { name: "公会与据点" }).click();
  const guildPanel = page.locator(".world-community-panel").filter({ hasText: "全服公会组织" });
  const basePanel = page.locator(".world-community-panel").filter({ hasText: "据点分布与打工帕鲁" });
  await expect(guildPanel).toContainText("测试工会");
  await expect(guildPanel).toContainText("会长 / 管理员: Alice");
  await expect(guildPanel).toContainText("Alice (Lv.20)");
  await expect(basePanel).toContainText("据点一号");
  await expect(basePanel).toContainText("1 / 15 打工帕鲁");
  await expect.poll(() => {
    const guildRequest = worldListUrls.findLast((url) => url.pathname === "/api/world/guilds");
    const baseRequest = worldListUrls.findLast((url) => url.pathname === "/api/world/bases");
    return guildRequest?.searchParams.get("snapshotId") === baseRequest?.searchParams.get("snapshotId") ? baseRequest?.searchParams.get("snapshotId") : null;
  }).toBe("world");
  await expect(page.locator(".world-community-controls")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /查看公会资产|查看据点资产/ })).toHaveCount(0);
  await expect(guildPanel.locator(".audit-footer")).toContainText("第 1/2 页");
  await guildPanel.getByTitle("下一页").click();
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/guilds" && url.searchParams.get("page") === "2")).toBeTruthy();
  await expect(guildPanel.locator(".audit-footer")).toContainText("第 2/2 页");
  await page.screenshot({ path: `../.impeccable/review/${testInfo.project.name}-community.png`, fullPage: true });
  await expect(basePanel.locator(".world-community-card")).toContainText("1 / 15 打工帕鲁");
  await expect(basePanel.locator(".world-community-card")).toContainText("X: 1, Y: 2, Z: 3");
  await basePanel.getByRole("button", { name: "小羊 (Lv.18)" }).click();
  await expect(drawer).toContainText("SheepBall");
  await drawer.getByRole("button", { name: "关闭帕鲁详情" }).click();
  await page.getByRole("button", { name: "重新解析" }).click();
  await expect.poll(() => reparseRequests).toBe(1);
  await expect.poll(() => reparseStatusReads).toBeGreaterThanOrEqual(3);
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/bases" && url.searchParams.get("snapshotId") === "world-new")).toBeTruthy();
  await page.getByRole("button", { name: "重新解析" }).click();
  await expect.poll(() => reparseRequests).toBe(2);
  await expect(page.getByText(/SNAPSHOT_PARSE_FAILED/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`ux04-${testInfo.project.name}.png`), fullPage: true });
});

test("UX-04：仓库位置请求不会让旧响应覆盖当前展开项", async ({ page }) => {
  const snapshot = {
    contract: worldContract, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1,
    snapshotId: "race", stale: false, errorCode: null, error: null, parsing: false, parseStatus: "ready", reparseGeneration: 0,
    parseDurationMs: null, peakMemoryBytes: null, cacheSizeBytes: null, gameTimeTicks: null,
    dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
    counts: { players: 0, pals: 0, guilds: 0, bases: 0, containers: 0, inventory_items: 2, work_pals: 0 },
    overview: { assets: { players: 0, pals: 0, palSpecies: 0, itemTypes: 2, itemQuantity: 2, bases: 0, guilds: 0 }, actions: { attentionPals: 0, luckyPals: 0, bossPals: 0, unassignedPals: 0, unknownItems: 0, unknownPalMetadata: 0, careUnavailable: 0 } },
  };
  const coverage = snapshot.dataCoverage;
  const item = (itemId: string, name: string) => ({ itemId, name, category: "材料", rarity: null, metadataKnown: true, metadataLabel: null, totalQuantity: 1, locationCount: 2 });
  const group = (locationType: "player" | "base", label: string) => ({ locationType, groupId: `${locationType}-1`, label, quantitySum: 1, locationCount: 1, containerCount: 1 });
  const detail = (itemId: string, groups: object[], locations: object[]) => ({ itemId, groups, locations, page: 1, pageSize: 100, total: locations.length, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, snapshotId: "race", stale: false, parsing: false, parseStatus: "ready", errorCode: null, dataCoverage: coverage });
  const location = (id: number, label: string, locationType: "player" | "base") => ({ id, locationType, locationLabel: label, ownerId: null, ownerName: null, guildId: null, guildName: null, baseId: null, baseName: null, slotIndex: 0, quantity: 1, containerId: `container-${id}`, mapObjectType: null, mapObjectInstanceId: null, worldPosition: null });
  let releaseOldItem: () => void = () => undefined;
  const oldItemReleased = new Promise<void>((resolve) => { releaseOldItem = resolve; });
  let markOldItemStarted: () => void = () => undefined;
  const oldItemStarted = new Promise<void>((resolve) => { markOldItemStarted = resolve; });
  let releaseOldGroup: () => void = () => undefined;
  const oldGroupReleased = new Promise<void>((resolve) => { releaseOldGroup = resolve; });
  let markOldGroupStarted: () => void = () => undefined;
  const oldGroupStarted = new Promise<void>((resolve) => { markOldGroupStarted = resolve; });

  await page.route("**/api/auth/status", (route) => route.fulfill({ json: auth }));
  await page.route("**/api/shell/status", (route) => route.fulfill({ json: shell }));
  await page.route("**/api/server/settings", (route) => route.fulfill({ json: { executablePath: shell.executablePath, launchArguments: "" } }));
  await page.route("**/api/operations/health", (route) => route.fulfill({ json: { observedAt: 1, capacity: { state: "ok", freeBytes: 1, totalBytes: 1, minimumFreeBytes: 1, copyBytes: 1, requiredFreeBytes: 1, warningFreeBytes: 1, sourceErrorCode: null, errorCode: null }, directories: [], world: { state: "healthy", lastSuccessAt: 1, snapshotId: "race", parsing: false, errorCode: null, cacheSizeBytes: 0 }, backups: { state: "healthy", lastSuccessAt: 1, itemCount: 0, validCount: 0, invalidCount: 0, totalBytes: 0, errorCode: null }, background: [], alerts: [] } }));
  await page.route("**/api/live/**", (route) => route.fulfill({ json: { data: {}, source: "rest", observedAt: 1, stale: false, errorCode: null } }));
  await page.route("**/api/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "" }));
  await page.route("**/api/world/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/world/snapshots/current") return route.fulfill({ json: snapshot });
    if (url.pathname === "/api/world/inventory-items") return route.fulfill({ json: { items: [item("A", "物品 A"), item("B", "物品 B")], categories: ["材料"], page: 1, pageSize: 60, total: 2, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, snapshotId: "race", stale: false, parsing: false, parseStatus: "ready", errorCode: null, dataCoverage: coverage, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "test", errorCode: null } } });
    if (url.pathname === "/api/world/inventory-items/A") {
      markOldItemStarted();
      await oldItemReleased;
      return route.fulfill({ json: detail("A", [group("player", "过期 A 分组")], []) }).catch(() => undefined);
    }
    if (url.pathname === "/api/world/inventory-items/B") {
      const locationType = url.searchParams.get("locationType");
      if (!locationType) return route.fulfill({ json: detail("B", [group("player", "玩家分组"), group("base", "据点分组")], []) });
      if (locationType === "player") {
        markOldGroupStarted();
        await oldGroupReleased;
        return route.fulfill({ json: detail("B", [group("player", "玩家分组"), group("base", "据点分组")], [location(1, "过期玩家位置", "player")]) }).catch(() => undefined);
      }
      return route.fulfill({ json: detail("B", [group("player", "玩家分组"), group("base", "据点分组")], [location(2, "最新据点位置", "base")]) });
    }
    return route.fulfill({ status: 404, json: { errorCode: "WORLD_TEST_UNROUTED", message: url.pathname } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "全服物资检索" }).click();
  const itemA = page.locator(".inventory-item-summary").filter({ hasText: "物品 A" });
  const itemB = page.locator(".inventory-item-summary").filter({ hasText: "物品 B" });
  await itemA.click();
  await oldItemStarted;
  await itemB.click();
  await expect(page.locator(".inventory-locations")).toContainText("玩家分组");
  releaseOldItem();
  await page.waitForTimeout(50);
  await expect(page.locator(".inventory-locations")).toContainText("玩家分组");
  await expect(page.locator(".inventory-locations")).not.toContainText("过期 A 分组");

  await page.locator(".inventory-location-group-summary").filter({ hasText: "玩家分组" }).click();
  await oldGroupStarted;
  await page.locator(".inventory-location-group-summary").filter({ hasText: "据点分组" }).click();
  await expect(page.locator(".inventory-location-details")).toContainText("最新据点位置");
  releaseOldGroup();
  await page.waitForTimeout(50);
  await expect(page.locator(".inventory-location-details")).toContainText("最新据点位置");
  await expect(page.locator(".inventory-location-details")).not.toContainText("过期玩家位置");
});
