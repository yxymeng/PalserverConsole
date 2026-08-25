from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from collections.abc import Mapping, Sequence
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal, TypedDict

from ..metadata import WorldMetadataBundle, WorldMetadataError, load_world_metadata
from ..metadata.loader import WORK_SUITABILITY_TYPES, unavailable_metadata_status
from ..steam import is_reparse_point
from .pal_care_species import max_full_stomach

CACHE_SCHEMA_NAME = "world-asset-cache"
CACHE_SCHEMA_VERSION = 13
ZERO_UUID = "00000000-0000-0000-0000-000000000000"
_WORK_SUITABILITY_TYPES = WORK_SUITABILITY_TYPES

PalCareReason = Literal["zero_hp", "disease", "hunger_low", "san_low"]
PalCareUnavailable = Literal["currentHp", "hunger", "sanity", "disease", "activity"]
PalCareSeverity = Literal["critical", "warning", "unavailable", "info", "healthy"]


class PalCareSignals(TypedDict):
    current_hp: float | None
    hunger: float | None
    sanity: float | None
    disease: str | None
    activity: str | None
    disease_recorded: bool
    activity_recorded: bool


class PalCareFields(PalCareSignals):
    hunger_raw: float | None
    hunger_status: str | None
    physical_health: str | None


class PalCareAssessment(TypedDict):
    reasons: list[PalCareReason]
    unavailable: list[PalCareUnavailable]
    severity: PalCareSeverity
    attention: bool


class WorldCacheSchemaError(ValueError):
    """The derived cache belongs to a different immutable cache schema."""

CACHE_SCHEMA = """
CREATE TABLE cache_info (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE players (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    name TEXT NOT NULL,
    level INTEGER,
    guild_id TEXT,
    inventory_ids_json TEXT NOT NULL DEFAULT '[]',
    party_container_id TEXT,
    storage_container_id TEXT,
    detail_json TEXT NOT NULL
);
CREATE INDEX players_name_idx ON players(name);
CREATE TABLE pals (
    id TEXT PRIMARY KEY,
    owner_player_id TEXT,
    character_id TEXT NOT NULL,
    nickname TEXT,
    level INTEGER,
    container_id TEXT,
    slot_index INTEGER,
    base_id TEXT,
    assignment TEXT NOT NULL,
    gender TEXT,
    rank INTEGER,
    is_boss INTEGER NOT NULL DEFAULT 0,
    is_lucky INTEGER NOT NULL DEFAULT 0,
    species_rarity INTEGER,
    iv_hp REAL,
    iv_attack REAL,
    iv_defense REAL,
    iv_average REAL,
    work_suitability_json TEXT NOT NULL DEFAULT '{}',
    metadata_known INTEGER NOT NULL DEFAULT 0,
    current_hp REAL,
    hunger REAL,
    sanity REAL,
    disease TEXT,
    activity TEXT,
    passive_skills_json TEXT NOT NULL DEFAULT '[]',
    equipped_skills_json TEXT NOT NULL DEFAULT '[]',
    learned_skills_json TEXT NOT NULL DEFAULT '[]',
    partner_skill_json TEXT,
    detail_json TEXT NOT NULL
);
CREATE INDEX pals_character_idx ON pals(character_id);
CREATE INDEX pals_owner_idx ON pals(owner_player_id);
CREATE INDEX pals_base_idx ON pals(base_id);
CREATE INDEX pals_roster_name_idx ON pals(nickname COLLATE NOCASE, character_id, id);
CREATE INDEX pals_roster_level_idx ON pals(level DESC, id);
CREATE INDEX pals_roster_aptitude_idx ON pals(species_rarity DESC, iv_average DESC, id);
CREATE INDEX pals_roster_marker_idx ON pals(is_lucky, is_boss, id);
CREATE INDEX pals_care_attention_idx ON pals(current_hp, hunger, sanity, disease);
CREATE TABLE guilds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    member_count INTEGER NOT NULL,
    base_count INTEGER NOT NULL,
    detail_json TEXT NOT NULL
);
CREATE INDEX guilds_name_idx ON guilds(name);
CREATE TABLE bases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    guild_id TEXT,
    worker_container_id TEXT,
    x REAL,
    y REAL,
    z REAL,
    detail_json TEXT NOT NULL
);
CREATE INDEX bases_guild_idx ON bases(guild_id);
CREATE TABLE containers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    owner_id TEXT,
    guild_id TEXT,
    base_id TEXT,
    slot_count INTEGER NOT NULL
);
CREATE INDEX containers_owner_idx ON containers(owner_id);
CREATE INDEX containers_base_idx ON containers(base_id);
CREATE TABLE inventory_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    container_id TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    item_name TEXT,
    item_category TEXT,
    item_rarity TEXT,
    metadata_known INTEGER NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT,
    guild_id TEXT,
    base_id TEXT,
    map_object_type TEXT,
    map_object_instance_id TEXT,
    world_x REAL,
    world_y REAL,
    world_z REAL
);
CREATE INDEX inventory_items_container_idx ON inventory_items(container_id, slot_index);
CREATE INDEX inventory_items_item_idx ON inventory_items(item_id);
CREATE INDEX inventory_items_owner_idx ON inventory_items(owner_id);
CREATE INDEX inventory_items_base_idx ON inventory_items(base_id);
CREATE INDEX inventory_items_category_idx ON inventory_items(item_category);
CREATE INDEX inventory_items_location_type_idx ON inventory_items(owner_kind);
"""


def inspect_storage(path: Path) -> dict[str, int | bool]:
    """Measure a managed path without following links or Windows reparse points.

    Capacity reporting must never walk into a redirected tree.  Errors are reported
    in the result so the caller can keep the rest of an operational-health snapshot.
    """

    result: dict[str, int | bool] = {
        "exists": False,
        "sizeBytes": 0,
        "fileCount": 0,
        "directoryCount": 0,
        "skippedEntries": 0,
        "errors": 0,
    }
    try:
        path.lstat()
    except FileNotFoundError:
        return result
    except OSError:
        result["errors"] = 1
        return result

    result["exists"] = True
    if is_reparse_point(path):
        result["skippedEntries"] = 1
        return result
    try:
        if path.is_file():
            result["fileCount"] = 1
            result["sizeBytes"] = int(path.stat().st_size)
            return result
        if not path.is_dir():
            return result
    except OSError:
        result["errors"] = int(result["errors"]) + 1
        return result

    result["directoryCount"] = 1
    pending = [path]
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    child = Path(entry.path)
                    if is_reparse_point(child):
                        result["skippedEntries"] = int(result["skippedEntries"]) + 1
                        continue
                    try:
                        if entry.is_file(follow_symlinks=False):
                            result["fileCount"] = int(result["fileCount"]) + 1
                            result["sizeBytes"] = int(result["sizeBytes"]) + int(
                                entry.stat(follow_symlinks=False).st_size
                            )
                        elif entry.is_dir(follow_symlinks=False):
                            result["directoryCount"] = int(result["directoryCount"]) + 1
                            pending.append(child)
                    except OSError:
                        result["errors"] = int(result["errors"]) + 1
        except OSError:
            result["errors"] = int(result["errors"]) + 1
    return result


