import { AlertCircle, Crown, LoaderCircle, Search, Sparkles, Star, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldPalDetail, WorldPalRosterItem, WorldPalRosterResponse, WorldRow } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { palTraitLabels, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { mergePalRosterPage } from "./palRosterState";

type Marker = "all" | "lucky" | "boss";
type Sort = "balanced" | "name" | "level";

const PAGE_SIZE = 60;
const locationLabels: Record<WorldPalRosterItem["locationType"], string> = {
  player: "玩家持有",
  party: "队伍携带",
  storage: "终端存放",
  base: "据点工作",
  unassigned: "未识别归属",
};

export function PalRoster({ snapshotId, onSnapshotReplaced }: { snapshotId: string | null | undefined; onSnapshotReplaced: () => Promise<string | null> }) {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [marker, setMarker] = useState<Marker>("all");
  const [sort, setSort] = useState<Sort>("balanced");
  const [items, setItems] = useState<WorldPalRosterItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);

  const loadPage = useCallback(async (page: number, append: boolean, requestedSnapshotId = snapshotId, retried = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError("");
    try {
      if (!requestedSnapshotId) {
        setItems([]);
        setTotal(0);
        return;
      }
      const query = new URLSearchParams({
        page: String(page), pageSize: String(PAGE_SIZE), marker, sort, snapshotId: requestedSnapshotId,
      });
      if (appliedSearch) query.set("search", appliedSearch);
      const result = await requestJson<WorldPalRosterResponse>(`/api/world/pals/roster?${query}`, { signal: controller.signal });
      if (sequence !== requestSequence.current || result.snapshotId !== requestedSnapshotId) return;
      setTotal(result.total);
      setItems((current) => mergePalRosterPage(current, result, requestedSnapshotId, append));
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED" && !retried) {
        let nextSnapshotId: string | null = null;
        try {
          nextSnapshotId = await onSnapshotReplaced();
        } catch {
          nextSnapshotId = null;
        }
        if (nextSnapshotId && sequence === requestSequence.current) {
          setItems([]);
          setTotal(0);
          await loadPage(page, false, nextSnapshotId, true);
          return;
        }
      }
      if (!isAbortError(caught) && sequence === requestSequence.current) {
        setError(caught instanceof Error ? caught.message : "帕鲁名册读取失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appliedSearch, marker, onSnapshotReplaced, snapshotId, sort]);

  useEffect(() => {
    setItems([]);
    setTotal(0);
    setDrawer(null);
    void loadPage(1, false);
    return () => requestRef.current?.abort();
  }, [loadPage]);

  const openDetail = useCallback(async (item: WorldPalRosterItem, trigger: HTMLButtonElement) => {
    returnFocusRef.current = trigger;
    setDrawer({ item, detail: null, loading: true, error: "" });
    try {
      if (!snapshotId) throw new Error("WORLD_CACHE_UNAVAILABLE: 当前没有可用的世界快照。");
      const detail = await requestJson<WorldPalDetail & { snapshotId: string }>(
        `/api/world/pals/${encodeURIComponent(item.id)}?snapshotId=${encodeURIComponent(snapshotId)}`,
      );
      setDrawer((current) => current?.item.id === item.id && detail.snapshotId === snapshotId
        ? { ...current, detail, loading: false } : current);
    } catch (caught) {
      if (!isAbortError(caught)) setDrawer((current) => current?.item.id === item.id
        ? { ...current, loading: false, error: caught instanceof Error ? caught.message : "帕鲁详情读取失败" } : current);
    }
  }, [snapshotId]);

  const closeDrawer = useCallback(() => {
    setDrawer(null);
    window.requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setAppliedSearch(search.trim());
  }

  function clearFilters() {
    setSearch("");
    setAppliedSearch("");
    setMarker("all");
    setSort("balanced");
  }

  const hasFilters = Boolean(appliedSearch) || marker !== "all" || sort !== "balanced";
  const canLoadMore = items.length < total;
  return <section className="pal-roster" aria-label="帕鲁名册">
    <header className="pal-roster-heading"><div><h2>帕鲁名册</h2><p>按稳定快照分批读取，临时照护状态不会改变默认名册顺序。</p></div><span>{total ? `已载入 ${items.length} / ${total}` : "等待快照"}</span></header>
    <form className="pal-roster-toolbar" onSubmit={submitSearch}>
      <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索帕鲁名册" placeholder="名称、Character ID 或内部 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
      <button className="primary-button world-search-button" type="submit">搜索</button>
      <div className="pal-roster-markers" aria-label="个体标记筛选">
        <button type="button" className={marker === "all" ? "active" : ""} aria-pressed={marker === "all"} onClick={() => setMarker("all")}>全部</button>
        <button type="button" className={marker === "lucky" ? "active" : ""} aria-pressed={marker === "lucky"} onClick={() => setMarker("lucky")}><Sparkles size={15} />闪光</button>
        <button type="button" className={marker === "boss" ? "active" : ""} aria-pressed={marker === "boss"} onClick={() => setMarker("boss")}><Crown size={15} />头目</button>
      </div>
      <label className="world-control"><span>排序</span><select aria-label="帕鲁名册排序" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="balanced">均衡</option><option value="name">名称</option><option value="level">等级</option></select></label>
      {hasFilters && <button className="world-clear-button" type="button" onClick={clearFilters}><X size={15} />清除已应用筛选</button>}
    </form>
    {error && <p className="form-error" role="alert">名册读取失败；已保留当前结果。<code>{error}</code></p>}
    <div className="pal-roster-table" aria-busy={loading} aria-live="polite">
      <div className="pal-roster-head"><span>帕鲁</span><span>等级</span><span>星级</span><span>个体标记</span><span>归属</span></div>
      {loading ? <PalRosterSkeleton /> : items.length ? items.map((item) => <PalRosterRow item={item} key={item.id} onOpen={openDetail} />) : <div className="world-empty-state"><Search size={22} /><strong>{snapshotId ? "没有符合条件的帕鲁" : "当前没有可用世界快照"}</strong><p>{snapshotId ? "尝试清除已应用筛选，或使用其他名称和 ID 搜索。" : "完成只读解析后可浏览名册。"}</p>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除已应用筛选</button>}</div>}
    </div>
    {canLoadMore && <button className="quiet-button pal-roster-more" type="button" disabled={loadingMore} onClick={() => void loadPage(Math.floor(items.length / PAGE_SIZE) + 1, true)}>{loadingMore ? <><LoaderCircle className="spin" size={17} />正在加载</> : `加载更多（还有 ${total - items.length} 条）`}</button>}
    <PalRosterDrawer state={drawer} onClose={closeDrawer} />
  </section>;
}

function PalRosterRow({ item, onOpen }: { item: WorldPalRosterItem; onOpen: (item: WorldPalRosterItem, trigger: HTMLButtonElement) => void }) {
  const pal = resolvePal(item as unknown as Record<string, unknown>);
  const location = item.locationType === "base" ? item.baseName || locationLabels.base : item.ownerName || locationLabels[item.locationType];
  return <div className="pal-roster-row">
    <button className="pal-roster-name" type="button" onClick={(event) => onOpen(item, event.currentTarget)}><span className="world-entity-avatar world-pal-avatar" data-icon-key={pal.known ? pal.characterId : "pal-placeholder"}><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span><span><strong>{pal.displayName}</strong><small>{pal.known ? pal.speciesName : pal.characterId}</small></span>{pal.gender && <span className={`world-pal-gender ${pal.gender}`} title={pal.gender === "male" ? "雄性" : "雌性"} aria-label={pal.gender === "male" ? "雄性" : "雌性"}>{pal.gender === "male" ? "♂" : "♀"}</span>}</button>
    <span data-label="等级">{item.level ?? "—"}</span>
    <span data-label="星级">{pal.rank && pal.rank > 0 ? <><Star size={14} fill="currentColor" />{pal.rank}</> : "—"}</span>
    <PalRosterTraits item={item} />
    <span className="pal-roster-location" data-label="归属"><strong>{locationLabels[item.locationType]}</strong><small>{location}</small></span>
  </div>;
}

function PalRosterTraits({ item }: { item: WorldPalRosterItem }) {
  const traits = palTraitLabels(item as unknown as Record<string, unknown>).filter((label) => label === "闪光" || label === "头目");
  return <span className="pal-roster-traits" data-label="个体标记">{traits.length ? traits.map((label) => <em key={label}>{label}</em>) : "普通"}</span>;
}

type DrawerState = { item: WorldPalRosterItem; detail: (WorldPalDetail & { snapshotId: string }) | null; loading: boolean; error: string };

function PalRosterDrawer({ state, onClose }: { state: DrawerState | null; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!state) return;
    const appRoot = document.getElementById("root");
    if (appRoot) appRoot.inert = true;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ) || [],
      );
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
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      if (appRoot) appRoot.inert = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, state]);
  if (!state) return null;
  const data = state.detail || state.item;
  const pal = resolvePal(data as unknown as Record<string, unknown>);
  return createPortal(<><button className="pal-roster-backdrop" type="button" tabIndex={-1} aria-label="关闭帕鲁详情遮罩" onClick={onClose} /><aside ref={drawerRef} className="pal-roster-drawer" role="dialog" aria-modal="true" aria-label="帕鲁详情"><header><div className="world-drawer-title"><span className="world-entity-avatar world-pal-avatar"><img src={pal.icon} alt="" /></span><div><h2>{pal.displayName}</h2><p>{pal.speciesName}</p></div></div><button ref={closeRef} className="icon-button bordered" type="button" aria-label="关闭帕鲁详情" title="关闭详情" onClick={onClose}><X size={18} /></button></header>{state.loading ? <div className="pal-roster-drawer-state"><LoaderCircle className="spin" size={24} /><strong>正在读取帕鲁详情</strong><p>名册结果仍保留，可随时关闭。</p></div> : state.error ? <div className="pal-roster-drawer-state error" role="alert"><AlertCircle size={24} /><strong>详情读取失败</strong><p>已保留名册结果。请关闭后重试，或检查当前快照状态。</p><code>{state.error}</code></div> : <PalRosterDetail data={data} pal={pal} />}</aside></>, document.body);
}

