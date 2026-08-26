import { AlertTriangle, Archive, ArrowLeft, Boxes, ChevronLeft, ChevronRight, CircleAlert, Crown, Database, HeartPulse, LayoutDashboard, PackageOpen, PawPrint, RefreshCw, Search, Sparkles, SlidersHorizontal, Users, Warehouse, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, WorldReparseResponse, WorldResponse, WorldRow, WorldStatus } from "../../api/contracts";
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

type EntityDetail = { resource: PrimaryWorldResource; data: WorldRow };
type SortKey = "name" | "level-desc" | "count-desc" | "id";
type StatusFilter = "all" | "guilded" | "unguilded" | "active" | "empty";
type WorkspaceKey = "overview" | PrimaryWorldResource | "inventories";
type EntityBrowserSnapshot = { result: WorldResponse | null; page: number; search: string; appliedSearch: string; sortKey: SortKey; statusFilter: StatusFilter };

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
  const [workspace, setWorkspace] = useState<WorkspaceKey>("overview");
  const [resource, setResource] = useState<PrimaryWorldResource>("players");
  const [inventoryContext, setInventoryContext] = useState<InventoryContext>({ scope: "inventory" });
  const [palContext, setPalContext] = useState<PalRosterContext>({ token: 0 });
  const [visitedWorkspaces, setVisitedWorkspaces] = useState<Set<WorkspaceKey>>(() => new Set(["overview"]));
  const [workspaceHistory, setWorkspaceHistory] = useState<{ workspace: WorkspaceKey; detail: EntityDetail | null }[]>([]);
  const [result, setResult] = useState<WorldResponse | null>(null);
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
          const nextResult = await requestJson<WorldResponse>(`/api/world/${resource}?${query}`, { signal });
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
        readStatus: () => requestJson<WorldStatus>("/api/world/snapshots/current"),
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
      const nextDetail = {
        resource: nextResource,
        data: await requestJson<WorldRow>(
          `/api/world/${nextResource}/${encodeURIComponent(id)}${snapshotId ? `?snapshotId=${encodeURIComponent(snapshotId)}` : ""}`,
        ),
      };
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
      <section id="world-workspace-overview" role="tabpanel" aria-labelledby="world-workspace-tab-overview" hidden={workspace !== "overview"}><WorldOverviewLobby status={status} onChooseResource={(target) => chooseResource(target, true)} onShowInventory={(context) => openInventory(context, true)} onShowPals={openPalSummary} /></section>
      <section id="world-workspace-inventories" role="tabpanel" aria-labelledby="world-workspace-tab-inventories" hidden={workspace !== "inventories"}>{visitedWorkspaces.has("inventories") && <InventoryWorkspace key={snapshotId || "none"} snapshotId={snapshotId} context={inventoryContext} onSnapshotReplaced={refreshSnapshot} onContextChange={setInventoryContext} onClearContext={() => setInventoryContext({ scope: "inventory" })} />}</section>
      <section id="world-workspace-pals" role="tabpanel" aria-labelledby="world-workspace-tab-pals" hidden={workspace !== "pals"}>{visitedWorkspaces.has("pals") && <PalRoster key={snapshotId || "none"} snapshotId={snapshotId} context={palContext} onSnapshotReplaced={refreshSnapshot} onNavigate={(target, id) => void openDetail(target, id, true)} />}</section>
      {(["players", "bases", "guilds"] as const).map((panel) => <section key={panel} id={`world-workspace-${panel}`} role="tabpanel" aria-labelledby={`world-workspace-tab-${panel}`} hidden={workspace !== panel}>{workspace === panel && <div className="world-browser">
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
            return <span key={column.key} data-key={column.key} data-label={column.label} title={cell}>{columnIndex === 0 && item.id ? <button className="world-link world-entity-link" type="button" aria-label={`${cell}${palGender ? `，${palGender}` : ""}`} aria-current={isSelected ? "true" : undefined} onClick={(event) => void openDetail(resource, String(item.id), false, event.currentTarget)}><EntityMarker resource={resource} item={item} /><span className="world-entity-label">{cell}</span>{resource === "pals" && <PalGenderIcon item={item} />}</button> : cell}</span>;
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

function WorldOverviewLobby({ status, onChooseResource, onShowInventory, onShowPals }: { status: WorldStatus | null; onChooseResource: (resource: PrimaryWorldResource) => void; onShowInventory: (context: InventoryContext) => void; onShowPals: (context: Omit<PalRosterContext, "token">) => void }) {
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
    { label: "玩家", value: overview.assets.players, detail: "已记录角色", icon: Users, action: () => onChooseResource("players") },
    { label: "帕鲁", value: overview.assets.pals, detail: `${overview.assets.palSpecies.toLocaleString()} 个物种`, icon: PawPrint, action: () => onShowPals({ label: "全部帕鲁" }) },
    { label: "仓库", value: overview.assets.itemTypes, detail: `${overview.assets.itemQuantity.toLocaleString()} 件物品`, icon: Boxes, action: () => onShowInventory({ scope: "all", label: "全世界物品" }) },
    { label: "据点", value: overview.assets.bases, detail: "稳定 ID 关联", icon: Warehouse, action: () => onChooseResource("bases") },
    { label: "公会", value: overview.assets.guilds, detail: "成员与资产", icon: Users, action: () => onChooseResource("guilds") },
  ];
  const actionItems = [
    { label: "需要关注", value: overview.actions.attentionPals, icon: HeartPulse, tone: "danger", action: () => onShowPals({ care: "attention", label: "需要关注" }) },
    { label: "闪光帕鲁", value: overview.actions.luckyPals, icon: Sparkles, action: () => onShowPals({ marker: "lucky", label: "闪光帕鲁" }) },
    { label: "头目帕鲁", value: overview.actions.bossPals, icon: Crown, action: () => onShowPals({ marker: "boss", label: "头目帕鲁" }) },
    { label: "未归属帕鲁", value: overview.actions.unassignedPals, icon: PawPrint, action: () => onShowPals({ location: "unassigned", label: "未归属帕鲁" }) },
    { label: "未知物品", value: overview.actions.unknownItems, icon: PackageOpen, action: () => onShowInventory({ scope: "all", metadata: "unknown", label: "资料未收录的物品" }) },
    { label: "解析完整性", value: completenessCount, icon: CircleAlert, tone: completenessCount ? "warning" : "healthy", action: showDiagnostics },
  ];
  return <div className="world-overview-lobby">
    <header className="world-overview-heading"><div><h2>世界资产总览</h2><p>先确认快照可信度，再进入当前世界的资产与待查看事项。</p></div><span className={status?.stale ? "warning" : "healthy"}>{status?.stale ? "旧缓存可用" : "当前快照可用"}</span></header>
    <section className="world-overview-section" aria-labelledby="world-assets-heading"><h3 id="world-assets-heading">资产规模</h3><div className="world-overview-assets">{assetItems.map(({ label, value, detail, icon: Icon, action }) => <button type="button" key={label} onClick={action}><Icon size={18} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><b>{value.toLocaleString()}</b></button>)}</div></section>
    <section className="world-overview-section" aria-labelledby="world-actions-heading"><div className="world-overview-section-title"><h3 id="world-actions-heading">需要处理或进一步查看</h3><p>数量为零的项目仍可进入对应筛选结果核对。</p></div><div className="world-overview-actions">{actionItems.map(({ label, value, icon: Icon, tone, action }) => <button className={tone || ""} type="button" key={label} onClick={action}><Icon size={18} aria-hidden="true" /><span>{label}</span><strong>{value.toLocaleString()}</strong></button>)}</div></section>
    <details ref={diagnosticsRef} className="world-overview-diagnostics"><summary tabIndex={-1}>技术诊断与数据覆盖</summary><dl><div><dt>Snapshot ID</dt><dd><code>{status?.snapshotId || "WORLD_CACHE_UNAVAILABLE"}</code></dd></div><div><dt>数据覆盖</dt><dd>{status?.dataCoverage.state === "complete" ? "完整" : "不可用"}</dd></div><div><dt>帕鲁元数据未收录</dt><dd>{overview.actions.unknownPalMetadata.toLocaleString()}</dd></div><div><dt>照护字段不可用</dt><dd>{overview.actions.careUnavailable.toLocaleString()}</dd></div><div><dt>解析耗时</dt><dd>{status?.parseDurationMs === null ? "不可用" : `${status?.parseDurationMs} ms`}</dd></div><div><dt>缓存大小</dt><dd>{status?.cacheSizeBytes === null ? "不可用" : `${Math.round((status?.cacheSizeBytes || 0) / 1024).toLocaleString()} KB`}</dd></div></dl></details>
  </div>;
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
    <header className="section-heading"><div className="world-drawer-title"><EntityMarker resource={resource} item={data} /><div><div className="world-entity-name"><h2>{entityName(data, resource)}</h2>{resource === "pals" && <PalGenderIcon item={data} />}</div><p><span className="world-detail-type">{RESOURCE_LABELS[resource]}</span>{resource === "players" ? playerProgressCoverage(playerProgressOf(data)) : <span className="world-detail-id"><small>{resource === "bases" ? "Base ID" : resource === "guilds" ? "Guild ID" : "Pal ID"}</small>{valueOf(data, "id")}</span>}</p></div></div><button ref={closeButtonRef} className="icon-button bordered" type="button" title={canGoBack ? "返回上一详情" : "关闭详情"} aria-label={canGoBack ? "返回上一详情" : "关闭详情"} onClick={onClose}>{canGoBack ? <ArrowLeft size={18} /> : <X size={18} />}</button></header>
    <div className="world-detail-properties">
      {resource === "players" && <PlayerDetail data={data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
      {resource === "pals" && <PalDetail data={data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
      {resource === "guilds" && <GuildDetail data={data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
      {resource === "bases" && <BaseDetail data={data} onNavigate={onNavigate} onShowInventory={onShowInventory} />}
    </div>
  </aside>;
}

function EntityMarker({ resource, item }: { resource: PrimaryWorldResource; item: WorldRow }) {
  if (resource === "players") return <span className="world-entity-avatar world-player-avatar" aria-hidden="true">{playerInitial(item.name)}</span>;
  if (resource === "pals") {
    const pal = resolvePal(item);
    return <span className="world-entity-avatar world-pal-avatar" data-icon-key={pal.known ? pal.characterId : "pal-placeholder"} aria-hidden="true"><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span>;
  }
  return null;
}

function PalGenderIcon({ item }: { item: WorldRow }) {
  const gender = resolvePal(item).gender;
  if (!gender) return null;
  const label = gender === "male" ? "雄性" : "雌性";
  return <span className={`world-pal-gender ${gender}`} title={label} aria-hidden="true">{gender === "male" ? "♂" : "♀"}</span>;
}

function genderLabel(item: WorldRow): string | null {
  const gender = resolvePal(item).gender;
  return gender === "male" ? "雄性" : gender === "female" ? "雌性" : null;
}

function PlayerDetail({ data, onNavigate, onShowInventory }: DetailProps) {
  const progress = playerProgressOf(data);
  const unavailable = playerProgressUnavailable(progress);
  return <>
    <section className="player-progress-identity">
      <PropertyGrid data={{ ...data, lastRecordedLabel: formatPlayerRecordedAt(data.lastRecordedAt) }} fields={[["等级", "level"], ["所属公会", "guildName"], ["最后记录时间", "lastRecordedLabel"]]} />
    </section>
    <RelationButton title="所属公会" value={rowOf(data, "guild")} resource="guilds" onNavigate={onNavigate} />
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
    <RelationList title="拥有帕鲁" rows={rowsOf(data, "pals")} resource="pals" onNavigate={onNavigate} />
    <RelationList title="队伍帕鲁" rows={rowsOf(data, "partyPals")} resource="pals" onNavigate={onNavigate} />
    <RelationList title="储存帕鲁" rows={rowsOf(data, "storagePals")} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="玩家库存" data={data} scope="player" onShowInventory={onShowInventory} />
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Player ID</dt><dd>{valueOf(data, "id")}</dd></div><div><dt>Instance ID</dt><dd>{valueOf(data, "instanceId")}</dd></div></dl></details>
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

function PalDetail({ data, onNavigate }: DetailProps) {
  const pal = resolvePal(data);
  const traitSummary = palTraitLabels(data).join(" · ") || "普通";
  return <>
    <PropertyGrid data={{ ...data, displayName: pal.displayName, speciesName: pal.speciesName, traitSummary }} fields={[["名称", "displayName"], ["种族", "speciesName"], ["属性", "traitSummary"], ["Character ID", "characterId"], ["等级", "level"], ["Container", "containerId"], ["Slot", "slotIndex"], ["工作状态", "assignment"]]} />
    <RelationButton title="主人" value={rowOf(data, "owner")} resource="players" onNavigate={onNavigate} />
    <RelationButton title="据点" value={rowOf(data, "base")} resource="bases" onNavigate={onNavigate} />
    <RelationButton title="容器" value={rowOf(data, "container")} />
    <RawDetail value={data.detail} />
  </>;
}

function GuildDetail({ data, onNavigate, onShowInventory }: DetailProps) {
  const summary = rowOf(data, "assetSummary");
  const inventory = summary ? rowOf(summary, "inventory") : null;
  const missingMembers = stringsOf(data, "missingMemberIds");
  const missingBases = stringsOf(data, "missingBaseIds");
  return <>
    <AssetSummary title="公会资产规模" items={[["成员", numberOf(summary, "memberCount")], ["据点", numberOf(summary, "baseCount")], ["帕鲁", numberOf(summary, "palCount")], ["物品种类", numberOf(inventory, "itemTypeCount")], ["物品总量", numberOf(inventory, "totalQuantity")]]} />
    <RelationList title="成员" rows={rowsOf(data, "members")} resource="players" onNavigate={onNavigate} />
    <RelationList title="关联据点" rows={rowsOf(data, "bases")} resource="bases" onNavigate={onNavigate} />
    <RelationList title="关联帕鲁" rows={rowsOf(data, "pals")} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="公会关联仓库" data={data} scope="guild" onShowInventory={onShowInventory} />
    {(missingMembers.length > 0 || missingBases.length > 0) && <section className="world-association-warning" role="status"><AlertTriangle size={17} aria-hidden="true" /><div><strong>部分关联资料不可用</strong><p>当前缓存中没有对应实体；以下稳定 ID 原样保留，未创建猜测关系。</p>{missingMembers.length > 0 && <MissingIdList label="缺失成员 ID" ids={missingMembers} />}{missingBases.length > 0 && <MissingIdList label="缺失据点 ID" ids={missingBases} />}</div></section>}
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Guild ID</dt><dd>{valueOf(data, "id")}</dd></div></dl></details>
  </>;
}

function BaseDetail({ data, onNavigate, onShowInventory }: DetailProps) {
  const association = valueOf(data, "guildAssociation");
  const care = rowOf(data, "careSummary");
  const inventory = rowOf(data, "inventorySummary");
  const overview = { ...data, coordinates: coordinateLabel(data), inventoryTypeCount: numberOf(inventory, "itemTypeCount"), inventoryQuantity: numberOf(inventory, "totalQuantity") };
  return <>
    <PropertyGrid data={overview} fields={[["坐标", "coordinates"], ["工作帕鲁", "workerCount"], ["物品种类", "inventoryTypeCount"], ["物品总量", "inventoryQuantity"]]} />
    <BaseGuildRelation data={data} association={association} onNavigate={onNavigate} />
    <CareSummary summary={care} />
    <RelationList title="工作帕鲁" rows={rowsOf(data, "workers")} resource="pals" onNavigate={onNavigate} />
    <InventoryButton title="据点库存" data={data} scope="base" onShowInventory={onShowInventory} />
    <details className="world-relation-section player-technical-detail"><summary>技术信息</summary><dl><div><dt>Base ID</dt><dd>{valueOf(data, "id")}</dd></div><div><dt>Worker Container ID</dt><dd>{valueOf(data, "workerContainerId")}</dd></div></dl></details>
  </>;
}

type DetailProps = { data: WorldRow; onNavigate: (resource: PrimaryWorldResource, id: string) => void; onShowInventory: (context: InventoryContext) => void };

function AssetSummary({ title, items }: { title: string; items: [string, number | null][] }) {
  return <section className="world-asset-summary"><h3>{title}</h3><dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value === null ? "不可用" : value.toLocaleString()}</dd></div>)}</dl></section>;
}

function MissingIdList({ label, ids }: { label: string; ids: string[] }) {
  return <div className="world-missing-ids"><span>{label}</span>{ids.map((id) => <code key={id}>{id}</code>)}</div>;
}

function BaseGuildRelation({ data, association, onNavigate }: { data: WorldRow; association: string; onNavigate: DetailProps["onNavigate"] }) {
  const guild = rowOf(data, "guild");
  if (association === "linked" && guild?.id) return <RelationButton title="所属公会" value={guild} resource="guilds" onNavigate={onNavigate} />;
  if (association === "unavailable") return <section className="world-relation-section"><h3>所属公会</h3><p className="world-association-unavailable">关联资料不可用</p><code className="world-stable-id">{valueOf(data, "guildId")}</code></section>;
  return <section className="world-relation-section"><h3>所属公会</h3><p className="muted">未分配</p></section>;
}

function CareSummary({ summary }: { summary: WorldRow | null }) {
  const total = numberOf(summary, "total");
  const critical = numberOf(summary, "critical");
  const warning = numberOf(summary, "warning");
  const attention = numberOf(summary, "attention");
  const unavailable = numberOf(summary, "unavailable");
  const tone = attention === null ? "unavailable" : attention > 0 ? "attention" : unavailable ? "unavailable" : "healthy";
  const label = total === 0 ? "暂无工作帕鲁" : attention === null ? "照护摘要不可用" : attention > 0 ? `${attention} 只需要关注` : unavailable ? "部分照护数据不可用" : "未见需要关注";
  return <section className={`base-care-summary ${tone}`} aria-label="工作帕鲁照护摘要"><header><HeartPulse size={18} aria-hidden="true" /><div><h3>照护摘要</h3><p>{label}</p></div></header><dl><div><dt>需立即处理</dt><dd>{critical ?? "-"}</dd></div><div><dt>需要关注</dt><dd>{warning ?? "-"}</dd></div><div><dt>数据不可用</dt><dd>{unavailable ?? "-"}</dd></div></dl><small>与帕鲁名册“需要关注”使用同一存档快照规则。</small></section>;
}

function PropertyGrid({ data, fields }: { data: WorldRow; fields: [string, string][] }) {
  return <dl className="world-detail-grid">{fields.map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{valueOf(data, key)}</dd></div>)}</dl>;
}

function RelationButton({ title, value, resource, onNavigate }: { title: string; value: WorldRow | null; resource?: PrimaryWorldResource; onNavigate?: DetailProps["onNavigate"] }) {
  return <section className="world-relation-section"><h3>{title}</h3>{value ? resource && value.id && onNavigate ? <button className="world-relation-link" type="button" onClick={() => onNavigate(resource, String(value.id))}>{entityName(value, resource)}<small>{String(value.id)}</small></button> : <p>{entityName(value, "bases")}</p> : <p className="muted">未关联</p>}</section>;
}

function RelationList({ title, rows, resource, onNavigate }: { title: string; rows: WorldRow[]; resource: PrimaryWorldResource; onNavigate: DetailProps["onNavigate"] }) {
  return <section className="world-relation-section"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div className="world-relation-list">{rows.map((item, index) => item.id ? <button className="world-relation-link" type="button" key={String(item.id)} onClick={() => onNavigate(resource, String(item.id))}><span className="world-relation-name">{entityName(item, resource)}{resource === "pals" && <PalGenderIcon item={item} />}</span><small>{String(item.id)}</small></button> : <p key={index}>{entityName(item, resource)}</p>)}</div> : <p className="muted">暂无可关联数据</p>}</section>;
}

function InventoryButton({ title, data, scope, onShowInventory }: { title: string; data: WorldRow; scope: "player" | "base" | "guild"; onShowInventory: DetailProps["onShowInventory"] }) {
  const id = valueOf(data, "id");
  if (id === "不可用") return null;
  const resource = scope === "player" ? "players" : scope === "base" ? "bases" : "guilds";
  const name = entityName(data, resource);
  const context = scope === "player" ? { scope, ownerId: id } : scope === "base" ? { scope, baseId: id } : { scope: "inventory" as const, guildId: id };
  const label = `${scope === "player" ? "玩家库存" : scope === "base" ? "据点库存" : "公会关联仓库"}：${name}`;
  return <section className="world-relation-section"><h3>{title}</h3><button className="world-relation-link" type="button" onClick={() => onShowInventory({ ...context, label })}><span className="world-relation-name"><PackageOpen size={16} aria-hidden="true" />在仓库中查看</span><small>仅显示该稳定 ID 的关联范围</small></button></section>;
}

function RawDetail({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return null;
  return <details className="world-relation-section world-raw-detail"><summary>其他解析数据</summary><pre className="world-detail-json">{JSON.stringify(value, null, 2)}</pre></details>;
}

function rowsOf(data: WorldRow, key: string): WorldRow[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter(isWorldRow) : [];
}

function stringsOf(data: WorldRow, key: string): string[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function numberOf(data: WorldRow | null, key: string): number | null {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coordinateLabel(data: WorldRow): string {
  const values = ["x", "y", "z"].map((key) => numberOf(data, key));
  return values.every((value) => value !== null) ? values.map((value) => Math.round(value as number).toLocaleString()).join(" / ") : "数据不可用";
}

function rowOf(data: WorldRow, key: string): WorldRow | null {
  return isWorldRow(data[key]) ? data[key] : null;
}

function isWorldRow(value: unknown): value is WorldRow {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function valueOf(data: WorldRow, key: string): string {
  const value = data[key];
  if (value === undefined || value === null || value === "") return "不可用";
  if (typeof value === "object") return Array.isArray(value) ? `${value.length} 项` : "已关联";
  return String(value);
}

function entityName(data: WorldRow, resource: PrimaryWorldResource): string {
  if (resource === "pals") return resolvePal(data).displayName;
  return valueOf(data, "name") !== "不可用" ? valueOf(data, "name") : valueOf(data, "id");
}
