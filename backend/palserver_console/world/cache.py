from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from collections.abc import Mapping, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

from ..steam import is_reparse_point

CACHE_SCHEMA_NAME = "world-asset-cache"
CACHE_SCHEMA_VERSION = 5
ZERO_UUID = "00000000-0000-0000-0000-000000000000"


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
    current_hp REAL,
    hunger REAL,
    sanity REAL,
    disease TEXT,
    activity TEXT,
    detail_json TEXT NOT NULL
);
CREATE INDEX pals_character_idx ON pals(character_id);
CREATE INDEX pals_owner_idx ON pals(owner_player_id);
CREATE INDEX pals_base_idx ON pals(base_id);
CREATE INDEX pals_roster_name_idx ON pals(nickname COLLATE NOCASE, character_id, id);
CREATE INDEX pals_roster_level_idx ON pals(level DESC, id);
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
    quantity INTEGER NOT NULL,
    owner_kind TEXT NOT NULL,
    owner_id TEXT,
    guild_id TEXT,
    base_id TEXT
);
CREATE INDEX inventory_items_container_idx ON inventory_items(container_id, slot_index);
CREATE INDEX inventory_items_item_idx ON inventory_items(item_id);
CREATE INDEX inventory_items_base_idx ON inventory_items(base_id);
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
    base_camps = _list_property(world.get("BaseCampSaveData"))
    game_time_ticks = _game_time_ticks(world)

    group_rows, player_group = _groups(groups)
    base_rows, worker_container_to_base = _bases(base_camps)
    character_container_rows, instance_locations = _character_containers(
        character_containers, worker_container_to_base, player_profiles
    )
    player_rows, pal_rows = _characters(
        characters, player_profiles, player_group, instance_locations
    )
    item_container_rows, item_rows = _item_containers(
        item_containers, player_profiles, base_rows
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
            "INSERT INTO pals VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                container_id, slot_index, item_id, quantity, owner_kind,
                owner_id, guild_id, base_id
            ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
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


def query_pal_roster(
    path: Path,
    *,
    page: int,
    page_size: int,
    search: str | None,
    marker: str,
    sort: str,
    care: str = "all",
) -> tuple[list[dict[str, object]], int]:
    """Query the immutable cache in a stable roster order without loading all Pals."""

    if (
        marker not in {"all", "lucky", "boss"}
        or sort not in {"balanced", "name", "level"}
        or care not in {"all", "attention"}
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
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    name_order = "COALESCE(NULLIF(p.nickname, ''), p.character_id) COLLATE NOCASE, p.id"
    order = (
        "p.level IS NULL, p.level DESC, " + name_order
        if sort == "level"
        else name_order
    )
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
        }
    return profiles


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
                    _json({"platform": profile.get("platform")}),
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
        care = _pal_care_fields(save_parameter)
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
                care["current_hp"],
                care["hunger"],
                care["sanity"],
                care["disease"],
                care["activity"],
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
                        "care": care,
                    }
                ),
            )
        )
    return players, pals


def _pal_care_fields(save_parameter: Mapping[str, Any]) -> dict[str, object | None]:
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
    )
    status = _enum_text(status_raw)
    disease_value = _enum_text(disease_raw)
    activity_value = _enum_text(activity_raw)
    physical_health = _enum_text(physical_health_raw)
    hunger_status = _enum_text(hunger_status_raw)
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
    hunger = None
    # FullStomach is an absolute, species-dependent value; only expose a
    # percentage when the same record also provides its maximum.
    if full_stomach is not None and hunger_max is not None and hunger_max > 0:
        hunger = min(100.0, max(0.0, full_stomach / hunger_max * 100.0))
    return {
        "current_hp": _save_hp(save_parameter),
        "hunger": hunger,
        "hunger_raw": hunger_raw,
        "hunger_status": hunger_status,
        "sanity": _save_number(save_parameter, "SanityValue", "Sanity", "SAN"),
        "physical_health": physical_health,
        "disease": disease_value,
        "activity": activity_value,
        "disease_recorded": disease_raw is not None
        or (status_raw is not None and not _is_activity_status(status)),
        "activity_recorded": activity_raw is not None or _is_activity_status(status),
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
    result["care"] = _pal_care_status(result)
    return result


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
    reasons: list[str] = []
    if current_hp == 0:
        reasons.append("zero_hp")
    if disease is not None:
        reasons.append("disease")
    if hunger is not None and hunger < 20:
        reasons.append("hunger_low")
    if sanity is not None and sanity < 50:
        reasons.append("san_low")
    unavailable = [
        key
        for key, available in (
            ("currentHp", current_hp is not None),
            ("hunger", hunger is not None),
            ("sanity", sanity is not None),
            ("disease", disease_recorded),
            ("activity", activity_recorded),
        )
        if not available
    ]
    severity = (
        "critical"
        if "zero_hp" in reasons or "disease" in reasons
        else "warning"
        if reasons
        else "info"
        if activity
        else "unavailable"
        if unavailable
        else "healthy"
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
        "reasons": reasons,
        "unavailable": unavailable,
        "severity": severity,
        "attention": bool(reasons),
    }


def query_pal_care_summary(path: Path) -> dict[str, int]:
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    try:
        row = connection.execute(
            """
            SELECT
                COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN current_hp = 0 OR disease IS NOT NULL
                    THEN 1 ELSE 0 END), 0) AS critical,
                COALESCE(SUM(CASE WHEN current_hp != 0 AND disease IS NULL
                    AND (hunger < 20 OR sanity < 50) THEN 1 ELSE 0 END), 0) AS warning,
                COALESCE(SUM(CASE WHEN current_hp IS NULL OR hunger IS NULL
                    OR sanity IS NULL
                    OR COALESCE(json_extract(detail_json, '$.care.disease_recorded'), 0) = 0
                    OR COALESCE(json_extract(detail_json, '$.care.activity_recorded'), 0) = 0
                    THEN 1 ELSE 0 END), 0) AS unavailable
            FROM pals
            """
        ).fetchone()
        critical, warning = int(row[1]), int(row[2])
        return {
            "total": int(row[0]),
            "critical": critical,
            "warning": warning,
            "attention": critical + warning,
            "unavailable": int(row[3]),
        }
    finally:
        connection.close()


def _item_containers(
    entries: list[Any],
    profiles: Mapping[str, Mapping[str, Any]],
    bases: Sequence[tuple[Any, ...]],
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
        owner_id = owner_by_container.get(container_id)
        base_id = container_id if container_id in base_ids else None
        kind = "player_inventory" if owner_id else ("base_inventory" if base_id else "unassigned")
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
            items.append(
                (
                    container_id,
                    _integer(raw.get("slot_index")) or 0,
                    item_id,
                    quantity,
                    kind,
                    owner_id,
                    guild_id,
                    base_id,
                )
            )
    return containers, items


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
