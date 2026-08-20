import { AlertTriangle, ChevronDown, FileCog, FolderSearch, HardDrive, Network, RotateCcw, RotateCw, Save, Search, ServerCog } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from "react";
import type { AuthStatus, ConfigDocument } from "../../api/contracts";
import { createIdempotencyKey, isAbortError, requestJson } from "../../api/client";
import { useAbortableRequest } from "../../hooks/useAbortableRequest";
import { ConsolePortSettings } from "../server/ConsolePortSettings";
import { ServerSettingsPanel } from "../server/ServerSettingsPanel";

type ConfigEditorTab = "common" | "advanced";
export type ConfigWorkspace = "game" | "instance";
type ConfigCategoryId =
  | "server"
  | "runtime"
  | "network"
  | "mods"
  | "communication"
  | "access"
  | "random"
  | "progression"
  | "combat"
  | "survival"
  | "resources"
  | "building"
  | "guild"
  | "worldRules"
  | "performance"
  | "character"
  | "advanced";

type ConfigKind = "text" | "password" | "number" | "boolean" | "select" | "multi-select";
type ConfigOption = { value: string; label: string; description?: string };
type ConfigFieldMeta = {
  key: string;
  label: string;
  description: string;
  kind: ConfigKind;
  min?: number;
  max?: number;
  step?: number;
  options?: ConfigOption[];
};

const CONFIG_LABELS: Record<string, string> = {
  ServerName: "服务器名称",
  ServerDescription: "服务器描述",
  AdminPassword: "管理员密码",
  ServerPassword: "服务器密码",
  Difficulty: "难度",
  PublicIP: "公共 IP",
  PublicPort: "公共端口",
  ServerPlayerMaxNum: "服务器玩家最大数量",
  bIsUseBackupSaveData: "是否自动备份存档数据",
  AutoSaveSpan: "自动保存间隔",
  CrossplayPlatforms: "允许连接平台",
  LogFormatType: "日志格式类型",
  ChatPostLimitPerMinute: "每分钟聊天限制数",
  RandomizerType: "随机器类型",
  RandomizerSeed: "随机种子",
  bIsRandomizerPalLevelRandom: "完全随机野外帕鲁等级",
  bEnableVoiceChat: "启用游戏内语音聊天",
  VoiceChatMaxVolumeDistance: "语音音量无衰减距离",
  VoiceChatZeroVolumeDistance: "语音完全静音距离",
  DayTimeSpeedRate: "白天流逝速度",
  NightTimeSpeedRate: "夜间流逝速度",
  ExpRate: "经验值倍率",
  PalCaptureRate: "捕捉概率倍率",
  PalSpawnNumRate: "帕鲁出现数量倍率",
  PalDamageRateAttack: "帕鲁攻击伤害倍率",
  PalDamageRateDefense: "帕鲁承受伤害倍率",
  PlayerDamageRateAttack: "玩家攻击伤害倍率",
  PlayerDamageRateDefense: "玩家承受伤害倍率",
  PlayerStomachDecreaceRate: "玩家饱食度降低倍率",
  PlayerStaminaDecreaceRate: "玩家耐力降低倍率",
  PlayerAutoHPRegeneRate: "玩家生命值自然回复倍率",
  PlayerAutoHpRegeneRateInSleep: "玩家睡眠时生命值回复倍率",
  PalStomachDecreaceRate: "帕鲁饱食度降低倍率",
  PalStaminaDecreaceRate: "帕鲁耐力降低倍率",
  PalAutoHPRegeneRate: "帕鲁生命值自然回复倍率",
  PalAutoHpRegeneRateInSleep: "帕鲁睡眠时生命值回复倍率",
  BuildObjectHpRate: "建筑物生命值倍率",
  BuildObjectDamageRate: "对建筑物伤害倍率",
  BuildObjectDeteriorationDamageRate: "非基地圈内建筑物的劣化速度倍率",
  CollectionDropRate: "道具采集量倍率",
  CollectionObjectHpRate: "可采集物品生命值倍率",
  CollectionObjectRespawnSpeedRate: "可采集物品重生间隔倍率",
  EnemyDropItemRate: "道具掉落量倍率",
  DeathPenalty: "死亡惩罚",
  bEnablePlayerToPlayerDamage: "启用玩家对玩家伤害",
  bEnableFriendlyFire: "启用友伤",
  bEnableInvaderEnemy: "启用袭击事件",
  EnablePredatorBossPal: "启用猛兽 Boss 帕鲁",
  bActiveUNKO: "激活帕鲁便便",
  bEnableAimAssistPad: "启用手柄瞄准辅助",
  bEnableAimAssistKeyboard: "启用键盘瞄准辅助",
  DropItemMaxNum: "掉落物品最大存在数量",
  DropItemMaxNum_UNKO: "帕鲁便便掉落最大数量",
  BaseCampMaxNum: "全地图据点最大数量",
  BaseCampMaxNumInGuild: "公会的据点最大数量",
  BaseCampWorkerMaxNum: "可分配至据点工作的帕鲁数量上限",
  MaxBuildingLimitNum: "每个玩家的建筑物最大数量",
  DropItemAliveMaxHours: "掉落物品存活最大小时数",
  bAutoResetGuildNoOnlinePlayers: "自动重置无在线玩家的公会",
  AutoResetGuildTimeNoOnlinePlayers: "自动重置无在线玩家的公会时间（小时）",
  GuildPlayerMaxNum: "公会玩家最大数量",
  PalEggDefaultHatchingTime: "巨大蛋孵化所需时间（小时）",
  WorkSpeedRate: "工作速率",
  bIsMultiplay: "是否多人游戏",
  bIsPvP: "是否 PvP",
  bHardcore: "是否硬核模式",
  bPalLost: "是否帕鲁丢失模式",
  bCharacterRecreateInHardcore: "是否允许在硬核模式下重新创建角色",
  bCanPickupOtherGuildDeathPenaltyDrop: "能否拾取其他公会玩家的死亡惩罚掉落物",
  bEnableNonLoginPenalty: "启用超时未登录惩罚",
  bEnableFastTravel: "启用快速传送",
  bIsStartLocationSelectByMap: "是否通过地图选择复活位置",
  bExistPlayerAfterLogout: "登出后玩家人物是否存在",
  bEnableDefenseOtherGuildPlayer: "启用据点内防御其他公会玩家",
  bInvisibleOtherGuildBaseCampAreaFX: "隐藏其他公会据点区域特效",
  bBuildAreaLimit: "建筑区域限制",
  ItemWeightRate: "物品重量倍率",
  ServerReplicatePawnCullDistance: "玩家与帕鲁同步距离",
  bShowPlayerList: "启用服务器内可以查看其他玩家列表",
  RCONEnabled: "启用 RCON",
  RCONPort: "RCON 端口",
  RESTAPIEnabled: "启用 REST API",
  RESTAPIPort: "REST API 端口",
  Region: "地区",
  bUseAuth: "使用授权",
  BanListURL: "封禁列表 URL",
  bAllowClientMod: "允许客户端 Mod",
  bIsShowJoinLeftMessage: "显示玩家加入/离开消息",
  DenyTechnologyList: "禁用科技列表",
  GuildRejoinCooldownMinutes: "公会重加冷却时间（分钟）",
  BlockRespawnTime: "阻止重生时间",
  RespawnPenaltyDurationThreshold: "重生惩罚持续时间阈值",
  RespawnPenaltyTimeScale: "重生惩罚时间倍数",
  bDisplayPvPItemNumOnWorldMap_BaseCamp: "地图显示 PvP 掉落物数量（基地）",
  bDisplayPvPItemNumOnWorldMap_Player: "地图显示 PvP 掉落物数量（玩家）",
  AdditionalDropItemWhenPlayerKillingInPvPMode: "PvP 击杀附加掉落物",
  AdditionalDropItemNumWhenPlayerKillingInPvPMode: "PvP 击杀附加掉落物数量",
  bAdditionalDropItemWhenPlayerKillingInPvPMode: "启用 PvP 击杀附加掉落",
  bAllowEnhanceStat_Health: "允许加点：生命",
  bAllowEnhanceStat_Attack: "允许加点：攻击",
  bAllowEnhanceStat_Stamina: "允许加点：体力",
  bAllowEnhanceStat_Weight: "允许加点：负重",
  bAllowEnhanceStat_WorkSpeed: "允许加点：工作速度",
  PhysicsActiveDropItemMaxNum: "可启用物理模拟的掉落物最大数量",
  PlayerDataPalStorageUpdateCheckTickInterval: "玩家帕鲁仓库数据更新检测间隔",
  MonsterFarmActionSpeedRate: "帕鲁放牧产出物品速度倍率",
  AutoTransferMasterCheckIntervalSeconds: "公会归属自动转移检测间隔（秒）",
  AutoTransferMasterThresholdDays: "公会会长自动移交离线天数阈值",
  MaxGuildsPerFrame: "单帧处理公会最大数量",
  bEnableBuildingPlayerUIdDisplay: "显示建筑建造者玩家 ID",
  BuildingNameDisplayCacheTTLSeconds: "建筑名称显示缓存有效期（秒）",
  bEnableFastTravelOnlyBaseCamp: "仅基地可快速旅行",
  bAllowGlobalPalboxExport: "允许通过跨界帕鲁终端保存帕鲁的基因序列",
  bAllowGlobalPalboxImport: "允许通过跨界帕鲁终端的基因序列复原帕鲁",
  EquipmentDurabilityDamageRate: "装备耐久度损坏率",
  ItemContainerForceMarkDirtyInterval: "物品容器强制标记为脏的间隔（秒）",
  ItemCorruptionMultiplier: "物品腐化倍率",
};

