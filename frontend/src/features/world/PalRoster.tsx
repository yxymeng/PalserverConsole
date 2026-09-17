import { AlertCircle, ChevronDown, ChevronRight, CircleAlert, Crown, Filter, HeartPulse, LoaderCircle, RotateCcw, Search, ShieldCheck, SlidersHorizontal, Sparkles, Star, X } from "lucide-react";
import { createPortal } from "react-dom";
import { MobileSheetHandle } from "../../components/ui/mobile-sheet-handle";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldMetadataStatus, WorldPalAptitude, WorldPalCare, WorldPalDetail, WorldPalRosterItem, WorldPalRosterResponse, WorldPalSkill, WorldPalSkills } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { useIsMobile } from "../../hooks/use-mobile";
import { matchingPalCharacterIds, palTraitLabels, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { mergePalRosterPage } from "./palRosterState";
import { careReasonLabels, careSummaryLabel } from "./palCare";
import { PalDetailModal } from "./PalDetailModal";
import { workSuitabilityLabels } from "./palWorkLabels";

type Marker = "all" | "lucky" | "boss";
type CareFilter = "all" | "attention";
type LocationFilter = "all" | "player" | "party" | "storage" | "base" | "unassigned";
export type PalRosterContext = { marker?: Marker; care?: CareFilter; location?: LocationFilter; label?: string; token: number };
type Sort = "balanced" | "name" | "level" | "rarity" | "averageIv" | "workSuitability";
type AptitudeFilters = {
  minLevel: string; minRank: string; minRarity: string;
  minHpIv: string; minAttackIv: string; minDefenseIv: string; minAverageIv: string;
  workSuitabilities: string[]; passiveSkills: string[]; minWorkLevel: string;
  passiveMatch: "all" | "any"; excludeNegativePassives: boolean;
};
type UpdateAptitude = <K extends keyof AptitudeFilters>(key: K, value: AptitudeFilters[K]) => void;

const PAGE_SIZE = 60;
const EMPTY_APTITUDE_FILTERS: AptitudeFilters = { minLevel: "", minRank: "", minRarity: "", minHpIv: "", minAttackIv: "", minDefenseIv: "", minAverageIv: "", workSuitabilities: [], passiveSkills: [], minWorkLevel: "1", passiveMatch: "all", excludeNegativePassives: false };
const PASSIVE_PRESETS = [
  { name: "四金极速坐骑", icon: "🚀", skills: ["传说", "神速", "运动健将", "疾风"], match: "all" as const },
  { name: "传说 + 运动健将", icon: "⚡", skills: ["传说", "运动健将"], match: "all" as const },
  { name: "流水线天花板", icon: "🏭", skills: ["工匠精神", "社畜", "认真", "稀有"], match: "all" as const },
  { name: "四金极限纯攻", icon: "⚔️", skills: ["传说", "脑筋", "凶猛", "稀有"], match: "all" as const },
  { name: "不朽重装肉盾", icon: "🛡️", skills: ["传说", "顽强肉体", "突袭指挥官", "铁壁军师"], match: "all" as const },
  { name: "神速 + 健将赶路", icon: "💨", skills: ["神速", "运动健将"], match: "all" as const },
  { name: "各系帝王", icon: "🔥", skills: ["炎帝", "海皇", "雷帝", "冥王", "冰帝", "地帝", "神龙", "圣天", "精灵王"], match: "any" as const },
  { name: "纯净零负面词条", icon: "✨", skills: [], match: "all" as const },
];
const locationLabels: Record<WorldPalRosterItem["locationType"], string> = {
  player: "玩家持有",
  party: "队伍携带",
  storage: "终端存放",
  base: "据点工作",
  unassigned: "未识别归属",
};

export function PalRoster({ snapshotId, context, onSnapshotReplaced, onNavigate }: { snapshotId: string | null | undefined; context?: PalRosterContext; onSnapshotReplaced: () => Promise<string | null>; onNavigate?: (resource: "players" | "bases", id: string) => void }) {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [marker, setMarker] = useState<Marker>("all");
  const [care, setCare] = useState<CareFilter>("all");
  const [location, setLocation] = useState<LocationFilter>("all");
  const [sort, setSort] = useState<Sort>("balanced");
  const [draftAptitude, setDraftAptitude] = useState<AptitudeFilters>(EMPTY_APTITUDE_FILTERS);
  const [appliedAptitude, setAppliedAptitude] = useState<AptitudeFilters>(EMPTY_APTITUDE_FILTERS);
  const [items, setItems] = useState<WorldPalRosterItem[]>([]);
  const [total, setTotal] = useState(0);
  const [careSummary, setCareSummary] = useState<WorldPalRosterResponse["careSummary"] | null>(null);
  const [passiveSkillOptions, setPassiveSkillOptions] = useState<WorldPalSkill[]>([]);
  const [metadata, setMetadata] = useState<WorldMetadataStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [desktopAptitudeFiltersOpen, setDesktopAptitudeFiltersOpen] = useState(false);
  const [mobileAptitudeFiltersOpen, setMobileAptitudeFiltersOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const mobileAptitudeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const isMobile = useIsMobile();

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
        page: String(page), pageSize: String(PAGE_SIZE), marker, care, sort, snapshotId: requestedSnapshotId,
      });
      if (appliedSearch) {
        query.set("search", appliedSearch);
        const characterIds = matchingPalCharacterIds(appliedSearch);
        if (characterIds.length) query.set("characterId", characterIds.join(","));
      }
      if (location !== "all") query.set("location", location);
      for (const key of ["minLevel", "minRank", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const) {
        if (appliedAptitude[key]) query.set(key, appliedAptitude[key]);
      }
      if (appliedAptitude.workSuitabilities.length) {
        query.set("workSuitability", appliedAptitude.workSuitabilities.join(","));
        query.set("minWorkLevel", appliedAptitude.minWorkLevel || "1");
      }
      if (appliedAptitude.passiveSkills.length) query.set("passiveSkill", appliedAptitude.passiveSkills.join(","));
      if (appliedAptitude.passiveSkills.length) query.set("passiveMatch", appliedAptitude.passiveMatch);
      if (appliedAptitude.excludeNegativePassives) query.set("excludeNegativePassives", "true");
      const result = await requestJson<WorldPalRosterResponse>(`/api/world/pals/roster?${query}`, { signal: controller.signal });
      if (sequence !== requestSequence.current || result.snapshotId !== requestedSnapshotId) return;
      setTotal(result.total);
      setCareSummary(result.careSummary);
      setPassiveSkillOptions(result.passiveSkills || []);
      setMetadata(result.metadata);
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
        setError(caught instanceof Error ? caught.message : "帕鲁图鉴花名册读取失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appliedAptitude, appliedSearch, care, location, marker, onSnapshotReplaced, snapshotId, sort]);

  useEffect(() => {
    if (!context) return;
    setSearch("");
    setAppliedSearch("");
    setMarker(context.marker || "all");
    setCare(context.care || "all");
    setLocation(context.location || "all");
    setSort("balanced");
    setDraftAptitude(EMPTY_APTITUDE_FILTERS);
    setAppliedAptitude(EMPTY_APTITUDE_FILTERS);
  }, [context]);

  useEffect(() => {
    setItems([]);
    setTotal(0);
    setCareSummary(null);
    setPassiveSkillOptions([]);
    setMetadata(null);
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
    applyFilters();
  }

  function applyFilters() {
    setAppliedSearch(search.trim());
    setAppliedAptitude({
      ...draftAptitude,
      workSuitabilities: [...draftAptitude.workSuitabilities],
      passiveSkills: [...draftAptitude.passiveSkills],
    });
    if (mobileAptitudeFiltersOpen) closeMobileAptitudeFilters();
  }

  function closeMobileAptitudeFilters() {
    setMobileAptitudeFiltersOpen(false);
    window.requestAnimationFrame(() => mobileAptitudeTriggerRef.current?.focus());
  }

  function clearFilters() {
    setSearch("");
    setAppliedSearch("");
    setMarker("all");
    setCare("all");
    setLocation("all");
    setSort("balanced");
    setDraftAptitude(EMPTY_APTITUDE_FILTERS);
    setAppliedAptitude(EMPTY_APTITUDE_FILTERS);
  }

  function updateAptitude<K extends keyof AptitudeFilters>(key: K, value: AptitudeFilters[K]) {
    setDraftAptitude((current) => ({ ...current, [key]: value }));
  }

  function removeAppliedAptitude(key: keyof Omit<AptitudeFilters, "workSuitabilities" | "minWorkLevel">) {
    setDraftAptitude((current) => ({ ...current, [key]: "" }));
    setAppliedAptitude((current) => ({ ...current, [key]: "" }));
  }

  function removeWorkSuitability(type: string) {
    const remove = (current: AptitudeFilters) => ({ ...current, workSuitabilities: current.workSuitabilities.filter((name) => name !== type) });
    setDraftAptitude(remove);
    setAppliedAptitude(remove);
  }

  function removePassiveSkill(skillId: string) {
    const remove = (current: AptitudeFilters) => ({ ...current, passiveSkills: current.passiveSkills.filter((id) => id !== skillId) });
    setDraftAptitude(remove);
    setAppliedAptitude(remove);
  }

  function setQuickWorkSuitability(value: string) {
    const workSuitabilities = value === "all" ? [] : [value];
    setDraftAptitude((current) => ({ ...current, workSuitabilities }));
    setAppliedAptitude((current) => ({ ...current, workSuitabilities }));
  }

  function applyPassivePreset(names: string[], passiveMatch: "all" | "any") {
    const passiveSkills = names.map((name) => passiveSkillOptions.find((skill) => skillDisplayName(skill) === name)?.id || name);
    setDraftAptitude((current) => ({ ...current, passiveSkills, passiveMatch, excludeNegativePassives: true }));
    setAppliedAptitude((current) => ({ ...current, passiveSkills, passiveMatch, excludeNegativePassives: true }));
  }

  const hasAptitudeFilters = Object.entries(appliedAptitude).some(([key, value]) => ["workSuitabilities", "passiveSkills"].includes(key) ? (value as string[]).length > 0 : !["minWorkLevel", "passiveMatch"].includes(key) && Boolean(value));
  const hasFilters = Boolean(appliedSearch) || marker !== "all" || care !== "all" || location !== "all" || sort !== "balanced" || hasAptitudeFilters;
  const canLoadMore = items.length < total;
  return <section className="pal-roster" aria-label="帕鲁图鉴花名册">
    <header className="world-module-heading pal-roster-heading"><h2>帕鲁图鉴花名册</h2><span className="world-module-total">{total ? `已载入 ${items.length} / ${total} 只` : "等待快照"}</span></header>
    {context?.label && <p className="world-navigation-context" role="status">当前来自总览：{context.label}</p>}
    {metadata?.status === "unavailable" && <p className="pal-metadata-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><span>固定版本元数据当前不可用；名册仍保持只读可浏览，稀有度和工作适应性显示为“资料未收录”。</span><code>{metadata.errorCode || "WORLD_METADATA_UNAVAILABLE"}</code></p>}
    <form className="pal-roster-toolbar" onSubmit={submitSearch}>
      <div className="pal-filter-search-row">
        <div className="world-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索帕鲁图鉴花名册" placeholder="搜索帕鲁名称、昵称、被动词条或所属训练家..." value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} />{search && <button type="button" aria-label="清空搜索" onClick={() => { setSearch(""); setAppliedSearch(""); }}><X size={14} /></button>}</div>
        <button className="primary-button world-search-button" type="submit">搜索</button>
      </div>
      {appliedSearch && <div className="pal-active-search"><Sparkles size={14} /><span>当前正在筛选：<strong>「{appliedSearch}」</strong>（现存 {total} 只）</span><button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); }}><X size={13} />清除筛选</button></div>}
      <div className="pal-filter-quick-row">
        <label><span>工作技能:</span><select aria-label="工作技能筛选" value={appliedAptitude.workSuitabilities.length === 1 ? appliedAptitude.workSuitabilities[0] : "all"} onChange={(event) => setQuickWorkSuitability(event.target.value)}><option value="all">全部工作技能</option>{Object.entries(workSuitabilityLabels).map(([value, label]) => <option value={value} key={value}>{workSuitabilityIcons[value] || "⚙️"} {label}</option>)}</select></label>
        <label><span>存放位置:</span><select aria-label="帕鲁存放位置筛选" value={location} onChange={(event) => setLocation(event.target.value as LocationFilter)}><option value="all">全部位置</option><option value="party">🎒 随身队伍</option><option value="base">🏰 据点打工</option><option value="storage">📦 帕鲁终端</option><option value="unassigned">未识别归属</option></select></label>
        <div className="pal-roster-markers" aria-label="个体标记与照护筛选">
          <button type="button" className={marker === "boss" ? "boss active" : "boss"} aria-pressed={marker === "boss"} onClick={() => setMarker((value) => value === "boss" ? "all" : "boss")}><Crown size={14} />仅头目</button>
          <button type="button" className={marker === "lucky" ? "lucky active" : "lucky"} aria-pressed={marker === "lucky"} onClick={() => setMarker((value) => value === "lucky" ? "all" : "lucky")}><Sparkles size={14} />仅稀有闪光</button>
          <button type="button" className={care === "attention" ? "attention active" : "attention"} aria-pressed={care === "attention"} onClick={() => setCare((value) => value === "attention" ? "all" : "attention")}><HeartPulse size={14} />需要关注{careSummary ? ` ${careSummary.attention}` : ""}</button>
        </div>
        <label className="pal-filter-sort"><span>排序:</span><select aria-label="帕鲁图鉴花名册排序" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="balanced">均衡</option><option value="name">名称</option><option value="level">等级</option><option value="rarity">物种稀有度</option><option value="averageIv">平均个体值</option><option value="workSuitability">工作适应性</option></select></label>
      </div>
    </form>
    {isMobile ? <section className="pal-aptitude-filters pal-advanced-filter-mobile"><button ref={mobileAptitudeTriggerRef} className="pal-aptitude-trigger pal-advanced-summary" type="button" onClick={() => setMobileAptitudeFiltersOpen(true)}><SlidersHorizontal size={15} /><span>词条组合高级筛选</span>{hasAptitudeFilters && <small>已命中 {total} 只</small>}<span className="pal-advanced-action"><Filter size={14} />高级筛选<ChevronDown size={14} /></span></button><PassivePresetBar onSelect={applyPassivePreset} /></section> : <section className={`pal-aptitude-filters ${desktopAptitudeFiltersOpen ? "open" : ""}`}>
      <button className="pal-advanced-summary" type="button" aria-expanded={desktopAptitudeFiltersOpen} onClick={() => setDesktopAptitudeFiltersOpen((open) => !open)}><SlidersHorizontal size={15} /><span>词条组合高级筛选</span>{hasAptitudeFilters && <small>已命中 {total} 只</small>}<span className="pal-advanced-action"><Filter size={14} />高级筛选<ChevronDown size={14} /></span></button>
      <PassivePresetBar onSelect={applyPassivePreset} />
      {desktopAptitudeFiltersOpen && <form onSubmit={(event) => { event.preventDefault(); applyFilters(); }}><AptitudeFilterFields filters={draftAptitude} passiveSkillOptions={passiveSkillOptions} onUpdate={updateAptitude} /></form>}
    </section>}
    {hasFilters && <div className="pal-applied-filters" aria-label="已应用筛选">
      <span>已应用</span>
      {appliedSearch && <button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); }}>搜索：{appliedSearch}<X size={13} /></button>}
      {marker !== "all" && <button type="button" onClick={() => setMarker("all")}>{marker === "lucky" ? "闪光" : "头目"}<X size={13} /></button>}
      {care !== "all" && <button type="button" onClick={() => setCare("all")}>需要关注<X size={13} /></button>}
      {location !== "all" && <button type="button" onClick={() => setLocation("all")}>未归属帕鲁<X size={13} /></button>}
      {sort !== "balanced" && <button type="button" onClick={() => setSort("balanced")}>排序：{{ name: "名称", level: "等级", rarity: "物种稀有度", averageIv: "平均个体值", workSuitability: "工作适应性" }[sort]}<X size={13} /></button>}
      {(["minLevel", "minRank", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const).map((key) => appliedAptitude[key] && <button type="button" key={key} onClick={() => removeAppliedAptitude(key)}>{{ minLevel: "等级", minRank: "星级", minRarity: "稀有度", minHpIv: "生命个体值", minAttackIv: "攻击个体值", minDefenseIv: "防御个体值", minAverageIv: "平均个体值" }[key]} ≥ {appliedAptitude[key]}<X size={13} /></button>)}
      {appliedAptitude.workSuitabilities.map((type) => <button type="button" key={type} onClick={() => removeWorkSuitability(type)}>{workSuitabilityLabels[type] || type} ≥ {appliedAptitude.minWorkLevel || "1"} 级<X size={13} /></button>)}
      {appliedAptitude.passiveSkills.map((id) => <button type="button" key={id} onClick={() => removePassiveSkill(id)}>{skillDisplayName(passiveSkillOptions.find((skill) => skill.id === id) || { id, name: null, description: null, sourceName: null, rank: null, element: null, power: null, cooldown: null, metadataKnown: false })}<X size={13} /></button>)}
      {appliedAptitude.excludeNegativePassives && <button type="button" onClick={() => { updateAptitude("excludeNegativePassives", false); setAppliedAptitude((current) => ({ ...current, excludeNegativePassives: false })); }}>过滤负面词条<X size={13} /></button>}
      <button className="pal-applied-reset" type="button" onClick={clearFilters}><RotateCcw size={13} />重置全部</button>
    </div>}
    {error && <section className="world-request-failure" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>帕鲁图鉴花名册请求失败</strong><p>已保留当前结果；请检查连接或快照状态后重试。</p><code>{error}</code></div><button className="quiet-button" type="button" onClick={() => void loadPage(1, false)}>重新尝试</button></section>}
    <div className="pal-roster-table pal-roster-cards" aria-busy={loading} aria-live="polite">
      <div className="pal-roster-head"><span>帕鲁</span><span>等级 / 星级</span><span>资质</span><span>工作适应性</span><span>被动技能</span><span>个体标记</span><span>照护状态</span><span>归属</span></div>
      {loading ? <PalRosterSkeleton /> : items.length ? items.map((item) => <PalRosterRow item={item} key={item.id} onOpen={openDetail} />) : <div className="world-empty-state"><Search size={22} /><strong>{snapshotId ? "未找到符合当前条件的帕鲁" : "当前没有可用世界快照"}</strong>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选</button>}</div>}
    </div>
    {canLoadMore && <button className="quiet-button pal-roster-more" type="button" disabled={loadingMore} onClick={() => void loadPage(Math.floor(items.length / PAGE_SIZE) + 1, true)}>{loadingMore ? <><LoaderCircle className="spin" size={17} />正在加载</> : `加载更多（还有 ${total - items.length} 条）`}</button>}
    <PalRosterDrawer state={drawer} onClose={closeDrawer} onNavigate={(target, id) => { closeDrawer(); onNavigate?.(target, id); }} onFindSameSpecies={(item) => { const species = resolvePal(item).speciesName; closeDrawer(); setSearch(species); setAppliedSearch(species); }} />
    {isMobile && <MobileAptitudeFilters open={mobileAptitudeFiltersOpen} filters={draftAptitude} passiveSkillOptions={passiveSkillOptions} onUpdate={updateAptitude} onApply={applyFilters} onClose={closeMobileAptitudeFilters} />}
  </section>;
}

