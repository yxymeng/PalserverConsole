import { expect, test } from "vitest";

import type { LiveSnapshot } from "../../api/contracts";
import { liveTitleText, playerDataState } from "./livePresentation";

const snapshot = {
  info: { source: "rest", observedAt: 1, stale: false, errorCode: null, data: {} },
} as LiveSnapshot;

test("实时标题不会把重连状态误报为正常", () => {
  expect(liveTitleText(snapshot, "", "reconnecting")).toBe("实时数据正在重连");
  expect(liveTitleText(snapshot, "", "open")).toBe("实时数据正常");
  expect(liveTitleText(snapshot, "NETWORK_ERROR", "open")).toBe("实时数据不可用");
});

test("在线玩家只有在快照成功返回后才显示空状态", () => {
  expect(playerDataState(null, "", 0)).toBe("loading");
  expect(playerDataState(null, "NETWORK_ERROR", 0)).toBe("error");
  expect(playerDataState(snapshot, "", 0)).toBe("empty");
  expect(playerDataState(snapshot, "", 1)).toBe("ready");
});
