from __future__ import annotations

import json
import sqlite3
import time
import uuid
from collections.abc import Mapping, Sequence
from contextlib import suppress
from pathlib import Path
from typing import Any

CACHE_SCHEMA_VERSION = 1
ZERO_UUID = "00000000-0000-0000-0000-000000000000"

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
    detail_json TEXT NOT NULL
);
CREATE INDEX pals_character_idx ON pals(character_id);
CREATE INDEX pals_owner_idx ON pals(owner_player_id);
CREATE INDEX pals_base_idx ON pals(base_id);
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


def build_world_cache(
    cache_path: Path,
    level_properties: Mapping[str, Any],
    player_properties: Sequence[Mapping[str, Any]],
    *,
    snapshot_id: str,
    source_observed_at: int,
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
            "schema_version": str(CACHE_SCHEMA_VERSION),
            "snapshot_id": snapshot_id,
            "source_observed_at": str(source_observed_at),
            "created_at": str(int(time.time())),
            "counts": json.dumps(counts, separators=(",", ":")),
        }
        connection.executemany("INSERT INTO cache_info(key, value) VALUES(?, ?)", metadata.items())
        connection.executemany(
            "INSERT INTO players VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", player_rows
        )
        connection.executemany(
            "INSERT INTO pals VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", pal_rows
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


def validate_cache_file(path: Path) -> dict[str, int]:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.suffix.casefold() != ".sqlite":
        raise ValueError("World cache must be a regular .sqlite file.")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro", uri=True)
    try:
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
    if search:
        clauses.append("(" + " OR ".join(f"{field} LIKE ?" for field in search_fields) + ")")
        parameters.extend([f"%{search}%"] * len(search_fields))
    for value, field in ((owner_id, filter_fields[0]), (base_id, filter_fields[1])):
        if value and field in _table_columns(table):
            clauses.append(f"{field} = ?")
            parameters.append(value)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    order = "name COLLATE NOCASE, id" if table in {"players", "guilds", "bases"} else "rowid"
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
        return [_public_row(dict(row)) for row in rows], total
    finally:
        connection.close()


def player_detail(path: Path, player_id: str) -> dict[str, object] | None:
    connection = sqlite3.connect(f"file:{path.resolve(strict=True).as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        row = connection.execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
        if row is None:
            return None
        result = _public_row(dict(row))
        result["pals"] = [
            _public_row(dict(item))
            for item in connection.execute(
                "SELECT * FROM pals WHERE owner_player_id = ? ORDER BY rowid LIMIT 200",
                (player_id,),
            ).fetchall()
        ]
        result["inventory"] = [
            _public_row(dict(item))
            for item in connection.execute(
                "SELECT * FROM inventory_items WHERE owner_id = ? "
                "ORDER BY container_id, slot_index LIMIT 200",
                (player_id,),
            ).fetchall()
        ]
        return result
    finally:
        connection.close()


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
                _json(
                    {
                        "gender": _scalar(save_parameter.get("Gender")),
                        "rank": _scalar(save_parameter.get("Rank")),
                    }
                ),
            )
        )
    return players, pals


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
