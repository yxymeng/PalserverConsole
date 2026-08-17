import { cn } from "../lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("brand-mark", className)}>
      <img src="/zoe-console-icon.png" alt="" aria-hidden="true" />
    </span>
  );
}
