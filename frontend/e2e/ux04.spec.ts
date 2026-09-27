import { expect, test, type Page } from "@playwright/test";

const worldContract = { queryVersion: 1, cacheSchema: "world-asset-cache", cacheSchemaVersion: 17, metadataSchema: "palserver-console-world-metadata", metadataSchemaVersion: 1, metadataDataVersion: "2026.08.25.3" };

const auth = { local: true, authenticated: true, adminPasswordConfigured: true, csrfToken: "ux04-csrf", lanWarning: null, port: 8223 };
const shell = { observedAt: 1_786_000_000, module: "M2", serverState: "stopped", configured: true, pids: [], executablePath: "C:\\PalServer\\PalServer.exe", instanceId: "world-1" };
const playerProgress = { state: "complete", values: { discoveredPalSpecies: 12, capturedPals: 3456, fastTravelPoints: 18, exploredAreas: 7, fieldBosses: 4, towerBosses: 2, dungeonClears: 9, oilRigClears: 3, technologyPoints: 14, ancientTechnologyPoints: 5, recipes: 62 }, unavailable: [] };
const player = { id: "player-1", instanceId: "instance-player-1", name: "Alice", level: 20, guildId: "guild-1", guildName: "测试工会", lastRecordedAt: "2026-08-25T12:00:00+00:00", progress: playerProgress };
const care = { currentHp: 0, hunger: 50.20763942173549, hungerRaw: null, hungerStatus: null, sanity: 40, physicalHealth: null, disease: "EPalStatus::Cold", activity: "EPalActivity::Working", diseaseRecorded: true, activityRecorded: true, reasons: ["zero_hp", "disease", "hunger_low", "san_low"], unavailable: [], severity: "critical", attention: true };
const unavailableCare = { currentHp: null, hunger: null, hungerRaw: null, hungerStatus: null, sanity: null, physicalHealth: null, disease: null, activity: null, diseaseRecorded: false, activityRecorded: false, reasons: [], unavailable: ["currentHp", "hunger", "sanity", "disease", "activity"], severity: "unavailable", attention: false };
const aptitude = { speciesRarity: 1, ivs: { hp: 60, attack: 58, defense: 60, average: 59.333333333333336 }, workSuitabilities: [{ type: "Handcraft", level: 1 }, { type: "Transport", level: 1 }], metadataKnown: true, metadataLabel: null };
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
const sortPal = { id: "pal-3", nickname: "阿帕", characterId: "SheepBall", level: 6, rank: 5, ownerPlayerId: null, baseId: null, containerId: null, slotIndex: null, assignment: "unassigned", aptitude, skills: noSkills, care: unavailableCare };
const base = { id: "base-1", name: "据点一号", guildId: "guild-1", guildName: "测试工会", workerContainerId: "container-1", x: 1, y: 2, z: 3, workerCount: 1, maxWorkerCount: 15, workers: [pal] };
const communityMembers = [player, ...Array.from({ length: 63 }, (_, index) => ({ ...player, id: `player-${index + 2}`, instanceId: `instance-player-${index + 2}`, name: `成员 ${index + 2}`, level: index + 2 }))];
const guild = { id: "guild-1", name: "测试工会", memberCount: 64, baseCount: 80, adminPlayerId: "player-1", adminPlayerName: "Alice", members: communityMembers.map((member, index) => ({ id: member.id, name: member.name, level: member.level, role: index ? "member" as const : "leader" as const })) };
const communityGuilds = [guild, ...Array.from({ length: 63 }, (_, index) => ({ ...guild, id: `guild-${index + 2}`, name: `公会 ${index + 2}`, memberCount: 0, baseCount: 0, adminPlayerId: null, adminPlayerName: null, members: [] }))];
const communityBases = [base, ...Array.from({ length: 79 }, (_, index) => {
  const number = index + 2;
  const workerCount = number === 2 ? 64 : 40;
  const name = number === 2 ? "大名单据点" : `四十只据点 ${number}`;
  return { ...base, id: `base-${number}`, name, workerContainerId: `container-${number}`, x: number, y: number + 1, z: number + 2, workerCount, maxWorkerCount: workerCount, workers: Array.from({ length: workerCount }, (_, workerIndex) => ({ ...pal, id: `pal-${number}-${workerIndex + 1}`, nickname: `打工帕鲁${number}-${workerIndex + 1}`, baseId: `base-${number}`, baseName: name, containerId: `container-${number}`, slotIndex: workerIndex })) };
})];
const communityWorkers = communityBases.flatMap((item) => item.workers);
const guildDetailBases = communityBases.map(({ id, name, guildId, workerContainerId, x, y, z }) => ({ id, name, guildId, workerContainerId, x, y, z }));
let reparseRequests = 0;

