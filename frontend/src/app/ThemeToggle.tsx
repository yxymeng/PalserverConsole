import { Moon, Sun } from "lucide-react";

import type { Theme } from "../api/contracts";

export function ThemeToggle({
  theme,
  onToggle,
  className = "",
}: {
  theme: Theme;
  onToggle: () => void;
  className?: string;
}) {
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
