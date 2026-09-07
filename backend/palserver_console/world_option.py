from __future__ import annotations

import json
import time
from decimal import Decimal
from pathlib import Path
from typing import Any, cast

from palworld_save_tools.archive import FArchiveReader
from palworld_save_tools.gvas import GvasFile, GvasHeader
from palworld_save_tools.palsav import compress_gvas_to_sav, decompress_sav_to_gvas

WORLD_OPTION_CLASS = "/Script/Pal.PalWorldOptionSaveGame"
ZERO_UUID = "00000000-0000-0000-0000-000000000000"
UNIX_EPOCH_TICKS = 621355968000000000

WORLD_OPTION_ENUMS = {
    "Difficulty": "EPalOptionWorldDifficulty",
    "DeathPenalty": "EPalOptionWorldDeathPenalty",
    "LogFormatType": "EPalOptionWorldLogFormatType",
    "RandomizerType": "EPalRandomizerType",
}
WORLD_OPTION_ENUM_ARRAYS = {"CrossplayPlatforms": "EPalAllowConnectPlatform"}
WORLD_OPTION_INTS = frozenset(
    {
        "PublicPort",
        "ServerPlayerMaxNum",
        "RCONPort",
        "RESTAPIPort",
        "DropItemMaxNum",
        "DropItemMaxNum_UNKO",
        "BaseCampMaxNum",
        "BaseCampMaxNumInGuild",
        "BaseCampWorkerMaxNum",
        "MaxBuildingLimitNum",
        "GuildPlayerMaxNum",
        "SupplyDropSpan",
        "ChatPostLimitPerMinute",
        "GuildRejoinCooldownMinutes",
        "AdditionalDropItemNumWhenPlayerKillingInPvPMode",
    }
)
WORLD_OPTION_FLOATS = frozenset(
    {
        "DayTimeSpeedRate",
        "NightTimeSpeedRate",
        "ExpRate",
        "PalCaptureRate",
        "PalSpawnNumRate",
        "PalDamageRateAttack",
        "PalDamageRateDefense",
        "PlayerDamageRateAttack",
        "PlayerDamageRateDefense",
        "PlayerStomachDecreaceRate",
        "PlayerStaminaDecreaceRate",
        "PlayerAutoHPRegeneRate",
        "PlayerAutoHpRegeneRateInSleep",
        "PalStomachDecreaceRate",
        "PalStaminaDecreaceRate",
        "PalAutoHPRegeneRate",
        "PalAutoHpRegeneRateInSleep",
        "BuildObjectHpRate",
        "BuildObjectDamageRate",
        "BuildObjectDeteriorationDamageRate",
        "CollectionDropRate",
        "CollectionObjectHpRate",
        "CollectionObjectRespawnSpeedRate",
        "EnemyDropItemRate",
        "ItemWeightRate",
        "EquipmentDurabilityDamageRate",
        "ItemContainerForceMarkDirtyInterval",
        "ItemCorruptionMultiplier",
        "DropItemAliveMaxHours",
        "AutoResetGuildTimeNoOnlinePlayers",
        "WorkSpeedRate",
        "AutoSaveSpan",
        "PalEggDefaultHatchingTime",
        "ServerReplicatePawnCullDistance",
        "BlockRespawnTime",
        "RespawnPenaltyDurationThreshold",
        "RespawnPenaltyTimeScale",
    }
)
WORLD_OPTION_STRINGS = frozenset(
    {
        "RandomizerSeed",
        "ServerName",
        "ServerDescription",
        "AdminPassword",
        "ServerPassword",
        "PublicIP",
        "Region",
        "BanListURL",
        "DenyTechnologyList",
        "AdditionalDropItemWhenPlayerKillingInPvPMode",
    }
)
WORLD_OPTION_BOOLS = frozenset(
    {
        "bIsRandomizerPalLevelRandom",
        "bAllowGlobalPalboxExport",
        "bAllowGlobalPalboxImport",
        "bEnableInvaderEnemy",
        "EnablePredatorBossPal",
        "bActiveUNKO",
        "bAutoResetGuildNoOnlinePlayers",
        "bIsMultiplay",
        "bEnableNonLoginPenalty",
        "bIsStartLocationSelectByMap",
        "bIsUseBackupSaveData",
        "bUseAuth",
        "bEnableFastTravel",
        "bIsPvP",
        "bHardcore",
        "bPalLost",
        "bCharacterRecreateInHardcore",
        "bCanPickupOtherGuildDeathPenaltyDrop",
        "bExistPlayerAfterLogout",
        "bEnableDefenseOtherGuildPlayer",
        "bInvisibleOtherGuildBaseCampAreaFX",
        "bBuildAreaLimit",
        "bShowPlayerList",
        "bEnablePlayerToPlayerDamage",
        "bEnableFriendlyFire",
        "bEnableAimAssistPad",
        "bEnableAimAssistKeyboard",
        "bEnableFastTravelOnlyBaseCamp",
        "bAllowClientMod",
        "bIsShowJoinLeftMessage",
        "RCONEnabled",
        "RESTAPIEnabled",
        "bDisplayPvPItemNumOnWorldMap_BaseCamp",
        "bDisplayPvPItemNumOnWorldMap_Player",
        "bAdditionalDropItemWhenPlayerKillingInPvPMode",
        "bAllowEnhanceStat_Health",
        "bAllowEnhanceStat_Attack",
        "bAllowEnhanceStat_Stamina",
        "bAllowEnhanceStat_Weight",
        "bAllowEnhanceStat_WorkSpeed",
    }
)
WORLD_OPTION_KEYS = frozenset(
    set(WORLD_OPTION_ENUMS)
    | set(WORLD_OPTION_ENUM_ARRAYS)
    | WORLD_OPTION_INTS
    | WORLD_OPTION_FLOATS
    | WORLD_OPTION_STRINGS
    | WORLD_OPTION_BOOLS
)