function PalRosterDetail({ data, pal }: { data: WorldPalDetail | WorldPalRosterItem; pal: ReturnType<typeof resolvePal> }) {
  const record = data as unknown as WorldRow;
  const location = "locationType" in data ? locationLabels[data.locationType] : value(record.locationType) || value(record.assignment);
  return <div className="pal-roster-detail"><dl className="world-detail-grid"><div><dt>等级</dt><dd>{value(record.level)}</dd></div><div><dt>星级</dt><dd>{pal.rank ?? "—"}</dd></div><div><dt>归属</dt><dd>{location}</dd></div><div><dt>主人</dt><dd>{value(record.ownerName) || value((record.owner as WorldRow | undefined)?.name)}</dd></div><div><dt>据点</dt><dd>{value(record.baseName) || value((record.base as WorldRow | undefined)?.name)}</dd></div><div><dt>Character ID</dt><dd><code>{pal.characterId}</code></dd></div><div><dt>内部 ID</dt><dd><code>{value(record.id)}</code></dd></div></dl><section className="world-relation-section"><h3>个体标记</h3><p>{palTraitLabels(record).join(" · ") || "普通"}</p></section><details className="world-relation-section world-raw-detail"><summary>原始记录</summary><pre className="world-detail-json">{JSON.stringify(record.detail || record, null, 2)}</pre></details></div>;
}

function PalRosterSkeleton() {
  return <div className="pal-roster-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function value(value: unknown): string {
  return value === null || value === undefined || value === "" ? "未关联" : String(value);
}
