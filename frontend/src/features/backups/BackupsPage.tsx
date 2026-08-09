import { AlertTriangle, FolderSearch, Save } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { AuthStatus, BackupResponse } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatBytes } from "../../utils/format";

export function BackupsPage({ auth }: { auth: AuthStatus }) {
  const [data, setData] = useState<BackupResponse | null>(null);
  const [retention, setRetention] = useState("infinite");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const nextRequestSignal = useAbortableRequest();
  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    try { const next = await requestJson<BackupResponse>("/api/backups", { signal }); setData(next); setRetention(next.retention === null ? "infinite" : String(next.retention)); }
    catch (caught) { if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "备份读取失败"); }
  }, [nextRequestSignal]);
  useEffect(() => { void load(); }, [load]);
  async function saveRetention(event: FormEvent) {
    event.preventDefault(); setError(""); setMessage("");
    try { const value = retention.trim().toLowerCase() === "infinite" || retention.trim() === "" ? null : Number(retention); await requestJson("/api/backups/retention", { method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ retention: value }) }); setMessage("保留策略已保存。"); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存策略失败"); }
  }
  async function remove(id: string) { if (!window.confirm(`确认删除历史备份 ${id}？`)) return; try { await requestJson(`/api/backups/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "X-CSRF-Token": auth.csrfToken || "" } }); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "删除失败"); } }
  async function restore(id: string) { if (!window.confirm(`确认恢复备份 ${id}？服务器必须已停止，恢复前会创建安全副本。`)) return; try { await requestJson(`/api/backups/${encodeURIComponent(id)}/restore`, { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}" }); setMessage("备份已恢复。"); await load(); } catch (caught) { setError(caught instanceof Error ? caught.message : "恢复失败"); } }
  async function openDirectory() { try { await requestJson("/api/backups/open-directory", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}" }); } catch (caught) { setError(caught instanceof Error ? caught.message : "打开目录失败"); } }
  return <div className="page-stack audit-page">
    <section className="audit-header"><div><h2>官方备份</h2><p>仅管理 PalServer 官方 backup/world 目录；活动世界没有删除入口。</p></div>{auth.local && <button className="quiet-button" onClick={() => void openDirectory()}><FolderSearch size={17} />打开目录</button>}</section>
    {data?.stale && <div className="warning-strip" role="status"><AlertTriangle size={18} />备份数据已过期{data.errorCode ? `（${data.errorCode}）` : ""}，请刷新后再执行恢复或删除。</div>}
    <section className="settings-section"><div className="section-heading"><div><h2>保留策略</h2><p>默认无限；设置数字后只清理最旧且完整的历史备份。</p></div></div><form className="settings-form port-form" onSubmit={saveRetention}><label htmlFor="backup-retention">保留数量</label><input id="backup-retention" value={retention} onChange={(event) => setRetention(event.target.value)} placeholder="infinite" /><button className="primary-button" type="submit"><Save size={17} />保存策略</button></form></section>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    <section className="world-table backup-table"><div className="world-table-head" style={{ "--world-columns": 5 } as CSSProperties}><span>时间目录</span><span>大小</span><span>完整性</span><span>路径</span><span>操作</span></div>{data?.items.length ? data.items.map((item) => <div className="world-table-row" style={{ "--world-columns": 5 } as CSSProperties} key={item.id}><span data-label="时间目录">{item.id}</span><span data-label="大小">{formatBytes(item.sizeBytes)}</span><span data-label="完整性">{item.valid ? "可恢复" : `缺少 ${item.missing.join(", ")}`}</span><span data-label="路径">{data.backupRoot}</span><span data-label="操作"><button className="quiet-button" disabled={!item.valid} onClick={() => void restore(item.id)}>恢复</button><button className="danger-button" onClick={() => void remove(item.id)}>删除</button></span></div>) : <p className="empty-state">暂无官方备份。</p>}</section>
  </div>;
}
