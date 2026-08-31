import { ArrowLeft, Boxes, Building2, ChevronLeft, ChevronRight, CircleAlert, Compass, Crown, Database, FileText, Flame, Globe, HeartPulse, History, LayoutDashboard, MapPin, Package, PackageOpen, PawPrint, RefreshCw, Search, Sparkles, SlidersHorizontal, Trophy, Users, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, LiveValue, WorldBaseListItem, WorldContainerReference, WorldEntityListItem, WorldEntityListResponse, WorldGuildListItem, WorldPalDetail, WorldPalListItem, WorldPlayerDetail, WorldPlayerListItem, WorldPlayerProgress, WorldPlayerProgressField, WorldReparseResponse, WorldSnapshotContext, WorldStatus } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { useIsMobile } from "../../hooks/use-mobile";
import { formatWorldTime, type PrimaryWorldResource } from "./worldTable";
import { playerInitial, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { PalRoster, type PalRosterContext } from "./PalRoster";
import { PalDetailModal } from "./PalDetailModal";
import { InventoryWorkspace, type InventoryContext } from "./InventoryWorkspace";
import { PLAYER_PROGRESS_GROUPS, PLAYER_PROGRESS_LABELS, playerProgressCoverage, playerProgressOf, playerProgressPercent, playerProgressTotal, playerProgressUnavailable, playerProgressValue } from "./playerProgress";
import { presentWorldSnapshot } from "./worldSnapshotPresentation";
import { waitForWorldReparse } from "./worldReparse";
import { ensureWorldContract } from "./worldContract";

type EntityDetail =
  | { resource: "players"; data: WorldPlayerDetail & WorldSnapshotContext }
  | { resource: "pals"; data: WorldPalDetail & WorldSnapshotContext };
type WorldEntityDetailData = EntityDetail["data"];
type RelationshipItem = WorldPlayerListItem | WorldPalListItem | WorldGuildListItem | WorldBaseListItem | WorldContainerReference;
type SortKey = "name" | "level-desc" | "id";
type StatusFilter = "all" | "guilded" | "unguilded";
type WorkspaceKey = "overview" | "players" | "pals" | "community" | "inventories";
type CommunityResource = "guilds" | "bases";
type EntityBrowserSnapshot = { result: WorldEntityListResponse | null; page: number; search: string; appliedSearch: string; sortKey: SortKey; statusFilter: StatusFilter };

const WORKSPACES: { key: WorkspaceKey; label: string; icon: typeof Database; countKey?: keyof WorldStatus["counts"]; resource?: PrimaryWorldResource }[] = [
  { key: "overview", label: "世界资产总览", icon: Globe },
  { key: "players", label: "训练家档案", icon: Users, countKey: "players", resource: "players" },
  { key: "pals", label: "帕鲁图鉴花名册", icon: PawPrint, countKey: "pals", resource: "pals" },
  { key: "community", label: "公会与据点", icon: Building2, resource: "guilds" },
  { key: "inventories", label: "全服物资检索", icon: Package, countKey: "inventory_items" },
];

const WORKSPACE_BY_RESOURCE: Record<PrimaryWorldResource, WorkspaceKey> = { players: "players", pals: "pals", guilds: "community", bases: "community" };

const RESOURCE_LABELS: Record<PrimaryWorldResource, string> = {
  players: "训练家档案",
  pals: "帕鲁",
  guilds: "公会",
  bases: "据点",
};

const PLAYER_STATUS_OPTIONS = [{ value: "all", label: "全部训练家" }, { value: "guilded", label: "已加入公会" }, { value: "unguilded", label: "未加入公会" }] as const;
const PLAYER_SORT_OPTIONS = [{ value: "name", label: "名称" }, { value: "level-desc", label: "等级（高到低）" }, { value: "id", label: "稳定 ID" }] as const;

export function WorldDataPage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<WorldStatus | null>(null);
  const [onlinePlayerCount, setOnlinePlayerCount] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceKey>("overview");
  const [resource, setResource] = useState<PrimaryWorldResource>("players");
  const [inventoryContext, setInventoryContext] = useState<InventoryContext>({ scope: "inventory" });
  const [palContext, setPalContext] = useState<PalRosterContext>({ token: 0 });
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Set<WorkspaceKey>>(() => new Set(["overview"]));
  const [workspaceHistory, setWorkspaceHistory] = useState<{ workspace: WorkspaceKey; resource: PrimaryWorldResource; detail: EntityDetail | null }[]>([]);
  const [result, setResult] = useState<WorldEntityListResponse | null>(null);
  const [communityResults, setCommunityResults] = useState<Record<CommunityResource, WorldEntityListResponse | null>>({ guilds: null, bases: null });
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<EntityDetail | null>(null);
  const [detailHistory, setDetailHistory] = useState<EntityDetail[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [showListLoading, setShowListLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reparseError, setReparseError] = useState("");
  const [reparsing, setReparsing] = useState(false);
  const pageSize = 50;
  const nextRequestSignal = useAbortableRequest();
  const loadSequence = useRef(0);
  const entityStateCache = useRef<Partial<Record<PrimaryWorldResource, EntityBrowserSnapshot>>>({});
  const scrollPositions = useRef<Partial<Record<WorkspaceKey, number>>>({});
  const previousSnapshotId = useRef<string | null | undefined>(undefined);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const snapshotId = status?.snapshotId;

  const refreshSnapshot = useCallback(async () => {
    const nextStatus = await requestJson<WorldStatus>("/api/world/snapshots/current");
    ensureWorldContract(nextStatus.contract);
    setStatus(nextStatus);
    return nextStatus.snapshotId;
  }, []);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const signal = nextRequestSignal();
    const hasEntityBrowser = workspace === "players" || workspace === "community";
    setListLoading(hasEntityBrowser);
    setError("");
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const nextStatus = await requestJson<WorldStatus>("/api/world/snapshots/current", { signal });
        ensureWorldContract(nextStatus.contract);
        setStatus(nextStatus);
        if (!hasEntityBrowser || !nextStatus.snapshotId) {
          setResult(null);
          break;
        }
        const stableSnapshotId = nextStatus.snapshotId;
        try {
          if (workspace === "community") {
            const resources: CommunityResource[] = ["guilds", "bases"];
            const states = Object.fromEntries(resources.map((target) => {
              const cached = entityStateCache.current[target];
              return [target, target === resource
                ? { result: cached?.result || null, page, search: cached?.search || appliedSearch, appliedSearch, sortKey, statusFilter }
                : cached || { result: null, page: 1, search: "", appliedSearch: "", sortKey: "name" as SortKey, statusFilter: "all" as StatusFilter }];
            })) as Record<CommunityResource, EntityBrowserSnapshot>;
            const responses = await Promise.all(resources.map(async (target) => {
              const state = states[target];
              const query = createWorldListQuery(state, pageSize, stableSnapshotId);
              return requestJson<WorldEntityListResponse>(`/api/world/${target}?${query}`, { signal });
            }));
            if (responses.some((response) => response.snapshotId !== stableSnapshotId)) continue;
            const nextCommunityResults = { guilds: responses[0], bases: responses[1] };
            resources.forEach((target) => { entityStateCache.current[target] = { ...states[target], result: nextCommunityResults[target] }; });
            setCommunityResults(nextCommunityResults);
            setResult(nextCommunityResults[resource as CommunityResource]);
          } else {
            const query = createWorldListQuery({ page, appliedSearch, sortKey, statusFilter }, pageSize, stableSnapshotId);
            const nextResult = await requestJson<WorldEntityListResponse>(`/api/world/${resource}?${query}`, { signal });
            if (nextResult.snapshotId !== stableSnapshotId) continue;
            setResult(nextResult);
          }
          break;
        } catch (caught) {
          if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED" && attempt === 0) continue;
          throw caught;
        }
      }
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "世界数据读取失败");
    } finally {
      if (sequence === loadSequence.current) setListLoading(false);
    }
  }, [appliedSearch, nextRequestSignal, page, resource, sortKey, statusFilter, workspace]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (workspace !== "overview") return;
    let active = true;
    const controller = new AbortController();
    const refreshOnlinePlayers = async () => {
      try {
        const response = await requestJson<LiveValue<unknown>>(
          "/api/live/players",
          { signal: controller.signal },
        );
        if (!active) return;
        const players = livePlayersFrom(response.data);
        setOnlinePlayerCount(
          response.stale || response.errorCode || players === null
            ? null
            : players.length,
        );
      } catch (caught) {
        if (active && !isAbortError(caught)) setOnlinePlayerCount(null);
      }
    };
    void refreshOnlinePlayers();
    const timer = window.setInterval(() => void refreshOnlinePlayers(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
      controller.abort();
    };
  }, [workspace]);
  useEffect(() => {
    if (previousSnapshotId.current !== undefined && previousSnapshotId.current !== snapshotId) {
      entityStateCache.current = {};
      scrollPositions.current = {};
      setWorkspaceHistory([]);
      setDetailHistory([]);
      setSelected(null);
      setResult(null);
      setCommunityResults({ guilds: null, bases: null });
      setPage(1);
      setSearch("");
      setAppliedSearch("");
      setStatusFilter("all");
      setSortKey("name");
      setPalContext((current) => ({ token: current.token + 1 }));
      setInventoryContext({ scope: "inventory" });
    }
    previousSnapshotId.current = snapshotId;
  }, [snapshotId]);
  useEffect(() => {
    if (!listLoading) {
      setShowListLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowListLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [listLoading]);

  function saveEntityBrowser() {
    if (workspace === "players" || workspace === "community") {
      entityStateCache.current[resource] = { result, page, search, appliedSearch, sortKey, statusFilter };
    }
  }

  function activateWorkspace(next: WorkspaceKey, pushHistory = false) {
    saveEntityBrowser();
    scrollPositions.current[workspace] = window.scrollY;
    if (pushHistory && next !== workspace) setWorkspaceHistory((current) => [...current, { workspace, resource, detail: selected }]);
    setVisitedWorkspaces((current) => new Set(current).add(next));
    setWorkspace(next);
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollPositions.current[next] || 0 }));
  }

  function chooseResource(next: PrimaryWorldResource, pushHistory = false) {
    activateWorkspace(WORKSPACE_BY_RESOURCE[next], pushHistory);
    setResource(next);
    const restored = entityStateCache.current[next];
    setResult(restored?.result || null);
    setPage(restored?.page || 1);
    setSearch(restored?.search || "");
    setAppliedSearch(restored?.appliedSearch || "");
    setStatusFilter(restored?.statusFilter || "all");
    setSortKey(restored?.sortKey || "name");
  }

  function chooseWorkspace(next: WorkspaceKey) {
    setSelected(null);
    setDetailHistory([]);
    const target = WORKSPACES.find((item) => item.key === next);
    if (target?.resource) {
      chooseResource(target.resource);
      return;
    }
    activateWorkspace(next);
  }

  function openInventory(context: InventoryContext, pushHistory = true) {
    setInventoryContext(context);
    activateWorkspace("inventories", pushHistory);
    setSelected(null);
    setDetailHistory([]);
  }

  function openPalSummary(context: Omit<PalRosterContext, "token">) {
    setPalContext((current) => ({ ...context, token: current.token + 1 }));
    activateWorkspace("pals", true);
  }

  function returnWorkspace() {
    const entry = workspaceHistory.at(-1);
    if (!entry) return;
    setWorkspaceHistory((current) => current.slice(0, -1));
    setSelected(entry.detail);
    if (entry.workspace === "players" || entry.workspace === "community") chooseResource(entry.resource);
    else activateWorkspace(entry.workspace);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(search.trim());
  }

  function clearFilters() {
    setSearch("");
    setAppliedSearch("");
    setStatusFilter("all");
    setSortKey("name");
    setPage(1);
  }

  function changeCommunityPage(target: CommunityResource, nextPage: number) {
    if (target !== resource) chooseResource(target);
    setPage(nextPage);
  }

  async function reparse() {
    setReparseError("");
    setMessage("");
    setReparsing(true);
    try {
      const previousSnapshotId = status?.snapshotId || null;
      const response = await requestJson<WorldReparseResponse>("/api/world/reparse", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: "{}",
      });
      setMessage(response.message);
      const nextStatus = await waitForWorldReparse({
        previousSnapshotId,
        reparseGeneration: response.reparseGeneration,
        readStatus: async () => {
          const nextStatus = await requestJson<WorldStatus>("/api/world/snapshots/current");
          ensureWorldContract(nextStatus.contract);
          return nextStatus;
        },
        onStatus: setStatus,
      });
      setStatus(nextStatus);
      await load();
    } catch (caught) {
      setReparseError(caught instanceof Error ? caught.message : "重新解析请求失败");
    } finally {
      setReparsing(false);
    }
  }

  const openDetail = useCallback(async (nextResource: EntityDetail["resource"], id: string, preserveCurrent = false, trigger?: HTMLElement) => {
    if (!selected) detailReturnFocusRef.current = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setDetailLoading(true);
    setError("");
    try {
      const nextDetail = await loadEntityDetail(nextResource, id, snapshotId);
      if (preserveCurrent && selected) setDetailHistory((current) => [...current, selected]);
      setSelected(nextDetail);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "实体详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }, [selected, snapshotId]);

  function closeDetail() {
    const previous = detailHistory.at(-1) || null;
    setDetailHistory((current) => current.slice(0, -1));
    setSelected(previous);
    if (!previous) window.requestAnimationFrame(() => detailReturnFocusRef.current?.focus());
  }

  const displayedItems = result?.items || [];
  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch) || statusFilter !== "all" || sortKey !== "name";

  return <div className="page-stack world-page">
    <div className="world-page-navigation">
      <div className="world-tabs world-workspace-tabs" role="tablist" aria-label="世界资产工作区">
        {WORKSPACES.map(({ key, label, icon: Icon, countKey }) => <button key={key} className={workspace === key ? "active" : ""} type="button" role="tab" id={`world-workspace-tab-${key}`} aria-selected={workspace === key} aria-controls={`world-workspace-${key}`} onClick={() => chooseWorkspace(key)}><Icon size={17} /><span>{label}</span>{countKey && <strong>{status?.counts[countKey] ?? "-"}</strong>}</button>)}
      </div>
      <WorldSnapshotUtility status={status} message={message} reparseError={reparseError} reparsing={reparsing} onReparse={() => void reparse()} />
    </div>
    {error && <WorldRequestFailure error={error} onRetry={() => void load()} />}
    {workspaceHistory.length > 0 && <button className="world-context-return" type="button" onClick={returnWorkspace}><ArrowLeft size={16} />返回{WORKSPACES.find((item) => item.key === workspaceHistory.at(-1)?.workspace)?.label || "上一处"}<span>保留原筛选、结果与详情上下文</span></button>}
    <main className="world-workspace">
      <section id="world-workspace-overview" role="tabpanel" aria-labelledby="world-workspace-tab-overview" hidden={workspace !== "overview"}><WorldOverviewLobby status={status} onlinePlayerCount={onlinePlayerCount} onChooseResource={(target) => chooseResource(target, true)} onShowInventory={(context) => openInventory(context, true)} onShowPals={openPalSummary} /></section>
      <section id="world-workspace-inventories" role="tabpanel" aria-labelledby="world-workspace-tab-inventories" hidden={workspace !== "inventories"}>{visitedWorkspaces.has("inventories") && <InventoryWorkspace key={snapshotId || "none"} snapshotId={snapshotId} context={inventoryContext} onSnapshotReplaced={refreshSnapshot} onContextChange={setInventoryContext} onClearContext={() => setInventoryContext({ scope: "inventory" })} />}</section>
      <section id="world-workspace-pals" role="tabpanel" aria-labelledby="world-workspace-tab-pals" hidden={workspace !== "pals"}>{visitedWorkspaces.has("pals") && <PalRoster key={snapshotId || "none"} snapshotId={snapshotId} context={palContext} onSnapshotReplaced={refreshSnapshot} onNavigate={(target, id) => target === "bases" ? chooseResource(target, true) : void openDetail(target, id, true)} />}</section>
      <section id="world-workspace-players" role="tabpanel" aria-labelledby="world-workspace-tab-players" hidden={workspace !== "players"}>{workspace === "players" && <div className="world-player-archive">
        <header className="world-player-archive-heading"><div><span className="world-heading-icon"><Users size={22} /></span><div><h2>训练家档案 · 探索进度与概览</h2><p>登记训练家共 <strong>{result?.total ?? status?.counts.players ?? "—"}</strong> 名；油田未记录按 0 次展示，其余进度来自只读存档快照。</p></div></div><span className="world-module-total">当前显示 {displayedItems.length} 名</span></header>
        <section className="world-list-panel" aria-label="训练家档案列表">
          <form className="world-toolbar world-player-toolbar" onSubmit={submitSearch}>
            <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索训练家档案" placeholder="搜索训练家名称或稳定 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
            <button className="primary-button world-search-button" type="submit">搜索</button>
            <label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>公会</span><select aria-label="训练家公会筛选" value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value as StatusFilter); }}>{PLAYER_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="world-control"><span>排序</span><select aria-label="训练家排序方式" value={sortKey} onChange={(event) => { setPage(1); setSortKey(event.target.value as SortKey); }}>{PLAYER_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            {hasFilters && <button className="world-clear-button" type="button" aria-label="清除训练家筛选条件" onClick={clearFilters}><X size={15} />清除</button>}
          </form>
          <div className="world-player-grid" aria-live="polite" aria-busy={listLoading}>
            {showListLoading ? Array.from({ length: 6 }, (_, index) => <div className="world-player-card skeleton" aria-hidden="true" key={index}><span /><span /><span /></div>) : displayedItems.length ? (displayedItems as WorldPlayerListItem[]).map((item) => <PlayerArchiveCard item={item} selected={selected?.resource === "players" && selected.data.id === item.id} key={item.id} onOpen={(trigger) => void openDetail("players", item.id, false, trigger)} />) : <div className="world-empty-state world-player-empty"><Users size={26} /><strong>{result ? hasFilters ? "没有符合条件的训练家" : "当前快照没有训练家档案" : snapshotId ? "正在读取训练家档案" : "当前没有可用世界快照"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : "完成只读解析后，训练家档案会显示在这里。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
          </div>
          <WorldPagination result={result} page={page} totalPages={totalPages} onPage={setPage} />
        </section>
      </div>}</section>
      <section id="world-workspace-community" role="tabpanel" aria-labelledby="world-workspace-tab-community" hidden={workspace !== "community"}>{workspace === "community" && <div className="world-community-browser">
      <div className="world-community-columns">
        {(["guilds", "bases"] as CommunityResource[]).map((target) => <CommunityPanel resource={target} result={communityResults[target]} loading={showListLoading} snapshotId={snapshotId} key={target} onOpenPal={(itemId, trigger) => void openDetail("pals", itemId, true, trigger)} onPage={(nextPage) => changeCommunityPage(target, nextPage)} />)}
      </div>
      </div>}</section>
    </main>
    {selected && <EntityDetailLayer detail={selected} loading={detailLoading} canGoBack={detailHistory.length > 0} onClose={closeDetail} onNavigate={(target, id) => void openDetail(target, id, true)} onShowInventory={openInventory} />}
  </div>;
}

function createWorldListQuery(state: Pick<EntityBrowserSnapshot, "page" | "appliedSearch" | "sortKey" | "statusFilter">, pageSize: number, snapshotId: string) {
  const query = new URLSearchParams({ page: String(state.page), pageSize: String(pageSize), sort: state.sortKey, snapshotId });
  if (state.appliedSearch) query.set("search", state.appliedSearch);
  if (state.statusFilter !== "all") query.set("status", state.statusFilter);
  return query;
}

async function loadEntityDetail(resource: EntityDetail["resource"], id: string, snapshotId: string | null | undefined): Promise<EntityDetail> {
  const suffix = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : "";
  const url = `/api/world/${resource}/${encodeURIComponent(id)}${suffix}`;
  if (resource === "players") return { resource, data: await requestJson<WorldPlayerDetail & WorldSnapshotContext>(url) };
  return { resource, data: await requestJson<WorldPalDetail & WorldSnapshotContext>(url) };
}

function WorldSnapshotUtility({ status, message, reparseError, reparsing, onReparse }: { status: WorldStatus | null; message: string; reparseError: string; reparsing: boolean; onReparse: () => void }) {
  const presentation = presentWorldSnapshot(status);
  const [copied, setCopied] = useState(false);
  const errorIdentifier = presentation.errorIdentifier || reparseError || null;
  const sourceObservedAt = status?.sourceObservedAt ?? status?.observedAt;

  async function copyErrorIdentifier() {
    if (!errorIdentifier) return;
    try {
      await navigator.clipboard.writeText(errorIdentifier);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return <aside className="world-snapshot-utility" aria-live="polite">
    <details className={`world-snapshot-status ${presentation.tone}`} open={Boolean(errorIdentifier) || undefined}>
      <summary><span className="world-snapshot-state-icon">{presentation.tone === "loading" ? <RefreshCw className="spin" size={16} /> : <Database size={16} />}</span><strong>{presentation.label}</strong><small>{formatWorldTime(sourceObservedAt)}</small></summary>
      <div className="world-snapshot-popover"><header><strong>快照状态详情</strong><button className="icon-button bordered" type="button" aria-label="关闭快照状态" onClick={(event) => { const details = event.currentTarget.closest("details"); if (details) details.open = false; }}><X size={15} /></button></header><p>{presentation.summary}</p><dl><div><dt>存档记录</dt><dd>{formatWorldTime(sourceObservedAt)}</dd></div><div><dt>解析完成</dt><dd>{status?.parsedAt ? formatWorldTime(status.parsedAt) : "尚未完成"}</dd></div></dl><p><strong>影响：</strong>{presentation.impact}</p><p><strong>下一步：</strong>{presentation.nextStep}</p>{errorIdentifier && <div className="world-snapshot-error" role="alert"><span>错误标识</span><code>{errorIdentifier}</code><button className="world-copy-button" type="button" onClick={() => void copyErrorIdentifier()}>{copied ? "已复制" : "复制"}</button></div>}<p className="world-snapshot-boundary">重新解析只读取存档并生成派生缓存，不会修改真实 .sav。</p></div>
    </details>
    <button className="quiet-button world-reparse-button" type="button" disabled={reparsing || status?.parsing} onClick={onReparse}><RefreshCw className={reparsing ? "spin" : ""} size={16} />{reparsing || status?.parsing ? "正在解析" : "重新解析"}</button>
    {message && <p className="form-success world-snapshot-message" role="status">{message}</p>}
    {reparseError && <p className="form-error world-snapshot-message" role="alert">重新解析请求失败；请打开快照状态复制错误标识后检查连接或存档状态。</p>}
  </aside>;
}

function PlayerArchiveCard({ item, selected, onOpen }: { item: WorldPlayerListItem; selected: boolean; onOpen: (trigger: HTMLButtonElement) => void }) {
  const progress = playerProgressOf(item);
  const explorationPercent = playerProgressPercent(progress, "discoveredPalSpecies");
  const metrics: { label: string; field: WorldPlayerProgressField; icon: typeof Database; detail?: string }[] = [
    { label: "帕鲁图鉴", field: "discoveredPalSpecies", icon: PawPrint, detail: progress.values.capturedPals === undefined ? undefined : `累计捕获 ${progress.values.capturedPals.toLocaleString()} 只` },
    { label: "野外头目", field: "fieldBosses", icon: Trophy },
    { label: "高塔领袖", field: "towerBosses", icon: Crown },
    { label: "地下城", field: "dungeonClears", icon: Compass },
    { label: "海上油田", field: "oilRigClears", icon: Flame },
    { label: "巨鹫之像", field: "fastTravel", icon: MapPin },
  ];
  return <article className="world-player-card" data-selected={selected || undefined}>
    <header className="world-player-card-header"><span className="world-player-card-avatar">{playerInitial(item.name)}</span><div><span><h3>{item.name}</h3>{item.level !== null && <em>Lv.{item.level}</em>}</span><small className={`world-player-coverage ${progress.state}`}>{playerProgressCoverage(progress)}</small></div></header>
    <section className="world-player-exploration" aria-label={`${item.name}的探索进度`}>
      <header><span><Trophy size={16} />海岛探索成就</span><strong>{explorationPercent === null ? "图鉴探索率不可用" : `图鉴探索率 ${explorationPercent}%`}</strong></header>
      {explorationPercent !== null && <div className="world-player-progress" role="progressbar" aria-label="图鉴探索率" aria-valuemin={0} aria-valuemax={100} aria-valuenow={explorationPercent}><span style={{ width: `${explorationPercent}%` }} /></div>}
      <div className="world-player-progress-grid">{metrics.map((metric) => <PlayerProgressMetric progress={progress} {...metric} key={metric.field} />)}</div>
    </section>
    <dl className="world-player-metadata"><div><dt>所属公会</dt><dd>{item.guildName || (item.guildId ? "公会资料不可用" : "未加入公会")}</dd></div><div><dt>最后记录</dt><dd>{formatPlayerRecordedAt(item.lastRecordedAt)}</dd></div><div><dt>Player ID</dt><dd><code>{item.id}</code></dd></div></dl>
    <button className="world-player-detail-button" type="button" aria-current={selected ? "true" : undefined} onClick={(event) => onOpen(event.currentTarget)}><FileText size={16} />查看完整训练家档案</button>
  </article>;
}

function PlayerProgressMetric({ progress, label, field, icon: Icon, detail }: { progress: WorldPlayerProgress; label: string; field: WorldPlayerProgressField; icon: typeof Database; detail?: string }) {
  const value = playerProgressValue(progress, field);
  const total = playerProgressTotal(progress, field);
  return <span className="world-player-progress-item"><small>{label}<Icon size={13} /></small><strong>{value ?? "—"}{total !== null && <em> / {total.toLocaleString()}</em>}</strong><b>{detail || (value === null ? "数据不可用" : PLAYER_PROGRESS_LABELS[field])}</b></span>;
}

function CommunityPanel({ resource, result, loading, snapshotId, onOpenPal, onPage }: { resource: CommunityResource; result: WorldEntityListResponse | null; loading: boolean; snapshotId: string | null | undefined; onOpenPal: (id: string, trigger: HTMLButtonElement) => void; onPage: (page: number) => void }) {
  const Icon = resource === "guilds" ? Users : Building2;
  const title = resource === "guilds" ? "全服公会组织" : "据点分布与打工帕鲁";
  const items = result?.items || [];
  const panelPage = result?.page || 1;
  const totalPages = result?.total ? Math.ceil(result.total / result.pageSize) : 1;
  return <section className="world-community-panel" data-kind={resource} aria-labelledby={`world-community-${resource}-heading`}>
    <header><Icon size={16} /><h3 id={`world-community-${resource}-heading`}>{title} ({items.length})</h3></header>
    <div className={`world-community-card-grid ${loading ? "is-loading" : ""}`} aria-live="polite" aria-busy={loading}>
      {loading ? Array.from({ length: 2 }, (_, index) => <article className="world-community-card skeleton" aria-hidden="true" key={index}><span /><span /></article>) : items.length ? items.map((item) => <CommunityCard resource={resource} item={item as WorldGuildListItem | WorldBaseListItem} key={item.id} onOpenPal={onOpenPal} />) : <div className="world-empty-state"><Icon size={22} /><strong>{result ? `暂无${RESOURCE_LABELS[resource]}数据` : snapshotId ? `正在读取${RESOURCE_LABELS[resource]}数据` : "当前没有可用世界快照"}</strong><p>{result ? "当前存档快照中没有可显示的数据。" : snapshotId ? "解析成功后，实体会显示在这里。" : "完成只读解析后可浏览此工作区；错误状态会保留在快照控件中。"}</p></div>}
    </div>
    <WorldPagination result={result} page={panelPage} totalPages={totalPages} onPage={onPage} />
  </section>;
}

function CommunityCard({ resource, item, onOpenPal }: { resource: "guilds" | "bases"; item: WorldGuildListItem | WorldBaseListItem; onOpenPal: (id: string, trigger: HTMLButtonElement) => void }) {
  const guild = resource === "guilds" ? item as WorldGuildListItem : null;
  const base = resource === "bases" ? item as WorldBaseListItem : null;
  const association = base?.guildName || (base?.guildId ? "公会资料不可用" : "自由据点");
  const coordinates = base && [base.x, base.y, base.z].every((value) => typeof value === "number") ? `X: ${base.x}, Y: ${base.y}, Z: ${base.z}` : "坐标不可用";
  return <article className="world-community-card" data-kind={resource}>
    <header><div><h3>{item.name}</h3>{base && <p>{association}</p>}</div><span>{guild ? `${guild.memberCount.toLocaleString()} 成员 · ${guild.baseCount.toLocaleString()} 据点` : `${base?.workerCount.toLocaleString()} / ${base?.maxWorkerCount?.toLocaleString() ?? "—"} 打工帕鲁`}</span></header>
    <section className="world-community-card-content">
      {guild ? <><p>会长 / 管理员: <strong>{guild.adminPlayerName || "资料不可用"}</strong></p><div className="world-community-card-tags">{guild.members.map((member) => <span key={member.id}>{member.name}{member.level !== null ? ` (Lv.${member.level})` : ""}{member.role === "leader" && <> <Crown size={12} aria-label="会长" /></>}</span>)}</div></> : <><p className="world-community-card-location"><MapPin size={14} /><strong>{coordinates}</strong></p><div className="world-community-card-tags">{base?.workers.map((worker) => <button type="button" key={worker.id} onClick={(event) => { event.stopPropagation(); onOpenPal(worker.id, event.currentTarget); }}><PawPrint size={12} />{worker.nickname || resolvePal(worker).name}{worker.level !== null ? ` (Lv.${worker.level})` : ""}</button>)}</div></>}
    </section>
  </article>;
}

function WorldPagination({ result, page, totalPages, onPage }: { result: WorldEntityListResponse | null; page: number; totalPages: number; onPage: (page: number) => void }) {
  return <section className="audit-footer"><span>共 {result?.total || 0} 条，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages} onClick={() => onPage(page + 1)}><ChevronRight size={18} /></button></div></section>;
}

function WorldOverviewLobby({ status, onlinePlayerCount, onChooseResource, onShowInventory, onShowPals }: { status: WorldStatus | null; onlinePlayerCount: number | null; onChooseResource: (resource: PrimaryWorldResource) => void; onShowInventory: (context: InventoryContext) => void; onShowPals: (context: Omit<PalRosterContext, "token">) => void }) {
  const overview = status?.overview;
  const diagnosticsRef = useRef<HTMLDetailsElement | null>(null);
  const coverageIncomplete = status?.dataCoverage.state !== "complete" || status.stale || Boolean(status.errorCode);
  const completenessCount = (coverageIncomplete ? 1 : 0) + (overview?.actions.unknownPalMetadata ? 1 : 0) + (overview?.actions.careUnavailable ? 1 : 0);
  function showDiagnostics() {
    if (!diagnosticsRef.current) return;
    diagnosticsRef.current.open = true;
    diagnosticsRef.current.scrollIntoView({ block: "center" });
    diagnosticsRef.current.querySelector("summary")?.focus();
  }
  if (!overview) return <section className="world-overview-empty"><LayoutDashboard size={24} /><div><h2>总览等待可用快照</h2><p>成功完成一次只读解析后，这里会汇总资产规模与需要进一步查看的事项。</p></div></section>;
  const gameCalendar = formatWorldCalendar(status?.gameTimeTicks);
  const assetItems = [
    { label: "登记训练家", value: overview.assets.players.toLocaleString(), unit: "名", detail: onlinePlayerCount === null ? "在线人数当前不可用" : `当前在线 ${onlinePlayerCount.toLocaleString()} 名`, icon: Users, tone: "primary", action: () => onChooseResource("players") },
    { label: "帕鲁生态", value: overview.assets.pals.toLocaleString(), unit: "只", detail: `覆盖 ${overview.assets.palSpecies.toLocaleString()} 种帕鲁`, icon: PawPrint, tone: "success", action: () => onShowPals({ label: "全部帕鲁" }) },
    { label: "公会组织", value: overview.assets.guilds.toLocaleString(), unit: "个", detail: "成员与资产聚合", icon: Users, tone: "primary", action: () => onChooseResource("guilds") },
    { label: "建立据点", value: overview.assets.bases.toLocaleString(), unit: "个", detail: "按稳定 Base ID 关联", icon: Building2, tone: "warning", action: () => onChooseResource("bases") },
    { label: "全服物资", value: overview.assets.itemTypes.toLocaleString(), unit: "种", detail: `玩家、据点与公会合计 ${overview.assets.itemQuantity.toLocaleString()} 件`, icon: Boxes, tone: "danger", action: () => onShowInventory({ scope: "inventory", label: "持有库存" }) },
    { label: "游戏历法", ...gameCalendar, icon: History, tone: "success", action: showDiagnostics },
  ];
  const actionItems = [
    { label: "需要关注", value: overview.actions.attentionPals, icon: HeartPulse, tone: "danger", action: () => onShowPals({ care: "attention", label: "需要关注" }) },
    { label: "闪光帕鲁", value: overview.actions.luckyPals, icon: Sparkles, action: () => onShowPals({ marker: "lucky", label: "闪光帕鲁" }) },
    { label: "头目帕鲁", value: overview.actions.bossPals, icon: Crown, action: () => onShowPals({ marker: "boss", label: "头目帕鲁" }) },
    { label: "数据完整性", value: completenessCount, icon: CircleAlert, tone: completenessCount ? "warning" : "healthy", action: showDiagnostics },
  ];
  return <div className="world-overview-lobby">
    <header className="world-overview-heading"><div><h2>世界资产总览</h2><p>从登记训练家、帕鲁生态、公会、据点、物资与游戏历法六个维度查看当前世界快照。</p></div><span className={status?.stale ? "warning" : "healthy"}>{status?.stale ? "旧缓存可用" : "当前快照可用"}</span></header>
    <section className="world-overview-section" aria-labelledby="world-assets-heading"><div className="world-overview-section-title"><h3 id="world-assets-heading">资产规模</h3><p>物资只统计玩家背包、据点箱子和公会箱子，不计世界容器</p></div><div className="world-overview-assets">{assetItems.map(({ label, value, unit, detail, icon: Icon, tone, action }) => <button className={tone} type="button" key={label} onClick={action}><span className="world-overview-asset-copy"><strong>{label}</strong><Icon size={17} aria-hidden="true" /></span><span className="world-overview-asset-value"><b>{value}</b><em>{unit}</em></span><small className="world-overview-asset-detail">{detail}</small></button>)}</div><p className="world-overview-progress-note"><CircleAlert size={15} />全服平均探索度、累计捕获、地下城、高塔与油田战绩尚无完整快照聚合；不会用当前分页结果推算。</p></section>
    <section className="world-overview-section" aria-labelledby="world-actions-heading"><div className="world-overview-section-title"><h3 id="world-actions-heading">进一步查看</h3><p>保留有明确浏览价值的入口</p></div><div className="world-overview-actions">{actionItems.map(({ label, value, icon: Icon, tone, action }) => <button className={tone || ""} type="button" key={label} onClick={action}><span className="world-overview-action-icon"><Icon size={18} aria-hidden="true" /></span><span>{label}</span><strong>{value.toLocaleString()}</strong><small>点击查看</small></button>)}</div></section>
    <details ref={diagnosticsRef} className="world-overview-diagnostics"><summary tabIndex={-1}>技术诊断与数据覆盖</summary><dl><div><dt>Snapshot ID</dt><dd><code>{status?.snapshotId || "WORLD_CACHE_UNAVAILABLE"}</code></dd></div><div><dt>数据覆盖</dt><dd>{status?.dataCoverage.state === "complete" ? "完整" : "不可用"}</dd></div><div><dt>帕鲁元数据未收录</dt><dd>{overview.actions.unknownPalMetadata.toLocaleString()}</dd></div><div><dt>照护字段不可用</dt><dd>{overview.actions.careUnavailable.toLocaleString()}</dd></div><div><dt>解析耗时</dt><dd>{status?.parseDurationMs === null ? "不可用" : `${status?.parseDurationMs} ms`}</dd></div><div><dt>缓存大小</dt><dd>{status?.cacheSizeBytes === null ? "不可用" : `${Math.round((status?.cacheSizeBytes || 0) / 1024).toLocaleString()} KB`}</dd></div></dl></details>
  </div>;
}

function livePlayersFrom(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) {
    return data.every((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      ? data
      : null;
  }
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return livePlayersFrom((data as Record<string, unknown>).players);
  return null;
}

function formatWorldCalendar(ticks: number | null | undefined): { value: string; unit: string; detail: string } {
  if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks < 0) return { value: "—", unit: "", detail: "当前快照未提供游戏时钟" };
  const totalMinutes = Math.floor(ticks / 600_000_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor(totalMinutes % 1_440 / 60);
  const minutes = totalMinutes % 60;
  return { value: `Day ${days.toLocaleString()}`, unit: "", detail: `另 ${hours} 小时 ${minutes} 分` };
}

function WorldRequestFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <section className="world-request-failure" role="alert"><CircleAlert size={18} aria-hidden="true" /><div><strong>世界数据请求失败</strong><p>当前页面没有写入任何存档；请检查连接或快照状态后重试。</p><code>{error}</code></div><button className="quiet-button" type="button" onClick={onRetry}>重新尝试</button></section>;
}

type EntityDrawerProps = { detail: EntityDetail | null; loading: boolean; canGoBack: boolean; onClose: () => void; onNavigate: DetailNavigate; onShowInventory: (context: InventoryContext) => void; drawerRef?: { current: HTMLElement | null }; closeButtonRef?: { current: HTMLButtonElement | null }; modal?: boolean };

function EntityDrawer({ detail, loading, canGoBack, onClose, onNavigate, onShowInventory, drawerRef, closeButtonRef, modal = false }: EntityDrawerProps) {
  if (!detail) return <aside className="world-entity-drawer empty" aria-label="世界实体详情"><Database size={24} /><h2>{loading ? "正在读取详情..." : "选择一个实体"}</h2><p>选择训练家或帕鲁，查看属性和可用关联。</p></aside>;

  const { data, resource } = detail;
  if (resource === "pals") return <PalDetailModal data={data} onClose={onClose} panelRef={drawerRef} closeRef={closeButtonRef} ariaLabel="世界实体详情" />;
  return <aside ref={drawerRef} className={`world-entity-drawer${resource === "players" ? " world-player-profile-modal" : ""}`} data-resource={resource} role="dialog" aria-modal={modal} aria-label="世界实体详情">
    <header className="section-heading"><div className="world-drawer-title"><EntityMarker resource={resource} item={data} /><div><div className="world-entity-name"><h2>{entityName(data, resource)}</h2>{data.level !== null && <em className="world-player-profile-level">Lv.{data.level}</em>}</div><p><span className="world-detail-type">{RESOURCE_LABELS[resource]}</span>{playerProgressCoverage(playerProgressOf(data))}</p></div></div><button ref={closeButtonRef} className="icon-button bordered" type="button" title={canGoBack ? "返回上一详情" : "关闭详情"} aria-label={canGoBack ? "返回上一详情" : "关闭详情"} onClick={onClose}>{canGoBack ? <ArrowLeft size={18} /> : <X size={18} />}</button></header>
    <div className="world-detail-properties">
      {detail.resource === "players" && <PlayerDetail data={detail.data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
    </div>
  </aside>;
}

function EntityMarker({ resource, item }: { resource: EntityDetail["resource"]; item: WorldEntityListItem | WorldEntityDetailData }) {
  if (resource === "players") return <span className="world-entity-avatar world-player-avatar" aria-hidden="true">{playerInitial(entityName(item, resource))}</span>;
  if (resource === "pals" && "characterId" in item) {
    const pal = resolvePal(item);
    return <span className="world-entity-avatar world-pal-avatar" data-icon-key={pal.known ? pal.characterId : "pal-placeholder"} aria-hidden="true"><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span>;
  }
  return null;
}

function PalGenderIcon({ item }: { item: WorldPalListItem | (WorldPalDetail & WorldSnapshotContext) }) {
  const gender = resolvePal(item).gender;
  if (!gender) return null;
  const label = gender === "male" ? "雄性" : "雌性";
  return <span className={`world-pal-gender ${gender}`} title={label} aria-hidden="true">{gender === "male" ? "♂" : "♀"}</span>;
}

function PlayerDetail({ data, onNavigate, onShowInventory }: DetailProps<WorldPlayerDetail>) {
  const progress = playerProgressOf(data);
  const unavailable = playerProgressUnavailable(progress);
  return <>
    <section className="player-progress-identity">
      <PropertyGrid entries={[["等级", data.level], ["所属公会", data.guildName], ["最后记录时间", formatPlayerRecordedAt(data.lastRecordedAt)]]} />
    </section>
    <RelationButton title="所属公会" value={data.guild} />
    <section className={`player-progress-status ${progress.state}`} aria-label="训练家进度数据覆盖">
      <strong>{playerProgressCoverage(progress)}</strong>
      <p>{progress.state === "complete" ? "以下项目均来自这名训练家的只读存档快照。" : progress.state === "partial" ? "仅显示存档中可确认的项目；缺失项目不会补零。" : "当前世界角色存在，但没有可用的训练家存档进度；不会显示一组误导性的零值。"}</p>
      {progress.state === "partial" && <details><summary>查看不可用项目（{unavailable.length}）</summary><p>{unavailable.join("、")}</p></details>}
    </section>
    {progress.state !== "unavailable" && <div className="player-progress-groups">
      {PLAYER_PROGRESS_GROUPS.map((group) => {
        const available = group.fields.filter((field) => progress.values[field] !== undefined);
        if (!available.length) return null;
        return <section className="player-progress-group" key={group.title}><h3>{group.title}</h3><dl>{available.map((field) => <div key={field}><dt>{PLAYER_PROGRESS_LABELS[field]}</dt><dd>{playerProgressValue(progress, field)}</dd></div>)}</dl></section>;
      })}
    </div>}
    <RelationList title="拥有帕鲁" rows={data.pals} resource="pals" onNavigate={onNavigate} />
    <RelationList title="队伍帕鲁" rows={data.partyPals} resource="pals" onNavigate={onNavigate} />
    <RelationList title="储存帕鲁" rows={data.storagePals} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="玩家库存" data={data} onShowInventory={onShowInventory} />
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Player ID</dt><dd>{data.id}</dd></div><div><dt>Instance ID</dt><dd>{data.instanceId}</dd></div></dl></details>
  </>;
}

function EntityDetailLayer(props: EntityDrawerProps) {
  const isMobile = useIsMobile();
  const isPlayerModal = props.detail?.resource === "players";
  const isPalModal = props.detail?.resource === "pals";
  const isModal = isMobile || isPlayerModal || isPalModal;
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  useEffect(() => { onCloseRef.current = props.onClose; }, [props.onClose]);
  useEffect(() => {
    if (!props.detail) return;
    const appRoot = document.getElementById("root");
    const focusableSelector = "button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (!isModal || event.key !== "Tab") return;
      const focusable = Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    if (isModal && appRoot) appRoot.inert = true;
    window.addEventListener("keydown", onKeyDown);
    if (isModal) window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      if (isModal && appRoot) appRoot.inert = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isModal, props.detail]);
  const content = <>{props.detail && <button className={`world-drawer-backdrop${isPlayerModal ? " world-player-profile-backdrop" : ""}${isPalModal ? " pal-detail-backdrop" : ""}`} type="button" tabIndex={-1} aria-label="关闭详情遮罩" onClick={props.onClose} />}<EntityDrawer {...props} drawerRef={drawerRef} closeButtonRef={closeButtonRef} modal={isModal} /></>;
  return isModal && props.detail ? createPortal(content, document.body) : content;
}

function formatPlayerRecordedAt(value: unknown): string {
  if (typeof value !== "string" || !value) return "不可用";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "不可用" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

type DetailNavigate = (resource: EntityDetail["resource"], id: string) => void;
type DetailProps<T> = { data: T; onNavigate: DetailNavigate; onShowInventory: (context: InventoryContext) => void };

function PropertyGrid({ entries }: { entries: [string, string | number | null | undefined][] }) {
  return <dl className="world-detail-grid">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayValue(value)}</dd></div>)}</dl>;
}

function RelationButton({ title, value, resource, onNavigate }: { title: string; value: RelationshipItem | null; resource?: EntityDetail["resource"]; onNavigate?: DetailNavigate }) {
  return <section className="world-relation-section"><h3>{title}</h3>{value ? resource && onNavigate ? <button className="world-relation-link" type="button" onClick={() => onNavigate(resource, value.id)}>{entityName(value, resource)}<small>{value.id}</small></button> : <p>{entityName(value, "bases")}</p> : <p className="muted">未关联</p>}</section>;
}

function RelationList({ title, rows, resource, onNavigate }: { title: string; rows: RelationshipItem[]; resource: EntityDetail["resource"]; onNavigate: DetailNavigate }) {
  return <section className="world-relation-section"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div className="world-relation-list">{rows.map((item) => <button className="world-relation-link" type="button" key={item.id} onClick={() => onNavigate(resource, item.id)}><span className="world-relation-name">{entityName(item, resource)}{resource === "pals" && "characterId" in item && <PalGenderIcon item={item} />}</span><small>{item.id}</small></button>)}</div> : <p className="muted">暂无可关联数据</p>}</section>;
}

function InventoryButton({ title, data, onShowInventory }: { title: string; data: RelationshipItem; onShowInventory: (context: InventoryContext) => void }) {
  const id = data.id;
  const name = entityName(data, "players");
  return <section className="world-relation-section"><h3>{title}</h3><button className="world-relation-link" type="button" onClick={() => onShowInventory({ scope: "player", ownerId: id, label: `玩家库存：${name}` })}><span className="world-relation-name"><PackageOpen size={16} aria-hidden="true" />在仓库中查看</span><small>仅显示该稳定 ID 的关联范围</small></button></section>;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "不可用";
  if (typeof value === "object") return Array.isArray(value) ? `${value.length} 项` : "已关联";
  return String(value);
}

function entityName(data: RelationshipItem | WorldEntityListItem | WorldEntityDetailData, resource: PrimaryWorldResource): string {
  if (resource === "pals" && "characterId" in data) return resolvePal(data).displayName;
  return "name" in data && data.name ? data.name : data.id;
}
