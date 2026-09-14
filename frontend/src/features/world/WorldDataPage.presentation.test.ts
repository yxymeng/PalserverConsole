import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("世界数据筛选与排序交给完整数据查询处理", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8").replace(/\r\n/g, "\n");

  expect(source).toContain('query.set("status", state.statusFilter)');
  expect(source).toContain('sort: state.sortKey');
  expect(source).not.toContain("matchesRelationFilter");
  expect(source).toContain("entityStateCache.current[next]");
  expect(source).toContain("scrollPositions.current[workspace]");
  expect(source).toContain('label: "世界资产总览"');
  expect(source).toContain('label: "训练家档案"');
  expect(source).toContain('label: "帕鲁图鉴花名册"');
  expect(source).toContain('label: "公会与据点"');
  expect(source).toContain('const resources: CommunityResource[] = ["guilds", "bases"]');
  expect(source).toContain("await Promise.all(resources.map");
  expect(source).toContain('className="world-community-layout"');
  expect(source).not.toContain("world-community-controls");
  expect(source).not.toContain("world-community-card-open");
  expect(source).toContain("function CommunityWorkspace");
  expect(source).toContain("world-community-guild-nav");
  expect(source).toContain('"未关联公会"');
  expect(source).toContain("guildDetail.pals.filter");
  expect(source).toContain("完整关联据点");
  expect(source).toContain("function CommunityBaseCard");
  expect(source).toContain("查看全部");
  expect(source).toContain("function GuildCommunityDetail");
  expect(source).toContain("function BaseCommunityDetail");
  expect(source).toContain("完整打工帕鲁名单来自此据点详情");
  expect(source).toContain('label: "全服物资检索"');
  expect(source).toContain("InventoryWorkspace");
  expect(source).toContain("WorldOverviewLobby");
  expect(source).toContain("WorldSnapshotUtility");
  expect(source).not.toContain("WorldSnapshotBar");
  expect(source).toContain('label: "游戏历法"');
  expect(source).toContain("formatWorldCalendar(status?.gameTimeTicks)");
  expect(source).toContain("不会用当前分页结果推算");
  expect(source).toContain("CommunityBaseGrid");
  expect(source).toContain("WorldPagination");
  expect(source).not.toContain("从登记训练家、帕鲁生态、公会、据点、物资与游戏历法六个维度");
  expect(source).not.toContain("油田未记录按 0 次展示");
  expect(source).not.toContain('className="world-overview-heading"');
  expect(source).not.toContain('className="world-player-archive-heading"');
  expect(source).not.toContain('label: "未知物品"');
  expect(source).not.toContain('label: "未归属帕鲁"');
  expect(source).not.toContain('workspace="inventories"');
});

test("仓库默认使用持有库存并按存放分布两级展开", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const inventoryPath = fileURLToPath(new URL("./InventoryWorkspace.tsx", import.meta.url));
  const pageSource = readFileSync(pagePath, "utf8");
  const source = readFileSync(inventoryPath, "utf8");

  expect(pageSource).toContain('useState<InventoryContext>({ scope: "inventory" })');
  expect(source).toContain('["inventory", "全部持有"]');
  expect(source).toContain('["player", "玩家背包"]');
  expect(source).toContain('["base", "据点箱子"]');
  expect(source).not.toContain('["world", "世界"]');
  expect(source).toContain("持有总量");
  expect(source).toContain("世界宝箱和其他地图容器不计入仓库");
  expect(source).toContain("公会仓库");
  expect(source).not.toContain('["guild", "公会"]');
  expect(source).toContain("存放记录");
  expect(source).toContain("存放分布");
  expect(source).toContain("group.label");
  expect(source).toContain('group.locationType === "world"');
  expect(source).toContain('group.locationType === "unassigned"');
  expect(source).toContain("mapObjectType");
  expect(source).not.toContain("<small>位置</small>");
});

test("公会导航按完整详情筛选据点，并在详情中保留完整成员与打工帕鲁", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const pageSource = readFileSync(pagePath, "utf8");

  expect(pageSource).toContain("/api/world/guilds/${encodeURIComponent(guild.id)}${suffix}");
  expect(pageSource).toContain("当前不会改用已加载的 50 条据点做不完整筛选");
  expect(pageSource).toContain("function baseWorkerCapacity(value: unknown): number | null");
  expect(pageSource).toContain("/api/world/bases/${encodeURIComponent(id)}${suffix}");
  expect(pageSource).toContain('capacityState: hasLoadedCapacity || hasDetailCapacity ? undefined : baseCapacityErrors[base.id] ? "error" : "loading"');
  expect(pageSource).not.toContain("maxWorkerCount: base.maxWorkerCount");
  expect(pageSource).toContain("无法判断当前范围是否有据点");
  expect(pageSource).toContain('label="完整关联据点"');
  expect(pageSource).toContain("完整成员名单");
  expect(pageSource).toContain("完整打工帕鲁");
  expect(pageSource).toContain("communityViews");
  expect(pageSource).toContain("detailScrollPositions");
  expect(pageSource).toContain("<WorldPagination");
  expect(pageSource).not.toContain("world-community-controls");
});

test("在线玩家未知结构不会被当成零人", () => {
  const pagePath = fileURLToPath(new URL("./WorldDataPage.tsx", import.meta.url));
  const source = readFileSync(pagePath, "utf8");

  expect(source).toContain("function livePlayersFrom(data: unknown): Record<string, unknown>[] | null");
  expect(source).toContain("response.stale || response.errorCode || players === null");
  expect(source).toContain("return null;");
});
