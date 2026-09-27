import { AlertCircle, Check, ChevronDown, ChevronRight, CircleAlert, Crown, Filter, HeartPulse, LoaderCircle, Plus, RotateCcw, Search, Settings, ShieldCheck, SlidersHorizontal, Sparkles, Star, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldMetadataStatus, WorldPalAptitude, WorldPalCare, WorldPalDetail, WorldPalRosterItem, WorldPalRosterResponse, WorldPalSkill, WorldPalSkills } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { matchingPalCharacterIds, palTraitLabels, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { mergePalRosterPage } from "./palRosterState";
import { careReasonLabels, careSummaryLabel } from "./palCare";
import { PalDetailModal } from "./PalDetailModal";
import { formatPassiveDescription } from "./palSkillDescription";
import { workSuitabilities } from "./palWorkSuitabilities";
import type { WorldDetailCache } from "./worldDetailCache";

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
  { name: "极速坐骑四词条", icon: "🚀", badge: "移速 +80% 终极骑乘", skills: ["传说", "神速", "运动健将", "灵活"], match: "all" as const },
  { name: "传说 + 运动健将", icon: "⚡", badge: "极速双核组合", skills: ["传说", "运动健将"], match: "all" as const },
  { name: "流水线天花板四打工", icon: "🏭", badge: "工作速度 +120%", skills: ["工匠精神", "社畜", "认真", "稀有"], match: "all" as const },
  { name: "四金极限纯攻战神", icon: "⚔️", badge: "面板攻击 +85%", skills: ["传说", "脑筋", "凶猛", "稀有"], match: "all" as const },
  { name: "不朽重装肉盾 & 训练家增益", icon: "🛡️", badge: "高防御 + 玩家攻防增益", skills: ["传说", "顽强肉体", "突袭指挥官", "铁壁军师"], match: "all" as const },
  { name: "神速 + 健将赶路组", icon: "💨", badge: "基础双速 +50%", skills: ["神速", "运动健将"], match: "all" as const },
  { name: "各系帝王专属主C", icon: "🔥", badge: "单系独有 +30% 增伤", skills: ["炎帝", "海皇", "雷帝", "冥王", "冰帝", "岩帝", "神龙", "圣天", "精灵王"], match: "any" as const },
  { name: "纯净零负面词条", icon: "✨", badge: "过滤已知负面词条", skills: [], match: "all" as const },
];
const PASSIVE_CATEGORIES = [
  { id: "mount", label: "极速骑乘", icon: "⚡", names: ["传说", "神速", "运动健将", "灵活"] },
  { id: "work", label: "据点打工", icon: "🔨", names: ["工匠精神", "社畜", "认真", "稀有", "自恋狂", "工作狂", "小胃"] },
  { id: "combat", label: "极限战斗", icon: "⚔️", names: ["传说", "脑筋", "凶猛", "稀有", "顽强肉体"] },
  { id: "elemental", label: "元素帝王", icon: "🔥", names: ["炎帝", "海皇", "雷帝", "冥王", "冰帝", "神龙", "岩帝", "圣天", "精灵王"] },
  { id: "buff", label: "训练家增益", icon: "👑", names: ["突袭指挥官", "铁壁军师"] },
  { id: "negative", label: "避坑减益", icon: "⚠️", names: [] },
] as const;
const locationLabels: Record<WorldPalRosterItem["locationType"], string> = {
  player: "玩家持有",
  party: "队伍携带",
  storage: "终端存放",
  base: "据点工作",
  unassigned: "未识别归属",
};

