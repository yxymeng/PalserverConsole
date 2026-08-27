import { AlertTriangle, Archive, ArrowLeft, Boxes, ChevronLeft, ChevronRight, CircleAlert, Crown, Database, HeartPulse, LayoutDashboard, PackageOpen, PawPrint, RefreshCw, Search, Sparkles, SlidersHorizontal, Users, Warehouse, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, LiveValue, WorldBaseDetail, WorldBaseListItem, WorldContainerReference, WorldEntityListItem, WorldEntityListResponse, WorldGuildDetail, WorldGuildListItem, WorldPalCareSummary, WorldPalDetail, WorldPalListItem, WorldPlayerDetail, WorldPlayerListItem, WorldReparseResponse, WorldSnapshotContext, WorldStatus } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { useIsMobile } from "../../hooks/use-mobile";
import { formatWorldTime, type PrimaryWorldResource, worldCell, worldColumns } from "./worldTable";
import { palTraitLabels, playerInitial, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { PalRoster, type PalRosterContext } from "./PalRoster";
import { InventoryWorkspace, type InventoryContext } from "./InventoryWorkspace";
import { PLAYER_PROGRESS_GROUPS, PLAYER_PROGRESS_LABELS, playerProgressCoverage, playerProgressOf, playerProgressUnavailable, playerProgressValue } from "./playerProgress";
import { presentWorldSnapshot } from "./worldSnapshotPresentation";
import { waitForWorldReparse } from "./worldReparse";
import { ensureWorldContract } from "./worldContract";

type EntityDetail =
  | { resource: "players"; data: WorldPlayerDetail & WorldSnapshotContext }
  | { resource: "pals"; data: WorldPalDetail & WorldSnapshotContext }
  | { resource: "guilds"; data: WorldGuildDetail & WorldSnapshotContext }
  | { resource: "bases"; data: WorldBaseDetail & WorldSnapshotContext };
type WorldEntityDetailData = EntityDetail["data"];
type RelationshipItem = WorldPlayerListItem | WorldPalListItem | WorldGuildListItem | WorldBaseListItem | WorldContainerReference;
type SortKey = "name" | "level-desc" | "count-desc" | "id";
type StatusFilter = "all" | "guilded" | "unguilded" | "active" | "empty";
type WorkspaceKey = "overview" | PrimaryWorldResource | "inventories";
type EntityBrowserSnapshot = { result: WorldEntityListResponse | null; page: number; search: string; appliedSearch: string; sortKey: SortKey; statusFilter: StatusFilter };

const WORKSPACES: { key: WorkspaceKey; label: string; icon: typeof Database; countKey?: keyof WorldStatus["counts"]; resource?: PrimaryWorldResource; planned?: boolean }[] = [
  { key: "overview", label: "总览", icon: LayoutDashboard },
  { key: "players", label: "玩家", icon: Users, countKey: "players", resource: "players" },
  { key: "pals", label: "帕鲁名册", icon: PawPrint, countKey: "pals", resource: "pals" },
  { key: "inventories", label: "仓库", icon: Archive, countKey: "inventory_items" },
  { key: "bases", label: "据点", icon: Warehouse, countKey: "bases", resource: "bases" },
  { key: "guilds", label: "公会", icon: Users, countKey: "guilds", resource: "guilds" },
];

const WORKSPACE_BY_RESOURCE: Record<PrimaryWorldResource, WorkspaceKey> = { players: "players", pals: "pals", guilds: "guilds", bases: "bases" };

const RESOURCE_LABELS: Record<PrimaryWorldResource, string> = {
  players: "玩家",
  pals: "帕鲁",
  guilds: "公会",
  bases: "据点",
};

const STATUS_OPTIONS: Record<Exclude<PrimaryWorldResource, "pals">, { value: StatusFilter; label: string }[]> = {
  players: [{ value: "all", label: "全部玩家" }, { value: "guilded", label: "已加入公会" }, { value: "unguilded", label: "未加入公会" }],
  guilds: [{ value: "all", label: "全部公会" }, { value: "active", label: "有成员或据点" }, { value: "empty", label: "空公会" }],
  bases: [{ value: "all", label: "全部据点" }, { value: "guilded", label: "已归属公会" }, { value: "unguilded", label: "未归属公会" }],
};

const SORT_OPTIONS: Record<Exclude<PrimaryWorldResource, "pals">, { value: SortKey; label: string }[]> = {
  players: [{ value: "name", label: "名称" }, { value: "level-desc", label: "等级（高到低）" }, { value: "id", label: "稳定 ID" }],
  guilds: [{ value: "name", label: "名称" }, { value: "count-desc", label: "成员数量（多到少）" }, { value: "id", label: "稳定 ID" }],
  bases: [{ value: "name", label: "名称" }, { value: "id", label: "稳定 ID" }],
};

export function WorldDataPage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<WorldStatus | null>(null);
  const [onlinePlayerCount, setOnlinePlayerCount] = useState<number | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceKey>("overview");
  const [resource, setResource] = useState<PrimaryWorldResource>("players");
  const [inventoryContext, setInventoryContext] = useState<InventoryContext>({ scope: "inventory" });
  const [palContext, setPalContext] = useState<PalRosterContext>({ token: 0 });
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Set<WorkspaceKey>>(() => new Set(["overview"]));
  const [workspaceHistory, setWorkspaceHistory] = useState<{ workspace: WorkspaceKey; detail: EntityDetail | null }[]>([]);
  const [result, setResult] = useState<WorldEntityListResponse | null>(null);
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
    const hasEntityBrowser = workspace !== "overview" && workspace !== "inventories" && resource !== "pals";
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
        const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
        if (appliedSearch) query.set("search", appliedSearch);
        if (statusFilter !== "all") query.set("status", statusFilter);
        query.set("sort", sortKey);
        if (nextStatus.snapshotId) query.set("snapshotId", nextStatus.snapshotId);
        try {
          const nextResult = await requestJson<WorldEntityListResponse>(`/api/world/${resource}?${query}`, { signal });
          if (nextResult.snapshotId !== nextStatus.snapshotId) continue;
          setResult(nextResult);
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
    const controller = new AbortController();
    void requestJson<LiveValue<unknown>>("/api/live/players", { signal: controller.signal })
      .then((response) => {
        setOnlinePlayerCount(
          response.stale || response.errorCode
            ? null
            : livePlayersFrom(response.data).length,
        );
      })
      .catch((caught) => { if (!isAbortError(caught)) setOnlinePlayerCount(null); });
    return () => controller.abort();
  }, [workspace, snapshotId]);
  useEffect(() => {
    if (previousSnapshotId.current !== undefined && previousSnapshotId.current !== snapshotId) {
      entityStateCache.current = {};
      scrollPositions.current = {};
      setWorkspaceHistory([]);
      setDetailHistory([]);
      setSelected(null);
      setResult(null);
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
    if (workspace === "players" || workspace === "bases" || workspace === "guilds") {
      entityStateCache.current[resource] = { result, page, search, appliedSearch, sortKey, statusFilter };
    }
  }

  function activateWorkspace(next: WorkspaceKey, pushHistory = false) {
    saveEntityBrowser();
    scrollPositions.current[workspace] = window.scrollY;
    if (pushHistory && next !== workspace) setWorkspaceHistory((current) => [...current, { workspace, detail: selected }]);
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
    if (entry.workspace === "players" || entry.workspace === "bases" || entry.workspace === "guilds") chooseResource(entry.workspace);
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

  const openDetail = useCallback(async (nextResource: PrimaryWorldResource, id: string, preserveCurrent = false, trigger?: HTMLElement) => {
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
  const columns = worldColumns(resource);
  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch) || statusFilter !== "all" || sortKey !== "name";

  return <div className="page-stack world-page">
    <WorldSnapshotBar status={status} message={message} reparseError={reparseError} reparsing={reparsing} onReparse={() => void reparse()} />
    {error && <WorldRequestFailure error={error} onRetry={() => void load()} />}
    <div className="world-tabs world-workspace-tabs" role="tablist" aria-label="世界资产工作区">
      {WORKSPACES.map(({ key, label, icon: Icon, countKey }) => <button key={key} className={workspace === key ? "active" : ""} type="button" role="tab" id={`world-workspace-tab-${key}`} aria-selected={workspace === key} aria-controls={`world-workspace-${key}`} onClick={() => chooseWorkspace(key)}><Icon size={17} /><span>{label}</span>{countKey && <strong>{status?.counts[countKey] ?? "-"}</strong>}</button>)}
    </div>
    {workspaceHistory.length > 0 && <button className="world-context-return" type="button" onClick={returnWorkspace}><ArrowLeft size={16} />返回{WORKSPACES.find((item) => item.key === workspaceHistory.at(-1)?.workspace)?.label || "上一处"}<span>保留原筛选、结果与详情上下文</span></button>}
    <main className="world-workspace">
      <section id="world-workspace-overview" role="tabpanel" aria-labelledby="world-workspace-tab-overview" hidden={workspace !== "overview"}><WorldOverviewLobby status={status} onlinePlayerCount={onlinePlayerCount} onChooseResource={(target) => chooseResource(target, true)} onShowInventory={(context) => openInventory(context, true)} onShowPals={openPalSummary} /></section>
      <section id="world-workspace-inventories" role="tabpanel" aria-labelledby="world-workspace-tab-inventories" hidden={workspace !== "inventories"}>{visitedWorkspaces.has("inventories") && <InventoryWorkspace key={snapshotId || "none"} snapshotId={snapshotId} context={inventoryContext} onSnapshotReplaced={refreshSnapshot} onContextChange={setInventoryContext} onClearContext={() => setInventoryContext({ scope: "inventory" })} />}</section>
      <section id="world-workspace-pals" role="tabpanel" aria-labelledby="world-workspace-tab-pals" hidden={workspace !== "pals"}>{visitedWorkspaces.has("pals") && <PalRoster key={snapshotId || "none"} snapshotId={snapshotId} context={palContext} onSnapshotReplaced={refreshSnapshot} onNavigate={(target, id) => void openDetail(target, id, true)} />}</section>
      {(["players", "bases", "guilds"] as const).map((panel) => <section key={panel} id={`world-workspace-${panel}`} role="tabpanel" aria-labelledby={`world-workspace-tab-${panel}`} hidden={workspace !== panel}>{workspace === panel && <div className="world-browser" data-has-detail={Boolean(selected) || undefined}>
      <header className="world-module-heading world-browser-heading">
        <div><p className="world-module-kicker">{panel === "players" ? "角色与进度" : panel === "bases" ? "生产与归属" : "成员与聚合资产"}</p><h2>{RESOURCE_LABELS[panel]}</h2><p>{panel === "players" ? "查看角色等级、公会关系与可用的世界进度；缺失字段不会显示为零。" : panel === "bases" ? "按稳定 Base ID 查看工作帕鲁、照护状态与据点库存。" : "按稳定 Guild ID 查看成员、据点、帕鲁与仓库的聚合关系。"}</p></div>
        <span className="world-module-total">{result ? `共 ${result.total.toLocaleString()} ${panel === "players" ? "名玩家" : panel === "bases" ? "个据点" : "个公会"}` : "等待快照"}</span>
      </header>
      <section className="world-list-panel" aria-label={`${RESOURCE_LABELS[resource]}列表`}>
        <form className="world-toolbar" onSubmit={submitSearch}>
          <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索世界数据" placeholder="搜索名称或稳定 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
          <button className="primary-button world-search-button" type="submit">搜索</button>
          <label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>状态</span><select aria-label="状态筛选" value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value as StatusFilter); }}>{STATUS_OPTIONS[resource as Exclude<PrimaryWorldResource, "pals">].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          <label className="world-control"><span>排序</span><select aria-label="排序方式" value={sortKey} onChange={(event) => { setPage(1); setSortKey(event.target.value as SortKey); }}>{SORT_OPTIONS[resource as Exclude<PrimaryWorldResource, "pals">].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
          {hasFilters && <button className="world-clear-button" type="button" aria-label="清除筛选条件" onClick={clearFilters}><X size={15} />清除</button>}
          <span className="world-result-count">当前 {displayedItems.length} 条</span>
        </form>
        {message && <p className="form-success" role="status">{message}</p>}
        <section className={`world-table world-table-${resource} ${showListLoading ? "is-loading" : ""}`} aria-live="polite" aria-busy={listLoading}>
          <div className="world-table-head" style={{ "--world-columns": columns.length } as CSSProperties}>{columns.map((column) => <span key={column.key}>{column.label}</span>)}</div>
          {showListLoading ? <WorldTableSkeleton columns={columns.length} /> : displayedItems.length ? displayedItems.map((item, index) => {
            const isSelected = selected?.resource === resource && String(selected.data.id) === String(item.id);
            return <div className="world-table-row" data-selected={isSelected || undefined} style={{ "--world-columns": columns.length } as CSSProperties} key={String(item.id || `${resource}-${index}`)}>{columns.map((column, columnIndex) => {
            const cell = worldCell(item, column.key);
            const palGender = resource === "pals" && column.key === "displayName" ? genderLabel(item) : null;
            return <span key={column.key} data-key={column.key} data-label={column.label} title={cell}>{columnIndex === 0 && item.id ? <button className="world-link world-entity-link" type="button" aria-label={`${cell}${palGender ? `，${palGender}` : ""}`} aria-current={isSelected ? "true" : undefined} onClick={(event) => void openDetail(resource, String(item.id), false, event.currentTarget)}><EntityMarker resource={resource} item={item} /><span className="world-entity-label">{cell}</span>{resource === "pals" && "characterId" in item && <PalGenderIcon item={item} />}</button> : cell}</span>;
          })}</div>;
          }) : <div className="world-empty-state"><Database size={22} /><strong>{result ? hasFilters ? "没有符合条件的数据" : `暂无${RESOURCE_LABELS[resource]}数据` : snapshotId ? "正在读取世界数据" : "当前没有可用世界快照"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : snapshotId ? "解析成功后，实体会显示在这里。" : "完成只读解析后可浏览此工作区；错误状态会保留在快照条中。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
        </section>
        <section className="audit-footer"><span>共 {result?.total || 0} 条，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></section>
      </section>
      </div>}</section>)}
    </main>
    {(selected || workspace === "players" || workspace === "bases" || workspace === "guilds") && <EntityDetailLayer detail={selected} loading={detailLoading} canGoBack={detailHistory.length > 0} onClose={closeDetail} onNavigate={(target, id) => void openDetail(target, id, true)} onShowInventory={openInventory} />}
  </div>;
}

async function loadEntityDetail(resource: PrimaryWorldResource, id: string, snapshotId: string | null | undefined): Promise<EntityDetail> {
  const suffix = snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : "";
  const url = `/api/world/${resource}/${encodeURIComponent(id)}${suffix}`;
  if (resource === "players") return { resource, data: await requestJson<WorldPlayerDetail & WorldSnapshotContext>(url) };
  if (resource === "pals") return { resource, data: await requestJson<WorldPalDetail & WorldSnapshotContext>(url) };
  if (resource === "guilds") return { resource, data: await requestJson<WorldGuildDetail & WorldSnapshotContext>(url) };
  return { resource, data: await requestJson<WorldBaseDetail & WorldSnapshotContext>(url) };
}

function WorldSnapshotBar({ status, message, reparseError, reparsing, onReparse }: { status: WorldStatus | null; message: string; reparseError: string; reparsing: boolean; onReparse: () => void }) {
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

  return <section className={`world-status world-snapshot-bar ${presentation.tone}`} aria-live="polite">
    <div className="status-icon">{presentation.tone === "loading" ? <RefreshCw className="spin" size={23} /> : <Database size={23} />}</div>
    <div className="world-snapshot-summary"><h2>{presentation.label}</h2><p>{presentation.summary}</p></div>
    <div className="world-snapshot-times"><span><small>存档记录</small><strong>{formatWorldTime(sourceObservedAt)}</strong></span><span><small>解析完成</small><strong>{status?.parsedAt ? formatWorldTime(status.parsedAt) : "尚未完成"}</strong></span></div>
    <button className="quiet-button" type="button" disabled={reparsing || status?.parsing} onClick={onReparse}><RefreshCw className={reparsing ? "spin" : ""} size={17} />{reparsing || status?.parsing ? "正在解析" : "重新解析"}</button>
    <div className="world-snapshot-guidance"><p><strong>影响：</strong>{presentation.impact}</p><p><strong>下一步：</strong>{presentation.nextStep}</p></div>
    {errorIdentifier && <div className="world-snapshot-error" role="alert"><span>错误标识</span><code>{errorIdentifier}</code><button className="world-copy-button" type="button" onClick={() => void copyErrorIdentifier()}>{copied ? "已复制" : "复制"}</button></div>}
    {message && <p className="form-success world-snapshot-message" role="status">{message}</p>}
    {reparseError && <p className="form-error world-snapshot-message" role="alert">重新解析请求失败；请复制错误标识后检查连接或存档状态。</p>}
    <p className="world-snapshot-boundary">重新解析只读取存档并生成派生缓存，不会修改真实 .sav。</p>
  </section>;
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
  const assetItems = [
    { label: "玩家", value: `${onlinePlayerCount === null ? "—" : onlinePlayerCount.toLocaleString()} / ${overview.assets.players.toLocaleString()}`, unit: "名", detail: "在线 / 全部玩家", icon: Users, action: () => onChooseResource("players") },
    { label: "帕鲁", value: overview.assets.pals.toLocaleString(), unit: "只", detail: `${overview.assets.palSpecies.toLocaleString()} 种帕鲁`, icon: PawPrint, action: () => onShowPals({ label: "全部帕鲁" }) },
    { label: "仓库物品", value: overview.assets.itemTypes.toLocaleString(), unit: "种", detail: `玩家、据点与公会合计 ${overview.assets.itemQuantity.toLocaleString()} 件`, icon: Boxes, action: () => onShowInventory({ scope: "inventory", label: "持有库存" }) },
    { label: "据点", value: overview.assets.bases.toLocaleString(), unit: "个", detail: "按 Base ID 关联", icon: Warehouse, action: () => onChooseResource("bases") },
    { label: "公会", value: overview.assets.guilds.toLocaleString(), unit: "个", detail: "成员与资产聚合", icon: Users, action: () => onChooseResource("guilds") },
  ];
  const actionItems = [
    { label: "需要关注", value: overview.actions.attentionPals, icon: HeartPulse, tone: "danger", action: () => onShowPals({ care: "attention", label: "需要关注" }) },
    { label: "闪光帕鲁", value: overview.actions.luckyPals, icon: Sparkles, action: () => onShowPals({ marker: "lucky", label: "闪光帕鲁" }) },
    { label: "头目帕鲁", value: overview.actions.bossPals, icon: Crown, action: () => onShowPals({ marker: "boss", label: "头目帕鲁" }) },
    { label: "数据完整性", value: completenessCount, icon: CircleAlert, tone: completenessCount ? "warning" : "healthy", action: showDiagnostics },
  ];
  return <div className="world-overview-lobby">
    <header className="world-overview-heading"><div><p className="world-module-kicker">只读存档快照</p><h2>世界资产总览</h2><p>关键规模直接标明计量单位；点击任一指标可进入对应工作区。</p></div><span className={status?.stale ? "warning" : "healthy"}>{status?.stale ? "旧缓存可用" : "当前快照可用"}</span></header>
    <section className="world-overview-section" aria-labelledby="world-assets-heading"><div className="world-overview-section-title"><h3 id="world-assets-heading">资产规模</h3><p>仓库只统计玩家背包、据点箱子和公会箱子，不计世界容器</p></div><div className="world-overview-assets">{assetItems.map(({ label, value, unit, detail, icon: Icon, action }) => <button type="button" key={label} onClick={action}><span className="world-overview-asset-icon"><Icon size={19} aria-hidden="true" /></span><span className="world-overview-asset-copy"><strong>{label}</strong><small>{detail}</small></span><span className="world-overview-asset-value"><b>{value}</b><em>{unit}</em></span></button>)}</div></section>
    <section className="world-overview-section" aria-labelledby="world-actions-heading"><div className="world-overview-section-title"><h3 id="world-actions-heading">进一步查看</h3><p>保留有明确浏览价值的入口</p></div><div className="world-overview-actions">{actionItems.map(({ label, value, icon: Icon, tone, action }) => <button className={tone || ""} type="button" key={label} onClick={action}><span className="world-overview-action-icon"><Icon size={18} aria-hidden="true" /></span><span>{label}</span><strong>{value.toLocaleString()}</strong><small>点击查看</small></button>)}</div></section>
    <details ref={diagnosticsRef} className="world-overview-diagnostics"><summary tabIndex={-1}>技术诊断与数据覆盖</summary><dl><div><dt>Snapshot ID</dt><dd><code>{status?.snapshotId || "WORLD_CACHE_UNAVAILABLE"}</code></dd></div><div><dt>数据覆盖</dt><dd>{status?.dataCoverage.state === "complete" ? "完整" : "不可用"}</dd></div><div><dt>帕鲁元数据未收录</dt><dd>{overview.actions.unknownPalMetadata.toLocaleString()}</dd></div><div><dt>照护字段不可用</dt><dd>{overview.actions.careUnavailable.toLocaleString()}</dd></div><div><dt>解析耗时</dt><dd>{status?.parseDurationMs === null ? "不可用" : `${status?.parseDurationMs} ms`}</dd></div><div><dt>缓存大小</dt><dd>{status?.cacheSizeBytes === null ? "不可用" : `${Math.round((status?.cacheSizeBytes || 0) / 1024).toLocaleString()} KB`}</dd></div></dl></details>
  </div>;
}

function livePlayersFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return livePlayersFrom((data as Record<string, unknown>).players);
  return [];
}

function WorldTableSkeleton({ columns }: { columns: number }) {
  return <div className="world-table-skeleton" aria-hidden="true">{Array.from({ length: 5 }, (_, row) => <div className="world-table-row" style={{ "--world-columns": columns } as CSSProperties} key={row}>{Array.from({ length: columns }, (_, column) => <span className="world-skeleton-line" key={column} />)}</div>)}</div>;
}

function WorldRequestFailure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <section className="world-request-failure" role="alert"><CircleAlert size={18} aria-hidden="true" /><div><strong>世界数据请求失败</strong><p>当前页面没有写入任何存档；请检查连接或快照状态后重试。</p><code>{error}</code></div><button className="quiet-button" type="button" onClick={onRetry}>重新尝试</button></section>;
}

type EntityDrawerProps = { detail: EntityDetail | null; loading: boolean; canGoBack: boolean; onClose: () => void; onNavigate: (resource: PrimaryWorldResource, id: string) => void; onShowInventory: (context: InventoryContext) => void; drawerRef?: { current: HTMLElement | null }; closeButtonRef?: { current: HTMLButtonElement | null }; modal?: boolean };

function EntityDrawer({ detail, loading, canGoBack, onClose, onNavigate, onShowInventory, drawerRef, closeButtonRef, modal = false }: EntityDrawerProps) {
  if (!detail) return <aside className="world-entity-drawer empty" aria-label="世界实体详情"><Database size={24} /><h2>{loading ? "正在读取详情..." : "选择一个实体"}</h2><p>从左侧列表选择玩家、帕鲁、公会或据点，查看属性和可用关联。</p></aside>;

  const { data, resource } = detail;
  return <aside ref={drawerRef} className="world-entity-drawer" role="dialog" aria-modal={modal} aria-label="世界实体详情">
    <header className="section-heading"><div className="world-drawer-title"><EntityMarker resource={resource} item={data} /><div><div className="world-entity-name"><h2>{entityName(data, resource)}</h2>{detail.resource === "pals" && <PalGenderIcon item={detail.data} />}</div><p><span className="world-detail-type">{RESOURCE_LABELS[resource]}</span>{detail.resource === "players" ? playerProgressCoverage(playerProgressOf(detail.data)) : <span className="world-detail-id"><small>{resource === "bases" ? "Base ID" : resource === "guilds" ? "Guild ID" : "Pal ID"}</small>{data.id}</span>}</p></div></div><button ref={closeButtonRef} className="icon-button bordered" type="button" title={canGoBack ? "返回上一详情" : "关闭详情"} aria-label={canGoBack ? "返回上一详情" : "关闭详情"} onClick={onClose}>{canGoBack ? <ArrowLeft size={18} /> : <X size={18} />}</button></header>
    <div className="world-detail-properties">
      {detail.resource === "players" && <PlayerDetail data={detail.data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
      {detail.resource === "pals" && <PalDetail data={detail.data} onNavigate={onNavigate} />}
      {detail.resource === "guilds" && <GuildDetail data={detail.data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
      {detail.resource === "bases" && <BaseDetail data={detail.data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
    </div>
  </aside>;
}

function EntityMarker({ resource, item }: { resource: PrimaryWorldResource; item: WorldEntityListItem | WorldEntityDetailData }) {
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

function genderLabel(item: WorldEntityListItem): string | null {
  if (!("characterId" in item)) return null;
  const gender = resolvePal(item).gender;
  return gender === "male" ? "雄性" : gender === "female" ? "雌性" : null;
}

function PlayerDetail({ data, onNavigate, onShowInventory }: DetailProps<WorldPlayerDetail>) {
  const progress = playerProgressOf(data);
  const unavailable = playerProgressUnavailable(progress);
  return <>
    <section className="player-progress-identity">
      <PropertyGrid entries={[["等级", data.level], ["所属公会", data.guildName], ["最后记录时间", formatPlayerRecordedAt(data.lastRecordedAt)]]} />
    </section>
    <RelationButton title="所属公会" value={data.guild} resource="guilds" onNavigate={onNavigate} />
    <section className={`player-progress-status ${progress.state}`} aria-label="玩家进度数据覆盖">
      <strong>{playerProgressCoverage(progress)}</strong>
      <p>{progress.state === "complete" ? "以下项目均来自这名玩家的只读存档快照。" : progress.state === "partial" ? "仅显示存档中可确认的项目；缺失项目不会补零。" : "当前世界角色存在，但没有可用的玩家存档进度；不会显示一组误导性的零值。"}</p>
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
    <InventoryButton title="玩家库存" data={data} scope="player" onShowInventory={onShowInventory} />
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Player ID</dt><dd>{data.id}</dd></div><div><dt>Instance ID</dt><dd>{data.instanceId}</dd></div></dl></details>
  </>;
}

function EntityDetailLayer(props: EntityDrawerProps) {
  const isMobile = useIsMobile();
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
      if (!isMobile || event.key !== "Tab") return;
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
    if (isMobile && appRoot) appRoot.inert = true;
    window.addEventListener("keydown", onKeyDown);
    if (isMobile) window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      if (isMobile && appRoot) appRoot.inert = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isMobile, props.detail]);
  const content = <>{props.detail && <button className="world-drawer-backdrop" type="button" tabIndex={-1} aria-label="关闭详情遮罩" onClick={props.onClose} />}<EntityDrawer {...props} drawerRef={drawerRef} closeButtonRef={closeButtonRef} modal={isMobile} /></>;
  return isMobile && props.detail ? createPortal(content, document.body) : content;
}

function formatPlayerRecordedAt(value: unknown): string {
  if (typeof value !== "string" || !value) return "不可用";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "不可用" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function PalDetail({ data, onNavigate }: { data: WorldPalDetail; onNavigate: DetailNavigate }) {
  const pal = resolvePal(data);
  const traitSummary = palTraitLabels(data).join(" · ") || "普通";
  return <>
    <PropertyGrid entries={[["名称", pal.displayName], ["种族", pal.speciesName], ["属性", traitSummary], ["Character ID", data.characterId], ["等级", data.level], ["Container", data.containerId], ["Slot", data.slotIndex], ["工作状态", data.assignment]]} />
    <RelationButton title="主人" value={data.owner} resource="players" onNavigate={onNavigate} />
    <RelationButton title="据点" value={data.base} resource="bases" onNavigate={onNavigate} />
    <RelationButton title="容器" value={data.container} />
  </>;
}

function GuildDetail({ data, onNavigate, onShowInventory }: DetailProps<WorldGuildDetail>) {
  const { assetSummary: summary, missingMemberIds: missingMembers, missingBaseIds: missingBases } = data;
  const inventory = summary.inventory;
  return <>
    <AssetSummary title="公会资产规模" items={[["成员", summary.memberCount], ["据点", summary.baseCount], ["帕鲁", summary.palCount], ["物品种类", inventory.itemTypeCount], ["物品总量", inventory.totalQuantity]]} />
    <RelationList title="成员" rows={data.members} resource="players" onNavigate={onNavigate} />
    <RelationList title="关联据点" rows={data.bases} resource="bases" onNavigate={onNavigate} />
    <RelationList title="关联帕鲁" rows={data.pals} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="公会关联仓库" data={data} scope="guild" onShowInventory={onShowInventory} />
    {(missingMembers.length > 0 || missingBases.length > 0) && <section className="world-association-warning" role="status"><AlertTriangle size={17} aria-hidden="true" /><div><strong>部分关联资料不可用</strong><p>当前缓存中没有对应实体；以下稳定 ID 原样保留，未创建猜测关系。</p>{missingMembers.length > 0 && <MissingIdList label="缺失成员 ID" ids={missingMembers} />}{missingBases.length > 0 && <MissingIdList label="缺失据点 ID" ids={missingBases} />}</div></section>}
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Guild ID</dt><dd>{data.id}</dd></div></dl></details>
  </>;
}

function BaseDetail({ data, onNavigate, onShowInventory }: DetailProps<WorldBaseDetail>) {
  const { guildAssociation: association, careSummary: care, inventorySummary: inventory } = data;
  return <>
    <PropertyGrid entries={[["坐标", coordinateLabel(data)], ["工作帕鲁", data.workerCount], ["物品种类", inventory.itemTypeCount], ["物品总量", inventory.totalQuantity]]} />
    <BaseGuildRelation data={data} association={association} onNavigate={onNavigate} />
    <CareSummary summary={care} />
    <RelationList title="工作帕鲁" rows={data.workers} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="据点库存" data={data} scope="base" onShowInventory={onShowInventory} />
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Base ID</dt><dd>{data.id}</dd></div><div><dt>Worker Container ID</dt><dd>{displayValue(data.workerContainerId)}</dd></div></dl></details>
  </>;
}

type DetailNavigate = (resource: PrimaryWorldResource, id: string) => void;
type DetailProps<T> = { data: T; onNavigate: DetailNavigate; onShowInventory: (context: InventoryContext) => void };

function AssetSummary({ title, items }: { title: string; items: [string, number | null][] }) {
  return <section className="world-asset-summary"><h3>{title}</h3><dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null ? "不可用" : value.toLocaleString()}</dd></div>)}</dl></section>;
}

function MissingIdList({ label, ids }: { label: string; ids: string[] }) {
  return <div className="world-missing-ids"><span>{label}</span>{ids.map((id) => <code key={id}>{id}</code>)}</div>;
}

function BaseGuildRelation({ data, association, onNavigate }: { data: WorldBaseDetail; association: WorldBaseDetail["guildAssociation"]; onNavigate: DetailNavigate }) {
  const guild = data.guild;
  if (association === "linked" && guild?.id) return <RelationButton title="所属公会" value={guild} resource="guilds" onNavigate={onNavigate} />;
  if (association === "unavailable") return <section className="world-relation-section"><h3>所属公会</h3><p className="world-association-unavailable">关联资料不可用</p><code className="world-stable-id">{displayValue(data.guildId)}</code></section>;
  return <section className="world-relation-section"><h3>所属公会</h3><p className="muted">未分配</p></section>;
}

function CareSummary({ summary }: { summary: WorldPalCareSummary }) {
  const { total, critical, warning, attention, unavailable } = summary;
  const tone = attention > 0 ? "attention" : unavailable ? "unavailable" : "healthy";
  const label = total === 0 ? "暂无工作帕鲁" : attention > 0 ? `${attention} 只需要关注` : unavailable ? "部分照护数据不可用" : "未见需要关注";
  return <section className={`base-care-summary ${tone}`} aria-label="工作帕鲁照护摘要"><header><HeartPulse size={18} aria-hidden="true" /><div><h3>照护摘要</h3><p>{label}</p></div></header><dl><div><dt>需立即处理</dt><dd>{critical ?? "-"}</dd></div><div><dt>需要关注</dt><dd>{warning ?? "-"}</dd></div><div><dt>数据不可用</dt><dd>{unavailable ?? "-"}</dd></div></dl><small>与帕鲁名册“需要关注”使用同一存档快照规则。</small></section>;
}

function PropertyGrid({ entries }: { entries: [string, string | number | null | undefined][] }) {
  return <dl className="world-detail-grid">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayValue(value)}</dd></div>)}</dl>;
}

function RelationButton({ title, value, resource, onNavigate }: { title: string; value: RelationshipItem | null; resource?: PrimaryWorldResource; onNavigate?: DetailNavigate }) {
  return <section className="world-relation-section"><h3>{title}</h3>{value ? resource && onNavigate ? <button className="world-relation-link" type="button" onClick={() => onNavigate(resource, value.id)}>{entityName(value, resource)}<small>{value.id}</small></button> : <p>{entityName(value, "bases")}</p> : <p className="muted">未关联</p>}</section>;
}

function RelationList({ title, rows, resource, onNavigate }: { title: string; rows: RelationshipItem[]; resource: PrimaryWorldResource; onNavigate: DetailNavigate }) {
  return <section className="world-relation-section"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div className="world-relation-list">{rows.map((item) => <button className="world-relation-link" type="button" key={item.id} onClick={() => onNavigate(resource, item.id)}><span className="world-relation-name">{entityName(item, resource)}{resource === "pals" && "characterId" in item && <PalGenderIcon item={item} />}</span><small>{item.id}</small></button>)}</div> : <p className="muted">暂无可关联数据</p>}</section>;
}

function InventoryButton({ title, data, scope, onShowInventory }: { title: string; data: RelationshipItem; scope: "player" | "base" | "guild"; onShowInventory: (context: InventoryContext) => void }) {
  const id = data.id;
  const resource = scope === "player" ? "players" : scope === "base" ? "bases" : "guilds";
  const name = entityName(data, resource);
  const context = scope === "player" ? { scope, ownerId: id } : scope === "base" ? { scope, baseId: id } : { scope: "inventory" as const, guildId: id };
  const label = `${scope === "player" ? "玩家库存" : scope === "base" ? "据点库存" : "公会关联仓库"}：${name}`;
  return <section className="world-relation-section"><h3>{title}</h3><button className="world-relation-link" type="button" onClick={() => onShowInventory({ ...context, label })}><span className="world-relation-name"><PackageOpen size={16} aria-hidden="true" />在仓库中查看</span><small>仅显示该稳定 ID 的关联范围</small></button></section>;
}

function coordinateLabel(data: WorldBaseDetail): string {
  const values = [data.x, data.y, data.z];
  return values.every((value) => value !== null) ? values.map((value) => Math.round(value as number).toLocaleString()).join(" / ") : "数据不可用";
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
