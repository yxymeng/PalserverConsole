from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast

from .config import ProfileError, ServerProfile
from .control import ControlLock, create_control_lock
from .persistence import Database
from .steam import assert_no_reparse_points, validate_executable
from .world_option import (
    WORLD_OPTION_KEYS,
    create_world_option,
    default_world_option_fields,
    read_world_option,
    serialize_world_option,
    update_world_option,
)

SCHEMA_SOURCE = (
    "Palworld official configuration guide (checked 2026-08-06) + Bluefissure/pal-conf main"
)

# Keep the upstream field order. New fields are still preserved as unknown fields.
SCHEMA_FIELDS: tuple[str, ...] = (
    "ServerName",
    "ServerDescription",
    "AdminPassword",
    "ServerPassword",
    "PublicIP",
    "PublicPort",
    "ServerPlayerMaxNum",
    "bIsUseBackupSaveData",
    "AutoSaveSpan",
    "CrossplayPlatforms",
    "LogFormatType",
    "RandomizerType",
    "RandomizerSeed",
    "bIsRandomizerPalLevelRandom",
    "bEnableVoiceChat",
    "VoiceChatMaxVolumeDistance",
    "VoiceChatZeroVolumeDistance",
    "DayTimeSpeedRate",
    "NightTimeSpeedRate",
    "ExpRate",
    "PalCaptureRate",
    "PalSpawnNumRate",
    "PalDamageRateAttack",
    "PalDamageRateDefense",
    "PalStomachDecreaceRate",
    "PalStaminaDecreaceRate",
    "PalAutoHPRegeneRate",
    "PalAutoHpRegeneRateInSleep",
    "PlayerDamageRateAttack",
    "PlayerDamageRateDefense",
    "PlayerStomachDecreaceRate",
    "PlayerStaminaDecreaceRate",
    "PlayerAutoHPRegeneRate",
    "PlayerAutoHpRegeneRateInSleep",
    "BuildObjectHpRate",
    "BuildObjectDamageRate",
    "BuildObjectDeteriorationDamageRate",
    "DropItemMaxNum",
    "ItemWeightRate",
    "CollectionDropRate",
    "CollectionObjectHpRate",
    "CollectionObjectRespawnSpeedRate",
    "EnemyDropItemRate",
    "PalEggDefaultHatchingTime",
    "bEnableInvaderEnemy",
    "EnablePredatorBossPal",
    "DeathPenalty",
    "GuildPlayerMaxNum",
    "BaseCampMaxNumInGuild",
    "BaseCampWorkerMaxNum",
    "MaxBuildingLimitNum",
    "SupplyDropSpan",
    "ChatPostLimitPerMinute",
    "EquipmentDurabilityDamageRate",
    "ItemContainerForceMarkDirtyInterval",
    "ItemCorruptionMultiplier",
    "PhysicsActiveDropItemMaxNum",
    "MonsterFarmActionSpeedRate",
    "bEnablePlayerToPlayerDamage",
    "bEnableFriendlyFire",
    "bActiveUNKO",
    "bEnableAimAssistPad",
    "bEnableAimAssistKeyboard",
    "DropItemMaxNum_UNKO",
    "BaseCampMaxNum",
    "DropItemAliveMaxHours",
    "bAutoResetGuildNoOnlinePlayers",
    "AutoResetGuildTimeNoOnlinePlayers",
    "WorkSpeedRate",
    "bIsMultiplay",
    "bIsPvP",
    "bHardcore",
    "bPalLost",
    "bCharacterRecreateInHardcore",
    "bCanPickupOtherGuildDeathPenaltyDrop",
    "bEnableNonLoginPenalty",
    "bEnableFastTravel",
    "bEnableFastTravelOnlyBaseCamp",
    "bIsStartLocationSelectByMap",
    "bExistPlayerAfterLogout",
    "bEnableDefenseOtherGuildPlayer",
    "bInvisibleOtherGuildBaseCampAreaFX",
    "bBuildAreaLimit",
    "ServerReplicatePawnCullDistance",
    "bShowPlayerList",
    "bAllowGlobalPalboxExport",
    "bAllowGlobalPalboxImport",
    "RCONEnabled",
    "RCONPort",
    "RESTAPIEnabled",
    "RESTAPIPort",
    "Region",
    "bUseAuth",
    "BanListURL",
    "bAllowClientMod",
    "bIsShowJoinLeftMessage",
    "DenyTechnologyList",
    "GuildRejoinCooldownMinutes",
    "BlockRespawnTime",
    "RespawnPenaltyDurationThreshold",
    "RespawnPenaltyTimeScale",
    "bDisplayPvPItemNumOnWorldMap_BaseCamp",
    "bDisplayPvPItemNumOnWorldMap_Player",
    "AdditionalDropItemWhenPlayerKillingInPvPMode",
    "AdditionalDropItemNumWhenPlayerKillingInPvPMode",
    "bAdditionalDropItemWhenPlayerKillingInPvPMode",
    "bAllowEnhanceStat_Health",
    "bAllowEnhanceStat_Attack",
    "bAllowEnhanceStat_Stamina",
    "bAllowEnhanceStat_Weight",
    "bAllowEnhanceStat_WorkSpeed",
    "PlayerDataPalStorageUpdateCheckTickInterval",
    "AutoTransferMasterCheckIntervalSeconds",
    "AutoTransferMasterThresholdDays",
    "MaxGuildsPerFrame",
    "bEnableBuildingPlayerUIdDisplay",
    "BuildingNameDisplayCacheTTLSeconds",
)
SECRET_FIELDS = frozenset({"AdminPassword"})
MASKED_SECRET_VALUES = frozenset({"已配置", "未配置"})
MAX_CONFIG_SAVE_BYTES = 64 * 1024
MAX_CONFIG_SAVE_FIELDS = 128
MAX_CONFIG_FIELD_KEY_LENGTH = 128
MAX_CONFIG_FIELD_VALUE_LENGTH = 4096
_FIELD_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_OPTION_RE = re.compile(
    r"(?m)^(?P<prefix>\s*OptionSettings\s*=\s*)(?P<value>.*?)(?P<newline>\r?\n|$)"
)