function PassivePresetBar({ onSelect }: { onSelect: (names: string[], match: "all" | "any") => void }) {
  return <div className="pal-passive-presets"><strong>⚡ 快捷预设:</strong>{PASSIVE_PRESETS.map((preset) => <button type="button" key={preset.name} onClick={() => onSelect(preset.skills, preset.match)}><span>{preset.icon}</span>{preset.name}</button>)}</div>;
}

function AptitudeFilterFields({ filters, passiveSkillOptions, onUpdate }: { filters: AptitudeFilters; passiveSkillOptions: WorldPalSkill[]; onUpdate: UpdateAptitude }) {
  return <div className="pal-aptitude-filter-grid">
    {([
      ["minLevel", "最低等级", 0], ["minRank", "最低星级", 0], ["minRarity", "最低物种稀有度", 0],
      ["minHpIv", "最低生命个体值", 0], ["minAttackIv", "最低攻击个体值", 0], ["minDefenseIv", "最低防御个体值", 0], ["minAverageIv", "最低平均个体值", 0],
    ] as const).map(([key, label, min]) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min={min} max={key.includes("Iv") ? 100 : undefined} inputMode="numeric" value={filters[key]} onChange={(event) => onUpdate(key, event.target.value)} placeholder="不限" /></label>)}
    <fieldset className="pal-work-filter"><legend>工作适应性</legend><label className="pal-work-level"><span>每项至少</span><select aria-label="最低工作等级" value={filters.minWorkLevel} onChange={(event) => onUpdate("minWorkLevel", event.target.value)}>{Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 级</option>)}</select></label><div>{Object.entries(workSuitabilityLabels).map(([type, label]) => <label key={type}><input type="checkbox" checked={filters.workSuitabilities.includes(type)} onChange={() => onUpdate("workSuitabilities", filters.workSuitabilities.includes(type) ? filters.workSuitabilities.filter((name) => name !== type) : [...filters.workSuitabilities, type])} /><span>{label}</span></label>)}</div></fieldset>
    <fieldset className="pal-passive-filter"><legend>被动技能</legend><div className="pal-passive-filter-mode"><span>匹配方式</span><button type="button" className={filters.passiveMatch === "all" ? "active" : ""} onClick={() => onUpdate("passiveMatch", "all")}>全部满足 AND</button><button type="button" className={filters.passiveMatch === "any" ? "active" : ""} onClick={() => onUpdate("passiveMatch", "any")}>满足任一 OR</button><button type="button" className={filters.excludeNegativePassives ? "negative active" : "negative"} onClick={() => onUpdate("excludeNegativePassives", !filters.excludeNegativePassives)}><ShieldCheck size={13} />过滤负面词条</button></div>{passiveSkillOptions.length ? <div>{passiveSkillOptions.map((skill) => <label key={skill.id}><input type="checkbox" checked={filters.passiveSkills.includes(skill.id)} onChange={() => onUpdate("passiveSkills", filters.passiveSkills.includes(skill.id) ? filters.passiveSkills.filter((id) => id !== skill.id) : [...filters.passiveSkills, skill.id])} /><span>{skillDisplayName(skill)}</span>{skill.rank !== null && <small>阶级 {skill.rank}</small>}</label>)}</div> : <p className="pal-passive-empty">当前快照没有可筛选的被动技能。</p>}</fieldset>
    <button className="primary-button pal-aptitude-apply" type="submit">应用资质筛选</button>
  </div>;
}

