import { Activity, Database, FileCog, LogOut, Menu, MonitorCog, Wrench, X } from "lucide-react";
import { useState } from "react";
import type { AuthStatus, ShellStatus, Theme } from "../api/contracts";
import { requestJson } from "../api/client";
import { ConfigPage } from "../features/config/ConfigPage";
import { MaintenancePage } from "../features/maintenance/MaintenancePage";
import { Overview } from "../features/overview/Overview";
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
  const [active, setActive] = useState<"overview" | "world" | "config" | "maintenance">("overview");
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
            <Activity size={19} />首页
          </button>
          <button className={active === "world" ? "active" : ""} onClick={() => { setActive("world"); setMenuOpen(false); }}>
            <Database size={19} />{text.world}
          </button>
          <button className={active === "config" ? "active" : ""} onClick={() => { setActive("config"); setMenuOpen(false); }}>
            <FileCog size={19} />配置
          </button>
          <button className={active === "maintenance" ? "active" : ""} onClick={() => { setActive("maintenance"); setMenuOpen(false); }}>
            <Wrench size={19} />维护
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
              <h1>{active === "overview" ? "首页" : active === "world" ? text.world : active === "config" ? "配置" : "维护"}</h1>
            </div>
            <div className="topbar-actions">
              <ThemeToggle theme={theme} onToggle={onThemeToggle} />
              {!auth.local && <LogoutButton csrfToken={auth.csrfToken} onDone={onAuthChanged} />}
            </div>
          </div>
        </header>
        {active === "overview" && <Overview shell={shell} auth={auth} />}
        {active === "world" && <WorldDataPage auth={auth} />}
        {active === "config" && <ConfigPage auth={auth} onAuthChanged={onAuthChanged} />}
        {active === "maintenance" && <MaintenancePage auth={auth} />}
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