export function PalRoster({ detailCache, snapshotId, context, pendingDetail, onPendingDetailHandled, onSnapshotReplaced, onNavigate }: { detailCache: WorldDetailCache; snapshotId: string | null | undefined; context?: PalRosterContext; pendingDetail?: { id: string; snapshotId: string } | null; onPendingDetailHandled?: () => void; onSnapshotReplaced: (detailId?: string) => Promise<string | null>; onNavigate?: (resource: "players" | "bases", id: string) => void }) {
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
  const [passiveCatalog, setPassiveCatalog] = useState<WorldPalSkill[]>([]);
  const [passiveCatalogErrorCode, setPassiveCatalogErrorCode] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<WorldMetadataStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [detailRecoveryError, setDetailRecoveryError] = useState("");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [aptitudeFiltersOpen, setAptitudeFiltersOpen] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const detailSequence = useRef(0);
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
        page: String(page), pageSize: String(PAGE_SIZE), marker, care, sort, snapshotId: requestedSnapshotId,
      });
      if (appliedSearch) {
        query.set("search", appliedSearch);
        const characterIds = matchingPalCharacterIds(appliedSearch);
        if (characterIds.length) query.set("characterId", characterIds.join(","));
      }
      if (location !== "all") query.set("location", location);
      for (const key of ["minLevel", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const) {
        if (appliedAptitude[key]) query.set(key, appliedAptitude[key]);
      }
      if (appliedAptitude.minRank && Number(appliedAptitude.minRank) > 0) query.set("minRank", String(Number(appliedAptitude.minRank) + 1));
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
      setPassiveCatalog(result.passiveCatalog || []);
      setPassiveCatalogErrorCode(result.passiveCatalogErrorCode || null);
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
    detailSequence.current += 1;
    setItems([]);
    setTotal(0);
    setDrawer(null);
    setCareSummary(null);
    setPassiveSkillOptions([]);
    setPassiveCatalog([]);
    setPassiveCatalogErrorCode(null);
    setMetadata(null);
  }, [snapshotId]);

  useEffect(() => {
    void loadPage(1, false);
    return () => requestRef.current?.abort();
  }, [loadPage]);
  useEffect(() => () => { detailSequence.current += 1; }, []);

  useEffect(() => {
    if (!snapshotId || pendingDetail?.snapshotId !== snapshotId) return;
    let active = true;
    void detailCache.load("pals", pendingDetail.id, snapshotId).then((detail) => {
      if (!active) return;
      if (detail.snapshotId !== snapshotId) throw new Error("SNAPSHOT_REPLACED: 详情与当前快照不一致。");
      setDetailRecoveryError("");
      setDrawer({ item: detail, detail, loading: false, error: "" });
    }).catch((caught) => {
      if (active && !isAbortError(caught)) setDetailRecoveryError(caught instanceof Error ? caught.message : "帕鲁详情重新读取失败");
    }).finally(() => { if (active) onPendingDetailHandled?.(); });
    return () => { active = false; };
  }, [detailCache, onPendingDetailHandled, pendingDetail, snapshotId]);

  const openDetail = useCallback(async (item: WorldPalRosterItem, trigger: HTMLButtonElement) => {
    const sequence = ++detailSequence.current;
    returnFocusRef.current = trigger;
    setDetailRecoveryError("");
    const cached = detailCache.peek("pals", item.id, snapshotId);
    setDrawer({ item, detail: cached || null, loading: !cached, error: "" });
    if (cached) return;
    try {
      if (!snapshotId) throw new Error("WORLD_CACHE_UNAVAILABLE: 当前没有可用的世界快照。");
      const detail = await detailCache.load("pals", item.id, snapshotId);
      if (sequence !== detailSequence.current) return;
      setDrawer((current) => current?.item.id === item.id && detail.snapshotId === snapshotId
        ? { ...current, detail, loading: false } : current);
    } catch (caught) {
      if (sequence !== detailSequence.current) return;
      if (caught instanceof ApiRequestError && caught.code === "SNAPSHOT_REPLACED") {
        try {
          const nextSnapshotId = await onSnapshotReplaced(item.id);
          if (sequence !== detailSequence.current) return;
          if (nextSnapshotId && nextSnapshotId !== snapshotId) {
            setDrawer((current) => current?.item.id === item.id ? null : current);
            return;
          }
        } catch { /* Keep the original detail error if status refresh fails. */ }
      }
      if (!isAbortError(caught)) setDrawer((current) => current?.item.id === item.id
        ? { ...current, loading: false, error: caught instanceof Error ? caught.message : "帕鲁详情读取失败" } : current);
    }
  }, [detailCache, onSnapshotReplaced, snapshotId]);

  const closeDrawer = useCallback(() => {
    detailSequence.current += 1;
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
      minRank: draftAptitude.minRank === "0" ? "" : draftAptitude.minRank,
      workSuitabilities: [...draftAptitude.workSuitabilities],
      passiveSkills: [...draftAptitude.passiveSkills],
    });
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

  function updatePassive<K extends keyof AptitudeFilters>(key: K, value: AptitudeFilters[K]) {
    updateAptitude(key, value);
    setAppliedAptitude((current) => ({ ...current, [key]: value }));
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
    const matched = names.map((name) => allPassiveOptions.find((skill) => skillDisplayName(skill) === name)?.id);
    if (matched.some((id) => !id)) return;
    const passiveSkills = matched.filter((id): id is string => Boolean(id));
    const apply = (current: AptitudeFilters) => {
      const active = current.excludeNegativePassives && current.passiveMatch === passiveMatch && current.passiveSkills.length === passiveSkills.length && passiveSkills.every((id) => current.passiveSkills.includes(id));
      return { ...current, passiveSkills: active ? [] : passiveSkills, passiveMatch: active ? "all" as const : passiveMatch, excludeNegativePassives: !active };
    };
    setDraftAptitude(apply);
    setAppliedAptitude(apply);
  }

  const hasPassiveFilters = appliedAptitude.passiveSkills.length > 0 || appliedAptitude.excludeNegativePassives;
  const passiveCatalogIds = new Set(passiveCatalog.map((skill) => skill.id));
  const allPassiveOptions = [...passiveCatalog, ...passiveSkillOptions.filter((skill) => !passiveCatalogIds.has(skill.id))];
  const hasAptitudeFilters = Object.entries(appliedAptitude).some(([key, value]) => ["workSuitabilities", "passiveSkills"].includes(key) ? (value as string[]).length > 0 : !["minWorkLevel", "passiveMatch"].includes(key) && Boolean(value));
  const hasFilters = Boolean(appliedSearch) || marker !== "all" || care !== "all" || location !== "all" || sort !== "balanced" || hasAptitudeFilters;
  const canLoadMore = items.length < total;
  return <section className="pal-roster" aria-label="帕鲁图鉴花名册">
    <header className="world-module-heading pal-roster-heading"><h2>帕鲁图鉴花名册</h2><span className="world-module-total">{total ? `已载入 ${items.length} / ${total} 只` : "等待快照"}</span></header>
    {context?.label && <p className="world-navigation-context" role="status">当前来自总览：{context.label}</p>}
    {metadata?.status === "unavailable" && <p className="pal-metadata-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><span>固定版本元数据当前不可用；名册仍保持只读可浏览，稀有度和工作适应性显示为“资料未收录”。</span><code>{metadata.errorCode || "WORLD_METADATA_UNAVAILABLE"}</code></p>}
    {passiveCatalogErrorCode && <p className="pal-metadata-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><span>完整被动词条目录当前不可用；仍可筛选此快照中已出现的词条，包含未出现词条的预设暂不可选。</span><code>{passiveCatalogErrorCode}</code></p>}
    <form className="pal-roster-toolbar" onSubmit={submitSearch}>
      <div className="pal-filter-search-row">
        <div className="world-search"><Search size={17} aria-hidden="true" /><input aria-label="搜索帕鲁图鉴花名册" placeholder="搜索帕鲁名称、昵称、被动词条或所属训练家..." value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} />{search && <button type="button" aria-label="清空搜索" onClick={() => { setSearch(""); setAppliedSearch(""); }}><X size={14} /></button>}</div>
        <button className="primary-button world-search-button" type="submit">搜索</button>
      </div>
      {appliedSearch && <div className="pal-active-search"><Sparkles size={14} /><span>当前正在筛选：<strong>「{appliedSearch}」</strong>（现存 {total} 只）</span><button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); }}><X size={13} />清除筛选</button></div>}
      <div className="pal-filter-quick-row">
        <label><span>工作技能:</span><select aria-label="工作技能筛选" value={appliedAptitude.workSuitabilities.length === 1 ? appliedAptitude.workSuitabilities[0] : "all"} onChange={(event) => setQuickWorkSuitability(event.target.value)}><option value="all">全部工作技能</option>{Object.entries(workSuitabilities).map(([value, { label }]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label><span>存放位置:</span><select aria-label="帕鲁存放位置筛选" value={location} onChange={(event) => setLocation(event.target.value as LocationFilter)}><option value="all">全部位置</option><option value="party">🎒 随身队伍</option><option value="base">🏰 据点打工</option><option value="storage">📦 帕鲁终端</option><option value="unassigned">未识别归属</option></select></label>
        <div className="pal-roster-markers" aria-label="个体标记与照护筛选">
          <button type="button" className={marker === "boss" ? "boss active" : "boss"} aria-pressed={marker === "boss"} onClick={() => setMarker((value) => value === "boss" ? "all" : "boss")}><Crown size={14} />仅头目</button>
          <button type="button" className={marker === "lucky" ? "lucky active" : "lucky"} aria-pressed={marker === "lucky"} onClick={() => setMarker((value) => value === "lucky" ? "all" : "lucky")}><Sparkles size={14} />仅稀有闪光</button>
          <button type="button" className={care === "attention" ? "attention active" : "attention"} aria-pressed={care === "attention"} onClick={() => setCare((value) => value === "attention" ? "all" : "attention")}><HeartPulse size={14} />需要关注{careSummary ? ` ${careSummary.attention}` : ""}</button>
        </div>
        <label className="pal-filter-sort"><span>排序:</span><select aria-label="帕鲁图鉴花名册排序" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="balanced">均衡</option><option value="name">名称</option><option value="level">等级</option><option value="rarity">物种稀有度</option><option value="averageIv">平均个体值</option><option value="workSuitability">工作适应性</option></select></label>
      </div>
    </form>
    {hasFilters && <div className="pal-applied-filters" aria-label="已应用筛选">
      <div className="pal-applied-heading"><strong>已应用筛选</strong><button className="pal-applied-reset" type="button" onClick={clearFilters}><RotateCcw size={13} />重置全部</button></div>
      {appliedSearch && <button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); }}>搜索：{appliedSearch}<X size={13} /></button>}
      {marker !== "all" && <button type="button" onClick={() => setMarker("all")}>{marker === "lucky" ? "闪光" : "头目"}<X size={13} /></button>}
      {care !== "all" && <button type="button" onClick={() => setCare("all")}>需要关注<X size={13} /></button>}
      {location !== "all" && <button type="button" onClick={() => setLocation("all")}>未归属帕鲁<X size={13} /></button>}
      {sort !== "balanced" && <button type="button" onClick={() => setSort("balanced")}>排序：{{ name: "名称", level: "等级", rarity: "物种稀有度", averageIv: "平均个体值", workSuitability: "工作适应性" }[sort]}<X size={13} /></button>}
      {(["minLevel", "minRank", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const).map((key) => appliedAptitude[key] && <button type="button" key={key} onClick={() => removeAppliedAptitude(key)}>{{ minLevel: "等级", minRank: "星级", minRarity: "稀有度", minHpIv: "生命个体值", minAttackIv: "攻击个体值", minDefenseIv: "防御个体值", minAverageIv: "平均个体值" }[key]} ≥ {appliedAptitude[key]}<X size={13} /></button>)}
      {appliedAptitude.workSuitabilities.map((type) => <button type="button" key={type} onClick={() => removeWorkSuitability(type)}>{workSuitabilities[type]?.label || type} ≥ {appliedAptitude.minWorkLevel || "1"} 级<X size={13} /></button>)}
      {appliedAptitude.passiveSkills.map((id) => <button type="button" key={id} onClick={() => removePassiveSkill(id)}>{skillDisplayName(allPassiveOptions.find((skill) => skill.id === id) || { id, name: null, description: null, sourceName: null, rank: null, element: null, power: null, cooldown: null, metadataKnown: false })}<X size={13} /></button>)}
      {appliedAptitude.excludeNegativePassives && <button type="button" onClick={() => { updateAptitude("excludeNegativePassives", false); setAppliedAptitude((current) => ({ ...current, excludeNegativePassives: false })); }}>过滤负面词条<X size={13} /></button>}
    </div>}
    <section className={`pal-aptitude-filters ${aptitudeFiltersOpen ? "open" : ""}`}>
      <button className="pal-advanced-summary" type="button" aria-expanded={aptitudeFiltersOpen} onClick={() => setAptitudeFiltersOpen((open) => !open)}><SlidersHorizontal size={15} /><span>词条组合高级筛选</span>{hasPassiveFilters && <small>已命中 {total} 只</small>}<span className="pal-advanced-action"><Filter size={14} />{aptitudeFiltersOpen ? "收起筛选" : "高级筛选"}<ChevronDown size={14} /></span></button>
      <PassivePresetBar filters={appliedAptitude} options={allPassiveOptions} onSelect={applyPassivePreset} />
      {aptitudeFiltersOpen && <div className="pal-combo-panel"><PassiveFilterFields filters={appliedAptitude} options={allPassiveOptions} catalogUnavailable={Boolean(passiveCatalogErrorCode)} onUpdate={updatePassive} /></div>}
    </section>
    <details className="pal-other-filters"><summary>资质与工作适应性</summary><form onSubmit={(event) => { event.preventDefault(); applyFilters(); }}><AptitudeFilterFields filters={draftAptitude} onUpdate={updateAptitude} /></form></details>
    {error && <section className="world-request-failure" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>帕鲁图鉴花名册请求失败</strong><p>已保留当前结果；请检查连接或快照状态后重试。</p><code>{error}</code></div><button className="quiet-button" type="button" onClick={() => void loadPage(1, false)}>重新尝试</button></section>}
    {detailRecoveryError && <section className="world-request-failure" role="alert"><AlertCircle size={18} aria-hidden="true" /><div><strong>帕鲁详情重新读取失败</strong><p>快照已更新，请在名册中重新打开这只帕鲁。</p><code>{detailRecoveryError}</code></div></section>}
    <div className="pal-roster-table pal-roster-cards" aria-busy={loading} aria-live="polite">
      <div className="pal-roster-head"><span>帕鲁</span><span>等级 / 星级</span><span>资质</span><span>工作适应性</span><span>被动技能</span><span>个体标记</span><span>照护状态</span><span>归属</span></div>
      {loading ? <PalRosterSkeleton /> : items.length ? items.map((item) => <PalRosterRow item={item} key={item.id} selectedPassiveSkills={appliedAptitude.passiveSkills} onOpen={openDetail} />) : <div className="world-empty-state"><Search size={22} /><strong>{snapshotId ? "未找到符合当前条件的帕鲁" : "当前没有可用世界快照"}</strong>{hasFilters && <button className="quiet-button" type="button" onClick={clearFilters}>清除筛选</button>}</div>}
    </div>
    {canLoadMore && <button className="quiet-button pal-roster-more" type="button" disabled={loadingMore} onClick={() => void loadPage(Math.floor(items.length / PAGE_SIZE) + 1, true)}>{loadingMore ? <><LoaderCircle className="spin" size={17} />正在加载</> : `加载更多（还有 ${total - items.length} 条）`}</button>}
    <PalRosterDrawer state={drawer} onClose={closeDrawer} onNavigate={(target, id) => { closeDrawer(); onNavigate?.(target, id); }} onFindSameSpecies={(item) => { const species = resolvePal(item).speciesName; closeDrawer(); setSearch(species); setAppliedSearch(species); }} />
  </section>;
}

