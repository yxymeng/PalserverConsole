import { describe, expect, it } from "vitest";

import type { WorldStatus } from "../../api/contracts";
import { waitForWorldReparse } from "./worldReparse";

function status(snapshotId: string, parseStatus: WorldStatus["parseStatus"]): WorldStatus {
  return {
    source: "save-snapshot", observedAt: 1, sourceObservedAt: 1, collectedAt: 1,
    parsedAt: parseStatus === "ready" ? 2 : null, snapshotId, stale: false,
    errorCode: null, error: null, parsing: parseStatus === "parsing", parseStatus,
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
      readStatus: async () => responses.shift() || status("new", "ready"),
      wait: async () => undefined,
      intervalMs: 0,
      timeoutMs: 100,
    });

    expect(result.snapshotId).toBe("new");
    expect(result.parseStatus).toBe("ready");
    expect(responses).toHaveLength(0);
  });
});
