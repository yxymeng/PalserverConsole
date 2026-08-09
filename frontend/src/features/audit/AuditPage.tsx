import { ChevronLeft, ChevronRight, Download, FileClock, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, AuditItem, AuditResponse } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatObservedAt } from "../../utils/format";

export function AuditPage({ auth }: { auth: AuthStatus }) {
  const [events, setEvents] = useState<AuditResponse | null>(null);
  const [retention, setRetention] = useState("30");
  const [capabilities, setCapabilities] = useState<{ chatSupported: boolean; commandSupported: boolean; message: string | null } | null>(null);
  const [eventType, setEventType] = useState("");
  const [result, setResult] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const pageSize = 25;
  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async (nextPage = page) => {
    const signal = nextRequestSignal();
    setError("");
    try {
      const query = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
      if (eventType) query.set("eventType", eventType);
      if (result) query.set("result", result);
      if (source) query.set("source", source);
      const [nextEvents, nextRetention, nextCapabilities] = await Promise.all([
        requestJson<AuditResponse>(`/api/audit?${query.toString()}`, { signal }),
        requestJson<{ retentionDays: number }>("/api/audit/settings", { signal }),
        requestJson<{ chatSupported: boolean; commandSupported: boolean; message: string | null }>("/api/audit/capabilities", { signal }),
      ]);
      setEvents(nextEvents); setRetention(String(nextRetention.retentionDays)); setCapabilities(nextCapabilities);
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "审计读取失败");
    }
  }, [eventType, nextRequestSignal, page, result, source]);

  useEffect(() => { void load(page); }, [load, page]);

  async function saveRetention(event: FormEvent) {
    event.preventDefault(); setError("");
    try {
      await requestJson("/api/audit/settings", {
        method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ retentionDays: Number(retention) }),
      });
      await load(1); setPage(1);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
  }

  function exportEvents(format: "json" | "csv") {
    const query = new URLSearchParams({ format });
    if (eventType) query.set("eventType", eventType);
    if (result) query.set("result", result);
    if (source) query.set("source", source);
    window.open(`/api/audit/export?${query.toString()}`, "_blank", "noopener");
  }

  const totalPages = events ? Math.max(1, Math.ceil(events.total / pageSize)) : 1;
  return <div className="page-stack audit-page">
    <section className="audit-header">
      <div><h2>运营审计</h2><p>仅记录管理动作、玩家进出、可识别日志事件和错误结果。</p></div>
      <div className="audit-export"><button className="quiet-button" onClick={() => exportEvents("json")}><Download size={17} />JSON</button><button className="quiet-button" onClick={() => exportEvents("csv")}><Download size={17} />CSV</button></div>
    </section>
    <section className="audit-filters">
      <label>事件类型<select value={eventType} onChange={(event) => { setPage(1); setEventType(event.target.value); }}><option value="">全部</option><option value="player.joined">玩家进入</option><option value="player.left">玩家退出</option><option value="chat.message">聊天</option><option value="command.executed">命令</option><option value="server.operation">服务器操作</option><option value="live.announce">公告</option><option value="live.kick">踢出</option><option value="live.ban">封禁</option><option value="live.unban">解封</option></select></label>
      <label>结果<select value={result} onChange={(event) => { setPage(1); setResult(event.target.value); }}><option value="">全部</option><option value="success">成功</option><option value="queued">已排队</option><option value="failed">失败</option><option value="cancelled">已取消</option></select></label>
      <label>来源<select value={source} onChange={(event) => { setPage(1); setSource(event.target.value); }}><option value="">全部</option><option value="console">控制台</option><option value="player-diff">玩家列表差异</option><option value="palserver-log">PalServer 日志</option><option value="console-output">控制台输出</option></select></label>
      <button className="quiet-button" onClick={() => void load(1)}><RefreshCw size={17} />刷新</button>
    </section>
    <section className="audit-capability"><FileClock size={19} /><span>{capabilities?.message || `日志解析器 ${capabilities?.chatSupported ? "支持" : "未发现"}聊天、${capabilities?.commandSupported ? "支持" : "未发现"}命令事件。`}</span></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="audit-table" aria-live="polite">
      <div className="audit-table-head"><span>时间</span><span>事件</span><span>结果</span><span>来源</span><span>详情</span></div>
      {events?.items.length ? events.items.map((item) => <div className="audit-table-row" key={item.id}><span>{formatObservedAt(item.createdAt)}</span><strong>{auditEventLabel(item.eventType)}</strong><span className={`audit-result ${item.result}`}>{auditResultLabel(item.result)}</span><span>{auditSourceLabel(item.source)}</span><span title={JSON.stringify(item.detail)}>{auditDetail(item)}</span></div>) : <p className="empty-state">暂无符合条件的审计事件。</p>}
    </section>
    <section className="audit-footer"><span>共 {events?.total || 0} 条，第 {events?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" title="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></section>
    <section className="audit-retention"><form onSubmit={saveRetention}><label htmlFor="audit-retention">保留天数（0 表示不限）</label><input id="audit-retention" type="number" min={0} max={3650} value={retention} onChange={(event) => setRetention(event.target.value)} /><button className="primary-button" type="submit">保存策略</button></form></section>
  </div>;
}

function auditEventLabel(type: string) { const labels: Record<string, string> = { "player.joined": "玩家进入", "player.left": "玩家退出", "chat.message": "聊天", "command.executed": "命令", "server.operation": "服务器操作", "live.announce": "公告", "live.kick": "踢出", "live.ban": "封禁", "live.unban": "解封", "config.server_settings": "服务器配置", "config.network": "网络配置", "audit.retention": "审计策略" }; return labels[type] || type; }
function auditResultLabel(result: string) { return ({ success: "成功", queued: "已排队", failed: "失败", cancelled: "已取消" } as Record<string, string>)[result] || result; }
function auditSourceLabel(source: string) { return ({ console: "控制台", "player-diff": "玩家列表", "palserver-log": "PalServer 日志", "console-output": "控制台输出" } as Record<string, string>)[source] || source; }
function auditDetail(item: AuditItem) { const detail = item.detail; if (typeof detail.error === "string") return detail.error; if (typeof detail.playerId === "string") return detail.playerId; if (typeof detail.message === "string") return detail.message; if (typeof detail.kind === "string") return detail.kind; return item.parserVersion || "已记录"; }