function MobileAptitudeFilters({ open, filters, passiveSkillOptions, onUpdate, onApply, onClose }: { open: boolean; filters: AptitudeFilters; passiveSkillOptions: WorldPalSkill[]; onUpdate: UpdateAptitude; onApply: () => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    if (!open) return;
    const appRoot = document.getElementById("root");
    const focusableSelector = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) || []);
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
    if (appRoot) appRoot.inert = true;
    window.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      if (appRoot) appRoot.inert = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<><button className="pal-aptitude-backdrop" type="button" tabIndex={-1} aria-label="关闭高级筛选遮罩" onClick={onClose} /><aside ref={dialogRef} className="pal-aptitude-filters pal-aptitude-filter-layer" role="dialog" aria-modal="true" aria-label="资质、工作与被动技能"><MobileSheetHandle onDismiss={onClose} /><header><h3>词条组合高级筛选</h3><button ref={closeRef} className="icon-button bordered" type="button" aria-label="关闭高级筛选" onClick={onClose}><X size={18} /></button></header><form onSubmit={(event) => { event.preventDefault(); onApply(); }}><AptitudeFilterFields filters={filters} passiveSkillOptions={passiveSkillOptions} onUpdate={onUpdate} /></form></aside></>, document.body);
}

function PalRosterRow({ item, onOpen }: { item: WorldPalRosterItem; onOpen: (item: WorldPalRosterItem, trigger: HTMLButtonElement) => void }) {
  const pal = resolvePal(item);
  const hasNickname = pal.displayName !== pal.speciesName;
  const location = item.locationType === "base" ? item.baseName || locationLabels.base : item.ownerName || locationLabels[item.locationType];
  return <button className="pal-roster-row" type="button" aria-label={hasNickname ? `${pal.displayName}（${pal.speciesName}）` : pal.displayName} onClick={(event) => onOpen(item, event.currentTarget)}>
    <span className="pal-roster-top">
      <span className="pal-roster-name"><span className="world-entity-avatar world-pal-avatar" data-icon-key={pal.known ? pal.characterId : "pal-placeholder"}><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span><span className="pal-roster-copy"><span><strong>{pal.displayName}</strong><span className="pal-roster-level">Lv.{item.level ?? "—"}</span></span>{hasNickname && <small>{pal.speciesName}</small>}<span className="pal-roster-stars" data-label="等级 / 星级" aria-label={`${pal.rank ?? 0} 星`}>{Array.from({ length: 4 }, (_, index) => <Star key={index} size={11} fill={index < (pal.rank ?? 0) ? "currentColor" : "none"} />)}<small>{pal.rank ?? 0} 星</small></span></span>{pal.gender && <span className={`world-pal-gender ${pal.gender}`} title={pal.gender === "male" ? "雄性" : "雌性"} aria-label={pal.gender === "male" ? "雄性" : "雌性"}>{pal.gender === "male" ? "♂" : "♀"}</span>}</span>
      <PalRosterTraits item={item} />
    </span>
    <PalPassiveSummary skills={item.skills} />
    <PalWorkSummary aptitude={item.aptitude} />
    <span className="pal-roster-extra"><PalAptitudeSummary aptitude={item.aptitude} /><PalCareBadge care={item.care} /></span>
    <span className="pal-roster-location" data-label="归属"><span>{locationLabels[item.locationType]}：<strong>{location}</strong></span><span>查看详情 <ChevronRight size={14} aria-hidden="true" /></span></span>
  </button>;
}

