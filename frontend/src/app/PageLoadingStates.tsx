import { AlertTriangle, RefreshCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "../components/ui/button";
import type { Theme } from "../api/contracts";
import { BrandMark } from "./BrandMark";
import { text } from "./text";
import { ThemeToggle } from "./ThemeToggle";

export type SkeletonPage = "overview" | "world" | "config";

export function PageSkeleton({ page, label }: { page: SkeletonPage; label: string }) {
  return (
    <section className={`page-stack psc-page-skeleton is-${page}`} role="status" aria-label={label} aria-busy="true">
      {page === "config" ? <div className="psc-page-skeleton-tabs" aria-hidden="true"><span /><span /></div> : null}
      <div className="psc-page-skeleton-lead" aria-hidden="true">
        <div className="psc-page-skeleton-copy">
          <span className="psc-skeleton-block psc-page-skeleton-kicker" />
          <span className="psc-skeleton-block psc-page-skeleton-title" />
          <span className="psc-skeleton-block psc-page-skeleton-text" />
          <span className="psc-skeleton-block psc-page-skeleton-text short" />
        </div>
        <span className="psc-skeleton-block psc-page-skeleton-media" />
      </div>
      {page !== "config" ? <div className="psc-page-skeleton-tabs" aria-hidden="true"><span /><span /><span /></div> : null}
      <div className="psc-page-skeleton-grid" aria-hidden="true">
        {Array.from({ length: page === "overview" ? 4 : 3 }, (_, index) => (
          <span className="psc-skeleton-block" key={index} />
        ))}
      </div>
    </section>
  );
}

export function AppShellSkeleton({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  return (
    <div className="psc-shell psc-shell-skeleton">
      <header className="psc-topbar">
        <div className="psc-topbar-inner">
          <div className="psc-desktop-brand" aria-label={text.product}>
            <BrandMark />
            <span className="psc-brand-copy"><strong>{text.product}</strong><small>PalServer 值守台</small></span>
          </div>
          <h1 className="psc-mobile-page-title">首页</h1>
          <div className="psc-desktop-navigation psc-shell-skeleton-navigation" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => <span className="psc-skeleton-block" key={index} />)}
          </div>
          <div className="psc-topbar-actions">
            <span className="psc-skeleton-block psc-shell-skeleton-status" aria-hidden="true" />
            <ThemeToggle theme={theme} onToggle={onThemeToggle} />
          </div>
        </div>
      </header>
      <main className="psc-main" aria-label="首页页面">
        <PageSkeleton page="overview" label="正在连接本机控制台" />
      </main>
      <div className="psc-mobile-navigation psc-shell-skeleton-mobile-navigation" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => <span className="psc-skeleton-block" key={index} />)}
      </div>
    </div>
  );
}

type PageLoadBoundaryProps = {
  children: ReactNode;
  errorTitle: string;
  retryLabel: string;
  onRetry: () => void;
};

type PageLoadBoundaryState = { error: Error | null };

export class PageLoadBoundary extends Component<PageLoadBoundaryProps, PageLoadBoundaryState> {
  state: PageLoadBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PageLoadBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page module render failure", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="page-stack psc-page-load-error" role="alert">
        <div className="psc-page-load-error-panel">
          <span className="psc-page-load-error-icon" aria-hidden="true"><AlertTriangle /></span>
          <div>
            <h2>{this.props.errorTitle}</h2>
            <p>页面模块没有成功载入。顶部状态和其他入口仍可使用，请重试当前页面。</p>
            <code>{this.state.error.message}</code>
          </div>
          <Button variant="outline" type="button" onClick={this.props.onRetry}>
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {this.props.retryLabel}
          </Button>
        </div>
      </section>
    );
  }
}
