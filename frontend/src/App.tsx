import {
  Activity,
  Archive,
  AlertTriangle,
  CheckCircle2,
  CircleStop,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Database,
  FileClock,
  FileCog,
  FolderSearch,
  LogOut,
  Menu,
  MonitorCog,
  Moon,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Send,
  Play,
  UserRoundX,
  Users,
  Warehouse,
  PawPrint,
  Sun,
  X,
} from "lucide-react";
import { CSSProperties, FormEvent, useCallback, useEffect, useState } from "react";

type AuthStatus = {
  local: boolean;
  authenticated: boolean;
  adminPasswordConfigured: boolean;
  csrfToken: string | null;
  lanWarning: string | null;
  port: number;
};

type ShellStatus = {
  observedAt: number;
  module: "M2";
  serverState: "not_configured" | "stopped" | "running";
  configured: boolean;
  pids: number[];
  executablePath: string | null;
};

type WorldCandidate = { worldId: string; worldPath: string; modifiedAt: number };
type ServerSettings = {
  executablePath: string | null;
  launchArguments: string;
  worldId?: string | null;
  worldPath?: string | null;
  worldCandidates?: WorldCandidate[];
  bindingValid?: boolean;
  bindingErrorCode?: string | null;
};
type DiscoveryCandidate = {
  libraryPath: string;
  installPath: string;
  executablePath: string;
  manifestValid: boolean;
  worldCandidates: WorldCandidate[];
};
type Operation = {
  id: string;
  operationId?: string;
  kind: string;
  state: string;
  stage: string;
  error_code: string | null;
  detail: string | null;
  errorCode?: string | null;
};

type ApiError = { errorCode?: string; message?: string; retryable?: boolean };
type LiveValue<T> = {
  data: T;
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
};
type LiveSnapshot = {
  info: LiveValue<Record<string, unknown>>;
  players: LiveValue<unknown>;
  metrics: LiveValue<{ server?: Record<string, unknown>; process?: ProcessMetrics }>;
  settings: LiveValue<Record<string, unknown>>;
};
type ProcessMetrics = {
  pids: number[];
  cpuPercent: number;
  memoryBytes: number;
  diskReadBytes: number;
  diskWriteBytes: number;
};
type AuditItem = {
  id: number;
  eventType: string;
  peerIp: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: number;
  source: string;
  parserVersion: string | null;
};
type AuditResponse = { items: AuditItem[]; page: number; pageSize: number; total: number; observedAt: number };
type WorldStatus = {
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
  error: string | null;
  snapshotId: string | null;
  parsing: boolean;
  parseDurationMs: number | null;
  peakMemoryBytes?: number | null;
  cacheSizeBytes?: number | null;
  counts: Record<string, number>;
};
type WorldRow = Record<string, unknown> & { id?: string; name?: string };
type WorldResponse = {
  items: WorldRow[];
  page: number;
  pageSize: number;
  total: number;
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
};
type WorldResource = "players" | "pals" | "guilds" | "bases" | "inventories" | "work-pals";
type Theme = "light" | "dark";

const THEME_STORAGE_KEY = "palserver-console-theme";

const text = {
  product: "PalServerConsole",
  overview: "总览",
  server: "服务器管理",
  config: "服务器配置",
  audit: "运营审计",
  world: "世界数据",
  loading: "正在连接本机控制台...",
  loginTitle: "局域网管理员登录",
  password: "游戏管理员密码",
  login: "登录",
  logout: "退出登录",
  retry: "重新连接",
  shellTitle: "生命周期控制已就绪",
  shellBody: "服务器写操作仅由管理员明确触发。",
} as const;

class ApiRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(`${code}: ${message}`);
    this.name = "ApiRequestError";
    this.code = code;
    this.retryable = retryable;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as ApiError;
    throw new ApiRequestError(
      error.errorCode || `HTTP_${response.status}`,
      error.message || `${response.status} ${response.statusText}`,
      error.retryable,
    );
  }
  return (await response.json()) as T;
}

function operationId(operation: Operation) { return operation.operationId || operation.id; }
function operationState(operation: Operation) { return operation.state; }
function operationStage(operation: Operation) { return operation.stage; }
function operationErrorCode(operation: Operation) { return operation.errorCode || operation.error_code; }

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "dark" || saved === "light" ? saved : "light";
  } catch {
    return "light";
  }
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const status = await requestJson<AuthStatus>("/api/auth/status");
      setAuth(status);
      setShell(
        status.authenticated
          ? await requestJson<ShellStatus>("/api/shell/status")
          : null,
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "连接失败");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is optional when browser storage is unavailable.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => current === "light" ? "dark" : "light");
  }, []);

  if (loadError) {
    return <ConnectionError message={loadError} onRetry={() => void load()} theme={theme} onThemeToggle={toggleTheme} />;
  }
  if (!auth) {
    return <LoadingScreen theme={theme} onThemeToggle={toggleTheme} />;
  }
  if (!auth.authenticated) {
    return <LoginScreen warning={auth.lanWarning} onSuccess={() => void load()} theme={theme} onThemeToggle={toggleTheme} />;
  }
  return <ConsoleShell auth={auth} shell={shell} onAuthChanged={() => void load()} theme={theme} onThemeToggle={toggleTheme} />;
}