async function setupWorld(page: Page) {
  reparseRequests = 0;
  await page.addInitScript(() => window.localStorage.setItem("palserver-console-theme", "island"));
  const worldListUrls: URL[] = [];
  const worldDetailUrls: URL[] = [];
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
      counts: { players: 1, pals: 3, guilds: 64, bases: 80, inventory_items: 1, work_pals: 1 },
      overview: { assets: { players: 1, pals: 3, palSpecies: 2, itemTypes: 2, itemQuantity: 26, bases: 80, guilds: 64 }, actions: { attentionPals: 1, luckyPals: 1, bossPals: 0, unassignedPals: 2, unknownItems: 1, unknownPalMetadata: 1, careUnavailable: 2 } },
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
      const requestUrl = new URL(route.request().url());
      rosterUrls.push(requestUrl);
      const sort = requestUrl.searchParams.get("sort");
      const marker = requestUrl.searchParams.get("marker");
      const careFilter = requestUrl.searchParams.get("care");
      const rosterPals = [{ ...pal, gender: "Female", rank: 1, isBoss: false, isLucky: true, locationType: "base" }, { ...unknownPal, gender: null, rank: null, isBoss: false, isLucky: false, locationType: "unassigned" }, { ...sortPal, gender: null, rank: 5, isBoss: false, isLucky: false, locationType: "unassigned" }];
      const sorted = sort === "name" ? [rosterPals[2], rosterPals[0], rosterPals[1]] : rosterPals;
      const location = requestUrl.searchParams.get("location");
      const search = requestUrl.searchParams.get("search")?.toLocaleLowerCase() || "";
      const characterIds = new Set((requestUrl.searchParams.get("characterId") || "").split(",").filter(Boolean));
      const searched = search || characterIds.size ? sorted.filter((item) => item.nickname.toLocaleLowerCase().includes(search) || item.characterId.toLocaleLowerCase().includes(search) || item.id.toLocaleLowerCase().includes(search) || characterIds.has(item.characterId)) : sorted;
      const items = careFilter === "attention" ? [rosterPals[0]] : marker === "lucky" ? [rosterPals[0]] : marker === "boss" ? [] : location === "unassigned" ? rosterPals.slice(1) : searched;
      const passiveSkills = [...palSkills.passive, { ...palSkills.passive[0], id: "MoveSpeed_up_3", name: "神速", description: "移动速度 +30%", sourceName: "Swift" }];
      const passiveCatalog = [...passiveSkills, { ...palSkills.passive[0], id: "MoveSpeed_up_2", name: "运动健将", description: "移动速度 +20%", sourceName: "Runner" }, { ...palSkills.passive[0], id: "MoveSpeed_up_1", name: "灵活", description: "移动速度 +10%", sourceName: "Nimble" }, { ...palSkills.passive[0], id: "Rare", name: "稀有", description: "攻击 +15%，防御 +15% (None)，工作速度 +20%", sourceName: "Lucky" }];
      return route.fulfill({ json: { items, page: 1, pageSize: 60, total: items.length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null, careSummary: { total: 3, critical: 1, warning: 0, attention: 1, unavailable: 2 }, passiveSkills, passiveCatalog, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    if (path === "/api/world/inventory-items") {
      const requestUrl = new URL(route.request().url());
      inventoryUrls.push(requestUrl);
      const scope = requestUrl.searchParams.get("scope") || "all";
      const wood = (totalQuantity: number, locationCount: number) => {
        const groups = [{ locationType: "player", groupId: "player-1", label: "玩家：Alice", quantitySum: 3, locationCount: 1, containerCount: 1 }, { locationType: "base", groupId: "base-1", label: "据点：据点一号", quantitySum: 9, locationCount: 2, containerCount: 1 }, { locationType: "world", groupId: null, label: "其他位置", quantitySum: 6, locationCount: 3, containerCount: 2 }, { locationType: "unassigned", groupId: null, label: "未识别位置", quantitySum: 4, locationCount: 1, containerCount: 1 }];
        const selected = scope === "player" ? groups.slice(0, 1) : scope === "base" ? groups.slice(1, 2) : scope === "world" ? groups.slice(2, 3) : scope === "inventory" ? groups.slice(0, 2) : groups;
        return { itemId: "Wood", name: "木材", category: "材料", rarity: "普通", metadataKnown: true, metadataLabel: null, totalQuantity, locationCount, locationGroupCount: selected.length, locationPreview: selected.slice(0, 3) };
      };
      const unknown = { itemId: "FutureOre", name: null, category: null, rarity: null, metadataKnown: false, metadataLabel: "资料未收录", totalQuantity: 4, locationCount: 1, locationGroupCount: 1, locationPreview: [{ locationType: "base", groupId: "base-1", label: "据点：据点一号", quantitySum: 4, locationCount: 1, containerCount: 1 }] };
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
    const lists: Record<string, object[]> = { "/api/world/players": [player], "/api/world/pals": [pal, unknownPal, sortPal], "/api/world/guilds": communityGuilds, "/api/world/bases": communityBases };
    if (path in lists) {
      const requestUrl = new URL(route.request().url());
      worldListUrls.push(requestUrl);
      const page = Number(requestUrl.searchParams.get("page") || 1);
      const search = requestUrl.searchParams.get("search")?.trim().toLocaleLowerCase() || "";
      const matching = search ? lists[path].filter((item) => JSON.stringify(item).toLocaleLowerCase().includes(search)) : lists[path];
      return route.fulfill({ json: { items: matching.slice((page - 1) * 50, page * 50), page, pageSize: 50, total: matching.length, source: "save-snapshot", observedAt: 1, snapshotId: activeSnapshotId, stale: false, errorCode: null } });
    }
    const details: Record<string, object> = {
      "/api/world/players/player-1": { ...player, snapshotId: activeSnapshotId, guild, pals: [pal], partyPals: [pal], storagePals: [], inventory: [{ id: "item-1", itemId: "Wood", quantity: 3, containerId: "bag-1" }] },
      "/api/world/pals/pal-1": { ...pal, snapshotId: activeSnapshotId, owner: player, base, container: { id: "container-1", kind: "base_workers", slotCount: 20 }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } },
      "/api/world/guilds/guild-1": { ...guild, snapshotId: activeSnapshotId, members: communityMembers, bases: guildDetailBases, pals: communityWorkers, assetSummary: { memberCount: 64, baseCount: 80, palCount: communityWorkers.length, inventory: { itemTypeCount: 2, totalQuantity: 12, locationCount: 3 } }, missingMemberIds: [], missingBaseIds: [] },
      "/api/world/bases/base-1": { ...base, snapshotId: activeSnapshotId, guild, guildAssociation: "linked", workers: [pal], workerCount: 1, careSummary: { total: 1, critical: 1, warning: 0, attention: 1, unavailable: 0 }, inventorySummary: { itemTypeCount: 2, totalQuantity: 9, locationCount: 2 } },
    };
    if (path in details) {
      worldDetailUrls.push(new URL(route.request().url()));
      if (new URL(route.request().url()).searchParams.get("snapshotId") !== activeSnapshotId) return route.fulfill({ status: 409, json: { errorCode: "SNAPSHOT_REPLACED", message: "请求的存档快照已被新的成功缓存替换。" } });
      return route.fulfill({ json: details[path] });
    }
    const communityBase = communityBases.find((item) => path === `/api/world/bases/${item.id}`);
    if (communityBase) {
      worldDetailUrls.push(new URL(route.request().url()));
      return route.fulfill({ json: { ...communityBase, snapshotId: activeSnapshotId, guild, guildAssociation: "linked", workers: communityBase.workers, workerCount: communityBase.workerCount, careSummary: { total: communityBase.workerCount, critical: 0, warning: 0, attention: 0, unavailable: 0 }, inventorySummary: { itemTypeCount: 0, totalQuantity: 0, locationCount: 0 } } });
    }
    const communityPal = communityWorkers.find((item) => path === `/api/world/pals/${item.id}`);
    if (communityPal) {
      const workerBase = communityBases.find((item) => item.id === communityPal.baseId) || base;
      worldDetailUrls.push(new URL(route.request().url()));
      return route.fulfill({ json: { ...communityPal, snapshotId: activeSnapshotId, owner: player, base: workerBase, container: { id: workerBase.workerContainerId, kind: "base_workers", slotCount: workerBase.maxWorkerCount }, metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null } } });
    }
    const communityMember = communityMembers.find((item) => path === `/api/world/players/${item.id}`);
    if (communityMember) {
      worldDetailUrls.push(new URL(route.request().url()));
      return route.fulfill({ json: { ...communityMember, snapshotId: activeSnapshotId, guild, pals: [], partyPals: [], storagePals: [], inventory: [] } });
    }
    return route.fulfill({ status: 404, json: { errorCode: "WORLD_ENTITY_NOT_FOUND", message: path } });
  });

  return { worldListUrls, worldDetailUrls, rosterUrls, inventoryUrls, getReparseStatusReads: () => reparseStatusReads, switchSnapshot: (id: string) => { activeSnapshotId = id; } };
}

test("帕鲁星级筛选按显示星数请求，过期详情会刷新快照", async ({ page }) => {
  const { rosterUrls, worldDetailUrls, switchSnapshot } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  await expect(page.locator(".pal-roster-row")).toHaveCount(3);
  await expect(page.locator(".pal-roster-row").filter({ hasText: "阿帕" }).locator(".pal-roster-stars svg[fill='currentColor']")).toHaveCount(4);
  await page.getByText("资质与工作适应性", { exact: true }).click();
  const minStars = page.getByLabel("最低星级");
  await expect(minStars).toHaveAttribute("max", "4");
  await minStars.fill("1");
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("minRank")).toBe("2");
  await minStars.fill("4");
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("minRank")).toBe("5");
  await minStars.fill("0");
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.has("minRank")).toBe(false);

  switchSnapshot("world-next");
  await page.getByRole("button", { name: "小羊" }).click();
  await expect.poll(() => worldDetailUrls.some((url) => url.pathname === "/api/world/pals/pal-1" && url.searchParams.get("snapshotId") === "world")).toBe(true);
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("snapshotId")).toBe("world-next");
  await expect.poll(() => worldDetailUrls.filter((url) => url.pathname === "/api/world/pals/pal-1").map((url) => url.searchParams.get("snapshotId")).slice(0, 2)).toEqual(["world", "world-next"]);
  await expect(page.getByRole("dialog", { name: "帕鲁详情" })).toBeVisible();
  await expect.poll(() => worldDetailUrls.at(-1)?.searchParams.get("snapshotId")).toBe("world-next");
});

