import { ChevronLeft, ChevronRight, Database, PawPrint, RefreshCw, Search, SlidersHorizontal, Users, Warehouse, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";

import type { AuthStatus, WorldResponse, WorldRow, WorldStatus } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatWorldTime, type PrimaryWorldResource, worldCell, worldColumns } from "./worldTable";
import { palTraitLabels, playerInitial, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";

type EntityDetail = { resource: PrimaryWorldResource; data: WorldRow };
type SortKey = "name" | "level" | "id";
type RelationFilter = "all" | "linked" | "unlinked";

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

export function WorldDataPage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<WorldStatus | null>(null);
  const [resource, setResource] = useState<PrimaryWorldResource>("players");
  const [result, setResult] = useState<WorldResponse | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [relationFilter, setRelationFilter] = useState<RelationFilter>("all");
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
  }, [appliedSearch, nextRequestSignal, page, resource]);

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
    setRelationFilter("all");
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
    setRelationFilter("all");
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

  const displayedItems = useMemo(
    () => sortRows(
      (result?.items || []).filter((item) => matchesRelationFilter(item, resource, relationFilter)),
      resource,
      sortKey,
    ),
    [relationFilter, resource, result?.items, sortKey],
  );
  const columns = worldColumns(resource);
  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch) || relationFilter !== "all" || sortKey !== "name";

  return <div className="page-stack world-page">
    <section className={`world-status ${status?.stale ? "stale" : ""}`}>
      <div className="status-icon">{status?.parsing ? <RefreshCw className="spin" size={23} /> : <Database size={23} />}</div>
      <div><h2>{status?.parsing ? "正在解析存档快照" : status?.stale ? "正在显示最后成功缓存" : "存档缓存可用"}</h2><p>{status?.error || `最后成功：${formatWorldTime(status?.observedAt)}${status?.parseDurationMs ? ` · ${status.parseDurationMs} ms` : ""}`}</p></div>
      <button className="quiet-button" type="button" onClick={() => void reparse()}><RefreshCw size={17} />重新解析</button>
    </section>
    <div className="world-tabs" role="tablist" aria-label="世界实体分类">
      {PRIMARY_RESOURCES.map(({ key, label, icon: Icon }) => <button key={key} className={resource === key ? "active" : ""} type="button" role="tab" aria-selected={resource === key} onClick={() => chooseResource(key)}><Icon size={17} /><span>{label}</span><strong>{status?.counts[key] ?? "-"}</strong></button>)}
    </div>
    <div className="world-browser">
      <section className="world-list-panel" aria-label={`${RESOURCE_LABELS[resource]}列表`}>
        <form className="world-toolbar" onSubmit={submitSearch}>
          <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索世界数据" placeholder="搜索名称或稳定 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
          <button className="primary-button world-search-button" type="submit">搜索</button>
          <label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>关联</span><select aria-label="关联筛选" value={relationFilter} onChange={(event) => { setPage(1); setRelationFilter(event.target.value as RelationFilter); }}><option value="all">全部</option><option value="linked">已关联</option><option value="unlinked">未关联</option></select></label>
          <label className="world-control"><span>排序</span><select aria-label="排序方式" value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}><option value="name">名称</option><option value="level">等级 / 数量</option><option value="id">稳定 ID</option></select></label>
          {hasFilters && <button className="world-clear-button" type="button" aria-label="清除筛选条件" onClick={clearFilters}><X size={15} />清除</button>}
          <span className="world-result-count">当前 {displayedItems.length} 条</span>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-success" role="status">{message}</p>}
        <section className={`world-table ${showListLoading ? "is-loading" : ""}`} aria-live="polite" aria-busy={listLoading}>
          <div className="world-table-head" style={{ "--world-columns": columns.length } as CSSProperties}>{columns.map((column) => <span key={column.key}>{column.label}</span>)}</div>
          {showListLoading ? <WorldTableSkeleton columns={columns.length} /> : displayedItems.length ? displayedItems.map((item, index) => {
            const isSelected = selected?.resource === resource && String(selected.data.id) === String(item.id);
            return <div className="world-table-row" data-selected={isSelected || undefined} style={{ "--world-columns": columns.length } as CSSProperties} key={String(item.id || `${resource}-${index}`)}>{columns.map((column, columnIndex) => {
            const cell = worldCell(item, column.key);
            const palGender = resource === "pals" && column.key === "displayName" ? genderLabel(item) : null;
            return <span key={column.key} data-label={column.label}>{columnIndex === 0 && item.id ? <button className="world-link world-entity-link" type="button" aria-label={`${cell}${palGender ? `，${palGender}` : ""}`} aria-current={isSelected ? "true" : undefined} onClick={() => void openDetail(resource, String(item.id))}><EntityMarker resource={resource} item={item} /><span className="world-entity-label">{cell}</span>{resource === "pals" && <PalGenderIcon item={item} />}</button> : cell}</span>;
          })}</div>;
          }) : <div className="world-empty-state"><Database size={22} /><strong>{result ? hasFilters ? "没有符合条件的数据" : `暂无${RESOURCE_LABELS[resource]}数据` : "正在读取世界数据"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : "解析成功后，实体会显示在这里。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
        </section>
        <section className="audit-footer"><span>共 {result?.total || 0} 条，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></section>
      </section>
      {selected && <button className="world-drawer-backdrop" type="button" aria-label="关闭详情遮罩" onClick={() => setSelected(null)} />}
      <EntityDrawer detail={selected} loading={detailLoading} onClose={() => setSelected(null)} onNavigate={(target, id) => void openDetail(target, id)} />
    </div>
  </div>;
}

function WorldTableSkeleton({ columns }: { columns: number }) {
  return <div className="world-table-skeleton" aria-hidden="true">{Array.from({ length: 5 }, (_, row) => <div className="world-table-row" style={{ "--world-columns": columns } as CSSProperties} key={row}>{Array.from({ length: columns }, (_, column) => <span className="world-skeleton-line" key={column} />)}</div>)}</div>;
}

function EntityDrawer({ detail, loading, onClose, onNavigate }: { detail: EntityDetail | null; loading: boolean; onClose: () => void; onNavigate: (resource: PrimaryWorldResource, id: string) => void }) {
  if (!detail) return <aside className="world-entity-drawer empty" aria-label="世界实体详情"><Database size={24} /><h2>{loading ? "正在读取详情..." : "选择一个实体"}</h2><p>从左侧列表选择玩家、帕鲁、工会或据点，查看属性和可用关联。</p></aside>;

  const { data, resource } = detail;
  return <aside className="world-entity-drawer" role="dialog" aria-modal="false" aria-label="世界实体详情">
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
  return <>
    <PropertyGrid data={{ ...data, displayName: pal.displayName, speciesName: pal.speciesName, traitSummary }} fields={[["名称", "displayName"], ["种族", "speciesName"], ["属性", "traitSummary"], ["Character ID", "characterId"], ["等级", "level"], ["Container", "containerId"], ["Slot", "slotIndex"], ["工作状态", "assignment"]]} />
    <RelationButton title="主人" value={rowOf(data, "owner")} resource="players" onNavigate={onNavigate} />
    <RelationButton title="据点" value={rowOf(data, "base")} resource="bases" onNavigate={onNavigate} />
    <RelationButton title="容器" value={rowOf(data, "container")} />
    <RawDetail value={data.detail} />
  </>;
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

function sortRows(items: WorldRow[], resource: PrimaryWorldResource, sortKey: SortKey): WorldRow[] {
  const keyBySort: Record<SortKey, string> = { name: "name", level: "level", id: "id" };
  const key = keyBySort[sortKey];
  const sortValue = (item: WorldRow) => sortKey === "name" && resource === "pals" ? resolvePal(item).displayName : valueOf(item, key);
  return [...items].sort((left, right) => sortValue(left).localeCompare(sortValue(right), "zh-CN", { numeric: true }));
}

function matchesRelationFilter(item: WorldRow, resource: PrimaryWorldResource, filter: RelationFilter): boolean {
  if (filter === "all") return true;
  const linked = resource === "pals" ? Boolean(item.ownerPlayerId || item.baseId) : resource === "guilds" ? Number(item.memberCount || 0) > 0 || Number(item.baseCount || 0) > 0 : Boolean(item.guildId);
  return filter === "linked" ? linked : !linked;
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
