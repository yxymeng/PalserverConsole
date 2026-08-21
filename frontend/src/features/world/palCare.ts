import type { WorldPalCare } from "../../api/contracts";

const diseaseLabels: Record<string, string> = {
  cold: "感冒", sick: "感冒", commoncold: "感冒", sprain: "扭伤", injury: "扭伤",
  ulcer: "胃溃疡", stomachulcer: "胃溃疡", fracture: "骨折", bonefracture: "骨折",
  weakness: "虚弱", depression: "抑郁症", gluttony: "暴食症", overeating: "暴食症",
};
const activityLabels: Record<string, string> = {
  work: "工作中", working: "工作中", rest: "休息", resting: "休息",
  lazy: "偷懒", slacking: "偷懒", idle: "闲置",
};

function enumKey(value: string) {
  return value.split("::").at(-1)?.replaceAll("_", "").replaceAll("-", "").toLowerCase() || value;
}

export function diseaseLabel(disease: string | null) {
  if (!disease) return null;
  return diseaseLabels[enumKey(disease)] || null;
}

export function activityLabel(activity: string | null) {
  if (!activity) return null;
  return activityLabels[enumKey(activity)] || null;
}

export function careSummaryLabel(care: WorldPalCare) {
  if (care.attention) return care.severity === "critical" ? "需立即处理" : "需要关注";
  if (care.unavailable.length) return "数据不可用";
  if (care.activity) return activityLabel(care.activity) || "存档活动";
  return "未见异常";
}

export function careReasonLabels(care: WorldPalCare) {
  return care.reasons.map((reason) => ({
    zero_hp: "生命值为零", disease: diseaseLabel(care.disease) || `资料未收录：${care.disease}`,
    hunger_low: "饱食度低于 20%", san_low: "SAN 低于 50%",
  })[reason]);
}