test("同快照重复打开详情复用缓存，快照变化后重新请求", async ({ page }) => {
  const { worldDetailUrls, worldListUrls, switchSnapshot } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const trigger = page.getByRole("button", { name: "查看完整训练家档案" });
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  for (let attempt = 0; attempt < 2; attempt++) {
    await trigger.click();
    await expect(dialog).toContainText("已探索区域");
    await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  expect(worldDetailUrls.filter(url => url.pathname === "/api/world/players/player-1")).toHaveLength(1);
  switchSnapshot("world-cache-next");
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  await expect.poll(() => worldListUrls.filter(url => url.pathname === "/api/world/players").at(-1)?.searchParams.get("snapshotId")).toBe("world-cache-next");
  await trigger.click();
  await expect(dialog).toContainText("已探索区域");
  expect(worldDetailUrls.filter(url => url.pathname === "/api/world/players/player-1").map(url => url.searchParams.get("snapshotId"))).toEqual(["world", "world-cache-next"]);
});

test("预加载与点击共享同一个慢请求，完成后重复打开无需等待", async ({ page }, info) => {
  await setupWorld(page);
  let release = () => {};
  const responseGate = new Promise<void>(resolve => { release = resolve; });
  let requests = 0;
  await page.route("**/api/world/players/player-1?*", async route => {
    requests += 1;
    await responseGate;
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const trigger = page.getByRole("button", { name: "查看完整训练家档案" });
  if (info.project.name === "desktop") await trigger.hover();
  else await trigger.scrollIntoViewIfNeeded();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  try {
    await expect.poll(() => requests).toBe(1);
    await expect(dialog).toHaveCount(0);
    await trigger.click();
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(dialog).toContainText("已探索区域");
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog).toContainText("已探索区域");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  expect(requests).toBe(1);
});

test("帕鲁名册和关联帕鲁详情共享缓存", async ({ page }) => {
  const { worldDetailUrls } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  await page.getByRole("button", { name: "小羊" }).click();
  const rosterDialog = page.getByRole("dialog", { name: "帕鲁详情" });
  await expect(rosterDialog).toBeVisible();
  await expect(rosterDialog.locator(".pal-detail-notice")).toHaveCount(0);
  await rosterDialog.getByRole("button", { name: "关闭帕鲁详情" }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  await page.locator(".world-community-card").filter({ hasText: "据点一号" }).getByRole("button", { name: /小羊/ }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  await expect(dialog.locator(".pal-detail-header")).toContainText("小羊");
  await expect(dialog.getByRole("status")).toHaveCount(0);
  expect(worldDetailUrls.filter(url => url.pathname === "/api/world/pals/pal-1")).toHaveLength(1);
});

test("完整训练家档案在详情请求完成前立即打开", async ({ page }, info) => {
  await setupWorld(page);
  let release = () => {};
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/world/players/player-1?*", async (route) => {
    await responseGate;
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const trigger = page.locator(".world-player-card").filter({ hasText: "Alice" }).getByRole("button", { name: "查看完整训练家档案" });
  await trigger.evaluate((element) => element.addEventListener("click", () => {
    performance.mark("detail-click");
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[role="dialog"][aria-label="世界实体详情"]')) return;
      observer.disconnect();
      requestAnimationFrame(() => performance.measure("detail-open-frame", "detail-click"));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, { once: true }));
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  try {
    await expect(dialog).toBeVisible({ timeout: 1000 });
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    await expect(dialog.getByRole("button", { name: "关闭详情", exact: true })).toBeFocused();
    console.log(`Detail opening frame (${info.project.name}): ${await page.evaluate(() => performance.getEntriesByName("detail-open-frame")[0].duration.toFixed(1))}ms before response`);
    if (info.project.name === "mobile") {
      await expect(dialog.getByRole("button", { name: "关闭详情", exact: true })).toBeInViewport();
      await expect(dialog).not.toHaveAttribute("data-sheet-moving", "true");
    }
    await page.screenshot({ path: info.outputPath("detail-loading.png") });
  } finally {
    release();
  }
  await expect(dialog).toContainText("已探索区域");
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(trigger).toBeFocused();
});

test("加载中关闭档案后，迟到响应不会重开详情或干扰重新打开", async ({ page }) => {
  await setupWorld(page);
  let release = () => {};
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/world/players/player-1?*", async (route) => {
    if (++requests === 1) await responseGate;
    await route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const trigger = page.getByRole("button", { name: "查看完整训练家档案" });
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  try {
    await trigger.click();
    await expect.poll(() => requests).toBe(1);
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => document.getElementById("root")!.inert)).toBe(false);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
    await trigger.click();
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    expect(requests).toBe(1);
  } finally {
    release();
  }
  await expect(dialog).toContainText("已探索区域");
  await expect(dialog).toHaveAttribute("aria-busy", "false");
  await dialog.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(dialog).toBeHidden();
});

test("关闭详情后的迟到409不会重置新筛选", async ({ page }) => {
  const { switchSnapshot, worldListUrls } = await setupWorld(page);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  await page.route("**/api/world/players/player-1?*", async route => { await gate; await route.fallback(); finished = true; });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const trigger = page.getByRole("button", { name: "查看完整训练家档案" });
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  try {
    await trigger.click();
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await page.getByRole("textbox", { name: "搜索训练家档案" }).fill("Alice");
    await page.locator(".world-player-archive").getByRole("button", { name: "搜索", exact: true }).click();
    await expect.poll(() => worldListUrls.at(-1)?.searchParams.get("search")).toBe("Alice");
    switchSnapshot("world-canceled-next");
  } finally { release(); }
  await expect.poll(() => finished).toBe(true);
  // Allow a canceled consumer's potential status refresh to reach React before asserting absence.
  await page.waitForTimeout(500);
  await expect(page.getByRole("textbox", { name: "搜索训练家档案" })).toHaveValue("Alice");
  expect(worldListUrls.at(-1)?.searchParams.get("snapshotId")).toBe("world");
  await expect(dialog).toHaveCount(0);
});

test("快照刷新途中关闭详情不会提交迟到状态", async ({ page }) => {
  const { switchSnapshot } = await setupWorld(page);
  let releaseDetail = () => {};
  let releaseStatus = () => {};
  const detailGate = new Promise<void>(resolve => { releaseDetail = resolve; });
  const statusGate = new Promise<void>(resolve => { releaseStatus = resolve; });
  let blockStatus = false;
  let refreshStarted = false;
  let refreshFinished = false;
  await page.route("**/api/world/players/player-1?*", async route => { await detailGate; await route.fallback(); });
  await page.route("**/api/world/snapshots/current", async route => {
    if (blockStatus) { refreshStarted = true; await statusGate; }
    await route.fallback();
    if (blockStatus) refreshFinished = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  try {
    await page.getByRole("button", { name: "查看完整训练家档案" }).click();
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    blockStatus = true;
    switchSnapshot("world-refresh-next");
    releaseDetail();
    await expect.poll(() => refreshStarted).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.getByRole("textbox", { name: "搜索训练家档案" }).fill("Alice");
  } finally { releaseDetail(); releaseStatus(); }
  await expect.poll(() => refreshFinished).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.getByRole("textbox", { name: "搜索训练家档案" })).toHaveValue("Alice");
  await expect(dialog).toHaveCount(0);
});

test("返回详情后的迟到409不会清空上一详情上下文", async ({ page }) => {
  const { switchSnapshot } = await setupWorld(page);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finished = false;
  await page.route("**/api/world/pals/pal-2-64?*", async route => {
    await gate;
    await route.fulfill({ status: 409, json: { errorCode: "SNAPSHOT_REPLACED", message: "测试迟到响应" } });
    finished = true;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  await page.locator(".world-community-card").filter({ hasText: "大名单据点" }).getByRole("button", { name: "查看全部 64 只" }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  const query = dialog.getByRole("textbox", { name: "查找据点打工帕鲁" });
  try {
    await query.fill("打工帕鲁2-64");
    await dialog.getByRole("button", { name: /打工帕鲁2-64/ }).click();
    await expect(dialog.getByRole("status")).toContainText("正在读取");
    await dialog.getByRole("button", { name: "返回上一详情" }).click();
    await expect(query).toHaveValue("打工帕鲁2-64");
    switchSnapshot("world-return-next");
  } finally { release(); }
  await expect.poll(() => finished).toBe(true);
  await page.waitForTimeout(500);
  await expect(query).toHaveValue("打工帕鲁2-64");
  await expect(dialog).toHaveAttribute("data-resource", "bases");
});

test("手机抽屉内部滚动只预加载真正可见的两个入口", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile", "Mobile-only idle prefetch");
  const { worldDetailUrls } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  await page.locator(".world-community-card").filter({ hasText: "大名单据点" }).getByRole("button", { name: "查看全部 64 只" }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  await expect(dialog.getByRole("textbox", { name: "查找据点打工帕鲁" })).toBeVisible();
  await page.waitForTimeout(1000);
  const previous = new Set(worldDetailUrls.map(url => url.pathname));
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const targets = await dialog.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const handle = element.querySelector(".mobile-sheet-handle")!.getBoundingClientRect();
    return Array.from(element.querySelectorAll<HTMLElement>("button[data-detail-resource][data-detail-id]")).filter(button => {
      const rect = button.getBoundingClientRect();
      return rect.top < bounds.bottom && rect.bottom > Math.max(bounds.top, handle.bottom);
    }).slice(0, 2).map(button => `/api/world/${button.dataset.detailResource}/${button.dataset.detailId}`);
  });
  expect(targets).toHaveLength(2);
  expect(targets.every(path => !previous.has(path))).toBe(true);
  await expect.poll(() => targets.every(path => worldDetailUrls.some(url => url.pathname === path))).toBe(true);
  const added = worldDetailUrls.filter(url => !previous.has(url.pathname)).map(url => url.pathname);
  expect(added.sort()).toEqual([...targets].sort());
});

test("据点和关联帕鲁立即打开原面板，公会已读取详情直接复用", async ({ page }, info) => {
  const { worldDetailUrls } = await setupWorld(page);
  const gates = new Map<string, () => void>();
  for (const path of ["bases/base-1", "pals/pal-1"]) {
    const gate = new Promise<void>(resolve => { gates.set(path, resolve); });
    await page.route(`**/api/world/${path}?*`, async route => { await gate; await route.fallback(); });
  }
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  const card = page.locator(".world-community-card").filter({ hasText: "据点一号" });
  const targets = [
    { resource: "bases", id: "base-1", trigger: card.getByRole("button", { name: "查看全部 1 只" }) },
    { resource: "pals", id: "pal-1", trigger: card.getByRole("button", { name: /小羊/ }) },
  ];
  try { for (const target of targets) {
    await target.trigger.click();
    const dialog = page.getByRole("dialog", { name: "世界实体详情" });
    try {
      await expect(dialog.getByRole("status")).toContainText("正在读取");
      await expect(dialog).toHaveAttribute("data-resource", target.resource);
      await expect(page.getByRole("dialog")).toHaveCount(1);
      if (info.project.name === "mobile") {
        await expect(dialog).not.toHaveAttribute("data-sheet-moving", "true");
        await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
      }
      if (target.resource === "pals") await page.screenshot({ path: info.outputPath("pal-loading.png") });
    } finally {
      gates.get(`${target.resource}/${target.id}`)!();
    }
    const panel = await dialog.elementHandle();
    await expect(dialog).toHaveAttribute("aria-busy", "false");
    expect(await panel!.evaluate(element => element.isConnected)).toBe(true);
    await dialog.getByRole("button", { name: target.resource === "pals" ? "关闭帕鲁详情" : "关闭详情", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(target.trigger).toBeFocused();
  } } finally { gates.forEach(release => release()); }
  const guildNav = page.locator(".world-community-guild-nav");
  await guildNav.locator("summary").click();
  await guildNav.getByRole("button", { name: /测试工会/ }).click();
  await page.getByRole("button", { name: "查看成员（64）" }).click();
  const guildDialog = page.getByRole("dialog", { name: "世界实体详情" });
  await expect(guildDialog).toHaveAttribute("data-resource", "guilds");
  await expect(guildDialog.getByRole("status")).toHaveCount(0);
  expect(worldDetailUrls.filter(url => url.pathname === "/api/world/guilds/guild-1")).toHaveLength(1);
});

test("详情请求失败在原面板内重试", async ({ page }) => {
  await setupWorld(page);
  let requests = 0;
  await page.route("**/api/world/players/player-1?*", (route) => ++requests === 1
    ? route.fulfill({ status: 503, json: { errorCode: "WORLD_CACHE_UNAVAILABLE", message: "测试慢请求失败" } })
    : route.fallback());
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  await page.getByRole("button", { name: "查看完整训练家档案" }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  await expect(dialog.getByRole("alert")).toContainText("WORLD_CACHE_UNAVAILABLE");
  const panel = await dialog.elementHandle();
  await dialog.getByRole("button", { name: "重新尝试" }).click();
  await expect(dialog).toContainText("已探索区域");
  expect(await panel!.evaluate(element => element.isConnected)).toBe(true);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".world-request-failure")).toHaveCount(0);
});

test("关联详情加载中返回保留原筛选、滚动和抽屉高度", async ({ page }, info) => {
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  await page.locator(".world-community-card").filter({ hasText: "大名单据点" }).getByRole("button", { name: "查看全部 64 只" }).click();
  const dialog = page.getByRole("dialog", { name: "世界实体详情" });
  await expect(dialog.getByRole("textbox", { name: "查找据点打工帕鲁" })).toBeVisible();
  if (info.project.name === "mobile") {
    await expect(dialog.getByRole("button", { name: "关闭详情", exact: true })).toBeFocused();
    await dialog.getByRole("button", { name: "调整抽屉高度" }).press("ArrowUp");
    await expect(dialog).not.toHaveAttribute("data-sheet-moving", "true");
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  }
  await dialog.getByRole("textbox", { name: "查找据点打工帕鲁" }).fill("打工帕鲁2-64");
  const palTrigger = dialog.getByRole("button", { name: /打工帕鲁2-64/ });
  await palTrigger.scrollIntoViewIfNeeded();
  const scrollTop = await dialog.evaluate(element => element.scrollTop);
  let release = () => {};
  const responseGate = new Promise<void>((resolve) => { release = resolve; });
  let responseFinished = false;
  await page.route("**/api/world/pals/pal-2-64?*", async (route) => {
    await responseGate;
    await route.fallback();
    responseFinished = true;
  });
  try {
    await palTrigger.click();
    await expect(dialog.getByRole("status")).toContainText("正在读取帕鲁详情");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await dialog.getByRole("button", { name: "返回上一详情" }).click();
    await expect(dialog.getByRole("textbox", { name: "查找据点打工帕鲁" })).toHaveValue("打工帕鲁2-64");
    await expect.poll(() => dialog.evaluate(element => element.scrollTop)).toBeCloseTo(scrollTop, 0);
    if (info.project.name === "mobile") expect((await dialog.boundingBox())!.height).toBeCloseTo(832, 0);
  } finally {
    release();
  }
  await expect.poll(() => responseFinished).toBe(true);
  await expect(dialog).toHaveAttribute("data-resource", "bases");
  await expect(dialog.getByRole("button", { name: "返回上一详情" })).toHaveCount(0);
});

test("跨实体详情遇到 SNAPSHOT_REPLACED 后按新快照重试", async ({ page }) => {
  const { worldDetailUrls, switchSnapshot } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "训练家档案" }).click();
  const playerCard = page.locator(".world-player-card").filter({ hasText: "Alice" });
  await expect(playerCard).toBeVisible();
  switchSnapshot("world-next");
  await playerCard.getByRole("button", { name: "查看完整训练家档案" }).click();
  await expect.poll(() => worldDetailUrls.filter((url) => url.pathname === "/api/world/players/player-1").map((url) => url.searchParams.get("snapshotId"))).toEqual(["world", "world-next"]);
  await expect(page.getByRole("dialog", { name: "世界实体详情" })).toBeVisible();
  await expect(page.locator(".world-player-card").filter({ hasText: "Alice" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "世界实体详情" })).toBeVisible();
  await expect(page.locator(".world-request-failure")).toHaveCount(0);
});

test("详情抽屉跨类型导航保持手势，下甩退出完整详情流程", async ({ page }, testInfo) => {
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  const guildNav = page.locator(".world-community-guild-nav");
  await guildNav.locator("summary").click();
  await guildNav.getByRole("button", { name: /测试工会/ }).click();
  const trigger = page.getByRole("button", { name: "查看成员（64）" });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "世界实体详情" });
  await drawer.getByRole("button", { name: /Alice/ }).click();
  await expect(drawer.locator(".section-heading")).toContainText("Alice");
  const handle = drawer.getByRole("button", { name: "调整抽屉高度" });
  if (testInfo.project.name === "mobile") {
    await expect(handle).toBeVisible();
    await handle.press("ArrowUp");
    await expect(drawer).not.toHaveAttribute("data-sheet-moving", "true");
    await expect.poll(async () => (await drawer.boundingBox())!.height).toBeCloseTo(832, 0);
    await handle.press("ArrowDown");
    await expect.poll(async () => (await drawer.boundingBox())!.height).toBeCloseTo(506.4, 0);
  } else await expect(handle).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath("player-detail-navigation.png") });
  await drawer.getByRole("button", { name: "返回上一详情" }).click();
  await drawer.getByRole("button", { name: /据点一号/ }).click();
  await expect(drawer.locator(".section-heading")).toContainText("据点一号");
  if (testInfo.project.name === "mobile") {
    await drawer.evaluate(element => { element.scrollTop = 0; });
    const box = (await handle.boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step++) {
      await page.waitForTimeout(10);
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 48 }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
    await expect(drawer).toBeHidden();
  } else {
    await drawer.getByRole("button", { name: "返回上一详情" }).click();
    await page.screenshot({ path: testInfo.outputPath("guild-detail-return.png") });
    await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  }
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.getElementById("root")!.inert)).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

test("关联帕鲁复用当前详情抽屉并保留高度与返回上下文", async ({ page }, testInfo) => {
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  const card = page.locator(".world-community-card").filter({ hasText: "大名单据点" });
  const trigger = card.getByRole("button", { name: "查看全部 64 只" });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "世界实体详情", exact: true });
  const mobile = testInfo.project.name === "mobile";
  if (mobile) {
    await expect.poll(async () => (await drawer.boundingBox())!.height).toBeCloseTo(506.4, 0);
    await drawer.getByRole("button", { name: "调整抽屉高度" }).press("ArrowUp");
    await expect(drawer).not.toHaveAttribute("data-sheet-moving", "true");
    await expect.poll(async () => (await drawer.boundingBox())!.height).toBeCloseTo(832, 0);
  }
  await drawer.getByLabel("查找据点打工帕鲁").fill("打工帕鲁2-64");
  const worker = drawer.getByRole("button", { name: /打工帕鲁2-64/ });
  await worker.scrollIntoViewIfNeeded();
  const savedTop = await drawer.evaluate(element => element.scrollTop);
  await worker.click();
  await expect(drawer.locator(".pal-detail-header")).toContainText("棉悠悠");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.locator(".world-drawer-backdrop, .pal-roster-backdrop")).toHaveCount(1);
  const back = drawer.getByRole("button", { name: "返回上一详情", exact: true });
  await expect(back).toBeFocused();
  if (mobile) {
    await expect(page.getByRole("button", { name: "调整抽屉高度" })).toHaveCount(1);
    await expect(drawer).toHaveAttribute("data-sheet-snap", "expanded");
    await expect.poll(async () => (await drawer.boundingBox())!.height).toBeCloseTo(832, 0);
    await expect.poll(() => drawer.evaluate(element => element.scrollTop)).toBe(0);
  }
  await page.screenshot({ path: testInfo.outputPath("linked-pal-single-panel.png") });
  await back.click();
  await expect(drawer.getByLabel("查找据点打工帕鲁")).toHaveValue("打工帕鲁2-64");
  await expect.poll(() => drawer.evaluate(element => element.scrollTop)).toBe(savedTop);
  if (mobile) await expect(drawer).toHaveAttribute("data-sheet-snap", "expanded");
  await page.screenshot({ path: testInfo.outputPath("base-detail-return.png") });
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.getElementById("root")!.inert)).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
});

