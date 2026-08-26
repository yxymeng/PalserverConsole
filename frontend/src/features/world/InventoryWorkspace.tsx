import { Archive, ChevronDown, ChevronLeft, ChevronRight, LoaderCircle, MapPin, Search, SlidersHorizontal, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldInventoryDetailResponse, WorldInventoryItem, WorldInventoryLocationGroup, WorldInventoryResponse, WorldInventoryScope } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";

export type InventoryContext = {
  scope: WorldInventoryScope;
  ownerId?: string;
  baseId?: string;
  guildId?: string;
  label?: string;
  metadata?: "unknown";
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
  const [expandedGroup, setExpandedGroup] = useState<WorldInventoryLocationGroup | null>(null);
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
        if (context.guildId) query.set("guildId", context.guildId);
        if (context.metadata) query.set("metadata", context.metadata);
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
    setExpandedGroup(null);
    setLocationError("");
  }, [snapshotId, context]);

  const loadLocations = useCallback(async (item: WorldInventoryItem, group: WorldInventoryLocationGroup | null, nextPage = 1, previous: WorldInventoryDetailResponse | null = null) => {
    setLocationLoading(true);
    setLocationError("");
    try {
      let currentSnapshotId = snapshotId || null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!currentSnapshotId) return;
        const query = new URLSearchParams({ page: String(nextPage), pageSize: group ? "100" : "1", scope: context.scope, snapshotId: currentSnapshotId });
        if (context.ownerId) query.set("ownerId", context.ownerId);
        if (context.baseId) query.set("baseId", context.baseId);
        if (context.guildId) query.set("guildId", context.guildId);
        if (group) {
          query.set("locationType", group.locationType);
          if (group.groupId) query.set("groupId", group.groupId);
        }
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
      setExpandedGroup(null);
      return;
    }
    setExpanded(item);
    setLocations(null);
    setExpandedGroup(null);
    void loadLocations(item, null);
  }

  function toggleGroup(item: WorldInventoryItem, group: WorldInventoryLocationGroup) {
    if (expandedGroup?.locationType === group.locationType && expandedGroup.groupId === group.groupId) {
      setExpandedGroup(null);
      return;
    }
    setExpandedGroup(group);
    setLocations((current) => current ? { ...current, locations: [], page: 1, total: group.locationCount } : current);
    void loadLocations(item, group);
  }

  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  const hasFilters = Boolean(appliedSearch || category || sort !== "name" || context.scope !== "inventory" || context.ownerId || context.baseId || context.guildId);
  const allUnknown = Boolean(result?.items.length) && result!.items.every((item) => !item.metadataKnown);
  const quantityLabel = ({ inventory: "库存总量", player: "玩家总量", base: "据点总量", world: "世界容器总量", all: "全世界总量" } as const)[context.scope];

  return <section className="inventory-workspace" aria-label="仓库">
    <header className="inventory-heading">
      <div><h2>仓库</h2><p>按物品汇总当前存档快照中的玩家背包、据点和公会仓库；世界容器可单独查看。</p></div>
      <span className="inventory-total">{result?.total ?? "-"} 种物品</span>
    </header>
    {context.label && <div className="inventory-context" role="status"><MapPin size={17} aria-hidden="true" /><span>当前仅显示：{context.label}</span><button className="world-clear-button" type="button" onClick={onClearContext}><X size={15} />返回全部仓库</button></div>}
    {allUnknown && <p className="inventory-metadata-warning" role="status">当前结果中的物品资料尚未收录；仍保留 Item ID、真实数量和全部位置。</p>}
    <form className="inventory-toolbar" onSubmit={submitSearch}>
      <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索物品" placeholder="搜索中文名称或 Item ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
      <button className="primary-button world-search-button" type="submit">搜索</button>
      <fieldset className="inventory-scope" aria-label="库存范围"><legend>范围</legend>{([ ["inventory", "库存"], ["player", "玩家"], ["base", "据点"], ["world", "世界"], ["all", "全部"] ] as const).map(([value, label]) => <button type="button" key={value} className={context.scope === value ? "active" : ""} aria-pressed={context.scope === value} onClick={() => { onContextChange({ scope: value }); setPage(1); }}>{label}</button>)}</fieldset>
      <label className="world-control"><SlidersHorizontal size={16} aria-hidden="true" /><span>分类</span><select aria-label="物品分类筛选" value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}><option value="">全部分类</option>{(result?.categories || []).map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="world-control"><span>排序</span><select aria-label="仓库排序方式" value={sort} onChange={(event) => { setSort(event.target.value as InventorySort); setPage(1); }}><option value="name">名称</option><option value="quantity">总量（高到低）</option></select></label>
      {hasFilters && <button className="world-clear-button" type="button" onClick={clearFilters}><X size={15} />清除筛选</button>}
    </form>
    {error && <section className="world-request-failure" role="alert"><Archive size={18} aria-hidden="true" /><div><strong>仓库请求失败</strong><p>当前页面没有写入任何存档；请检查连接或快照状态后重试。</p><code>{error}</code></div><button className="quiet-button" type="button" onClick={() => void load()}>重新尝试</button></section>}
    <div className="inventory-results" aria-live="polite" aria-busy={loading}>
      {loading ? <div className="inventory-loading"><LoaderCircle className="spin" size={20} />正在聚合仓库…</div> : result?.items.length ? result.items.map((item) => <article className="inventory-item" key={item.itemId} data-expanded={expanded?.itemId === item.itemId || undefined}>
        <button className="inventory-item-summary" type="button" aria-expanded={expanded?.itemId === item.itemId} onClick={() => toggleItem(item)}>
          <span className="inventory-item-icon" aria-hidden="true"><Archive size={20} /></span>
          <span className="inventory-item-main"><strong>{item.name || item.itemId}</strong><span className="inventory-item-meta"><code>{item.itemId}</code>{item.metadataLabel && <em>{item.metadataLabel}</em>}{item.category && <small>{item.category}</small>}{item.rarity && <small>{item.rarity}</small>}</span></span>
          <span className="inventory-item-number"><small>{quantityLabel}</small><strong>{item.totalQuantity.toLocaleString()}</strong></span>
          <span className="inventory-item-number"><small>存放记录</small><strong>{item.locationCount.toLocaleString()}</strong></span>
          <ChevronDown className="inventory-chevron" size={19} aria-hidden="true" />
        </button>
        {expanded?.itemId === item.itemId && <section className="inventory-locations" aria-label={`${item.name || item.itemId}的存放分布`}>
          <h3>存放分布 <small>{item.locationCount} 条记录</small></h3>
          {locationError && <section className="world-request-failure compact" role="alert"><Archive size={17} aria-hidden="true" /><div><strong>存放分布读取失败</strong><p>已保留仓库汇总；请重试读取此物品的位置。</p><code>{locationError}</code></div><button className="quiet-button" type="button" onClick={() => void loadLocations(item, expandedGroup)}>重新读取位置</button></section>}
          {locationLoading && !locations ? <p className="inventory-location-loading"><LoaderCircle className="spin" size={16} />正在汇总存放分布…</p> : locations?.groups.map((group) => {
            const groupExpanded = expandedGroup?.locationType === group.locationType && expandedGroup.groupId === group.groupId;
            const countLabel = group.locationType === "world" ? `${group.containerCount}处` : group.locationType === "unassigned" ? `${group.locationCount}条` : null;
            return <div className="inventory-location-group" key={`${group.locationType}:${group.groupId || "all"}`} data-expanded={groupExpanded || undefined}>
              <button className="inventory-location-group-summary" type="button" aria-expanded={groupExpanded} onClick={() => toggleGroup(item, group)}>
                <span><strong>{group.label}</strong>{countLabel && <small>{countLabel}</small>}</span><strong>× {group.quantitySum.toLocaleString()}</strong><ChevronDown size={18} aria-hidden="true" />
              </button>
              {groupExpanded && <div className="inventory-location-details">
                {locationLoading ? <p className="inventory-location-loading"><LoaderCircle className="spin" size={16} />正在读取位置…</p> : locations.locations.map((location) => <div className="inventory-location" key={location.id}>
                  <span><strong>{location.locationLabel}</strong><small>槽位 {location.slotIndex + 1}</small></span><strong>× {location.quantity.toLocaleString()}</strong>
                  <details><summary>技术信息</summary><dl><div><dt>Container ID</dt><dd><code>{location.containerId || "资料未收录"}</code></dd></div>{location.mapObjectType && <div><dt>类型</dt><dd><code>{location.mapObjectType}</code></dd></div>}{location.mapObjectInstanceId && <div><dt>MapObject Instance ID</dt><dd><code>{location.mapObjectInstanceId}</code></dd></div>}{location.worldPosition && <div><dt>世界坐标</dt><dd>{location.worldPosition.x.toLocaleString()} / {location.worldPosition.y.toLocaleString()} / {location.worldPosition.z.toLocaleString()}</dd></div>}</dl></details>
                </div>)}
                {locations.locations.length < locations.total && <button className="quiet-button inventory-more" type="button" disabled={locationLoading} onClick={() => void loadLocations(item, group, locations.page + 1, locations)}>加载更多位置</button>}
              </div>}
            </div>;
          })}
        </section>}
      </article>) : <div className="world-empty-state"><Archive size={22} /><strong>{result ? hasFilters ? "没有符合条件的物品" : "当前存档快照没有库存" : snapshotId ? "正在读取仓库" : "当前没有可用世界快照"}</strong><p>{hasFilters ? "清除搜索或筛选条件后再试。" : snapshotId ? "解析成功后，玩家、据点和公会仓库中的物品会在这里按总量聚合。" : "完成只读解析后可浏览仓库；错误状态会保留在快照条中。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选条件</button>}</div>}
    </div>
    <footer className="audit-footer inventory-footer"><span>共 {result?.total || 0} 种物品，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" type="button" title="上一页" disabled={page <= 1 || loading} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" type="button" title="下一页" disabled={page >= totalPages || loading} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></footer>
  </section>;
}
