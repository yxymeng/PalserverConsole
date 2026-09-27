import { requestJson } from "../../api/client";
import type { WorldBaseDetail, WorldGuildDetail, WorldPalDetail, WorldPlayerDetail, WorldSnapshotContext } from "../../api/contracts";

type DetailContext = WorldSnapshotContext & { snapshotId: string };
type DetailData = {
  players: WorldPlayerDetail & DetailContext;
  pals: WorldPalDetail & DetailContext;
  guilds: WorldGuildDetail & DetailContext;
  bases: WorldBaseDetail & DetailContext;
};
export type DetailResource = keyof DetailData;
export type EntityDetail = { [R in DetailResource]: { resource: R; data: DetailData[R] } }[DetailResource];

// Owned by one WorldDataPage instance; nothing is persisted or shared across instances.
export function createWorldDetailCache() {
  const ready = new Map<string, DetailData[DetailResource]>();
  const pending = new Map<string, { snapshotId: string; controller: AbortController; promise: Promise<DetailData[DetailResource]> }>();
  const keyOf = (resource: DetailResource, id: string, snapshotId: string) => JSON.stringify([snapshotId, resource, id]);
  const peek = <R extends DetailResource>(resource: R, id: string, snapshotId: string | null | undefined): DetailData[R] | undefined => {
    if (!snapshotId) return;
    const key = keyOf(resource, id, snapshotId);
    const value = ready.get(key);
    if (value) { ready.delete(key); ready.set(key, value); }
    return value as DetailData[R] | undefined;
  };
  const load = <R extends DetailResource>(resource: R, id: string, snapshotId: string | null | undefined): Promise<DetailData[R]> => {
    if (!snapshotId) return Promise.reject(new Error("WORLD_CACHE_UNAVAILABLE: 当前没有可用的世界快照。"));
    const cached = peek(resource, id, snapshotId);
    if (cached) return Promise.resolve(cached);
    const key = keyOf(resource, id, snapshotId);
    const existing = pending.get(key);
    if (existing) return existing.promise as Promise<DetailData[R]>;
    const controller = new AbortController();
    const promise = requestJson<DetailData[R]>(`/api/world/${resource}/${encodeURIComponent(id)}?snapshotId=${encodeURIComponent(snapshotId)}`, { signal: controller.signal }).then((data) => {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (data.snapshotId !== snapshotId) throw new Error("SNAPSHOT_REPLACED: 详情与当前快照不一致。");
      ready.set(key, data);
      if (ready.size > 24) ready.delete(ready.keys().next().value!);
      return data;
    }).finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); });
    pending.set(key, { snapshotId, controller, promise });
    return promise;
  };
  const retainSnapshot = (snapshotId: string | null | undefined) => {
    for (const [key, data] of ready) if (data.snapshotId !== snapshotId) ready.delete(key);
    for (const [key, entry] of pending) if (entry.snapshotId !== snapshotId) { entry.controller.abort(); pending.delete(key); }
  };
  return {
    peek, load, retainSnapshot,
    preload(resource: DetailResource, id: string, snapshotId: string | null | undefined) {
      if (snapshotId && pending.size < 2) void load(resource, id, snapshotId).catch(() => {});
    },
    clear() { retainSnapshot(null); },
  };
}

export type WorldDetailCache = ReturnType<typeof createWorldDetailCache>;
