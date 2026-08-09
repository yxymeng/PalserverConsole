import { Activity, Archive, Database, FileClock, FileCog, LogOut, Menu, MonitorCog, Server, X } from "lucide-react";
import { useState } from "react";
import type { AuthStatus, ShellStatus, Theme } from "../api/contracts";
import { requestJson } from "../api/client";
import { AuditPage } from "../features/audit/AuditPage";
import { BackupsPage } from "../features/backups/BackupsPage";
import { ConfigPage } from "../features/config/ConfigPage";
import { Overview } from "../features/overview/Overview";
import { ServerManagement } from "../features/server/ServerManagement";
import { WorldDataPage } from "../features/world/WorldDataPage";
import { text } from "./text";
import { ThemeToggle } from "./ThemeToggle";
import { FRONTEND_VERSION } from "./version";

export function ConsoleShell({
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
        <small className="sidebar-version">前端 v{FRONTEND_VERSION}</small>
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

function LogoutButton({ csrfToken, onDone }: { csrfToken: string | null; onDone: () => void }) {
  async function logout() {
    await requestJson("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken || "" }, body: "{}" });
    onDone();
  }
  return <button className="quiet-button" type="button" onClick={() => void logout()}><LogOut size={18} />{text.logout}</button>;
}