const CONFIG_DESCRIPTIONS: Record<string, string> = {
  AutoSaveSpan: "服务器自动保存世界的时间间隔。",
  DeathPenalty: "决定玩家死亡时会掉落哪些物品。",
  LogFormatType: "选择服务器日志文件的保存格式。",
  RandomizerType: "决定随机化的作用范围。",
  CrossplayPlatforms: "选择允许加入本服务器的平台。",
  DenyTechnologyList: "选择需要从科技树中禁用的项目。",
};

type ConfigCategoryGroup = { id: ConfigCategoryId; tab: "panel" | "world"; label: string; description: string; keys: string[] };

const CONFIG_CATEGORY_GROUPS: ConfigCategoryGroup[] = [
  { id: "server", tab: "panel", label: "基本信息", description: "名称、描述、密码、地区与玩家人数", keys: ["ServerName", "ServerDescription", "AdminPassword", "ServerPassword", "PublicIP", "PublicPort", "ServerPlayerMaxNum", "Region"] },
  { id: "runtime", tab: "panel", label: "运行与存档", description: "自动保存、备份与服务器运行行为", keys: ["bIsUseBackupSaveData", "AutoSaveSpan", "bIsMultiplay"] },
  { id: "network", tab: "panel", label: "网络与接口", description: "RCON、REST API 与封禁列表", keys: ["RCONEnabled", "RCONPort", "RESTAPIEnabled", "RESTAPIPort", "BanListURL"] },
  { id: "mods", tab: "panel", label: "跨平台与模组", description: "平台联机、客户端 Mod 与科技限制", keys: ["CrossplayPlatforms", "bAllowClientMod", "bAllowGlobalPalboxExport", "bAllowGlobalPalboxImport", "DenyTechnologyList"] },
  { id: "communication", tab: "panel", label: "聊天与语音", description: "聊天频率、日志与语音距离", keys: ["LogFormatType", "ChatPostLimitPerMinute", "bEnableVoiceChat", "VoiceChatMaxVolumeDistance", "VoiceChatZeroVolumeDistance", "bIsShowJoinLeftMessage"] },
  { id: "access", tab: "panel", label: "可见性与权限", description: "玩家列表与服务器授权显示", keys: ["bShowPlayerList", "bUseAuth"] },
  { id: "random", tab: "world", label: "随机化", description: "世界、帕鲁与等级的随机化规则", keys: ["RandomizerType", "RandomizerSeed", "bIsRandomizerPalLevelRandom"] },
  { id: "progression", tab: "world", label: "时间与成长", description: "昼夜、经验、捕捉、出现数量与工作速度", keys: ["DayTimeSpeedRate", "NightTimeSpeedRate", "ExpRate", "PalCaptureRate", "PalSpawnNumRate", "WorkSpeedRate"] },
  { id: "combat", tab: "world", label: "战斗", description: "玩家和帕鲁伤害、PvP、袭击与死亡惩罚", keys: ["PlayerDamageRateAttack", "PlayerDamageRateDefense", "PalDamageRateAttack", "PalDamageRateDefense", "bEnablePlayerToPlayerDamage", "bEnableFriendlyFire", "bIsPvP", "DeathPenalty", "bEnableInvaderEnemy", "EnablePredatorBossPal", "bHardcore", "bPalLost", "bCharacterRecreateInHardcore", "bCanPickupOtherGuildDeathPenaltyDrop", "bAdditionalDropItemWhenPlayerKillingInPvPMode", "AdditionalDropItemWhenPlayerKillingInPvPMode", "AdditionalDropItemNumWhenPlayerKillingInPvPMode"] },
  { id: "survival", tab: "world", label: "生存", description: "饱食度、耐力、生命恢复、孵化与重生", keys: ["PlayerStomachDecreaceRate", "PlayerStaminaDecreaceRate", "PlayerAutoHPRegeneRate", "PlayerAutoHpRegeneRateInSleep", "PalStomachDecreaceRate", "PalStaminaDecreaceRate", "PalAutoHPRegeneRate", "PalAutoHpRegeneRateInSleep", "PalEggDefaultHatchingTime", "bEnableNonLoginPenalty", "bExistPlayerAfterLogout", "BlockRespawnTime", "RespawnPenaltyDurationThreshold", "RespawnPenaltyTimeScale"] },
  { id: "resources", tab: "world", label: "资源与掉落", description: "采集、掉落、重量、空投与耐久度", keys: ["CollectionDropRate", "CollectionObjectHpRate", "CollectionObjectRespawnSpeedRate", "EnemyDropItemRate", "ItemWeightRate", "DropItemMaxNum", "DropItemMaxNum_UNKO", "DropItemAliveMaxHours", "SupplyDropSpan", "EquipmentDurabilityDamageRate", "ItemContainerForceMarkDirtyInterval", "ItemCorruptionMultiplier", "PhysicsActiveDropItemMaxNum", "bActiveUNKO"] },
  { id: "building", tab: "world", label: "建造与据点", description: "建筑耐久、建造限制、据点与防御规则", keys: ["BuildObjectHpRate", "BuildObjectDamageRate", "BuildObjectDeteriorationDamageRate", "MaxBuildingLimitNum", "bBuildAreaLimit", "BaseCampMaxNum", "BaseCampMaxNumInGuild", "BaseCampWorkerMaxNum", "bEnableDefenseOtherGuildPlayer", "bInvisibleOtherGuildBaseCampAreaFX", "bEnableBuildingPlayerUIdDisplay", "BuildingNameDisplayCacheTTLSeconds"] },
  { id: "guild", tab: "world", label: "公会与玩家", description: "公会人数、自动重置、归属转移与地图显示", keys: ["GuildPlayerMaxNum", "bAutoResetGuildNoOnlinePlayers", "AutoResetGuildTimeNoOnlinePlayers", "GuildRejoinCooldownMinutes", "AutoTransferMasterCheckIntervalSeconds", "AutoTransferMasterThresholdDays", "MaxGuildsPerFrame", "bDisplayPvPItemNumOnWorldMap_BaseCamp", "bDisplayPvPItemNumOnWorldMap_Player"] },
  { id: "worldRules", tab: "world", label: "世界规则", description: "传送、复活位置、瞄准辅助与其他规则", keys: ["bEnableFastTravel", "bEnableFastTravelOnlyBaseCamp", "bIsStartLocationSelectByMap", "bEnableAimAssistPad", "bEnableAimAssistKeyboard"] },
  { id: "performance", tab: "world", label: "高级性能", description: "同步距离、放牧和数据更新策略", keys: ["ServerReplicatePawnCullDistance", "PlayerDataPalStorageUpdateCheckTickInterval", "MonsterFarmActionSpeedRate"] },
  { id: "character", tab: "world", label: "角色成长", description: "允许玩家提升的角色属性", keys: ["bAllowEnhanceStat_Health", "bAllowEnhanceStat_Attack", "bAllowEnhanceStat_Stamina", "bAllowEnhanceStat_Weight", "bAllowEnhanceStat_WorkSpeed"] },
  { id: "advanced", tab: "world", label: "高级字段", description: "版本化 schema 外的配置键", keys: [] },
];

