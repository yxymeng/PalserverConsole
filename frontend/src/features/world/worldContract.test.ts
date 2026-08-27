import { describe, expect, it } from "vitest";

import { ensureWorldContract } from "./worldContract";

const current = {
  queryVersion: 1,
  cacheSchema: "world-asset-cache",
  cacheSchemaVersion: 15,
  metadataSchema: "palserver-console-world-metadata",
  metadataSchemaVersion: 1,
  metadataDataVersion: "2026.08.25.3",
};

describe("world contract boundary", () => {
  it("accepts the single recorded query, cache, and metadata boundary", () => {
    expect(() => ensureWorldContract(current)).not.toThrow();
  });

  it("rejects an incompatible boundary instead of silently adapting it", () => {
    expect(() => ensureWorldContract({ ...current, cacheSchemaVersion: 13 }))
      .toThrow(/WORLD_QUERY_CONTRACT_INCOMPATIBLE/);
    expect(() => ensureWorldContract({ ...current, metadataDataVersion: "2026.08.23.1" }))
      .toThrow(/WORLD_QUERY_CONTRACT_INCOMPATIBLE/);
  });
});