def build_world_cache(
    cache_path: Path,
    level_properties: Mapping[str, Any],
    player_properties: Sequence[Mapping[str, Any]],
    *,
    snapshot_id: str,
    source_observed_at: int,
    collected_at: int | None = None,
    parse_started_at: int | None = None,
) -> dict[str, int]:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    if cache_path.exists():
        raise FileExistsError(f"Cache already exists: {cache_path.name}")

    world = _property(level_properties.get("worldSaveData"))
    if not isinstance(world, Mapping):
        raise ValueError("Level.sav is missing worldSaveData.")

    player_profiles = _player_profiles(player_properties)
    characters = _list_property(world.get("CharacterSaveParameterMap"))
    item_containers = _list_property(world.get("ItemContainerSaveData"))
    character_containers = _list_property(world.get("CharacterContainerSaveData"))
    groups = _list_property(world.get("GroupSaveDataMap"))
    guild_extras = _list_property(world.get("GuildExtraSaveDataMap"))
    base_camps = _list_property(world.get("BaseCampSaveData"))
    map_objects = _list_property(world.get("MapObjectSaveData"))
    game_time_ticks = _game_time_ticks(world)

    group_rows, player_group = _groups(groups)
    base_rows, worker_container_to_base = _bases(base_camps)
    character_container_rows, instance_locations = _character_containers(
        character_containers, worker_container_to_base, player_profiles
    )
    try:
        world_metadata = load_world_metadata()
        metadata_status = world_metadata.status
    except WorldMetadataError as error:
        world_metadata = None
        metadata_status = unavailable_metadata_status(error.code)
    player_rows, pal_rows = _characters(
        characters, player_profiles, player_group, instance_locations, world_metadata
    )
    item_container_rows, item_rows = _item_containers(
        item_containers,
        player_profiles,
        base_rows,
        world_metadata,
        _map_object_item_containers(map_objects),
        _guild_item_containers(guild_extras),
    )

    counts = {
        "players": len(player_rows),
        "pals": len(pal_rows),
        "guilds": len(group_rows),
        "bases": len(base_rows),
        "containers": len(character_container_rows) + len(item_container_rows),
        "inventory_items": len(item_rows),
        "work_pals": sum(1 for row in pal_rows if row[8] == "base_worker"),
    }

    connection = sqlite3.connect(cache_path)
    try:
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.executescript(CACHE_SCHEMA)
        metadata = {
            "schema": CACHE_SCHEMA_NAME,
            "schema_version": str(CACHE_SCHEMA_VERSION),
            "snapshot_id": snapshot_id,
            "source_observed_at": str(source_observed_at),
            "created_at": str(int(time.time())),
            "counts": json.dumps(counts, separators=(",", ":")),
            "metadata_status": str(metadata_status["status"]),
            "metadata_schema": str(metadata_status["schema"]),
            "metadata_schema_version": str(metadata_status["schemaVersion"]),
            "metadata_data_version": str(metadata_status["dataVersion"] or ""),
            "metadata_source_revision": str(metadata_status["sourceRevision"] or ""),
            "metadata_error_code": str(metadata_status["errorCode"] or ""),
        }
        if game_time_ticks is not None:
            metadata["game_time_ticks"] = str(game_time_ticks)
        if collected_at is not None:
            metadata["collected_at"] = str(collected_at)
        if parse_started_at is not None:
            metadata["parse_started_at"] = str(parse_started_at)
        connection.executemany("INSERT INTO cache_info(key, value) VALUES(?, ?)", metadata.items())
        connection.executemany(
            "INSERT INTO players VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", player_rows
        )
        connection.executemany(
            "INSERT INTO pals VALUES(" + ", ".join("?" for _ in range(30)) + ")",
            pal_rows,
        )
        connection.executemany("INSERT INTO guilds VALUES(?, ?, ?, ?, ?)", group_rows)
        connection.executemany("INSERT INTO bases VALUES(?, ?, ?, ?, ?, ?, ?, ?)", base_rows)
        connection.executemany(
            "INSERT INTO containers VALUES(?, ?, ?, ?, ?, ?)",
            character_container_rows + item_container_rows,
        )
        connection.executemany(
            """INSERT INTO inventory_items(
                container_id, slot_index, item_id, item_name, item_category, item_rarity,
                metadata_known, quantity, owner_kind,
                owner_id, guild_id, base_id, map_object_type,
                map_object_instance_id, world_x, world_y, world_z
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            item_rows,
        )
        connection.execute(f"PRAGMA user_version = {CACHE_SCHEMA_VERSION}")
        connection.commit()
        _validate_cache(connection, counts)
    except Exception:
        connection.close()
        cache_path.unlink(missing_ok=True)
        raise
    finally:
        with suppress(Exception):
            connection.close()
    return counts


def _game_time_ticks(world: Mapping[str, Any]) -> int | None:
    game_time = _mapping(world.get("GameTimeSaveData"))
    value = _scalar(game_time.get("GameDateTimeTicks"))
    if isinstance(value, bool):
        return None
    try:
        ticks = int(value)
    except (TypeError, ValueError):
        return None
    return ticks if ticks >= 0 else None


def read_cache_metadata(path: Path) -> dict[str, str]:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.suffix.casefold() != ".sqlite":
        raise ValueError("World cache must be a regular .sqlite file.")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute("SELECT key, value FROM cache_info").fetchall()
        return {str(key): str(value) for key, value in rows}
    finally:
        connection.close()


def query_world_metadata_status(path: Path) -> dict[str, object]:
    metadata = read_cache_metadata(path)
    return {
        "status": metadata.get("metadata_status", "unavailable"),
        "schema": metadata.get("metadata_schema", "palserver-console-world-metadata"),
        "schemaVersion": int(metadata.get("metadata_schema_version", "1")),
        "dataVersion": metadata.get("metadata_data_version") or None,
        "sourceRevision": metadata.get("metadata_source_revision") or None,
        "errorCode": metadata.get("metadata_error_code") or None,
    }


def validate_cache_file(path: Path) -> dict[str, int]:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.suffix.casefold() != ".sqlite":
        raise ValueError("World cache must be a regular .sqlite file.")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    try:
        metadata = {
            str(key): str(value)
            for key, value in connection.execute("SELECT key, value FROM cache_info").fetchall()
        }
        if metadata.get("schema") != CACHE_SCHEMA_NAME or metadata.get(
            "schema_version"
        ) != str(CACHE_SCHEMA_VERSION):
            raise WorldCacheSchemaError("World cache schema is incompatible.")
        user_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if user_version != CACHE_SCHEMA_VERSION:
            raise WorldCacheSchemaError("World cache schema is incompatible.")
        row = connection.execute("SELECT value FROM cache_info WHERE key='counts'").fetchone()
        if row is None:
            raise ValueError("World cache is missing counts metadata.")
        counts = json.loads(str(row[0]))
        if not isinstance(counts, dict):
            raise ValueError("World cache counts metadata is invalid.")
        _validate_cache(connection, {str(key): int(value) for key, value in counts.items()})
        return {str(key): int(value) for key, value in counts.items()}
    finally:
        connection.close()


def query_cache(
    path: Path,
    resource: str,
    *,
    page: int,
    page_size: int,
    search: str | None = None,
    owner_id: str | None = None,
    base_id: str | None = None,
    status: str = "all",
    sort: str = "name",
) -> tuple[list[dict[str, object]], int]:
    definitions = {
        "players": ("players", ("name", "id"), ("owner_id", "base_id")),
        "pals": ("pals", ("character_id", "nickname", "id"), ("owner_player_id", "base_id")),
        "guilds": ("guilds", ("name", "id"), ("owner_id", "base_id")),
        "bases": ("bases", ("name", "id"), ("owner_id", "id")),
        "inventories": (
            "inventory_items",
            ("item_id", "container_id"),
            ("owner_id", "base_id"),
        ),
        "work-pals": ("pals", ("character_id", "nickname", "id"), ("owner_player_id", "base_id")),
    }
    if resource not in definitions:
        raise ValueError("Unknown world resource.")
    table, search_fields, filter_fields = definitions[resource]
    clauses: list[str] = []
    parameters: list[object] = []
    if resource == "work-pals":
        clauses.append("assignment = 'base_worker'")
    status_clauses = {
        "players": {
            "all": None,
            "guilded": "guild_id IS NOT NULL AND guild_id <> ''",
            "unguilded": "guild_id IS NULL OR guild_id = ''",
        },
        "pals": {
            "all": None,
            "player": "owner_player_id IS NOT NULL AND owner_player_id <> ''",
            "base": "base_id IS NOT NULL AND base_id <> ''",
            "unassigned": (
                "(owner_player_id IS NULL OR owner_player_id = '') "
                "AND (base_id IS NULL OR base_id = '')"
            ),
        },
        "guilds": {"all": None, "active": "member_count > 0", "empty": "member_count = 0"},
        "bases": {
            "all": None,
            "guilded": "guild_id IS NOT NULL AND guild_id <> ''",
            "unguilded": "guild_id IS NULL OR guild_id = ''",
        },
    }
    if resource in status_clauses:
        if status not in status_clauses[resource]:
            raise ValueError("Unknown world status filter.")
        if status_clause := status_clauses[resource][status]:
            clauses.append(status_clause)
    if search:
        clauses.append("(" + " OR ".join(f"{field} LIKE ?" for field in search_fields) + ")")
        parameters.extend([f"%{search}%"] * len(search_fields))
    for value, field in ((owner_id, filter_fields[0]), (base_id, filter_fields[1])):
        if value and field in _table_columns(table):
            clauses.append(f"{field} = ?")
            parameters.append(value)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    order_definitions = {
        "players": {
            "name": "name COLLATE NOCASE, id",
            "level-desc": "level IS NULL, level DESC, name COLLATE NOCASE, id",
            "id": "id",
        },
        "pals": {
            "name": "COALESCE(NULLIF(nickname, ''), character_id) COLLATE NOCASE, id",
            "level-desc": "level IS NULL, level DESC, character_id COLLATE NOCASE, id",
            "id": "id",
        },
        "guilds": {
            "name": "name COLLATE NOCASE, id",
            "count-desc": "member_count DESC, base_count DESC, name COLLATE NOCASE, id",
            "id": "id",
        },
        "bases": {"name": "name COLLATE NOCASE, id", "id": "id"},
    }
    if resource in order_definitions:
        if sort not in order_definitions[resource]:
            raise ValueError("Unknown world sort.")
        order = order_definitions[resource][sort]
    else:
        order = "rowid"
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        count_row = connection.execute(
            f"SELECT COUNT(*) FROM {table}{where}", parameters
        ).fetchone()
        total = int(count_row[0])
        rows = connection.execute(
            f"SELECT * FROM {table}{where} ORDER BY {order} LIMIT ? OFFSET ?",
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
        public_rows = [_public_row(dict(row)) for row in rows]
        if resource == "players":
            for public_row in public_rows:
                _add_player_profile_fields(public_row)
            _add_relation_names(
                connection,
                public_rows,
                id_field="guildId",
                name_field="guildName",
                table="guilds",
            )
        elif resource in {"pals", "work-pals"}:
            _add_relation_names(
                connection,
                public_rows,
                id_field="ownerPlayerId",
                name_field="ownerName",
                table="players",
            )
            _add_relation_names(
                connection,
                public_rows,
                id_field="baseId",
                name_field="baseName",
                table="bases",
            )
        elif resource == "bases":
            _add_relation_names(
                connection,
                public_rows,
                id_field="guildId",
                name_field="guildName",
                table="guilds",
            )
        return public_rows, total
    finally:
        connection.close()


def query_inventory(
    path: Path,
    *,
    page: int,
    page_size: int,
    search: str | None,
    category: str | None,
    scope: str,
    owner_id: str | None,
    base_id: str | None,
    sort: str,
) -> tuple[list[dict[str, object]], int, list[str]]:
    """Aggregate immutable item slots before they leave the server."""

    if scope not in {"inventory", "all", "player", "base", "world"} or sort not in {
        "name",
        "quantity",
    }:
        raise ValueError("Unknown inventory query.")
    clauses, parameters = _inventory_filters(
        search=search,
        category=category,
        scope=scope,
        owner_id=owner_id,
        base_id=base_id,
    )
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    order = {
        "name": (
            "CASE WHEN itemName IS NULL OR itemName = '' THEN 1 ELSE 0 END, "
            "COALESCE(itemName, itemId) COLLATE NOCASE, itemId"
        ),
        "quantity": "totalQuantity DESC, COALESCE(itemName, itemId) COLLATE NOCASE, itemId",
    }[sort]
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        total = int(
            connection.execute(
                "SELECT COUNT(*) FROM (SELECT 1 FROM inventory_items AS ii"
                f"{where} GROUP BY ii.item_id)",
                parameters,
            ).fetchone()[0]
        )
        rows = connection.execute(
            "SELECT ii.item_id AS itemId, MAX(ii.item_name) AS itemName, "
            "MAX(ii.item_category) AS category, MAX(ii.item_rarity) AS rarity, "
            "MAX(ii.metadata_known) AS metadataKnown, SUM(ii.quantity) AS totalQuantity, "
            "COUNT(*) AS locationCount FROM inventory_items AS ii"
            f"{where} GROUP BY ii.item_id ORDER BY {order} LIMIT ? OFFSET ?",
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
        category_clauses, category_parameters = _inventory_filters(
            search=None,
            category=None,
            scope=scope,
            owner_id=owner_id,
            base_id=base_id,
        )
        category_where = (
            f" WHERE {' AND '.join([*category_clauses, 'ii.item_category IS NOT NULL'])}"
            if category_clauses
            else " WHERE ii.item_category IS NOT NULL"
        )
        categories = [
            str(row[0])
            for row in connection.execute(
                "SELECT DISTINCT ii.item_category FROM inventory_items AS ii"
                f"{category_where} ORDER BY ii.item_category COLLATE NOCASE",
                category_parameters,
            ).fetchall()
            if isinstance(row[0], str) and row[0]
        ]
    finally:
        connection.close()
    return [_inventory_public_row(dict(row)) for row in rows], total, categories


def query_inventory_locations(
    path: Path,
    item_id: str,
    *,
    page: int,
    page_size: int,
    scope: str,
    owner_id: str | None,
    base_id: str | None,
    location_type: str | None = None,
    group_id: str | None = None,
) -> tuple[list[dict[str, object]], int]:
    if scope not in {"inventory", "all", "player", "base", "world"}:
        raise ValueError("Unknown inventory query.")
    clauses, parameters = _inventory_filters(
        search=None,
        category=None,
        scope=scope,
        owner_id=owner_id,
        base_id=base_id,
    )
    clauses.append("ii.item_id = ?")
    parameters.append(item_id)
    _add_inventory_group_filter(clauses, parameters, location_type, group_id)
    where = " WHERE " + " AND ".join(clauses)
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        total = int(
            connection.execute(
                "SELECT COUNT(*) FROM inventory_items AS ii" + where, parameters
            ).fetchone()[0]
        )
        rows = connection.execute(
            "SELECT ii.id, ii.container_id AS containerId, ii.slot_index AS slotIndex, "
            "ii.quantity, ii.owner_kind AS ownerKind, ii.owner_id AS ownerId, "
            "ii.guild_id AS guildId, ii.base_id AS baseId, "
            "ii.map_object_type AS mapObjectType, "
            "ii.map_object_instance_id AS mapObjectInstanceId, "
            "ii.world_x AS worldX, ii.world_y AS worldY, ii.world_z AS worldZ, "
            "p.name AS ownerName, g.name AS guildName, b.name AS baseName "
            "FROM inventory_items AS ii "
            "LEFT JOIN players AS p ON p.id = ii.owner_id "
            "LEFT JOIN guilds AS g ON g.id = ii.guild_id "
            "LEFT JOIN bases AS b ON b.id = ii.base_id"
            f"{where} ORDER BY ii.owner_kind, COALESCE(p.name, g.name, b.name, ''), "
            "ii.slot_index, ii.id "
            "LIMIT ? OFFSET ?",
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
    finally:
        connection.close()
    return [_inventory_location_public_row(dict(row)) for row in rows], total


def query_inventory_location_groups(
    path: Path,
    item_id: str,
    *,
    scope: str,
    owner_id: str | None,
    base_id: str | None,
) -> list[dict[str, object]]:
    if scope not in {"inventory", "all", "player", "base", "world"}:
        raise ValueError("Unknown inventory query.")
    clauses, parameters = _inventory_filters(
        search=None,
        category=None,
        scope=scope,
        owner_id=owner_id,
        base_id=base_id,
    )
    clauses.append("ii.item_id = ?")
    parameters.append(item_id)
    where = " WHERE " + " AND ".join(clauses)
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT ii.owner_kind AS ownerKind, "
            "CASE WHEN ii.owner_kind = 'player_inventory' THEN ii.owner_id "
            "WHEN ii.owner_kind = 'base_inventory' THEN ii.base_id "
            "WHEN ii.owner_kind = 'guild_inventory' THEN ii.guild_id "
            "ELSE NULL END AS groupId, "
            "MAX(p.name) AS ownerName, MAX(g.name) AS guildName, MAX(b.name) AS baseName, "
            "SUM(ii.quantity) AS quantitySum, COUNT(*) AS locationCount, "
            "COUNT(DISTINCT ii.container_id) AS containerCount "
            "FROM inventory_items AS ii "
            "LEFT JOIN players AS p ON p.id = ii.owner_id "
            "LEFT JOIN guilds AS g ON g.id = ii.guild_id "
            "LEFT JOIN bases AS b ON b.id = ii.base_id"
            f"{where} GROUP BY ii.owner_kind, groupId "
            "ORDER BY CASE ii.owner_kind WHEN 'player_inventory' THEN 0 "
            "WHEN 'base_inventory' THEN 1 WHEN 'guild_inventory' THEN 2 "
            "WHEN 'world' THEN 3 ELSE 4 END, "
            "COALESCE(MAX(p.name), MAX(g.name), MAX(b.name), groupId, '') COLLATE NOCASE",
            parameters,
        ).fetchall()
    finally:
        connection.close()
    return [_inventory_group_public_row(dict(row)) for row in rows]


def _inventory_filters(
    *,
    search: str | None,
    category: str | None,
    scope: str,
    owner_id: str | None,
    base_id: str | None,
) -> tuple[list[str], list[object]]:
    clauses: list[str] = []
    parameters: list[object] = []
    if scope == "player":
        clauses.append("ii.owner_kind = 'player_inventory'")
    elif scope == "base":
        clauses.append("ii.owner_kind = 'base_inventory'")
    elif scope == "inventory":
        clauses.append(
            "ii.owner_kind IN ('player_inventory', 'base_inventory', 'guild_inventory')"
        )
    elif scope == "world":
        clauses.append("ii.owner_kind = 'world'")
    if owner_id:
        clauses.append("ii.owner_id = ?")
        parameters.append(owner_id)
    if base_id:
        clauses.append("ii.base_id = ?")
        parameters.append(base_id)
    if category:
        clauses.append("ii.item_category = ?")
        parameters.append(category)
    if search:
        clauses.append("(ii.item_id LIKE ? OR ii.item_name LIKE ?)")
        parameters.extend([f"%{search}%", f"%{search}%"])
    return clauses, parameters


def _add_inventory_group_filter(
    clauses: list[str],
    parameters: list[object],
    location_type: str | None,
    group_id: str | None,
) -> None:
    if location_type is None:
        if group_id is not None:
            raise ValueError("Inventory group ID requires a location type.")
        return
    owner_kind = {
        "player": "player_inventory",
        "base": "base_inventory",
        "guild": "guild_inventory",
        "world": "world",
        "unassigned": "unassigned",
    }.get(location_type)
    if owner_kind is None:
        raise ValueError("Unknown inventory location group.")
    clauses.append("ii.owner_kind = ?")
    parameters.append(owner_kind)
    if location_type in {"player", "base", "guild"}:
        if not group_id:
            raise ValueError("Inventory owner group requires a stable ID.")
        id_column = {
            "player": "ii.owner_id",
            "base": "ii.base_id",
            "guild": "ii.guild_id",
        }[location_type]
        clauses.append(f"{id_column} = ?")
        parameters.append(group_id)
    elif group_id is not None:
        raise ValueError("World and unassigned groups do not use a group ID.")


def _inventory_public_row(row: Mapping[str, object]) -> dict[str, object]:
    metadata_known = bool(row.get("metadataKnown"))
    return {
        "itemId": _text(row.get("itemId")) or "",
        "name": _text(row.get("itemName")),
        "category": _text(row.get("category")),
        "rarity": _text(row.get("rarity")),
        "metadataKnown": metadata_known,
        "metadataLabel": None if metadata_known else "资料未收录",
        "totalQuantity": _integer(row.get("totalQuantity")) or 0,
        "locationCount": _integer(row.get("locationCount")) or 0,
    }


def _inventory_location_public_row(row: Mapping[str, object]) -> dict[str, object]:
    owner_kind = _text(row.get("ownerKind")) or "unassigned"
    owner_id = _text(row.get("ownerId"))
    guild_id = _text(row.get("guildId"))
    base_id = _text(row.get("baseId"))
    owner_name = _text(row.get("ownerName"))
    guild_name = _text(row.get("guildName"))
    base_name = _text(row.get("baseName"))
    if owner_kind == "player_inventory":
        label = f"玩家：{owner_name or owner_id or '资料未收录'}"
        location_type = "player"
    elif owner_kind == "base_inventory":
        label = f"据点：{base_name or base_id or '资料未收录'}"
        location_type = "base"
    elif owner_kind == "guild_inventory":
        label = f"公会仓库：{guild_name}" if guild_name else "公会仓库"
        location_type = "guild"
    elif owner_kind == "world":
        map_object_type = _text(row.get("mapObjectType"))
        label = (
            "世界宝箱"
            if map_object_type and map_object_type.casefold().startswith("treasurebox")
            else "世界容器"
        )
        location_type = "world"
    else:
        label = "未关联容器"
        location_type = "unassigned"
    return {
        "id": _integer(row.get("id")) or 0,
        "locationType": location_type,
        "locationLabel": label,
        "ownerId": owner_id,
        "ownerName": owner_name,
        "guildId": guild_id,
        "guildName": guild_name,
        "baseId": base_id,
        "baseName": base_name,
        "slotIndex": _integer(row.get("slotIndex")) or 0,
        "quantity": _integer(row.get("quantity")) or 0,
        "containerId": _text(row.get("containerId")),
        "mapObjectType": _text(row.get("mapObjectType")),
        "mapObjectInstanceId": _text(row.get("mapObjectInstanceId")),
        "worldPosition": _world_position_public(row),
    }


def _inventory_group_public_row(row: Mapping[str, object]) -> dict[str, object]:
    owner_kind = _text(row.get("ownerKind")) or "unassigned"
    group_id = _text(row.get("groupId"))
    if owner_kind == "player_inventory":
        location_type = "player"
        label = f"玩家：{_text(row.get('ownerName')) or group_id or '资料未收录'}"
    elif owner_kind == "base_inventory":
        location_type = "base"
        label = f"据点：{_text(row.get('baseName')) or group_id or '资料未收录'}"
    elif owner_kind == "guild_inventory":
        location_type = "guild"
        guild_name = _text(row.get("guildName"))
        label = f"公会仓库：{guild_name}" if guild_name else "公会仓库"
    elif owner_kind == "world":
        location_type = "world"
        label = "其他位置"
    else:
        location_type = "unassigned"
        label = "未识别位置"
    return {
        "locationType": location_type,
        "groupId": group_id,
        "label": label,
        "quantitySum": _integer(row.get("quantitySum")) or 0,
        "locationCount": _integer(row.get("locationCount")) or 0,
        "containerCount": _integer(row.get("containerCount")) or 0,
    }


def _world_position_public(row: Mapping[str, object]) -> dict[str, float] | None:
    values = tuple(_number(row.get(key)) for key in ("worldX", "worldY", "worldZ"))
    if any(value is None for value in values):
        return None
    return {"x": values[0], "y": values[1], "z": values[2]}  # type: ignore[dict-item]


def query_pal_roster(
    path: Path,
    *,
    page: int,
    page_size: int,
    search: str | None,
    marker: str,
    sort: str,
    care: str = "all",
    min_level: int | None = None,
    min_rank: int | None = None,
    min_rarity: int | None = None,
    min_hp_iv: float | None = None,
    min_attack_iv: float | None = None,
    min_defense_iv: float | None = None,
    min_average_iv: float | None = None,
    work_suitabilities: Sequence[str] = (),
    min_work_level: int = 1,
    passive_skills: Sequence[str] = (),
) -> tuple[list[dict[str, object]], int]:
    """Query the immutable cache in a stable roster order without loading all Pals."""

    if (
        marker not in {"all", "lucky", "boss"}
        or sort not in {"balanced", "name", "level", "rarity", "averageIv", "workSuitability"}
        or care not in {"all", "attention"}
        or any(name not in _WORK_SUITABILITY_TYPES for name in work_suitabilities)
        or any(not name.strip() for name in passive_skills)
    ):
        raise ValueError("Unknown Pal roster query.")
    clauses: list[str] = []
    parameters: list[object] = []
    if search:
        clauses.append("(p.nickname LIKE ? OR p.character_id LIKE ? OR p.id LIKE ?)")
        parameters.extend([f"%{search}%"] * 3)
    if marker == "lucky":
        clauses.append("p.is_lucky = 1")
    elif marker == "boss":
        clauses.append("p.is_boss = 1")
    if care == "attention":
        clauses.append(
            "(p.current_hp = 0 OR p.disease IS NOT NULL OR p.hunger < 20 OR p.sanity < 50)"
        )
    for value, column in (
        (min_level, "p.level"),
        (min_rank, "p.rank"),
        (min_rarity, "p.species_rarity"),
        (min_hp_iv, "p.iv_hp"),
        (min_attack_iv, "p.iv_attack"),
        (min_defense_iv, "p.iv_defense"),
        (min_average_iv, "p.iv_average"),
    ):
        if value is not None:
            clauses.append(f"{column} >= ?")
            parameters.append(value)
    for suitability in dict.fromkeys(work_suitabilities):
        clauses.append(f"json_extract(p.work_suitability_json, '$.{suitability}') >= ?")
        parameters.append(min_work_level)
    for passive_skill in dict.fromkeys(passive_skills):
        clauses.append(
            "EXISTS(SELECT 1 FROM json_each(p.passive_skills_json) WHERE value = ?)"
        )
        parameters.append(passive_skill)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    name_order = "COALESCE(NULLIF(p.nickname, ''), p.character_id) COLLATE NOCASE, p.id"
    order = {
        "balanced": name_order,
        "name": name_order,
        "level": "p.level IS NULL, p.level DESC, " + name_order,
        "rarity": "p.species_rarity IS NULL, p.species_rarity DESC, " + name_order,
        "averageIv": "p.iv_average IS NULL, p.iv_average DESC, " + name_order,
        "workSuitability": (
            "COALESCE((SELECT MAX(CAST(value AS INTEGER)) "
            "FROM json_each(p.work_suitability_json)), -1) DESC, " + name_order
        ),
    }[sort]
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        count_row = connection.execute(
            f"SELECT COUNT(*) FROM pals AS p{where}", parameters
        ).fetchone()
        total = int(count_row[0])
        rows = connection.execute(
            "SELECT p.*, c.kind AS container_kind FROM pals AS p "
            "LEFT JOIN containers AS c ON c.id = p.container_id"
            f"{where} ORDER BY {order} LIMIT ? OFFSET ?",
            (*parameters, page_size, (page - 1) * page_size),
        ).fetchall()
        public_rows = [_pal_public_row(dict(row)) for row in rows]
        _add_relation_names(
            connection,
            public_rows,
            id_field="ownerPlayerId",
            name_field="ownerName",
            table="players",
        )
        _add_relation_names(
            connection, public_rows, id_field="baseId", name_field="baseName", table="bases"
        )
        for row in public_rows:
            kind = row.pop("containerKind", None)
            row["locationType"] = (
                "base" if row.get("baseId") else "party" if kind == "pal_party"
                else "storage"
                if kind == "pal_storage"
                else "player"
                if row.get("ownerPlayerId")
                else "unassigned"
            )
        return public_rows, total
    finally:
        connection.close()


def query_pal_passive_skill_options(path: Path) -> list[dict[str, object]]:
    """List passives observed in this immutable snapshot for advanced filtering."""

    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            "SELECT passive_skills_json, detail_json FROM pals WHERE passive_skills_json != '[]'"
        ).fetchall()
    finally:
        connection.close()
    options: dict[str, dict[str, object]] = {}
    for row in rows:
        skill_details = _mapping(_mapping(_json_loads(row["detail_json"])).get("skills"))
        details = _skill_list(skill_details.get("passive"))
        detail_by_id = {str(item["id"]): item for item in details if item.get("id")}
        for skill_id in _json_list(row["passive_skills_json"]):
            options.setdefault(skill_id, detail_by_id.get(skill_id, _unknown_skill(skill_id)))
    return sorted(
        options.values(),
        key=lambda item: (not bool(item.get("metadataKnown")), str(item.get("name") or item["id"])),
    )


def entity_detail(path: Path, resource: str, entity_id: str) -> dict[str, object] | None:
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        if resource == "players":
            return _player_detail(connection, entity_id)
        if resource == "pals":
            return _pal_detail(connection, entity_id)
        if resource == "guilds":
            return _guild_detail(connection, entity_id)
        if resource == "bases":
            return _base_detail(connection, entity_id)
        raise ValueError("Unknown entity resource.")
    finally:
        connection.close()


def _player_detail(connection: sqlite3.Connection, player_id: str) -> dict[str, object] | None:
    row = connection.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
    if row is None:
        return None
    result = _public_row(dict(row))
    _add_player_profile_fields(result)
    pals = _rows(
        connection,
        "SELECT * FROM pals WHERE owner_player_id = ? ORDER BY rowid LIMIT 200",
        (player_id,),
    )
    result["pals"] = pals
    result["partyPals"] = [
        pal for pal in pals if pal.get("containerId") == result.get("partyContainerId")
    ]
    result["storagePals"] = [
        pal for pal in pals if pal.get("containerId") == result.get("storageContainerId")
    ]
    result["inventory"] = _rows(
        connection,
        "SELECT * FROM inventory_items WHERE owner_id = ? "
        "ORDER BY container_id, slot_index LIMIT 200",
        (player_id,),
    )
    result["guild"] = _reference(connection, "guilds", result.get("guildId"))
    return result


def _pal_detail(connection: sqlite3.Connection, pal_id: str) -> dict[str, object] | None:
    row = connection.execute("SELECT * FROM pals WHERE id = ?", (pal_id,)).fetchone()
    if row is None:
        return None
    result = _pal_public_row(dict(row))
    result["owner"] = _reference(connection, "players", result.get("ownerPlayerId"))
    result["base"] = _reference(connection, "bases", result.get("baseId"))
    result["container"] = _reference(connection, "containers", result.get("containerId"))
    return result


def _guild_detail(connection: sqlite3.Connection, guild_id: str) -> dict[str, object] | None:
    row = connection.execute("SELECT * FROM guilds WHERE id = ?", (guild_id,)).fetchone()
    if row is None:
        return None
    result = _public_row(dict(row))
    result["members"] = _rows(
        connection,
        "SELECT id, name, level, guild_id FROM players WHERE guild_id = ? "
        "ORDER BY name COLLATE NOCASE LIMIT 200",
        (guild_id,),
    )
    result["bases"] = _rows(
        connection,
        "SELECT id, name, guild_id, worker_container_id, x, y, z FROM bases "
        "WHERE guild_id = ? ORDER BY name COLLATE NOCASE LIMIT 200",
        (guild_id,),
    )
    return result


def _base_detail(connection: sqlite3.Connection, base_id: str) -> dict[str, object] | None:
    row = connection.execute("SELECT * FROM bases WHERE id = ?", (base_id,)).fetchone()
    if row is None:
        return None
    result = _public_row(dict(row))
    result["guild"] = _reference(connection, "guilds", result.get("guildId"))
    result["workers"] = _rows(
        connection,
        "SELECT * FROM pals WHERE base_id = ? AND assignment = 'base_worker' "
        "ORDER BY rowid LIMIT 200",
        (base_id,),
    )
    result["inventory"] = _rows(
        connection,
        "SELECT * FROM inventory_items WHERE base_id = ? "
        "ORDER BY container_id, slot_index LIMIT 200",
        (base_id,),
    )
    return result


def _rows(
    connection: sqlite3.Connection, query: str, parameters: tuple[object, ...]
) -> list[dict[str, object]]:
    return [_public_row(dict(item)) for item in connection.execute(query, parameters).fetchall()]


def _add_relation_names(
    connection: sqlite3.Connection,
    rows: list[dict[str, object]],
    *,
    id_field: str,
    name_field: str,
    table: str,
) -> None:
    if table not in {"players", "guilds", "bases"}:
        raise ValueError("Unknown relation table.")
    entity_ids = sorted(
        {
            entity_id
            for row in rows
            if isinstance(entity_id := row.get(id_field), str) and entity_id
        }
    )
    if not entity_ids:
        return
    placeholders = ", ".join("?" for _ in entity_ids)
    names = {
        str(entity_id): str(name)
        for entity_id, name in connection.execute(
            f"SELECT id, name FROM {table} WHERE id IN ({placeholders})", entity_ids
        ).fetchall()
    }
    for row in rows:
        entity_id = row.get(id_field)
        if isinstance(entity_id, str) and entity_id in names:
            row[name_field] = names[entity_id]


def _reference(
    connection: sqlite3.Connection, table: str, entity_id: object
) -> dict[str, object] | None:
    if not isinstance(entity_id, str) or not entity_id:
        return None
    columns = {
        "players": "id, name, level, guild_id",
        "guilds": "id, name, member_count, base_count",
        "bases": "id, name, guild_id, worker_container_id, x, y, z",
        "containers": "id, kind, owner_id, guild_id, base_id, slot_count",
    }
    if table not in columns:
        raise ValueError("Unknown reference table.")
    row = connection.execute(
        f"SELECT {columns[table]} FROM {table} WHERE id = ?", (entity_id,)
    ).fetchone()
    return _public_row(dict(row)) if row else None


def _player_profiles(properties: Sequence[Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {}
    for properties_item in properties:
        save_data = _property(properties_item.get("SaveData"))
        if not isinstance(save_data, Mapping):
            continue
        player_id = _id(_property(save_data.get("PlayerUId")))
        if not player_id:
            continue
        inventory = _property(save_data.get("InventoryInfo"))
        inventory_ids: list[str] = []
        if isinstance(inventory, Mapping):
            for value in inventory.values():
                container_id = _container_id(value)
                if container_id:
                    inventory_ids.append(container_id)
        profiles[player_id] = {
            "inventory_ids": inventory_ids,
            "party_container_id": _container_id(save_data.get("OtomoCharacterContainerId")),
            "storage_container_id": _container_id(save_data.get("PalStorageContainerId")),
            "platform": _scalar(save_data.get("PlayerPlatform")),
            "last_recorded_at": _windows_ticks_iso(_scalar(save_data.get("LastOnlineDateTime"))),
            "progress": _player_progress(save_data),
        }
    return profiles


_PLAYER_PROGRESS_FIELDS = (
    "discoveredPalSpecies",
    "capturedPals",
    "fastTravelPoints",
    "exploredAreas",
    "fieldBosses",
    "towerBosses",
    "dungeonClears",
    "oilRigClears",
    "technologyPoints",
    "ancientTechnologyPoints",
    "recipes",
)


def _player_progress(save_data: Mapping[str, Any]) -> dict[str, object]:
    record = _property(save_data.get("RecordData"))
    record_data = record if isinstance(record, Mapping) else {}
    candidates: dict[str, int | None] = {
        "discoveredPalSpecies": _truthy_map_count(record_data.get("PaldeckUnlockFlag")),
        "capturedPals": _count_map_sum(record_data.get("PalCaptureCount")),
        "fastTravelPoints": _truthy_map_count(record_data.get("FastTravelPointUnlockFlag")),
        "exploredAreas": _truthy_map_count(record_data.get("FindAreaFlagMap")),
        "fieldBosses": _truthy_map_count(record_data.get("NormalBossDefeatFlag")),
        "towerBosses": _truthy_map_count(record_data.get("TowerBossDefeatFlag")),
        "dungeonClears": _nonnegative_integer(record_data.get("FixedDungeonClearCount")),
        "oilRigClears": _nonnegative_integer(record_data.get("OilrigClearCount")),
        "technologyPoints": _nonnegative_integer(save_data.get("TechnologyPoint")),
        "ancientTechnologyPoints": _nonnegative_integer(save_data.get("bossTechnologyPoint")),
        "recipes": _property_list_count(save_data.get("UnlockedRecipeTechnologyNames")),
    }
    values = {key: value for key, value in candidates.items() if value is not None}
    unavailable = [key for key in _PLAYER_PROGRESS_FIELDS if key not in values]
    state = "unavailable" if not values else "partial" if unavailable else "complete"
    return {"state": state, "values": values, "unavailable": unavailable}


def _map_entries(value: object) -> list[tuple[object, object]] | None:
    current = _property(value)
    if isinstance(current, Mapping) and isinstance(current.get("values"), list):
        current = current["values"]
    if isinstance(current, Mapping):
        return list(current.items())
    if not isinstance(current, list):
        return None
    entries: list[tuple[object, object]] = []
    for item in current:
        if not isinstance(item, Mapping) or "value" not in item:
            return None
        entries.append((item.get("key"), item["value"]))
    return entries


def _truthy_map_count(value: object) -> int | None:
    entries = _map_entries(value)
    if entries is None:
        return None
    count = 0
    for _, raw in entries:
        current = _scalar(raw)
        if not isinstance(current, bool | int) or (
            isinstance(current, int) and current not in {0, 1}
        ):
            return None
        count += int(bool(current))
    return count


def _count_map_sum(value: object) -> int | None:
    entries = _map_entries(value)
    if entries is None:
        return None
    total = 0
    for _, raw in entries:
        current = _nonnegative_integer(raw)
        if current is None:
            return None
        total += current
    return total


def _nonnegative_integer(value: object) -> int | None:
    current = _scalar(value)
    if isinstance(current, bool) or not isinstance(current, int | float):
        return None
    integer = int(current)
    return integer if integer >= 0 and integer == current else None


def _property_list_count(value: object) -> int | None:
    current = _property(value)
    if isinstance(current, Mapping) and isinstance(current.get("values"), list):
        return len(current["values"])
    return len(current) if isinstance(current, list) else None


def _windows_ticks_iso(value: object) -> str | None:
    ticks = _nonnegative_integer(value)
    if ticks is None or ticks == 0:
        return None
    try:
        return (datetime(1, 1, 1, tzinfo=UTC) + timedelta(microseconds=ticks // 10)).isoformat()
    except OverflowError:
        return None


def _groups(entries: list[Any]) -> tuple[list[tuple[Any, ...]], dict[str, str]]:
    rows: list[tuple[Any, ...]] = []
    player_group: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        raw = _property(_mapping(entry.get("value")).get("RawData"))
        if not isinstance(raw, Mapping) or raw.get("group_type") != "EPalGroupType::Guild":
            continue
        group_id = _id(raw.get("group_id")) or _id(entry.get("key"))
        if not group_id:
            continue
        raw_members = raw.get("players")
        members: list[Any] = raw_members if isinstance(raw_members, list) else []
        for member in members:
            if isinstance(member, Mapping):
                member_id = _id(member.get("player_uid"))
                if member_id:
                    player_group[member_id] = group_id
        raw_base_ids = raw.get("base_ids")
        base_values: list[Any] = raw_base_ids if isinstance(raw_base_ids, list) else []
        base_ids = [_id(item) for item in base_values]
        base_ids = [item for item in base_ids if item]
        name = str(raw.get("guild_name") or raw.get("group_name") or "未命名工会")
        detail = {"baseIds": base_ids, "adminPlayerId": _id(raw.get("admin_player_uid"))}
        rows.append((group_id, name, len(members), len(base_ids), _json(detail)))
    return rows, player_group


def _bases(entries: list[Any]) -> tuple[list[tuple[Any, ...]], dict[str, str]]:
    rows: list[tuple[Any, ...]] = []
    worker_to_base: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        value = _mapping(entry.get("value"))
        raw = _property(value.get("RawData"))
        if not isinstance(raw, Mapping):
            continue
        base_id = _id(raw.get("id")) or _id(entry.get("key"))
        if not base_id:
            continue
        worker_struct = _property(value.get("WorkerDirector"))
        worker = (
            _property(worker_struct.get("RawData"))
            if isinstance(worker_struct, Mapping)
            else None
        )
        worker_id = _id(worker.get("container_id")) if isinstance(worker, Mapping) else None
        if worker_id:
            worker_to_base[worker_id] = base_id
        transform = raw.get("transform") if isinstance(raw.get("transform"), Mapping) else {}
        translation = transform.get("translation") if isinstance(transform, Mapping) else {}
        if not isinstance(translation, Mapping):
            translation = {}
        rows.append(
            (
                base_id,
                str(raw.get("name") or "未命名据点"),
                _nullable_id(raw.get("group_id_belong_to")),
                worker_id,
                _number(translation.get("x")),
                _number(translation.get("y")),
                _number(translation.get("z")),
                _json({"state": raw.get("state")}),
            )
        )
    return rows, worker_to_base


def _character_containers(
    entries: list[Any],
    worker_to_base: Mapping[str, str],
    profiles: Mapping[str, Mapping[str, Any]],
) -> tuple[list[tuple[Any, ...]], dict[str, tuple[str, int, str | None]]]:
    rows: list[tuple[Any, ...]] = []
    locations: dict[str, tuple[str, int, str | None]] = {}
    owner_by_container: dict[str, str] = {}
    kind_by_container: dict[str, str] = {}
    for player_id, profile in profiles.items():
        container_roles = (
            ("party_container_id", "pal_party"),
            ("storage_container_id", "pal_storage"),
        )
        for key, kind in container_roles:
            container_id = profile.get(key)
            if isinstance(container_id, str):
                owner_by_container[container_id] = player_id
                kind_by_container[container_id] = kind
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        container_id = _container_id(_mapping(entry.get("key")))
        if not container_id:
            continue
        slots = _list_property(_mapping(entry.get("value")).get("Slots"))
        base_id = worker_to_base.get(container_id)
        kind = "base_workers" if base_id else kind_by_container.get(container_id, "unassigned_pals")
        owner = owner_by_container.get(container_id)
        rows.append((container_id, kind, owner, None, base_id, len(slots)))
        for slot in slots:
            if not isinstance(slot, Mapping):
                continue
            raw = _property(slot.get("RawData"))
            if not isinstance(raw, Mapping):
                continue
            instance_id = _id(raw.get("instance_id"))
            if instance_id:
                locations[instance_id] = (
                    container_id,
                    int(_scalar(slot.get("SlotIndex")) or 0),
                    base_id,
                )
    return rows, locations


def _characters(
    entries: list[Any],
    profiles: Mapping[str, Mapping[str, Any]],
    player_group: Mapping[str, str],
    locations: Mapping[str, tuple[str, int, str | None]],
    world_metadata: WorldMetadataBundle | None,
) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
    players: list[tuple[Any, ...]] = []
    pals: list[tuple[Any, ...]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        key = _mapping(entry.get("key"))
        value = _mapping(entry.get("value"))
        raw = _property(value.get("RawData"))
        if not isinstance(raw, Mapping):
            continue
        save_parameter = _property(_mapping(raw.get("object")).get("SaveParameter"))
        if not isinstance(save_parameter, Mapping):
            continue
        player_id = _nullable_id(_property(key.get("PlayerUId")))
        instance_id = _id(_property(key.get("InstanceId")))
        if not instance_id:
            continue
        level = _integer(_scalar(save_parameter.get("Level")))
        nickname = _text(_scalar(save_parameter.get("NickName")))
        if bool(_scalar(save_parameter.get("IsPlayer"))):
            if not player_id:
                continue
            profile = profiles.get(player_id, {})
            name = nickname or _text(_scalar(key.get("DebugName"))) or "未命名玩家"
            players.append(
                (
                    player_id,
                    instance_id,
                    name,
                    level,
                    player_group.get(player_id) or _nullable_id(raw.get("group_id")),
                    _json(profile.get("inventory_ids", [])),
                    profile.get("party_container_id"),
                    profile.get("storage_container_id"),
                    _json(
                        {
                            "platform": profile.get("platform"),
                            "lastRecordedAt": profile.get("last_recorded_at"),
                            "progress": profile.get("progress")
                            or {
                                "state": "unavailable",
                                "values": {},
                                "unavailable": list(_PLAYER_PROGRESS_FIELDS),
                            },
                        }
                    ),
                )
            )
            continue
        character_id = _text(_scalar(save_parameter.get("CharacterID")))
        if not character_id:
            continue
        owner_id = _nullable_id(_scalar(save_parameter.get("OwnerPlayerUId"))) or player_id
        container_id: str | None = None
        slot_index: int | None = None
        base_id: str | None = None
        if instance_id in locations:
            container_id, slot_index, base_id = locations[instance_id]
        assignment = "base_worker" if base_id else ("player" if owner_id else "unassigned")
        gender = _scalar(save_parameter.get("Gender"))
        rank = _integer(_scalar(save_parameter.get("Rank")))
        character_id_upper = character_id.upper()
        is_boss = character_id_upper.startswith(("BOSS_", "GYM_"))
        is_boss = is_boss or character_id_upper.endswith("BOSS")
        is_lucky = bool(_scalar(save_parameter.get("IsRarePal")))
        species = world_metadata.pal(character_id) if world_metadata else None
        iv_hp = _save_number(save_parameter, "Talent_HP")
        iv_attack = _save_number(save_parameter, "Talent_Shot")
        iv_defense = _save_number(save_parameter, "Talent_Defense")
        iv_values = (iv_hp, iv_attack, iv_defense)
        iv_average = (
            sum(value for value in iv_values if value is not None) / 3
            if all(value is not None for value in iv_values)
            else None
        )
        work_suitabilities = species.work_suitabilities if species else {}
        care = _pal_care_fields(save_parameter, character_id)
        passive_skill_ids = _save_skill_ids(save_parameter, "PassiveSkillList")
        equipped_skill_ids = _save_skill_ids(save_parameter, "EquipWaza", "EquippedWaza")
        learned_skill_ids = _save_skill_ids(save_parameter, "MasteredWaza", "MasteredWazaList")
        passive_skills = _skill_presentations(passive_skill_ids, world_metadata, "passive")
        equipped_skills = _skill_presentations(equipped_skill_ids, world_metadata, "active")
        learned_skills = _skill_presentations(learned_skill_ids, world_metadata, "active")
        partner_skill = _partner_skill_presentation(species.partner_skill if species else None)
        pals.append(
            (
                instance_id,
                owner_id,
                character_id,
                nickname,
                level,
                container_id,
                slot_index,
                base_id,
                assignment,
                gender,
                rank,
                int(is_boss),
                int(is_lucky),
                species.rarity if species else None,
                iv_hp,
                iv_attack,
                iv_defense,
                iv_average,
                _json(work_suitabilities),
                int(species is not None),
                care["current_hp"],
                care["hunger"],
                care["sanity"],
                care["disease"],
                care["activity"],
                _json(passive_skill_ids),
                _json(equipped_skill_ids),
                _json(learned_skill_ids),
                _json(partner_skill),
                _json(
                    {
                        "gender": gender,
                        "rank": rank,
                        "isBoss": is_boss,
                        "isPredator": character_id.upper().startswith("PREDATOR_"),
                        "isLucky": is_lucky,
                        "isAwakened": bool(
                            _scalar(save_parameter.get("bIsAwakening"))
                        ),
                        "isImported": bool(
                            _scalar(save_parameter.get("bImportedCharacter"))
                        ),
                        "aptitude": {
                            "species_rarity": species.rarity if species else None,
                            "iv_hp": iv_hp,
                            "iv_attack": iv_attack,
                            "iv_defense": iv_defense,
                            "iv_average": iv_average,
                            "work_suitabilities": work_suitabilities,
                            "metadata_known": species is not None,
                        },
                        "care": care,
                        "skills": {
                            "passive": passive_skills,
                            "equipped": equipped_skills,
                            "learned": learned_skills,
                            "partner": partner_skill,
                        },
                    }
                ),
            )
        )
    return players, pals


def _save_skill_ids(save_parameter: Mapping[str, Any], *keys: str) -> list[str]:
    result: list[str] = []
    for key in keys:
        value = save_parameter.get(key)
        if value is None:
            continue
        for entry in _list_property(value):
            skill_id = _skill_id(entry)
            if skill_id and skill_id not in result:
                result.append(skill_id)
    return result


def _skill_id(value: Any) -> str | None:
    raw = _property(value)
    if isinstance(raw, Mapping):
        for key in ("WazaID", "SkillID", "PassiveSkillID", "ID", "id"):
            if key in raw:
                return _skill_id(raw[key])
        return None
    scalar = _scalar(raw)
    text = _text(scalar)
    if not text:
        return None
    normalized = text.rsplit("::", 1)[-1].strip()
    return normalized if normalized and normalized.casefold() != "none" else None


def _skill_presentations(
    skill_ids: Sequence[str], world_metadata: WorldMetadataBundle | None, kind: str
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for skill_id in skill_ids:
        metadata = world_metadata.skill(skill_id) if world_metadata else None
        if metadata is not None and metadata.get("kind") != kind:
            metadata = None
        name = _text(metadata.get("name")) if metadata else None
        result.append(
            {
                "id": skill_id,
                "name": name,
                "description": _text(metadata.get("description")) if metadata else None,
                "sourceName": _text(metadata.get("sourceName")) if metadata else None,
                "rank": _integer(metadata.get("rank")) if metadata else None,
                "element": _text(metadata.get("element")) if metadata else None,
                "power": _number(metadata.get("power")) if metadata else None,
                "cooldown": _number(metadata.get("cooldown")) if metadata else None,
                "metadataKnown": metadata is not None,
            }
        )
    return result


def _partner_skill_presentation(
    partner: Mapping[str, object] | None,
) -> dict[str, object] | None:
    if partner is None:
        return None
    return {
        "id": partner["id"],
        "name": _text(partner.get("name")),
        "description": _text(partner.get("description")),
        "sourceName": partner["sourceName"],
        "rank": None,
        "element": None,
        "power": None,
        "cooldown": None,
        "metadataKnown": True,
    }


def _pal_care_fields(
    save_parameter: Mapping[str, Any], character_id: str
) -> PalCareFields:
    status_raw = _first_present(save_parameter, "PalStatus")
    disease_raw = _first_present(
        save_parameter, "WorkerSick", "Disease", "PalDisease", "SickType"
    )
    physical_health_raw = _first_present(save_parameter, "PhysicalHealth")
    hunger_status_raw = _first_present(save_parameter, "HungerType")
    activity_raw = _first_present(
        save_parameter,
        "Activity",
        "PalActivity",
        "WorkState",
        "WorkStatus",
        "BaseCampWorkerEventType",
        "CurrentWorkSuitability",
    )
    status = _enum_text(status_raw)
    disease_value = _enum_text(disease_raw)
    activity_value = _enum_text(activity_raw)
    physical_health = _enum_text(physical_health_raw)
    if physical_health is None:
        physical_health = "EPalStatusPhysicalHealthType::Healthful"
    hunger_status = _enum_text(hunger_status_raw)
    if hunger_status is None:
        hunger_status = "EPalStatusHungerType::Default"
    if disease_value is not None and _enum_key(disease_value) in {"", "none", "normal", "healthy"}:
        disease_value = None
    if activity_value is not None and _enum_key(activity_value) in {"", "none"}:
        activity_value = None
    if disease_value is None and _is_disease_status(status):
        disease_value = status
    if activity_value is None and _is_activity_status(status):
        activity_value = status
    full_stomach = _save_number(save_parameter, "FullStomach")
    hunger_raw = full_stomach
    if hunger_raw is None:
        hunger_raw = _save_number(save_parameter, "Hunger", "FoodAmount", "Food")
    hunger_max = _save_number(save_parameter, "MaxFullStomach")
    if hunger_max is None:
        hunger_max = max_full_stomach(character_id)
    hunger = None
    # FullStomach is absolute; normalize it with an explicit saved maximum or
    # the pinned offline species maximum. Unknown species remain unavailable.
    if full_stomach is not None and hunger_max is not None and hunger_max > 0:
        hunger = min(100.0, max(0.0, full_stomach / hunger_max * 100.0))
    sanity = _save_number(save_parameter, "SanityValue", "Sanity", "SAN")
    if sanity is None:
        sanity = 100.0
    return {
        "current_hp": _save_hp(save_parameter),
        "hunger": hunger,
        "hunger_raw": hunger_raw,
        "hunger_status": hunger_status,
        "sanity": sanity,
        "physical_health": physical_health,
        "disease": disease_value,
        "activity": activity_value,
        # These sparse save properties omit their normal/default enum values.
        # Availability is a parser capability, not per-Pal key presence.
        "disease_recorded": True,
        "activity_recorded": True,
    }


def _first_present(values: Mapping[str, Any], *keys: str) -> Any:
    return next((values[key] for key in keys if key in values), None)


def _save_number(values: Mapping[str, Any], *keys: str) -> float | None:
    raw = _scalar(_first_present(values, *keys))
    number = _number(raw)
    if number is not None:
        return number
    if not isinstance(raw, Mapping):
        return None
    for key in ("Value", "Current", "CurrentValue", "value"):
        number = _number(_scalar(raw.get(key)))
        if number is not None:
            return number
    return None


def _save_hp(values: Mapping[str, Any]) -> float | None:
    for key in ("Hp", "HP", "CurrentHP", "Health"):
        if key not in values:
            continue
        number = _save_number(values, key)
        if number is None:
            return None
        raw = values[key]
        if isinstance(raw, Mapping) and raw.get("struct_type") == "FixedPoint64":
            return number / 1000.0
        return number
    return None


def _enum_text(value: Any) -> str | None:
    return _text(_scalar(value))


def _enum_key(value: str) -> str:
    return value.rsplit("::", 1)[-1].replace("_", "").replace("-", "").casefold()


def _is_activity_status(value: str | None) -> bool:
    activity_keys = {"work", "working", "rest", "resting", "lazy", "slacking", "idle"}
    return value is not None and _enum_key(value) in activity_keys


def _is_disease_status(value: str | None) -> bool:
    if value is None or _is_activity_status(value):
        return False
    return _enum_key(value) not in {"", "none", "normal", "healthy"}


def _pal_public_row(row: dict[str, Any]) -> dict[str, object]:
    result = _public_row(row)
    work = _mapping(result.pop("workSuitability", {}))
    result["aptitude"] = {
        "speciesRarity": result.pop("speciesRarity", None),
        "ivs": {
            "hp": result.pop("ivHp", None),
            "attack": result.pop("ivAttack", None),
            "defense": result.pop("ivDefense", None),
            "average": result.pop("ivAverage", None),
        },
        "workSuitabilities": [
            {"type": name, "level": int(level)}
            for name, level in sorted(
                work.items(), key=lambda item: (-int(item[1]), str(item[0]))
            )
            if isinstance(name, str) and isinstance(level, int | float)
        ],
        "metadataKnown": bool(result.pop("metadataKnown", False)),
        "metadataLabel": None
        if bool(row.get("metadata_known"))
        else "资料未收录",
    }
    result["care"] = _pal_care_status(result)
    skill_data = _mapping(_mapping(result.get("detail")).get("skills"))
    result["skills"] = {
        "passive": _skill_list(skill_data.get("passive")),
        "equipped": _skill_list(skill_data.get("equipped")),
        "learned": _skill_list(skill_data.get("learned")),
        "partner": _skill_record(skill_data.get("partner")),
    }
    return result


def _skill_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    return [record for item in value if (record := _skill_record(item)) is not None]


def _skill_record(value: object) -> dict[str, object] | None:
    record = _mapping(value)
    skill_id = _text(record.get("id"))
    if not skill_id:
        return None
    return {
        "id": skill_id,
        "name": _text(record.get("name")),
        "description": _text(record.get("description")),
        "sourceName": _text(record.get("sourceName")),
        "rank": _integer(record.get("rank")),
        "element": _text(record.get("element")),
        "power": _number(record.get("power")),
        "cooldown": _number(record.get("cooldown")),
        "metadataKnown": bool(record.get("metadataKnown")),
    }


def _unknown_skill(skill_id: str) -> dict[str, object]:
    return {
        "id": skill_id,
        "name": None,
        "description": None,
        "sourceName": None,
        "rank": None,
        "element": None,
        "power": None,
        "cooldown": None,
        "metadataKnown": False,
    }


def _json_loads(value: object) -> object:
    try:
        return json.loads(str(value))
    except (TypeError, ValueError):
        return {}


def _json_list(value: object) -> list[str]:
    parsed = _json_loads(value)
    return [item for item in parsed if isinstance(item, str)] if isinstance(parsed, list) else []


def _pal_care_status(row: Mapping[str, object]) -> dict[str, object]:
    current_hp = _number(row.get("currentHp"))
    hunger = _number(row.get("hunger"))
    sanity = _number(row.get("sanity"))
    disease = _text(row.get("disease"))
    activity = _text(row.get("activity"))
    detail = _mapping(row.get("detail"))
    stored_care = _mapping(detail.get("care"))
    hunger_raw = _number(stored_care.get("hunger_raw"))
    hunger_status = _text(stored_care.get("hunger_status"))
    physical_health = _text(stored_care.get("physical_health"))
    disease_recorded = bool(stored_care.get("disease_recorded"))
    activity_recorded = bool(stored_care.get("activity_recorded"))
    assessment = _assess_pal_care(
        {
            "current_hp": current_hp,
            "hunger": hunger,
            "sanity": sanity,
            "disease": disease,
            "activity": activity,
            "disease_recorded": disease_recorded,
            "activity_recorded": activity_recorded,
        }
    )
    return {
        "currentHp": current_hp,
        "hunger": hunger,
        "hungerRaw": hunger_raw,
        "hungerStatus": hunger_status,
        "sanity": sanity,
        "physicalHealth": physical_health,
        "disease": disease,
        "activity": activity,
        "diseaseRecorded": disease_recorded,
        "activityRecorded": activity_recorded,
        **assessment,
    }


def _assess_pal_care(signals: PalCareSignals) -> PalCareAssessment:
    reasons: list[PalCareReason] = []
    if signals["current_hp"] == 0:
        reasons.append("zero_hp")
    if signals["disease"] is not None:
        reasons.append("disease")
    if signals["hunger"] is not None and signals["hunger"] < 20:
        reasons.append("hunger_low")
    if signals["sanity"] is not None and signals["sanity"] < 50:
        reasons.append("san_low")
    availability: tuple[tuple[PalCareUnavailable, bool], ...] = (
        ("currentHp", signals["current_hp"] is not None),
        ("hunger", signals["hunger"] is not None),
        ("sanity", signals["sanity"] is not None),
        ("disease", signals["disease_recorded"]),
        ("activity", signals["activity_recorded"]),
    )
    unavailable = [
        key
        for key, available in availability
        if not available
    ]
    severity: PalCareSeverity = (
        "critical"
        if "zero_hp" in reasons or "disease" in reasons
        else "warning"
        if reasons
        else "unavailable"
        if unavailable
        else "info"
        if signals["activity"]
        else "healthy"
    )
    return {
        "reasons": reasons,
        "unavailable": unavailable,
        "severity": severity,
        "attention": bool(reasons),
    }


def query_pal_care_summary(path: Path) -> dict[str, int]:
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    try:
        rows = connection.execute(
            """
            SELECT current_hp, hunger, sanity, disease, activity,
                COALESCE(json_extract(detail_json, '$.care.disease_recorded'), 0),
                COALESCE(json_extract(detail_json, '$.care.activity_recorded'), 0)
            FROM pals
            """
        ).fetchall()
        assessments = [
            _assess_pal_care(
                {
                    "current_hp": _number(row[0]),
                    "hunger": _number(row[1]),
                    "sanity": _number(row[2]),
                    "disease": _text(row[3]),
                    "activity": _text(row[4]),
                    "disease_recorded": bool(row[5]),
                    "activity_recorded": bool(row[6]),
                }
            )
            for row in rows
        ]
        critical = sum(item["severity"] == "critical" for item in assessments)
        warning = sum(item["severity"] == "warning" for item in assessments)
        return {
            "total": len(rows),
            "critical": critical,
            "warning": warning,
            "attention": critical + warning,
            "unavailable": sum(bool(item["unavailable"]) for item in assessments),
        }
    finally:
        connection.close()


def _item_containers(
    entries: list[Any],
    profiles: Mapping[str, Mapping[str, Any]],
    bases: Sequence[tuple[Any, ...]],
    world_metadata: WorldMetadataBundle | None,
    map_object_containers: Mapping[
        str,
        tuple[
            str | None,
            str | None,
            float | None,
            float | None,
            float | None,
            str | None,
        ],
    ],
    guild_containers: Mapping[str, str | None],
) -> tuple[list[tuple[Any, ...]], list[tuple[Any, ...]]]:
    owner_by_container: dict[str, str] = {}
    for player_id, profile in profiles.items():
        for container_id in profile.get("inventory_ids", []):
            if isinstance(container_id, str):
                owner_by_container[container_id] = player_id
    base_ids = {str(row[0]) for row in bases}
    containers: list[tuple[Any, ...]] = []
    items: list[tuple[Any, ...]] = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        container_id = _container_id(_mapping(entry.get("key")))
        if not container_id:
            continue
        value = _mapping(entry.get("value"))
        belong = _property(value.get("BelongInfo"))
        guild_id = (
            _nullable_id(_property(belong.get("GroupId"))) if isinstance(belong, Mapping) else None
        )
        owner_id = owner_by_container.get(container_id) or _belong_id(
            belong, "PlayerUId", "PlayerUid", "player_uid", "owner_id"
        )
        map_object = map_object_containers.get(container_id)
        guild_container = container_id in guild_containers
        if guild_container:
            guild_id = guild_containers[container_id] or guild_id
        base_id = _belong_id(belong, "BaseId", "BaseCampId", "base_id", "base_camp_id")
        if base_id not in base_ids:
            base_id = None
        if base_id is None and map_object and map_object[5] in base_ids:
            base_id = map_object[5]
        kind = (
            "player_inventory"
            if owner_id
            else "guild_inventory"
            if guild_container
            else "base_inventory"
            if base_id
            else "world"
            if map_object
            else "unassigned"
        )
        slots = _list_property(value.get("Slots"))
        containers.append((container_id, kind, owner_id, guild_id, base_id, len(slots)))
        for slot in slots:
            if not isinstance(slot, Mapping):
                continue
            raw = _property(slot.get("RawData"))
            if not isinstance(raw, Mapping):
                continue
            item = raw.get("item") if isinstance(raw.get("item"), Mapping) else {}
            item_id = _text(item.get("static_id")) if isinstance(item, Mapping) else None
            quantity = _integer(raw.get("count")) or 0
            if not item_id or quantity <= 0:
                continue
            metadata = world_metadata.item(item_id) if world_metadata else None
            items.append(
                (
                    container_id,
                    _integer(raw.get("slot_index")) or 0,
                    item_id,
                    metadata.name if metadata else None,
                    metadata.category if metadata else None,
                    metadata.rarity if metadata else None,
                    metadata is not None and metadata.name is not None,
                    quantity,
                    kind,
                    owner_id,
                    guild_id,
                    base_id,
                    *(map_object[:5] if map_object else (None, None, None, None, None)),
                )
            )
    return containers, items


def _guild_item_containers(entries: list[Any]) -> dict[str, str | None]:
    result: dict[str, str | None] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        guild_id = _nullable_id(_property(entry.get("key")))
        value = _mapping(entry.get("value"))
        storage = _mapping(value.get("GuildItemStorage"))
        raw = _property(storage.get("RawData"))
        if not isinstance(raw, Mapping):
            continue
        container_id = _nullable_id(raw.get("container_id"))
        if container_id:
            result[container_id] = guild_id
    return result


def _map_object_item_containers(
    entries: list[Any],
) -> dict[
    str,
    tuple[
        str | None,
        str | None,
        float | None,
        float | None,
        float | None,
        str | None,
    ],
]:
    result: dict[
        str,
        tuple[
            str | None,
            str | None,
            float | None,
            float | None,
            float | None,
            str | None,
        ],
    ] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        map_object_type = _text(_scalar(entry.get("MapObjectId")))
        model = _mapping(entry.get("Model"))
        model_raw = _mapping(model.get("RawData"))
        instance_id = _nullable_id(model_raw.get("instance_id"))
        base_camp_id_belong_to = _nullable_id(model_raw.get("base_camp_id_belong_to"))
        x, y, z = _map_object_position(model_raw.get("initital_transform_cache"))
        concrete_model = _mapping(entry.get("ConcreteModel"))
        for module in _list_property(concrete_model.get("ModuleMap")):
            if not isinstance(module, Mapping):
                continue
            module_type = _text(_scalar(module.get("key"))) or _text(module.get("key"))
            if module_type != "EPalMapObjectConcreteModelModuleType::ItemContainer":
                continue
            module_value = _mapping(module.get("value"))
            raw = _mapping(module_value.get("RawData"))
            target_container_id = _nullable_id(raw.get("target_container_id"))
            if target_container_id:
                result[target_container_id] = (
                    map_object_type,
                    instance_id,
                    x,
                    y,
                    z,
                    base_camp_id_belong_to,
                )
    return result


def _map_object_position(value: object) -> tuple[float | None, float | None, float | None]:
    transform = _mapping(value)
    translation = _mapping(transform.get("translation"))
    return (
        _number(_scalar(translation.get("x"))),
        _number(_scalar(translation.get("y"))),
        _number(_scalar(translation.get("z"))),
    )


def _belong_id(value: object, *keys: str) -> str | None:
    belong = _mapping(value)
    for key in keys:
        if identifier := _nullable_id(_property(belong.get(key))):
            return identifier
    return None


def _validate_cache(connection: sqlite3.Connection, expected: Mapping[str, int]) -> None:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    if integrity is None or integrity[0] != "ok":
        raise ValueError("World cache integrity_check failed.")
    table_map = {
        "players": "players",
        "pals": "pals",
        "guilds": "guilds",
        "bases": "bases",
        "containers": "containers",
        "inventory_items": "inventory_items",
    }
    for key, table in table_map.items():
        actual = int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        if actual != int(expected.get(key, actual)):
            raise ValueError(f"World cache count mismatch for {key}.")
    merged = connection.execute(
        "SELECT COUNT(*) FROM bases GROUP BY id HAVING COUNT(*) > 1"
    ).fetchone()
    if merged is not None:
        raise ValueError("Duplicate stable Base ID detected.")


def _property(value: Any) -> Any:
    current = value
    while isinstance(current, Mapping) and "value" in current and (
        "type" in current or "struct_type" in current or "array_type" in current
    ):
        current = current["value"]
    return current


def _list_property(value: Any) -> list[Any]:
    current = _property(value)
    if isinstance(current, Mapping) and isinstance(current.get("values"), list):
        return list(current["values"])
    return list(current) if isinstance(current, list) else []


def _mapping(value: Any) -> Mapping[str, Any]:
    current = _property(value)
    return current if isinstance(current, Mapping) else {}


def _scalar(value: Any) -> Any:
    current = _property(value)
    if isinstance(current, Mapping) and set(current).issuperset({"type", "value"}):
        return current["value"]
    return current


def _container_id(value: Any) -> str | None:
    current = _property(value)
    if isinstance(current, Mapping):
        return _nullable_id(_property(current.get("ID")))
    return _nullable_id(current)


def _id(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, uuid.UUID):
        return str(value)
    text = str(value)
    return text if text and text != ZERO_UUID else None


def _nullable_id(value: Any) -> str | None:
    return _id(_scalar(value))


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _integer(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) and not isinstance(value, bool) else None


def _number(value: Any) -> float | None:
    return float(value) if isinstance(value, int | float) else None


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _public_row(row: dict[str, Any]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in row.items():
        public_key = _camel_case(key)
        if key.endswith("_json"):
            public_key = _camel_case(key[:-5])
            try:
                result[public_key] = json.loads(value) if value else {}
            except (json.JSONDecodeError, TypeError):
                result[public_key] = {}
        else:
            result[public_key] = value
    return result


def _add_player_profile_fields(row: dict[str, object]) -> None:
    detail = row.get("detail")
    profile = detail if isinstance(detail, Mapping) else {}
    progress = profile.get("progress")
    row["progress"] = (
        progress
        if isinstance(progress, Mapping)
        else {
            "state": "unavailable",
            "values": {},
            "unavailable": list(_PLAYER_PROGRESS_FIELDS),
        }
    )
    row["lastRecordedAt"] = profile.get("lastRecordedAt")


def _camel_case(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


def _table_columns(table: str) -> set[str]:
    return {
        "players": {"id", "guild_id"},
        "pals": {"owner_player_id", "base_id"},
        "guilds": {"id"},
        "bases": {"id", "guild_id"},
        "inventory_items": {"owner_id", "base_id"},
    }[table]