function PalAptitudeSummary({ aptitude }: { aptitude: WorldPalAptitude }) {
  if (!aptitude.metadataKnown && Object.values(aptitude.ivs).every((value) => value === null)) return <span className="pal-aptitude-summary unavailable" data-label="资质"><strong>资料未收录</strong></span>;
  return <span className="pal-aptitude-summary" data-label="资质"><strong>稀有度 {aptitude.speciesRarity ?? "—"}</strong><small>IV {formatIv(aptitude.ivs.hp)} / {formatIv(aptitude.ivs.attack)} / {formatIv(aptitude.ivs.defense)} · 均值 {formatIv(aptitude.ivs.average)}</small></span>;
}

function PalWorkSummary({ aptitude }: { aptitude: WorldPalAptitude }) {
  return <span className="pal-work-summary" data-label="工作适应性">{aptitude.workSuitabilities.length ? aptitude.workSuitabilities.map((work) => <em key={work.type}>{workSuitabilityIcons[work.type] || "⚙️"}<span>{workSuitabilityLabels[work.type] || work.type}</span><strong>Lv.{work.level}</strong></em>) : <small>{aptitude.metadataKnown ? "无工作适应性" : "资料未收录"}</small>}</span>;
}

function PalPassiveSummary({ skills }: { skills?: WorldPalSkills }) {
  const passiveSkills = skills?.passive || [];
  return <span className="pal-passive-summary" data-label="被动技能">{passiveSkills.length ? passiveSkills.map((skill) => { const name = skillDisplayName(skill); const tone = NEGATIVE_PASSIVES.has(name) || (skill.rank ?? 0) < 0 ? "negative" : name === "传说" || (skill.rank ?? 0) >= 3 ? "featured" : ""; return <em className={tone} key={skill.id}>{name}</em>; }) : <small>无被动技能</small>}</span>;
}

