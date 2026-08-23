import { Archive, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, MapPin, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldInventoryDetailResponse, WorldInventoryItem, WorldInventoryResponse, WorldInventoryScope } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";

export type InventoryContext = {
  scope: WorldInventoryScope;
  ownerId?: string;
  baseId?: string;
  label?: string;
};

type InventorySort = "name" | "quantity";

export function InventoryWorkspace({ snapshotId, context, onSnapshotReplaced, onContextChange, onClearContext }: {
  snapshotId: string | null | undefined;
  context: InventoryContext;
  onSnapshotReplaced: () => Promise<string | null>;
  onContextChange: (context: InventoryContext) => void;
  onClearContext: () => void;
}) {
  const [result, setResult] = useState<WorldInventoryResponse | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState<InventorySort>("name");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<WorldInventoryItem | null>(null);
  const [locations, setLocations] = useState<WorldInventoryDetailResponse | null>(null);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState("");
  const nextRequestSignal = useAbortableRequest();
  const loadSequence = useRef(0);
  const pageSize = 60;

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const signal = nextRequestSignal();
    setLoading(true);
    setError("");
    try {
      let currentSnapshotId = snapshotId || null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!currentSnapshotId) {
          setResult(null);
          break;
        }
        const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize), scope: context.scope, sort, snapshotId: currentSnapshotId });
        if (appliedSearch) query.set("search", appliedSearch);
        if (category) query.set("category", category);
        if (context.ownerId) query.set("ownerId", context.ownerId);
        if (context.baseId) query.set("baseId", context.baseId);
        try {
          const next = await requestJson<WorldInventoryResponse>(`/api/world/inventories?${query}`, { signal });
          if (next.snapshotId !== currentSnapshotId) {
            currentSnapshotId = await onSnapshotReplaced();
            continue;
          }
          setResult(next);
          break;
        } catch (caught) {
          if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED" && attempt === 0) {
            currentSnapshotId = await onSnapshotReplaced();
            continue;
          }
          throw caught;
        }
      }
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "仓库读取失败");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [appliedSearch, category, context, nextRequestSignal, onSnapshotReplaced, page, snapshotId, sort]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setExpanded(null);
    setLocations(null);
    setLocationError("");
  }, [snapshotId, context]);

  const loadLocations = useCallback(async (item: WorldInventoryItem, nextPage = 1, previous: WorldInventoryDetailResponse | null = null) => {
    setLocationLoading(true);
    setLocationError("");
    try {
      let currentSnapshotId = snapshotId || null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!currentSnapshotId) return;
        const query = new URLSearchParams({ page: String(nextPage), pageSize: "100", scope: context.scope, snapshotId: currentSnapshotId });
        if (context.ownerId) query.set("ownerId", context.ownerId);
        if (context.baseId) query.set("baseId", context.baseId);
        try {
          const next = await requestJson<WorldInventoryDetailResponse>(`/api/world/inventories/${encodeURIComponent(item.itemId)}?${query}`);
          if (next.snapshotId !== currentSnapshotId) {
            currentSnapshotId = await onSnapshotReplaced();
            continue;
          }
          setLocations(previous ? { ...next, locations: [...previous.locations, ...next.locations] } : next);
          break;
        } catch (caught) {
          if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED" && attempt === 0) {
            currentSnapshotId = await onSnapshotReplaced();
            continue;
          }
          throw caught;
        }
      }
    } catch (caught) {
      if (!isAbortError(caught)) setLocationError(caught instanceof Error ? caught.message : "物品位置读取失败");
    } finally {
      setLocationLoading(false);
    }
  }, [context, onSnapshotReplaced, snapshotId]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(search.trim());
  }

  function clearFilters() {
    setSearch("");
    setAppliedSearch("");
    setCategory("");
    setSort("name");
    setPage(1);
  }

  function toggleItem(item: WorldInventoryItem) {
    if (expanded?.itemId === item.itemId) {
      setExpanded(null);
      setLocations(null);
      return;
    }
    setExpanded(item);
    setLocations(null);
    void loadLocations(item);
  }

  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch || category || sort !== "name" || context.scope !== "all" || context.ownerId || context.baseId);
  const allUnknown = Boolean(result?.items.length) && result!.items.every((item) => !item.metadataKnown);

  return <section className="inventory-workspace" aria-label="仓库">
    <header className="inventory-heading">
      <div><h2>仓库</h2><p>按物品汇总当前存档快照中的玩家背包和据点库存；展开后才读取具体位置与槽位。</p></div>
      <span className="inventory-total">{result?.total ?? "-"} 种物品</span>
    </header>
    {context.label && <div className="inventory-context" role="status"><MapPin size={17} aria-hidden="true" /><span>当前仅显示：{context.label}</span><button className="world-clear-button" type="button" onClick={onClearContext}><X size={15} />返回全部仓库</button></div>}
    {allUnknown && <p className="inventory-metadata-warning" role="status">当前结果中的物品资料尚未收录；仍保留 Item ID、真实数量和全部位置。</p>}
    <form className="inventory-toolbar" onSubmit={submitSearch}>
      <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索物品" placeholder="搜索中文名称或 Item ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
      <button className="primary-button world-search-button" type="submit">搜索</button>
      <fieldset className="inventory-scope" aria-label="库存范围"><legend>范围</legend>{([ ["all", "全部"], ["player", "玩家"], ["base", "据点"] ] as const).map(([value, label]) => <button type="button" key={value} className={context.scope === value ? "active" : ""} onClick={() => { onContextChange({ scope: value }); setPage(1); }}>{label}</button>)}</fieldset>
      <label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>分类</span><select aria-label="物品分类筛选" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部分类</option>{(result?.categories || []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="world-control"><span>排序</span><select aria-label="仓库排序方式" value={sort} onChange={(event) => { setSort(event.target.value as InventorySort); setPage(1); }}><option value="name">名称</option><option value="quantity">总量（高到低）</option></select></label>
      {hasFilters && <button className="world-clear-button" type="button" onClick={clearFilters}><X size={15} />清除筛选</button>}
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="inventory-results" aria-live="polite" aria-busy={loading}>
      {loading ? <div className="inventory-loading"><LoaderCircle className="spin" size={20} />正在聚合仓库…</div> : result?.items.length ? result.items.map((item) => <article className="inventory-item" key={item.itemId} data-expanded={expanded?.itemId === item.itemId || undefined}>
        <button className="inventory-item-summary" type="button" aria-expanded={expanded?.itemId === item.itemId} onClick={() => toggleItem(item)}>
          <span className="inventory-item-icon" aria-hidden="true"><Archive size={20} /></span>
          <span className="inventory-item-main"><strong>{item.name || item.itemId}</strong><span className="inventory-item-meta"><code>{item.itemId}</code>{item.metadataLabel && <em>{item.metadataLabel}</em>}{item.category && <small>{item.category}</small>}{item.rarity && <small>{item.rarity}</small>}</span></span>
          <span className="inventory-item-number"><small>全世界总量</small><strong>{item.totalQuantity.toLocaleString()}</strong></span>
          <span className="inventory-item-number"><small>位置</small><strong>{item.locationCount.toLocaleString()}</strong></span>
          <ChevronDown className="inventory-chevron" size={19} aria-hidden="true" />
        </button>
        {expanded?.itemId === item.itemId && <section className="inventory-locations" aria-label={`${item.name || item.itemId}的位置`}>
          <h3>存放位置 <small>{locations?.total ?? item.locationCount}</small></h3>
          {locationError && <p className="form-error" role="alert">{locationError}</p>}
          {locationLoading && !locations ? <p className="inventory-location-loading"><LoaderCircle className="spin" size={16} />正在读取位置…</p> : locations?.locations.map((location) => <div className="inventory-location" key={location.id}><span><strong>{location.locationLabel}</strong><small>槽位 {location.slotIndex + 1}</small></span><strong>× {location.quantity.toLocaleString()}</strong><details><summary>技术信息</summary><code>containerId: {location.containerId || "资料未收录"}</code></details></div>)}
          {locations && locations.locations.length < locations.total && <button className="quiet-button inventory-more" type="button" disabled={locationLoading} onClick={() => void loadLocations(item, locations.page + 1, locations)}>加载更多位置</button>}
        </section>}
      </article>) : <div className="world-empty-state"><Archive size={22} /><strong>{result ? hasFilters ? "没有符合条件的物品" : "当前存档快照没有库存" : "正在读取仓库"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : "解析成功后，玩家和据点中的物品会在这里按总量聚合。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
    </div>
    <footer className="audit-footer inventory-footer"><span>共 {result?.total || 0} 种物品，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></footer>
  </section>;
}
