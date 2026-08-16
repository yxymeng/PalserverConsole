import { expect, test } from "vitest";

import type { LiveSnapshot, WorldStatus } from "../../api/contracts";
import {
  liveTitleText,
  playerDataState,
  worldStatusAfterResponse,
  worldArchiveState,
} from "./livePresentation";

const snapshot = {
  info: { source: "rest", observedAt: 1, stale: false, errorCode: null, data: {} },
} as LiveSnapshot;

const firstWorldStatus = {
  source: "save-snapshot",
  observedAt: 10,
  stale: false,
  errorCode: null,
  error: null,
  snapshotId: "first",
  parsing: false,
  parseDurationMs: 12,
  gameTimeTicks: 172_800_000_000,
  counts: { players: 2, guilds: 1, pals: 3, bases: 1 },
} as WorldStatus;

const nextWorldStatus = { ...firstWorldStatus, observedAt: 20, snapshotId: "second", gameTimeTicks: 259_200_000_000 };

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

test("世界快照 success -> failure -> success 不保留旧数据", () => {
  let error = "";
  let status = worldStatusAfterResponse(firstWorldStatus, error);
  expect(status?.gameTimeTicks).toBe(firstWorldStatus.gameTimeTicks);
  expect(worldArchiveState(status, error)).toBe("最新");

  error = "NETWORK_ERROR";
  status = worldStatusAfterResponse(null, error);
  expect(status).toBeNull();
  expect(status?.gameTimeTicks).toBeUndefined();
  expect(worldArchiveState(status, error)).toBe("不可用");

  error = "";
  status = worldStatusAfterResponse(nextWorldStatus, error);
  expect(status?.gameTimeTicks).toBe(nextWorldStatus.gameTimeTicks);
  expect(worldArchiveState(status, error)).toBe("最新");
});