# Bluefissure/pal-conf main, commit a0f75513 (2026-07-11). Values intentionally
# keep pal-conf's source representation; default_world_option_fields() converts
# them to this backend's canonical INI-style representation.
WORLD_OPTION_DEFAULTS = {
    "AdditionalDropItemNumWhenPlayerKillingInPvPMode": "1",
    "AdditionalDropItemWhenPlayerKillingInPvPMode": "PlayerDropItem",
    "AdminPassword": "",
    "AutoResetGuildTimeNoOnlinePlayers": "72.000000",
    "AutoSaveSpan": "30.000000",
    "BanListURL": "https://b.palworldgame.com/api/banlist.txt",
    "BaseCampMaxNum": "128",
    "BaseCampMaxNumInGuild": "3",
    "BaseCampWorkerMaxNum": "15",
    "BlockRespawnTime": "5.000000",
    "BuildObjectDamageRate": "1.000000",
    "BuildObjectDeteriorationDamageRate": "1.000000",
    "BuildObjectHpRate": "1.000000",
    "ChatPostLimitPerMinute": "10",
    "CollectionDropRate": "1.000000",
    "CollectionObjectHpRate": "1.000000",
    "CollectionObjectRespawnSpeedRate": "1.000000",
    "CrossplayPlatforms": "Steam,Xbox,PS5,Mac",
    "DayTimeSpeedRate": "1.000000",
    "DeathPenalty": "All",
    "DenyTechnologyList": "",
    "Difficulty": "None",
    "DropItemAliveMaxHours": "1.000000",
    "DropItemMaxNum": "3000",
    "DropItemMaxNum_UNKO": "100",
    "EnablePredatorBossPal": "True",
    "EnemyDropItemRate": "1.000000",
    "EquipmentDurabilityDamageRate": "1.000000",
    "ExpRate": "1.000000",
    "GuildPlayerMaxNum": "20",
    "GuildRejoinCooldownMinutes": "0",
    "ItemContainerForceMarkDirtyInterval": "1.000000",
    "ItemCorruptionMultiplier": "1.000000",
    "ItemWeightRate": "1.000000",
    "LogFormatType": "Text",
    "MaxBuildingLimitNum": "0",
    "NightTimeSpeedRate": "1.000000",
    "PalAutoHPRegeneRate": "1.000000",
    "PalAutoHpRegeneRateInSleep": "1.000000",
    "PalCaptureRate": "1.000000",
    "PalDamageRateAttack": "1.000000",
    "PalDamageRateDefense": "1.000000",
    "PalEggDefaultHatchingTime": "72.000000",
    "PalSpawnNumRate": "1.000000",
    "PalStaminaDecreaceRate": "1.000000",
    "PalStomachDecreaceRate": "1.000000",
    "PlayerAutoHPRegeneRate": "1.000000",
    "PlayerAutoHpRegeneRateInSleep": "1.000000",
    "PlayerDamageRateAttack": "1.000000",
    "PlayerDamageRateDefense": "1.000000",
    "PlayerStaminaDecreaceRate": "1.000000",
    "PlayerStomachDecreaceRate": "1.000000",
    "PublicIP": "",
    "PublicPort": "8211",
    "RCONEnabled": "False",
    "RCONPort": "25575",
    "RESTAPIEnabled": "False",
    "RESTAPIPort": "8212",
    "RandomizerSeed": "",
    "RandomizerType": "None",
    "Region": "",
    "RespawnPenaltyDurationThreshold": "0.000000",
    "RespawnPenaltyTimeScale": "2.000000",
    "ServerDescription": "",
    "ServerName": "Default Palworld Server",
    "ServerPassword": "",
    "ServerPlayerMaxNum": "32",
    "ServerReplicatePawnCullDistance": "15000.000000",
    "SupplyDropSpan": "180",
    "WorkSpeedRate": "1.000000",
    "bActiveUNKO": "False",
    "bAdditionalDropItemWhenPlayerKillingInPvPMode": "False",
    "bAllowClientMod": "True",
    "bAllowEnhanceStat_Attack": "True",
    "bAllowEnhanceStat_Health": "True",
    "bAllowEnhanceStat_Stamina": "True",
    "bAllowEnhanceStat_Weight": "True",
    "bAllowEnhanceStat_WorkSpeed": "True",
    "bAllowGlobalPalboxExport": "True",
    "bAllowGlobalPalboxImport": "False",
    "bAutoResetGuildNoOnlinePlayers": "False",
    "bBuildAreaLimit": "False",
    "bCanPickupOtherGuildDeathPenaltyDrop": "False",
    "bCharacterRecreateInHardcore": "False",
    "bDisplayPvPItemNumOnWorldMap_BaseCamp": "False",
    "bDisplayPvPItemNumOnWorldMap_Player": "False",
    "bEnableAimAssistKeyboard": "False",
    "bEnableAimAssistPad": "True",
    "bEnableDefenseOtherGuildPlayer": "False",
    "bEnableFastTravel": "True",
    "bEnableFastTravelOnlyBaseCamp": "False",
    "bEnableFriendlyFire": "False",
    "bEnableInvaderEnemy": "True",
    "bEnableNonLoginPenalty": "True",
    "bEnablePlayerToPlayerDamage": "False",
    "bExistPlayerAfterLogout": "False",
    "bHardcore": "False",
    "bInvisibleOtherGuildBaseCampAreaFX": "False",
    "bIsMultiplay": "False",
    "bIsPvP": "False",
    "bIsRandomizerPalLevelRandom": "False",
    "bIsShowJoinLeftMessage": "True",
    "bIsStartLocationSelectByMap": "True",
    "bIsUseBackupSaveData": "True",
    "bPalLost": "False",
    "bShowPlayerList": "False",
    "bUseAuth": "True",
}