for (const action of ["关闭按钮", "遮罩", "Escape", "下甩"] as const) test(`关联详情的${action}退出整个抽屉，返回仍保留上一详情`, async ({ page }, testInfo) => {
  test.skip(action === "下甩" && testInfo.project.name !== "mobile", "下甩只适用于手机");
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点", exact: true }).click();
  const card = page.locator(".world-community-card").filter({ hasText: "据点一号" });
  const trigger = card.getByRole("button", { name: "查看全部 1 只" });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "世界实体详情", exact: true });
  await drawer.getByRole("button", { name: /小羊/ }).click();
  await expect(drawer.getByRole("button", { name: "返回上一详情", exact: true })).toBeFocused();
  await expect(drawer.getByRole("button", { name: "关闭帕鲁详情", exact: true })).toHaveCount(1);
  if (action === "关闭按钮") await drawer.getByRole("button", { name: "关闭帕鲁详情", exact: true }).click();
  else if (action === "遮罩") await page.getByRole("button", { name: "关闭详情遮罩", exact: true }).click({ position: { x: 5, y: 5 } });
  else if (action === "Escape") await page.keyboard.press("Escape");
  else {
    await expect(drawer).not.toHaveAttribute("data-sheet-moving", "true");
    const box = (await drawer.getByRole("button", { name: "调整抽屉高度" }).boundingBox())!;
    const client = await page.context().newCDPSession(page);
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 5; step++) {
      await page.waitForTimeout(8);
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 48 }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await client.detach();
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.getElementById("root")!.inert)).toBe(false);
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  await trigger.click();
  await expect(drawer.getByRole("button", { name: "返回上一详情", exact: true })).toHaveCount(0);
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
});