const COMMON_CONFIG_KEYS = [
  "ServerName", "ServerDescription", "ServerPassword", "AdminPassword", "ServerPlayerMaxNum", "PublicPort", "Difficulty",
  "ExpRate", "PalCaptureRate", "EnemyDropItemRate", "PalEggDefaultHatchingTime", "DayTimeSpeedRate", "NightTimeSpeedRate",
  "PlayerDamageRateAttack", "PlayerDamageRateDefense", "PalDamageRateAttack", "PalDamageRateDefense",
  "PlayerStomachDecreaceRate", "PlayerStaminaDecreaceRate", "PalStomachDecreaceRate", "PalStaminaDecreaceRate",
  "DeathPenalty", "bIsPvP", "bEnablePlayerToPlayerDamage", "bEnableFriendlyFire",
];

const CONFIG_CATEGORY_BY_KEY: Record<string, ConfigCategoryId> = {};
for (const group of CONFIG_CATEGORY_GROUPS) {
  for (const key of group.keys) CONFIG_CATEGORY_BY_KEY[key] = group.id;
}

const CONFIG_NUMERIC_RANGES: Record<string, { min: number; max: number; step: number }> = {
  PublicPort: { min: 1, max: 65535, step: 1 },
  ServerPlayerMaxNum: { min: 1, max: 512, step: 1 },
  AutoSaveSpan: { min: 30, max: 3600, step: 30 },
  VoiceChatMaxVolumeDistance: { min: 0, max: 50000, step: 100 },
  VoiceChatZeroVolumeDistance: { min: 0, max: 50000, step: 100 },
  DayTimeSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  NightTimeSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  ExpRate: { min: 0.1, max: 20, step: 0.1 },
  PalCaptureRate: { min: 0.1, max: 5, step: 0.1 },
  PalSpawnNumRate: { min: 0.1, max: 5, step: 0.1 },
  PalDamageRateAttack: { min: 0.1, max: 5, step: 0.1 },
  PalDamageRateDefense: { min: 0.1, max: 5, step: 0.1 },
  PlayerDamageRateAttack: { min: 0.1, max: 5, step: 0.1 },
  PlayerDamageRateDefense: { min: 0.1, max: 5, step: 0.1 },
  PlayerStomachDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerStaminaDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerAutoHPRegeneRate: { min: 0.1, max: 5, step: 0.1 },
  PlayerAutoHpRegeneRateInSleep: { min: 0.1, max: 5, step: 0.1 },
  PalStomachDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PalStaminaDecreaceRate: { min: 0.1, max: 5, step: 0.1 },
  PalAutoHPRegeneRate: { min: 0.1, max: 5, step: 0.1 },
  PalAutoHpRegeneRateInSleep: { min: 0.1, max: 5, step: 0.1 },
  BuildObjectHpRate: { min: 0.1, max: 5, step: 0.1 },
  BuildObjectDamageRate: { min: 0.5, max: 3, step: 0.1 },
  BuildObjectDeteriorationDamageRate: { min: 0, max: 10, step: 0.1 },
  DropItemMaxNum: { min: 0, max: 10000, step: 1 },
  ItemWeightRate: { min: 0.1, max: 5, step: 0.1 },
  CollectionDropRate: { min: 0.5, max: 5, step: 0.1 },
  CollectionObjectHpRate: { min: 0.5, max: 3, step: 0.1 },
  CollectionObjectRespawnSpeedRate: { min: 0.5, max: 5, step: 0.1 },
  EnemyDropItemRate: { min: 0.5, max: 5, step: 0.1 },
  PalEggDefaultHatchingTime: { min: 0, max: 240, step: 0.1 },
  GuildPlayerMaxNum: { min: 1, max: 100, step: 1 },
  BaseCampMaxNumInGuild: { min: 1, max: 50, step: 1 },
  BaseCampWorkerMaxNum: { min: 1, max: 50, step: 1 },
  MaxBuildingLimitNum: { min: 0, max: 10000, step: 1 },
  SupplyDropSpan: { min: 0, max: 1000, step: 1 },
  ChatPostLimitPerMinute: { min: 0, max: 100, step: 1 },
  EquipmentDurabilityDamageRate: { min: 0.1, max: 5, step: 0.1 },
  ItemContainerForceMarkDirtyInterval: { min: 0.1, max: 10, step: 0.1 },
  ItemCorruptionMultiplier: { min: 0.1, max: 10, step: 0.1 },
  PhysicsActiveDropItemMaxNum: { min: 0, max: 10000, step: 1 },
  DropItemMaxNum_UNKO: { min: 0, max: 5000, step: 1 },
  BaseCampMaxNum: { min: 0, max: 10240, step: 1 },
  DropItemAliveMaxHours: { min: 0, max: 240, step: 0.1 },
  AutoResetGuildTimeNoOnlinePlayers: { min: 0, max: 240, step: 0.1 },
  WorkSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  ServerReplicatePawnCullDistance: { min: 500, max: 15000, step: 100 },
  RCONPort: { min: 1, max: 65535, step: 1 },
  RESTAPIPort: { min: 1, max: 65535, step: 1 },
  GuildRejoinCooldownMinutes: { min: 0, max: 1440, step: 1 },
  BlockRespawnTime: { min: 0, max: 60, step: 0.1 },
  RespawnPenaltyDurationThreshold: { min: 0, max: 3600, step: 1 },
  RespawnPenaltyTimeScale: { min: 0, max: 10, step: 0.1 },
  AdditionalDropItemNumWhenPlayerKillingInPvPMode: { min: 0, max: 100, step: 1 },
  PlayerDataPalStorageUpdateCheckTickInterval: { min: 0.1, max: 60, step: 0.1 },
  MonsterFarmActionSpeedRate: { min: 0.1, max: 5, step: 0.1 },
  AutoTransferMasterCheckIntervalSeconds: { min: 60, max: 86400, step: 60 },
  AutoTransferMasterThresholdDays: { min: 1, max: 365, step: 1 },
  MaxGuildsPerFrame: { min: 1, max: 100, step: 1 },
  BuildingNameDisplayCacheTTLSeconds: { min: 1, max: 3600, step: 1 },
};

