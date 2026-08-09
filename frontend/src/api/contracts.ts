// Canonical frontend contracts synchronized with the backend camelCase API schema.
export type AuthStatus = {
  local: boolean;
  authenticated: boolean;
  adminPasswordConfigured: boolean;
  csrfToken: string | null;
  lanWarning: string | null;
  port: number;
};

export type ShellStatus = {
  observedAt: number;
  module: "M2";
  serverState: "not_configured" | "stopped" | "running";
  configured: boolean;
  pids: number[];
  executablePath: string | null;
};

export type WorldCandidate = { worldId: string; worldPath: string; modifiedAt: number };
export type ServerSettings = {
  executablePath: string | null;
  launchArguments: string;
  worldId?: string | null;
  worldPath?: string | null;
  worldCandidates?: WorldCandidate[];
  bindingValid?: boolean;
  bindingErrorCode?: string | null;
};
export type DiscoveryCandidate = {
  libraryPath: string;
  installPath: string;
  executablePath: string;
  manifestValid: boolean;
  worldCandidates: WorldCandidate[];
};
export type Operation = {
  operationId: string;
  kind: string;
  state: string;
  stage: string;
  errorCode: string | null;
  detail: string | null;
};

export type LiveValue<T> = {
  data: T;
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
};
export type LiveSnapshot = {
  info: LiveValue<Record<string, unknown>>;
  players: LiveValue<unknown>;
  metrics: LiveValue<{ server?: Record<string, unknown>; process?: ProcessMetrics }>;
  settings: LiveValue<Record<string, unknown>>;
};
export type ProcessMetrics = {
  pids: number[];
  cpuPercent: number;
  memoryBytes: number;
  diskReadBytes: number;
  diskWriteBytes: number;
};
export type AuditItem = {
  id: number;
  eventType: string;
  peerIp: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: number;
  source: string;
  parserVersion: string | null;
};
export type AuditResponse = { items: AuditItem[]; page: number; pageSize: number; total: number; observedAt: number };
export type WorldStatus = {
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
  error: string | null;
  snapshotId: string | null;
  parsing: boolean;
  parseDurationMs: number | null;
  peakMemoryBytes?: number | null;
  cacheSizeBytes?: number | null;
  counts: Record<string, number>;
};
export type WorldRow = Record<string, unknown> & { id?: string; name?: string };
export type WorldResponse = {
  items: WorldRow[];
  page: number;
  pageSize: number;
  total: number;
  source: string;
  observedAt: number;
  stale: boolean;
  errorCode: string | null;
};
export type WorldResource = "players" | "pals" | "guilds" | "bases" | "inventories" | "work-pals";
export type Theme = "light" | "dark";

export type BackupItem = { id: string; observedAt: number; sizeBytes: number; valid: boolean; missing: string[] };
export type BackupResponse = {
  items: BackupItem[];
  retention: number | null;
  worldPath: string;
  backupRoot: string;
  observedAt?: number;
  stale?: boolean;
  errorCode?: string | null;
};
export type ConfigDocument = {
  path: string;
  sourceHash: string;
  fields: Record<string, string>;
  unknownFields: Record<string, string>;
  schema: string[];
  rawText: string;
  adminPasswordConfigured: boolean;
  worldOptionPresent?: boolean;
  draft: (ConfigDocument & { state?: string; conflict?: Record<string, unknown> | null }) | null;
};