function PassivePresetBar({ filters, options, onSelect }: { filters: AptitudeFilters; options: WorldPalSkill[]; onSelect: (names: string[], match: "all" | "any") => void }) {
  return <div className="pal-passive-presets"><strong>⚡ 快捷预设:</strong><div>{PASSIVE_PRESETS.map((preset) => { const ids = preset.skills.map((name) => options.find((skill) => skillDisplayName(skill) === name)?.id); const available = ids.every(Boolean); const active = available && ids.length === filters.passiveSkills.length && ids.every((id) => filters.passiveSkills.includes(id!)) && filters.passiveMatch === preset.match && filters.excludeNegativePassives; return <button type="button" key={preset.name} disabled={!available} className={active ? "active" : ""} onClick={() => onSelect(preset.skills, preset.match)}><span>{preset.icon}</span>{preset.name}{active ? <Check size={12} /> : <small>{preset.badge}</small>}</button>; })}</div></div>;
}

function AptitudeFilterFields({ filters, onUpdate }: { filters: AptitudeFilters; onUpdate: UpdateAptitude }) {
  return <><div className="pal-aptitude-filter-grid">
    {([
      ["minLevel", "最低等级", 0], ["minRank", "最低星级", 0], ["minRarity", "最低物种稀有度", 0],
      ["minHpIv", "最低生命个体值", 0], ["minAttackIv", "最低攻击个体值", 0], ["minDefenseIv", "最低防御个体值", 0], ["minAverageIv", "最低平均个体值", 0],
    ] as const).map(([key, label, min]) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min={min} max={key === "minRank" ? 4 : key.includes("Iv") ? 100 : undefined} inputMode="numeric" value={filters[key]} onChange={(event) => onUpdate(key, event.target.value)} placeholder="不限" /></label>)}
    <fieldset className="pal-work-filter"><legend>工作适应性</legend><label className="pal-work-level"><span>每项至少</span><select aria-label="最低工作等级" value={filters.minWorkLevel} onChange={(event) => onUpdate("minWorkLevel", event.target.value)}>{Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 级</option>)}</select></label><div>{Object.entries(workSuitabilities).map(([type, { label }]) => <label key={type}><input type="checkbox" checked={filters.workSuitabilities.includes(type)} onChange={() => onUpdate("workSuitabilities", filters.workSuitabilities.includes(type) ? filters.workSuitabilities.filter((name) => name !== type) : [...filters.workSuitabilities, type])} /><span>{label}</span></label>)}</div></fieldset>
  </div><button className="primary-button pal-aptitude-apply" type="submit">应用资质筛选</button></>;
}

