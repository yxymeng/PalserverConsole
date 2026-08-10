import { AlertTriangle, CheckCircle2, Database, HardDrive, RefreshCw, ServerCog, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AuthStatus, OperationalHealth, StorageCleanupPreview } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatBytes } from "../../utils/format";
import { healthStateLabel, healthStateTone, healthTime } from "./operationalHealth";

export function OperationalHealthPanel({ auth }: { auth: AuthStatus }) {
  const [health, setHealth] = useState<OperationalHealth | null>(null);
  const [preview, setPreview] = useState<StorageCleanupPreview | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const result = await requestJson<OperationalHealth>("/api/operations/health", { signal });
      setHealth(result);
      setError("");
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "运维健康状态读取失败");
    }
  }, [nextRequestSignal]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function previewCleanup() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<StorageCleanupPreview>("/api/world/storage/cleanup-preview");
      setPreview(result);
      setMessage(result.state === "busy" ? "存档解析进行中，暂不能清理。" : "已生成清理预览，确认前不会删除任何文件。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "生成清理预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function confirmCleanup() {
    if (!preview?.previewToken || !preview.candidateCount) return;
    if (!window.confirm(`确认清理 ${preview.candidateCount} 个控制台生成的快照/缓存项（${formatBytes(preview.totalBytes)}）？不会删除游戏存档或官方备份。`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<{ removedBytes: number }>("/api/world/storage/cleanup", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ previewToken: preview.previewToken }),
      });
      setPreview(null);
      setMessage(`已清理 ${formatBytes(result.removedBytes)} 控制台生成数据。`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "确认清理失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="operational-health" aria-labelledby="operational-health-title">
    <div className="section-heading operational-heading">
      <div><h2 id="operational-health-title">运维健康与容量</h2><p>显示控制台运行目录、官方备份、缓存和后台任务的只读巡检结果。</p></div>
      <button className="quiet-button" type="button" onClick={() => void load()} disabled={busy}><RefreshCw size={17} />刷新</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    {health?.alerts.length ? <div className="operational-alerts" role="status">{health.alerts.map((alert) => <p className={`operational-alert ${alert.severity}`} key={`${alert.code}-${alert.message}`}><AlertTriangle size={17} />{alert.message}</p>)}</div> : null}
    <div className="operational-summary" aria-label="关键运维状态">
      <HealthCard icon={<HardDrive size={19} />} label="下次快照空间" state={health?.capacity.state} value={health?.capacity.freeBytes === null || health?.capacity.freeBytes === undefined ? "不可用" : formatBytes(health.capacity.freeBytes)} detail={health?.capacity.requiredFreeBytes === null || health?.capacity.requiredFreeBytes === undefined ? "无法计算安全余量" : `至少需保留 ${formatBytes(health.capacity.requiredFreeBytes)}`} />
      <HealthCard icon={<Database size={19} />} label="最后成功解析" state={health?.world.state} value={health ? healthTime(health.world.lastSuccessAt) : "正在读取"} detail={health ? `${healthStateLabel(health.world.state)}${health.world.errorCode ? ` · ${health.world.errorCode}` : health.world.parsing ? " · 正在解析" : ""}` : "保存数据缓存"} />
      <HealthCard icon={<CheckCircle2 size={19} />} label="最后有效备份" state={health?.backups.state} value={health ? healthTime(health.backups.lastSuccessAt) : "正在读取"} detail={health ? `${healthStateLabel(health.backups.state)} · ${health.backups.validCount}/${health.backups.itemCount} 个有效` : "官方 backup/world"} />
      <HealthCard icon={<ServerCog size={19} />} label="后台任务" state={backgroundState(health)} value={health ? `${health.background.filter((item) => item.state === "healthy").length}/${health.background.length} 正常` : "正在读取"} detail={health ? health.background.map((item) => `${item.name}: ${healthStateLabel(item.state)}`).join(" · ") : "监控、审计、解析"} />
    </div>
    <div className="health-directory-grid" aria-label="目录容量">
      {health?.directories.map((directory) => <article className={`health-directory ${healthStateTone(directory.state)}`} key={directory.name}>
        <div><span>{directory.label}</span><strong>{formatBytes(directory.sizeBytes)}</strong></div>
        <small>{directory.freeBytes === null ? "剩余空间不可用" : `剩余 ${formatBytes(directory.freeBytes)}`} · {directory.fileCount} 个文件</small>
        <em>{healthStateLabel(directory.state)}{directory.errorCode ? ` · ${directory.errorCode}` : ""}</em>
      </article>)}
      {!health && <p className="empty-state">正在读取目录容量...</p>}
    </div>
    <div className="background-health" aria-label="后台健康">
      {health?.background.map((service) => <article className={`background-health-card ${healthStateTone(service.state)}`} key={service.name}>
        <div><strong>{service.name}</strong><span>{healthStateLabel(service.state)}</span></div>
        <small>最后成功：{healthTime(service.lastSuccessAt)}{service.errorCode ? ` · ${service.errorCode}` : ""}</small>
      </article>)}
    </div>
    <div className="cleanup-preview">
      <div><h3>控制台缓存清理</h3><p>仅预览并清理控制台生成的过期快照和缓存；不会删除游戏存档或官方备份。</p></div>
      <div className="cleanup-actions">
        <button className="quiet-button" type="button" onClick={() => void previewCleanup()} disabled={busy}><Trash2 size={17} />预览清理</button>
        {preview?.candidateCount ? <button className="danger-button" type="button" onClick={() => void confirmCleanup()} disabled={busy || !preview.previewToken}>确认清理 {preview.candidateCount} 项</button> : null}
      </div>
      {preview?.state === "ready" ? <small>预计释放 {formatBytes(preview.totalBytes)}；预览在短时间内有效，目录变化后需重新预览。</small> : null}
    </div>
  </section>;
}

function HealthCard({ icon, label, state, value, detail }: { icon: ReactNode; label: string; state: string | undefined; value: string; detail: string }) {
  return <article className={`health-summary-card ${healthStateTone(state || "unavailable")}`}><span className="health-summary-icon">{icon}</span><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></article>;
}

function backgroundState(health: OperationalHealth | null): string {
  if (!health?.background.length) return "unavailable";
  if (health.background.some((item) => ["blocked", "failed", "stopped", "invalid"].includes(item.state))) return "failed";
  if (health.background.some((item) => ["warning", "unavailable", "no_data", "stale"].includes(item.state))) return "warning";
  return "healthy";
}