test("UX-04：训练家与帕鲁详情、公会据点卡片及关联跳转", async ({ page }, testInfo) => {
  const { worldListUrls, worldDetailUrls, rosterUrls, inventoryUrls, getReparseStatusReads } = await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();

  const tabs = page.getByRole("tablist", { name: "世界资产工作区" });
  await expect(tabs.getByRole("tab")).toHaveCount(5);
  await expect(tabs).toContainText("世界资产总览");
  await expect(tabs).toContainText("训练家档案");
  await expect(tabs).toContainText("帕鲁图鉴花名册");
  await expect(tabs).toContainText("公会与据点");
  await expect(tabs).toContainText("全服物资检索");
  await expect(page.getByRole("tabpanel", { name: "世界资产总览" }).getByRole("heading", { name: "资产规模" })).toBeVisible();
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
  const linkedPalDrawer = page.locator(".pal-detail-modal");
  await expect(linkedPalDrawer).toContainText("个体值（IV）");
  await expect(linkedPalDrawer).toContainText("当前位置");
  await expect(linkedPalDrawer).toContainText("据点工作 · 据点一号");
  await linkedPalDrawer.getByRole("button", { name: "返回上一详情" }).click();
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
  await expect(palRow.locator(".pal-roster-copy > span > strong")).toHaveText("棉悠悠");
  await expect(palRow.locator(".pal-roster-copy > small")).toHaveText("「小羊」");
  await expect(palRow).toHaveAccessibleName("棉悠悠（昵称：小羊）");
  const unrenamedPalRow = page.locator(".pal-roster-row").filter({ hasText: "FuturePal" });
  await expect(unrenamedPalRow.locator(".pal-roster-copy > span > strong")).toHaveText("FuturePal");
  await expect(unrenamedPalRow.locator(".pal-roster-copy > small")).toHaveCount(0);
  await expect(unrenamedPalRow).toHaveAccessibleName("FuturePal");
  await expect(palRow.locator(".world-pal-gender")).toHaveText("♀");
  await expect(palRow.locator(".world-pal-gender")).toHaveAttribute("title", "雌性");
  await expect(palRow.locator('[data-label="等级 / 星级"]')).toContainText("0 星");
  await expect(unrenamedPalRow.locator('[data-label="等级 / 星级"]')).toContainText("0 星");
  await expect(page.locator(".pal-roster-row").filter({ hasText: "阿帕" }).locator('[data-label="等级 / 星级"]')).toContainText("4 星");
  await expect(palRow.locator('[data-label="资质"]')).toContainText("稀有度 1");
  await expect(palRow.locator('[data-label="工作适应性"]')).toContainText("手工作业Lv.1");
  await expect(palRow.locator(".pal-work-summary em img")).toHaveCount(2);
  await expect(palRow.locator(".pal-work-summary em img").first()).toHaveAttribute("src", "/assets/work-suitabilities/T_icon_palwork_04.png");
  await expect(palRow.locator(".pal-work-summary em img").nth(1)).toHaveAttribute("src", "/assets/work-suitabilities/T_icon_palwork_11.png");
  await expect(palRow.locator(".pal-work-summary em img").first()).toHaveAttribute("width", "12");
  await expect(palRow.locator(".pal-work-summary em img").first()).toHaveAttribute("alt", "");
  await expect(palRow.locator(".pal-work-summary em img").first()).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByLabel("工作技能筛选").locator('option[value="Handcraft"]')).toHaveText("手工作业");
  await expect(palRow.locator('[data-label="个体标记"]')).toHaveText("闪光");
  await expect(palRow.locator('[data-label="归属"]')).toContainText("据点一号");
  await expect(palRow.locator('[data-label="照护状态"]')).toContainText("需立即处理");
  await expect(palRow).not.toContainText("base-1");
  await expect(page.locator('[data-icon-key="pal-placeholder"]')).toHaveCount(1);
  await page.getByLabel("搜索帕鲁图鉴花名册").fill("不存在的帕鲁");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  const emptyState = page.locator(".pal-roster-cards > .world-empty-state");
  await expect(emptyState).toBeVisible();
  const appliedBounds = await page.locator(".pal-applied-filters").boundingBox();
  const advancedBounds = await page.locator(".pal-aptitude-filters").boundingBox();
  expect(appliedBounds).not.toBeNull();
  expect(advancedBounds).not.toBeNull();
  expect(appliedBounds!.y).toBeLessThan(advancedBounds!.y);
  await expect(page.locator(".pal-applied-heading").getByRole("button", { name: "重置全部" })).toBeVisible();
  const [emptyBox, rosterBox] = await Promise.all([emptyState.boundingBox(), page.locator(".pal-roster-cards").boundingBox()]);
  expect(emptyBox).not.toBeNull();
  expect(rosterBox).not.toBeNull();
  expect(Math.abs((emptyBox!.x + emptyBox!.width / 2) - (rosterBox!.x + rosterBox!.width / 2))).toBeLessThan(2);
  await page.getByRole("button", { name: "重置全部" }).click();
  await page.getByLabel("搜索帕鲁图鉴花名册").fill("棉悠悠");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.locator(".pal-roster-row")).toHaveCount(2);
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("characterId")).toBe("BOSS_SheepBall,Quest_Farmer03_SheepBall,SheepBall");
  await page.getByRole("button", { name: "重置全部" }).click();
  await page.getByLabel("帕鲁存放位置筛选").selectOption("storage");
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("location")).toBe("storage");
  await page.getByLabel("帕鲁存放位置筛选").selectOption("all");
  await page.getByRole("button", { name: /纯净零负面词条/ }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("excludeNegativePassives")).toBe("true");
  await page.getByRole("button", { name: /纯净零负面词条/ }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.has("excludeNegativePassives")).toBe(false);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`pal-roster-${testInfo.project.name}.png`) });
  await page.getByText("词条组合高级筛选", { exact: true }).click();
  await expect(page.locator(".pal-advanced-summary")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("dialog", { name: "资质、工作与被动技能" })).toHaveCount(0);
  await expect(page.locator(".pal-combo-current")).toBeVisible();
  await expect(page.locator(".pal-combo-categories")).toBeVisible();
  await page.locator(".pal-aptitude-filters").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: testInfo.outputPath(`pal-filter-open-${testInfo.project.name}.png`) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole("button", { name: /极速骑乘/ }).click();
  await expect(page.getByRole("button", { name: /极速骑乘/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /全部/ }).last().click();
  await page.getByRole("button", { name: /极速坐骑四词条/ }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("passiveSkill")).toBe("Legend,MoveSpeed_up_3,MoveSpeed_up_2,MoveSpeed_up_1");
  await page.getByRole("button", { name: /极速坐骑四词条/ }).click();
  await page.getByLabel("搜索特性词条").fill("灵活");
  await page.getByRole("button", { name: "加入" }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("passiveSkill")).toBe("MoveSpeed_up_1");
  await page.getByLabel("已应用筛选").getByRole("button", { name: "灵活" }).click();
  await page.getByLabel("搜索特性词条").fill("神速");
  await expect(page.locator(".pal-combo-list").getByRole("button", { name: /神速/ })).toHaveCount(1);
  await page.getByLabel("搜索特性词条").fill("稀有");
  const rareSkill = page.locator(".pal-combo-list").getByRole("button", { name: /稀有/ }).first();
  await expect(rareSkill).toHaveAttribute("title", "攻击 +15%，防御 +15%，工作速度 +20%");
  await expect(rareSkill).not.toContainText("(None)");
  await page.getByLabel("搜索特性词条").clear();
  await page.getByText("资质与工作适应性", { exact: true }).click();
  await page.getByLabel("最低物种稀有度").fill("1");
  await page.getByLabel("最低工作等级").selectOption("1");
  await page.getByLabel("手工作业", { exact: true }).check();
  await page.getByLabel("搬运", { exact: true }).check();
  let releasePassiveResponse: (() => void) | undefined;
  await page.route("**/api/world/pals/roster?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("passiveSkill") === "Legend") {
      await new Promise<void>((resolve) => { releasePassiveResponse = resolve; });
    }
    await route.fallback();
  });
  await page.locator(".pal-combo-list").getByRole("button", { name: /传说/ }).first().click();
  await expect.poll(() => Boolean(releasePassiveResponse)).toBeTruthy();
  await expect(page.locator(".pal-roster-skeleton-card")).toHaveCount(6);
  await expect(page.locator(".pal-roster-skeleton-card .avatar")).toHaveCount(6);
  await page.locator(".pal-roster-skeleton-card").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath(`pal-filter-loading-${testInfo.project.name}.png`) });
  await expect(page.locator(".pal-combo-list").getByRole("button", { name: /神速/ }).first()).toBeVisible();
  releasePassiveResponse?.();
  await expect(page.locator(".pal-roster-skeleton-card")).toHaveCount(0);
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("passiveSkill")).toBe("Legend");
  const matchedPassive = page.locator(".pal-roster-row").filter({ hasText: "小羊" }).locator(".pal-passive-summary em");
  await expect(matchedPassive).toHaveClass(/matched/);
  await expect(matchedPassive).toHaveAttribute("title", "命中筛选词条: 传说");
  await expect(matchedPassive).toHaveCSS("background-color", "rgb(14, 165, 233)");
  await page.locator(".pal-combo-list").getByRole("button", { name: /神速/ }).first().click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("passiveSkill")).toBe("Legend,MoveSpeed_up_3");
  await page.getByRole("button", { name: "满足任一 OR" }).click();
  await expect.poll(() => rosterUrls.at(-1)?.searchParams.get("passiveMatch")).toBe("any");
  await page.getByRole("button", { name: /过滤负面词条/ }).click();
  await page.getByRole("button", { name: "应用资质筛选" }).click();
  await expect.poll(() => rosterUrls.some((url) => url.searchParams.get("minRarity") === "1" && url.searchParams.get("workSuitability") === "Handcraft,Transport" && url.searchParams.get("minWorkLevel") === "1" && url.searchParams.get("passiveSkill") === "Legend,MoveSpeed_up_3" && url.searchParams.get("passiveMatch") === "any" && url.searchParams.get("excludeNegativePassives") === "true")).toBeTruthy();
  await expect(page.getByLabel("已应用筛选")).toContainText("手工作业 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("搬运 ≥ 1 级");
  await expect(page.getByLabel("已应用筛选")).toContainText("传说");
  await page.locator(".pal-aptitude-filters").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: testInfo.outputPath(`pal-filter-applied-${testInfo.project.name}.png`) });
  const requestCount = rosterUrls.length;
  await page.getByLabel("已应用筛选").getByRole("button", { name: "传说" }).click();
  await expect.poll(() => rosterUrls.slice(requestCount).some((url) => url.searchParams.get("passiveSkill") === "MoveSpeed_up_3")).toBeTruthy();
  await page.getByLabel("帕鲁图鉴花名册排序").selectOption("name");
  await expect(page.locator(".pal-roster-row").first()).toContainText("阿帕");
  await page.getByRole("button", { name: "小羊" }).click();
  const palDrawer = page.getByRole("dialog", { name: "帕鲁详情" });
  await expect(palDrawer).not.toContainText("编号:");
  await expect(palDrawer).toContainText("棉悠悠");
  await expect(palDrawer).toContainText("稀有闪光");
  await expect(palDrawer).toContainText("个体值（IV）");
  await expect(palDrawer).toContainText("SAN 理智值");
  await expect(palDrawer).toContainText("饱食度");
  await expect(palDrawer).toContainText("平均 IV");
  await expect(palDrawer.locator(".pal-iv-summary")).toContainText("59.3");
  await expect(palDrawer.locator(".pal-vitals")).toContainText("50.2%");
  await expect(palDrawer).not.toContainText("333333");
  await expect(palDrawer).not.toContainText("207639");
  await expect(palDrawer.getByLabel("帕鲁六维雷达图")).toHaveCount(0);
  expect(await palDrawer.locator(".pal-iv-list > div, .pal-vitals > section").evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth))).toBe(true);

  await expect(palDrawer).toContainText("工作适应性技能");
  await expect(palDrawer.locator(".pal-detail-section.work img")).toHaveCount(2);
  await expect(palDrawer.locator(".pal-detail-section.work img").first()).toHaveAttribute("src", "/assets/work-suitabilities/T_icon_palwork_04.png");
  await expect(palDrawer.locator(".pal-detail-section.work img").nth(1)).toHaveAttribute("src", "/assets/work-suitabilities/T_icon_palwork_11.png");
  await expect(palDrawer).toContainText("被动特性词条");
  await expect(palDrawer).toContainText("配备主动战斗技能");
  await expect(palDrawer).toContainText("传说");
  await expect(palDrawer).toContainText("威力 40");
  await expect(palDrawer).toContainText("当前位置");
  await expect(palDrawer).toContainText("据点工作 · 据点一号");
  await expect(palDrawer).not.toContainText("所属训练家:");
  await expect(palDrawer).not.toContainText("存放位置:");
  const closePalDrawer = palDrawer.getByRole("button", { name: "关闭帕鲁详情" });
  await expect(closePalDrawer).toBeFocused();
  await expect(palDrawer.locator(".pal-passive-grid article").first()).toContainText("攻击 +20%，防御 +20%");
  await expect(palDrawer.locator(".pal-passive-grid button")).toHaveCount(0);
  await expect(palDrawer.getByRole("dialog", { name: "被动词条详情" })).toHaveCount(0);
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
  const guildNav = page.locator(".world-community-guild-nav");
  const baseWorkspace = page.locator(".world-community-base-workspace");
  await expect(guildNav).toContainText("测试工会");
  await expect(guildNav).toContainText("64 名成员 · 80 个据点");
  await expect(baseWorkspace).toContainText("全部据点");
  await expect(baseWorkspace).toContainText("据点一号");
  await expect(baseWorkspace).toContainText("1 / 15 打工帕鲁");
  await guildNav.locator("summary").click();
  await expect(guildNav.getByRole("button", { name: /全部公会/ })).toBeVisible();
  await expect.poll(() => {
    const guildRequest = worldListUrls.findLast((url) => url.pathname === "/api/world/guilds");
    const baseRequest = worldListUrls.findLast((url) => url.pathname === "/api/world/bases");
    return guildRequest?.searchParams.get("snapshotId") === baseRequest?.searchParams.get("snapshotId") ? baseRequest?.searchParams.get("snapshotId") : null;
  }).toBe("world");
  await expect(page.locator(".world-community-controls")).toHaveCount(0);
  await guildNav.getByLabel("搜索公会").fill("公会 64");
  await guildNav.getByRole("button", { name: "搜索", exact: true }).click();
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/guilds" && url.searchParams.get("search") === "公会 64")).toBeTruthy();
  await expect(guildNav).toContainText("公会 64");
  await guildNav.getByLabel("搜索公会").fill("");
  await guildNav.getByRole("button", { name: "搜索", exact: true }).click();
  await expect.poll(() => worldListUrls.findLast((url) => url.pathname === "/api/world/guilds")?.searchParams.has("search")).toBeFalsy();
  await expect(guildNav.locator(".audit-footer")).toContainText("第 1/2 页");
  await expect(baseWorkspace.locator(".audit-footer")).toContainText("共 80 条，第 1/2 页");
  await baseWorkspace.locator(".audit-footer").getByTitle("下一页").click();
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/bases" && url.searchParams.get("page") === "2")).toBeTruthy();
  await expect(baseWorkspace).toContainText("据点 80");
  await baseWorkspace.locator(".audit-footer").getByTitle("上一页").click();
  await guildNav.getByTitle("下一页").click();
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/guilds" && url.searchParams.get("page") === "2")).toBeTruthy();
  await expect(guildNav.locator(".audit-footer")).toContainText("第 2/2 页");
  await guildNav.getByTitle("上一页").click();
  await guildNav.getByRole("button", { name: /测试工会/ }).click();
  await expect.poll(() => worldDetailUrls.some((url) => url.pathname === "/api/world/guilds/guild-1" && url.searchParams.get("snapshotId") === "world")).toBeTruthy();
  await expect(baseWorkspace).toContainText("以下据点来自该公会详情返回的完整关联数据");
  await expect.poll(() => worldDetailUrls.some((url) => url.pathname === "/api/world/bases/base-1" && url.searchParams.get("snapshotId") === "world")).toBeTruthy();
  await expect(baseWorkspace).toContainText("测试工会");
  await expect(baseWorkspace).toContainText("查看成员（64）");
  await expect(baseWorkspace.locator(".world-community-local-pagination")).toContainText("完整关联据点共 80 条，显示 1-12 条，第 1/7 页");
  await baseWorkspace.locator(".world-community-local-pagination").getByTitle("下一页").click();
  await expect(baseWorkspace).toContainText("据点 13");
  await baseWorkspace.locator(".world-community-local-pagination").getByTitle("上一页").click();
  const baseCard = baseWorkspace.locator(".world-community-card").filter({ hasText: "据点一号" });
  await expect(baseCard).toContainText("1 / 15 打工帕鲁");
  await expect(baseCard).toContainText("X: 1, Y: 2, Z: 3");
  await baseCard.getByRole("button", { name: "查看全部 1 只" }).click();
  await expect(drawer).toContainText("完整打工帕鲁");
  await expect(drawer).toContainText("完整打工帕鲁名单来自此据点详情");
  if (testInfo.project.name === "mobile") {
    await expect(drawer).toHaveAttribute("data-sheet-snap", "compact");
    await expect(drawer).toHaveCSS("left", "0px");
    await expect(drawer).toHaveCSS("border-radius", "20px 20px 0px 0px");
    await expect(drawer).toHaveCSS("transform", "none");
    const sheetBox = (await drawer.boundingBox())!;
    expect(sheetBox.x).toBe(0);
    expect(sheetBox.width).toBe(390);
    expect(sheetBox.y).toBeGreaterThan(0);
    expect(sheetBox.y + sheetBox.height).toBeCloseTo(844, 0);
  }
  await drawer.getByRole("button", { name: /小羊/ }).click();
  const basePalDrawer = page.locator(".pal-detail-modal");
  await expect(basePalDrawer).toContainText("棉悠悠");
  await basePalDrawer.getByRole("button", { name: "返回上一详情" }).click();
  await expect(drawer).toContainText("完整打工帕鲁");
  await drawer.getByRole("button", { name: "关闭详情" }).click();
  const largeBaseCard = baseWorkspace.locator(".world-community-card").filter({ hasText: "大名单据点" });
  await expect(largeBaseCard).toContainText("64 / 64 打工帕鲁");
  await expect(largeBaseCard).toContainText("预览 5/64 只");
  const fortyWorkerBaseCard = baseWorkspace.locator(".world-community-card").filter({ hasText: "四十只据点 3" });
  await expect(fortyWorkerBaseCard).toContainText("40 / 40 打工帕鲁");
  await expect(fortyWorkerBaseCard).toContainText("预览 5/40 只");
  await page.screenshot({ path: testInfo.project.name === "mobile" ? "../.impeccable/review/community-mobile-390x844-island.png" : "../.impeccable/review/community-desktop-1440x960-island.png", fullPage: true, animations: "disabled" });
  await largeBaseCard.getByRole("button", { name: "查看全部 64 只" }).click();
  await expect(drawer).toContainText("完整打工帕鲁 64 / 64");
  await drawer.locator(".world-community-detail-list .audit-footer").getByTitle("下一页").click();
  await expect(drawer).toContainText("打工帕鲁2-13");
  const savedDetailScrollTop = await drawer.evaluate((element) => {
    element.scrollTop = 240;
    return element.scrollTop;
  });
  expect(savedDetailScrollTop).toBeGreaterThan(0);
  await drawer.getByRole("button", { name: /打工帕鲁2-13/ }).click();
  await expect(basePalDrawer).toContainText("棉悠悠");
  await basePalDrawer.getByRole("button", { name: "返回上一详情" }).click();
  await expect(drawer.locator(".world-community-detail-list .audit-footer")).toContainText("第 2/6 页");
  await expect.poll(() => drawer.evaluate((element) => element.scrollTop)).toBe(savedDetailScrollTop);
  const workerSearch = drawer.getByLabel("查找据点打工帕鲁");
  await workerSearch.fill("打工帕鲁2-64");
  await expect(drawer).toContainText("打工帕鲁2-64");
  await drawer.getByRole("button", { name: /打工帕鲁2-64/ }).click();
  await basePalDrawer.getByRole("button", { name: "返回上一详情" }).click();
  await expect(workerSearch).toHaveValue("打工帕鲁2-64");
  await drawer.getByRole("button", { name: "关闭详情" }).click();
  await baseWorkspace.getByRole("button", { name: "查看成员（64）" }).click();
  await expect(drawer).toContainText("完整成员名单");
  await expect(drawer).toContainText("64 / 64");
  await drawer.locator(".world-community-detail-list .audit-footer").getByTitle("下一页").click();
  await expect(drawer).toContainText("成员 13");
  const memberSearch = drawer.getByLabel("查找公会成员");
  await memberSearch.fill("成员 64");
  await drawer.getByRole("button", { name: /成员 64/ }).click();
  await expect(drawer).toContainText("成员 64");
  await drawer.getByRole("button", { name: "返回上一详情" }).click();
  await expect(memberSearch).toHaveValue("成员 64");
  await drawer.getByRole("button", { name: "关闭详情" }).click();
  await page.getByRole("button", { name: "重新解析" }).click();
  await expect.poll(() => reparseRequests).toBe(1);
  await expect.poll(getReparseStatusReads).toBeGreaterThanOrEqual(3);
  await expect.poll(() => worldListUrls.some((url) => url.pathname === "/api/world/bases" && url.searchParams.get("snapshotId") === "world-new")).toBeTruthy();
  await page.getByRole("button", { name: "重新解析" }).click();
  await expect.poll(() => reparseRequests).toBe(2);
  await expect(page.getByText(/SNAPSHOT_PARSE_FAILED/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath(`ux04-${testInfo.project.name}.png`), fullPage: true });
});

