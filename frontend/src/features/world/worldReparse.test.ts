import { describe, expect, it } from "vitest";

import type { WorldStatus } from "../../api/contracts";
import { waitForWorldReparse } from "./worldReparse";

function status(snapshotId: string, parseStatus: WorldStatus["parseStatus"], reparseGeneration = 1): WorldStatus {
  return {
    contract: { queryVersion: 1, cacheSchema: "world-asset-cache", cacheSchemaVersion: 14, metadataSchema: "palserver-console-world-metadata", metadataSchemaVersion: 1, metadataDataVersion: "2026.08.25.3" },
    source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1,
    parsedAt: parseStatus === "ready" ? 2 : null, snapshotId, stale: false,
    errorCode: null, error: null, parsing: parseStatus === "parsing", parseStatus, reparseGeneration,
    parseDurationMs: null, peakMemoryBytes: null, cacheSizeBytes: null, gameTimeTicks: null,
    dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
    counts: { players: 1, pals: 1, guilds: 1, bases: 1, containers: 1, inventory_items: 1, work_pals: 1 },
  };
}

describe("waitForWorldReparse", () => {
  it("忽略 watcher 启动前的旧 ready，并等待 parsing 后的新快照", async () => {
    const responses = [status("old", "ready"), status("old", "parsing"), status("new", "ready")];
    const result = await waitForWorldReparse({
      previousSnapshotId: "old",
      reparseGeneration: 1,
      readStatus: async () => responses.shift() || status("new", "ready"),
      wait: async () => undefined,
      intervalMs: 0,
      timeoutMs: 100,
    });

    expect(result.snapshotId).toBe("new");
    expect(result.parseStatus).toBe("ready");
    expect(responses).toHaveLength(0);
  });

  it("忽略本次解析启动前的旧 incompatible，并等待新快照", async () => {
    const responses = [
      status("old", "incompatible", 0),
      status("old", "parsing"),
      status("new", "ready"),
    ];
    const result = await waitForWorldReparse({
      previousSnapshotId: "old",
      reparseGeneration: 1,
      readStatus: async () => responses.shift() || status("new", "ready"),
      wait: async () => undefined,
      intervalMs: 0,
      timeoutMs: 100,
    });

    expect(result.snapshotId).toBe("new");
    expect(responses).toHaveLength(0);
  });

  it("按 generation 区分旧失败并上报本次失败终态", async () => {
    const oldFailure = status("old", "failed", 0);
    oldFailure.errorCode = "OLD_PARSE_FAILED";
    const newFailure = status("old", "failed");
    newFailure.errorCode = "SNAPSHOT_PARSE_FAILED";
    const responses = [oldFailure, status("old", "parsing"), newFailure];
    const observed: WorldStatus[] = [];

    await expect(waitForWorldReparse({
      previousSnapshotId: "old",
      reparseGeneration: 1,
      readStatus: async () => responses.shift() || newFailure,
      onStatus: (nextStatus) => observed.push(nextStatus),
      wait: async () => undefined,
      intervalMs: 0,
      timeoutMs: 100,
    })).rejects.toThrow("SNAPSHOT_PARSE_FAILED");

    expect(observed.at(-1)?.errorCode).toBe("SNAPSHOT_PARSE_FAILED");
    expect(responses).toHaveLength(0);
  });

  it("首次轮询已快速失败时保留本次真实 errorCode", async () => {
    const newFailure = status("old", "failed", 2);
    newFailure.errorCode = "FAST_PARSE_FAILED";
    const observed: WorldStatus[] = [];

    await expect(waitForWorldReparse({
      previousSnapshotId: "old",
      reparseGeneration: 2,
      readStatus: async () => newFailure,
      onStatus: (nextStatus) => observed.push(nextStatus),
      wait: async () => undefined,
      intervalMs: 0,
      timeoutMs: 100,
    })).rejects.toThrow("FAST_PARSE_FAILED");

    expect(observed).toEqual([newFailure]);
  });
});
