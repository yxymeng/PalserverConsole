import { ChevronLeft, ChevronRight, Database, RefreshCw, Users, Warehouse, PawPrint, X } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { AuthStatus, WorldStatus, WorldRow, WorldResponse, WorldResource } from "../../api/contracts";
import { isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { formatWorldTime, worldCell, worldColumns } from "./worldTable";

export function WorldDataPage({ auth }: { auth: AuthStatus }) {
  const [status, setStatus] = useState<WorldStatus | null>(null);
  const [resource, setResource] = useState<WorldResource>("players");
  const [result, setResult] = useState<WorldResponse | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedPlayer, setSelectedPlayer] = useState<WorldRow | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pageSize = 50;
  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    setError("");
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (appliedSearch) query.set("search", appliedSearch);
      const [nextStatus, nextResult] = await Promise.all([
        requestJson<WorldStatus>("/api/world/snapshots/current", { signal }),
        requestJson<WorldResponse>(`/api/world/${resource}?${query}`, { signal }),
      ]);
      setStatus(nextStatus);
      setResult(nextResult);
    } catch (caught) {
      if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "世界数据读取失败");
    }
  }, [appliedSearch, nextRequestSignal, page, resource]);

  useEffect(() => { void load(); }, [load]);

  function chooseResource(next: WorldResource) {
    setResource(next);
    setPage(1);
    setSelectedPlayer(null);
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setAppliedSearch(search.trim());
  }

  async function reparse() {
    setError(""); setMessage("");
    try {
      const response = await requestJson<{ message: string }>("/api/world/reparse", {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: "{}",
      });
      setMessage(response.message);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "重新解析请求失败");
    }
  }

  async function showPlayer(playerId: string) {
    setError("");
    try { setSelectedPlayer(await requestJson<WorldRow>(`/api/world/players/${playerId}`)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "玩家详情读取失败"); }
  }

  const tabs: { key: WorldResource; label: string; icon: typeof Users }[] = [
    { key: "players", label: "玩家", icon: Users },
    { key: "pals", label: "帕鲁", icon: PawPrint },
    { key: "guilds", label: "工会", icon: Users },
    { key: "bases", label: "据点", icon: Warehouse },
    { key: "inventories", label: "库存", icon: Database },
    { key: "work-pals", label: "工作帕鲁", icon: PawPrint },
  ];
  const columns = worldColumns(resource);
  const totalPages = result?.total ? Math.ceil(result.total / pageSize) : 1;
  return <div className="page-stack world-page">
    <section className={`world-status ${status?.stale ? "stale" : ""}`}>
      <div className="status-icon">{status?.parsing ? <RefreshCw className="spin" size={23} /> : <Database size={23} />}</div>
      <div><h2>{status?.parsing ? "正在解析存档快照" : status?.stale ? "正在显示最后成功缓存" : "存档缓存可用"}</h2><p>{status?.error || `最后成功：${formatWorldTime(status?.observedAt)}${status?.parseDurationMs ? ` · ${status.parseDurationMs} ms` : ""}`}</p></div>
      <button className="quiet-button" onClick={() => void reparse()}><RefreshCw size={17} />重新解析</button>
    </section>
    <section className="world-counts" aria-label="世界数据数量">
      <span><strong>{status?.counts.players ?? "-"}</strong>玩家</span>
      <span><strong>{status?.counts.pals ?? "-"}</strong>帕鲁</span>
      <span><strong>{status?.counts.guilds ?? "-"}</strong>工会</span>
      <span><strong>{status?.counts.bases ?? "-"}</strong>据点</span>
      <span><strong>{status?.counts.inventory_items ?? "-"}</strong>物品槽</span>
      <span><strong>{status?.counts.work_pals ?? "-"}</strong>工作帕鲁</span>
    </section>
    <div className="world-tabs" role="tablist" aria-label="世界数据分类">
      {tabs.map(({ key, label, icon: Icon }) => <button key={key} className={resource === key ? "active" : ""} role="tab" aria-selected={resource === key} onClick={() => chooseResource(key)}><Icon size={17} />{label}</button>)}
    </div>
    <form className="world-search" onSubmit={submitSearch}><input aria-label="搜索世界数据" placeholder="搜索名称或稳定 ID" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /><button className="primary-button" type="submit">搜索</button></form>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status">{message}</p>}
    <section className="world-table" aria-live="polite">
      <div className="world-table-head" style={{ "--world-columns": columns.length } as CSSProperties}>{columns.map((column) => <span key={column.key}>{column.label}</span>)}</div>
      {result?.items.length ? result.items.map((item, index) => <div className="world-table-row" style={{ "--world-columns": columns.length } as CSSProperties} key={String(item.id || `${resource}-${index}`)}>{columns.map((column) => <span key={column.key} data-label={column.label}>{column.key === "name" && resource === "players" && item.id ? <button className="world-link" onClick={() => void showPlayer(String(item.id))}>{worldCell(item, column.key)}</button> : worldCell(item, column.key)}</span>)}</div>) : <p className="empty-state">暂无符合条件的数据。</p>}
    </section>
    <section className="audit-footer"><span>共 {result?.total || 0} 条，第 {result?.page || 1}/{totalPages} 页</span><div><button className="icon-button bordered" title="上一页" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><button className="icon-button bordered" title="下一页" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></section>
    {selectedPlayer && <section className="world-detail"><div className="section-heading"><div><h2>{String(selectedPlayer.name || "玩家详情")}</h2><p>{String(selectedPlayer.id || "")}</p></div><button className="icon-button bordered" title="关闭详情" onClick={() => setSelectedPlayer(null)}><X size={18} /></button></div><dl><div><dt>等级</dt><dd>{String(selectedPlayer.level ?? "不可用")}</dd></div><div><dt>工会 ID</dt><dd>{String(selectedPlayer.guildId || "未分配")}</dd></div><div><dt>背包物品</dt><dd>{Array.isArray(selectedPlayer.inventory) ? selectedPlayer.inventory.length : 0}</dd></div><div><dt>所属帕鲁</dt><dd>{Array.isArray(selectedPlayer.pals) ? selectedPlayer.pals.length : 0}</dd></div></dl></section>}
  </div>;
}
