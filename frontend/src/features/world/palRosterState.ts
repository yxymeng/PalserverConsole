import type { WorldPalRosterItem, WorldPalRosterResponse } from "../../api/contracts";

export function mergePalRosterPage(
  current: WorldPalRosterItem[],
  incoming: WorldPalRosterResponse,
  expectedSnapshotId: string,
  append: boolean,
): WorldPalRosterItem[] {
  if (incoming.snapshotId !== expectedSnapshotId) return [];
  if (!append) return incoming.items;
  const ids = new Set(current.map((item) => item.id));
  return [...current, ...incoming.items.filter((item) => !ids.has(item.id))];
}
