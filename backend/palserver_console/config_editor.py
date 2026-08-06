from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .persistence import Database

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
_OPTION_RE = re.compile(
    r"(?m)^(?P<prefix>\s*OptionSettings\s*=\s*)(?P<value>.*?)(?P<newline>\r?\n|$)"
)


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


def _split_values(value: str) -> list[str]:
    text = value.strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    parts: list[str] = []
    start = 0
    quote = False
    depth = 0
    for index, char in enumerate(text):
        if char == '"' and (index == 0 or text[index - 1] != "\\"):
            quote = not quote
        elif not quote:
            if char == "(":
                depth += 1
            elif char == ")":
                depth = max(0, depth - 1)
            elif char == "," and depth == 0:
                parts.append(text[start:index].strip())
                start = index + 1
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def _parse_document(raw: str) -> tuple[dict[str, str], list[str], str | None]:
    match = _OPTION_RE.search(raw)
    if match:
        option_text = match.group("value").strip()
        fields: dict[str, str] = {}
        order: list[str] = []
        for item in _split_values(option_text):
            if "=" not in item:
                continue
            key, value = item.split("=", 1)
            key = key.strip()
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
        if key and key not in fields:
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
    ) -> None:
        self.database = database
        self.data_dir = data_dir
        self.executable_getter = executable_getter
        self.running = running

    def path(self) -> Path:
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
        return path

    def _read(
        self, path: Path | None = None
    ) -> tuple[Path, str, FileVersion, dict[str, str], list[str]]:
        target = path or self.path()
        raw = target.read_text(encoding="utf-8-sig")
        version = _version(target)
        fields, order, _ = _parse_document(raw)
        return target, raw, version, fields, order

    def current(self) -> dict[str, object]:
        path, raw, version, fields, order = self._read()
        result = self._payload(path, raw, version, fields, order, draft=False)
        result["worldOptionPresent"] = self._world_option_present()
        return result

    def draft(self) -> dict[str, object]:
        current = self.current()
        row = self.database.get_config_draft()
        if row is None:
            current["draft"] = None
            return current
        draft_path = Path(str(row["draft_path"]))
        if not draft_path.is_file():
            current["draft"] = None
            return current
        _, raw, version, fields, order = self._read(draft_path)
        draft_payload = self._payload(draft_path, raw, version, fields, order, draft=True)
        draft_payload["state"] = row["state"]
        draft_payload["conflict"] = (
            json.loads(str(row["conflict_json"])) if row["conflict_json"] else None
        )
        current["draft"] = draft_payload
        return current

    def save_draft(self, fields: dict[str, str]) -> dict[str, object]:
        target, raw, source, original, order = self._read()
        if any(key in SECRET_FIELDS for key in fields):
            raise ConfigError(
                "SECRET_FIELD_FORBIDDEN", "AdminPassword 只能显示配置状态，不能查看或修改。"
            )
        merged = dict(original)
        merged.update({str(key): str(value) for key, value in fields.items()})
        pending = self.data_dir / "pending" / "PalWorldSettings.ini"
        pending.parent.mkdir(parents=True, exist_ok=True)
        pending.write_text(_replace_option(raw, merged, order), encoding="utf-8", newline="")
        self.database.save_config_draft(str(pending), source.sha256, source.mtime_ns, "draft", None)
        return self.draft()

    def diff(self) -> dict[str, object]:
        current = self.current()
        draft = cast(dict[str, object] | None, self.draft().get("draft"))
        if not draft:
            return {"hasDraft": False, "conflict": None, "text": "", "fields": []}
        current_raw = str(current["rawText"])
        draft_raw = str(draft["rawText"])
        row = self.database.get_config_draft()
        conflict = self._conflict(row)
        return {
            "hasDraft": True,
            "conflict": conflict,
            "text": "".join(
                difflib.unified_diff(
                    current_raw.splitlines(True),
                    draft_raw.splitlines(True),
                    fromfile="当前",
                    tofile="草稿",
                )
            ),
            "fields": self._field_diff(current["fields"], draft["fields"]),
        }

    def apply(self, *, force: bool = False) -> dict[str, object]:
        if self.running():
            raise ConfigError(
                "SERVER_RUNNING", "PalServer 运行中不能写入真实 INI，请先停止服务器。"
            )
        target, raw, source, _, _ = self._read()
        row = self.database.get_config_draft()
        if row is None:
            raise ConfigError("CONFIG_DRAFT_NOT_FOUND", "没有待应用配置草稿。")
        conflict = self._conflict(row)
        if conflict and not force:
            self.database.update_config_draft_state(
                "conflict", json.dumps(conflict, ensure_ascii=False)
            )
            raise ConfigError(
                "CONFIG_CONFLICT", "检测到 PalWorldSettings.ini 已被外部修改，请先查看差异。"
            )
        draft_path = Path(str(row["draft_path"]))
        draft_raw = draft_path.read_text(encoding="utf-8-sig")
        backup = target.with_name(f"{target.name}.{time.strftime('%Y%m%d-%H%M%S')}.bak")
        shutil.copy2(target, backup)
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        try:
            temp.write_text(draft_raw, encoding="utf-8", newline="")
            os.replace(temp, target)
        except OSError as error:
            if temp.exists():
                temp.unlink()
            raise ConfigError(
                "CONFIG_WRITE_FAILED", f"写入 PalWorldSettings.ini 失败: {error}"
            ) from error
        self.database.clear_config_draft()
        self.database.set_setting("config.last_backup", str(backup))
        return {"message": "PalWorldSettings.ini 已原子替换。", "backupPath": str(backup)}

    def apply_pending_if_safe(self) -> None:
        if self.database.get_config_draft() is None or self.running():
            return
        try:
            self.apply()
        except ConfigError:
            return

    def _world_option_present(self) -> bool:
        executable = self.executable_getter()
        if executable is None:
            return False
        root = executable.parent / "Pal" / "Saved" / "SaveGames" / "0"
        try:
            return any(
                (world / "WorldOption.sav").is_file() for world in root.iterdir() if world.is_dir()
            )
        except OSError:
            return False

    def _conflict(self, row: dict[str, object] | None) -> dict[str, object] | None:
        if row is None:
            return None
        try:
            current = _version(self.path())
        except ConfigError:
            return {"reason": "CONFIG_NOT_FOUND"}
        if current.sha256 != str(row["source_hash"]) or current.mtime_ns != int(
            cast(int, row["source_mtime_ns"])
        ):
            return {
                "reason": "SOURCE_CHANGED",
                "expectedHash": row["source_hash"],
                "actualHash": current.sha256,
                "expectedMtimeNs": row["source_mtime_ns"],
                "actualMtimeNs": current.mtime_ns,
            }
        return None

    @staticmethod
    def _field_diff(current: object, draft: object) -> list[dict[str, str]]:
        a = current if isinstance(current, dict) else {}
        b = draft if isinstance(draft, dict) else {}
        return [
            {"key": key, "current": str(a.get(key, "")), "draft": str(b.get(key, ""))}
            for key in sorted(set(a) | set(b))
            if a.get(key) != b.get(key)
        ]

    @staticmethod
    def _payload(
        path: Path,
        raw: str,
        version: FileVersion,
        fields: dict[str, str],
        order: list[str],
        *,
        draft: bool,
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
            "isDraft": draft,
        }
