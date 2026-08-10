import type { ShellStatus } from "../../api/contracts";

export function serverStateLabel(state?: ShellStatus["serverState"]): string {
  if (state === "running") return "运行中";
  if (state === "stopped") return "已停止";
  return "尚未配置";
}