function PassiveFilterFields({ filters, options, catalogUnavailable, onUpdate }: { filters: AptitudeFilters; options: WorldPalSkill[]; catalogUnavailable: boolean; onUpdate: UpdateAptitude }) {
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const [queryError, setQueryError] = useState("");
  const groups = [...PASSIVE_CATEGORIES.map((group) => ({ ...group, skills: group.id === "negative" ? options.filter((skill) => (skill.rank ?? 0) < 0) : group.names.flatMap((name) => options.filter((skill) => skillDisplayName(skill) === name)) })), { id: "other", label: "其他词条", icon: "✨", skills: options.filter((skill) => !PASSIVE_CATEGORIES.some((group) => group.id === "negative" ? (skill.rank ?? 0) < 0 : group.names.some((name) => name === skillDisplayName(skill)))) }];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleGroups = groups.filter((group) => category === "all" || category === group.id).map((group) => ({ ...group, skills: group.skills.filter((skill) => `${skillDisplayName(skill)} ${formatPassiveDescription(skill.description)} ${skill.id}`.toLocaleLowerCase().includes(normalizedQuery)) })).filter((group) => group.skills.length);
  const toggle = (id: string) => onUpdate("passiveSkills", filters.passiveSkills.includes(id) ? filters.passiveSkills.filter((value) => value !== id) : filters.passiveSkills.length < 12 ? [...filters.passiveSkills, id] : filters.passiveSkills);
  const addQuery = (event: FormEvent) => {
    event.preventDefault();
    const matches = options.filter((skill) => [skill.id, skillDisplayName(skill), skill.sourceName].some((value) => value?.toLocaleLowerCase() === normalizedQuery));
    const match = matches.find((skill) => skill.id.toLocaleLowerCase() === normalizedQuery) || (matches.length === 1 ? matches[0] : null);
    if (!match) { setQueryError("请输入完整的游戏内词条名或技能 ID"); return; }
    if (!filters.passiveSkills.includes(match.id) && filters.passiveSkills.length >= 12) { setQueryError("最多选择 12 个词条"); return; }
    if (!filters.passiveSkills.includes(match.id)) toggle(match.id);
    setQuery("");
    setQueryError("");
  };
  return <div className="pal-combo-fields">
    <div className="pal-combo-current"><div className="pal-combo-current-head"><strong>当前筛选组合:</strong><span>{filters.passiveSkills.length ? `已选 ${filters.passiveSkills.length} 项` : "暂未选择特定词条 (点击下方特性标签快速加入)"}</span><div className="pal-combo-modes">{filters.passiveSkills.length > 1 && <div className="pal-combo-match"><button type="button" className={filters.passiveMatch === "all" ? "active" : ""} aria-pressed={filters.passiveMatch === "all"} onClick={() => onUpdate("passiveMatch", "all")}>全部满足 AND</button><button type="button" className={filters.passiveMatch === "any" ? "active" : ""} aria-pressed={filters.passiveMatch === "any"} onClick={() => onUpdate("passiveMatch", "any")}>满足任一 OR</button></div>}<button type="button" className={`pal-combo-negative ${filters.excludeNegativePassives ? "active" : ""}`} aria-pressed={filters.excludeNegativePassives} onClick={() => onUpdate("excludeNegativePassives", !filters.excludeNegativePassives)}><ShieldCheck size={13} />过滤负面词条{filters.excludeNegativePassives && <Check size={12} />}</button></div></div>
      {filters.passiveSkills.length > 0 && <div className="pal-combo-selected">{filters.passiveSkills.map((id, index) => <span className="pal-combo-selected-pair" key={id}>{index > 0 && <small>{filters.passiveMatch === "all" ? "AND (且)" : "OR (或)"}</small>}<span className="pal-combo-selected-tag"><Sparkles size={12} />【{skillDisplayName(options.find((skill) => skill.id === id) || { id, name: null, description: null, sourceName: null, rank: null, element: null, power: null, cooldown: null, metadataKnown: false })}】<button type="button" aria-label={`移除${id}`} onClick={() => toggle(id)}><X size={12} /></button></span></span>)}</div>}
    </div>
    <div className="pal-combo-tools"><div className="pal-combo-categories"><button type="button" aria-pressed={category === "all"} className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>🌟 全部{category === "all" && <Check size={12} />}</button>{groups.filter((group) => group.id !== "other" || group.skills.length).map((group) => <button type="button" key={group.id} aria-pressed={category === group.id} className={category === group.id ? "active" : ""} onClick={() => setCategory(group.id)}>{group.icon} {group.label}{category === group.id && <Check size={12} />}</button>)}</div><form className="pal-combo-search" onSubmit={addQuery}><Search size={14} /><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setQueryError(""); }} placeholder="搜索/添加特性词条..." aria-label="搜索特性词条" />{query.trim() && <button type="submit">加入</button>}</form></div>
    {queryError && <p className="pal-combo-query-error" role="alert">{queryError}</p>}
    <div className="pal-combo-list">{visibleGroups.map((group) => <section key={group.id}><h4>{group.icon} {group.label}</h4><div>{group.skills.map((skill) => { const selected = filters.passiveSkills.includes(skill.id); const description = formatPassiveDescription(skill.description); return <button type="button" key={skill.id} className={selected ? "active" : ""} aria-pressed={selected} title={description || skill.id} onClick={() => toggle(skill.id)}>{selected ? <Check size={11} /> : <Plus size={11} />}<span>{skillDisplayName(skill)}</span>{description && <small>{description}</small>}</button>; })}</div></section>)}{!visibleGroups.length && <p className="pal-passive-empty">{options.length ? "没有符合搜索条件的词条。" : catalogUnavailable ? "词条目录暂不可用，当前快照也没有已出现的被动词条。" : "暂无可筛选的被动词条。"}</p>}</div>
  </div>;
}

