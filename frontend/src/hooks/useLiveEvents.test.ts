import { expect, test } from "vitest";

import { liveConnectionLabel } from "./useLiveEvents";

test.each([
  ["connecting", "正在连接实时事件"],
  ["open", "实时事件已连接"],
  ["reconnecting", "实时事件正在重连"],
  ["closed", "实时事件已关闭"],
] as const)("SSE 状态 %s 显示明确中文文案", (status, label) => {
  expect(liveConnectionLabel(status)).toBe(label);
});
