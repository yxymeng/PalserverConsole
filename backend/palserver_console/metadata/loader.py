"""Load and validate the immutable local world-metadata bundle."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from functools import lru_cache
from importlib.resources import files
from pathlib import Path
from typing import Any, Literal, TypedDict, cast

METADATA_SCHEMA_NAME = "palserver-console-world-metadata"
METADATA_SCHEMA_VERSION = 1
WORK_SUITABILITY_TYPES = frozenset(
    {
        "EmitFlame",
        "Watering",
        "Seeding",
        "GenerateElectricity",
        "Handcraft",
        "Collection",
        "Deforest",
        "Mining",
        "OilExtraction",
        "ProductMedicine",
        "Cool",
        "Transport",
        "MonsterFarm",
    }
)


class MetadataStatus(TypedDict):
    status: Literal["ready", "unavailable"]
    schema: str
    schemaVersion: int
    dataVersion: str | None
    sourceRevision: str | None
    errorCode: str | None


@dataclass(frozen=True)
class PalSpeciesMetadata:
    rarity: int
    work_suitabilities: dict[str, int]
    partner_skill: dict[str, object] | None


@dataclass(frozen=True)
class ItemMetadata:
    name: str | None
    category: str
    rarity: str


@dataclass(frozen=True)
class WorldMetadataBundle:
    data_version: str
    source_revision: str
    pals: dict[str, PalSpeciesMetadata]
    skills: dict[str, dict[str, object]]
    items: dict[str, ItemMetadata]
    player_progress_totals: dict[str, int]
    player_progress_totals_data_version: str
    _pals_casefold: dict[str, PalSpeciesMetadata] = field(repr=False)
    _skills_casefold: dict[str, dict[str, object]] = field(repr=False)
    _items_casefold: dict[str, ItemMetadata] = field(repr=False)

    @property
    def status(self) -> MetadataStatus:
        return {
            "status": "ready",
            "schema": METADATA_SCHEMA_NAME,
            "schemaVersion": METADATA_SCHEMA_VERSION,
            "dataVersion": self.data_version,
            "sourceRevision": self.source_revision,
            "errorCode": None,
        }

    def pal(self, character_id: str) -> PalSpeciesMetadata | None:
        direct = self.pals.get(character_id)
        if direct is not None:
            return direct
        return self._pals_casefold.get(character_id.casefold())

    def skill(self, skill_id: str) -> dict[str, object] | None:
        return self.skills.get(skill_id) or self._skills_casefold.get(skill_id.casefold())

    def item(self, item_id: str) -> ItemMetadata | None:
        return self.items.get(item_id) or self._items_casefold.get(item_id.casefold())

class WorldMetadataError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def unavailable_metadata_status(error_code: str = "WORLD_METADATA_UNAVAILABLE") -> MetadataStatus:
    return {
        "status": "unavailable",
        "schema": METADATA_SCHEMA_NAME,
        "schemaVersion": METADATA_SCHEMA_VERSION,
        "dataVersion": None,
        "sourceRevision": None,
        "errorCode": error_code,
    }


@lru_cache(maxsize=8)
def load_world_metadata(path: Path | None = None) -> WorldMetadataBundle:
    try:
        text = (
            path.read_text(encoding="utf-8")
            if path is not None
            else files(__package__).joinpath("data/world-metadata-v1.json").read_text(
                encoding="utf-8"
            )
        )
    except (FileNotFoundError, OSError) as error:
        raise WorldMetadataError(
            "WORLD_METADATA_UNAVAILABLE", "Local world metadata bundle is unavailable."
        ) from error
    try:
        payload = json.loads(text)
    except json.JSONDecodeError as error:
        raise WorldMetadataError(
            "WORLD_METADATA_INVALID", "Local world metadata bundle is not valid JSON."
        ) from error
    if not isinstance(payload, Mapping):
        raise WorldMetadataError("WORLD_METADATA_INVALID", "Metadata root must be an object.")
    _require_keys(
        payload,
        {
            "schema",
            "schemaVersion",
            "dataVersion",
            "source",
            "generatedBy",
            "collections",
            "integrity",
            "sources",
            "progressTotals",
            "progressTotalsDataVersion",
        },
        "root",
    )
    _require_equal(payload, "schema", METADATA_SCHEMA_NAME)
    _require_equal(payload, "schemaVersion", METADATA_SCHEMA_VERSION)
    data_version = _required_text(payload, "dataVersion")
    source = _required_mapping(payload, "source")
    _require_keys(
        source,
        {"repository", "revision", "path", "sha256", "license", "licenseFile"},
        "source",
    )
    _required_text(source, "repository")
    source_revision = _required_text(source, "revision")
    source_sha256 = _required_text(source, "sha256")
    _required_text(source, "path")
    _required_text(source, "licenseFile")
    _required_text(payload, "generatedBy")
    _validate_sources(_required_mapping(payload, "sources"))
    _require_equal(source, "license", "MIT")
    if not _is_hex_digest(source_revision, 40) or not _is_hex_digest(source_sha256, 64):
        raise WorldMetadataError("WORLD_METADATA_INVALID", "Metadata source digest is invalid.")
    collections = _required_mapping(payload, "collections")
    _require_keys(collections, {"pals", "skills", "items"}, "collections")
    pals_raw = _required_mapping(collections, "pals")
    skills_raw = _required_mapping(collections, "skills")
    items_raw = _required_mapping(collections, "items")
    progress_totals_raw = _required_mapping(payload, "progressTotals")
    progress_totals_data_version = _required_text(payload, "progressTotalsDataVersion")
    _require_keys(
        progress_totals_raw,
        {"fastTravel", "exploredAreas", "towerBosses", "oilRigLocations"},
        "progressTotals",
    )
    progress_totals: dict[str, int] = {}
    for name, value in progress_totals_raw.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Player progress total is invalid: {name}."
            )
        progress_totals[str(name)] = value
    integrity = _required_mapping(payload, "integrity")
    _require_keys(
        integrity,
        {"algorithm", "collectionsSha256", "progressTotalsSha256", "counts"},
        "integrity",
    )
    _require_equal(integrity, "algorithm", "sha256")
    expected_hash = _required_text(integrity, "collectionsSha256")
    actual_hash = hashlib.sha256(_canonical_json(collections)).hexdigest()
    if actual_hash != expected_hash:
        raise WorldMetadataError(
            "WORLD_METADATA_INTEGRITY_FAILED",
            f"Metadata collections SHA-256 mismatch: expected {expected_hash}, got {actual_hash}.",
        )
    expected_progress_hash = _required_text(integrity, "progressTotalsSha256")
    actual_progress_hash = hashlib.sha256(_canonical_json(progress_totals_raw)).hexdigest()
    if actual_progress_hash != expected_progress_hash:
        raise WorldMetadataError(
            "WORLD_METADATA_INTEGRITY_FAILED",
            "Metadata player progress totals SHA-256 mismatch: "
            f"expected {expected_progress_hash}, got {actual_progress_hash}.",
        )
    counts = _required_mapping(integrity, "counts")
    _require_keys(counts, {"pals", "skills", "items"}, "counts")
    for name, collection in (("pals", pals_raw), ("skills", skills_raw), ("items", items_raw)):
        expected_count = counts.get(name)
        if not isinstance(expected_count, int) or isinstance(expected_count, bool):
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Metadata count is invalid: {name}."
            )
        if expected_count != len(collection):
            raise WorldMetadataError(
                "WORLD_METADATA_INTEGRITY_FAILED", f"Metadata count mismatch: {name}."
            )
    pals: dict[str, PalSpeciesMetadata] = {}
    for character_id, raw in pals_raw.items():
        if not isinstance(character_id, str) or not character_id or not isinstance(raw, Mapping):
            raise WorldMetadataError("WORLD_METADATA_INVALID", "Pal metadata entry is invalid.")
        _require_keys(raw, {"rarity", "workSuitabilities", "partnerSkill"}, f"pal/{character_id}")
        rarity = raw.get("rarity")
        suitability_raw = raw.get("workSuitabilities")
        if (
            not isinstance(rarity, int)
            or isinstance(rarity, bool)
            or rarity < 0
            or not isinstance(suitability_raw, Mapping)
        ):
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Pal metadata fields are invalid: {character_id}."
            )
        suitabilities: dict[str, int] = {}
        for suitability, level in suitability_raw.items():
            if (
                not isinstance(suitability, str)
                or suitability not in WORK_SUITABILITY_TYPES
                or not isinstance(level, int)
                or isinstance(level, bool)
                or level < 1
                or level > 10
            ):
                raise WorldMetadataError(
                    "WORLD_METADATA_INVALID",
                    f"Pal work suitability is invalid: {character_id}/{suitability}.",
                )
            suitabilities[suitability] = level
        partner_raw = raw.get("partnerSkill")
        if partner_raw is None:
            partner_skill = None
        elif (
            isinstance(partner_raw, Mapping)
            and set(partner_raw) == {"id", "name", "sourceName", "description"}
            and all(
                isinstance(partner_raw.get(key), str)
                for key in ("id", "sourceName", "description")
            )
            and (partner_raw.get("name") is None or isinstance(partner_raw.get("name"), str))
        ):
            partner_skill = {
                "id": str(partner_raw["id"]),
                "name": partner_raw["name"],
                "sourceName": str(partner_raw["sourceName"]),
                "description": str(partner_raw["description"]),
            }
        else:
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Pal partner skill is invalid: {character_id}."
            )
        pals[character_id] = PalSpeciesMetadata(rarity, suitabilities, partner_skill)
    skills = _object_collection(skills_raw, "skills")
    items: dict[str, ItemMetadata] = {}
    for item_id, raw in items_raw.items():
        if not isinstance(item_id, str) or not item_id or not isinstance(raw, Mapping):
            raise WorldMetadataError("WORLD_METADATA_INVALID", "Item metadata entry is invalid.")
        if set(raw) not in ({"category", "rarity"}, {"name", "category", "rarity"}):
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Metadata object keys are invalid: item/{item_id}."
            )
        items[item_id] = ItemMetadata(
            name=_required_text(raw, "name") if "name" in raw else None,
            category=_required_text(raw, "category"),
            rarity=_required_text(raw, "rarity"),
        )
    return WorldMetadataBundle(
        data_version=data_version,
        source_revision=source_revision,
        pals=pals,
        skills=skills,
        items=items,
        player_progress_totals=progress_totals,
        player_progress_totals_data_version=progress_totals_data_version,
        _pals_casefold={name.casefold(): value for name, value in pals.items()},
        _skills_casefold={name.casefold(): value for name, value in skills.items()},
        _items_casefold={name.casefold(): value for name, value in items.items()},
    )


def _canonical_json(value: Mapping[str, object]) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")


def _required_mapping(value: Mapping[str, Any], key: str) -> Mapping[str, Any]:
    result = value.get(key)
    if not isinstance(result, Mapping):
        raise WorldMetadataError("WORLD_METADATA_INVALID", f"Metadata field is invalid: {key}.")
    return result


def _required_text(value: Mapping[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise WorldMetadataError("WORLD_METADATA_INVALID", f"Metadata field is invalid: {key}.")
    return result


def _require_equal(value: Mapping[str, Any], key: str, expected: object) -> None:
    if value.get(key) != expected:
        raise WorldMetadataError("WORLD_METADATA_INVALID", f"Metadata field is invalid: {key}.")


def _require_keys(value: Mapping[str, Any], expected: set[str], context: str) -> None:
    if set(value) != expected:
        raise WorldMetadataError(
            "WORLD_METADATA_INVALID", f"Metadata object keys are invalid: {context}."
        )


def _is_hex_digest(value: str, length: int) -> bool:
    return len(value) == length and all(character in "0123456789abcdef" for character in value)


def _object_collection(value: Mapping[str, Any], name: str) -> dict[str, dict[str, object]]:
    result: dict[str, dict[str, object]] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not key or not isinstance(item, Mapping):
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", f"Metadata collection is invalid: {name}."
            )
        result[key] = cast(dict[str, object], dict(item))
    return result


def _validate_sources(sources: Mapping[str, Any]) -> None:
    if not sources:
        raise WorldMetadataError("WORLD_METADATA_INVALID", "Metadata sources are missing.")
    for name, source in sources.items():
        if not isinstance(name, str) or not isinstance(source, Mapping):
            raise WorldMetadataError("WORLD_METADATA_INVALID", "Metadata source is invalid.")
        _require_keys(source, {"repository", "revision", "license", "files"}, f"sources/{name}")
        _required_text(source, "repository")
        revision = _required_text(source, "revision")
        _required_text(source, "license")
        if not _is_hex_digest(revision, 40):
            raise WorldMetadataError(
                "WORLD_METADATA_INVALID", "Metadata source revision is invalid."
            )
        files_raw = _required_mapping(source, "files")
        if not files_raw:
            raise WorldMetadataError("WORLD_METADATA_INVALID", "Metadata source files are missing.")
        for file_name, file_info in files_raw.items():
            if not isinstance(file_name, str) or not isinstance(file_info, Mapping):
                raise WorldMetadataError(
                    "WORLD_METADATA_INVALID", "Metadata source file is invalid."
                )
            _require_keys(file_info, {"path", "sha256"}, f"sources/{name}/{file_name}")
            _required_text(file_info, "path")
            if not _is_hex_digest(_required_text(file_info, "sha256"), 64):
                raise WorldMetadataError(
                    "WORLD_METADATA_INVALID", "Metadata source digest is invalid."
                )