function ThemeToggle({ theme, onToggle, className = "" }: { theme: Theme; onToggle: () => void; className?: string }) {
  const isDark = theme === "dark";
  const label = isDark ? "切换到浅色界面" : "切换到深色界面";
  return (
    <button
      aria-label={label}
      aria-pressed={isDark}
      className={`theme-toggle ${className}`.trim()}
      onClick={onToggle}
      title={label}
      type="button"
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

function LoadingScreen({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  return (
    <main className="centered-page" aria-live="polite">
      <ThemeToggle theme={theme} onToggle={onThemeToggle} className="screen-theme-toggle" />
      <div className="brand-mark"><MonitorCog size={24} /></div>
      <p className="product-name">{text.product}</p>
      <RefreshCw className="spin" size={20} />
      <p className="muted">{text.loading}</p>
    </main>
  );
}

function ConnectionError({ message, onRetry, theme, onThemeToggle }: { message: string; onRetry: () => void; theme: Theme; onThemeToggle: () => void }) {
  return (
    <main className="centered-page">
      <ThemeToggle theme={theme} onToggle={onThemeToggle} className="screen-theme-toggle" />
      <div className="brand-mark danger"><AlertTriangle size={24} /></div>
      <h1>无法连接控制台</h1>
      <p className="error-detail">{message}</p>
      <button className="primary-button" type="button" onClick={onRetry}>
        <RefreshCw size={18} />{text.retry}
      </button>
    </main>
  );
}

function LoginScreen({ warning, onSuccess, theme, onThemeToggle }: { warning: string | null; onSuccess: () => void; theme: Theme; onThemeToggle: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await requestJson("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      onSuccess();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <ThemeToggle theme={theme} onToggle={onThemeToggle} className="screen-theme-toggle" />
      <section className="login-panel">
        <div className="brand-row">
          <div className="brand-mark"><MonitorCog size={24} /></div>
          <span>{text.product}</span>
        </div>
        <ShieldCheck className="login-icon" size={34} />
        <h1>{text.loginTitle}</h1>
        {warning && <p className="warning-strip"><AlertTriangle size={17} />{warning}</p>}
        <form onSubmit={submit}>
          <label htmlFor="login-password">{text.password}</label>
          <input
            id="login-password"
            autoComplete="current-password"
            minLength={1}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" disabled={busy} type="submit">
            <ShieldCheck size={18} />{busy ? "正在验证..." : text.login}
          </button>
        </form>
      </section>
    </main>
  );
}

function ConsoleShell({
  auth,
  shell,
  onAuthChanged,
  theme,
  onThemeToggle,
}: {
  auth: AuthStatus;
  shell: ShellStatus | null;
  onAuthChanged: () => void;
  theme: Theme;
  onThemeToggle: () => void;
}) {
  const [active, setActive] = useState<"overview" | "server" | "audit" | "world" | "backups" | "config">("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="app-shell">
      <aside className={menuOpen ? "sidebar open" : "sidebar"}>
        <div className="sidebar-brand">
          <div className="brand-mark"><MonitorCog size={22} /></div>
          <span>{text.product}</span>
          <button className="icon-button close-menu" title="关闭菜单" onClick={() => setMenuOpen(false)}>
            <X size={20} />
          </button>
        </div>
        <nav aria-label="主导航">
          <button className={active === "overview" ? "active" : ""} onClick={() => { setActive("overview"); setMenuOpen(false); }}>
            <Activity size={19} />{text.overview}
          </button>
          <button className={active === "server" ? "active" : ""} onClick={() => { setActive("server"); setMenuOpen(false); }}>
            <Server size={19} />{text.server}
          </button>
          <button className={active === "audit" ? "active" : ""} onClick={() => { setActive("audit"); setMenuOpen(false); }}>
            <FileClock size={19} />{text.audit}
          </button>
          <button className={active === "world" ? "active" : ""} onClick={() => { setActive("world"); setMenuOpen(false); }}>
            <Database size={19} />{text.world}
          </button>
          <button className={active === "backups" ? "active" : ""} onClick={() => { setActive("backups"); setMenuOpen(false); }}>
            <Archive size={19} />官方备份
          </button>
          <button className={active === "config" ? "active" : ""} onClick={() => { setActive("config"); setMenuOpen(false); }}>
            <FileCog size={19} />{text.config}
          </button>
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot" />
          <span>{auth.local ? "本机访问" : "局域网会话"}</span>
        </div>
      </aside>
      {menuOpen && <button className="menu-backdrop" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}
      <main className="content">
        <header className="topbar">
          <div className="topbar-inner">
            <button className="icon-button menu-button" title="打开菜单" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
            <div>
              <p className="eyebrow">{text.product}</p>
              <h1>{active === "overview" ? text.overview : active === "server" ? text.server : active === "audit" ? text.audit : active === "world" ? text.world : active === "backups" ? "官方备份" : text.config}</h1>
            </div>
            <div className="topbar-actions">
              <ThemeToggle theme={theme} onToggle={onThemeToggle} />
              {!auth.local && <LogoutButton csrfToken={auth.csrfToken} onDone={onAuthChanged} />}
            </div>
          </div>
        </header>
        {active === "overview" && <Overview shell={shell} auth={auth} onAuthChanged={onAuthChanged} />}
        {active === "server" && <ServerManagement auth={auth} initialStatus={shell} />}
        {active === "audit" && <AuditPage auth={auth} />}
        {active === "world" && <WorldDataPage auth={auth} />}
        {active === "backups" && <BackupsPage auth={auth} />}
        {active === "config" && <ConfigPage auth={auth} />}
      </main>
    </div>
  );
}

function LiveMonitoring({ auth, embedded = false }: { auth: AuthStatus; embedded?: boolean }) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [unbanId, setUnbanId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [info, players, metrics, settings] = await Promise.all([
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/info"),
        requestJson<LiveValue<unknown>>("/api/live/players"),
        requestJson<LiveValue<LiveSnapshot["metrics"]["data"]>>("/api/live/metrics"),
        requestJson<LiveValue<Record<string, unknown>>>("/api/live/settings"),
      ]);
      setSnapshot({ info, players, metrics, settings });
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "实时数据刷新失败");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const events = new EventSource("/api/events", { withCredentials: true });
    events.addEventListener("snapshot", (event) => {
      try { setSnapshot(JSON.parse((event as MessageEvent<string>).data) as LiveSnapshot); }
      catch { setError("实时数据格式无效。"); }
    });
    return () => events.close();
  }, [refresh]);

  async function action(path: string, body?: object) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>(path, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(body || {}),
      });
      setMessage(result.message);
      void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "管理操作失败");
    } finally { setBusy(false); }
  }

  const players = playersFrom(snapshot?.players.data);
  const process = snapshot?.metrics.data.process;
  return <div className={embedded ? "live-monitoring-panel" : "page-stack live-page"}>
    {embedded && <section className="section-heading live-monitoring-heading"><div><h2>实时监控</h2><p>在线玩家、服务器状态和进程指标</p></div></section>}
    {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
    <section className="live-toolbar">
      <div><span className={snapshot?.info.stale ? "status-dot stale-dot" : "status-dot"} /><strong>{snapshot?.info.stale ? "实时数据已过期" : "实时数据正常"}</strong><small>{liveStatus(snapshot?.info)}</small></div>
      <button className="icon-button bordered" title="立即刷新实时数据" onClick={() => void refresh()}><RefreshCw size={19} /></button>
    </section>
    <section className="metric-grid live-metrics" aria-label="实时服务器指标">
      <article><span>在线玩家</span><strong>{players.length}</strong><small>{sourceLabel(snapshot?.players)}</small></article>
      <article><span>Server FPS</span><strong>{displayValue(snapshot?.metrics.data.server, ["serverfps", "serverFps", "ServerFPS", "fps"])}</strong><small>{sourceLabel(snapshot?.metrics)}</small></article>
      <article><span>进程 CPU</span><strong>{process ? `${process.cpuPercent}%` : "不可用"}</strong><small>{process ? `内存 ${formatBytes(process.memoryBytes)}` : sourceLabel(snapshot?.metrics)}</small></article>
    </section>
    <section className="live-section">
      <div className="section-heading"><div><h2>服务器状态</h2><p>{sourceLabel(snapshot?.info)} · {formatObservedAt(snapshot?.info.observedAt)}</p></div><span className={snapshot?.info.stale ? "badge warning" : "badge success"}>{snapshot?.info.stale ? "已过期" : "最新"}</span></div>
      <dl className="live-detail-grid">
        <div><dt>服务器</dt><dd>{displayValue(snapshot?.info.data, ["servername", "serverName", "ServerName"] )}</dd></div>
        <div><dt>版本</dt><dd>{displayValue(snapshot?.info.data, ["version", "Version"])}</dd></div>
        <div><dt>世界</dt><dd>{displayValue(snapshot?.info.data, ["worldguid", "worldName", "WorldName", "worldId"] )}</dd></div>
        <div><dt>磁盘读取</dt><dd>{process ? formatBytes(process.diskReadBytes) : "不可用"}</dd></div>
        <div><dt>磁盘写入</dt><dd>{process ? formatBytes(process.diskWriteBytes) : "不可用"}</dd></div>
      </dl>
    </section>
    <section className="live-section">
      <div className="section-heading"><div><h2>在线玩家</h2><p>{sourceLabel(snapshot?.players)}。完整 IP 按管理需求显示。</p></div><Users size={22} /></div>
      {players.length ? <div className="player-table" role="table"><div className="player-head" role="row"><span>玩家</span><span>Player ID</span><span>IP</span><span>操作</span></div>{players.map((player, index) => {
        const id = playerId(player) || `unknown-${index}`;
        return <div className="player-row" role="row" key={`${id}-${index}`}><span>{playerText(player, ["name", "playerName", "accountName"], "未知玩家")}</span><span>{id}</span><span>{playerText(player, ["ip", "ipAddress"], "不可用")}</span><span className="player-actions"><button title="踢出玩家" disabled={busy || id.startsWith("unknown-")} onClick={() => { if (window.confirm(`确认踢出 ${id}？`)) void action(`/api/live/players/${encodeURIComponent(id)}/kick`, { message: "管理员已将你踢出服务器。" }); }}><UserRoundX size={16} /></button><button className="danger-icon" title="封禁玩家" disabled={busy || id.startsWith("unknown-")} onClick={() => { if (window.confirm(`确认封禁 ${id}？`)) void action(`/api/live/players/${encodeURIComponent(id)}/ban`, { message: "管理员已封禁此账号。" }); }}><CircleStop size={16} /></button></span></div>;
      })}</div> : <p className="empty-state">当前没有可用的在线玩家数据。</p>}
    </section>
    <section className="live-actions">
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (announcement.trim()) void action("/api/live/announce", { message: announcement.trim() }); }}><label htmlFor="announcement">服务器公告</label><input id="announcement" maxLength={500} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="输入公告内容" /><button className="primary-button" disabled={busy} type="submit"><Send size={18} />发送</button></form>
      <form className="inline-form" onSubmit={(event) => { event.preventDefault(); if (unbanId.trim()) void action(`/api/live/players/${encodeURIComponent(unbanId.trim())}/unban`); }}><label htmlFor="unban-id">解除封禁 User ID</label><input id="unban-id" maxLength={256} value={unbanId} onChange={(event) => setUnbanId(event.target.value)} placeholder="输入 User ID" /><button className="quiet-button" disabled={busy} type="submit">解除封禁</button></form>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
    </section>
  </div>;
}

function playersFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  if (data && typeof data === "object" && Array.isArray((data as Record<string, unknown>).players)) return playersFrom((data as Record<string, unknown>).players);
  return [];
}

function WorldDataPage({ auth }: { auth: AuthStatus }) {
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

  const load = useCallback(async () => {
    setError("");
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (appliedSearch) query.set("search", appliedSearch);
      const [nextStatus, nextResult] = await Promise.all([
        requestJson<WorldStatus>("/api/world/snapshots/current"),
        requestJson<WorldResponse>(`/api/world/${resource}?${query}`),
      ]);
      setStatus(nextStatus);
      setResult(nextResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "世界数据读取失败");
    }
  }, [appliedSearch, page, resource]);

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

function worldColumns(resource: WorldResource) {
  const definitions: Record<WorldResource, { key: string; label: string }[]> = {
    players: [{ key: "name", label: "玩家" }, { key: "level", label: "等级" }, { key: "id", label: "Player ID" }, { key: "guildId", label: "工会" }],
    pals: [{ key: "nickname", label: "昵称" }, { key: "characterId", label: "帕鲁" }, { key: "level", label: "等级" }, { key: "ownerPlayerId", label: "主人" }, { key: "baseId", label: "据点" }],
    guilds: [{ key: "name", label: "工会" }, { key: "memberCount", label: "成员" }, { key: "baseCount", label: "据点" }, { key: "id", label: "Guild ID" }],
    bases: [{ key: "name", label: "据点" }, { key: "id", label: "Base ID" }, { key: "guildId", label: "工会" }, { key: "workerContainerId", label: "工作容器" }],
    inventories: [{ key: "itemId", label: "物品" }, { key: "quantity", label: "数量" }, { key: "containerId", label: "容器" }, { key: "ownerKind", label: "归属" }, { key: "baseId", label: "据点" }],
    "work-pals": [{ key: "nickname", label: "昵称" }, { key: "characterId", label: "帕鲁" }, { key: "level", label: "等级" }, { key: "baseId", label: "据点" }, { key: "id", label: "Instance ID" }],
  };
  return definitions[resource];
}

function worldCell(item: WorldRow, key: string) {
  const value = item[key];
  if (value === undefined || value === null || value === "") return key === "baseId" || key === "guildId" || key === "ownerPlayerId" ? "未分配" : "不可用";
  if (key === "ownerKind") return ({ player_inventory: "玩家背包", base_inventory: "据点库存", unassigned: "未分配" } as Record<string, string>)[String(value)] || String(value);
  return String(value);
}

function formatWorldTime(value?: number) { return value ? new Date(value * 1000).toLocaleString("zh-CN") : "尚无成功结果"; }

