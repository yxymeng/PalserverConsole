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
  createdAt?: number | null;
  updatedAt?: number | null;
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
export type WorldResource = "players" | "pals" | "guilds" | "bases" | "inventories" | "work-pals";
export type WorldParseStatus = "ready" | "parsing" | "failed" | "unavailable" | "incompatible";
export type WorldDataCoverage = {
  state: "complete" | "unavailable";
  resources: Record<WorldResource, boolean>;
};
export type WorldSnapshotContext = {
  source: string;
  observedAt: number;
  sourceObservedAt: number;
  collectedAt: number | null;
  parsedAt: number | null;
  snapshotId: string | null;
  stale: boolean;
  errorCode: string | null;
  parsing: boolean;
  parseStatus: WorldParseStatus;
  dataCoverage: WorldDataCoverage;
};
export type WorldSnapshotSummary = WorldSnapshotContext & {
  reparseGeneration: number;
  error: string | null;
  parseDurationMs: number | null;
  peakMemoryBytes: number | null;
  cacheSizeBytes: number | null;
  gameTimeTicks: number | null;
  counts: {
    players: number;
    pals: number;
    guilds: number;
    bases: number;
    containers: number;
    inventory_items: number;
    work_pals: number;
  };
};
export type WorldStatus = WorldSnapshotSummary;
export type WorldReparseResponse = { message: string; reparseGeneration: number };

