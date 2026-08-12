import { expect, test } from "vitest";

import { formatByteRate, formatPercent, liveStatus, sourceLabel } from "./format";

test("实时监控状态不向用户显示内部来源和错误码", () => {
  const unavailable = {
    data: {},
    source: "unavailable",
    observedAt: 1_786_000_000,
    stale: true,
    errorCode: "REST_CONNECTION_REFUSED;RCON_CONNECTION_REFUSED",
  };

  expect(sourceLabel(unavailable)).toBe("实时数据暂不可用");
  expect(liveStatus(unavailable)).toMatch(/^实时数据暂不可用 · /);
  expect(liveStatus(unavailable)).not.toContain("REST_CONNECTION_REFUSED");
});

test("进程指标在首个样本前显示校准状态，之后使用明确单位", () => {
  expect(formatPercent(0, false)).toBe("正在校准");
  expect(formatByteRate(0, false)).toBe("正在校准");
  expect(formatPercent(12.5, true)).toBe("12.5%");
  expect(formatByteRate(1_536, true)).toBe("1.5 KB/秒");
});
