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
  instanceId: string;
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
export type NotificationStatus = { enabled: boolean; configured: boolean };

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
  cpuReady?: boolean;
  memoryBytes: number;
  diskReadBytes: number;
  diskWriteBytes: number;
  diskReadBytesPerSecond?: number;
  diskWriteBytesPerSecond?: number;
  ioReady?: boolean;
  startedAt?: number | null;
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
export type RestoreRecoveryJournal = {
  journalId: string | null;
  worldId: string | null;
  worldPath: string | null;
  sourceBackupId: string | null;
  sourcePath: string | null;
  safetyCopyPath: string | null;
  stagingPath: string | null;
  phase: string | null;
  component: string | null;
  completedComponents: string[];
  checksums: Record<string, unknown>;
  errorType: string | null;
  errorMessage: string | null;
  originalError: string | null;
  createdAt: number | null;
  updatedAt: number | null;
};
export type RestoreRecovery = { active: boolean; journal: RestoreRecoveryJournal | null };
export type BackupResponse = {
  items: BackupItem[];
  retention: number | null;
  worldPath: string;
  backupRoot: string;
  restoreRecovery: RestoreRecovery;
  observedAt?: number;
  stale?: boolean;
  errorCode?: string | null;
};
export type OperationalHealthState = "ok" | "warning" | "blocked" | "unavailable" | "no_data" | "healthy" | "stale" | "failed" | "stopped" | "invalid";
export type OperationalDirectory = {
  name: string;
  label: string;
  path: string | null;
  state: OperationalHealthState;
  sizeBytes: number;
  fileCount: number;
  freeBytes: number | null;
  totalBytes: number | null;
  errorCode: string | null;
};
export type OperationalHealth = {
  observedAt: number;
  capacity: {
    state: "ok" | "warning" | "blocked" | "unavailable";
    freeBytes: number | null;
    totalBytes: number | null;
    minimumFreeBytes: number;
    copyBytes: number | null;
    requiredFreeBytes: number | null;
    warningFreeBytes: number | null;
    sourceErrorCode: string | null;
    errorCode: string | null;
  };
  directories: OperationalDirectory[];
  world: {
    state: OperationalHealthState;
    lastSuccessAt: number | null;
    snapshotId: string | null;
    parsing: boolean;
    errorCode: string | null;
    cacheSizeBytes: number | null;
  };
  backups: {
    state: OperationalHealthState;
    lastSuccessAt: number | null;
    itemCount: number;
    validCount: number;
    invalidCount: number;
    totalBytes: number;
    errorCode: string | null;
  };
  background: Array<{
    name: string;
    state: OperationalHealthState;
    alive: boolean;
    startedAt: number | null;
    lastSuccessAt: number | null;
    lastRunAt: number | null;
    errorCode: string | null;
  }>;
  alerts: Array<{ severity: "warning" | "critical"; code: string; message: string }>;
};
export type StorageCleanupPreview = {
  state: "ready" | "busy";
  previewToken: string | null;
  expiresAt: number | null;
  candidateCount: number;
  totalBytes: number;
  errors: number;
  candidates: Array<{ kind: string; name: string; sizeBytes: number }>;
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
