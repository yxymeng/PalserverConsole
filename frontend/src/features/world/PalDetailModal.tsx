import { Award, Briefcase, ChevronRight, Flame, Gauge, Heart, MapPin, Search, Shield, Sparkles, Swords, User, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import type { WorldPalDetail, WorldPalRosterItem, WorldPalSkill } from "../../api/contracts";
import { resolvePal, UNKNOWN_PAL_ICON } from "./palCatalog";
import { workSuitabilityLabels } from "./palWorkLabels";

const detailNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const formatValue = (value: number | null | undefined) => value == null ? "不可用" : detailNumber.format(value);

type PalData = WorldPalDetail | WorldPalRosterItem;

const workLabels: Record<string, string> = {
  ...workSuitabilityLabels,
  Kindling: "生火", Watering: "浇水", Planting: "播种", GenerateElectricity: "发电", Handcraft: "手工作业",
  Gathering: "采集", Lumbering: "伐木", Mining: "采矿", Medicine: "制药", Cooling: "冷却", Transport: "搬运", Farming: "牧场",
};

const locationLabels: Record<string, string> = {
  player: "玩家持有", party: "玩家随身队伍", storage: "帕鲁终端", base_worker: "据点打工", base: "据点打工", unassigned: "野外 / 未归属",
};

export function PalDetailModal({ data, onClose, onFindSameSpecies, panelRef, closeRef, ariaLabel = "帕鲁详情", notice }: {
  data: PalData;
  onClose: () => void;
  onFindSameSpecies?: (data: PalData) => void;
  panelRef?: Ref<HTMLElement>;
  closeRef?: Ref<HTMLButtonElement>;
  ariaLabel?: string;
  notice?: ReactNode;
}) {
  const pal = resolvePal(data);
  const [selectedPassive, setSelectedPassive] = useState<WorldPalSkill | null>(null);
  const passiveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const passiveCloseRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (selectedPassive) window.requestAnimationFrame(() => passiveCloseRef.current?.focus()); }, [selectedPassive]);
  function closePassive() {
    setSelectedPassive(null);
    window.requestAnimationFrame(() => passiveTriggerRef.current?.focus());
  }
  const ownerName = data.ownerName || ("owner" in data ? data.owner?.name : null);
  const baseName = data.baseName || ("base" in data ? data.base?.name : null);
  const location = "locationType" in data
    ? ({ player: "玩家持有", party: "玩家随身队伍", storage: "帕鲁终端", base: "据点打工", unassigned: "野外 / 未归属" }[data.locationType])
    : locationLabels[data.assignment] || "归属未识别";
  const ivs = [
    ["生命 IV", data.aptitude.ivs.hp, Heart, "hp"],
    ["攻击 IV", data.aptitude.ivs.attack, Swords, "attack"],
    ["防御 IV", data.aptitude.ivs.defense, Shield, "defense"],
  ] as const;
  const sameSpecies = () => onFindSameSpecies?.(data);

  return <aside ref={panelRef} className="pal-detail-modal" role="dialog" aria-modal="true" aria-label={ariaLabel}>
    <header className="pal-detail-header">
      <div className="pal-detail-identity">
        <span className="pal-detail-icon"><img src={pal.icon} alt="" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = UNKNOWN_PAL_ICON; }} /></span>
        <div><div className="pal-detail-title"><h2>{pal.speciesName}</h2>{data.nickname && <span className="pal-detail-nickname">“{data.nickname}”</span>}{pal.isBoss && <span className="pal-detail-badge boss"><Flame size={14} />巨型头目</span>}{pal.isLucky && <span className="pal-detail-badge lucky"><Sparkles size={14} />稀有闪光</span>}</div>
          <p><span>性别: <b className={pal.gender || "unknown"}>{pal.gender === "male" ? "♂ 雄性" : pal.gender === "female" ? "♀ 雌性" : "无性别"}</b></span><i>·</i><span>等级: <strong>Lv.{data.level ?? "—"}</strong></span><i>·</i><span>星级: <em>{data.rank == null ? "不可用" : `★ x${data.rank}`}</em></span><i>·</i><span>物种稀有度: <strong>{formatValue(data.aptitude.speciesRarity)}</strong></span></p>
        </div>
      </div>
      <div className="pal-detail-header-actions"><button ref={closeRef} className="pal-detail-close" type="button" aria-label="关闭帕鲁详情" title="关闭详情" onClick={onClose}><X size={20} /></button></div>
    </header>

    <div className="pal-detail-body">
      {notice}
      <section className="pal-iv-section" aria-label="个体值（IV）">
        <header>
          <h3><Gauge size={17} aria-hidden="true" />个体值（IV）</h3>
          <p className="pal-iv-summary" title="生命、攻击、防御三项的平均值"><span>平均 IV</span><strong>{formatValue(data.aptitude.ivs.average)}</strong></p>
        </header>
        <dl className="pal-iv-list">{ivs.map(([label, value, Icon, tone]) => <div key={label} data-tone={tone}><dt><Icon size={18} aria-hidden="true" />{label}</dt><dd>{formatValue(value)}</dd></div>)}</dl>
        <p className="pal-iv-note">存档快照中的个体资质，不代表当前战斗属性</p>
      </section>

      <div className="pal-vitals">
        <Vital label="SAN 理智值" value={data.care.sanity === null ? "数据不可用" : `${formatValue(data.care.sanity)}%`} percent={data.care.sanity} tone="san" />
        <Vital label="饱食度" value={data.care.hunger === null ? data.care.hungerRaw === null ? "数据不可用" : `原始值 ${formatValue(data.care.hungerRaw)}` : `${formatValue(data.care.hunger)}%`} percent={data.care.hunger} tone="hunger" />
      </div>

      <SkillSection title={`配备主动战斗技能 (${data.skills.equipped.length}/3)`} icon={<Swords size={15} />} className="active" skills={data.skills.equipped} />

      <section className="pal-detail-section passive"><h3><Sparkles size={15} />被动特性词条 ({data.skills.passive.length}/4)</h3>{data.skills.passive.length ? <div className="pal-passive-grid">{data.skills.passive.map((skill) => <button type="button" key={skill.id} className={skill.rank !== null && skill.rank >= 3 ? "god-tier" : ""} onClick={(event) => { passiveTriggerRef.current = event.currentTarget; setSelectedPassive(skill); }}><span><strong>{skill.name || skill.sourceName || "技能名称未收录"}</strong>{skill.rank !== null && <em>{skill.rank} 阶</em>}</span><p>{skillDescription(skill)}</p><small><span>{skill.rank !== null && skill.rank >= 3 ? <><Award size={12} />高阶特性</> : "被动特性"}</span><b>查看加成详解<ChevronRight size={13} /></b></small></button>)}</div> : <p className="pal-detail-empty">无任何被动特性词条</p>}</section>

      <section className="pal-detail-section work"><h3><Briefcase size={15} />工作适应性技能</h3>{data.aptitude.workSuitabilities.length ? <div>{data.aptitude.workSuitabilities.map((work) => <span key={work.type}>{workLabels[work.type] || "工作类型未收录"}<strong>Lv.{work.level}</strong></span>)}</div> : <p className="pal-detail-empty">{data.aptitude.metadataKnown ? "无工作技能（战斗与骑乘专用型）" : "工作适应性资料未收录"}</p>}</section>

      <section className="pal-detail-location"><div><span><User size={15} />所属训练家:</span><strong>{ownerName || "野生 / 未登记"}</strong></div><div><span><MapPin size={15} />存放位置:</span><strong>{baseName ? `${location} (${baseName})` : location}</strong></div></section>
    </div>

    {onFindSameSpecies && <footer className="pal-detail-footer"><button className="pal-detail-same" type="button" onClick={sameSpecies}><Search size={16} />查找同种帕鲁</button></footer>}
    {selectedPassive && <div className="pal-passive-dialog-layer"><button type="button" tabIndex={-1} aria-label="关闭被动词条详情遮罩" onClick={closePassive} /><section role="dialog" aria-modal="true" aria-label="被动词条详情"><header><div><small>被动特性词条</small><h3>{selectedPassive.name || selectedPassive.sourceName || "词条名称未收录"}</h3></div><button ref={passiveCloseRef} type="button" aria-label="关闭被动词条详情" onClick={closePassive}><X size={18} /></button></header><p>{skillDescription(selectedPassive)}</p><dl><div><dt>阶级</dt><dd>{selectedPassive.rank ?? "不可用"}</dd></div></dl></section></div>}
  </aside>;
}

function Vital({ label, value, percent, tone }: { label: string; value: string; percent: number | null; tone: "san" | "hunger" }) {
  return <section><div><span><Zap size={15} />{label}</span><strong>{value}</strong></div><div className="pal-vital-track"><i className={tone} style={{ width: `${percent === null ? 0 : Math.max(0, Math.min(100, percent))}%` }} /></div></section>;
}

function SkillSection({ title, icon, className, skills }: { title: string; icon: ReactNode; className: string; skills: WorldPalSkill[] }) {
  if (!skills.length) return null;
  return <section className={`pal-detail-section ${className}`}><h3>{icon}{title}</h3><div className="pal-active-grid">{skills.map((skill) => <article key={skill.id}><div><strong>{skill.name || skill.sourceName || "技能名称未收录"}</strong>{skill.power !== null && <em>威力 {formatValue(skill.power)}</em>}</div><small><span>冷却: {skill.cooldown === null ? "不可用" : `${formatValue(skill.cooldown)}s`}</span><b>主动技</b></small></article>)}</div></section>;
}

function skillDescription(skill: WorldPalSkill): string {
  return skill.description?.replace(/\{[^{}]+\}%?/g, "（数值未收录）") || "该词条暂无说明。";
}
