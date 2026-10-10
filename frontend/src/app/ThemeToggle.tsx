import { Leaf, Moon, Palette, Sun } from "lucide-react";

import type { Theme } from "../api/contracts";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "../components/ui/select";
import { cn } from "../lib/utils";
import { THEME_OPTIONS } from "./theme";

const THEME_ICONS = { light: Leaf, island: Sun, dark: Moon } as const;

export function ThemeToggle({
  theme,
  onChange,
  className = "",
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
  className?: string;
}) {
  const current = THEME_OPTIONS.find((option) => option.id === theme) ?? THEME_OPTIONS[0];
  return (
    <div className={cn("theme-selector", className)}>
      <Select value={theme} onValueChange={(value) => { if (value) onChange(value as Theme); }}>
        <SelectTrigger className="psc-topbar-control theme-selector-trigger" aria-label={`选择界面主题，当前${current.shortName}`} data-theme-value={theme}>
          <Palette aria-hidden="true" />
          <span>{current.shortName}</span>
        </SelectTrigger>
        <SelectContent className="psc-theme-menu" align="end" sideOffset={8} alignItemWithTrigger={false}>
          <SelectGroup>
            <SelectLabel className="psc-theme-menu-title">切换界面主题风格</SelectLabel>
            {THEME_OPTIONS.map((option) => {
              const Icon = THEME_ICONS[option.id];
              return <SelectItem className="psc-theme-option" key={option.id} value={option.id}>
                <span className="psc-theme-option-icon" data-option-theme={option.id}><Icon aria-hidden="true" /></span>
                <span className="psc-theme-option-copy"><strong>{option.name}</strong><small>{option.description}</small></span>
              </SelectItem>;
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
