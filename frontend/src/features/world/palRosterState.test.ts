import { describe, expect, test } from "vitest";

import type { WorldPalRosterItem, WorldPalRosterResponse } from "../../api/contracts";
import { mergePalRosterPage } from "./palRosterState";

function response(snapshotId: string, count: number, start = 0): WorldPalRosterResponse {
  const items: WorldPalRosterItem[] = Array.from({ length: count }, (_, index) => ({
    id: `pal-${start + index}`, ownerPlayerId: null, characterId: "FuturePal", nickname: null,
    level: 1, containerId: null, slotIndex: null, baseId: null, assignment: "unassigned",
    gender: null, rank: null, isBoss: false, isLucky: false, locationType: "unassigned",
    aptitude: { speciesRarity: null, ivs: { hp: null, attack: null, defense: null, average: null }, workSuitabilities: [], metadataKnown: false, metadataLabel: "资料未收录" },
    skills: { passive: [], equipped: [], learned: [], partner: null },
    care: { currentHp: null, hunger: null, hungerRaw: null, hungerStatus: null, sanity: null, physicalHealth: null, disease: null, activity: null, diseaseRecorded: false, activityRecorded: false, reasons: [], unavailable: ["currentHp", "hunger", "sanity", "disease", "activity"], severity: "unavailable", attention: false },
  }));
  return {
    items, page: 1, pageSize: 60, total: count, snapshotId, source: "fixture", observedAt: 1,
    sourceObservedAt: 1, collectedAt: 1, parsedAt: 1, stale: false, errorCode: null,
    parsing: false, parseStatus: "ready", dataCoverage: { state: "complete", resources: { players: true, pals: true, guilds: true, bases: true, inventories: true, "work-pals": true } },
    careSummary: { total: count, critical: 0, warning: 0, attention: 0, unavailable: count },
    passiveSkills: [],
    metadata: { status: "ready", schema: "palserver-console-world-metadata", schemaVersion: 1, dataVersion: "test", sourceRevision: "revision", errorCode: null },
  };
}

describe("Pal roster page state", () => {
  test("keeps empty and small result boundaries intact", () => {
    expect(mergePalRosterPage([], response("snapshot-a", 0), "snapshot-a", false)).toEqual([]);
    expect(mergePalRosterPage([], response("snapshot-a", 3), "snapshot-a", false)).toHaveLength(3);
  });

  test("keeps 1,600 and 5,000 record snapshots paged without duplicates", () => {
    const initial = response("snapshot-a", 60);
    const next = response("snapshot-a", 60, 60);
    expect(initial.pageSize).toBe(60);
    expect(response("snapshot-a", 1_600).total).toBe(1_600);
    expect(response("snapshot-a", 5_000).total).toBe(5_000);
    expect(mergePalRosterPage(initial.items, next, "snapshot-a", true)).toHaveLength(120);
    expect(mergePalRosterPage(initial.items, response("snapshot-a", 60), "snapshot-a", true)).toHaveLength(60);
  });

  test("drops an old page after a snapshot replacement", () => {
    expect(mergePalRosterPage(response("snapshot-a", 60).items, response("snapshot-b", 60), "snapshot-a", true)).toEqual([]);
  });
});
