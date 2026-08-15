import { Moon, Sun } from "lucide-react";

import type { Theme } from "../api/contracts";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";

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
    <Tooltip>
      <TooltipTrigger
        render={<Button variant="outline" size="icon" />}
        aria-label={label}
        aria-pressed={isDark}
        className={cn("theme-toggle", className)}
        onClick={onToggle}
        title={label}
      >
        {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