function PalRosterRow({ item, selectedPassiveSkills, onOpen }: { item: WorldPalRosterItem; selectedPassiveSkills: string[]; onOpen: (item: WorldPalRosterItem, trigger: HTMLButtonElement) => void }) {
  const pal = resolvePal(item);
  const hasNickname = pal.displayName !== pal.speciesName;
  const location = item.locationType === "base" ? item.baseName || locationLabels.base : item.ownerName || locationLabels[item.locationType];
  return <button className="pal-roster-row" data-detail-resource="pals" data-detail-id={item.id} type="button" aria-label={hasNickname ? `${pal.speciesName}（昵称：${pal.displayName}）` : pal.speciesName} onClick={(event) => onOpen(item, event.currentTarget)}>
    <span className="pal-roster-top">
      <span className="pal-roster-name"><span className="world-entity-avatar world-pal-avatar" data-icon-key={pal.known ? pal.characterId : "pal-placeholder"}><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span><span className="pal-roster-copy"><span><strong>{pal.speciesName}</strong><span className="pal-roster-level">Lv.{item.level ?? "—"}</span></span>{hasNickname && <small>「{pal.displayName}」</small>}<span className="pal-roster-stars" data-label="等级 / 星级" aria-label={pal.rank === null ? "星级不可用" : `${pal.rank} 星`}>{Array.from({ length: 4 }, (_, index) => <Star key={index} size={11} fill={pal.rank !== null && index < pal.rank ? "currentColor" : "none"} />)}<small>{pal.rank === null ? "不可用" : `${pal.rank} 星`}</small></span></span>{pal.gender && <span className={`world-pal-gender ${pal.gender}`} title={pal.gender === "male" ? "雄性" : "雌性"} aria-label={pal.gender === "male" ? "雄性" : "雌性"}>{pal.gender === "male" ? "♂" : "♀"}</span>}</span>
      <PalRosterTraits item={item} />
    </span>
    <PalPassiveSummary skills={item.skills} selectedPassiveSkills={selectedPassiveSkills} />
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
  return <span className="pal-work-summary" data-label="工作适应性">{aptitude.workSuitabilities.length ? aptitude.workSuitabilities.map((work) => {
    const { label, icon } = workSuitabilities[work.type] || { label: work.type, icon: null };
    return <em key={work.type}>{icon ? <img src={icon} width={12} height={12} alt="" aria-hidden="true" /> : <Settings size={12} aria-hidden="true" />}<span>{label}</span><strong>Lv.{work.level}</strong></em>;
  }) : <small>{aptitude.metadataKnown ? "无工作适应性" : "资料未收录"}</small>}</span>;
}

