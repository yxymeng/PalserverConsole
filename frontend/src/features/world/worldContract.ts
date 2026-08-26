import type { WorldContractBoundary } from "../../api/contracts";

export const WORLD_QUERY_CONTRACT_VERSION = 1;
export const WORLD_CACHE_SCHEMA = { name: "world-asset-cache", version: 14 } as const;
export const WORLD_METADATA_SCHEMA = { name: "palserver-console-world-metadata", version: 1 } as const;
export const WORLD_METADATA_DATA_VERSION = "2026.08.25.3";

export function ensureWorldContract(contract: WorldContractBoundary): void {
  if (
    contract.queryVersion !== WORLD_QUERY_CONTRACT_VERSION
    || contract.cacheSchema !== WORLD_CACHE_SCHEMA.name
    || contract.cacheSchemaVersion !== WORLD_CACHE_SCHEMA.version
    || contract.metadataSchema !== WORLD_METADATA_SCHEMA.name
    || contract.metadataSchemaVersion !== WORLD_METADATA_SCHEMA.version
    || (contract.metadataDataVersion !== null && contract.metadataDataVersion !== WORLD_METADATA_DATA_VERSION)
  ) {
    throw new Error("WORLD_QUERY_CONTRACT_INCOMPATIBLE: 世界资产台查询契约与当前前端不兼容，请重新构建并重启控制台。");
  }
}
