import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { MobileSheetHandle } from "../../components/ui/mobile-sheet-handle";
import {
  BookOpenCheck,
  Box,
  BrainCircuit,
  Compass,
  Crown,
  Flame,
  Globe,
  Landmark,
  MapPinned,
  PawPrint,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Swords,
  Trophy,
  X,
  type LucideIcon,
} from "lucide-react";

import type { WorldPlayerListItem, WorldPlayerProgressField } from "../../api/contracts";
import { Button } from "../../components/ui/button";
import { Spinner } from "../../components/ui/spinner";
import {
  PLAYER_PROGRESS_GROUPS,
  PLAYER_PROGRESS_LABELS,
  playerProgressCoverage,
  playerProgressGameTotal,
  playerProgressPercent,
  playerProgressTotal,
  playerProgressUnavailable,
  playerProgressValue,
} from "../world/playerProgress";

export type PlayerExplorationState = {
  playerId: string;
  playerName: string;
  status: "loading" | "ready" | "error";
  detail: WorldPlayerListItem | null;
  error: string;
};

const PRIMARY_METRICS: Array<{
  field: WorldPlayerProgressField;
  label: string;
  suffix: string;
  tone: "sky" | "emerald" | "amber" | "rose";
  icon: LucideIcon;
}> = [
  { field: "exploredAreas", label: "全图探索度", suffix: "%", tone: "sky", icon: Globe },
  { field: "fastTravel", label: "巨鹫之像", suffix: "处", tone: "emerald", icon: MapPinned },
  { field: "towerBosses", label: "高塔领袖讨伐", suffix: "项", tone: "amber", icon: Crown },
  { field: "oilRigClears", label: "海上油田要塞", suffix: "次", tone: "rose", icon: Flame },
];

const PRIMARY_FIELDS = new Set<WorldPlayerProgressField>(PRIMARY_METRICS.map(({ field }) => field));
const DETAIL_FIELDS = PLAYER_PROGRESS_GROUPS.flatMap(({ fields }) => fields).filter((field) => !PRIMARY_FIELDS.has(field));
const DETAIL_PRESENTATION: Partial<Record<WorldPlayerProgressField, { icon: LucideIcon; tone: string; suffix: string }>> = {
  discoveredPalSpecies: { icon: PawPrint, tone: "sky", suffix: "种" },
  capturedPals: { icon: Box, tone: "emerald", suffix: "只" },
  relics: { icon: Sparkles, tone: "teal", suffix: "座" },
  memos: { icon: ScrollText, tone: "sky", suffix: "份" },
  fieldBosses: { icon: Swords, tone: "rose", suffix: "项" },
  dungeonClears: { icon: Trophy, tone: "amber", suffix: "次" },
  technologyPoints: { icon: BrainCircuit, tone: "violet", suffix: "点" },
  ancientTechnologyPoints: { icon: Landmark, tone: "violet", suffix: "点" },
  recipes: { icon: BookOpenCheck, tone: "teal", suffix: "项" },
};