export type WorldPlayerListItem = {
  id: string; instanceId: string; name: string; level: number | null; guildId: string | null;
  guildName?: string; inventoryIds: string[]; partyContainerId: string | null; storageContainerId: string | null;
  lastRecordedAt: string | null; progress: WorldPlayerProgress;
};
export type WorldPlayerProgressField = "discoveredPalSpecies" | "capturedPals" | "fastTravelPoints" | "exploredAreas" | "fieldBosses" | "towerBosses" | "dungeonClears" | "oilRigClears" | "technologyPoints" | "ancientTechnologyPoints" | "recipes";
export type WorldPlayerProgress = {
  state: "complete" | "partial" | "unavailable";
  values: Partial<Record<WorldPlayerProgressField, number>>;
  unavailable: WorldPlayerProgressField[];
};
export type WorldPalListItem = {
  id: string; ownerPlayerId: string | null; characterId: string; nickname: string | null; level: number | null;
  containerId: string | null; slotIndex: number | null; baseId: string | null; assignment: string;
  ownerName?: string; baseName?: string;
};
export type WorldPalRosterItem = WorldPalListItem & {
  gender: string | null;
  rank: number | null;
  isBoss: boolean;
  isLucky: boolean;
  locationType: "player" | "party" | "storage" | "base" | "unassigned";
  aptitude: WorldPalAptitude;
  skills: WorldPalSkills;
  care: WorldPalCare;
};
export type WorldPalAptitude = {
  speciesRarity: number | null;
  ivs: { hp: number | null; attack: number | null; defense: number | null; average: number | null };
  workSuitabilities: { type: string; level: number }[];
  metadataKnown: boolean;
  metadataLabel: "资料未收录" | null;
};
export type WorldPalSkill = {
  id: string;
  name: string | null;
  description: string | null;
  sourceName: string | null;
  rank: number | null;
  element: string | null;
  power: number | null;
  cooldown: number | null;
  metadataKnown: boolean;
};
export type WorldPalSkills = {
  passive: WorldPalSkill[];
  equipped: WorldPalSkill[];
  learned: WorldPalSkill[];
  partner: WorldPalSkill | null;
};
export type WorldMetadataStatus = {
  status: "ready" | "unavailable";
  schema: string;
  schemaVersion: number;
  dataVersion: string | null;
  sourceRevision: string | null;
  errorCode: string | null;
};
export type WorldPalCare = {
  currentHp: number | null;
  hunger: number | null;
  hungerRaw: number | null;
  hungerStatus: string | null;
  sanity: number | null;
  physicalHealth: string | null;
  disease: string | null;
  activity: string | null;
  diseaseRecorded: boolean;
  activityRecorded: boolean;
  reasons: ("zero_hp" | "disease" | "hunger_low" | "san_low")[];
  unavailable: ("currentHp" | "hunger" | "sanity" | "disease" | "activity")[];
  severity: "critical" | "warning" | "info" | "unavailable" | "healthy";
  attention: boolean;
};
export type WorldPalCareSummary = {
  total: number;
  critical: number;
  warning: number;
  attention: number;
  unavailable: number;
};
export type WorldPalRosterResponse = WorldSnapshotContext & {
  items: WorldPalRosterItem[];
  page: number;
  pageSize: number;
  total: number;
  careSummary: WorldPalCareSummary;
  passiveSkills: WorldPalSkill[];
  metadata: WorldMetadataStatus;
};
export type WorldGuildListItem = {
  id: string; name: string; memberCount: number; baseCount: number;
};
export type WorldBaseListItem = {
  id: string; name: string; guildId: string | null; workerContainerId: string | null;
  x: number | null; y: number | null; z: number | null; guildName?: string;
};
export type WorldInventoryListItem = {
  id: number; containerId: string; slotIndex: number; itemId: string; quantity: number; ownerKind: string;
  ownerId: string | null; guildId: string | null; baseId: string | null;
};
export type WorldInventoryScope = "inventory" | "player" | "base" | "world" | "all";
export type WorldInventoryItem = {
  itemId: string;
  name: string | null;
  category: string | null;
  rarity: string | null;
  metadataKnown: boolean;
  metadataLabel: "资料未收录" | null;
  totalQuantity: number;
  locationCount: number;
};
export type WorldInventoryLocation = {
  id: number;
  locationType: "player" | "base" | "guild" | "world" | "unassigned";
  locationLabel: string;
  ownerId: string | null;
  ownerName: string | null;
  guildId: string | null;
  guildName: string | null;
  baseId: string | null;
  baseName: string | null;
  slotIndex: number;
  quantity: number;
  containerId: string | null;
  mapObjectType: string | null;
  mapObjectInstanceId: string | null;
  worldPosition: { x: number; y: number; z: number } | null;
};
export type WorldInventoryLocationGroup = {
  locationType: WorldInventoryLocation["locationType"];
  groupId: string | null;
  label: string;
  quantitySum: number;
  locationCount: number;
  containerCount: number;
};
export type WorldInventoryResponse = WorldSnapshotContext & {
  items: WorldInventoryItem[];
  categories: string[];
  page: number;
  pageSize: number;
  total: number;
  metadata: WorldMetadataStatus;
};
export type WorldInventoryDetailResponse = WorldSnapshotContext & {
  itemId: string;
  groups: WorldInventoryLocationGroup[];
  locations: WorldInventoryLocation[];
  page: number;
  pageSize: number;
  total: number;
};
export type WorldContainerReference = {
  id: string; kind: string; ownerId: string | null; guildId: string | null;
  baseId: string | null; slotCount: number;
};
export type WorldPlayerDetail = WorldPlayerListItem & {
  pals: WorldPalListItem[];
  partyPals: WorldPalListItem[];
  storagePals: WorldPalListItem[];
  inventory: WorldInventoryListItem[];
  guild: WorldGuildListItem | null;
};
export type WorldPalDetail = WorldPalListItem & {
  owner: WorldPlayerListItem | null;
  base: WorldBaseListItem | null;
  container: WorldContainerReference | null;
  care: WorldPalCare;
  aptitude: WorldPalAptitude;
  skills: WorldPalSkills;
  metadata: WorldMetadataStatus;
};
export type WorldGuildDetail = WorldGuildListItem & {
  members: WorldPlayerListItem[];
  bases: WorldBaseListItem[];
};
export type WorldBaseDetail = WorldBaseListItem & {
  guild: WorldGuildListItem | null;
  workers: WorldPalListItem[];
  inventory: WorldInventoryListItem[];
};
export type WorldTypedListItem =
  | WorldPlayerListItem
  | WorldPalListItem
  | WorldGuildListItem
  | WorldBaseListItem
  | WorldInventoryListItem;
export type WorldTypedListResponse = WorldSnapshotContext & {
  items: WorldTypedListItem[];
  page: number;
  pageSize: number;
  total: number;
};
export type WorldTypedDetailResponse = WorldSnapshotContext & (
  | WorldPlayerDetail
  | WorldPalDetail
  | WorldGuildDetail
  | WorldBaseDetail
);

/** @deprecated Existing entity-browser compatibility type. New asset queries use WorldTyped* types. */
export type WorldRow = Record<string, unknown> & { id?: string; name?: string };
/** @deprecated Existing entity-browser compatibility response. */
export type WorldResponse = WorldSnapshotContext & {
  items: WorldRow[];
  page: number;
  pageSize: number;
  total: number;
};
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
