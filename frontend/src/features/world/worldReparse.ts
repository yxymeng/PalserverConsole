import type { WorldStatus } from "../../api/contracts";

export type WorldReparsePollingOptions = {
  previousSnapshotId: string | null;
  reparseGeneration: number;
  readStatus: () => Promise<WorldStatus>;
  onStatus?: (status: WorldStatus) => void;
  wait?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
};

export async function waitForWorldReparse(options: WorldReparsePollingOptions): Promise<WorldStatus> {
  const wait = options.wait || ((milliseconds: number) => new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 240_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await options.readStatus();
    const isCurrentAttempt = status.reparseGeneration >= options.reparseGeneration;
    if (status.snapshotId !== options.previousSnapshotId && status.parseStatus === "ready") {
      options.onStatus?.(status);
      return status;
    }
    if (status.parseStatus === "parsing") {
      options.onStatus?.(status);
    } else if (isCurrentAttempt && (
      status.parseStatus === "failed" || status.parseStatus === "incompatible"
    )) {
      options.onStatus?.(status);
      throw new Error(`${status.errorCode || "WORLD_REPARSE_FAILED"}: 重新解析未生成可用快照。`);
    }
    await wait(intervalMs);
  }
  throw new Error("WORLD_REPARSE_TIMEOUT: 等待新存档快照超时，请稍后刷新。");
}