test("UX-04：游戏原始工作图标在明暗主题加载，未知技能使用 SVG 兜底", async ({ page }, testInfo) => {
  const types = ["EmitFlame", "Watering", "Seeding", "GenerateElectricity", "Handcraft", "Collection", "Deforest", "Mining", "OilExtraction", "ProductMedicine", "Cool", "Transport", "MonsterFarm", "FutureWork"];
  await setupWorld(page);
  await page.route("**/api/world/pals/roster?*", (route) => route.fulfill({ json: {
    items: [{ ...pal, locationType: "base", aptitude: { ...aptitude, workSuitabilities: types.map((type) => ({ type, level: 2 })) } }],
    snapshotId: new URL(route.request().url()).searchParams.get("snapshotId"), page: 1, pageSize: 60, total: 1,
    careSummary: { total: 1, critical: 1, warning: 0, attention: 1, unavailable: 0 },
    passiveSkills: [], passiveCatalog: [], metadata: { status: "ready" },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  const summary = page.locator(".pal-work-summary");
  const images = summary.locator("img");
  await expect(images).toHaveCount(13);
  const work = summary.locator("em").last();
  await expect(work).toHaveText("FutureWorkLv.2");
  await expect(work.locator("svg.lucide-settings")).toHaveCount(1);
  await expect(work.locator("svg")).toHaveAttribute("stroke", "currentColor");
  await expect(page.getByLabel("工作技能筛选").locator("option")).toHaveCount(14);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await expect.poll(() => images.evaluateAll((elements) => elements.every((element) => {
      const image = element as HTMLImageElement;
      const bounds = image.getBoundingClientRect();
      const size = image.src.endsWith("T_icon_palwork_09.png") ? 40 : 64;
      return image.complete && image.naturalWidth === size && image.naturalHeight === size && bounds.width === 12 && bounds.height === 12 && getComputedStyle(image).filter === "none";
    }))).toBeTruthy();
    await expect.poll(() => work.evaluate((element) => getComputedStyle(element.querySelector("svg")!).stroke === getComputedStyle(element).color)).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    await page.locator(".pal-roster-row").screenshot({ path: testInfo.outputPath(`work-original-${theme}.png`) });
  }
});

test("UX-04：详情工作技能复用原图，在明暗主题完整加载并换行", async ({ page }, testInfo) => {
  const types = ["EmitFlame", "Watering", "Seeding", "GenerateElectricity", "Handcraft", "Collection", "Deforest", "Mining", "OilExtraction", "ProductMedicine", "Cool", "Transport", "MonsterFarm"];
  await setupWorld(page);
  await page.route("**/api/world/pals/pal-1?*", (route) => route.fulfill({ json: {
    ...pal, aptitude: { ...aptitude, workSuitabilities: types.map((type) => ({ type, level: 2 })) },
    snapshotId: new URL(route.request().url()).searchParams.get("snapshotId"), owner: player, base,
    container: { id: "container-1", kind: "base_workers", slotCount: 20 },
    metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null },
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  await page.locator(".pal-roster-row").first().click();
  const dialog = page.getByRole("dialog", { name: "帕鲁详情" });
  const section = dialog.locator(".pal-detail-section.work");
  await expect(section.locator("img")).toHaveCount(13);
  await expect(section).not.toContainText("FutureWork");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await section.scrollIntoViewIfNeeded();
    await expect.poll(() => section.locator("img").evaluateAll((elements) => elements.every((element) => {
      const image = element as HTMLImageElement;
      const bounds = image.getBoundingClientRect();
      const size = image.src.endsWith("T_icon_palwork_09.png") ? 40 : 64;
      return image.complete && image.naturalWidth === size && image.naturalHeight === size && bounds.width === 16 && bounds.height === 16 && getComputedStyle(image).filter === "none" && image.alt === "" && image.getAttribute("aria-hidden") === "true";
    }))).toBeTruthy();
    expect(await section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
    await section.screenshot({ path: testInfo.outputPath(`detail-work-${theme}.png`) });
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("UX-04：帕鲁卡片从 1024px 起显示三列，保留手机布局与间距", async ({ page }, testInfo) => {
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  const cards = page.locator(".pal-roster-cards");
  await expect(cards.locator(".pal-roster-row")).toHaveCount(3);
  for (const [width, columns] of [[390, 1], [760, 1], [765, 2], [1023, 2], [1024, 3], [1180, 3], [1181, 3]]) {
    await page.setViewportSize({ width, height: 960 });
    await expect.poll(() => cards.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(columns);
    await expect(cards).toHaveCSS("gap", "15px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
    if (width === 1024 || width === 390) {
      await cards.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`pal-roster-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1024, height: 960 });
  await page.getByRole("tab", { name: "训练家档案" }).click();
  await expect.poll(() => page.locator(".world-player-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
});

test("UX-04：765px 宽度可访问完整公会菜单与响应式物资卡片", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 765, height: 844 });
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点" }).click();
  const guildNav = page.getByLabel("公会选择器");
  await expect(guildNav.locator("summary")).toBeVisible();
  await expect(guildNav.getByLabel("搜索公会")).toBeHidden();
  await guildNav.locator("summary").click();
  await expect(guildNav.getByLabel("搜索公会")).toBeVisible();
  await expect(guildNav.getByRole("button", { name: /测试工会/ })).toBeVisible();
  await page.getByRole("tab", { name: "全服物资检索" }).click();
  const inventory = page.locator(".inventory-workspace");
  await expect(inventory.locator(".inventory-toolbar")).toBeVisible();
  await expect(inventory.locator(".inventory-item-summary")).toHaveCount(2);
  await expect(inventory.locator(".inventory-item").first().locator(".inventory-preview")).toContainText("玩家：Alice");
  expect(await inventory.evaluate((element) => {
    const style = (selector: string) => getComputedStyle(element.querySelector(selector)!);
    return {
      searchHeight: style(".world-search").minHeight,
      buttonHeight: style(".world-search-button").minHeight,
      scopeHeight: style(".inventory-scope").minHeight,
      controlHeight: style(".world-control").minHeight,
      resultDisplay: style(".inventory-results").display,
      resultColumns: style(".inventory-results").gridTemplateColumns.split(" ").length,
      itemRadius: style(".inventory-item").borderRadius,
    };
  })).toEqual({ searchHeight: "42px", buttonHeight: "42px", scopeHeight: "42px", controlHeight: "42px", resultDisplay: "grid", resultColumns: 1, itemRadius: "16px" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.route("**/api/world/inventory-items?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });
  await inventory.getByLabel("物品分类筛选").selectOption("材料");
  await expect(inventory.locator(".inventory-skeleton")).toHaveCount(8);
  await expect(inventory.locator(".inventory-item-summary")).toHaveCount(2);
  await page.setViewportSize({ width: 768, height: 844 });
  await expect.poll(() => inventory.locator(".inventory-results").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect.poll(() => inventory.locator(".inventory-results").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(4);
  await page.screenshot({ path: testInfo.outputPath("inventory-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => inventory.locator(".inventory-results").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
  const search = await inventory.getByLabel("搜索物品").boundingBox();
  const category = await inventory.getByLabel("物品分类筛选").boundingBox();
  const scope = await inventory.getByRole("group", { name: "仓库范围" }).boundingBox();
  const sort = await inventory.getByLabel("仓库排序方式").boundingBox();
  expect(search && category && scope && sort && search.y < category.y && category.y < scope.y && scope.y < sort.y).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath("inventory-mobile.png"), fullPage: true });
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


test("帕鲁弹窗：数值精度、布局与详情交互", async ({ page }, testInfo) => {
  await setupWorld(page);
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "帕鲁图鉴花名册" }).click();
  const trigger = page.getByRole("button", { name: /小羊/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "帕鲁详情", exact: true });
  await expect(dialog.getByRole("button", { name: "关闭帕鲁详情" })).toBeFocused();
  if (testInfo.project.name === "mobile") {
    await expect(dialog.getByRole("button", { name: "调整抽屉高度" })).toBeVisible();
    await expect.poll(async () => (await dialog.boundingBox())!.height).toBeCloseTo(506.4, 0);
  }
  await expect(dialog.getByRole("button", { name: "查找同种帕鲁", exact: true })).toHaveCount(1);
  await expect(dialog).not.toContainText("编号:");
  await expect(dialog.locator(".pal-iv-summary")).toContainText("59.3");
  await expect(dialog.locator(".pal-vitals")).toContainText("50.2%");
  await expect(dialog).not.toContainText("207639");
  await expect(dialog).not.toContainText("333333");
  await expect(dialog.locator(".pal-iv-section")).not.toContainText("稀有度");
  await expect(dialog.locator(".pal-iv-section")).not.toContainText("星级");
  await expect(dialog.locator(".pal-detail-header")).toContainText("物种稀有度: 1");
  expect(await dialog.locator(".pal-iv-list > div, .pal-vitals > section, .pal-detail-body").evaluateAll((cells) => cells.every((cell) => cell.scrollWidth <= cell.clientWidth))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("pal-detail.png"), animations: "disabled" });
  const passiveCard = dialog.locator(".pal-passive-grid article").first();
  await passiveCard.scrollIntoViewIfNeeded();
  await expect(passiveCard).toBeInViewport();
  await expect(passiveCard).toContainText("攻击 +20%，防御 +20%");
  expect(await passiveCard.locator("p").evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("pre-line");
  if (testInfo.project.name === "mobile") await page.screenshot({ path: testInfo.outputPath("pal-passive-mobile.png"), animations: "disabled" });
  await expect(dialog.locator(".pal-passive-grid button")).toHaveCount(0);
  await expect(dialog.getByRole("dialog", { name: "被动词条详情" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await dialog.getByRole("button", { name: "查找同种帕鲁", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: "搜索帕鲁图鉴花名册" })).toHaveValue("棉悠悠");
});


test("据点容量：使用存档当前槽位而非配置最高值", async ({ page }) => {
  await setupWorld(page);
  const workers = Array.from({ length: 26 }, (_, index) => ({ ...pal, id: `capacity-pal-${index}`, slotIndex: index }));
  await page.route("**/api/world/bases?*", (route) => route.fulfill({ json: {
    items: [{ ...base, name: "容量验证据点", workerCount: 26, maxWorkerCount: 30, workers }],
    page: 1, pageSize: 50, total: 1, source: "save-snapshot", observedAt: 1,
    snapshotId: "world", stale: false, errorCode: null,
  } }));
  await page.goto("/");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.getByRole("tab", { name: "公会与据点" }).click();
  const card = page.locator(".world-community-card").filter({ hasText: "容量验证据点" });
  await expect(card.locator("header")).toContainText("26 / 30 打工帕鲁");
  await expect(card.getByTitle("存档中的打工帕鲁数量；容量仅在同快照的据点详情提供时显示")).toBeVisible();
});
