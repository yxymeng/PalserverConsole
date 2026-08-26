import type { WorldSnapshotSummary } from "../../api/contracts";

export type SnapshotTone = "ready" | "warning" | "danger" | "loading";

export type SnapshotPresentation = {
  label: string;
  summary: string;
  impact: string;
  nextStep: string;
  tone: SnapshotTone;
  errorIdentifier: string | null;
};

export function presentWorldSnapshot(status: WorldSnapshotSummary | null): SnapshotPresentation {
  if (!status) {
    return {
      label: "正在读取存档快照",
      summary: "正在检查可用的只读世界数据。",
      impact: "世界资产暂不可判断。",
      nextStep: "请稍候，读取完成后会显示快照来源与解析状态。",
      tone: "loading",
      errorIdentifier: null,
    };
  }

  const hasCache = Boolean(status.snapshotId);
  const errorIdentifier = status.errorCode || status.error || null;
  if (status.parsing || status.parseStatus === "parsing") {
    return {
      label: hasCache ? "正在解析新存档快照" : "正在解析首个存档快照",
      summary: hasCache ? "当前继续显示最后成功缓存，新快照完成后会自动切换。" : "尚未生成可用缓存，世界资产暂不可用。",
      impact: hasCache ? "数据不是实时状态，仍以当前展示的旧快照为准。" : "在解析完成前，无法浏览世界资产。",
      nextStep: "解析只读取存档，不会修改真实 .sav。",
      tone: "loading",
      errorIdentifier,
    };
  }

  if (errorIdentifier || status.parseStatus === "failed" || status.parseStatus === "incompatible") {
    return hasCache ? {
      label: "解析失败，正在显示旧缓存",
      summary: "本次解析没有生成新快照，当前仍可浏览上次成功解析的数据。",
      impact: "数据可能已过期，不能作为服务器实时状态使用。",
      nextStep: "保留错误标识，检查存档可读性后重新解析。",
      tone: "warning",
      errorIdentifier,
    } : {
      label: "存档快照不可用",
      summary: "解析失败且没有可用的成功缓存。",
      impact: "世界资产暂时无法读取。",
      nextStep: "保留错误标识，检查存档可读性后重新解析。",
      tone: "danger",
      errorIdentifier,
    };
  }

  if (!hasCache || status.parseStatus === "unavailable") {
    return {
      label: "存档快照不可用",
      summary: "尚未找到成功解析的世界缓存。",
      impact: "世界资产暂时无法读取。",
      nextStep: "确认存档可读取后，执行重新解析。",
      tone: "danger",
      errorIdentifier: null,
    };
  }

  if (status.stale) {
    return {
      label: "正在显示最后成功缓存",
      summary: "新快照尚未可用，当前继续提供上次成功解析的数据。",
      impact: "数据可能已过期，不能作为服务器实时状态使用。",
      nextStep: "可在合适时机重新解析以读取较新的存档。",
      tone: "warning",
      errorIdentifier: null,
    };
  }

  return {
    label: "存档快照可用",
    summary: "当前世界资产来自最近一次成功解析的只读存档快照。",
    impact: "数据不是服务器实时状态。",
    nextStep: "需要更新数据时，可重新解析当前存档。",
    tone: "ready",
    errorIdentifier: null,
  };
}