function AuditPage({ auth }: { auth: AuthStatus }) {
  const [events, setEvents] = useState<AuditResponse | null>(null);
  const [retention, setRetention] = useState("30");
  const [capabilities, setCapabilities] = useState<{ chatSupported: boolean; commandSupported: boolean; message: string | null } | null>(null);
  const [eventType, setEventType] = useState("");
  const [result, setResult] = useState("");
  const [source, setSource] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const pageSize = 25;

  const load = useCallback(async (nextPage = page) => {
    setError("");
    try {
      const query = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
      if (eventType) query.set("eventType", eventType);
      if (result) query.set("result", result);
      if (source) query.set("source", source);
      const [nextEvents, nextRetention, nextCapabilities] = await Promise.all([
        requestJson<AuditResponse>(`/api/audit?${query.toString()}`),
        requestJson<{ retentionDays: number }>("/api/audit/settings"),
        requestJson<{ chatSupported: boolean; commandSupported: boolean; message: string | null }>("/api/audit/capabilities"),
      ]);
      setEvents(nextEvents); setRetention(String(nextRetention.retentionDays)); setCapabilities(nextCapabilities);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "审计读取失败"); }
  }, [eventType, page, result, source]);

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

function playerText(player: Record<string, unknown>, keys: string[], fallback: string) { return displayValue(player, keys, fallback); }
function playerId(player: Record<string, unknown>) { return displayValue(player, ["userId", "userid", "playerId", "id"], ""); }
function displayValue(value: Record<string, unknown> | undefined, keys: string[], fallback = "不可用") {
  if (!value) return fallback;
  const entries = Object.entries(value);
  for (const key of keys) {
    const direct = value[key];
    const item = direct ?? entries.find(([actual]) => actual.toLowerCase() === key.toLowerCase())?.[1];
    if (item !== undefined && item !== null && String(item)) return String(item);
  }
  return fallback;
}
function formatBytes(value: number) { if (!Number.isFinite(value)) return "不可用"; const units = ["B", "KB", "MB", "GB", "TB"]; let size = value; let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`; }
function formatObservedAt(value?: number) { return value ? new Date(value * 1000).toLocaleTimeString("zh-CN") : "尚未采集"; }
function sourceLabel(value?: LiveValue<unknown>) { if (!value) return "尚未采集"; return value.stale ? `${value.source} · ${value.errorCode || "数据已过期"}` : value.source; }
function liveStatus(value?: LiveValue<unknown>) { return value ? `${sourceLabel(value)} · ${formatObservedAt(value.observedAt)}` : "尚未采集"; }

function Overview({ shell, auth, onAuthChanged }: { shell: ShellStatus | null; auth: AuthStatus; onAuthChanged: () => void }) {
  const [port, setPort] = useState(String(auth.port));
  const [portMessage, setPortMessage] = useState("");
  const [portError, setPortError] = useState("");

  useEffect(() => { setPort(String(auth.port)); }, [auth.port]);

  async function savePort(event: FormEvent) {
    event.preventDefault();
    setPortMessage("");
    setPortError("");
    try {
      const result = await requestJson<{ message: string }>("/api/settings/network", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify({ port: Number(port) }),
      });
      setPortMessage(result.message);
      onAuthChanged();
    } catch (caught) {
      setPortError(caught instanceof Error ? caught.message : "保存端口失败");
    }
  }

  return (
    <div className="page-stack">
      {!auth.local && <div className="warning-strip"><AlertTriangle size={18} />仅可信内网使用，禁止公网暴露。</div>}
      <section className="status-band">
        <div className="status-icon"><CheckCircle2 size={25} /></div>
        <div>
          <h2>{text.shellTitle}</h2>
          <p>{text.shellBody}</p>
        </div>
        <span className="badge">M2</span>
      </section>
      <section className="metric-grid" aria-label="基础状态">
        <article><span>控制台后端</span><strong>运行中</strong><small>FastAPI 单进程</small></article>
        <article><span>访问模式</span><strong>{auth.local ? "本机免登录" : "LAN 已认证"}</strong><small>{auth.adminPasswordConfigured ? "使用游戏管理员密码" : "仅监听 127.0.0.1"}</small></article>
        <article><span>PalServer</span><strong>{serverStateLabel(shell?.serverState)}</strong><small>{shell ? new Date(shell.observedAt * 1000).toLocaleTimeString("zh-CN") : "状态不可用"}</small></article>
      </section>
      <section className="settings-section overview-network-settings">
        <div className="section-heading"><div><h2>控制台监听端口</h2><p>当前端口：{auth.port}。修改后需重启控制台才会生效。</p></div></div>
        {auth.local ? <form className="settings-form port-form" onSubmit={savePort}>
          <label htmlFor="console-port">控制台监听端口</label>
          <input id="console-port" type="number" min={1} max={65535} value={port} onChange={(event) => setPort(event.target.value)} required />
          {portError && <p className="form-error" role="alert">{portError}</p>}
          {portMessage && <p className="form-success" role="status">{portMessage}</p>}
          <button className="primary-button" type="submit"><Settings size={18} />保存端口</button>
        </form> : <div className="notice-band"><AlertTriangle size={20} /><span>监听端口只能在服务器本机的总览页面修改。</span></div>}
      </section>
    </div>
  );
}

function serverStateLabel(state?: ShellStatus["serverState"]) {
  if (state === "running") return "运行中";
  if (state === "stopped") return "已停止";
  return "尚未配置";
}

function ServerManagement({ auth, initialStatus }: { auth: AuthStatus; initialStatus: ShellStatus | null }) {
  const [status, setStatus] = useState(initialStatus);
  const [settings, setSettings] = useState<ServerSettings>({ executablePath: "", launchArguments: "" });
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [nextStatus, nextSettings] = await Promise.all([
        requestJson<ShellStatus>("/api/shell/status"),
        requestJson<ServerSettings>("/api/server/settings"),
      ]);
      setStatus(nextStatus);
      setSettings(nextSettings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "状态刷新失败");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!operation || !["queued", "running"].includes(operationState(operation))) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await requestJson<Operation>(`/api/server/operations/${operationId(operation)}`);
        setOperation(next);
        if (!["queued", "running"].includes(operationState(next))) void refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "操作状态查询失败");
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [operation, refresh]);

  async function discover() {
    setBusy(true); setError("");
    try { setCandidates(await requestJson<DiscoveryCandidate[]>("/api/server/discovery")); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Steam 发现失败"); }
    finally { setBusy(false); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const result = await requestJson<{ message: string }>("/api/server/settings", {
        method: "PUT",
        headers: { "X-CSRF-Token": auth.csrfToken || "" },
        body: JSON.stringify(settings),
      });
      setMessage(result.message); await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setBusy(false); }
  }

  async function begin(kind: "start" | "save" | "stop" | "restart") {
    const labels = { start: "启动", save: "保存世界", stop: "关闭", restart: "重启" };
    if (!window.confirm(`确认对 ${settings.executablePath || "当前 PalServer"} 执行“${labels[kind]}”？`)) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const next = await requestJson<Operation>(`/api/server/operations/${kind}`, {
        method: "POST",
        headers: {
          "X-CSRF-Token": auth.csrfToken || "",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          countdownSeconds: 30,
          message: "服务器将在 30 秒后维护，请及时返回安全地点。",
        }),
      });
      setOperation(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作提交失败"); }
    finally { setBusy(false); }
  }

  async function cancel() {
    if (!operation) return;
    try {
      await requestJson(`/api/server/operations/${operationId(operation)}/cancel`, {
        method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}",
      });
      setMessage("取消请求已提交。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "取消失败"); }
  }

  async function forceStop() {
    if (!operation || !window.confirm(`PalServer 未能优雅退出。确认强制结束 PID ${status?.pids.join(", ") || "未知"}？`)) return;
    try {
      const next = await requestJson<Operation>(`/api/server/operations/${operationId(operation)}/force-stop`, {
        method: "POST",
        headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": crypto.randomUUID() },
        body: "{}",
      });
      setOperation(next);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "强制停止失败"); }
  }

  const operating = !!operation && ["queued", "running"].includes(operationState(operation));
  return (
    <div className="page-stack server-page">
      <section className="server-status-row">
        <div><span>PalServer</span><strong>{serverStateLabel(status?.serverState)}</strong></div>
        <div><span>目标进程</span><strong>{status?.pids.length ? status.pids.join(", ") : "无"}</strong></div>
        <button className="icon-button bordered" title="刷新状态" onClick={() => void refresh()}><RefreshCw size={19} /></button>
      </section>
      <section className="action-toolbar" aria-label="服务器操作">
        <button disabled={busy || operating || status?.serverState === "running"} onClick={() => void begin("start")}><Play size={18} />启动</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("save")}><Save size={18} />保存世界</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("stop")}><CircleStop size={18} />关闭</button>
        <button disabled={busy || operating || status?.serverState !== "running"} onClick={() => void begin("restart")}><RotateCw size={18} />重启</button>
      </section>
      {operation && <section className="operation-band" aria-live="polite">
        <div><span>当前操作</span><strong>{operation.kind} · {operationStage(operation)}</strong><small>{operationErrorCode(operation) ? `${operationErrorCode(operation)}: ${operation.detail || ""}` : operationState(operation)}</small></div>
        {operationStage(operation) === "countdown" && <button className="quiet-button" onClick={() => void cancel()}>取消</button>}
        {operationState(operation) === "awaiting_force_confirmation" && <button className="danger-button" onClick={() => void forceStop()}><CircleStop size={18} />确认强制停止</button>}
      </section>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-success" role="status">{message}</p>}
      <section className="settings-section embedded-settings">
        <div className="section-heading"><div><h2>PalServer 安装</h2><p>{settings.executablePath || "尚未选择 PalServer.exe"}</p></div>{auth.local && <button className="quiet-button" disabled={busy} onClick={() => void discover()}><FolderSearch size={18} />扫描 Steam</button>}</div>
        {candidates.length > 0 && <div className="candidate-list">{candidates.map((candidate) => <button key={candidate.executablePath} onClick={() => setSettings({ ...settings, executablePath: candidate.executablePath, worldId: null, worldCandidates: candidate.worldCandidates })}><Server size={18} /><span><strong>{candidate.installPath}</strong><small>{candidate.manifestValid ? "manifest 已验证" : "manifest 未验证"}</small></span></button>)}</div>}
        {auth.local ? <form className="settings-form server-form" onSubmit={saveSettings}>
          <label htmlFor="server-executable">PalServer.exe 路径</label>
          <input id="server-executable" value={settings.executablePath || ""} onChange={(event) => setSettings({ ...settings, executablePath: event.target.value })} required />
          {(settings.worldCandidates?.length || 0) > 0 && <>
            <label htmlFor="server-world">World ID（必须明确选择）</label>
            <select id="server-world" value={settings.worldId || ""} onChange={(event) => setSettings({ ...settings, worldId: event.target.value || null })} required>
              <option value="">请选择世界</option>
              {settings.worldCandidates?.map((world) => <option key={world.worldId} value={world.worldId}>{world.worldId}</option>)}
            </select>
          </>}
          {settings.bindingErrorCode && <p className="form-error" role="alert">世界绑定不可用：{settings.bindingErrorCode}</p>}
          <label htmlFor="launch-arguments">启动参数</label>
          <input id="launch-arguments" value={settings.launchArguments} onChange={(event) => setSettings({ ...settings, launchArguments: event.target.value })} />
          <button className="primary-button" disabled={busy} type="submit"><Save size={18} />保存设置</button>
        </form> : <div className="notice-band"><ShieldCheck size={20} /><span>安装路径和启动参数只能在服务器本机修改。</span></div>}
      </section>
      <LiveMonitoring auth={auth} embedded />
    </div>
  );
}

type BackupItem = { id: string; observedAt: number; sizeBytes: number; valid: boolean; missing: string[] };
type BackupResponse = {
  items: BackupItem[];
  retention: number | null;
  worldPath: string;
  backupRoot: string;
  observedAt?: number;
  stale?: boolean;
  errorCode?: string | null;
};

function BackupsPage({ auth }: { auth: AuthStatus }) {
  const [data, setData] = useState<BackupResponse | null>(null);
  const [retention, setRetention] = useState("infinite");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    try { const next = await requestJson<BackupResponse>("/api/backups"); setData(next); setRetention(next.retention === null ? "infinite" : String(next.retention)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "备份读取失败"); }
  }, []);
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

type ConfigDocument = {
  path: string;
  sourceHash: string;
  fields: Record<string, string>;
  unknownFields: Record<string, string>;
  schema: string[];
  rawText: string;
  adminPasswordConfigured: boolean;
  worldOptionPresent?: boolean;
  draft: (ConfigDocument & { state?: string; conflict?: Record<string, unknown> | null }) | null;
};

type ConfigEditorTab = "panel" | "world";
type ConfigCategoryId =
  | "server"
  | "runtime"
  | "network"
  | "mods"
  | "communication"
  | "access"
  | "random"
  | "progression"
  | "combat"
  | "survival"
  | "resources"
  | "building"
  | "guild"
  | "worldRules"
  | "performance"
  | "character"
  | "advanced";

type ConfigKind = "text" | "password" | "number" | "boolean" | "select" | "multi-select";
type ConfigOption = { value: string; label: string; description?: string };
type ConfigFieldMeta = {
  key: string;
  label: string;
  description: string;
  kind: ConfigKind;
  min?: number;
  max?: number;
  step?: number;
  options?: ConfigOption[];
};

const CONFIG_LABELS: Record<string, string> = {
  ServerName: "服务器名称",
  ServerDescription: "服务器描述",
  AdminPassword: "管理员密码",
  ServerPassword: "服务器密码",
  PublicIP: "公共 IP",
  PublicPort: "公共端口",
  ServerPlayerMaxNum: "服务器玩家最大数量",
  bIsUseBackupSaveData: "是否自动备份存档数据",
  AutoSaveSpan: "自动保存间隔",
  CrossplayPlatforms: "允许连接平台",
  LogFormatType: "日志格式类型",
  ChatPostLimitPerMinute: "每分钟聊天限制数",
  RandomizerType: "随机器类型",
  RandomizerSeed: "随机种子",
  bIsRandomizerPalLevelRandom: "完全随机野外帕鲁等级",
  bEnableVoiceChat: "启用游戏内语音聊天",
  VoiceChatMaxVolumeDistance: "语音音量无衰减距离",
  VoiceChatZeroVolumeDistance: "语音完全静音距离",
  DayTimeSpeedRate: "白天流逝速度",
  NightTimeSpeedRate: "夜间流逝速度",
  ExpRate: "经验值倍率",
  PalCaptureRate: "捕捉概率倍率",
  PalSpawnNumRate: "帕鲁出现数量倍率",
  PalDamageRateAttack: "帕鲁攻击伤害倍率",
  PalDamageRateDefense: "帕鲁承受伤害倍率",
  PlayerDamageRateAttack: "玩家攻击伤害倍率",
  PlayerDamageRateDefense: "玩家承受伤害倍率",
  PlayerStomachDecreaceRate: "玩家饱食度降低倍率",
  PlayerStaminaDecreaceRate: "玩家耐力降低倍率",
  PlayerAutoHPRegeneRate: "玩家生命值自然回复倍率",
  PlayerAutoHpRegeneRateInSleep: "玩家睡眠时生命值回复倍率",
  PalStomachDecreaceRate: "帕鲁饱食度降低倍率",
  PalStaminaDecreaceRate: "帕鲁耐力降低倍率",
  PalAutoHPRegeneRate: "帕鲁生命值自然回复倍率",
  PalAutoHpRegeneRateInSleep: "帕鲁睡眠时生命值回复倍率",
  BuildObjectHpRate: "建筑物生命值倍率",
  BuildObjectDamageRate: "对建筑物伤害倍率",
  BuildObjectDeteriorationDamageRate: "非基地圈内建筑物的劣化速度倍率",
  CollectionDropRate: "道具采集量倍率",
  CollectionObjectHpRate: "可采集物品生命值倍率",
  CollectionObjectRespawnSpeedRate: "可采集物品重生间隔倍率",
  EnemyDropItemRate: "道具掉落量倍率",
  DeathPenalty: "死亡惩罚",
  bEnablePlayerToPlayerDamage: "启用玩家对玩家伤害",
  bEnableFriendlyFire: "启用友伤",
  bEnableInvaderEnemy: "启用袭击事件",
  EnablePredatorBossPal: "启用猛兽 Boss 帕鲁",
  bActiveUNKO: "激活帕鲁便便",
  bEnableAimAssistPad: "启用手柄瞄准辅助",
  bEnableAimAssistKeyboard: "启用键盘瞄准辅助",
  DropItemMaxNum: "掉落物品最大存在数量",
  DropItemMaxNum_UNKO: "帕鲁便便掉落最大数量",
  BaseCampMaxNum: "全地图据点最大数量",
  BaseCampMaxNumInGuild: "公会的据点最大数量",
  BaseCampWorkerMaxNum: "可分配至据点工作的帕鲁数量上限",
  MaxBuildingLimitNum: "每个玩家的建筑物最大数量",
  DropItemAliveMaxHours: "掉落物品存活最大小时数",
  bAutoResetGuildNoOnlinePlayers: "自动重置无在线玩家的公会",
  AutoResetGuildTimeNoOnlinePlayers: "自动重置无在线玩家的公会时间（小时）",
  GuildPlayerMaxNum: "公会玩家最大数量",
  PalEggDefaultHatchingTime: "巨大蛋孵化所需时间（小时）",
  WorkSpeedRate: "工作速率",
  bIsMultiplay: "是否多人游戏",
  bIsPvP: "是否 PvP",
  bHardcore: "是否硬核模式",
  bPalLost: "是否帕鲁丢失模式",
  bCharacterRecreateInHardcore: "是否允许在硬核模式下重新创建角色",
  bCanPickupOtherGuildDeathPenaltyDrop: "能否拾取其他公会玩家的死亡惩罚掉落物",
  bEnableNonLoginPenalty: "启用超时未登录惩罚",
  bEnableFastTravel: "启用快速传送",
  bIsStartLocationSelectByMap: "是否通过地图选择复活位置",
  bExistPlayerAfterLogout: "登出后玩家人物是否存在",
  bEnableDefenseOtherGuildPlayer: "启用据点内防御其他公会玩家",
  bInvisibleOtherGuildBaseCampAreaFX: "隐藏其他公会据点区域特效",
  bBuildAreaLimit: "建筑区域限制",
  ItemWeightRate: "物品重量倍率",
  ServerReplicatePawnCullDistance: "玩家与帕鲁同步距离",
  bShowPlayerList: "启用服务器内可以查看其他玩家列表",
  RCONEnabled: "启用 RCON",
  RCONPort: "RCON 端口",
  RESTAPIEnabled: "启用 REST API",
  RESTAPIPort: "REST API 端口",
  Region: "地区",
  bUseAuth: "使用授权",
  BanListURL: "封禁列表 URL",
  bAllowClientMod: "允许客户端 Mod",
  bIsShowJoinLeftMessage: "显示玩家加入/离开消息",
  DenyTechnologyList: "禁用科技列表",
  GuildRejoinCooldownMinutes: "公会重加冷却时间（分钟）",
  BlockRespawnTime: "阻止重生时间",
  RespawnPenaltyDurationThreshold: "重生惩罚持续时间阈值",
  RespawnPenaltyTimeScale: "重生惩罚时间倍数",
  bDisplayPvPItemNumOnWorldMap_BaseCamp: "地图显示 PvP 掉落物数量（基地）",
  bDisplayPvPItemNumOnWorldMap_Player: "地图显示 PvP 掉落物数量（玩家）",
  AdditionalDropItemWhenPlayerKillingInPvPMode: "PvP 击杀附加掉落物",
  AdditionalDropItemNumWhenPlayerKillingInPvPMode: "PvP 击杀附加掉落物数量",
  bAdditionalDropItemWhenPlayerKillingInPvPMode: "启用 PvP 击杀附加掉落",
  bAllowEnhanceStat_Health: "允许加点：生命",
  bAllowEnhanceStat_Attack: "允许加点：攻击",
  bAllowEnhanceStat_Stamina: "允许加点：体力",
  bAllowEnhanceStat_Weight: "允许加点：负重",
  bAllowEnhanceStat_WorkSpeed: "允许加点：工作速度",
  PhysicsActiveDropItemMaxNum: "可启用物理模拟的掉落物最大数量",
  PlayerDataPalStorageUpdateCheckTickInterval: "玩家帕鲁仓库数据更新检测间隔",
  MonsterFarmActionSpeedRate: "帕鲁放牧产出物品速度倍率",
  AutoTransferMasterCheckIntervalSeconds: "公会归属自动转移检测间隔（秒）",
  AutoTransferMasterThresholdDays: "公会会长自动移交离线天数阈值",
  MaxGuildsPerFrame: "单帧处理公会最大数量",
  bEnableBuildingPlayerUIdDisplay: "显示建筑建造者玩家 ID",
  BuildingNameDisplayCacheTTLSeconds: "建筑名称显示缓存有效期（秒）",
  bEnableFastTravelOnlyBaseCamp: "仅基地可快速旅行",
  bAllowGlobalPalboxExport: "允许通过跨界帕鲁终端保存帕鲁的基因序列",
  bAllowGlobalPalboxImport: "允许通过跨界帕鲁终端的基因序列复原帕鲁",
  EquipmentDurabilityDamageRate: "装备耐久度损坏率",
  ItemContainerForceMarkDirtyInterval: "物品容器强制标记为脏的间隔（秒）",
  ItemCorruptionMultiplier: "物品腐化倍率",
};

const CONFIG_DESCRIPTIONS: Record<string, string> = {
  AutoSaveSpan: "服务器自动保存世界的时间间隔。",
  DeathPenalty: "决定玩家死亡时会掉落哪些物品。",
  LogFormatType: "选择服务器日志文件的保存格式。",
  RandomizerType: "决定随机化的作用范围。",
  CrossplayPlatforms: "选择允许加入本服务器的平台。",
  DenyTechnologyList: "选择需要从科技树中禁用的项目。",
};

type ConfigCategoryGroup = { id: ConfigCategoryId; tab: ConfigEditorTab; label: string; description: string; keys: string[] };

const CONFIG_CATEGORY_GROUPS: ConfigCategoryGroup[] = [
  { id: "server", tab: "panel", label: "基本信息", description: "名称、描述、密码、地区与玩家人数", keys: ["ServerName", "ServerDescription", "AdminPassword", "ServerPassword", "PublicIP", "PublicPort", "ServerPlayerMaxNum", "Region"] },
  { id: "runtime", tab: "panel", label: "运行与存档", description: "自动保存、备份与服务器运行行为", keys: ["bIsUseBackupSaveData", "AutoSaveSpan", "bIsMultiplay"] },
  { id: "network", tab: "panel", label: "网络与接口", description: "RCON、REST API 与封禁列表", keys: ["RCONEnabled", "RCONPort", "RESTAPIEnabled", "RESTAPIPort", "BanListURL"] },
  { id: "mods", tab: "panel", label: "跨平台与模组", description: "平台联机、客户端 Mod 与科技限制", keys: ["CrossplayPlatforms", "bAllowClientMod", "bAllowGlobalPalboxExport", "bAllowGlobalPalboxImport", "DenyTechnologyList"] },
  { id: "communication", tab: "panel", label: "聊天与语音", description: "聊天频率、日志与语音距离", keys: ["LogFormatType", "ChatPostLimitPerMinute", "bEnableVoiceChat", "VoiceChatMaxVolumeDistance", "VoiceChatZeroVolumeDistance", "bIsShowJoinLeftMessage"] },
  { id: "access", tab: "panel", label: "可见性与权限", description: "玩家列表与服务器授权显示", keys: ["bShowPlayerList", "bUseAuth"] },
  { id: "random", tab: "world", label: "随机化", description: "世界、帕鲁与等级的随机化规则", keys: ["RandomizerType", "RandomizerSeed", "bIsRandomizerPalLevelRandom"] },
  { id: "progression", tab: "world", label: "时间与成长", description: "昼夜、经验、捕捉、出现数量与工作速度", keys: ["DayTimeSpeedRate", "NightTimeSpeedRate", "ExpRate", "PalCaptureRate", "PalSpawnNumRate", "WorkSpeedRate"] },
  { id: "combat", tab: "world", label: "战斗", description: "玩家和帕鲁伤害、PvP、袭击与死亡惩罚", keys: ["PlayerDamageRateAttack", "PlayerDamageRateDefense", "PalDamageRateAttack", "PalDamageRateDefense", "bEnablePlayerToPlayerDamage", "bEnableFriendlyFire", "bIsPvP", "DeathPenalty", "bEnableInvaderEnemy", "EnablePredatorBossPal", "bHardcore", "bPalLost", "bCharacterRecreateInHardcore", "bCanPickupOtherGuildDeathPenaltyDrop", "bAdditionalDropItemWhenPlayerKillingInPvPMode", "AdditionalDropItemWhenPlayerKillingInPvPMode", "AdditionalDropItemNumWhenPlayerKillingInPvPMode"] },
  { id: "survival", tab: "world", label: "生存", description: "饱食度、耐力、生命恢复、孵化与重生", keys: ["PlayerStomachDecreaceRate", "PlayerStaminaDecreaceRate", "PlayerAutoHPRegeneRate", "PlayerAutoHpRegeneRateInSleep", "PalStomachDecreaceRate", "PalStaminaDecreaceRate", "PalAutoHPRegeneRate", "PalAutoHpRegeneRateInSleep", "PalEggDefaultHatchingTime", "bEnableNonLoginPenalty", "bExistPlayerAfterLogout", "BlockRespawnTime", "RespawnPenaltyDurationThreshold", "RespawnPenaltyTimeScale"] },
  { id: "resources", tab: "world", label: "资源与掉落", description: "采集、掉落、重量、空投与耐久度", keys: ["CollectionDropRate", "CollectionObjectHpRate", "CollectionObjectRespawnSpeedRate", "EnemyDropItemRate", "ItemWeightRate", "DropItemMaxNum", "DropItemMaxNum_UNKO", "DropItemAliveMaxHours", "SupplyDropSpan", "EquipmentDurabilityDamageRate", "ItemContainerForceMarkDirtyInterval", "ItemCorruptionMultiplier", "PhysicsActiveDropItemMaxNum", "bActiveUNKO"] },
  { id: "building", tab: "world", label: "建造与据点", description: "建筑耐久、建造限制、据点与防御规则", keys: ["BuildObjectHpRate", "BuildObjectDamageRate", "BuildObjectDeteriorationDamageRate", "MaxBuildingLimitNum", "bBuildAreaLimit", "BaseCampMaxNum", "BaseCampMaxNumInGuild", "BaseCampWorkerMaxNum", "bEnableDefenseOtherGuildPlayer", "bInvisibleOtherGuildBaseCampAreaFX", "bEnableBuildingPlayerUIdDisplay", "BuildingNameDisplayCacheTTLSeconds"] },
  { id: "guild", tab: "world", label: "公会与玩家", description: "公会人数、自动重置、归属转移与地图显示", keys: ["GuildPlayerMaxNum", "bAutoResetGuildNoOnlinePlayers", "AutoResetGuildTimeNoOnlinePlayers", "GuildRejoinCooldownMinutes", "AutoTransferMasterCheckIntervalSeconds", "AutoTransferMasterThresholdDays", "MaxGuildsPerFrame", "bDisplayPvPItemNumOnWorldMap_BaseCamp", "bDisplayPvPItemNumOnWorldMap_Player"] },
  { id: "worldRules", tab: "world", label: "世界规则", description: "传送、复活位置、瞄准辅助与其他规则", keys: ["bEnableFastTravel", "bEnableFastTravelOnlyBaseCamp", "bIsStartLocationSelectByMap", "bEnableAimAssistPad", "bEnableAimAssistKeyboard"] },
  { id: "performance", tab: "world", label: "高级性能", description: "同步距离、放牧和数据更新策略", keys: ["ServerReplicatePawnCullDistance", "PlayerDataPalStorageUpdateCheckTickInterval", "MonsterFarmActionSpeedRate"] },
  { id: "character", tab: "world", label: "角色成长", description: "允许玩家提升的角色属性", keys: ["bAllowEnhanceStat_Health", "bAllowEnhanceStat_Attack", "bAllowEnhanceStat_Stamina", "bAllowEnhanceStat_Weight", "bAllowEnhanceStat_WorkSpeed"] },
  { id: "advanced", tab: "world", label: "高级字段", description: "版本化 schema 外的配置键", keys: [] },
];

const CONFIG_CATEGORY_BY_KEY: Record<string, ConfigCategoryId> = {};
const CONFIG_TAB_BY_CATEGORY: Partial<Record<ConfigCategoryId, ConfigEditorTab>> = {};
for (const group of CONFIG_CATEGORY_GROUPS) {
  CONFIG_TAB_BY_CATEGORY[group.id] = group.tab;
  for (const key of group.keys) CONFIG_CATEGORY_BY_KEY[key] = group.id;
}

const CONFIG_NUMERIC_RANGES: Record<string, { min: number; max: number; step: number }> = {
  PublicPort: { min: 1, max: 65535, step: 1 },
  ServerPlayerMaxNum: { min: 1, max: 512, step: 1 },
  AutoSaveSpan: { min: 30, max: 3600, step: 30 },
  VoiceChatMaxVolumeDistance: { min: 0, max: 50000, step: 100 },
  VoiceChatZeroVolumeDistance: { min: 0, max: 50000, step: 100 },
  DayTimeSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  NightTimeSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  ExpRate: { min: 0.1, max: 20, step: 0.1 },
  PalCaptureRate: { min: 0.1, max: 5, step: 0.1 },
  PalSpawnNumRate: { min: 0.1, max: 5, step: 0.1 },
  PalDamageRateAttack: { min: 0.1, max: 5, step: 0.1 },
  PalDamageRateDefense: { min: 0.1, max: 5, step: 0.1 },
  PlayerDamageRateAttack: { min: 0.1, max: 5, step: 0.1 },
  PlayerDamageRateDefense: { min: 0.1, max: 5, step: 0.1 },
  PlayerStomachDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerStaminaDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerAutoHPRegeneRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerAutoHpRegeneRateInSleep: { min: 0.1, max: 5, step: 0.1 },
  PalStomachDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PalStaminaDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PalAutoHPRegeneRate: { min: 0.1, max: 5, step: 0.1 },
  PalAutoHpRegeneRateInSleep: { min: 0.1, max: 5, step: 0.1 },
  BuildObjectHpRate: { min: 0.1, max: 5, step: 0.1 },
  BuildObjectDamageRate: { min: 0.5, max: 3, step: 0.1 },
  BuildObjectDeteriorationDamageRate: { min: 0, max: 10, step: 0.1 },
  DropItemMaxNum: { min: 0, max: 10000, step: 1 },
  ItemWeightRate: { min: 0.1, max: 5, step: 0.1 },
  CollectionDropRate: { min: 0.5, max: 5, step: 0.1 },
  CollectionObjectHpRate: { min: 0.5, max: 3, step: 0.1 },
  CollectionObjectRespawnSpeedRate: { min: 0.5, max: 5, step: 0.1 },
  EnemyDropItemRate: { min: 0.5, max: 5, step: 0.1 },
  PalEggDefaultHatchingTime: { min: 0, max: 240, step: 0.1 },
  GuildPlayerMaxNum: { min: 1, max: 100, step: 1 },
  BaseCampMaxNumInGuild: { min: 1, max: 50, step: 1 },
  BaseCampWorkerMaxNum: { min: 1, max: 50, step: 1 },
  MaxBuildingLimitNum: { min: 0, max: 10000, step: 1 },
  SupplyDropSpan: { min: 0, max: 1000, step: 1 },
  ChatPostLimitPerMinute: { min: 0, max: 100, step: 1 },
  EquipmentDurabilityDamageRate: { min: 0.1, max: 5, step: 0.1 },
  ItemContainerForceMarkDirtyInterval: { min: 0.1, max: 10, step: 0.1 },
  ItemCorruptionMultiplier: { min: 0.1, max: 10, step: 0.1 },
  PhysicsActiveDropItemMaxNum: { min: 0, max: 10000, step: 1 },
  DropItemMaxNum_UNKO: { min: 0, max: 5000, step: 1 },
  BaseCampMaxNum: { min: 0, max: 10240, step: 1 },
  DropItemAliveMaxHours: { min: 0, max: 240, step: 0.1 },
  AutoResetGuildTimeNoOnlinePlayers: { min: 0, max: 240, step: 0.1 },
  WorkSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  ServerReplicatePawnCullDistance: { min: 500, max: 15000, step: 100 },
  RCONPort: { min: 1, max: 65535, step: 1 },
  RESTAPIPort: { min: 1, max: 65535, step: 1 },
  GuildRejoinCooldownMinutes: { min: 0, max: 1440, step: 1 },
  BlockRespawnTime: { min: 0, max: 60, step: 0.1 },
  RespawnPenaltyDurationThreshold: { min: 0, max: 3600, step: 1 },
  RespawnPenaltyTimeScale: { min: 0, max: 10, step: 0.1 },
  AdditionalDropItemNumWhenPlayerKillingInPvPMode: { min: 0, max: 100, step: 1 },
  PlayerDataPalStorageUpdateCheckTickInterval: { min: 0.1, max: 60, step: 0.1 },
  MonsterFarmActionSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  AutoTransferMasterCheckIntervalSeconds: { min: 60, max: 86400, step: 60 },
  AutoTransferMasterThresholdDays: { min: 1, max: 365, step: 1 },
  MaxGuildsPerFrame: { min: 1, max: 100, step: 1 },
  BuildingNameDisplayCacheTTLSeconds: { min: 1, max: 3600, step: 1 },
};

const CONFIG_SELECT_OPTIONS: Record<string, ConfigOption[]> = {
  RandomizerType: [
    { value: "None", label: "不随机化" },
    { value: "Region", label: "区域随机化" },
    { value: "All", label: "完全随机化" },
  ],
  LogFormatType: [
    { value: "Text", label: "纯文本" },
    { value: "Json", label: "JSON" },
  ],
  DeathPenalty: [
    { value: "None", label: "不掉落" },
    { value: "Item", label: "仅掉落物品" },
    { value: "ItemAndEquipment", label: "掉落物品和装备" },
    { value: "All", label: "全部掉落" },
  ],
};

const CONFIG_MULTI_OPTIONS: Record<string, ConfigOption[]> = {
  CrossplayPlatforms: [
    { value: "Steam", label: "Steam", description: "PC（Steam）" },
    { value: "Xbox", label: "Xbox", description: "Xbox / Microsoft Store" },
    { value: "PS5", label: "PlayStation 5", description: "PlayStation 5" },
    { value: "Mac", label: "Mac", description: "macOS" },
  ],
  DenyTechnologyList: [
    { value: "Accessory_AirDash2", label: "空中冲刺 II", description: "Accessory_AirDash2" },
    { value: "Accessory_AirDash3", label: "空中冲刺 III", description: "Accessory_AirDash3" },
    { value: "Accessory_JumpCount_Increase1", label: "二段跳", description: "Accessory_JumpCount_Increase1" },
    { value: "Accessory_JumpCount_Increase2", label: "三段跳", description: "Accessory_JumpCount_Increase2" },
    { value: "Accessory_Nonkilling", label: "不杀生", description: "Accessory_Nonkilling" },
    { value: "Accessory_TalentChecker", label: "天赋查看器", description: "Accessory_TalentChecker" },
    { value: "DimensionPalStorage", label: "跨界帕鲁终端", description: "DimensionPalStorage" },
    { value: "Battle_Sword_01", label: "单手剑", description: "Battle_Sword_01" },
  ],
};

const CONFIG_BOOLEAN_KEYS = new Set([
  "EnablePredatorBossPal",
  "RCONEnabled",
  "RESTAPIEnabled",
]);

function configCategoryFor(key: string): ConfigCategoryId {
  return CONFIG_CATEGORY_BY_KEY[key] || "advanced";
}

function configTabFor(key: string): ConfigEditorTab {
  return CONFIG_TAB_BY_CATEGORY[configCategoryFor(key)] ?? "world";
}

function configLabelFor(key: string): string {
  return CONFIG_LABELS[key] || key;
}

function configMetaFor(key: string, value: string): ConfigFieldMeta {
  if (key === "AdminPassword") {
    return {
      key,
      label: configLabelFor(key),
      description: "密码不会回显。输入新密码后保存草稿，再停服应用到游戏设置。",
      kind: "password",
    };
  }
  const range = CONFIG_NUMERIC_RANGES[key];
  if (range) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "可直接输入数值，也可以拖动进度条调整。",
      kind: "number",
      ...range,
    };
  }
  if (CONFIG_SELECT_OPTIONS[key]) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "从预设选项中选择配置值。",
      kind: "select",
      options: CONFIG_SELECT_OPTIONS[key],
    };
  }
  if (CONFIG_MULTI_OPTIONS[key]) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "可以同时选择多个配置项。",
      kind: "multi-select",
      options: CONFIG_MULTI_OPTIONS[key],
    };
  }
  if (CONFIG_BOOLEAN_KEYS.has(key) || key.startsWith("b") || /^(true|false)$/i.test(value.trim())) {
    return {
      key,
      label: configLabelFor(key),
      description: "开启或关闭这项服务器规则。",
      kind: "boolean",
    };
  }
  return {
    key,
    label: configLabelFor(key),
    description: "按原文本保存此配置值。",
    kind: "text",
  };
}

function configArrayValues(value: string): string[] {
  const content = value.trim().replace(/^\(|\)$/g, "");
  if (!content) return [];
  return content
    .split(",")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function configTupleValues(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") return configArrayValues(decoded);
    } catch {
      return [];
    }
  }
  return configArrayValues(value);
}

function serializeConfigArray(values: string[], previousValue: string): string {
  const previous = previousValue.trim();
  const wrapped = previous.startsWith("(") && previous.endsWith(")");
  const quoted = /(^|,)\s*"/.test(previous.replace(/^\(|\)$/g, ""));
  const content = values.map((value) => (quoted ? `"${value}"` : value)).join(",");
  return wrapped ? `(${content})` : content;
}

function serializeConfigTuple(values: string[]): string {
  return `(${values.join(",")})`;
}

function configNumberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatConfigNumberDisplay(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return String(Number(parsed.toFixed(2)));
}

function configTextDisplayValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function serializeConfigTextValue(displayValue: string, previousValue: string): string {
  const previous = previousValue.trim();
  if (previous.length >= 2 && previous.startsWith('"') && previous.endsWith('"')) {
    return `"${displayValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return displayValue;
}

