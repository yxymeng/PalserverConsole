import { expect, test } from "vitest";

import { serverStateLabel } from "./labels";

test.each([
  ["running", "运行中"],
  ["stopped", "已停止"],
  ["not_configured", "尚未配置"],
] as const)("服务器状态 %s 使用稳定中文文案", (state, label) => {
  expect(serverStateLabel(state)).toBe(label);
});
