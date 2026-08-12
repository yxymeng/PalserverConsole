import { AlertTriangle, CheckCircle2, Sparkles, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { AuthStatus, LiveSnapshot, ShellStatus } from "../../api/contracts";
import { formatBytes } from "../../utils/format";
import { serverStateLabel } from "../server/labels";
import { OperationalHealthPanel } from "./OperationalHealthPanel";
import { ServerControlPanel } from "../server/ServerControlPanel";

export function Overview({ shell, auth }: { shell: ShellStatus | null; auth: AuthStatus }) {
  const [liveSnapshot, setLiveSnapshot] = useState<LiveSnapshot | null>(null);

  return (
    <div className="page-stack">
      {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
      <HomeHero />
      <section className="status-band">
        <div className="status-icon"><CheckCircle2 size={25} /></div>
        <div>
          <h2>本机控制台状态</h2>
          <p>服务器写操作仅由管理员明确触发。</p>
        </div>
      </section>
      <HomeStatusGrid shell={shell} snapshot={liveSnapshot} />
      <ServerControlPanel auth={auth} initialStatus={shell} onSnapshot={setLiveSnapshot} />
      <OperationalHealthPanel auth={auth} />
    </div>
  );
}

function HomeHero() {
  return <section className="home-hero" aria-label="首页主视觉">
    <div className="home-hero-copy">
      <p className="home-hero-kicker"><Sparkles size={15} />PalServer · 本机控制中心</p>
      <h2>掌握世界状态，安全维护 PalServer。</h2>
      <p>状态、生命周期操作、实时监控和运维健康度集中在一个本机界面中。</p>
      <div className="home-hero-tags"><span><CheckCircle2 size={14} />本机访问</span><span><Zap size={14} />状态优先</span></div>
    </div>
    <div className="hero-character-stage" aria-hidden="true">
      <span className="hero-character-orbit orbit-one" /><span className="hero-character-orbit orbit-two" />
      <span className="hero-character-bolt bolt-one" /><span className="hero-character-bolt bolt-two" />
      <img className="hero-character" src="/hero-character-placeholder.svg" alt="" />
      <span className="hero-character-caption">LOCAL CONTROL</span>
    </div>
  </section>;
}

function HomeStatusGrid({ shell, snapshot }: { shell: ShellStatus | null; snapshot: LiveSnapshot | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const process = snapshot?.metrics.data.process;
  const world = firstText(snapshot?.info.data, ["worldName", "WorldName", "worldguid", "worldId"]) || shell?.instanceId || "未绑定";
  const players = playerCount(snapshot?.players.data);
  const stale = Boolean(snapshot && [snapshot.info, snapshot.players, snapshot.metrics].some((value) => value.stale || value.errorCode));

  return <section className="metric-grid home-status-grid" aria-label="PalServer 当前状态">
    <article><span>PalServer</span><strong>{serverStateLabel(shell?.serverState)}</strong><small>{shell ? `状态更新于 ${new Date(shell.observedAt * 1000).toLocaleTimeString("zh-CN")}` : "状态不可用"}</small></article>
    <article><span>当前世界 / 实例</span><strong>{world}</strong><small>{shell?.instanceId ? `实例：${shell.instanceId}` : "等待实例信息"}</small></article>
    <article><span>在线玩家</span><strong>{players === null ? "读取中" : players}</strong><small>{snapshot?.players.source || "实时数据"}</small></article>
    <article><span>运行时间</span><strong>{uptimeText(shell?.serverState, process?.startedAt, now)}</strong><small>{shell?.serverState === "running" && process?.startedAt ? `自 ${new Date(process.startedAt * 1000).toLocaleString("zh-CN")}` : shell?.serverState === "running" ? "进程启动时间不可用" : "服务器停止时不计时"}</small></article>
    <article><span>进程 CPU</span><strong>{process ? `${process.cpuPercent}%` : "不可用"}</strong><small>{snapshot?.metrics.source || "实时数据"}</small></article>
    <article><span>进程内存</span><strong>{process ? formatBytes(process.memoryBytes) : "不可用"}</strong><small>{process?.pids.length ? `PID：${process.pids.join(", ")}` : "无运行进程"}</small></article>
    <article className={stale ? "home-alert-card warning" : "home-alert-card"}><span>运行告警</span><strong>{snapshot ? stale ? "需要检查" : "正常" : "读取中"}</strong><small>{snapshot ? stale ? "实时源数据过期或返回错误" : "实时源数据正常" : "正在连接实时数据源"}</small></article>
  </section>;
}

function firstText(data: Record<string, unknown> | undefined, keys: string[]): string | null {
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return null;
}

function playerCount(data: unknown): number | null {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return playerCount((data as Record<string, unknown>).players);
  return data === undefined || data === null ? null : 0;
}

function uptimeText(state: ShellStatus["serverState"] | undefined, startedAt: number | null | undefined, now: number): string {
  if (state !== "running") return "未运行";
  if (!startedAt) return "不可用";
  const seconds = Math.max(0, Math.floor(now / 1_000 - startedAt));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds % 86_400 / 3_600);
  const minutes = Math.floor(seconds % 3_600 / 60);
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}