function PalPassiveSummary({ skills, selectedPassiveSkills }: { skills?: WorldPalSkills; selectedPassiveSkills: string[] }) {
  const passiveSkills = skills?.passive || [];
  return <span className="pal-passive-summary" data-label="被动技能">{passiveSkills.length ? passiveSkills.map((skill) => { const name = skillDisplayName(skill); const matched = selectedPassiveSkills.includes(skill.id); const tone = matched ? "matched" : NEGATIVE_PASSIVES.has(name) || (skill.rank ?? 0) < 0 ? "negative" : name === "传说" || (skill.rank ?? 0) >= 3 ? "featured" : ""; return <em className={tone} key={skill.id} title={matched ? `命中筛选词条: ${name}` : undefined}>{matched && <Sparkles size={10} aria-hidden="true" />}{name}</em>; }) : <small>无被动技能</small>}</span>;
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

type DrawerState = { item: WorldPalRosterItem | (WorldPalDetail & { snapshotId: string }); detail: (WorldPalDetail & { snapshotId: string }) | null; loading: boolean; error: string };

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
  return <div className="pal-roster-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <article className="pal-roster-skeleton-card" key={index}>
    <div className="pal-roster-skeleton-top"><div><span className="avatar" /><div><span className="name" /><span className="subtitle" /></div></div><span className="badge" /></div>
    <div className="pal-roster-skeleton-tags"><span /><span /></div>
    <div className="pal-roster-skeleton-tags work"><span /><span /></div>
    <div className="pal-roster-skeleton-bottom"><span /><span /></div>
  </article>)}</div>;
}

function formatIv(value: number | null): string {
  if (value === null) return "数据不可用";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function skillDisplayName(skill: WorldPalSkill): string {
  return skill.name || skill.sourceName || skill.id;
}
