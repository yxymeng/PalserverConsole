import { Activity, Database, FileCog, LogOut, Wrench } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";

import type { AuthStatus, ShellStatus, Theme } from "../api/contracts";
import { requestJson } from "../api/client";
import { Badge } from "../components/ui/badge";
import { BlurFade } from "../components/ui/blur-fade";
import { Button } from "../components/ui/button";
import { MaintenancePage } from "../features/maintenance/MaintenancePage";
import { Overview } from "../features/overview/Overview";
import { serverStateLabel } from "../features/server/labels";
import { text } from "./text";
import { BrandMark } from "./BrandMark";
import { PageLoadBoundary, PageSkeleton } from "./PageLoadingStates";
import { ThemeToggle } from "./ThemeToggle";

type PageKey = "overview" | "world" | "config" | "maintenance";

const WorldDataPage = lazy(() =>
  import("../features/world/WorldDataPage").then((module) => ({
    default: module.WorldDataPage,
  })),
);
const ConfigPage = lazy(() =>
  import("../features/config/ConfigPage").then((module) => ({
    default: module.ConfigPage,
  })),
);

const NAVIGATION = [
  { key: "overview", label: "首页", icon: Activity },
  { key: "world", label: "世界", icon: Database },
  { key: "config", label: "配置", icon: FileCog },
  { key: "maintenance", label: "维护", icon: Wrench },
] as const;

const PAGE_RETRY_STORAGE_KEY = "palserver-console-retry-page";

function initialPage(): PageKey {
  if (typeof window === "undefined") return "overview";
  try {
    const saved = window.sessionStorage.getItem(PAGE_RETRY_STORAGE_KEY);
    window.sessionStorage.removeItem(PAGE_RETRY_STORAGE_KEY);
    return NAVIGATION.some((item) => item.key === saved) ? saved as PageKey : "overview";
  } catch {
    return "overview";
  }
}

function retryPage(page: PageKey) {
  try {
    window.sessionStorage.setItem(PAGE_RETRY_STORAGE_KEY, page);
  } finally {
    window.location.reload();
  }
}

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
  const [active, setActive] = useState<PageKey>(initialPage);
  const [configWorkspace, setConfigWorkspace] = useState<"game" | "instance">("game");
  const [currentShell, setCurrentShell] = useState(shell);
  useEffect(() => setCurrentShell(shell), [shell]);
  return (
    <div className="psc-shell">
      <ConsoleLayout
        active={active}
        auth={auth}
        shell={currentShell}
        theme={theme}
        onActiveChange={setActive}
        configWorkspace={configWorkspace}
        onConfigWorkspaceChange={setConfigWorkspace}
        onAuthChanged={onAuthChanged}
        onShellStatusChange={setCurrentShell}
        onThemeToggle={onThemeToggle}
      />
    </div>
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
  onShellStatusChange,
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
  onShellStatusChange: (status: ShellStatus) => void;
  onThemeToggle: () => void;
}) {
  const pageTitle = NAVIGATION.find((item) => item.key === active)?.label || "首页";

  function activate(page: PageKey) {
    if (page === "config") onConfigWorkspaceChange("game");
    onActiveChange(page);
  }

  return (
    <>
      <header className="psc-topbar">
        <div className="psc-topbar-inner">
          <div className="psc-desktop-brand" aria-label={text.product}>
            <BrandMark />
            <span className="psc-brand-copy"><strong>{text.product}</strong><small>PalServer 值守台</small></span>
          </div>
          <h1 className="psc-mobile-page-title">{pageTitle}</h1>
          <PrimaryNavigation className="psc-desktop-navigation" active={active} onActivate={activate} />
          <div className="psc-topbar-actions">
              <Badge
                className="psc-server-status"
                data-state={shell?.serverState ?? "loading"}
                variant="outline"
              >
              <span className="status-dot" aria-hidden="true" />
              {shell ? serverStateLabel(shell.serverState) : "读取中"}
            </Badge>
            <ThemeToggle theme={theme} onToggle={onThemeToggle} />
            {!auth.local && <LogoutButton csrfToken={auth.csrfToken} onDone={onAuthChanged} />}
          </div>
        </div>
      </header>

      <main className="psc-main" aria-label={`${pageTitle}页面`}>
        <BlurFade key={active} className="psc-page-transition" duration={0.22} offset={0} blur="3px">
          {active === "overview" && <Overview shell={shell} auth={auth} onOpenMaintenance={() => onActiveChange("maintenance")} onShellStatusChange={onShellStatusChange} />}
          {active === "world" && (
            <PageLoadBoundary errorTitle="世界界面加载失败" retryLabel="重试加载世界" onRetry={() => retryPage("world")}>
              <Suspense fallback={<PageSkeleton page="world" label="正在加载世界界面" />}>
                <WorldDataPage auth={auth} />
              </Suspense>
            </PageLoadBoundary>
          )}
          {active === "config" && (
            <PageLoadBoundary errorTitle="配置界面加载失败" retryLabel="重试加载配置" onRetry={() => retryPage("config")}>
              <Suspense fallback={<PageSkeleton page="config" label="正在加载配置界面" />}>
                <ConfigPage
                  auth={auth}
                  onAuthChanged={onAuthChanged}
                  workspace={configWorkspace}
                  onWorkspaceChange={onConfigWorkspaceChange}
                />
              </Suspense>
            </PageLoadBoundary>
          )}
          {active === "maintenance" && <MaintenancePage auth={auth} />}
        </BlurFade>
      </main>

      <PrimaryNavigation className="psc-mobile-navigation" active={active} onActivate={activate} />
    </>
  );
}

function PrimaryNavigation({ className, active, onActivate }: { className: string; active: PageKey; onActivate: (page: PageKey) => void }) {
  return (
    <nav aria-label="主导航" className={`psc-primary-navigation ${className}`}>
      {NAVIGATION.map((item) => {
        const Icon = item.icon;
        return (
          <Button
            key={item.key}
            variant={active === item.key ? "default" : "ghost"}
            size="sm"
            type="button"
            aria-current={active === item.key ? "page" : undefined}
            onClick={() => onActivate(item.key)}
          >
            <Icon data-icon="inline-start" aria-hidden="true" />
            <span>{item.label}</span>
          </Button>
        );
      })}
    </nav>
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
