import { AlertCircle, ChevronDown, CircleAlert, Crown, HeartPulse, LoaderCircle, Search, Sparkles, Star, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { WorldMetadataStatus, WorldPalAptitude, WorldPalCare, WorldPalDetail, WorldPalRosterItem, WorldPalRosterResponse, WorldPalSkill, WorldPalSkills, WorldRow } from "../../api/contracts";
import { ApiRequestError, isAbortError, requestJson } from "../../api/client";
import { palTraitLabels, resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { mergePalRosterPage } from "./palRosterState";
import { activityLabel, careReasonLabels, careSummaryLabel, diseaseLabel, physicalHealthLabel } from "./palCare";

type Marker = "all" | "lucky" | "boss";
type CareFilter = "all" | "attention";
type Sort = "balanced" | "name" | "level" | "rarity" | "averageIv" | "workSuitability";
type AptitudeFilters = {
  minLevel: string; minRank: string; minRarity: string;
  minHpIv: string; minAttackIv: string; minDefenseIv: string; minAverageIv: string;
  workSuitabilities: string[]; passiveSkills: string[]; minWorkLevel: string;
};

const PAGE_SIZE = 60;
const EMPTY_APTITUDE_FILTERS: AptitudeFilters = { minLevel: "", minRank: "", minRarity: "", minHpIv: "", minAttackIv: "", minDefenseIv: "", minAverageIv: "", workSuitabilities: [], passiveSkills: [], minWorkLevel: "1" };
const EMPTY_PAL_SKILLS: WorldPalSkills = { passive: [], equipped: [], learned: [], partner: null };
const workSuitabilityLabels: Record<string, string> = {
  EmitFlame: "生火", Watering: "浇水", Seeding: "播种", GenerateElectricity: "发电",
  Handcraft: "手工作业", Collection: "采集", Deforest: "伐木", Mining: "采矿",
  OilExtraction: "原油提炼", ProductMedicine: "制药", Cool: "冷却", Transport: "搬运", MonsterFarm: "牧场",
};
const locationLabels: Record<WorldPalRosterItem["locationType"], string> = {
  player: "玩家持有",
  party: "队伍携带",
  storage: "终端存放",
  base: "据点工作",
  unassigned: "未识别归属",
};
const elementLabels: Record<string, string> = {
  Normal: "无", Fire: "火", Water: "水", Grass: "草", Electric: "雷",
  Ice: "冰", Ground: "地面", Dark: "暗", Dragon: "龙",
};

export function PalRoster({ snapshotId, onSnapshotReplaced }: { snapshotId: string | null | undefined; onSnapshotReplaced: () => Promise<string | null> }) {
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [marker, setMarker] = useState<Marker>("all");
  const [care, setCare] = useState<CareFilter>("all");
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
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const aptitudeFiltersRef = useRef<HTMLDetailsElement | null>(null);

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
      if (appliedSearch) query.set("search", appliedSearch);
      for (const key of ["minLevel", "minRank", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const) {
        if (appliedAptitude[key]) query.set(key, appliedAptitude[key]);
      }
      if (appliedAptitude.workSuitabilities.length) {
        query.set("workSuitability", appliedAptitude.workSuitabilities.join(","));
        query.set("minWorkLevel", appliedAptitude.minWorkLevel || "1");
      }
      if (appliedAptitude.passiveSkills.length) query.set("passiveSkill", appliedAptitude.passiveSkills.join(","));
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
        setError(caught instanceof Error ? caught.message : "帕鲁名册读取失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [appliedAptitude, appliedSearch, care, marker, onSnapshotReplaced, snapshotId, sort]);

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
    setAppliedSearch(search.trim());
    setAppliedAptitude({
      ...draftAptitude,
      workSuitabilities: [...draftAptitude.workSuitabilities],
      passiveSkills: [...draftAptitude.passiveSkills],
    });
    if (window.matchMedia("(max-width: 760px)").matches && aptitudeFiltersRef.current?.open) {
      aptitudeFiltersRef.current.open = false;
      aptitudeFiltersRef.current.querySelector("summary")?.focus();
    }
  }

  function clearFilters() {
    setSearch("");
    setAppliedSearch("");
    setMarker("all");
    setCare("all");
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

  const hasAptitudeFilters = Object.entries(appliedAptitude).some(([key, value]) => ["workSuitabilities", "passiveSkills"].includes(key) ? (value as string[]).length > 0 : key !== "minWorkLevel" && Boolean(value));
  const hasFilters = Boolean(appliedSearch) || marker !== "all" || care !== "all" || sort !== "balanced" || hasAptitudeFilters;
  const canLoadMore = items.length < total;
  return <section className="pal-roster" aria-label="帕鲁名册">
    <header className="pal-roster-heading"><div><h2>帕鲁名册</h2><p>按稳定快照分批读取；照护信息来自存档快照，不是实时监控。</p></div><span>{total ? `已载入 ${items.length} / ${total}` : "等待快照"}</span></header>
    {careSummary && <PalCareSummary summary={careSummary} />}
    {metadata?.status === "unavailable" && <p className="pal-metadata-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><span>固定版本元数据当前不可用；名册仍保持只读可浏览，稀有度和工作适应性显示为“资料未收录”。</span><code>{metadata.errorCode || "WORLD_METADATA_UNAVAILABLE"}</code></p>}
    <form className="pal-roster-toolbar" onSubmit={submitSearch}>
      <label className="world-search"><Search size={18} aria-hidden="true" /><input aria-label="搜索帕鲁名册" placeholder="名称、Character ID 或内部 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /></label>
      <button className="primary-button world-search-button" type="submit">应用筛选</button>
      <div className="pal-roster-markers" aria-label="个体标记与照护筛选">
        <button type="button" className={marker === "all" ? "active" : ""} aria-pressed={marker === "all"} onClick={() => setMarker("all")}>全部</button>
        <button type="button" className={marker === "lucky" ? "active" : ""} aria-pressed={marker === "lucky"} onClick={() => setMarker("lucky")}><Sparkles size={15} />闪光</button>
        <button type="button" className={marker === "boss" ? "active" : ""} aria-pressed={marker === "boss"} onClick={() => setMarker("boss")}><Crown size={15} />头目</button>
        <button type="button" className={care === "attention" ? "active" : ""} aria-pressed={care === "attention"} onClick={() => setCare((value) => value === "attention" ? "all" : "attention")}><HeartPulse size={15} />需要关注</button>
      </div>
      <label className="world-control"><span>排序</span><select aria-label="帕鲁名册排序" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="balanced">均衡</option><option value="name">名称</option><option value="level">等级</option><option value="rarity">物种稀有度</option><option value="averageIv">平均个体值</option><option value="workSuitability">工作适应性</option></select></label>
      {hasFilters && <button className="world-clear-button" type="button" onClick={clearFilters}><X size={15} />清除已应用筛选</button>}
      <details ref={aptitudeFiltersRef} className="pal-aptitude-filters">
        <summary><span>资质、工作与被动技能</span><small>多项工作和被动技能均须全部具备</small><ChevronDown size={16} aria-hidden="true" /></summary>
        <div className="pal-aptitude-filter-grid">
          {([
            ["minLevel", "最低等级", 0], ["minRank", "最低星级", 0], ["minRarity", "最低物种稀有度", 0],
            ["minHpIv", "最低生命个体值", 0], ["minAttackIv", "最低攻击个体值", 0], ["minDefenseIv", "最低防御个体值", 0], ["minAverageIv", "最低平均个体值", 0],
          ] as const).map(([key, label, min]) => <label key={key}><span>{label}</span><input aria-label={label} type="number" min={min} max={key.includes("Iv") ? 100 : undefined} inputMode="numeric" value={draftAptitude[key]} onChange={(event) => updateAptitude(key, event.target.value)} placeholder="不限" /></label>)}
          <fieldset className="pal-work-filter"><legend>工作适应性</legend><p>所选项目必须全部达到同一最低等级。</p><label className="pal-work-level"><span>每项至少</span><select aria-label="最低工作等级" value={draftAptitude.minWorkLevel} onChange={(event) => updateAptitude("minWorkLevel", event.target.value)}>{Array.from({ length: 10 }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1} 级</option>)}</select></label><div>{Object.entries(workSuitabilityLabels).map(([type, label]) => <label key={type}><input type="checkbox" checked={draftAptitude.workSuitabilities.includes(type)} onChange={() => updateAptitude("workSuitabilities", draftAptitude.workSuitabilities.includes(type) ? draftAptitude.workSuitabilities.filter((name) => name !== type) : [...draftAptitude.workSuitabilities, type])} /><span>{label}</span></label>)}</div></fieldset>
          <fieldset className="pal-passive-filter"><legend>被动技能</legend><p>所选被动技能必须全部具备。</p>{passiveSkillOptions.length ? <div>{passiveSkillOptions.map((skill) => <label key={skill.id}><input type="checkbox" checked={draftAptitude.passiveSkills.includes(skill.id)} onChange={() => updateAptitude("passiveSkills", draftAptitude.passiveSkills.includes(skill.id) ? draftAptitude.passiveSkills.filter((id) => id !== skill.id) : [...draftAptitude.passiveSkills, skill.id])} /><span>{skillDisplayName(skill)}</span>{skill.rank !== null && <small>阶级 {skill.rank}</small>}</label>)}</div> : <p className="pal-passive-empty">当前快照没有可筛选的被动技能。</p>}</fieldset>
          <button className="primary-button pal-aptitude-apply" type="submit">应用资质筛选</button>
        </div>
      </details>
    </form>
    {hasFilters && <div className="pal-applied-filters" aria-label="已应用筛选">
      <span>已应用</span>
      {appliedSearch && <button type="button" onClick={() => { setSearch(""); setAppliedSearch(""); }}>搜索：{appliedSearch}<X size={13} /></button>}
      {marker !== "all" && <button type="button" onClick={() => setMarker("all")}>{marker === "lucky" ? "闪光" : "头目"}<X size={13} /></button>}
      {care !== "all" && <button type="button" onClick={() => setCare("all")}>需要关注<X size={13} /></button>}
      {sort !== "balanced" && <button type="button" onClick={() => setSort("balanced")}>排序：{{ name: "名称", level: "等级", rarity: "物种稀有度", averageIv: "平均个体值", workSuitability: "工作适应性" }[sort]}<X size={13} /></button>}
      {(["minLevel", "minRank", "minRarity", "minHpIv", "minAttackIv", "minDefenseIv", "minAverageIv"] as const).map((key) => appliedAptitude[key] && <button type="button" key={key} onClick={() => removeAppliedAptitude(key)}>{{ minLevel: "等级", minRank: "星级", minRarity: "稀有度", minHpIv: "生命个体值", minAttackIv: "攻击个体值", minDefenseIv: "防御个体值", minAverageIv: "平均个体值" }[key]} ≥ {appliedAptitude[key]}<X size={13} /></button>)}
      {appliedAptitude.workSuitabilities.map((type) => <button type="button" key={type} onClick={() => removeWorkSuitability(type)}>{workSuitabilityLabels[type] || type} ≥ {appliedAptitude.minWorkLevel || "1"} 级<X size={13} /></button>)}
      {appliedAptitude.passiveSkills.map((id) => <button type="button" key={id} onClick={() => removePassiveSkill(id)}>{skillDisplayName(passiveSkillOptions.find((skill) => skill.id === id) || { id, name: null, description: null, sourceName: null, rank: null, element: null, power: null, cooldown: null, metadataKnown: false })}<X size={13} /></button>)}
    </div>}
    {error && <p className="form-error" role="alert">名册读取失败；已保留当前结果。<code>{error}</code></p>}
    <div className="pal-roster-table" aria-busy={loading} aria-live="polite">
      <div className="pal-roster-head"><span>帕鲁</span><span>等级 / 星级</span><span>资质</span><span>工作适应性</span><span>被动技能</span><span>个体标记</span><span>照护状态</span><span>归属</span></div>
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
    <span className="pal-roster-level" data-label="等级 / 星级"><strong>Lv. {item.level ?? "—"}</strong><small>{pal.rank && pal.rank > 0 ? <><Star size={13} fill="currentColor" />{pal.rank} 星</> : "0 星"}</small></span>
    <PalAptitudeSummary aptitude={item.aptitude} />
    <PalWorkSummary aptitude={item.aptitude} />
    <PalPassiveSummary skills={item.skills} />
    <PalRosterTraits item={item} />
    <PalCareBadge care={item.care} />
    <span className="pal-roster-location" data-label="归属"><strong>{locationLabels[item.locationType]}</strong><small>{location}</small></span>
  </div>;
}

function PalAptitudeSummary({ aptitude }: { aptitude: WorldPalAptitude }) {
  if (!aptitude.metadataKnown && Object.values(aptitude.ivs).every((value) => value === null)) return <span className="pal-aptitude-summary unavailable" data-label="资质"><strong>资料未收录</strong><small>保留内部 ID</small></span>;
  return <span className="pal-aptitude-summary" data-label="资质"><strong>稀有度 {aptitude.speciesRarity ?? "—"}</strong><small>个体值 {formatIv(aptitude.ivs.hp)} / {formatIv(aptitude.ivs.attack)} / {formatIv(aptitude.ivs.defense)} · 均值 {formatIv(aptitude.ivs.average)}</small></span>;
}

function PalWorkSummary({ aptitude }: { aptitude: WorldPalAptitude }) {
  return <span className="pal-work-summary" data-label="工作适应性">{aptitude.workSuitabilities.length ? aptitude.workSuitabilities.slice(0, 3).map((work) => <em key={work.type}>{workSuitabilityLabels[work.type] || work.type} {work.level}</em>) : <small>{aptitude.metadataKnown ? "无工作适应性" : "资料未收录"}</small>}</span>;
}

function PalPassiveSummary({ skills }: { skills?: WorldPalSkills }) {
  const passiveSkills = skills?.passive || [];
  return <span className="pal-passive-summary" data-label="被动技能">{passiveSkills.length ? passiveSkills.slice(0, 2).map((skill) => <em key={skill.id}>{skillDisplayName(skill)}</em>) : <small>无被动技能</small>}</span>;
}

function PalCareSummary({ summary }: { summary: WorldPalRosterResponse["careSummary"] }) {
  return <section className="pal-care-summary" aria-label="照护状态摘要">
    <span><strong>需要关注</strong><b>{summary.attention}</b></span>
    <span className="critical"><strong>Critical</strong><b>{summary.critical}</b></span>
    <span className="warning"><strong>Warning</strong><b>{summary.warning}</b></span>
    <span><strong>数据不可用</strong><b>{summary.unavailable}</b></span>
    <small>统计来自当前存档快照；活动不计入需要关注。</small>
  </section>;
}

function PalCareBadge({ care }: { care: WorldPalCare }) {
  const label = careSummaryLabel(care);
  return <span className={`pal-care-badge ${care.severity}`} data-label="照护状态" title={care.attention ? careReasonLabels(care).join("；") : undefined}>
    {care.attention && <CircleAlert size={15} aria-hidden="true" />}{label}
  </span>;
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
  const care = (data as WorldPalDetail | WorldPalRosterItem).care;
  const aptitude = (data as WorldPalDetail | WorldPalRosterItem).aptitude;
  const skills = (data as WorldPalDetail | WorldPalRosterItem).skills || EMPTY_PAL_SKILLS;
  return <div className="pal-roster-detail">
    <section className="world-relation-section pal-care-detail"><h3>照护状态 <small>来自存档快照</small></h3><PalCareDetail care={care} /></section>
    <dl className="world-detail-grid"><div><dt>等级</dt><dd>{value(record.level)}</dd></div><div><dt>星级</dt><dd>{pal.rank ?? 0}</dd></div><div><dt>归属</dt><dd>{location}</dd></div><div><dt>主人</dt><dd>{value(record.ownerName) || value((record.owner as WorldRow | undefined)?.name)}</dd></div><div><dt>据点</dt><dd>{value(record.baseName) || value((record.base as WorldRow | undefined)?.name)}</dd></div><div><dt>物种稀有度</dt><dd>{aptitude.speciesRarity ?? "资料未收录"}</dd></div></dl>
    <section className="world-relation-section pal-aptitude-detail"><h3>个体值 <small>生命 / 攻击 / 防御</small></h3><dl><div><dt>生命</dt><dd>{formatIv(aptitude.ivs.hp)}</dd></div><div><dt>攻击</dt><dd>{formatIv(aptitude.ivs.attack)}</dd></div><div><dt>防御</dt><dd>{formatIv(aptitude.ivs.defense)}</dd></div><div><dt>平均</dt><dd>{formatIv(aptitude.ivs.average)}</dd></div></dl></section>
    <section className="world-relation-section pal-work-detail"><h3>工作适应性</h3>{aptitude.workSuitabilities.length ? <ul>{aptitude.workSuitabilities.map((work) => <li key={work.type}><span>{workSuitabilityLabels[work.type] || work.type}</span><strong>{work.level} 级</strong></li>)}</ul> : <p>{aptitude.metadataKnown ? "无工作适应性" : <><code>{pal.characterId}</code> · 资料未收录</>}</p>}</section>
    <PalSkillSection title="被动技能" skills={skills.passive} kind="passive" />
    <PalSkillSection title="已装备主动技能" skills={skills.equipped} kind="active" />
    <PalSkillSection title="已学会主动技能" skills={skills.learned} kind="active" />
    <PalSkillSection title="伙伴技能" skills={skills.partner ? [skills.partner] : []} kind="partner" />
    <section className="world-relation-section"><h3>个体标记</h3><p>{palTraitLabels(record).join(" · ") || "普通"}</p></section>
    <section className="world-relation-section pal-technical-ids"><h3>技术信息</h3><p>Character ID <code>{pal.characterId}</code></p><p>内部 ID <code>{value(record.id)}</code></p></section>
    <details className="world-relation-section world-raw-detail"><summary>原始记录</summary><pre className="world-detail-json">{JSON.stringify(record.detail || record, null, 2)}</pre></details>
  </div>;
}

function PalSkillSection({ title, skills, kind }: { title: string; skills: WorldPalSkill[]; kind: "passive" | "active" | "partner" }) {
  const emptyLabel = kind === "partner" ? "资料未收录" : kind === "passive" ? "无被动技能" : "无记录";
  return <section className="world-relation-section pal-skill-section"><h3>{title}</h3>{skills.length ? <ul>{skills.map((skill) => <li key={skill.id}><div><strong>{skill.metadataKnown ? skillDisplayName(skill) : "资料未收录"}</strong><code>{skill.id}</code>{skill.metadataKnown && !skill.name && <small>中文资料未收录</small>}{skill.sourceName && !skill.metadataKnown && <small>{skill.sourceName}</small>}{skill.description && <p>{skill.description}</p>}</div>{kind === "passive" && skill.rank !== null && <span>阶级 {skill.rank}</span>}{kind === "active" && <small>{activeSkillFacts(skill)}</small>}</li>)}</ul> : <p>{emptyLabel}</p>}</section>;
}

function PalCareDetail({ care }: { care: WorldPalCare }) {
  const disease = diseaseLabel(care.disease);
  const activity = activityLabel(care.activity);
  const physicalHealth = physicalHealthLabel(care.physicalHealth);
  const hunger = care.hunger !== null
    ? `${care.hunger}%`
    : care.hungerRaw !== null
      ? `原始值 ${care.hungerRaw}${care.hungerStatus ? ` · ${care.hungerStatus}` : ""}`
      : "数据不可用";
  return <div className="pal-care-detail-content">
    <p className={`pal-care-badge ${care.severity}`}>{care.attention && <CircleAlert size={15} aria-hidden="true" />}{careSummaryLabel(care)}</p>
    {care.attention && <ul>{careReasonLabels(care).map((reason) => <li key={reason}>{reason}</li>)}</ul>}
    <dl><div><dt>生命</dt><dd>{care.currentHp ?? "数据不可用"}</dd></div><div><dt>身体状态</dt><dd>{care.physicalHealth ? physicalHealth || <code>{care.physicalHealth}</code> : "数据不可用"}</dd></div><div><dt>饱食度</dt><dd>{hunger}</dd></div><div><dt>SAN</dt><dd>{care.sanity === null ? "数据不可用" : `${care.sanity}%`}</dd></div><div><dt>疾病</dt><dd>{care.disease ? disease || <><code>{care.disease}</code>（资料未收录）</> : care.diseaseRecorded ? "未见疾病" : "数据不可用"}</dd></div><div><dt>活动</dt><dd>{care.activity ? activity || <code>{care.activity}</code> : care.activityRecorded ? "未见活动" : "数据不可用"}</dd></div></dl>
    {care.unavailable.length > 0 && <p className="pal-care-unavailable">部分照护字段数据不可用，未按健康状态处理。</p>}
  </div>;
}

function PalRosterSkeleton() {
  return <div className="pal-roster-skeleton" aria-hidden="true">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function value(value: unknown): string {
  return value === null || value === undefined || value === "" ? "未关联" : String(value);
}

function formatIv(value: number | null): string {
  if (value === null) return "数据不可用";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function skillDisplayName(skill: WorldPalSkill): string {
  return skill.name || skill.sourceName || skill.id;
}

function activeSkillFacts(skill: WorldPalSkill): string {
  const element = skill.element === null ? "属性数据不可用" : `属性 ${elementLabels[skill.element] || skill.element}`;
  const power = skill.power === null ? "威力数据不可用" : `威力 ${skill.power}`;
  const cooldown = skill.cooldown === null ? "冷却数据不可用" : `冷却 ${skill.cooldown} 秒`;
  return `${element} · ${power} · ${cooldown}`;
}
