import { expect, test } from "@playwright/test";

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
const pal = { id: "pal-1", nickname: "小羊", characterId: "SheepBall", level: 18, ownerPlayerId: "player-1", ownerName: "Alice", baseId: "base-1", baseName: "据点一号", containerId: "container-1", slotIndex: 2, assignment: "base_worker", detail: { gender: "Female", rank: 1, isLucky: true }, aptitude, skills: palSkills, care };
const unknownPal = { id: "pal-2", nickname: "", characterId: "FuturePal", level: 1, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned", aptitude: unknownAptitude, skills: noSkills, care: unavailableCare };
const sortPal = { id: "pal-3", nickname: "阿帕", characterId: "SheepBall", level: 6, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned", aptitude, skills: noSkills, care: unavailableCare };
const guild = { id: "guild-1", name: "测试工会", memberCount: 1, baseCount: 1 };
const base = { id: "base-1", name: "据点一号", guildId: "guild-1", workerContainerId: "container-1", x: 1, y: 2, z: 3 };
let reparseRequests = 0;

test("UX-04：四类实体统一列表详情模式并支持关联跳转", async ({ page }, testInfo) => {
  reparseRequests = 0;
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
      source: "save-snapshot", observedAt: activeSnapshotId === "world-new" ? 1_786_000_100 : 1_786_000_000, stale: incompatible || failed, errorCode, error: errorCode, snapshotId: activeSnapshotId, parsing, parseDurationMs: 42,
      sourceObservedAt: activeSnapshotId === "world-new" ? 1_786_000_100 : 1_786_000_000, collectedAt: 1_786_000_000, parsedAt: parsing ? null : 1_786_000_042, parseStatus,
      reparseGeneration: incompatible ? 0 : reparseRequests,
      dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
      counts: { players: 1, pals: 3, guilds: 1, bases: 1, inventory_items: 1, work_pals: 1 },
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
      const items = careFilter === "attention" ? [rosterPals[0]] : marker === "lucky" ? [rosterPals[0]] : marker === "boss" ? [] : sorted;
      return route.fulfill({ json: { items, page: 1, pageSize: 60, total: items.length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null, careSummary: { total: 3, critical: 1, warning: 0, attention: 1, unavailable: 2 }, passiveSkills: palSkills.passive, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    if (path === "/api/world/inventories") {
      const requestUrl = new URL(route.request().url());
      inventoryUrls.push(requestUrl);
      const scope = requestUrl.searchParams.get("scope") || "all";
      const wood = (totalQuantity: number, locationCount: number) => ({ itemId: "Wood", name: "木材", category: "材料", rarity: "普通", metadataKnown: true, metadataLabel: null, totalQuantity, locationCount });
      const unknown = { itemId: "FutureOre", name: null, category: null, rarity: null, metadataKnown: false, metadataLabel: "资料未收录", totalQuantity: 4, locationCount: 1 };
      const items = scope === "player" ? [wood(3, 1)] : scope === "base" ? [wood(9, 2), unknown] : scope === "world" ? [wood(6, 3)] : scope === "inventory" ? [wood(12, 3), unknown] : [wood(22, 7), unknown];
      return route.fulfill({ json: { items, categories: ["材料"], page: 1, pageSize: 60, total: items.length, source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, snapshotId: activeSnapshotId, stale: false, parsing: false, parseStatus: "ready", errorCode: null, dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    if (path === "/api/world/inventories/Wood") {
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
      return route.fulfill({ json: { items: lists[path], page: 1, pageSize: 50, total: lists[path].length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null } });
    }
    const details: Record<string, object> = {
      "/api/world/players/player-1": { ...player, guild, pals: [pal], partyPals: [pal], storagePals: [], inventory: [{ id: "item-1", itemId: "Wood", quantity: 3, containerId: "bag-1" }] },
      "/api/world/pals/pal-1": { ...pal, snapshotId: "world", owner: player, base, container: { id: "container-1", kind: "base_workers", slotCount: 20 }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } },
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
  await tabs.getByRole("tab", { name: "仓库" }).click();
  await expect(page.locator(".inventory-workspace")).toContainText("按物品汇总");
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "inventory")).toBeTruthy();
  await expect(page.getByLabel("库存范围").getByRole("button", { name: "库存" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".inventory-workspace")).toContainText("木材");
  const woodSummary = page.locator(".inventory-item-summary").filter({ hasText: "木材" });
  await expect(woodSummary).toContainText("库存总量");
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
  await page.getByLabel("库存范围").getByRole("button", { name: "世界" }).click();
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "world")).toBeTruthy();
  await expect(woodSummary).toContainText("世界容器总量");
  await expect(woodSummary).toContainText("6");
  await woodSummary.click();
  const worldGroup = page.locator(".inventory-location-group-summary").filter({ hasText: "其他位置" });
  await expect(worldGroup).toContainText("2处");
  await expect(page.locator(".inventory-locations")).not.toContainText("世界宝箱");
  await worldGroup.click();
  await expect(page.locator(".inventory-location")).toHaveCount(3);
  await expect(page.locator(".inventory-locations")).toContainText("世界宝箱");
  await page.locator(".inventory-location").last().getByText("技术信息").click();
  await expect(page.locator(".inventory-locations")).toContainText("TreasureBox_RequiredLongHold");
  await page.getByLabel("库存范围").getByRole("button", { name: "全部" }).click();
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "all")).toBeTruthy();
  await expect(woodSummary).toContainText("全世界总量");
  await expect(woodSummary).toContainText("22");
  await woodSummary.click();
  await expect(page.locator(".inventory-locations")).toContainText("未识别位置");
  await expect(page.locator(".inventory-locations")).toContainText("其他位置");
  await expect(page.locator(".inventory-workspace")).not.toContainText("<characterName");
  await page.getByLabel("库存范围").getByRole("button", { name: "玩家" }).click();
  await expect.poll(() => inventoryUrls.some((url) => url.searchParams.get("scope") === "player")).toBeTruthy();
  await expect(page.locator(".inventory-item-summary")).toHaveCount(1);
  await expect(page.locator(".inventory-item-summary")).toContainText("3");
  await tabs.getByRole("tab", { name: "玩家" }).click();
  await expect(page.locator(".world-player-avatar")).toHaveText("A");
  await expect(page.locator(".world-list-panel")).toContainText("测试工会");
  await expect(page.locator(".world-list-panel")).toContainText("发现 12 种 · 捕获 3,456 只");
  await expect(page.locator(".world-list-panel")).toContainText("完整数据");

  await page.getByRole("button", { name: "Alice" }).click();
  const drawer = page.getByLabel("世界实体详情");
  await expect(page.locator('.world-table-row[data-selected="true"]')).toContainText("Alice");
  if (testInfo.project.name === "mobile") await expect(drawer).toHaveAttribute("role", "dialog");
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
  await expect(drawer).toContainText("Character ID");
  await expect(drawer).toContainText("主人");
  await drawer.getByRole("button", { name: /Alice/ }).click();
  await expect(drawer).toContainText("队伍帕鲁");
  await drawer.getByRole("button", { name: "在仓库中查看" }).click();
  await expect(page.locator(".inventory-context")).toContainText("玩家库存：Alice");
  await expect(page.locator(".inventory-workspace")).toContainText("3");
  await tabs.getByRole("tab", { name: "帕鲁" }).click();

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
  if (testInfo.project.name === "mobile") await expect(page.locator(".pal-aptitude-filters[open]")).toHaveCSS("position", "fixed");
  await page.getByLabel("最低物种稀有度").fill("1");
  await page.getByLabel("最低工作等级").selectOption("1");
  await page.getByLabel("手工作业", { exact: true }).check();
  await page.getByLabel("搬运", { exact: true }).check();
  await page.getByRole("checkbox", { name: /传说/ }).check();
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.some((url) => url.searchParams.get("minRarity") === "1" && url.searchParams.get("workSuitability") === "Handcraft,Transport" && url.searchParams.get("minWorkLevel") === "1" && url.searchParams.get("passiveSkill") === "Legend")).toBeTruthy();
  await expect(page.getByLabel("已应用筛选")).toContainText("手工作业 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("搬运 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("传说");
  const requestCount = rosterUrls.length;
  await page.getByLabel("已应用筛选").getByRole("button", { name: "传说" }).click();
  await expect.poll(() => rosterUrls.slice(requestCount).some((url) => !url.searchParams.has("passiveSkill"))).toBeTruthy();
  await page.getByLabel("帕鲁名册排序").selectOption("name");
  await expect(page.locator(".pal-roster-row").first()).toContainText("阿帕");
  await page.getByRole("button", { name: "小羊" }).click();
  const palDrawer = page.getByRole("dialog", { name: "帕鲁详情" });
  await expect(palDrawer).toContainText("Character ID");
  await expect(palDrawer).toContainText("棉悠悠");
  await expect(palDrawer).toContainText("闪光 · 浓缩等级 1");
  await expect(palDrawer).toContainText("照护状态");
  await expect(palDrawer).toContainText("来自存档快照");
  await expect(palDrawer).toContainText("感冒");
  await expect(palDrawer).toContainText("生命 / 攻击 / 防御");
  await expect(palDrawer).toContainText("平均");
  await expect(palDrawer).toContainText("工作适应性");
  await expect(palDrawer).toContainText("被动技能");
  await expect(palDrawer).toContainText("已装备主动技能");
  await expect(palDrawer).toContainText("已学会主动技能");
  await expect(palDrawer).toContainText("伙伴技能");
  await expect(palDrawer).toContainText("传说");
  await expect(palDrawer).toContainText("威力 40");
  await expect(palDrawer).toContainText("中文资料未收录");
  const closePalDrawer = palDrawer.getByRole("button", { name: "关闭帕鲁详情" });
  await expect(closePalDrawer).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(palDrawer.locator("summary")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closePalDrawer).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath(`ux05-${testInfo.project.name}.png`), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(palDrawer).toBeHidden();
  await expect(page.getByRole("button", { name: "小羊" })).toBeFocused();
  await page.getByRole("button", { name: "需要关注" }).click();
  await expect(page.locator(".pal-roster-row")).toHaveCount(1);

  await page.getByRole("tab", { name: "公会" }).click();
  await page.getByRole("button", { name: "测试工会" }).click();
  await expect(drawer).toContainText("成员");
  await expect(drawer).toContainText("关联据点");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();

  await page.getByRole("tab", { name: "据点" }).click();
  await page.getByRole("button", { name: "据点一号" }).click();
  await expect(drawer).toContainText("工作帕鲁");
  await expect(drawer).toContainText("据点库存");
  if (testInfo.project.name === "mobile") await drawer.getByRole("button", { name: "关闭详情" }).click();
  await page.getByLabel("状态筛选").selectOption("guilded");
  await page.getByLabel("排序方式").selectOption("id");
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/bases" && url.searchParams.get("status") === "guilded" && url.searchParams.get("sort") === "id" && url.searchParams.get("snapshotId") === "world")).toBeTruthy();
  await expect(page.getByRole("button", { name: "清除筛选条件" })).toBeVisible();
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