function PalCareBadge({ care }: { care: WorldPalCare }) {
  const label = careSummaryLabel(care);
  return <span className={`pal-care-badge ${care.severity}`} data-label="照护状态" title={care.attention ? careReasonLabels(care).join("；") : undefined}>
    {care.attention && <CircleAlert size={15} aria-hidden="true" />}{label}
  </span>;
}

function PalRosterTraits({ item }: { item: WorldPalRosterItem }) {
  const traits = palTraitLabels(item).filter((label) => label === "闪光" || label === "头目");
  return <span className="pal-roster-traits" data-label="个体标记">{traits.map((label) => <em className={label === "头目" ? "boss" : "lucky"} key={label}>{label === "头目" ? <Crown size={12} /> : <Sparkles size={12} />}{label}</em>)}</span>;
}

const NEGATIVE_PASSIVES = new Set(["偷懒", "胆小", "笨手笨脚", "贪吃", "破坏狂", "娇生惯养", "弱不禁风"]);
const workSuitabilityIcons: Record<string, string> = { EmitFlame: "🔥", Watering: "💧", Seeding: "🌱", GenerateElectricity: "⚡", Handcraft: "🔨", Collection: "🌾", Deforest: "🪓", Mining: "⛏️", OilExtraction: "🛢️", ProductMedicine: "🧪", Cool: "❄️", Transport: "📦", MonsterFarm: "🐑" };