function serializeConfigPassword(value: string): string {
  if (!value) return "";
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function configRangePercent(value: string, min: number, max: number): number {
  const numeric = configNumberValue(value, min);
  return Math.min(100, Math.max(0, ((numeric - min) / (max - min)) * 100));
}

function ConfigFieldEditor({
  meta,
  value,
  sourceValue,
  onChange,
  onReset,
}: {
  meta: ConfigFieldMeta;
  value: string;
  sourceValue: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const isCrossplayPlatforms = meta.key === "CrossplayPlatforms";
  const selectedValues = [...new Set(isCrossplayPlatforms ? configTupleValues(value) : configArrayValues(value))];
  const configuredOptions = meta.options || [];
  const configuredValues = new Set(configuredOptions.map((option) => option.value));
  const serverOptions = selectedValues
    .filter((selected) => !configuredValues.has(selected))
    .map((selected) => ({ value: selected, label: selected, description: "服务器当前配置中的原始值" }));
  const options = [...configuredOptions, ...serverOptions];
  const selectionLabel = selectedValues.length
    ? selectedValues.map((selected) => options.find((option) => option.value === selected)?.label || selected).join("、")
    : "未选择";

  return (
    <div className="config-field-row" data-config-key={meta.key}>
      <div className="config-field-copy">
        <div className="config-field-title">
          <strong>{meta.label}</strong>
          <code>{meta.key}</code>
        </div>
        <p>{meta.description}</p>
      </div>
      <div className={`config-field-control config-kind-${meta.kind}`}>
        {meta.kind === "number" && meta.min !== undefined && meta.max !== undefined && meta.step !== undefined && (
          <div className="config-range-control">
            <input
              className="config-number-input"
              type="number"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={formatConfigNumberDisplay(value)}
              aria-label={meta.label}
              onChange={(event) => onChange(event.target.value)}
            />
            <div className="config-range-wrap">
              <input
                className="config-range-input"
                type="range"
                min={meta.min}
                max={meta.max}
                step={meta.step}
                value={configNumberValue(value, meta.min)}
                style={{ "--config-progress": `${configRangePercent(value, meta.min, meta.max)}%` } as CSSProperties}
                aria-label={`${meta.label}滑块`}
                onChange={(event) => onChange(event.target.value)}
              />
              <div className="config-range-scale"><span>{meta.min}</span><span>{meta.max}</span></div>
            </div>
          </div>
        )}
        {meta.kind === "boolean" && (
          <button
            className={`config-switch ${/^true$/i.test(value.trim()) ? "is-on" : ""}`}
            type="button"
            role="switch"
            aria-checked={/^true$/i.test(value.trim())}
            aria-label={meta.label}
            onClick={() => onChange(/^true$/i.test(value.trim()) ? "False" : "True")}
          ><span className="config-switch-thumb" /></button>
        )}
        {meta.kind === "select" && (
          <div className="config-select-control">
            <select value={value} aria-label={meta.label} onChange={(event) => onChange(event.target.value)}>
              {meta.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        )}
        {meta.kind === "multi-select" && (
          <details className="config-multi-control">
            <summary aria-label={`${meta.label}：${selectedValues.length ? `已选 ${selectedValues.length} 项` : "未选择"}`}>
              <span className="config-multi-summary">
                <span className="config-multi-summary-count">{selectedValues.length ? `已选 ${selectedValues.length} 项` : "未选择"}</span>
                <span className="config-multi-summary-value" title={selectionLabel}>{selectionLabel}</span>
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="config-multi-menu" role="group" aria-label={`${meta.label}选项`}>
              <div className="config-multi-menu-header"><span>可选择项</span><strong>{selectedValues.length} / {options.length}</strong></div>
              <div className="config-multi-options">
                {options.map((option) => {
                  const checked = selectedValues.includes(option.value);
                  return (
                    <label key={option.value} className={`config-multi-option ${checked ? "is-selected" : ""}`}>
                      <input type="checkbox" checked={checked} aria-label={option.label} onChange={() => onChange(isCrossplayPlatforms ? serializeConfigTuple(checked ? selectedValues.filter((item) => item !== option.value) : [...selectedValues, option.value]) : serializeConfigArray(checked ? selectedValues.filter((item) => item !== option.value) : [...selectedValues, option.value], value))} />
                      <span className="config-multi-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </details>
        )}
        {meta.kind === "password" && <input className="config-text-input" type="password" autoComplete="new-password" value={configTextDisplayValue(value)} placeholder={sourceValue === "已配置" ? "已配置；输入新密码以覆盖" : "输入游戏管理员密码"} aria-label={meta.label} onChange={(event) => onChange(serializeConfigPassword(event.target.value))} />}
        {meta.kind === "text" && <input className="config-text-input" value={configTextDisplayValue(value)} aria-label={meta.label} onChange={(event) => onChange(serializeConfigTextValue(event.target.value, value))} />}
      </div>
      <button className="config-reset-button" type="button" title="恢复原值" aria-label={`恢复${meta.label}原值`} onClick={onReset} disabled={meta.kind === "password" ? !value : value === sourceValue}><RotateCcw size={15} /></button>
    </div>
  );
}

function ConfigPage({ auth }: { auth: AuthStatus }) {
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<{ hasDraft: boolean; conflict: Record<string, unknown> | null; text: string; fields: { key: string; current: string; draft: string }[] } | null>(null);
  const [query, setQuery] = useState("");
  const [editorTab, setEditorTab] = useState<ConfigEditorTab>("panel");
  const [selectedCategory, setSelectedCategory] = useState<ConfigCategoryId>("server");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await requestJson<ConfigDocument>("/api/config/draft");
      setDocument(next);
      const nextFields = { ...(next.draft?.fields || next.fields) };
      delete nextFields.AdminPassword;
      setFields(nextFields);
      setDiff(await requestJson<typeof diff>("/api/config/diff"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "配置读取失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const fieldsToSave = { ...fields };
    if (!fieldsToSave.AdminPassword) delete fieldsToSave.AdminPassword;
    try { await requestJson("/api/config/draft", { method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ fields: fieldsToSave }) }); setMessage("配置草稿已保存，尚未写入真实 INI。"); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "草稿保存失败"); } finally { setBusy(false); }
  }
  async function apply(force = false) {
    if (!window.confirm(force ? "检测到外部修改，确认用当前草稿覆盖吗？" : "确认应用配置吗？PalServer 必须已停止。")) return;
    setBusy(true); setError("");
    try { const result = await requestJson<{ message: string }>("/api/config/apply", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ force }) }); setMessage(result.message); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "配置应用失败"); } finally { setBusy(false); }
  }
  async function restartApply() {
    if (!window.confirm("确认停止并重启 PalServer 后应用草稿吗？将先发送维护通知并保存世界。")) return;
    try { await requestJson("/api/config/apply-with-restart", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ countdownSeconds: 30, message: "服务器将在 30 秒后重启并应用配置，请及时返回安全地点。" }) }); setMessage("已提交重启并应用操作。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "重启应用失败"); }
  }
  async function openFolder() { try { await requestJson("/api/config/open-folder", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}" }); setError(""); setMessage("已打开配置目录。"); } catch (caught) { setError(caught instanceof Error ? caught.message : "打开目录失败"); } }
  if (!document) return <div className="page-stack"><p className="muted">正在读取 PalWorldSettings.ini...</p></div>;

  const allKeys = [
    ...document.schema.filter((key) => key === "AdminPassword" || key in fields),
    ...Object.keys(fields).filter((key) => !document.schema.includes(key)),
  ];
  const configOrder = new Map<string, number>();
  CONFIG_CATEGORY_GROUPS.forEach((group, groupIndex) => group.keys.forEach((key, keyIndex) => configOrder.set(key, groupIndex * 1000 + keyIndex)));
  const orderedKeys = [...allKeys].sort((left, right) => (configOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (configOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const activeGroups = CONFIG_CATEGORY_GROUPS.filter((group) => group.tab === editorTab);
  const visibleKeys = orderedKeys.filter((key) => {
    const inTab = Boolean(normalizedQuery) || configTabFor(key) === editorTab;
    const inCategory = Boolean(normalizedQuery) || configCategoryFor(key) === selectedCategory;
    const searchable = `${configLabelFor(key)} ${key} ${CONFIG_DESCRIPTIONS[key] || ""}`.toLocaleLowerCase();
    return inTab && inCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
  const selectedGroup = CONFIG_CATEGORY_GROUPS.find((group) => group.id === selectedCategory) || CONFIG_CATEGORY_GROUPS[0];
  const tabTotal = allKeys.filter((key) => configTabFor(key) === editorTab).length;
  function switchEditorTab(tab: ConfigEditorTab) {
    const firstGroup = CONFIG_CATEGORY_GROUPS.find((group) => group.tab === tab && allKeys.some((key) => configCategoryFor(key) === group.id));
    setEditorTab(tab);
    setQuery("");
    setSelectedCategory(firstGroup?.id || (tab === "panel" ? "server" : "random"));
  }

  return <div className="page-stack config-page">
    <section className="config-status"><div><h2>PalWorldSettings.ini</h2><p>{document.path}</p></div><div className="config-actions">{auth.local && <button className="quiet-button" type="button" onClick={() => void openFolder()}><FolderSearch size={17} />打开配置目录</button>}<span className={document.adminPasswordConfigured ? "badge success" : "badge warning"}>AdminPassword：{document.adminPasswordConfigured ? "已配置" : "未配置"}</span></div></section>
    <div className="notice-band"><AlertTriangle size={20} /><span>运行中的 PalServer 不会被实时写入；保存草稿后可停服应用，或提交“重启并应用”。</span></div>
    {document.worldOptionPresent && <div className="warning-strip"><AlertTriangle size={19} /><span>检测到当前世界存在 WorldOption.sav，游戏内设置可能覆盖此 INI。仍可继续应用。</span></div>}
    <form className="config-form" onSubmit={saveDraft}>
      <section className="config-editor-shell">
        <div className="config-editor-tabs" role="tablist" aria-label="配置设置类型">
          <button className={editorTab === "panel" ? "is-active" : ""} type="button" role="tab" aria-selected={editorTab === "panel"} onClick={() => switchEditorTab("panel")}>面板设置</button>
          <button className={editorTab === "world" ? "is-active" : ""} type="button" role="tab" aria-selected={editorTab === "world"} onClick={() => switchEditorTab("world")}>世界设置</button>
        </div>
        <div className="config-editor-toolbar">
          <label className="config-search"><Search size={19} aria-hidden="true" /><input type="search" value={query} placeholder="搜索名称或配置键" aria-label="搜索名称或配置键" onChange={(event) => setQuery(event.target.value)} /></label>
          <span className="config-count">{normalizedQuery ? visibleKeys.length : tabTotal} 项配置</span>
        </div>
        <div className="config-editor-layout">
          <nav className="config-category-nav" aria-label="配置分类">
            {activeGroups.map((group) => {
              const count = allKeys.filter((key) => configCategoryFor(key) === group.id).length;
              return <button key={group.id} className={selectedCategory === group.id && !normalizedQuery ? "is-active" : ""} type="button" onClick={() => { setSelectedCategory(group.id); setQuery(""); }}><span>{group.label}</span><small>{count}</small></button>;
            })}
          </nav>
          <div className="config-editor-main">
            <header className="config-section-header"><div><p className="config-section-kicker">{normalizedQuery ? "搜索结果" : editorTab === "panel" ? "面板设置" : "世界设置"}</p><h2>{normalizedQuery ? "匹配的配置" : selectedGroup.label}</h2><p>{normalizedQuery ? `共找到 ${visibleKeys.length} 项配置。` : selectedGroup.description}</p></div><span className="config-section-total">{visibleKeys.length} 项</span></header>
            <div className="config-field-list">
              {visibleKeys.map((key) => {
                const meta = configMetaFor(key, fields[key] || "");
                const sourceValue = key === "AdminPassword" ? (document.adminPasswordConfigured ? "已配置" : "未配置") : document.fields[key] || "";
                return <ConfigFieldEditor key={key} meta={meta} value={fields[key] || ""} sourceValue={sourceValue} onChange={(value) => setFields((current) => ({ ...current, [key]: value }))} onReset={() => setFields((current) => {
                  if (meta.kind === "password") {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  }
                  return { ...current, [key]: document.fields[key] || "" };
                })} />;
              })}
              {!visibleKeys.length && <div className="config-empty-results"><Search size={22} /><p>没有找到匹配的配置。</p><button className="quiet-button" type="button" onClick={() => { setQuery(""); setSelectedCategory("server"); }}>清除搜索</button></div>}
            </div>
          </div>
        </div>
      </section>
      <div className="config-toolbar"><button className="primary-button" disabled={busy} type="submit"><Save size={18} />保存待应用草稿</button>{document.draft && <><button className="quiet-button" type="button" disabled={busy} onClick={() => void apply(false)}>停服应用</button><button className="quiet-button" type="button" disabled={busy} onClick={() => void restartApply()}><RotateCw size={17} />重启并应用</button></>}</div>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    {diff?.hasDraft && <section className={diff.conflict ? "config-diff conflict" : "config-diff"}><div className="section-heading"><div><h2>草稿差异</h2><p>{diff.conflict ? "检测到外部修改，应用前必须确认覆盖。" : "当前草稿尚未写入真实 INI。"}</p></div>{diff.conflict && <button className="danger-button" type="button" onClick={() => void apply(true)}>确认覆盖外部修改</button>}</div><pre>{diff.text || "字段值有变化，但文本差异为空。"}</pre></section>}
  </div>;
}

// Kept temporarily for the existing route fixture while the editor transition is validated.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function ConfigPageLegacy({ auth }: { auth: AuthStatus }) {
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<{ hasDraft: boolean; conflict: Record<string, unknown> | null; text: string; fields: { key: string; current: string; draft: string }[] } | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const next = await requestJson<ConfigDocument>("/api/config/draft");
      setDocument(next);
      setFields(next.draft?.fields || next.fields);
      setDiff(await requestJson<typeof diff>("/api/config/diff"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "配置读取失败"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    try { await requestJson("/api/config/draft", { method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ fields }) }); setMessage("配置草稿已保存，尚未写入真实 INI。"); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "草稿保存失败"); } finally { setBusy(false); }
  }
  async function apply(force = false) {
    if (!window.confirm(force ? "检测到外部修改，确认用当前草稿覆盖吗？" : "确认应用配置吗？PalServer 必须已停止。")) return;
    setBusy(true); setError("");
    try { const result = await requestJson<{ message: string }>("/api/config/apply", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ force }) }); setMessage(result.message); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "配置应用失败"); } finally { setBusy(false); }
  }
  async function restartApply() {
    if (!window.confirm("确认停止并重启 PalServer 后应用草稿吗？将先发送维护通知并保存世界。")) return;
    try { await requestJson("/api/config/apply-with-restart", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ countdownSeconds: 30, message: "服务器将在 30 秒后重启并应用配置，请及时返回安全地点。" }) }); setMessage("已提交重启并应用操作。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "重启应用失败"); }
  }
  async function openFolder() { try { await requestJson("/api/config/open-folder", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}" }); } catch (caught) { setError(caught instanceof Error ? caught.message : "打开目录失败"); } }
  if (!document) return <div className="page-stack"><p className="muted">正在读取 PalWorldSettings.ini...</p></div>;
  const allFields = document.schema.filter((key) => key !== "AdminPassword").filter((key) => key in fields);
  const unknown = Object.keys(fields).filter((key) => !document.schema.includes(key) && key !== "AdminPassword");
  return <div className="page-stack config-page">
    <section className="config-status"><div><h2>PalWorldSettings.ini</h2><p>{document.path}</p></div><div className="config-actions">{auth.local && <button className="quiet-button" onClick={() => void openFolder()}><FolderSearch size={17} />打开配置目录</button>}<span className={document.adminPasswordConfigured ? "badge success" : "badge warning"}>AdminPassword：{document.adminPasswordConfigured ? "已配置" : "未配置"}</span></div></section>
    <div className="notice-band"><AlertTriangle size={20} /><span>运行中的 PalServer 不会被实时写入；保存草稿后可停服应用，或提交“重启并应用”。</span></div>
    {document.worldOptionPresent && <div className="warning-strip"><AlertTriangle size={19} /><span>检测到当前世界存在 WorldOption.sav，游戏内设置可能覆盖此 INI。仍可继续应用。</span></div>}
    <form className="config-form" onSubmit={saveDraft}>
      <section className="settings-section"><div className="section-heading"><div><h2>已识别字段</h2><p>字段值按原文本保存；未知字段会继续保留。</p></div></div><div className="config-grid">{allFields.map((key) => <label key={key} htmlFor={`config-${key}`}><span>{key}</span><input id={`config-${key}`} value={fields[key] || ""} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>)}</div></section>
      <section className="settings-section"><div className="section-heading"><div><h2>高级字段</h2><p>来自当前 INI 但不在版本化 schema 中的键，仍可编辑。</p></div></div>{unknown.length ? <div className="config-grid">{unknown.map((key) => <label key={key} htmlFor={`config-unknown-${key}`}><span>{key}</span><input id={`config-unknown-${key}`} value={fields[key] || ""} onChange={(event) => setFields({ ...fields, [key]: event.target.value })} /></label>)}</div> : <p className="empty-state">当前没有未知字段。</p>}</section>
      <div className="config-toolbar"><button className="primary-button" disabled={busy} type="submit"><Save size={18} />保存待应用草稿</button>{document.draft && <><button className="quiet-button" type="button" disabled={busy} onClick={() => void apply(false)}>停服应用</button><button className="quiet-button" type="button" disabled={busy} onClick={() => void restartApply()}><RotateCw size={17} />重启并应用</button></>}</div>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    {diff?.hasDraft && <section className={diff.conflict ? "config-diff conflict" : "config-diff"}><div className="section-heading"><div><h2>草稿差异</h2><p>{diff.conflict ? "检测到外部修改，应用前必须确认覆盖。" : "当前草稿尚未写入真实 INI。"}</p></div>{diff.conflict && <button className="danger-button" type="button" onClick={() => void apply(true)}>确认覆盖外部修改</button>}</div><pre>{diff.text || "字段值有变化，但文本差异为空。"}</pre></section>}
  </div>;
}

function LogoutButton({ csrfToken, onDone }: { csrfToken: string | null; onDone: () => void }) {
  async function logout() {
    await requestJson("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken || "" }, body: "{}" });
    onDone();
  }
  return <button className="quiet-button" type="button" onClick={() => void logout()}><LogOut size={18} />{text.logout}</button>;
}