export function PlayerExplorationDialog({ state, onClose, onRetry }: { state: PlayerExplorationState | null; onClose: () => void; onRetry: () => void }) {
  const open = state !== null;
  const detail = state?.detail;
  const progress = detail?.progress;
  const playerName = detail?.name || state?.playerName || "训练家";
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="psc-exploration-backdrop" />
        <DialogPrimitive.Popup className="psc-exploration-dialog">
          <MobileSheetHandle onDismiss={onClose} />
          <header className="psc-exploration-hero">
            <Compass className="psc-exploration-watermark" aria-hidden="true" />
            <div className="psc-exploration-profile">
              <span className="psc-exploration-avatar" aria-hidden="true">{initials(playerName)}</span>
              <div>
                <div className="psc-exploration-name-row">
                  <DialogPrimitive.Title data-slot="dialog-title">{playerName}</DialogPrimitive.Title>
                  {detail?.level !== null && detail?.level !== undefined && <span className="psc-exploration-level">Lv.{detail.level}</span>}
                  {progress && <span className="psc-exploration-coverage" data-state={progress.state}>{playerProgressCoverage(progress)}</span>}
                </div>
                <p>{detail ? <><span>Player ID：{detail.id}</span><span>存档记录：{recordedAt(detail.lastRecordedAt)}</span></> : "正在读取只读存档快照"}</p>
              </div>
            </div>
            <DialogPrimitive.Close className="psc-exploration-close" aria-label="关闭探索进度"><X aria-hidden="true" /></DialogPrimitive.Close>
          </header>

          <div className="psc-exploration-body" tabIndex={0}>
            {state?.status === "loading" && <div className="psc-exploration-state" role="status"><Spinner /><strong>正在读取探索进度</strong><p>正在关联在线训练家与最新只读存档快照。</p></div>}
            {state?.status === "error" && <div className="psc-exploration-state psc-exploration-error" role="alert"><RefreshCw aria-hidden="true" /><strong>探索进度暂不可用</strong><p>{state.error}</p><Button variant="outline" type="button" onClick={onRetry}><RefreshCw data-icon="inline-start" aria-hidden="true" />重新读取</Button></div>}
            {state?.status === "ready" && detail && progress && <>
              <section className="psc-exploration-metrics" aria-label="探索核心指标">
                {PRIMARY_METRICS.map(({ field, label, suffix, tone, icon: Icon }) => {
                  const value = playerProgressValue(progress, field);
                  const total = playerProgressTotal(progress, field);
                  const numericValue = progress.values[field];
                  const percentage = playerProgressPercent(progress, field);
                  const oilRigLocations = field === "oilRigClears" ? playerProgressGameTotal(progress, "oilRigLocations") : null;
                  const primaryValue = field === "exploredAreas" ? percentageText(percentage) : value;
                  return <article key={field} data-tone={tone}>
                    <div><span>{label}</span><span className="psc-exploration-metric-icon"><Icon aria-hidden="true" /></span></div>
                    <strong>{primaryValue ?? "不可用"}{field !== "exploredAreas" && total !== null ? <small>/ {total}</small> : field !== "exploredAreas" && value !== null ? <small>{suffix}</small> : null}</strong>
                    {field === "exploredAreas" && percentage !== null ? <><p>已探索 {value} / {total} 个区域</p><progress max={100} value={percentage} aria-label={`全图探索度 ${percentageText(percentage)}`} /></>
                      : field === "oilRigClears" && oilRigLocations !== null ? <p>{value === null ? "累计通关次数未记录" : "累计通关次数"} · 游戏共 {oilRigLocations} 处油田</p>
                        : numericValue !== undefined && total !== null ? <progress max={total} value={Math.min(numericValue, total)} aria-label={`${label} ${numericValue} / ${total}`} />
                          : <p>{PLAYER_PROGRESS_LABELS[field]}</p>}
                  </article>;
                })}
              </section>

              <section className="psc-exploration-details" aria-labelledby="exploration-details-title">
                <h3 id="exploration-details-title"><ShieldCheck aria-hidden="true" />核心冒险与收集指标</h3>
                <div className="psc-exploration-detail-grid">
                  {DETAIL_FIELDS.filter((field) => progress.values[field] !== undefined).map((field) => {
                    const presentation = DETAIL_PRESENTATION[field] ?? { icon: ShieldCheck, tone: "sky", suffix: "" };
                    const Icon = presentation.icon;
                    const value = playerProgressValue(progress, field);
                    const total = playerProgressTotal(progress, field);
                    return <div key={field} data-tone={presentation.tone}>
                      <span className="psc-exploration-detail-icon"><Icon aria-hidden="true" /></span>
                      <span className="psc-exploration-detail-label">{PLAYER_PROGRESS_LABELS[field]}</span>
                      <span className="psc-exploration-detail-value">{value}{total !== null && <small>/ {total}</small>}<small>{presentation.suffix}</small></span>
                    </div>;
                  })}
                </div>
              </section>

              {progress.state !== "complete" && <div className="psc-exploration-coverage-note"><strong>{playerProgressCoverage(progress)}</strong><p>{progress.state === "partial" ? `未显示不可确认的字段：${playerProgressUnavailable(progress).join("、")}。` : "当前玩家存档没有可确认的探索进度字段。"}</p></div>}
            </>}
          </div>

          <footer className="psc-exploration-footer">
            <DialogPrimitive.Description data-slot="dialog-description"><ShieldCheck aria-hidden="true" />玩家进度来自只读存档；总量来自游戏资源元数据{progress?.totalsDataVersion ? ` ${progress.totalsDataVersion}` : ""}。</DialogPrimitive.Description>
            <DialogPrimitive.Close render={<Button type="button" />}>关闭</DialogPrimitive.Close>
          </footer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function initials(name: string): string {
  return Array.from(name.trim()).slice(0, 2).join("").toUpperCase() || "PL";
}

function recordedAt(value: string | null): string {
  if (!value) return "时间不可用";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function percentageText(value: number | null): string | null {
  return value === null ? null : `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}%`;
}