const CONFIG_SELECT_OPTIONS: Record<string, ConfigOption[]> = {
  RandomizerType: [
    { value: "None", label: "不随机化" },
    { value: "Region", label: "区域随机化" },
    { value: "All", label: "完全随机化" },
  ],
  LogFormatType: [
    { value: "Text", label: "纯文本" },
    { value: "Json", label: "JSON" },
  ],
  DeathPenalty: [
    { value: "None", label: "不掉落" },
    { value: "Item", label: "仅掉落物品" },
    { value: "ItemAndEquipment", label: "掉落物品和装备" },
    { value: "All", label: "全部掉落" },
  ],
};

const CONFIG_MULTI_OPTIONS: Record<string, ConfigOption[]> = {
  CrossplayPlatforms: [
    { value: "Steam", label: "Steam", description: "PC（Steam）" },
    { value: "Xbox", label: "Xbox", description: "Xbox / Microsoft Store" },
    { value: "PS5", label: "PlayStation 5", description: "PlayStation 5" },
    { value: "Mac", label: "Mac", description: "macOS" },
  ],
  DenyTechnologyList: [
    { value: "Accessory_AirDash2", label: "空中冲刺 II", description: "Accessory_AirDash2" },
    { value: "Accessory_AirDash3", label: "空中冲刺 III", description: "Accessory_AirDash3" },
    { value: "Accessory_JumpCount_Increase1", label: "二段跳", description: "Accessory_JumpCount_Increase1" },
    { value: "Accessory_JumpCount_Increase2", label: "三段跳", description: "Accessory_JumpCount_Increase2" },
    { value: "Accessory_Nonkilling", label: "不杀生", description: "Accessory_Nonkilling" },
    { value: "Accessory_TalentChecker", label: "天赋查看器", description: "Accessory_TalentChecker" },
    { value: "DimensionPalStorage", label: "跨界帕鲁终端", description: "DimensionPalStorage" },
    { value: "Battle_Sword_01", label: "单手剑", description: "Battle_Sword_01" },
  ],
};