BOOL_FIELDS = frozenset(
    {
        "bIsUseBackupSaveData",
        "bIsRandomizerPalLevelRandom",
        "bEnableVoiceChat",
        "bEnableInvaderEnemy",
        "EnablePredatorBossPal",
        "bEnablePlayerToPlayerDamage",
        "bEnableFriendlyFire",
        "bActiveUNKO",
        "bEnableAimAssistPad",
        "bEnableAimAssistKeyboard",
        "bAutoResetGuildNoOnlinePlayers",
        "bIsMultiplay",
        "bIsPvP",
        "bHardcore",
        "bPalLost",
        "bCharacterRecreateInHardcore",
        "bCanPickupOtherGuildDeathPenaltyDrop",
        "bEnableNonLoginPenalty",
        "bEnableFastTravel",
        "bEnableFastTravelOnlyBaseCamp",
        "bIsStartLocationSelectByMap",
        "bExistPlayerAfterLogout",
        "bEnableDefenseOtherGuildPlayer",
        "bInvisibleOtherGuildBaseCampAreaFX",
        "bBuildAreaLimit",
        "bShowPlayerList",
        "bAllowGlobalPalboxExport",
        "bAllowGlobalPalboxImport",
        "RCONEnabled",
        "RESTAPIEnabled",
        "bUseAuth",
        "bAllowClientMod",
        "bIsShowJoinLeftMessage",
        "bDisplayPvPItemNumOnWorldMap_BaseCamp",
        "bDisplayPvPItemNumOnWorldMap_Player",
        "bAdditionalDropItemWhenPlayerKillingInPvPMode",
        "bAllowEnhanceStat_Health",
        "bAllowEnhanceStat_Attack",
        "bAllowEnhanceStat_Stamina",
        "bAllowEnhanceStat_Weight",
        "bAllowEnhanceStat_WorkSpeed",
        "bEnableBuildingPlayerUIdDisplay",
    }
)
TEXT_FIELDS = frozenset(
    {
        "ServerName",
        "ServerDescription",
        "ServerPassword",
        "PublicIP",
        "LogFormatType",
        "RandomizerType",
        "RandomizerSeed",
        "DeathPenalty",
        "Region",
        "BanListURL",
        "DenyTechnologyList",
        "AdditionalDropItemWhenPlayerKillingInPvPMode",
    }
)
TUPLE_FIELDS = frozenset({"CrossplayPlatforms"})
SCHEMA_FIELD_SET = frozenset(SCHEMA_FIELDS)


