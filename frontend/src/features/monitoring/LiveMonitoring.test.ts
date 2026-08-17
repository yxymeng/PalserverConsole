import { expect, test } from "vitest";

import type { LiveSnapshot, WorldStatus } from "../../api/contracts";
import {
  liveTitleText,
  onlinePlayersSummary,
  playerDataState,
  worldStatusAfterResponse,
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
  expect(playerDataState({
    ...snapshot,
    players: { data: [], source: "rest", observedAt: 1, stale: false, errorCode: "REST_HTTP_ERROR" },
  }, "", 0)).toBe("error");
});

test("首页在线玩家摘要覆盖空、单人、多人、加载、错误与过期状态", () => {
  expect(onlinePlayersSummary([], "empty")).toEqual({ value: "0 人", detail: "当前无人在线" });
  expect(onlinePlayersSummary([{ name: "Alice" }], "ready")).toEqual({ value: "1 人", detail: "Alice" });
  expect(onlinePlayersSummary([{ name: "Alice" }, { name: "Bob" }], "ready")).toEqual({ value: "2 人", detail: "Alice、Bob" });
  expect(onlinePlayersSummary([{ name: "一梦" }, { name: "Luna" }, { name: "Player3" }], "ready")).toEqual({
    value: "3 人",
    detail: "一梦、Luna、Player3",
  });
  expect(onlinePlayersSummary([{ name: "Alice" }, { name: "Bob" }, { name: "Carol" }, { name: "Dave" }], "ready")).toEqual({
    value: "4 人",
    detail: "Alice、Bob、Carol 等 4 人",
  });
  const eightPlayers = Array.from({ length: 8 }, (_, index) => ({ name: `Player${index + 1}` }));
  expect(onlinePlayersSummary(eightPlayers, "ready")).toEqual({
    value: "8 人",
    detail: "Player1、Player2、Player3 等 8 人",
  });
  expect(onlinePlayersSummary([{}], "ready")).toEqual({ value: "1 人", detail: "未知玩家" });
  expect(onlinePlayersSummary([], "loading")).toEqual({ value: "读取中", detail: "正在读取在线玩家" });
  expect(onlinePlayersSummary([], "error")).toEqual({ value: "—", detail: "在线数据不可用" });
  expect(onlinePlayersSummary([{ name: "一梦" }, { name: "Luna" }, { name: "Player3" }], "ready", true)).toEqual({
    value: "3 人",
    detail: "上次在线：一梦、Luna、Player3",
  });
});

test("世界快照 success -> failure -> success 不保留旧数据", () => {
  let error = "";
  let status = worldStatusAfterResponse(firstWorldStatus, error);
  expect(status?.gameTimeTicks).toBe(firstWorldStatus.gameTimeTicks);

  error = "NETWORK_ERROR";
  status = worldStatusAfterResponse(null, error);
  expect(status).toBeNull();
  expect(status?.gameTimeTicks).toBeUndefined();

  error = "";
  status = worldStatusAfterResponse(nextWorldStatus, error);
  expect(status?.gameTimeTicks).toBe(nextWorldStatus.gameTimeTicks);
});
