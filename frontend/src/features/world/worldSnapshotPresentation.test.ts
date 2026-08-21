import { describe, expect, it } from "vitest";

import type { WorldSnapshotSummary } from "../../api/contracts";
import { presentWorldSnapshot } from "./worldSnapshotPresentation";

const status = (overrides: Partial<WorldSnapshotSummary> = {}): WorldSnapshotSummary => ({
  source: "save-snapshot",
  observedAt: 1,
  sourceObservedAt: 1,
  collectedAt: 1,
  parsedAt: 1,
  snapshotId: "snapshot-1",
  stale: false,
  errorCode: null,
  error: null,
  parsing: false,
  parseStatus: "ready",
  dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
  parseDurationMs: 1,
  peakMemoryBytes: null,
  cacheSizeBytes: null,
  gameTimeTicks: null,
  counts: { players: 0, pals: 0, guilds: 0, bases: 0, containers: 0, inventory_items: 0, work_pals: 0 },
  ...overrides,
});

describe("世界资产台快照条", () => {
  it("解析失败时保留旧缓存与可复制英文错误标识", () => {
    expect(presentWorldSnapshot(status({ stale: true, parseStatus: "failed", errorCode: "WORLD_PARSE_FAILED" }))).toMatchObject({
      label: "解析失败，正在显示旧缓存",
      tone: "warning",
      errorIdentifier: "WORLD_PARSE_FAILED",
    });
  });

  it("没有缓存时明确说明世界资产不可用", () => {
    expect(presentWorldSnapshot(status({ snapshotId: null, parseStatus: "unavailable" }))).toMatchObject({
      label: "存档快照不可用",
      tone: "danger",
    });
  });

  it("解析中不会把旧缓存误报为实时数据", () => {
    expect(presentWorldSnapshot(status({ parsing: true, stale: true }))).toMatchObject({
      label: "正在解析新存档快照",
      tone: "loading",
    });
  });
});
