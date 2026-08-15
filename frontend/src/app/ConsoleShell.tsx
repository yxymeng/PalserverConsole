import { Activity, Database, FileCog, LogOut, Wrench, X } from "lucide-react";
import { useState, type CSSProperties } from "react";

import type { AuthStatus, ShellStatus, Theme } from "../api/contracts";
import { requestJson } from "../api/client";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar";
import { ConfigPage } from "../features/config/ConfigPage";
import { MaintenancePage } from "../features/maintenance/MaintenancePage";
import { Overview } from "../features/overview/Overview";
import { WorldDataPage } from "../features/world/WorldDataPage";
import { text } from "./text";
import { BrandMark } from "./BrandMark";
import { InstanceQuickPanel } from "./InstanceQuickPanel";
import { ThemeToggle } from "./ThemeToggle";
import { FRONTEND_VERSION } from "./version";

type PageKey = "overview" | "world" | "config" | "maintenance";

const NAVIGATION = [
  { key: "overview", label: "首页", icon: Activity },
  { key: "world", label: text.world, icon: Database },
  { key: "config", label: "配置", icon: FileCog },
  { key: "maintenance", label: "维护", icon: Wrench },
] as const;

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
  const [active, setActive] = useState<PageKey>("overview");
  const [configWorkspace, setConfigWorkspace] = useState<"game" | "instance">("game");
  const sidebarStyle = { "--sidebar-width": "252px" } as CSSProperties;

  return (
    <SidebarProvider style={sidebarStyle}>
      <ConsoleLayout
        active={active}
        auth={auth}
        shell={shell}
        theme={theme}
        onActiveChange={setActive}
        configWorkspace={configWorkspace}
        onConfigWorkspaceChange={setConfigWorkspace}
        onAuthChanged={onAuthChanged}
        onThemeToggle={onThemeToggle}
      />
    </SidebarProvider>
  );
}

function ConsoleLayout({
  active,
  auth,
  shell,
  theme,
  onActiveChange,
  configWorkspace,
  onConfigWorkspaceChange,
  onAuthChanged,
  onThemeToggle,
}: {
  active: PageKey;
  auth: AuthStatus;
  shell: ShellStatus | null;
  theme: Theme;
  onActiveChange: (page: PageKey) => void;
  configWorkspace: "game" | "instance";
  onConfigWorkspaceChange: (workspace: "game" | "instance") => void;
  onAuthChanged: () => void;
  onThemeToggle: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const pageTitle = NAVIGATION.find((item) => item.key === active)?.label || "首页";

  function activate(page: PageKey) {
    if (page === "config") onConfigWorkspaceChange("game");
    onActiveChange(page);
    if (isMobile) setOpenMobile(false);
  }

  return (
    <>
      <Sidebar collapsible="offcanvas" className="psc-sidebar">
        <SidebarHeader className="psc-sidebar-header">
          <div className="psc-brand-row">
            <BrandMark />
            <span className="psc-brand-copy"><strong>{text.product}</strong><small>PalServer 值守台</small></span>
            {isMobile && (
              <Button variant="ghost" size="icon" aria-label="关闭菜单" onClick={() => setOpenMobile(false)}>
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        </SidebarHeader>
        <SidebarSeparator />
        <SidebarContent>
          <nav aria-label="主导航" className="psc-navigation">
            <SidebarMenu>
              {NAVIGATION.map((item) => {
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.key}>
                    <SidebarMenuButton
                      isActive={active === item.key}
                      aria-current={active === item.key ? "page" : undefined}
                      onClick={() => activate(item.key)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </nav>
        </SidebarContent>
        <SidebarFooter className="psc-sidebar-footer">
          <Badge variant={auth.local ? "success" : "warning"}>
            <span className="status-dot" aria-hidden="true" />
            {auth.local ? "本机访问" : "局域网会话"}
          </Badge>
          <small>前端 v{FRONTEND_VERSION}</small>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="psc-inset">
        <header className="psc-topbar">
          <div className="psc-topbar-inner">
            <SidebarTrigger className="md:hidden" aria-label="打开菜单" title="打开菜单" />
            <h1>{pageTitle}</h1>
            <div className="psc-topbar-actions">
              <Badge className="hidden sm:inline-flex" variant={auth.local ? "success" : "warning"}>
                {auth.local ? "本机" : "LAN"} · {auth.port}
              </Badge>
              <InstanceQuickPanel
                auth={auth}
                shell={shell}
                onOpenSettings={() => {
                  onConfigWorkspaceChange("instance");
                  onActiveChange("config");
                }}
              />
              <ThemeToggle theme={theme} onToggle={onThemeToggle} />
              {!auth.local && <LogoutButton csrfToken={auth.csrfToken} onDone={onAuthChanged} />}
            </div>
          </div>
        </header>
        <main className="psc-main" aria-label={`${pageTitle}页面`}>
          {active === "overview" && <Overview shell={shell} auth={auth} onOpenMaintenance={() => onActiveChange("maintenance")} />}
          {active === "world" && <WorldDataPage auth={auth} />}
          {active === "config" && (
            <ConfigPage
              auth={auth}
              onAuthChanged={onAuthChanged}
              workspace={configWorkspace}
              onWorkspaceChange={onConfigWorkspaceChange}
            />
          )}
          {active === "maintenance" && <MaintenancePage auth={auth} />}
        </main>
      </SidebarInset>
    </>
  );
}

function LogoutButton({ csrfToken, onDone }: { csrfToken: string | null; onDone: () => void }) {
  async function logout() {
    await requestJson("/api/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrfToken || "" }, body: "{}" });
    onDone();
  }

  return (
    <Button variant="outline" type="button" onClick={() => void logout()}>
      <LogOut data-icon="inline-start" aria-hidden="true" />
      <span className="psc-logout-label">{text.logout}</span>
    </Button>
  );
}