def read_world_option(path: Path) -> tuple[GvasFile, int, dict[str, str]]:
    try:
        raw_gvas, save_type = decompress_sav_to_gvas(path.read_bytes())
        gvas = GvasFile.read(raw_gvas)
        settings = _settings(gvas)
    except Exception as error:
        raise ValueError(f"无法读取 WorldOption.sav: {type(error).__name__}: {error}") from error
    return gvas, save_type, fields_from_settings(settings)


def create_world_option(level_path: Path, fields: dict[str, str]) -> tuple[GvasFile, int]:
    try:
        raw_gvas, _ = decompress_sav_to_gvas(level_path.read_bytes())
        header = GvasHeader.read(FArchiveReader(raw_gvas)).dump()
    except Exception as error:
        raise ValueError(
            f"无法从 Level.sav 创建 WorldOption.sav: {type(error).__name__}: {error}"
        ) from error
    header["save_game_class_name"] = WORLD_OPTION_CLASS
    settings = non_default_properties_from_fields(fields)
    return (
        GvasFile.load(
            {
                "header": header,
                "properties": {
                    "Version": {"id": None, "value": 100, "type": "IntProperty"},
                    "Timestamp": {
                        "struct_type": "DateTime",
                        "struct_id": ZERO_UUID,
                        "id": None,
                        "value": UNIX_EPOCH_TICKS + time.time_ns() // 100,
                        "type": "StructProperty",
                    },
                    "OptionWorldData": {
                        "struct_type": "PalOptionWorldSaveData",
                        "struct_id": ZERO_UUID,
                        "id": None,
                        "value": {
                            "Settings": {
                                "struct_type": "PalOptionWorldSettings",
                                "struct_id": ZERO_UUID,
                                "id": None,
                                "value": settings,
                                "type": "StructProperty",
                            }
                        },
                        "type": "StructProperty",
                    },
                },
                "trailer": "AAAAAA==",
            }
        ),
        0x31,
    )