const CONFIG_BOOLEAN_KEYS = new Set([
  "EnablePredatorBossPal",
  "RCONEnabled",
  "RESTAPIEnabled",
]);

function configCategoryFor(key: string): ConfigCategoryId {
  return CONFIG_CATEGORY_BY_KEY[key] || "advanced";
}

function configLabelFor(key: string): string {
  return CONFIG_LABELS[key] || key;
}

function configMetaFor(key: string, value: string): ConfigFieldMeta {
  if (key === "AdminPassword") {
    return {
      key,
      label: configLabelFor(key),
      description: "密码不会回显。输入新密码后保存草稿，再停服应用到游戏设置。",
      kind: "password",
    };
  }
  const range = CONFIG_NUMERIC_RANGES[key];
  if (range) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "可直接输入数值，也可以拖动进度条调整。",
      kind: "number",
      ...range,
    };
  }
  if (CONFIG_SELECT_OPTIONS[key]) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "从预设选项中选择配置值。",
      kind: "select",
      options: CONFIG_SELECT_OPTIONS[key],
    };
  }
  if (CONFIG_MULTI_OPTIONS[key]) {
    return {
      key,
      label: configLabelFor(key),
      description: CONFIG_DESCRIPTIONS[key] || "可以同时选择多个配置项。",
      kind: "multi-select",
      options: CONFIG_MULTI_OPTIONS[key],
    };
  }
  if (CONFIG_BOOLEAN_KEYS.has(key) || key.startsWith("b") || /^(true|false)$/i.test(value.trim())) {
    return {
      key,
      label: configLabelFor(key),
      description: "开启或关闭这项服务器规则。",
      kind: "boolean",
    };
  }
  return {
    key,
    label: configLabelFor(key),
    description: "按原文本保存此配置值。",
    kind: "text",
  };
}

function configArrayValues(value: string): string[] {
  const content = value.trim().replace(/^\(|\)$/g, "");
  if (!content) return [];
  return content
    .split(",")
    .map((item) => item.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
}

function configTupleValues(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") return configArrayValues(decoded);
    } catch {
      return [];
    }
  }
  return configArrayValues(value);
}

function serializeConfigArray(values: string[], previousValue: string): string {
  const previous = previousValue.trim();
  const wrapped = previous.startsWith("(") && previous.endsWith(")");
  const quoted = /(^|,)\s*"/.test(previous.replace(/^\(|\)$/g, ""));
  const content = values.map((value) => (quoted ? `"${value}"` : value)).join(",");
  return wrapped ? `(${content})` : content;
}

function serializeConfigTuple(values: string[]): string {
  return `(${values.join(",")})`;
}

