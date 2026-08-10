import type { OperationalHealthState } from "../../api/contracts";

export type HealthTone = "success" | "warning" | "danger" | "muted";

export function healthStateLabel(state: OperationalHealthState | string) {
  const labels: Record<string, string> = {
    ok: "正常",
    healthy: "正常",
    warning: "需要关注",
    blocked: "空间不足，已阻止复制",
    unavailable: "不可用",
    no_data: "无数据",
    stale: "数据较旧",
    failed: "解析失败",
    stopped: "后台已停止",
    invalid: "校验无效",
  };
  return labels[state] || "状态未知";
}

export function healthStateTone(state: OperationalHealthState | string): HealthTone {
  if (["blocked", "failed", "stopped", "invalid"].includes(state)) return "danger";
  if (["warning", "unavailable", "no_data", "stale"].includes(state)) return "warning";
  if (["ok", "healthy"].includes(state)) return "success";
  return "muted";
}

export function healthTime(value: number | null | undefined) {
  return value ? new Date(value * 1000).toLocaleString("zh-CN") : "尚未成功";
}