def update_world_option(gvas: GvasFile, fields: dict[str, str]) -> None:
    settings = _settings(gvas)
    for key, value in fields.items():
        if key not in WORLD_OPTION_KEYS:
            continue
        if is_default_world_option_value(key, value):
            settings.pop(key, None)
        else:
            settings[key] = property_from_field(key, value)


def serialize_world_option(gvas: GvasFile, save_type: int) -> bytes:
    return cast(bytes, compress_gvas_to_sav(gvas.write(), save_type))


def properties_from_fields(fields: dict[str, str]) -> dict[str, dict[str, Any]]:
    return {
        key: property_from_field(key, value)
        for key, value in fields.items()
        if key in WORLD_OPTION_KEYS
    }


def non_default_properties_from_fields(
    fields: dict[str, str],
) -> dict[str, dict[str, Any]]:
    return {
        key: property_from_field(key, value)
        for key, value in fields.items()
        if key in WORLD_OPTION_KEYS and not is_default_world_option_value(key, value)
    }


def default_world_option_fields() -> dict[str, str]:
    return fields_from_settings(properties_from_fields(WORLD_OPTION_DEFAULTS))


def is_default_world_option_value(key: str, value: str) -> bool:
    return property_from_field(key, value) == property_from_field(
        key, WORLD_OPTION_DEFAULTS[key]
    )


def property_from_field(key: str, value: str) -> dict[str, Any]:
    if key in WORLD_OPTION_BOOLS:
        typed: Any = value.casefold() == "true"
        kind = "BoolProperty"
    elif key in WORLD_OPTION_INTS:
        number = Decimal(value)
        if number != number.to_integral_value():
            raise ValueError(f"WorldOption.sav 字段 {key} 必须是整数")
        typed = int(number)
        kind = "IntProperty"
    elif key in WORLD_OPTION_FLOATS:
        typed = float(Decimal(value))
        kind = "FloatProperty"
    elif key in WORLD_OPTION_STRINGS:
        typed = _text_value(value)
        kind = "StrProperty"
    elif key in WORLD_OPTION_ENUMS:
        enum_type = WORLD_OPTION_ENUMS[key]
        typed = {"type": enum_type, "value": f"{enum_type}::{_text_value(value)}"}
        kind = "EnumProperty"
    elif key in WORLD_OPTION_ENUM_ARRAYS:
        enum_type = WORLD_OPTION_ENUM_ARRAYS[key]
        values = [
            f"{enum_type}::{item}"
            for item in value.strip().removeprefix("(").removesuffix(")").split(",")
            if item
        ]
        return {
            "id": None,
            "array_type": "EnumProperty",
            "value": {"values": values},
            "type": "ArrayProperty",
        }
    else:
        raise ValueError(f"WorldOption.sav 不支持字段 {key}")
    return {"id": None, "value": typed, "type": kind}


def fields_from_settings(settings: dict[str, dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for key, prop in settings.items():
        if key not in WORLD_OPTION_KEYS or not isinstance(prop, dict):
            continue
        value = prop.get("value")
        if key in WORLD_OPTION_STRINGS:
            result[key] = json.dumps(str(value or ""), ensure_ascii=False)
        elif key in WORLD_OPTION_BOOLS:
            result[key] = "True" if value else "False"
        elif key in WORLD_OPTION_ENUMS and isinstance(value, dict):
            result[key] = str(value.get("value", "")).rsplit("::", 1)[-1]
        elif key in WORLD_OPTION_ENUM_ARRAYS and isinstance(value, dict):
            entries = value.get("values", [])
            result[key] = "(" + ",".join(
                (
                    str(item.get("value", ""))
                    if isinstance(item, dict)
                    else str(item)
                ).rsplit("::", 1)[-1]
                for item in entries
            ) + ")"
        elif key in WORLD_OPTION_INTS:
            result[key] = str(int(cast(int | float, value)))
        elif key in WORLD_OPTION_FLOATS:
            result[key] = format(float(cast(int | float, value)), ".15g")
    return result


def _settings(gvas: GvasFile) -> dict[str, dict[str, Any]]:
    return cast(
        dict[str, dict[str, Any]],
        gvas.properties["OptionWorldData"]["value"]["Settings"]["value"],
    )


def _text_value(value: str) -> str:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return value
    return parsed if isinstance(parsed, str) else value