class ConfigError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class FileVersion:
    sha256: str
    mtime_ns: int
    size: int


def _version(path: Path) -> FileVersion:
    try:
        stat = path.stat()
        return FileVersion(
            hashlib.sha256(path.read_bytes()).hexdigest(), stat.st_mtime_ns, stat.st_size
        )
    except OSError as error:
        raise ConfigError("CONFIG_NOT_FOUND", f"无法读取 PalWorldSettings.ini: {error}") from error


def _is_escaped(text: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and text[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return bool(backslashes % 2)


def _split_values(value: str) -> list[str]:
    text = value.strip()
    if text.startswith("(") != text.endswith(")"):
        raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 括号不完整。")
    if text.startswith("("):
        text = text[1:-1]
    if not text:
        return []
    parts: list[str] = []
    start = 0
    quote = False
    depth = 0
    for index, char in enumerate(text):
        if char == '"' and not _is_escaped(text, index):
            quote = not quote
        elif not quote:
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
                if depth < 0:
                    raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 括号不匹配。")
            elif char == "," and depth == 0:
                item = text[start:index].strip()
                if not item:
                    raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 包含空字段。")
                parts.append(item)
                start = index + 1
    if quote or depth:
        raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 引号或括号不匹配。")
    tail = text[start:].strip()
    if not tail:
        raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 包含空字段。")
    parts.append(tail)
    return parts


def _validate_field_key(key: str, *, source: bool = False) -> None:
    if len(key) > MAX_CONFIG_FIELD_KEY_LENGTH or not _FIELD_KEY_RE.fullmatch(key):
        code = "CONFIG_PARSE_ERROR" if source else "CONFIG_INVALID_FIELD_KEY"
        raise ConfigError(code, "配置字段名只能包含字母、数字和下划线，且必须以字母开头。")


def _parse_document(raw: str) -> tuple[dict[str, str], list[str], str | None]:
    match = _OPTION_RE.search(raw)
    if match:
        option_text = match.group("value").strip()
        fields: dict[str, str] = {}
        order: list[str] = []
        for item in _split_values(option_text):
            if "=" not in item:
                raise ConfigError("CONFIG_PARSE_ERROR", "OptionSettings 字段缺少等号。")
            key, value = item.split("=", 1)
            key = key.strip()
            _validate_field_key(key, source=True)
            if key in fields:
                raise ConfigError("CONFIG_DUPLICATE_KEY", f"OptionSettings 包含重复字段: {key}")
            fields[key] = value.strip()
            order.append(key)
        return fields, order, match.group(0)
    fields = {}
    order = []
    for line in raw.splitlines():
        if "=" not in line or line.lstrip().startswith(("#", ";", "[")):
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        _validate_field_key(key, source=True)
        if key in fields:
            raise ConfigError("CONFIG_DUPLICATE_KEY", f"配置文件包含重复字段: {key}")
        fields[key] = value.strip()
        order.append(key)
    return fields, order, None


def _render_values(fields: dict[str, str], order: list[str]) -> str:
    keys = list(order)
    keys.extend(key for key in fields if key not in keys)
    return "(" + ",".join(f"{key}={fields[key]}" for key in keys if key in fields) + ")"


def _replace_option(raw: str, fields: dict[str, str], order: list[str]) -> str:
    match = _OPTION_RE.search(raw)
    if match:
        replacement = (
            f"{match.group('prefix')}{_render_values(fields, order)}{match.group('newline')}"
        )
        return raw[: match.start()] + replacement + raw[match.end() :]
    lines = raw.splitlines(keepends=True)
    return "".join(lines) + "OptionSettings=" + _render_values(fields, order) + "\n"


def _ordered_keys(fields: dict[str, str], order: list[str]) -> list[str]:
    return [*order, *(key for key in fields if key not in order)]


def _render_verified(raw: str, fields: dict[str, str], order: list[str]) -> str:
    rendered = _replace_option(raw, fields, order)
    parsed_fields, parsed_order, _ = _parse_document(rendered)
    if parsed_fields != fields or parsed_order != _ordered_keys(fields, order):
        raise ConfigError("CONFIG_SERIALIZATION_FAILED", "配置序列化后的内容与保存内容不一致。")
    return rendered


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError("CONFIG_DUPLICATE_KEY", f"请求包含重复字段: {key}")
        result[key] = value
    return result


def parse_config_request(body: bytes) -> dict[str, str]:
    if len(body) > MAX_CONFIG_SAVE_BYTES:
        raise ConfigError("CONFIG_REQUEST_TOO_LARGE", "配置保存请求超过大小限制。")
    try:
        payload = json.loads(body.decode("utf-8"), object_pairs_hook=_reject_duplicate_json_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ConfigError(
            "CONFIG_INVALID_REQUEST", "配置保存请求必须是有效的 UTF-8 JSON 对象。"
        ) from error
    if not isinstance(payload, dict) or set(payload) != {"fields"}:
        raise ConfigError("CONFIG_INVALID_REQUEST", "配置保存请求只能包含 fields 对象。")
    fields = payload["fields"]
    if not isinstance(fields, dict):
        raise ConfigError("CONFIG_INVALID_REQUEST", "fields 必须是对象。")
    if len(fields) > MAX_CONFIG_SAVE_FIELDS:
        raise ConfigError("CONFIG_REQUEST_TOO_LARGE", "配置字段数量超过限制。")
    if not all(isinstance(key, str) and isinstance(value, str) for key, value in fields.items()):
        raise ConfigError("CONFIG_INVALID_REQUEST", "配置字段和值必须是字符串。")
    return cast(dict[str, str], fields)


def _invalid_value(key: str) -> ConfigError:
    return ConfigError("CONFIG_INVALID_FIELD_VALUE", f"配置字段 {key} 的值格式不合法。")


def _normalise_bool(key: str, value: str) -> str:
    normalized = value.strip().casefold()
    if normalized == "true":
        return "True"
    if normalized == "false":
        return "False"
    raise _invalid_value(key)


def _normalise_number(key: str, value: str, *, integer: bool) -> str:
    text = value.strip()
    if not text or not re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", text):
        raise _invalid_value(key)
    if integer:
        if "." in text:
            raise _invalid_value(key)
        return str(int(text))
    try:
        normalized = format(Decimal(text).normalize(), "f")
    except InvalidOperation as error:
        raise _invalid_value(key) from error
    return "0" if normalized in {"-0", ""} else normalized


def _normalise_text(key: str, value: str) -> str:
    if any(char in value for char in "\r\n\x00"):
        raise _invalid_value(key)
    candidate = value.strip()
    if candidate.startswith('"') or candidate.endswith('"'):
        try:
            text = json.loads(candidate)
        except json.JSONDecodeError as error:
            raise _invalid_value(key) from error
        if not isinstance(text, str):
            raise _invalid_value(key)
    else:
        text = value
    if any(ord(char) < 0x20 for char in text):
        raise _invalid_value(key)
    return json.dumps(text, ensure_ascii=False)


def _text_value_configured(value: str) -> bool:
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return bool(value)
    return bool(decoded) if isinstance(decoded, str) else bool(value)


def _normalise_tuple(key: str, value: str) -> str:
    if any(char in value for char in "\r\n\x00"):
        raise _invalid_value(key)
    candidate = value.strip()
    if candidate.startswith('"') or candidate.endswith('"'):
        try:
            decoded = json.loads(candidate)
        except json.JSONDecodeError as error:
            raise _invalid_value(key) from error
        if not isinstance(decoded, str):
            raise _invalid_value(key)
        candidate = decoded.strip()
    if candidate.startswith("(") != candidate.endswith(")"):
        raise _invalid_value(key)
    source = candidate if candidate.startswith("(") else f"({candidate})"
    try:
        items = _split_values(source)
    except ConfigError as error:
        raise _invalid_value(key) from error
    normalized_items: list[str] = []
    for item in items:
        token = item.strip()
        if token.startswith('"') or token.endswith('"'):
            try:
                decoded = json.loads(token)
            except json.JSONDecodeError as error:
                raise _invalid_value(key) from error
            if not isinstance(decoded, str):
                raise _invalid_value(key)
            token = decoded
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", token):
            raise _invalid_value(key)
        normalized_items.append(token)
    return "(" + ",".join(normalized_items) + ")"


def _normalise_unknown_value(key: str, value: str, source_value: str) -> str:
    source = source_value.strip()
    if source.startswith('"') or source.endswith('"'):
        return _normalise_text(key, value)
    if source.casefold() in {"true", "false"}:
        return _normalise_bool(key, value)
    if re.fullmatch(r"[+-]?\d+", source):
        return _normalise_number(key, value, integer=True)
    if re.fullmatch(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)", source):
        return _normalise_number(key, value, integer=False)
    if source.startswith("("):
        candidate = value.strip()
        if any(char in candidate for char in "\r\n\x00"):
            raise _invalid_value(key)
        if not candidate.startswith("(") or not candidate.endswith(")"):
            raise _invalid_value(key)
        _split_values(candidate)
        return candidate
    candidate = value.strip()
    if not candidate or any(char in candidate for char in ',()="\r\n\x00'):
        raise _invalid_value(key)
    return candidate


def _normalise_schema_value(key: str, value: str) -> str:
    if key in BOOL_FIELDS:
        return _normalise_bool(key, value)
    if key in TUPLE_FIELDS:
        return _normalise_tuple(key, value)
    if key in TEXT_FIELDS:
        return _normalise_text(key, value)
    return _normalise_number(key, value, integer=False)


def _normalise_admin_password(value: str) -> str:
    return _normalise_text("AdminPassword", value)


def _masked_fields(fields: dict[str, str]) -> dict[str, str]:
    return {
        key: ("已配置" if key in SECRET_FIELDS and value else "未配置")
        if key in SECRET_FIELDS
        else value
        for key, value in fields.items()
    }


def _masked_raw_text(raw: str, fields: dict[str, str], order: list[str]) -> str:
    masked = dict(fields)
    for key in SECRET_FIELDS:
        if key in masked:
            masked[key] = "<已隐藏>"
    if _OPTION_RE.search(raw):
        return _replace_option(raw, masked, order)
    return re.sub(
        r"(?m)^(?P<prefix>\s*AdminPassword\s*=)[^\r\n]*(?P<newline>\r?$)",
        r"\g<prefix><已隐藏>\g<newline>",
        raw,
    )


class ConfigService:
    def __init__(
        self,
        database: Database,
        data_dir: Path,
        executable_getter: Callable[[], Path | None],
        running: Callable[[], bool],
        profile_provider: Callable[[], ServerProfile] | None = None,
        control_lock: ControlLock | None = None,
        admin_password_rotation_callback: Callable[[], None] | None = None,
    ) -> None:
        self.database = database
        self.data_dir = data_dir
        self.executable_getter = executable_getter
        self.running = running
        self.profile_provider = profile_provider
        self.control_lock = control_lock or create_control_lock()
        self.admin_password_rotation_callback = admin_password_rotation_callback

    def path(self) -> Path:
        if self.profile_provider is not None:
            try:
                install = self.profile_provider().install_path
            except ProfileError as error:
                raise ConfigError(error.code, str(error)) from error
            path = (
                install
                / "Pal"
                / "Saved"
                / "Config"
                / "WindowsServer"
                / "PalWorldSettings.ini"
            )
            self._assert_path_safe(path)
            return path
        executable = self.executable_getter()
        if executable is None:
            raise ConfigError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        path = (
            executable.parent
            / "Pal"
            / "Saved"
            / "Config"
            / "WindowsServer"
            / "PalWorldSettings.ini"
        )
        self._assert_path_safe(path)
        return path

    def folder_path(self) -> Path:
        try:
            return self.path().parent
        except ConfigError as error:
            if error.code != "WORLD_PROFILE_REQUIRED":
                raise
        executable = self.executable_getter()
        if executable is None:
            raise ConfigError("SERVER_NOT_CONFIGURED", "PalServer.exe has not been selected.")
        try:
            validated = validate_executable(executable)
        except (OSError, ValueError) as error:
            raise ConfigError("INVALID_SERVER_PATH", str(error)) from error
        folder = validated.parent / "Pal" / "Saved" / "Config" / "WindowsServer"
        self._assert_path_safe(folder)
        return folder

    def world_option_folder_path(self) -> Path:
        path = self._world_option_path(required=True)
        assert path is not None
        return path.parent

    def _read(
        self, path: Path | None = None
    ) -> tuple[Path, str, FileVersion, dict[str, str], list[str]]:
        target = path or self.path()
        try:
            raw = target.read_text(encoding="utf-8-sig")
        except OSError as error:
            raise ConfigError(
                "CONFIG_NOT_FOUND", f"无法读取 PalWorldSettings.ini: {error}"
            ) from error
        version = _version(target)
        fields, order, _ = _parse_document(raw)
        return target, raw, version, fields, order

    def current(self) -> dict[str, object]:
        path, raw, version, fields, order = self._read()
        result = self._payload(path, raw, version, fields, order)
        world_option_path = self._world_option_path()
        world_option_present = bool(world_option_path and world_option_path.is_file())
        result["worldOptionPath"] = str(world_option_path) if world_option_path else None
        result["worldOptionPresent"] = world_option_present
        result["effectiveSource"] = "world-option" if world_option_present else "ini"
        result["worldOptionSchema"] = [
            key for key in ("Difficulty", *SCHEMA_FIELDS) if key in WORLD_OPTION_KEYS
        ]
        if world_option_present and world_option_path is not None:
            try:
                _, _, saved_world_fields = read_world_option(world_option_path)
            except ValueError as error:
                raise ConfigError("WORLD_OPTION_READ_FAILED", str(error)) from error
            world_fields = default_world_option_fields()
            world_fields.update(saved_world_fields)
        else:
            world_fields = {
                key: value for key, value in fields.items() if key in WORLD_OPTION_KEYS
            }
            world_fields.setdefault("Difficulty", "None")
        world_password = world_fields.get("AdminPassword", "")
        world_password_configured = _text_value_configured(world_password)
        if "AdminPassword" in world_fields:
            world_fields["AdminPassword"] = (
                "已配置" if world_password_configured else "未配置"
            )
        result["worldOptionFields"] = world_fields
        result["worldOptionAdminPasswordConfigured"] = world_password_configured
        row = self.database.get_config_draft()
        pending_path = Path(str(row["draft_path"])) if row else None
        pending_state = str(row["state"]) if row else ""
        result["pendingApply"] = (
            {
                "kind": "world-option" if pending_state == "pending-world-option" else "ini",
                "updatedAt": row["updated_at"],
            }
            if row
            and pending_state in {"pending-ini", "pending-world-option"}
            and pending_path
            and pending_path.is_file()
            else None
        )
        return result

    def save_ini(self, fields: dict[str, str]) -> dict[str, object]:
        with self.control_lock:
            target, target_raw, source, target_fields, target_order = self._read()
            pending = self.data_dir / "pending" / "PalWorldSettings.ini"
            row = self.database.get_config_draft()
            if row and row["state"] == "pending-ini" and pending.is_file():
                _, raw, _, original, order = self._read(pending)
            else:
                self._clear_pending_file(row)
                raw, original, order = target_raw, target_fields, target_order
            merged = dict(original)
            merged.update(self._validate_updates(fields, original))
            pending.parent.mkdir(parents=True, exist_ok=True)
            pending.write_text(
                _render_verified(raw, merged, order), encoding="utf-8", newline=""
            )
            self.database.save_config_draft(
                str(pending), source.sha256, source.mtime_ns, "pending-ini", None
            )
            if self.running():
                return {
                    "message": "配置已保存，PalServer 关闭、重启或下次启动时会自动应用。",
                    "pending": True,
                    "serverRunning": True,
                }
            result = self._apply_pending_exclusive()
            result.update({"pending": False, "serverRunning": False, "path": str(target)})
            return result

    def save_world_option(self, fields: dict[str, str]) -> dict[str, object]:
        with self.control_lock:
            target = self._world_option_path(required=True)
            assert target is not None
            self._assert_path_safe(target)
            if not target.parent.is_dir():
                raise ConfigError("WORLD_PATH_UNAVAILABLE", "当前世界存档目录不存在。")

            _, _, _, ini_fields, _ = self._read()
            pending = self.data_dir / "pending" / "WorldOption.sav"
            row = self.database.get_config_draft()
            if row and row["state"] != "pending-world-option":
                self._clear_pending_file(row)
            source = (
                pending
                if row and row["state"] == "pending-world-option" and pending.is_file()
                else target
            )
            if source.is_file():
                try:
                    gvas, save_type, original = read_world_option(source)
                except ValueError as error:
                    raise ConfigError("WORLD_OPTION_READ_FAILED", str(error)) from error
            else:
                self._clear_pending_file(row)
                original = {
                    "Difficulty": "None",
                    **{key: value for key, value in ini_fields.items() if key in WORLD_OPTION_KEYS},
                }
                try:
                    gvas, save_type = create_world_option(target.parent / "Level.sav", original)
                except ValueError as error:
                    raise ConfigError("WORLD_OPTION_CREATE_FAILED", str(error)) from error

            updates = self._validate_updates(fields, original)
            unsupported = set(updates) - WORLD_OPTION_KEYS
            if unsupported:
                key = sorted(unsupported)[0]
                raise ConfigError(
                    "WORLD_OPTION_UNSUPPORTED_FIELD", f"WorldOption.sav 不支持字段 {key}。"
                )
            try:
                update_world_option(gvas, updates)
                payload = serialize_world_option(gvas, save_type)
            except (OSError, ValueError, TypeError) as error:
                raise ConfigError(
                    "WORLD_OPTION_WRITE_FAILED", f"生成 WorldOption.sav 失败: {error}"
                ) from error
            pending.parent.mkdir(parents=True, exist_ok=True)
            pending.write_bytes(payload)
            self.database.save_config_draft(
                str(pending), "", 0, "pending-world-option", None
            )
            if self.running():
                return {
                    "message": "配置已保存，PalServer 关闭、重启或下次启动时会自动应用。",
                    "pending": True,
                    "serverRunning": True,
                }
            result = self._apply_pending_exclusive()
            result.update({"pending": False, "serverRunning": False, "path": str(target)})
            return result

    def apply_pending(self) -> dict[str, object]:
        with self.control_lock:
            return self._apply_pending_exclusive()

    def _apply_pending_exclusive(self) -> dict[str, object]:
        if self.running():
            raise ConfigError(
                "SERVER_RUNNING", "PalServer 运行中不能应用配置，请先停止服务器。"
            )
        row = self.database.get_config_draft()
        if row is None or row["state"] not in {"pending-ini", "pending-world-option"}:
            return {"message": "没有待应用配置。", "applied": False, "backupPath": None}
        pending = Path(str(row["draft_path"]))
        if row["state"] == "pending-world-option":
            return self._apply_pending_world_option(pending)
        return self._apply_pending_ini(pending)

    def _apply_pending_ini(self, pending: Path) -> dict[str, object]:
        target, _, _, original, _ = self._read()
        try:
            pending_raw = pending.read_text(encoding="utf-8-sig")
        except OSError as error:
            raise ConfigError("CONFIG_PENDING_NOT_FOUND", f"无法读取待应用配置: {error}") from error
        pending_fields, _, _ = _parse_document(pending_raw)
        admin_password_changed = self._admin_password_changed(original, pending_fields)
        backup = target.with_name(f"{target.name}.{time.strftime('%Y%m%d-%H%M%S')}.bak")
        self._assert_path_safe(target)
        self._assert_path_safe(backup)
        shutil.copy2(target, backup)
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        try:
            self._assert_path_safe(temp)
            temp.write_text(pending_raw, encoding="utf-8", newline="")
            self._assert_path_safe(target)
            self._assert_path_safe(temp)
            os.replace(temp, target)
        except OSError as error:
            if temp.exists():
                temp.unlink()
            raise ConfigError(
                "CONFIG_WRITE_FAILED", f"写入 PalWorldSettings.ini 失败: {error}"
            ) from error
        if _version(target).sha256 != hashlib.sha256(pending_raw.encode("utf-8")).hexdigest():
            raise ConfigError("CONFIG_VERIFY_FAILED", "PalWorldSettings.ini 写入后回读校验失败。")
        self.database.clear_config_draft()
        pending.unlink(missing_ok=True)
        self.database.set_setting("config.last_backup", str(backup))
        if admin_password_changed and self.admin_password_rotation_callback is not None:
            self.admin_password_rotation_callback()
        return {
            "message": "PalWorldSettings.ini 已保存并应用。",
            "applied": True,
            "kind": "ini",
            "backupPath": str(backup),
        }

    def _apply_pending_world_option(self, pending: Path) -> dict[str, object]:
        target = self._world_option_path(required=True)
        assert target is not None
        try:
            read_world_option(pending)
            payload = pending.read_bytes()
        except (OSError, ValueError) as error:
            raise ConfigError(
                "WORLD_OPTION_VERIFY_FAILED", f"待应用 WorldOption.sav 校验失败: {error}"
            ) from error
        backup: Path | None = None
        if target.is_file():
            backup = target.with_name(f"{target.name}.{time.strftime('%Y%m%d-%H%M%S')}.bak")
            self._assert_path_safe(backup)
            shutil.copy2(target, backup)
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        try:
            self._assert_path_safe(temp)
            temp.write_bytes(payload)
            self._assert_path_safe(target)
            os.replace(temp, target)
            if target.read_bytes() != payload:
                raise ValueError("WorldOption.sav 写入后内容与待应用文件不一致")
            read_world_option(target)
        except (OSError, ValueError) as error:
            if temp.exists():
                temp.unlink()
            raise ConfigError(
                "WORLD_OPTION_WRITE_FAILED", f"写入 WorldOption.sav 失败: {error}"
            ) from error
        self.database.clear_config_draft()
        pending.unlink(missing_ok=True)
        return {
            "message": "WorldOption.sav 已保存并应用。",
            "applied": True,
            "kind": "world-option",
            "backupPath": str(backup) if backup else None,
        }

    def _clear_pending_file(self, row: dict[str, object] | None) -> None:
        if row is None:
            return
        pending_root = (self.data_dir / "pending").resolve()
        path = Path(str(row["draft_path"])).resolve()
        if path.is_relative_to(pending_root):
            path.unlink(missing_ok=True)

    @staticmethod
    def _assert_path_safe(path: Path) -> None:
        try:
            assert_no_reparse_points(path)
        except ValueError as error:
            raise ConfigError("PATH_REPARSE_POINT", str(error)) from error

    @staticmethod
    def _admin_password_changed(original: dict[str, str], pending_fields: dict[str, str]) -> bool:
        current = original.get("AdminPassword")
        pending = pending_fields.get("AdminPassword")
        if current is None or pending is None:
            return current != pending
        try:
            return _normalise_admin_password(current) != _normalise_admin_password(pending)
        except ConfigError:
            return current != pending

    @staticmethod
    def _validate_updates(fields: dict[str, str], original: dict[str, str]) -> dict[str, str]:
        if len(fields) > MAX_CONFIG_SAVE_FIELDS:
            raise ConfigError("CONFIG_REQUEST_TOO_LARGE", "配置字段数量超过限制。")
        updates: dict[str, str] = {}
        for key, value in fields.items():
            if not isinstance(key, str) or not isinstance(value, str):
                raise ConfigError("CONFIG_INVALID_REQUEST", "配置字段和值必须是字符串。")
            _validate_field_key(key)
            if len(value) > MAX_CONFIG_FIELD_VALUE_LENGTH:
                raise ConfigError("CONFIG_REQUEST_TOO_LARGE", f"配置字段 {key} 的值超过长度限制。")
            if key in SECRET_FIELDS:
                if value in MASKED_SECRET_VALUES:
                    continue
                updates[key] = _normalise_admin_password(value)
                continue
            if key in SCHEMA_FIELD_SET:
                updates[key] = _normalise_schema_value(key, value)
                continue
            if key not in original:
                raise ConfigError("CONFIG_UNKNOWN_FIELD", f"未知配置字段不能新增: {key}")
            updates[key] = _normalise_unknown_value(key, value, original[key])
        return updates

    def _world_option_path(self, *, required: bool = False) -> Path | None:
        if self.profile_provider is not None:
            try:
                world = self.profile_provider().world_path
            except ProfileError as error:
                raise ConfigError(error.code, str(error)) from error
            path = world / "WorldOption.sav"
            self._assert_path_safe(path)
            return path
        if required:
            raise ConfigError(
                "WORLD_PROFILE_REQUIRED", "尚未选择当前世界，无法写入 WorldOption.sav。"
            )
        return None

    @staticmethod
    def _payload(
        path: Path,
        raw: str,
        version: FileVersion,
        fields: dict[str, str],
        order: list[str],
    ) -> dict[str, object]:
        masked = _masked_fields(fields)
        return {
            "path": str(path),
            "sourceHash": version.sha256,
            "sourceMtimeNs": version.mtime_ns,
            "size": version.size,
            "fields": masked,
            "unknownFields": {
                key: value for key, value in masked.items() if key not in SCHEMA_FIELDS
            },
            "schema": list(SCHEMA_FIELDS),
            "fieldOrder": order,
            "rawText": _masked_raw_text(raw, fields, order),
            "adminPasswordConfigured": bool(fields.get("AdminPassword")),
        }