type DrawerState = { item: WorldPalRosterItem; detail: (WorldPalDetail & { snapshotId: string }) | null; loading: boolean; error: string };

function PalRosterDrawer({ state, onClose, onFindSameSpecies }: { state: DrawerState | null; onClose: () => void; onNavigate: (resource: "players" | "bases", id: string) => void; onFindSameSpecies: (item: WorldPalDetail | WorldPalRosterItem) => void }) {
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
  const notice = state.loading ? <div className="pal-detail-notice"><LoaderCircle className="spin" size={18} />正在读取完整详情，先显示当前快照摘要。</div> : state.error ? <div className="pal-detail-notice error" role="alert"><AlertCircle size={18} /><span>详情读取失败，已保留花名册摘要。<code>{state.error}</code></span></div> : null;
  return createPortal(<><button className="pal-roster-backdrop pal-detail-backdrop" type="button" tabIndex={-1} aria-label="关闭帕鲁详情遮罩" onClick={onClose} /><PalDetailModal data={data} onClose={onClose} panelRef={drawerRef} closeRef={closeRef} notice={notice} onFindSameSpecies={onFindSameSpecies} /></>, document.body);
}

function PalRosterSkeleton() {
  return <div className="pal-roster-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function formatIv(value: number | null): string {
  if (value === null) return "数据不可用";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function skillDisplayName(skill: WorldPalSkill): string {
  return skill.name || skill.sourceName || skill.id;
}
