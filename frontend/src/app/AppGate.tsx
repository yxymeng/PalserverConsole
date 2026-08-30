import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AuthStatus, ShellStatus, Theme } from "../api/contracts";
import { isAbortError, requestJson } from "../api/client";
import { useAbortableRequest } from "../hooks/useAbortableRequest";
import { ConsoleShell } from "./ConsoleShell";
import { BrandMark } from "./BrandMark";
import { AppShellSkeleton } from "./PageLoadingStates";
import { text } from "./text";
import { ThemeToggle } from "./ThemeToggle";

const THEME_STORAGE_KEY = "palserver-console-theme";
const LEGACY_PALETTE_STORAGE_KEY = "palserver-console-palette";
const THEME_COLORS: Record<Theme, string> = { light: "#fafaf8", dark: "#1e2222" };

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "dark" || saved === "light" ? saved : "light";
  } catch {
    return "light";
  }
}

export function AppGate() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [shell, setShell] = useState<ShellStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const nextRequestSignal = useAbortableRequest();

  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    setLoadError("");
    try {
      const status = await requestJson<AuthStatus>("/api/auth/status", { signal });
      setAuth(status);
      setShell(
        status.authenticated
          ? await requestJson<ShellStatus>("/api/shell/status", { signal })
          : null,
      );
    } catch (error) {
      if (isAbortError(error)) return;
      setLoadError(error instanceof Error ? error.message : "连接失败");
    }
  }, [nextRequestSignal]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is optional when browser storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    delete document.documentElement.dataset.palette;
    try {
      window.localStorage.removeItem(LEGACY_PALETTE_STORAGE_KEY);
    } catch {
      // Removing the retired palette preview setting is optional when storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", THEME_COLORS[theme]);
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

function LoadingScreen({ theme, onThemeToggle }: { theme: Theme; onThemeToggle: () => void }) {
  return <AppShellSkeleton theme={theme} onThemeToggle={onThemeToggle} />;
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
          <BrandMark />
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