function configNumberValue(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatConfigNumberDisplay(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return String(Number(parsed.toFixed(2)));
}

function configTextDisplayValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

function serializeConfigTextValue(displayValue: string, previousValue: string): string {
  const previous = previousValue.trim();
  if (previous.length >= 2 && previous.startsWith('"') && previous.endsWith('"')) {
    return `"${displayValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return displayValue;
}

function serializeConfigPassword(value: string): string {
  if (!value) return "";
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function configRangePercent(value: string, min: number, max: number): number {
  const numeric = configNumberValue(value, min);
  return Math.min(100, Math.max(0, ((numeric - min) / (max - min)) * 100));
}

function ConfigFieldEditor({
  meta,
  value,
  sourceValue,
  modified,
  onChange,
  onReset,
}: {
  meta: ConfigFieldMeta;
  value: string;
  sourceValue: string;
  modified: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const isCrossplayPlatforms = meta.key === "CrossplayPlatforms";
  const selectedValues = [...new Set(isCrossplayPlatforms ? configTupleValues(value) : configArrayValues(value))];
  const configuredOptions = meta.options || [];
  const configuredValues = new Set(configuredOptions.map((option) => option.value));
  const serverOptions = selectedValues
    .filter((selected) => !configuredValues.has(selected))
    .map((selected) => ({ value: selected, label: selected, description: "服务器当前配置中的原始值" }));
  const options = [...configuredOptions, ...serverOptions];
  const selectionLabel = selectedValues.length
    ? selectedValues.map((selected) => options.find((option) => option.value === selected)?.label || selected).join("、")
    : "未选择";

  return (
    <div className="config-field-row" data-config-key={meta.key}>
      <div className="config-field-copy">
        <div className="config-field-title">
          <strong>{meta.label}</strong>
          <code>{meta.key}</code>
          {modified && <span className="config-changed-badge">已修改</span>}
        </div>
        <p>{meta.description}</p>
      </div>
      <div className={`config-field-control config-kind-${meta.kind}`}>
        {meta.kind === "number" && meta.min !== undefined && meta.max !== undefined && meta.step !== undefined && (
          <div className="config-range-control">
            <input
              className="config-number-input"
              type="number"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={formatConfigNumberDisplay(value)}
              aria-label={meta.label}
              onChange={(event) => onChange(event.target.value)}
            />
            <div className="config-range-wrap">
              <input
                className="config-range-input"
                type="range"
                min={meta.min}
                max={meta.max}
                step={meta.step}
                value={configNumberValue(value, meta.min)}
                style={{ "--config-progress": `${configRangePercent(value, meta.min, meta.max)}%` } as CSSProperties}
                aria-label={`${meta.label}滑块`}
                onChange={(event) => onChange(event.target.value)}
              />
              <div className="config-range-scale"><span>{meta.min}</span><span>{meta.max}</span></div>
            </div>
          </div>
        )}
        {meta.kind === "boolean" && (
          <div className="config-boolean-control"><span>{/^true$/i.test(value.trim()) ? "已开启" : "已关闭"}</span><button
              className={`config-switch ${/^true$/i.test(value.trim()) ? "is-on" : ""}`}
              type="button"
              role="switch"
              aria-checked={/^true$/i.test(value.trim())}
              aria-label={meta.label}
              onClick={() => onChange(/^true$/i.test(value.trim()) ? "False" : "True")}
            ><span className="config-switch-thumb" /></button></div>
        )}
        {meta.kind === "select" && (
          <div className="config-select-control">
            <select value={value} aria-label={meta.label} onChange={(event) => onChange(event.target.value)}>
              {meta.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </div>
        )}
        {meta.kind === "multi-select" && (
          <details className="config-multi-control">
            <summary aria-label={`${meta.label}：${selectedValues.length ? `已选 ${selectedValues.length} 项` : "未选择"}`}>
              <span className="config-multi-summary">
                <span className="config-multi-summary-count">{selectedValues.length ? `已选 ${selectedValues.length} 项` : "未选择"}</span>
                <span className="config-multi-summary-value" title={selectionLabel}>{selectionLabel}</span>
              </span>
              <ChevronDown size={16} aria-hidden="true" />
            </summary>
            <div className="config-multi-menu" role="group" aria-label={`${meta.label}选项`}>
              <div className="config-multi-menu-header"><span>可选择项</span><strong>{selectedValues.length} / {options.length}</strong></div>
              <div className="config-multi-options">
                {options.map((option) => {
                  const checked = selectedValues.includes(option.value);
                  return (
                    <label key={option.value} className={`config-multi-option ${checked ? "is-selected" : ""}`}>
                      <input type="checkbox" checked={checked} aria-label={option.label} onChange={() => onChange(isCrossplayPlatforms ? serializeConfigTuple(checked ? selectedValues.filter((item) => item !== option.value) : [...selectedValues, option.value]) : serializeConfigArray(checked ? selectedValues.filter((item) => item !== option.value) : [...selectedValues, option.value], value))} />
                      <span className="config-multi-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </details>
        )}
        {meta.kind === "password" && <input className="config-text-input" type="password" autoComplete="new-password" value={configTextDisplayValue(value)} placeholder={sourceValue === "已配置" ? "已配置；输入新密码以覆盖" : "输入游戏管理员密码"} aria-label={meta.label} onChange={(event) => onChange(serializeConfigPassword(event.target.value))} />}
        {meta.kind === "text" && <input className="config-text-input" value={configTextDisplayValue(value)} aria-label={meta.label} onChange={(event) => onChange(serializeConfigTextValue(event.target.value, value))} />}
      </div>
      <button className="config-reset-button" type="button" title="恢复原值" aria-label={`恢复${meta.label}原值`} onClick={onReset} disabled={meta.kind === "password" ? !value : value === sourceValue}><RotateCcw size={15} /></button>
    </div>
  );
}

export function ConfigPage({
  auth,
  onAuthChanged,
  workspace,
  onWorkspaceChange,
}: {
  auth: AuthStatus;
  onAuthChanged: () => void;
  workspace: ConfigWorkspace;
  onWorkspaceChange: (workspace: ConfigWorkspace) => void;
}) {
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [diff, setDiff] = useState<{ hasDraft: boolean; conflict: Record<string, unknown> | null; text: string; fields: { key: string; current: string; draft: string }[] } | null>(null);
  const [query, setQuery] = useState("");
  const [editorTab, setEditorTab] = useState<ConfigEditorTab>("common");
  const [selectedCategory, setSelectedCategory] = useState<ConfigCategoryId>("server");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const nextRequestSignal = useAbortableRequest();
  const load = useCallback(async () => {
    const signal = nextRequestSignal();
    try {
      const next = await requestJson<ConfigDocument>("/api/config/draft", { signal });
      setDocument(next);
      const nextFields = { ...(next.draft?.fields || next.fields) };
      delete nextFields.AdminPassword;
      setFields(nextFields);
      setDiff(await requestJson<typeof diff>("/api/config/diff", { signal }));
    } catch (caught) { if (!isAbortError(caught)) setError(caught instanceof Error ? caught.message : "配置读取失败"); }
  }, [nextRequestSignal]);
  useEffect(() => { void load(); }, [load]);
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const fieldsToSave = { ...fields };
    if (!fieldsToSave.AdminPassword) delete fieldsToSave.AdminPassword;
    try { await requestJson("/api/config/draft", { method: "PUT", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ fields: fieldsToSave }) }); setMessage("配置草稿已保存，尚未写入真实 INI。"); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "草稿保存失败"); } finally { setBusy(false); }
  }
  async function apply(force = false) {
    if (!window.confirm(force ? "检测到外部修改，确认用当前草稿覆盖吗？" : "确认应用配置吗？PalServer 必须已停止。")) return;
    setBusy(true); setError("");
    try { const result = await requestJson<{ message: string }>("/api/config/apply", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: JSON.stringify({ force }) }); setMessage(result.message); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "配置应用失败"); } finally { setBusy(false); }
  }
  async function restartApply() {
    if (!window.confirm("确认停止并重启 PalServer 后应用草稿吗？将先发送维护通知并保存世界。")) return;
    setBusy(true); setError("");
    try { await requestJson("/api/config/apply-with-restart", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "", "Idempotency-Key": createIdempotencyKey() }, body: JSON.stringify({ countdownSeconds: 30, message: "服务器将在 30 秒后重启并应用配置，请及时返回安全地点。" }) }); setMessage("已提交重启并应用操作。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "重启应用失败"); } finally { setBusy(false); }
  }
  async function openFolder() { try { await requestJson("/api/config/open-folder", { method: "POST", headers: { "X-CSRF-Token": auth.csrfToken || "" }, body: "{}" }); setError(""); setMessage("已打开配置目录。"); } catch (caught) { setError(caught instanceof Error ? caught.message : "打开目录失败"); } }
  const workspaceTabs = <div className="config-workspace-tabs" role="tablist" aria-label="配置工作区">
    <button className={workspace === "game" ? "is-active" : ""} type="button" role="tab" aria-selected={workspace === "game"} onClick={() => onWorkspaceChange("game")}><FileCog size={18} />游戏配置</button>
    <button className={workspace === "instance" ? "is-active" : ""} type="button" role="tab" aria-selected={workspace === "instance"} onClick={() => onWorkspaceChange("instance")}><ServerCog size={18} />实例与控制台</button>
  </div>;
  const consoleAndInstanceSettings = <section className="config-instance-workspace">
    <header className="config-instance-heading">
      <div><span className="config-instance-heading-icon"><ServerCog aria-hidden="true" /></span><div><h2>实例运行环境</h2><p>明确 PalServer 启动目标、世界绑定与控制台入口；这里的修改不会写入游戏规则配置。</p></div></div>
      <span className="config-locality-badge" data-local={auth.local || undefined}>{auth.local ? "服务器本机 · 可编辑" : "局域网访问 · 只读"}</span>
    </header>
    <div className="config-instance-map" aria-label="实例设置范围">
      <span><HardDrive aria-hidden="true" /><strong>运行实例</strong><small>可执行文件、World 与启动参数</small></span>
      <span><Network aria-hidden="true" /><strong>控制台入口</strong><small>Web 管理端口，重启控制台后生效</small></span>
    </div>
    <div className="config-instance-grid">
      <ServerSettingsPanel auth={auth} />
      <ConsolePortSettings auth={auth} onAuthChanged={onAuthChanged} />
    </div>
  </section>;
  if (workspace === "instance") return <div className="page-stack config-page">{workspaceTabs}{consoleAndInstanceSettings}</div>;
  if (!document) return <div className="page-stack config-page">{workspaceTabs}<section className="config-loading" aria-live="polite">{error ? <p className="form-error" role="alert">{error}</p> : <><span className="config-loading-line" /><span className="config-loading-line short" /><p className="muted">正在读取 PalWorldSettings.ini...</p></>}</section></div>;

  const allKeys = [
    ...document.schema.filter((key) => key === "AdminPassword" || key in fields),
    ...Object.keys(fields).filter((key) => !document.schema.includes(key)),
  ];
  const configOrder = new Map<string, number>();
  CONFIG_CATEGORY_GROUPS.forEach((group, groupIndex) => group.keys.forEach((key, keyIndex) => configOrder.set(key, groupIndex * 1000 + keyIndex)));
  const orderedKeys = [...allKeys].sort((left, right) => (configOrder.get(left) ?? Number.MAX_SAFE_INTEGER) - (configOrder.get(right) ?? Number.MAX_SAFE_INTEGER));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const commonKeys = COMMON_CONFIG_KEYS.filter((key) => allKeys.includes(key));
  const commonKeySet = new Set(commonKeys);
  const advancedKeys = orderedKeys.filter((key) => !commonKeySet.has(key));
  const activeGroups = CONFIG_CATEGORY_GROUPS.filter((group) => advancedKeys.some((key) => configCategoryFor(key) === group.id));
  const visibleKeys = (editorTab === "common" ? commonKeys : advancedKeys).filter((key) => {
    const inCategory = editorTab === "common" || Boolean(normalizedQuery) || configCategoryFor(key) === selectedCategory;
    const searchable = `${configLabelFor(key)} ${key} ${CONFIG_DESCRIPTIONS[key] || ""}`.toLocaleLowerCase();
    return inCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
  });
  const selectedGroup = activeGroups.find((group) => group.id === selectedCategory) || activeGroups[0] || CONFIG_CATEGORY_GROUPS[0];
  const tabTotal = editorTab === "common" ? commonKeys.length : advancedKeys.length;
  const baselineFields = document.draft?.fields || document.fields;
  const modifiedKeys = allKeys.filter((key) => key === "AdminPassword" ? Boolean(fields[key]) : (fields[key] || "") !== (baselineFields[key] || ""));
  const modifiedKeySet = new Set(modifiedKeys);
  const draftFieldCount = diff?.fields.length || 0;
  function switchEditorTab(tab: ConfigEditorTab) {
    setEditorTab(tab);
    setQuery("");
    if (tab === "advanced") setSelectedCategory(activeGroups[0]?.id || "advanced");
  }
  function discardWorkingChanges() {
    const nextFields = { ...baselineFields };
    delete nextFields.AdminPassword;
    setFields(nextFields);
  }

  return <div className="page-stack config-page">
    {workspaceTabs}
    <section className="config-summary" aria-label="游戏配置状态">
      <div className="config-file-summary"><div><h2>PalWorldSettings.ini</h2><p>{document.path}</p></div>{auth.local && <button className="quiet-button" type="button" onClick={() => void openFolder()}><FolderSearch size={17} />打开配置目录</button>}</div>
      <div className="config-summary-items">
        <span><small>管理员密码</small><strong className={document.adminPasswordConfigured ? "is-success" : "is-warning"}>{document.adminPasswordConfigured ? "已配置" : "未配置"}</strong></span>
        <span><small>WorldOption.sav</small><strong className={document.worldOptionPresent ? "is-warning" : ""}>{document.worldOptionPresent ? "可能覆盖 INI" : "未检测到覆盖"}</strong></span>
        <span><small>已保存草稿</small><strong>{diff?.hasDraft ? `${draftFieldCount} 项修改` : "无"}</strong></span>
        <span><small>外部冲突</small><strong className={diff?.conflict ? "is-danger" : "is-success"}>{diff?.conflict ? "需要确认" : "未检测到"}</strong></span>
      </div>
    </section>
    <div className="config-workflow" role="note"><strong>编辑 → 保存草稿 → 应用到服务器</strong><span>运行中的 PalServer 不会被实时写入；应用前必须停服，或使用“重启并应用”。</span></div>
    {document.worldOptionPresent && <div className="warning-strip"><AlertTriangle size={19} /><span>检测到当前世界存在 WorldOption.sav，游戏内设置可能覆盖此 INI。仍可继续应用。</span></div>}
    <form className="config-form" onSubmit={saveDraft}>
      <section className="config-editor-shell">
        <div className="config-editor-tabs" role="tablist" aria-label="配置设置类型">
          <button className={editorTab === "common" ? "is-active" : ""} type="button" role="tab" aria-selected={editorTab === "common"} onClick={() => switchEditorTab("common")}>常用配置</button>
          <button className={editorTab === "advanced" ? "is-active" : ""} type="button" role="tab" aria-selected={editorTab === "advanced"} onClick={() => switchEditorTab("advanced")}>高级配置</button>
        </div>
        <div className="config-editor-toolbar">
          {editorTab === "advanced" && <label className="config-search"><Search size={19} aria-hidden="true" /><input type="search" value={query} placeholder="搜索名称或配置键" aria-label="搜索名称或配置键" onChange={(event) => setQuery(event.target.value)} /></label>}
          <span className="config-count">{normalizedQuery ? visibleKeys.length : tabTotal} 项配置</span>
        </div>
        <div className={editorTab === "advanced" ? "config-editor-layout" : "config-editor-layout common-config-layout"}>
          {editorTab === "advanced" && <nav className="config-category-nav" aria-label="高级配置分类">
            {activeGroups.map((group) => {
              const count = advancedKeys.filter((key) => configCategoryFor(key) === group.id).length;
              return <button key={group.id} className={selectedCategory === group.id && !normalizedQuery ? "is-active" : ""} type="button" onClick={() => { setSelectedCategory(group.id); setQuery(""); }}><span>{group.label}</span><small>{count}</small></button>;
            })}
          </nav>}
          <div className="config-editor-main">
            <header className="config-section-header"><div><h2>{normalizedQuery ? "匹配的配置" : editorTab === "common" ? "日常服务器规则" : selectedGroup.label}</h2><p>{normalizedQuery ? `共找到 ${visibleKeys.length} 项配置。` : editorTab === "common" ? "仅展示日常会调整的服务器规则；完整字段可从高级配置进入。" : selectedGroup.description}</p></div><span className="config-section-total">{visibleKeys.length} 项</span></header>
            <div className="config-field-list">
              {visibleKeys.map((key) => {
                const meta = configMetaFor(key, fields[key] || "");
                const sourceValue = key === "AdminPassword" ? (document.adminPasswordConfigured ? "已配置" : "未配置") : baselineFields[key] || "";
                return <ConfigFieldEditor key={key} meta={meta} value={fields[key] || ""} sourceValue={sourceValue} modified={modifiedKeySet.has(key)} onChange={(value) => setFields((current) => ({ ...current, [key]: value }))} onReset={() => setFields((current) => {
                  if (meta.kind === "password") {
                    const next = { ...current };
                    delete next[key];
                    return next;
                  }
                  return { ...current, [key]: baselineFields[key] || "" };
                })} />;
              })}
              {!visibleKeys.length && <div className="config-empty-results"><Search size={22} /><p>{editorTab === "common" ? "当前配置中没有可显示的常用字段。" : "没有找到匹配的配置。"}</p>{editorTab === "advanced" && <button className="quiet-button" type="button" onClick={() => { setQuery(""); setSelectedCategory(activeGroups[0]?.id || "advanced"); }}>清除搜索</button>}</div>}
            </div>
          </div>
        </div>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
      <div className="config-action-bar"><div className="config-action-state"><strong>{modifiedKeys.length ? `${modifiedKeys.length} 项未保存修改` : document.draft ? "草稿已保存，等待应用" : "配置与已保存内容一致"}</strong><span>{modifiedKeys.length ? "先保存为草稿，不会立即写入真实 INI。" : document.draft ? `${draftFieldCount} 项草稿修改尚未应用到服务器。` : "修改字段后可保存为待应用草稿。"}</span></div><div className="config-toolbar">{modifiedKeys.length > 0 && <button className="quiet-button" type="button" disabled={busy} onClick={discardWorkingChanges}>放弃本次修改</button>}<button className="primary-button" disabled={busy || modifiedKeys.length === 0} type="submit"><Save size={18} />{busy ? "正在保存…" : modifiedKeys.length ? `保存 ${modifiedKeys.length} 项草稿` : "保存草稿"}</button>{document.draft && <><button className="quiet-button" type="button" disabled={busy || Boolean(diff?.conflict)} onClick={() => void apply(false)}>停服应用</button><button className="quiet-button" type="button" disabled={busy || Boolean(diff?.conflict)} onClick={() => void restartApply()}><RotateCw size={17} />{busy ? "正在提交…" : "重启并应用"}</button></>}</div></div>
    </form>
    {diff?.hasDraft && <section className={diff.conflict ? "config-diff conflict" : "config-diff"}><div className="section-heading"><div><h2>草稿差异</h2><p>{diff.conflict ? "检测到外部修改，应用前必须确认覆盖。" : "以下草稿尚未写入真实 INI。"}</p></div>{diff.conflict && <button className="danger-button" type="button" disabled={busy} onClick={() => void apply(true)}>确认覆盖外部修改</button>}</div>{diff.fields.length ? <div className="config-diff-table"><div className="config-diff-head"><span>配置项</span><span>当前值</span><span>草稿值</span></div>{diff.fields.map((item) => <div className="config-diff-row" key={item.key}><strong>{configLabelFor(item.key)}<small>{item.key}</small></strong><span>{displayDiffValue(item.key, item.current)}</span><span>{displayDiffValue(item.key, item.draft)}</span></div>)}</div> : <p className="muted">字段值有变化，但没有可显示的字段摘要。</p>}<details className="config-raw-diff"><summary>查看原始差异</summary><pre>{diff.text || "文本差异为空。"}</pre></details></section>}
  </div>;
}

function displayDiffValue(key: string, value: string): string {
  if (key === "AdminPassword") return "••••••";
  return value || "（空）";
}
