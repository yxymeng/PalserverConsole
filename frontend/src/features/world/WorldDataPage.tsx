import { ChevronLeft, ChevronRight, Crown, Database, PawPrint, RefreshCw, Search, SlidersHorizontal, Sparkles, Users, Warehouse, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";

import type { AuthStatus, WorldResponse, WorldRow, WorldStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatWorldTime, type PrimaryWorldResource, worldCell, worldColumns } from "./worldTable";
import { palTraitLabels, playerInitial, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";

type EntityDetail = { resource: PrimaryWorldResource; data: WorldRow };
type SortKey = "name" | "level-desc" | "count-desc" | "id";
type StatusFilter = "all" | "guilded" | "unguilded" | "player" | "base" | "unassigned" | "active" | "empty";

const PRIMARY_RESOURCES: { key: PrimaryWorldResource; label: string; icon: typeof Users }[] = [
  { key: "players", label: "玩家", icon: Users },
  { key: "pals", label: "帕鲁", icon: PawPrint },
  { key: "guilds", label: "工会", icon: Users },
  { key: "bases", label: "据点", icon: Warehouse },
];

const RESOURCE_LABELS: Record<PrimaryWorldResource, string> = {
  players: "玩家",
  pals: "帕鲁",
  guilds: "工会",
  bases: "据点",
};

const RESOURCE_GUIDANCE: Record<PrimaryWorldResource, { title: string; description: string; search: string }> = {
  players: { title: "玩家名册", description: "按身份与工会关系定位玩家，再进入详情查看帕鲁和库存关联。", search: "搜索玩家名称或 Player ID" },
  pals: { title: "帕鲁档案", description: "优先识别名称、属性、主人与据点归属，未分配个体单独可筛。", search: "搜索帕鲁名称或稳定 ID" },
  guilds: { title: "工会结构", description: "从成员与据点规模判断工会结构，并沿关联继续查看实体。", search: "搜索工会名称或 Guild ID" },
  bases: { title: "据点目录", description: "查看据点归属和工作容器，详情中继续追踪工会、帕鲁与库存。", search: "搜索据点名称或 Base ID" },
};

const STATUS_OPTIONS: Record<PrimaryWorldResource, { value: StatusFilter; label: string }[]> = {
  players: [{ value: "all", label: "全部玩家" }, { value: "guilded", label: "已加入工会" }, { value: "unguilded", label: "未加入工会" }],
  pals: [{ value: "all", label: "全部帕鲁" }, { value: "player", label: "玩家持有" }, { value: "base", label: "据点工作" }, { value: "unassigned", label: "未分配" }],
  guilds: [{ value: "all", label: "全部工会" }, { value: "active", label: "有成员或据点" }, { value: "empty", label: "空工会" }],
  bases: [{ value: "all", label: "全部据点" }, { value: "guilded", label: "已归属工会" }, { value: "unguilded", label: "未归属工会" }],
};

const SORT_OPTIONS: Record<PrimaryWorldResource, { value: SortKey; label: string }[]> = {
  players: [{ value: "name", label: "名称" }, { value: "level-desc", label: "等级（高到低）" }, { value: "id", label: "稳定 ID" }],
  pals: [{ value: "name", label: "名称" }, { value: "level-desc", label: "等级（高到低）" }, { value: "id", label: "稳定 ID" }],
  guilds: [{ value: "name", label: "名称" }, { value: "count-desc", label: "成员数量（多到少）" }, { value: "id", label: "稳定 ID" }],
  bases: [{ value: "name", label: "名称" }, { value: "id", label: "稳定 ID" }],
};

export function WorldDataPage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<WorldStatus | null>(null);
  const [resource, setResource] = useState<PrimaryWorldResource>("players");
  const [result, setResult] = useState<WorldResponse | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<EntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [showListLoading, setShowListLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pageSize = 50;
  const nextRequestSignal = useAbortableRequest();
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const signal = nextRequestSignal();
    setListLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (appliedSearch) query.set("search", appliedSearch);
      if (statusFilter !== "all") query.set("status", statusFilter);
      query.set("sort", sortKey);
      const [nextStatus, nextResult] = await Promise.all([
        requestJson<WorldStatus>("/api/world/snapshots/current", { signal }),
        requestJson<WorldResponse>(`/api/world/${resource}?${query}`, { signal }),
      ]);
      setStatus(nextStatus);
      setResult(nextResult);
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "世界数据读取失败");
    } finally {
      if (sequence === loadSequence.current) setListLoading(false);
    }
  }, [appliedSearch, nextRequestSignal, page, resource, sortKey, statusFilter]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!listLoading) {
      setShowListLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowListLoading(true), 300);
    return () => window.clearTimeout(timer);
  }, [listLoading]);

  function chooseResource(next: PrimaryWorldResource) {
    setResource(next);
    setResult(null);
    setPage(1);
    setStatusFilter("all");
    setSortKey("name");
    setSelected(null);
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
    setError("");
    setMessage("");
    try {
      const response = await requestJson<{ message: string }>("/api/world/reparse", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: "{}",
      });
      setMessage(response.message);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重新解析请求失败");
    }
  }

  const openDetail = useCallback(async (nextResource: PrimaryWorldResource, id: string) => {
    setDetailLoading(true);
    setError("");
    try {
      setSelected({
        resource: nextResource,
        data: await requestJson<WorldRow>(`/api/world/${nextResource}/${encodeURIComponent(id)}`),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "实体详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const displayedItems = result?.items || [];
  const columns = worldColumns(resource);
  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch) || statusFilter !== "all" || sortKey !== "name";
  const resourceGuidance = RESOURCE_GUIDANCE[resource];
  const activeStatusLabel = STATUS_OPTIONS[resource].find((option) => option.value === statusFilter)?.label;
  const activeSortLabel = SORT_OPTIONS[resource].find((option) => option.value === sortKey)?.label;
  const palPageStats = resource === "pals" ? {
    lucky: displayedItems.filter((item) => palTraitLabels(item).includes("闪光")).length,
    assigned: displayedItems.filter((item) => Boolean(item.ownerPlayerId || item.baseId)).length,
    highest: displayedItems.reduce((highest, item) => Math.max(highest, Number(item.level) || 0), 0),
  } : null;

  return <div className="page-stack world-page">
    <section className={`world-command-deck ${status?.stale ? "stale" : ""}`}>
      <div className="world-command-status"><span className="world-command-icon">{status?.parsing ? <RefreshCw className="spin" /> : <Database />}</span><div><h2>{status?.parsing ? "正在解析存档快照" : status?.stale ? "正在显示最后成功缓存" : "存档缓存可用"}</h2><p>{status?.error || `最后成功：${formatWorldTime(status?.observedAt)}${status?.parseDurationMs ? ` · ${status.parseDurationMs} ms` : ""}`}</p></div><button className="quiet-button" type="button" onClick={() => void reparse()}><RefreshCw size={17} />重新解析</button></div>
      <div className="world-command-counts" aria-label="世界实体概览">{PRIMARY_RESOURCES.map(({ key, label, icon: Icon }) => <span key={key}><Icon aria-hidden="true" /><small>{label}</small><strong>{status?.counts[key] ?? "-"}</strong></span>)}</div>
    </section>
    <div className="world-tabs" role="tablist" aria-label="世界实体分类">
      {PRIMARY_RESOURCES.map(({ key, label, icon: Icon }) => <button key={key} className={resource === key ? "active" : ""} type="button" role="tab" aria-selected={resource === key} onClick={() => chooseResource(key)}><Icon size={17} /><span>{label}</span><strong>{status?.counts[key] ?? "-"}</strong></button>)}
    </div>
    <div className="world-browser" data-resource={resource}>
      <section className="world-list-panel" aria-label={`${RESOURCE_LABELS[resource]}列表`}>
        <header className="world-list-heading"><div><h2>{resourceGuidance.title}</h2><p>{resourceGuidance.description}</p></div><span>{result?.total || 0} 条记录</span></header>
        {palPageStats && <section className="pal-collection-summary" aria-label="帕鲁数据概览"><span><PawPrint aria-hidden="true" /><small>帕鲁总数</small><strong>{result?.total || 0}</strong></span><span><Sparkles aria-hidden="true" /><small>本页闪光</small><strong>{palPageStats.lucky}</strong></span><span><Users aria-hidden="true" /><small>本页已归属</small><strong>{palPageStats.assigned}</strong></span><span><Crown aria-hidden="true" /><small>本页最高等级</small><strong>Lv.{palPageStats.highest}</strong></span></section>}
        <form className={`world-toolbar ${resource === "pals" ? "pal-filter-panel" : ""}`} onSubmit={submitSearch}>
          <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索世界数据" placeholder={resourceGuidance.search} value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
          <button className="primary-button world-search-button" type="submit">搜索</button>
          {resource === "pals" ? <><fieldset className="pal-filter-segments"><legend><SlidersHorizontal size={14} />归属</legend><div>{STATUS_OPTIONS.pals.map((option) => <button key={option.value} className={statusFilter === option.value ? "active" : ""} type="button" aria-pressed={statusFilter === option.value} onClick={() => { setPage(1); setStatusFilter(option.value); }}>{option.label.replace("全部帕鲁", "全部")}</button>)}</div></fieldset><fieldset className="pal-filter-segments pal-sort-segments"><legend>排序</legend><div>{SORT_OPTIONS.pals.filter((option) => option.value !== "id").map((option) => <button key={option.value} className={sortKey === option.value ? "active" : ""} type="button" aria-pressed={sortKey === option.value} onClick={() => { setPage(1); setSortKey(option.value); }}>{option.label.replace("（高到低）", "")}</button>)}</div></fieldset></> : <><label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>状态</span><select aria-label="状态筛选" value={statusFilter} onChange={(event) => { setPage(1); setStatusFilter(event.target.value as StatusFilter); }}>{STATUS_OPTIONS[resource].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label className="world-control"><span>排序</span><select aria-label="排序方式" value={sortKey} onChange={(event) => { setPage(1); setSortKey(event.target.value as SortKey); }}>{SORT_OPTIONS[resource].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></>}
          {hasFilters && <button className="world-clear-button" type="button" aria-label="清除筛选条件" onClick={clearFilters}><X size={15} />清除</button>}
          <span className="world-result-count">本页 {displayedItems.length} / 共 {result?.total || 0} 条</span>
        </form>
        {hasFilters && <div className="world-active-filters" aria-label="当前筛选条件"><span>筛选中</span>{appliedSearch && <button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); setPage(1); }}>关键词：{appliedSearch}<X size={13} /></button>}{statusFilter !== "all" && <button type="button" onClick={() => { setStatusFilter("all"); setPage(1); }}>{activeStatusLabel}<X size={13} /></button>}{sortKey !== "name" && <button type="button" onClick={() => { setSortKey("name"); setPage(1); }}>排序：{activeSortLabel}<X size={13} /></button>}</div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        {resource === "pals" && <div className="pal-roster-head" aria-hidden="true"><span>帕鲁</span><span>属性</span><span>等级</span><span>主人</span><span>据点</span><span /></div>}
        <section className={`world-table world-entity-list ${showListLoading ? "is-loading" : ""}`} aria-live="polite" aria-busy={listLoading}>
          {showListLoading ? <WorldTableSkeleton columns={columns.length} /> : displayedItems.length ? displayedItems.map((item, index) => {
            const isSelected = selected?.resource === resource && String(selected.data.id) === String(item.id);
            const primaryCell = worldCell(item, columns[0].key);
            const palGender = resource === "pals" ? genderLabel(item) : null;
            return <button className="world-table-row world-entity-card" data-selected={isSelected || undefined} type="button" key={String(item.id || `${resource}-${index}`)} aria-label={`${primaryCell}${palGender ? `，${palGender}` : ""}`} aria-current={isSelected ? "true" : undefined} onClick={() => item.id && void openDetail(resource, String(item.id))}><span className="world-entity-card-primary"><EntityMarker resource={resource} item={item} /><span><strong>{primaryCell}</strong><small>{String(item.id || "稳定 ID 不可用")}</small></span>{resource === "pals" && <PalGenderIcon item={item} />}</span><span className="world-entity-card-facts">{columns.slice(1).map((column) => <span key={column.key}><small>{column.label}</small><strong data-label={column.label}>{worldCell(item, column.key)}</strong></span>)}</span><ChevronRight className="world-entity-card-arrow" aria-hidden="true" /></button>;
          }) : <div className="world-empty-state"><Database size={22} /><strong>{result ? hasFilters ? "没有符合条件的数据" : `暂无${RESOURCE_LABELS[resource]}数据` : "正在读取世界数据"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : "解析成功后，实体会显示在这里。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
        </section>
        <section className="audit-footer"><span>共 {result?.total || 0} 条，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></section>
      </section>
      {resource !== "pals" && <>{selected && <button className="world-drawer-backdrop" type="button" aria-label="关闭详情遮罩" onClick={() => setSelected(null)} />}<EntityDrawer detail={selected} loading={detailLoading} onClose={() => setSelected(null)} onNavigate={(target, id) => void openDetail(target, id)} /></>}
    </div>
    {resource === "pals" && selected && createPortal(<div className="world-pal-overlay"><button className="world-drawer-backdrop" type="button" aria-label="关闭详情遮罩" onClick={() => setSelected(null)} /><EntityDrawer detail={selected} loading={detailLoading} onClose={() => setSelected(null)} onNavigate={(target, id) => void openDetail(target, id)} /></div>, document.body)}
  </div>;
}

function WorldTableSkeleton({ columns }: { columns: number }) {
  return <div className="world-table-skeleton" aria-hidden="true">{Array.from({ length: 5 }, (_, row) => <div className="world-table-row" style={{ "--world-columns": columns } as CSSProperties} key={row}>{Array.from({ length: columns }, (_, column) => <span className="world-skeleton-line" key={column} />)}</div>)}</div>;
}

function EntityDrawer({ detail, loading, onClose, onNavigate }: { detail: EntityDetail | null; loading: boolean; onClose: () => void; onNavigate: (resource: PrimaryWorldResource, id: string) => void }) {
  if (!detail) return <aside className="world-entity-drawer empty" aria-label="世界实体详情"><Database size={24} /><h2>{loading ? "正在读取详情..." : "选择一个实体"}</h2><p>从左侧列表选择玩家、帕鲁、工会或据点，查看属性和可用关联。</p></aside>;

  const { data, resource } = detail;
  return <aside className="world-entity-drawer" data-resource={resource} role="dialog" aria-modal={resource === "pals" ? "true" : "false"} aria-label="世界实体详情">
    <header className="section-heading"><div className="world-drawer-title"><EntityMarker resource={resource} item={data} /><div><div className="world-entity-name"><h2>{entityName(data, resource)}</h2>{resource === "pals" && <PalGenderIcon item={data} />}</div><p><span className="world-detail-type">{RESOURCE_LABELS[resource]}</span>{valueOf(data, "id")}</p></div></div><button className="icon-button bordered" type="button" title="关闭详情" aria-label="关闭详情" onClick={onClose}><X size={18} /></button></header>
    <div className="world-detail-properties">
      {resource === "players" && <PlayerDetail data={data} onNavigate={onNavigate} />}
      {resource === "pals" && <PalDetail data={data} onNavigate={onNavigate} />}
      {resource === "guilds" && <GuildDetail data={data} onNavigate={onNavigate} />}
      {resource === "bases" && <BaseDetail data={data} onNavigate={onNavigate} />}
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

function PlayerDetail({ data, onNavigate }: DetailProps) {
  return <>
    <PropertyGrid data={data} fields={[["等级", "level"], ["工会 ID", "guildId"], ["Player ID", "id"], ["实例", "instanceId"]]} />
    <RelationButton title="所属工会" value={rowOf(data, "guild")} resource="guilds" onNavigate={onNavigate} />
    <RelationList title="拥有帕鲁" rows={rowsOf(data, "pals")} resource="pals" onNavigate={onNavigate} />
    <RelationList title="队伍帕鲁" rows={rowsOf(data, "partyPals")} resource="pals" onNavigate={onNavigate} />
    <RelationList title="储存帕鲁" rows={rowsOf(data, "storagePals")} resource="pals" onNavigate={onNavigate} />
    <DataList title="玩家库存" rows={rowsOf(data, "inventory")} />
  </>;
}

function PalDetail({ data, onNavigate }: DetailProps) {
  const pal = resolvePal(data);
  const traitSummary = palTraitLabels(data).join(" · ") || "普通";
  const assignmentLabel = palAssignmentLabel(data.assignment);
  return <>
    <section className="world-pal-detail-hero"><span className="world-pal-detail-portrait"><img src={pal.icon} alt={pal.displayName} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span><div><span className="world-pal-detail-level">Lv.{valueOf(data, "level")}</span><strong>{pal.speciesName}</strong><p>{traitSummary}</p><small>{assignmentLabel}</small></div></section>
    <PropertyGrid data={{ ...data, displayName: pal.displayName, speciesName: pal.speciesName, traitSummary, assignmentLabel }} fields={[["名称", "displayName"], ["种族", "speciesName"], ["属性", "traitSummary"], ["Character ID", "characterId"], ["等级", "level"], ["Container", "containerId"], ["Slot", "slotIndex"], ["工作状态", "assignmentLabel"]]} />
    <RelationButton title="主人" value={rowOf(data, "owner")} resource="players" onNavigate={onNavigate} />
    <RelationButton title="据点" value={rowOf(data, "base")} resource="bases" onNavigate={onNavigate} />
    <RelationButton title="容器" value={rowOf(data, "container")} />
    <RawDetail value={data.detail} />
  </>;
}

function palAssignmentLabel(value: unknown): string {
  return ({ base_worker: "据点工作", base: "据点工作", player_inventory: "玩家持有", player_party: "玩家队伍", player: "玩家持有", party: "玩家队伍", storage: "仓库存放", unassigned: "未分配" } as Record<string, string>)[String(value || "")] || (value ? String(value) : "未分配");
}

function GuildDetail({ data, onNavigate }: DetailProps) {
  return <>
    <PropertyGrid data={data} fields={[["Guild ID", "id"], ["成员数量", "memberCount"], ["据点数量", "baseCount"]]} />
    <RelationList title="成员" rows={rowsOf(data, "members")} resource="players" onNavigate={onNavigate} />
    <RelationList title="关联据点" rows={rowsOf(data, "bases")} resource="bases" onNavigate={onNavigate} />
    <RawDetail value={data.detail} />
  </>;
}

function BaseDetail({ data, onNavigate }: DetailProps) {
  return <>
    <PropertyGrid data={data} fields={[["Base ID", "id"], ["X", "x"], ["Y", "y"], ["Z", "z"], ["工作容器", "workerContainerId"]]} />
    <RelationButton title="所属工会" value={rowOf(data, "guild")} resource="guilds" onNavigate={onNavigate} />
    <RelationList title="工作帕鲁" rows={rowsOf(data, "workers")} resource="pals" onNavigate={onNavigate} />
    <DataList title="可明确关联的库存" rows={rowsOf(data, "inventory")} />
    <RawDetail value={data.detail} />
  </>;
}

type DetailProps = { data: WorldRow; onNavigate: (resource: PrimaryWorldResource, id: string) => void };

function PropertyGrid({ data, fields }: { data: WorldRow; fields: [string, string][] }) {
  return <dl className="world-detail-grid">{fields.map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{valueOf(data, key)}</dd></div>)}</dl>;
}

function RelationButton({ title, value, resource, onNavigate }: { title: string; value: WorldRow | null; resource?: PrimaryWorldResource; onNavigate?: DetailProps["onNavigate"] }) {
  return <section className="world-relation-section"><h3>{title}</h3>{value ? resource && value.id && onNavigate ? <button className="world-relation-link" type="button" onClick={() => onNavigate(resource, String(value.id))}>{entityName(value, resource)}<small>{String(value.id)}</small></button> : <p>{entityName(value, "bases")}</p> : <p className="muted">未关联</p>}</section>;
}

function RelationList({ title, rows, resource, onNavigate }: { title: string; rows: WorldRow[]; resource: PrimaryWorldResource; onNavigate: DetailProps["onNavigate"] }) {
  return <section className="world-relation-section"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div className="world-relation-list">{rows.map((item, index) => item.id ? <button className="world-relation-link" type="button" key={String(item.id)} onClick={() => onNavigate(resource, String(item.id))}><span className="world-relation-name">{entityName(item, resource)}{resource === "pals" && <PalGenderIcon item={item} />}</span><small>{String(item.id)}</small></button> : <p key={index}>{entityName(item, resource)}</p>)}</div> : <p className="muted">暂无可关联数据</p>}</section>;
}

function DataList({ title, rows }: { title: string; rows: WorldRow[] }) {
  return <section className="world-relation-section"><h3>{title}<small>{rows.length}</small></h3>{rows.length ? <div className="world-data-list">{rows.map((item, index) => <p key={String(item.id || index)}>{entityName(item, "bases")}<small>{valueOf(item, "quantity") !== "不可用" ? ` × ${valueOf(item, "quantity")}` : valueOf(item, "containerId")}</small></p>)}</div> : <p className="muted">暂无可明确关联的数据</p>}</section>;
}

function RawDetail({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length) return null;
  return <details className="world-relation-section world-raw-detail"><summary>其他解析数据</summary><pre className="world-detail-json">{JSON.stringify(value, null, 2)}</pre></details>;
}

function rowsOf(data: WorldRow, key: string): WorldRow[] {
  const value = data[key];
  return Array.isArray(value) ? value.filter(isWorldRow) : [];
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
