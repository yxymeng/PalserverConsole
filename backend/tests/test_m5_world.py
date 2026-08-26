from __future__ import annotations

import errno
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

import palserver_console.world.cache as world_cache
from palserver_console.config import AppSettings, ProfileError, ServerProfileService
from palserver_console.main import create_app
from palserver_console.metadata import ItemMetadata, WorldMetadataBundle, WorldMetadataError
from palserver_console.persistence import Database
from palserver_console.world.adapter import read_save_properties, verify_stable_parse
from palserver_console.world.cache import (
    CACHE_SCHEMA_VERSION,
    WorldCacheSchemaError,
    build_world_cache,
    entity_detail,
    query_cache,
    query_inventory,
    query_inventory_location_groups,
    query_inventory_locations,
    query_pal_care_summary,
    query_pal_passive_skill_options,
    query_pal_roster,
    query_world_overview,
    read_cache_metadata,
    validate_cache_file,
)
from palserver_console.world.pal_care_species import max_full_stomach
from palserver_console.world.service import WorldDataError, WorldSnapshotService


def _profile_fixture(tmp_path: Path) -> tuple[Database, Path, Path, Path]:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    root = executable.parent / "Pal" / "Saved" / "SaveGames" / "0"
    worlds = []
    for world_id in ("world-a", "world-b"):
        world = root / world_id
        (world / "Players").mkdir(parents=True)
        (world / "Level.sav").write_bytes(world_id.encode())
        (world / "LevelMeta.sav").write_bytes(b"meta")
        worlds.append(world)
    database.set_setting("server.executable", str(executable))
    return database, executable, worlds[0], worlds[1]


def test_server_profile_is_explicit_and_stable_when_world_mtime_changes(tmp_path: Path) -> None:
    database, executable, selected, other = _profile_fixture(tmp_path)
    profiles = ServerProfileService(database)

    assert [item.world_id for item in profiles.candidates(executable)] == [
        "world-a",
        "world-b",
    ]
    bound = profiles.bind(executable, "world-a")
    assert bound.world_path == selected.resolve()

    os.utime(other / "Level.sav", ns=(9_000_000_000, 9_000_000_000))
    os.utime(selected / "Level.sav", ns=(1_000_000_000, 1_000_000_000))

    assert profiles.profile().world_id == "world-a"
    service = WorldSnapshotService(
        database,
        lambda: executable,
        tmp_path / "data",
        profile_provider=profiles.profile,
    )
    assert service._world_directory() == selected.resolve()

    selected.rename(tmp_path / "PalServer" / "Pal" / "Saved" / "SaveGames" / "0" / "moved")
    with pytest.raises(ProfileError) as error:
        profiles.profile()
    assert error.value.code == "WORLD_BINDING_INVALID"


def test_world_service_refuses_ambiguous_legacy_world_target(tmp_path: Path) -> None:
    database, executable, _, _ = _profile_fixture(tmp_path)
    service = WorldSnapshotService(database, lambda: executable, tmp_path / "data")

    with pytest.raises(WorldDataError) as error:
        service._world_directory()

    assert error.value.code == "WORLD_SELECTION_REQUIRED"


def test_world_id_path_traversal_is_rejected(tmp_path: Path) -> None:
    database, executable, _, _ = _profile_fixture(tmp_path)
    profiles = ServerProfileService(database)

    with pytest.raises(ProfileError) as error:
        profiles.bind(executable, "..\\outside")

    assert error.value.code == "INVALID_WORLD_ID"


def _property(value: Any, type_name: str = "StructProperty") -> dict[str, Any]:
    return {"type": type_name, "value": value}


def _container(container_id: uuid.UUID) -> dict[str, Any]:
    return _property({"ID": _property(container_id)})


def _character(
    player_id: uuid.UUID,
    instance_id: uuid.UUID,
    *,
    character_id: str | None,
    nickname: str,
    is_player: bool,
    gender: str | None = None,
    rank: int | None = None,
    is_rare: bool = False,
    is_awakened: bool = False,
    is_imported: bool = False,
    current_hp: float | None = None,
    hunger: float | None = None,
    sanity: float | None = None,
    disease: str | None = None,
    activity: str | None = None,
    save_parameter_fields: dict[str, Any] | None = None,
) -> dict[str, Any]:
    parameter: dict[str, Any] = {
        "Level": _property(20, "IntProperty"),
        "NickName": _property(nickname, "StrProperty"),
    }
    if is_player:
        parameter["IsPlayer"] = _property(True, "BoolProperty")
    elif character_id:
        parameter["CharacterID"] = _property(character_id, "NameProperty")
        parameter["OwnerPlayerUId"] = _property(player_id)
        if gender:
            parameter["Gender"] = _property(gender, "EnumProperty")
        if rank is not None:
            parameter["Rank"] = _property(rank, "IntProperty")
        if is_rare:
            parameter["IsRarePal"] = _property(True, "BoolProperty")
        if is_awakened:
            parameter["bIsAwakening"] = _property(True, "BoolProperty")
        if is_imported:
            parameter["bImportedCharacter"] = _property(True, "BoolProperty")
        if current_hp is not None:
            parameter["HP"] = _property(current_hp, "FloatProperty")
        if hunger is not None:
            parameter["FullStomach"] = _property(hunger, "FloatProperty")
            parameter["MaxFullStomach"] = _property(100.0, "FloatProperty")
        if sanity is not None:
            parameter["SanityValue"] = _property(sanity, "FloatProperty")
        if disease is not None:
            parameter["PalStatus"] = _property(disease, "EnumProperty")
        if activity is not None:
            parameter["Activity"] = _property(activity, "EnumProperty")
        if save_parameter_fields:
            parameter.update(save_parameter_fields)
    return {
        "key": {
            "PlayerUId": _property(player_id),
            "InstanceId": _property(instance_id),
            "DebugName": _property(nickname, "StrProperty"),
        },
        "value": {
            "RawData": _property(
                {
                    "object": {"SaveParameter": _property(parameter)},
                    "group_id": uuid.UUID(int=500),
                }
            )
        },
    }


def _synthetic_properties() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    player_id = uuid.UUID(int=1)
    base_a = uuid.UUID(int=101)
    base_b = uuid.UUID(int=102)
    workers_a = uuid.UUID(int=201)
    workers_b = uuid.UUID(int=202)
    inventory = uuid.UUID(int=301)
    pal_a = uuid.UUID(int=401)
    pal_b = uuid.UUID(int=402)
    player_instance = uuid.UUID(int=403)

    bases = []
    for base_id, workers, name in (
        (base_a, workers_a, "据点甲"),
        (base_b, workers_b, "据点乙"),
    ):
        bases.append(
            {
                "key": base_id,
                "value": {
                    "WorkerDirector": _property(
                        {"RawData": _property({"container_id": workers})}
                    ),
                    "RawData": _property(
                        {
                            "id": base_id,
                            "name": name,
                            "group_id_belong_to": uuid.UUID(int=500),
                            "state": 1,
                        }
                    ),
                },
            }
        )

    character_containers = []
    for container_id, instance_id in ((workers_a, pal_a), (workers_b, pal_b)):
        character_containers.append(
            {
                "key": {"ID": _property(container_id)},
                "value": {
                    "Slots": _property(
                        {
                            "values": [
                                {
                                    "SlotIndex": _property(0, "IntProperty"),
                                    "RawData": _property(
                                        {"player_uid": player_id, "instance_id": instance_id}
                                    ),
                                }
                            ]
                        },
                        "ArrayProperty",
                    )
                },
            }
        )

    level = {
        "worldSaveData": _property(
            {
                "CharacterSaveParameterMap": _property(
                    [
                        _character(
                            player_id,
                            player_instance,
                            character_id=None,
                            nickname="测试玩家",
                            is_player=True,
                        ),
                        _character(
                            player_id,
                            pal_a,
                            character_id="BOSS_SheepBall",
                            nickname="工作帕鲁甲",
                            is_player=False,
                            gender="EPalGenderType::Male",
                            rank=3,
                            is_rare=True,
                            is_awakened=True,
                            is_imported=True,
                            current_hp=0,
                            hunger=19.99,
                            sanity=49.99,
                            disease="EPalStatus::Cold",
                            activity="EPalActivity::Working",
                            save_parameter_fields={
                                "Talent_HP": _property(90, "ByteProperty"),
                                "Talent_Shot": _property(80, "ByteProperty"),
                                "Talent_Defense": _property(70, "ByteProperty"),
                            },
                        ),
                        _character(
                            player_id,
                            pal_b,
                            character_id="CatMage",
                            nickname="工作帕鲁乙",
                            is_player=False,
                            current_hp=100,
                            hunger=20,
                            sanity=50,
                            disease="EPalStatus::UnknownArchiveFever",
                            activity="EPalActivity::Resting",
                        ),
                    ],
                    "MapProperty",
                ),
                "ItemContainerSaveData": _property(
                    [
                        {
                            "key": {"ID": _property(inventory)},
                            "value": {
                                "BelongInfo": _property(
                                    {"GroupId": _property(uuid.UUID(int=500))}
                                ),
                                "Slots": _property(
                                    {
                                        "values": [
                                            {
                                                "RawData": _property(
                                                    {
                                                        "slot_index": 0,
                                                        "count": 3,
                                                        "item": {"static_id": "Wood"},
                                                    }
                                                )
                                            }
                                        ]
                                    },
                                    "ArrayProperty",
                                ),
                            },
                        }
                    ],
                    "MapProperty",
                ),
                "CharacterContainerSaveData": _property(
                    character_containers, "MapProperty"
                ),
                "GroupSaveDataMap": _property([], "MapProperty"),
                "BaseCampSaveData": _property(bases, "MapProperty"),
            }
        )
    }
    player = {
        "SaveData": _property(
            {
                "PlayerUId": _property(player_id),
                "InventoryInfo": _property({"CommonContainerId": _container(inventory)}),
            }
        )
    }
    return level, [player]


def _progress_map(values: dict[str, object]) -> dict[str, Any]:
    return _property(
        [
            {"key": _property(key, "NameProperty"), "value": _property(value)}
            for key, value in values.items()
        ],
        "MapProperty",
    )


def _complete_progress_save() -> dict[str, Any]:
    return {
        "RecordData": _property(
            {
                "PaldeckUnlockFlag": _progress_map({"SheepBall": True, "CatMage": False}),
                "PalCaptureCount": _progress_map({"SheepBall": 4, "CatMage": 3}),
                "FastTravelPointUnlockFlag": _progress_map({"Start": True, "Hill": True}),
                "FindAreaFlagMap": _progress_map({"Grassland": True}),
                "NormalBossDefeatFlag": _progress_map({"BOSS_1": True, "BOSS_2": False}),
                "TowerBossDefeatFlag": _progress_map({"TOWER_1": True, "TOWER_2": True}),
                "FixedDungeonClearCount": _property(5, "IntProperty"),
                "OilrigClearCount": _property(2, "IntProperty"),
            }
        ),
        "TechnologyPoint": _property(12, "IntProperty"),
        "bossTechnologyPoint": _property(3, "IntProperty"),
        "UnlockedRecipeTechnologyNames": _property(
            {"values": ["Arrow", "Flour", "Sphere"]}, "ArrayProperty"
        ),
    }


def test_synthetic_player_progress_distinguishes_complete_partial_missing_and_abnormal(
    tmp_path: Path,
) -> None:
    complete = world_cache._player_progress(_complete_progress_save())
    assert complete == {
        "state": "complete",
        "values": {
            "discoveredPalSpecies": 1,
            "capturedPals": 7,
            "fastTravelPoints": 2,
            "exploredAreas": 1,
            "fieldBosses": 1,
            "towerBosses": 2,
            "dungeonClears": 5,
            "oilRigClears": 2,
            "technologyPoints": 12,
            "ancientTechnologyPoints": 3,
            "recipes": 3,
        },
        "unavailable": [],
    }

    partial = world_cache._player_progress(
        {"TechnologyPoint": _property(0), "UnlockedRecipeTechnologyNames": _property([])}
    )
    assert partial["state"] == "partial"
    assert partial["values"] == {"technologyPoints": 0, "recipes": 0}
    assert "towerBosses" in cast(list[str], partial["unavailable"])

    missing = world_cache._player_progress({})
    assert missing["state"] == "unavailable"
    assert missing["values"] == {}

    abnormal = world_cache._player_progress(
        {
            "RecordData": _property(
                {
                    "PalCaptureCount": _progress_map({"SheepBall": -1}),
                    "TowerBossDefeatFlag": _property("not-a-map"),
                    "FixedDungeonClearCount": _property("many"),
                }
            ),
            "TechnologyPoint": _property(-4),
            "bossTechnologyPoint": _property(1.5),
            "UnlockedRecipeTechnologyNames": _property("Arrow"),
        }
    )
    assert abnormal["state"] == "unavailable"
    assert abnormal["values"] == {}

    level, players = _synthetic_properties()
    save_data = players[0]["SaveData"]["value"]
    save_data.update(_complete_progress_save())
    save_data["LastOnlineDateTime"] = _property(638_000_000_000_000_000, "Int64Property")
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    rows, total = query_cache(cache, "players", page=1, page_size=50)
    detail = entity_detail(cache, "players", str(uuid.UUID(int=1)))
    assert total == 1
    assert rows[0]["progress"] == complete
    assert rows[0]["lastRecordedAt"]
    assert detail is not None
    assert detail["progress"] == complete


def test_cache_keeps_stable_bases_separate_and_paginates(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    level["worldSaveData"]["value"]["GameTimeSaveData"] = _property(
        {"GameDateTimeTicks": _property(172_800_000_000, "Int64Property")}
    )
    cache = tmp_path / "world-cache.sqlite"
    counts = build_world_cache(
        cache, level, players, snapshot_id="fixture", source_observed_at=1
    )

    assert counts["bases"] == 2
    assert counts["work_pals"] == 2
    assert read_cache_metadata(cache)["game_time_ticks"] == "172800000000"
    bases, base_total = query_cache(cache, "bases", page=1, page_size=1)
    work_pals, work_total = query_cache(cache, "work-pals", page=1, page_size=50)
    assert base_total == 2
    assert len(bases) == 1
    assert work_total == 2
    assert {item["baseId"] for item in work_pals} == {
        str(uuid.UUID(int=101)),
        str(uuid.UUID(int=102)),
    }


def test_inventory_aggregates_slots_and_preserves_unknown_items(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    level, players = _synthetic_properties()
    containers = level["worldSaveData"]["value"]["ItemContainerSaveData"]["value"]
    base_id = uuid.UUID(int=101)
    base_container = uuid.UUID(int=302)
    containers.append(
        {
            "key": {"ID": _property(base_container)},
            "value": {
                "BelongInfo": _property({"BaseId": _property(base_id)}),
                "Slots": _property(
                    {
                        "values": [
                            {
                                "RawData": _property(
                                    {"slot_index": 0, "count": 7, "item": {"static_id": "Wood"}}
                                )
                            },
                            {
                                "RawData": _property(
                                    {"slot_index": 1, "count": 2, "item": {"static_id": "Wood"}}
                                )
                            },
                            {
                                "RawData": _property(
                                    {
                                        "slot_index": 2,
                                        "count": 4,
                                        "item": {"static_id": "FutureOre"},
                                    }
                                )
                            },
                            {
                                "RawData": _property(
                                    {"slot_index": 3, "count": 0, "item": {"static_id": "Empty"}}
                                )
                            },
                        ]
                    },
                    "ArrayProperty",
                ),
            },
        }
    )
    metadata = WorldMetadataBundle(
        data_version="test-items",
        source_revision="a" * 40,
        pals={},
        skills={},
        items={
            "Wood": ItemMetadata(name="木材", category="材料", rarity="普通"),
            "FutureOre": ItemMetadata(name=None, category="矿石", rarity="稀有"),
        },
        _pals_casefold={},
        _skills_casefold={},
        _items_casefold={
            "wood": ItemMetadata(name="木材", category="材料", rarity="普通"),
            "futureore": ItemMetadata(name=None, category="矿石", rarity="稀有"),
        },
    )
    monkeypatch.setattr(world_cache, "load_world_metadata", lambda: metadata)
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, total, categories = query_inventory(
        cache,
        page=1,
        page_size=1,
        search=None,
        category=None,
        scope="all",
        owner_id=None,
        base_id=None,
        sort="quantity",
    )
    assert total == 2
    assert categories == ["材料", "矿石"]
    assert items == [
        {
            "itemId": "Wood",
            "name": "木材",
            "category": "材料",
            "rarity": "普通",
            "metadataKnown": True,
            "metadataLabel": None,
            "totalQuantity": 12,
            "locationCount": 3,
        }
    ]
    locations, location_total = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="all",
        owner_id=None,
        base_id=None,
    )
    assert location_total == 3
    assert sum(cast(int, item["quantity"]) for item in locations) == items[0]["totalQuantity"]
    assert {item["locationType"] for item in locations} == {"player", "base"}
    assert all(item["containerId"] for item in locations)

    player_items, player_total, _ = query_inventory(
        cache,
        page=1,
        page_size=60,
        search="木材",
        category="材料",
        scope="player",
        owner_id=str(uuid.UUID(int=1)),
        base_id=None,
        sort="name",
    )
    assert player_total == 1
    assert player_items[0]["totalQuantity"] == 3
    unknown_items, unknown_total, _ = query_inventory(
        cache,
        page=1,
        page_size=60,
        search="FutureOre",
        category="矿石",
        scope="base",
        owner_id=None,
        base_id=str(base_id),
        sort="name",
    )
    assert unknown_total == 1
    assert unknown_items[0]["name"] is None
    assert unknown_items[0]["category"] == "矿石"
    assert unknown_items[0]["rarity"] == "稀有"
    assert unknown_items[0]["metadataKnown"] is False
    assert unknown_items[0]["metadataLabel"] == "资料未收录"
    metadata_unknown, metadata_unknown_total, _ = query_inventory(
        cache,
        page=1,
        page_size=60,
        search=None,
        category=None,
        scope="all",
        owner_id=None,
        base_id=None,
        sort="name",
        metadata="unknown",
    )
    assert metadata_unknown_total == 1
    assert [item["itemId"] for item in metadata_unknown] == ["FutureOre"]
    empty_items, empty_total, empty_categories = query_inventory(
        cache,
        page=1,
        page_size=60,
        search=None,
        category=None,
        scope="player",
        owner_id="missing-player",
        base_id=None,
        sort="name",
    )
    assert empty_items == []
    assert empty_total == 0
    assert empty_categories == []


def test_world_overview_aggregates_assets_and_actionable_counts(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    with sqlite3.connect(cache) as connection:
        connection.execute("UPDATE pals SET is_lucky = 0, is_boss = 0")
        connection.execute(
            "UPDATE pals SET is_lucky = 1, is_boss = 1, metadata_known = 0, "
            "owner_player_id = NULL, base_id = NULL WHERE id = (SELECT id FROM pals LIMIT 1)"
        )
        connection.execute("UPDATE inventory_items SET metadata_known = 0")

    overview = query_world_overview(cache)
    assets = cast(dict[str, int], overview["assets"])
    actions = cast(dict[str, int], overview["actions"])

    assert assets == {
        "players": 1,
        "pals": 2,
        "palSpecies": 2,
        "itemTypes": 1,
        "itemQuantity": 3,
        "bases": 2,
        "guilds": 0,
    }
    assert actions["luckyPals"] == 1
    assert actions["bossPals"] == 1
    assert actions["unassignedPals"] >= 1
    assert actions["unknownItems"] == 1
    assert actions["unknownPalMetadata"] >= 1


def test_inventory_world_locations_scopes_and_group_summaries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    level, players = _synthetic_properties()
    world = level["worldSaveData"]["value"]
    containers = world["ItemContainerSaveData"]["value"]
    base_id = uuid.UUID(int=101)
    base_container = uuid.UUID(int=302)
    world_container_a = uuid.UUID(int=401)
    world_container_b = uuid.UUID(int=402)
    unassigned_container = uuid.UUID(int=403)
    map_object_base_container = uuid.UUID(int=404)
    guild_container = uuid.UUID(int=405)
    guild_id = uuid.UUID(int=500)
    player_container = uuid.UUID(int=201)

    def add_container(
        container_id: uuid.UUID,
        counts: list[int],
        belong: dict[str, Any] | None = None,
    ) -> None:
        containers.append(
            {
                "key": {"ID": _property(container_id)},
                "value": {
                    "BelongInfo": _property(belong or {}),
                    "Slots": _property(
                        {
                            "values": [
                                {
                                    "RawData": _property(
                                        {
                                            "slot_index": index,
                                            "count": count,
                                            "item": {"static_id": "Wood"},
                                        }
                                    )
                                }
                                for index, count in enumerate(counts)
                            ]
                        },
                        "ArrayProperty",
                    ),
                },
            }
        )

    add_container(base_container, [7, 2], {"BaseId": _property(base_id)})
    add_container(world_container_a, [2, 3])
    add_container(world_container_b, [1])
    add_container(unassigned_container, [4])
    add_container(guild_container, [6])
    add_container(
        map_object_base_container,
        [5],
        {"GroupId": _property(uuid.UUID(int=500))},
    )

    def map_object(
        map_object_type: str,
        instance_id: uuid.UUID,
        target_container_id: uuid.UUID,
        base_camp_id_belong_to: uuid.UUID | None = None,
    ) -> dict[str, Any]:
        return {
            "MapObjectId": _property(map_object_type, "NameProperty"),
            "Model": _property(
                {
                    "RawData": _property(
                        {
                            "instance_id": instance_id,
                            "base_camp_id_belong_to": base_camp_id_belong_to,
                        }
                    )
                }
            ),
            "ConcreteModel": _property(
                {
                    "ModuleMap": _property(
                        [
                            {
                                "key": "EPalMapObjectConcreteModelModuleType::ItemContainer",
                                "value": {
                                    "RawData": _property(
                                        {"target_container_id": target_container_id}
                                    )
                                },
                            }
                        ],
                        "MapProperty",
                    )
                }
            ),
        }

    world["MapObjectSaveData"] = _property(
        {
            "values": [
                map_object(
                    "TreasureBox",
                    uuid.UUID(int=501),
                    world_container_a,
                    uuid.UUID(int=0),
                ),
                map_object(
                    "TreasureBox_RequiredLongHold",
                    uuid.UUID(int=502),
                    world_container_b,
                    uuid.UUID(int=999),
                ),
                # Exact MapObject references never override an established player/base owner.
                map_object(
                    "TreasureBox", uuid.UUID(int=503), player_container, base_id
                ),
                map_object("TreasureBox", uuid.UUID(int=504), base_container),
                map_object(
                    "StorageBox",
                    uuid.UUID(int=505),
                    map_object_base_container,
                    base_id,
                ),
            ]
        },
        "ArrayProperty",
    )
    world["GuildExtraSaveDataMap"] = _property(
        [
            {
                "key": guild_id,
                "value": {
                    "GuildItemStorage": _property(
                        {"RawData": _property({"container_id": guild_container})}
                    )
                },
            }
        ],
        "MapProperty",
    )
    metadata = WorldMetadataBundle(
        data_version="test-items",
        source_revision="a" * 40,
        pals={},
        skills={},
        items={"Wood": ItemMetadata(name="木材", category="材料", rarity="普通")},
        _pals_casefold={},
        _skills_casefold={},
        _items_casefold={
            "wood": ItemMetadata(name="木材", category="材料", rarity="普通")
        },
    )
    monkeypatch.setattr(world_cache, "load_world_metadata", lambda: metadata)
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    expected = {
        "inventory": (23, 5),
        "player": (3, 1),
        "base": (14, 3),
        "world": (6, 3),
        "all": (33, 9),
    }
    for scope, (quantity, location_count) in expected.items():
        items, total, _ = query_inventory(
            cache,
            page=1,
            page_size=60,
            search=None,
            category=None,
            scope=scope,
            owner_id=None,
            base_id=None,
            sort="name",
        )
        assert total == 1
        assert items[0]["totalQuantity"] == quantity
        assert items[0]["locationCount"] == location_count

    groups = query_inventory_location_groups(
        cache, "Wood", scope="all", owner_id=None, base_id=None
    )
    assert [group["locationType"] for group in groups] == [
        "player",
        "base",
        "guild",
        "world",
        "unassigned",
    ]
    assert sum(cast(int, group["quantitySum"]) for group in groups) == 33
    assert groups[2]["label"] == "公会仓库"
    assert groups[2]["groupId"] == str(guild_id)
    assert groups[2]["quantitySum"] == 6
    assert groups[3]["label"] == "其他位置"
    assert groups[3]["quantitySum"] == 6
    assert groups[3]["locationCount"] == 3
    assert groups[3]["containerCount"] == 2
    assert groups[4]["label"] == "未识别位置"

    world_locations, world_total = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="world",
        owner_id=None,
        base_id=None,
    )
    assert world_total == 3
    assert {location["locationType"] for location in world_locations} == {"world"}
    assert {location["locationLabel"] for location in world_locations} == {"世界宝箱"}
    assert {location["mapObjectType"] for location in world_locations} == {
        "TreasureBox",
        "TreasureBox_RequiredLongHold",
    }
    assert all(location["mapObjectInstanceId"] for location in world_locations)

    guild_locations, guild_total = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="inventory",
        owner_id=None,
        base_id=None,
        location_type="guild",
        group_id=str(guild_id),
    )
    assert guild_total == 1
    assert guild_locations[0]["locationType"] == "guild"
    assert guild_locations[0]["locationLabel"] == "公会仓库"
    assert guild_locations[0]["containerId"] == str(guild_container)

    unassigned_locations, unassigned_total = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="all",
        owner_id=None,
        base_id=None,
        location_type="unassigned",
    )
    assert unassigned_total == 1
    assert unassigned_locations[0]["containerId"] == str(unassigned_container)

    base_locations, base_total = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="base",
        owner_id=None,
        base_id=None,
    )
    assert base_total == 3
    map_object_base_location = next(
        location
        for location in base_locations
        if location["containerId"] == str(map_object_base_container)
    )
    assert map_object_base_location["locationType"] == "base"
    assert map_object_base_location["baseId"] == str(base_id)
    assert map_object_base_location["baseName"] == "据点甲"

    player_locations, _ = query_inventory_locations(
        cache,
        "Wood",
        page=1,
        page_size=100,
        scope="player",
        owner_id=None,
        base_id=None,
    )
    assert player_locations[0]["locationType"] == "player"


def test_lists_include_linked_relation_names(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    player_id = str(uuid.UUID(int=300))
    guild_id = str(uuid.UUID(int=500))
    with sqlite3.connect(cache) as connection:
        connection.execute(
            "INSERT INTO guilds VALUES(?, ?, ?, ?, ?)",
            (guild_id, "测试工会", 1, 0, "{}"),
        )
        connection.execute("UPDATE players SET guild_id = ? WHERE id = ?", (guild_id, player_id))

    rows, total = query_cache(cache, "players", page=1, page_size=50)
    bases, base_total = query_cache(cache, "bases", page=1, page_size=50)

    assert total == 1
    assert rows[0]["guildName"] == "测试工会"
    assert base_total == 2
    assert {row["guildName"] for row in bases} == {"测试工会"}


def test_base_and_guild_asset_details_use_only_stable_relations(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    guild_id = str(uuid.UUID(int=500))
    empty_guild_id = str(uuid.UUID(int=501))
    missing_guild_id = str(uuid.UUID(int=999))
    base_a = str(uuid.UUID(int=101))
    base_b = str(uuid.UUID(int=102))
    missing_base = str(uuid.UUID(int=103))
    player_id = str(uuid.UUID(int=1))
    missing_player = str(uuid.UUID(int=777))
    with sqlite3.connect(cache) as connection:
        connection.execute(
            "INSERT INTO guilds VALUES(?, ?, ?, ?, ?)",
            (
                guild_id,
                "测试公会",
                2,
                2,
                json.dumps(
                    {
                        "memberIds": [player_id, missing_player],
                        "baseIds": [base_a, "missing-base"],
                    }
                ),
            ),
        )
        connection.execute(
            "INSERT INTO guilds VALUES(?, ?, ?, ?, ?)",
            (empty_guild_id, "空公会", 0, 0, json.dumps({"memberIds": [], "baseIds": []})),
        )
        connection.execute("UPDATE players SET guild_id = ? WHERE id = ?", (guild_id, player_id))
        connection.execute("UPDATE bases SET guild_id = NULL WHERE id = ?", (base_b,))
        connection.execute(
            "INSERT INTO bases VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            (missing_base, "关联缺失据点", missing_guild_id, None, 10.0, 20.0, 30.0, "{}"),
        )
        inventory_columns = (
            "container_id, slot_index, item_id, item_name, item_category, item_rarity, "
            "metadata_known, quantity, owner_kind, owner_id, guild_id, base_id, "
            "map_object_type, map_object_instance_id, world_x, world_y, world_z"
        )
        inventory_insert = (
            f"INSERT INTO inventory_items({inventory_columns}) "
            f"VALUES({', '.join('?' for _ in range(17))})"
        )
        connection.execute(
            inventory_insert,
            (
                "base-items", 0, "Stone", "石头", "Material", "Common", 1, 7,
                "base_inventory", None, guild_id, base_a, None, None, None, None, None,
            ),
        )
        connection.execute(
            inventory_insert,
            (
                "guild-items", 0, "Wood", "木材", "Material", "Common", 1, 5,
                "guild_inventory", None, guild_id, None, None, None, None, None, None,
            ),
        )

    base_detail = entity_detail(cache, "bases", base_a)
    unassigned_base = entity_detail(cache, "bases", base_b)
    unavailable_base = entity_detail(cache, "bases", missing_base)
    guild_detail = entity_detail(cache, "guilds", guild_id)
    empty_guild = entity_detail(cache, "guilds", empty_guild_id)
    guild_items, guild_item_types, _ = query_inventory(
        cache,
        page=1,
        page_size=60,
        search=None,
        category=None,
        scope="inventory",
        owner_id=None,
        base_id=None,
        guild_id=guild_id,
        sort="name",
    )

    assert base_detail is not None
    assert base_detail["guildAssociation"] == "linked"
    assert base_detail["workerCount"] == 1
    assert base_detail["careSummary"] == {
        "total": 1, "critical": 1, "warning": 0, "attention": 1, "unavailable": 0
    }
    assert base_detail["inventorySummary"] == {
        "itemTypeCount": 1, "totalQuantity": 7, "locationCount": 1
    }
    assert unassigned_base is not None and unassigned_base["guildAssociation"] == "unassigned"
    assert unavailable_base is not None and unavailable_base["guildAssociation"] == "unavailable"
    assert unavailable_base["guild"] is None

    assert guild_detail is not None
    assert guild_detail["assetSummary"] == {
        "memberCount": 1,
        "baseCount": 1,
        "palCount": 2,
        "inventory": {"itemTypeCount": 2, "totalQuantity": 15, "locationCount": 3},
    }
    assert guild_detail["missingMemberIds"] == [missing_player]
    assert guild_detail["missingBaseIds"] == ["missing-base"]
    assert {item["id"] for item in cast(list[dict[str, Any]], guild_detail["pals"])} == {
        str(uuid.UUID(int=401)), str(uuid.UUID(int=402))
    }
    assert guild_item_types == 2
    assert sum(cast(int, item["totalQuantity"]) for item in guild_items) == 15
    assert empty_guild is not None
    assert empty_guild["assetSummary"] == {
        "memberCount": 0,
        "baseCount": 0,
        "palCount": 0,
        "inventory": {"itemTypeCount": 0, "totalQuantity": 0, "locationCount": 0},
    }


def test_player_status_filter_and_sort_apply_before_pagination(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    player_id = str(uuid.UUID(int=1))
    guild_id = str(uuid.UUID(int=500))
    second_player_id = str(uuid.UUID(int=301))
    with sqlite3.connect(cache) as connection:
        connection.execute(
            "INSERT INTO guilds VALUES(?, ?, ?, ?, ?)",
            (guild_id, "测试工会", 1, 0, "{}"),
        )
        connection.execute("UPDATE players SET guild_id = ? WHERE id = ?", (guild_id, player_id))
        connection.execute(
            "INSERT INTO players VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (second_player_id, "instance-2", "高级玩家", 50, None, "[]", None, None, "{}"),
        )

    guilded, guilded_total = query_cache(
        cache, "players", page=1, page_size=1, status="guilded", sort="name"
    )
    unguilded, unguilded_total = query_cache(
        cache, "players", page=1, page_size=1, status="unguilded", sort="name"
    )
    sorted_rows, sorted_total = query_cache(
        cache, "players", page=1, page_size=1, sort="level-desc"
    )

    assert guilded_total == 1
    assert guilded[0]["id"] == player_id
    assert unguilded_total == 1
    assert unguilded[0]["id"] == second_player_id
    assert sorted_total == 2
    assert sorted_rows[0]["id"] == second_player_id


def test_pal_list_includes_owner_base_names_and_display_traits(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    rows, total = query_cache(cache, "pals", page=1, page_size=50)
    boss = next(row for row in rows if row["characterId"] == "BOSS_SheepBall")

    assert total == 2
    assert boss["ownerName"] == "测试玩家"
    assert boss["baseName"] == "据点甲"
    detail = cast(dict[str, Any], boss["detail"])
    skills = detail.pop("skills")
    assert detail == {
        "gender": "EPalGenderType::Male",
        "rank": 3,
        "isBoss": True,
        "isPredator": False,
        "isLucky": True,
        "isAwakened": True,
        "isImported": True,
        "aptitude": {
            "species_rarity": 5,
            "iv_hp": 90.0,
            "iv_attack": 80.0,
            "iv_defense": 70.0,
            "iv_average": 80.0,
            "work_suitabilities": {
                "Handcraft": 1,
                "MonsterFarm": 1,
                "Transport": 1,
            },
            "metadata_known": True,
        },
        "care": {
            "current_hp": 0.0,
            "hunger": 19.99,
            "hunger_raw": 19.99,
            "hunger_status": "EPalStatusHungerType::Default",
            "sanity": 49.99,
            "physical_health": "EPalStatusPhysicalHealthType::Healthful",
            "disease": "EPalStatus::Cold",
            "activity": "EPalActivity::Working",
            "disease_recorded": True,
            "activity_recorded": True,
        },
    }
    assert skills == {
        "passive": [],
        "equipped": [],
        "learned": [],
        "partner": {
            "id": "Fluffy Shield",
            "name": None,
            "description": (
                "When activated, equips to the player and becomes a shield. "
                "Sometimes drops Wool when assigned to Ranch."
            ),
            "sourceName": "Fluffy Shield",
            "rank": None,
            "element": None,
            "power": None,
            "cooldown": None,
            "metadataKnown": True,
        },
    }


def test_pal_roster_queries_are_paged_stable_and_keep_unknown_records(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    with sqlite3.connect(cache) as connection:
        connection.execute("DELETE FROM pals")
    empty, empty_total = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced"
    )
    assert empty == []
    assert empty_total == 0

    def rows(start: int, stop: int) -> list[tuple[object, ...]]:
        return [
            (
                f"pal-{index:05d}", None, "FuturePal" if index == 1_599 else "SheepBall",
                f"名册-{index:05d}", index % 50, None, None, None, "unassigned",
                    "EPalGenderType::Male", index % 5, int(index % 97 == 0), int(index % 89 == 0),
                    None if index == 1_599 else 1,
                    float(index % 101), float(index % 101), float(index % 101), float(index % 101),
                    "{}" if index == 1_599 else '{"Handcraft":1}',
                    0 if index == 1_599 else 1,
                        None, None, None, None, None, "[]", "[]", "[]", "null", "{}",
            )
            for index in range(start, stop)
        ]

    with sqlite3.connect(cache) as connection:
        connection.executemany(
            "INSERT INTO pals VALUES(" + ", ".join("?" for _ in range(30)) + ")",
            rows(0, 1_600),
        )
    first_1600, total_1600 = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced"
    )
    assert total_1600 == 1_600
    assert len(first_1600) == 60
    assert first_1600 == query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced"
    )[0]
    unknown, unknown_total = query_pal_roster(
        cache, page=1, page_size=60, search="FuturePal", marker="all", sort="balanced"
    )
    assert unknown_total == 1
    assert unknown[0]["id"] == "pal-01599"
    assert unknown[0]["locationType"] == "unassigned"
    assert cast(dict[str, Any], unknown[0]["aptitude"])["metadataLabel"] == "资料未收录"
    unassigned, unassigned_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="balanced",
        location="unassigned",
    )
    assert unassigned_total == 1_600
    assert all(item["locationType"] == "unassigned" for item in unassigned)

    with sqlite3.connect(cache) as connection:
        connection.executemany(
            "INSERT INTO pals VALUES(" + ", ".join("?" for _ in range(30)) + ")",
            rows(1_600, 5_000),
        )
    level_page, total_5000 = query_pal_roster(
        cache, page=2, page_size=60, search=None, marker="all", sort="level"
    )
    lucky, lucky_total = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="lucky", sort="balanced"
    )
    assert total_5000 == 5_000
    assert len(level_page) == 60
    assert all(item["isLucky"] for item in lucky)
    assert lucky_total > 0


def test_pal_roster_exposes_and_filters_aptitude_with_all_work_semantics(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache-aptitude.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="averageIv",
    )
    assert total == 2
    boss_aptitude = cast(dict[str, Any], items[0]["aptitude"])
    assert boss_aptitude == {
        "speciesRarity": 5,
        "ivs": {"hp": 90.0, "attack": 80.0, "defense": 70.0, "average": 80.0},
        "workSuitabilities": [
            {"type": "Handcraft", "level": 1},
            {"type": "MonsterFarm", "level": 1},
            {"type": "Transport", "level": 1},
        ],
        "metadataKnown": True,
        "metadataLabel": None,
    }

    rare, rare_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="rarity",
        min_rarity=6,
    )
    assert rare_total == 1 and rare[0]["characterId"] == "CatMage"
    ivs, iv_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="averageIv",
        min_hp_iv=90,
        min_attack_iv=80,
        min_defense_iv=70,
        min_average_iv=80,
    )
    assert iv_total == 1 and ivs[0]["characterId"] == "BOSS_SheepBall"
    work, work_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="workSuitability",
        work_suitabilities=("Handcraft", "ProductMedicine"),
        min_work_level=3,
    )
    assert work_total == 1 and work[0]["characterId"] == "CatMage"
    none, none_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="workSuitability",
        work_suitabilities=("Handcraft", "ProductMedicine", "Transport"),
        min_work_level=3,
    )
    assert none == [] and none_total == 0


def test_pal_skills_keep_unknowns_and_filter_by_all_selected_passives(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    characters = level["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]
    save_parameter = characters[1]["value"]["RawData"]["value"]["object"]["SaveParameter"]["value"]
    save_parameter["PassiveSkillList"] = _property(
        [_property("Legend", "NameProperty"), _property("MoveSpeed_up_2", "NameProperty")],
        "ArrayProperty",
    )
    save_parameter["EquipWaza"] = _property(
        [{"WazaID": _property("EPalWazaID::AirCanon", "EnumProperty")}], "ArrayProperty"
    )
    save_parameter["MasteredWaza"] = _property(
        [
            _property("EPalWazaID::PowerShot", "EnumProperty"),
            _property("UnknownWaza", "NameProperty"),
        ],
        "ArrayProperty",
    )
    cache = tmp_path / "world-cache-skills.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    rows, total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="balanced",
        passive_skills=("Legend", "MoveSpeed_up_2"),
    )
    assert total == 1
    skills = cast(dict[str, Any], rows[0]["skills"])
    assert skills["passive"] == [
        {
            "id": "Legend",
            "name": "传说",
            "description": "攻击 +20%，防御 +20%，移动速度提升20%",
            "sourceName": "Legend",
            "rank": 4,
            "element": None,
            "power": None,
            "cooldown": None,
            "metadataKnown": True,
        },
        {
            "id": "MoveSpeed_up_2",
            "name": "运动健将",
            "description": "移动速度提升20%",
            "sourceName": "Runner",
            "rank": 3,
            "element": None,
            "power": None,
            "cooldown": None,
            "metadataKnown": True,
        },
    ]
    assert skills["equipped"][0]["id"] == "AirCanon"
    assert skills["equipped"][0]["element"] == "Normal"
    assert skills["equipped"][0]["power"] == 40
    assert skills["equipped"][0]["cooldown"] == 2.0
    assert skills["equipped"][0]["metadataKnown"] is True
    assert skills["learned"][1] == {
        "id": "UnknownWaza",
        "name": None,
        "description": None,
        "sourceName": None,
        "rank": None,
        "element": None,
        "power": None,
        "cooldown": None,
        "metadataKnown": False,
    }
    assert [item["name"] for item in query_pal_passive_skill_options(cache)] == ["传说", "运动健将"]
    no_match, no_match_total = query_pal_roster(
        cache,
        page=1,
        page_size=60,
        search=None,
        marker="all",
        sort="balanced",
        passive_skills=("Legend", "UnknownPassive"),
    )
    assert no_match == [] and no_match_total == 0


def test_missing_world_metadata_keeps_unknown_pal_records_read_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    level, players = _synthetic_properties()

    def unavailable() -> None:
        raise WorldMetadataError("WORLD_METADATA_UNAVAILABLE", "missing")

    monkeypatch.setattr(world_cache, "load_world_metadata", unavailable)
    cache = tmp_path / "world-cache-no-metadata.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, total = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced"
    )
    assert total == 2
    assert all(cast(dict[str, Any], item["aptitude"])["metadataKnown"] is False for item in items)
    assert all(
        cast(dict[str, Any], item["aptitude"])["metadataLabel"] == "资料未收录"
        for item in items
    )
    assert read_cache_metadata(cache)["metadata_error_code"] == "WORLD_METADATA_UNAVAILABLE"


def test_pal_care_attention_preserves_thresholds_unknown_disease_and_missing_fields(
    tmp_path: Path,
) -> None:
    level, players = _synthetic_properties()
    characters = level["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]
    characters.append(
        _character(
            uuid.UUID(int=1),
            uuid.UUID(int=404),
            character_id="SheepBall",
            nickname="字段缺失帕鲁",
            is_player=False,
            save_parameter_fields={
                "Activity": _property("EPalActivity::Working", "EnumProperty")
            },
        )
    )
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, total = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced"
    )
    by_name = {
        str(item["nickname"]): cast(dict[str, Any], item["care"])
        for item in items
    }
    critical = by_name["工作帕鲁甲"]
    boundary = by_name["工作帕鲁乙"]
    missing = by_name["字段缺失帕鲁"]
    assert total == 3
    assert critical["reasons"] == ["zero_hp", "disease", "hunger_low", "san_low"]
    assert critical["activity"] == "EPalActivity::Working"
    assert boundary["reasons"] == ["disease"]
    assert boundary["hunger"] == 20.0 and boundary["sanity"] == 50.0
    assert boundary["disease"] == "EPalStatus::UnknownArchiveFever"
    assert missing["unavailable"] == ["currentHp", "hunger"]
    assert missing["sanity"] == 100.0
    assert missing["diseaseRecorded"] is True
    assert missing["activityRecorded"] is True
    assert missing["activity"] == "EPalActivity::Working"
    assert missing["severity"] == "unavailable"

    attention, attention_total = query_pal_roster(
        cache, page=1, page_size=60, search=None, marker="all", sort="balanced", care="attention"
    )
    assert attention_total == 2
    assert {item["nickname"] for item in attention} == {"工作帕鲁甲", "工作帕鲁乙"}
    assert query_pal_care_summary(cache) == {
        "total": 3, "critical": 2, "warning": 0, "attention": 2, "unavailable": 1,
    }


def test_pal_care_reads_real_save_field_shapes_without_treating_raw_food_as_percent(
    tmp_path: Path,
) -> None:
    level, players = _synthetic_properties()
    characters = level["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]
    characters.append(
        _character(
            uuid.UUID(int=1),
            uuid.UUID(int=405),
            character_id="SheepBall",
            nickname="真实字段帕鲁",
            is_player=False,
            save_parameter_fields={
                "Hp": {
                    "type": "StructProperty",
                    "struct_type": "FixedPoint64",
                    "value": {"Value": _property(125_000, "Int64Property")},
                },
                "FullStomach": _property(30.0, "FloatProperty"),
                "HungerType": _property(
                    "EPalStatusHungerType::Starvation", "EnumProperty"
                ),
                "SanityValue": _property(75.0, "FloatProperty"),
                "PhysicalHealth": _property(
                    "EPalStatusPhysicalHealthType::MinorInjury", "EnumProperty"
                ),
                "WorkerSick": _property(
                    "EPalBaseCampWorkerSickType::Cold", "EnumProperty"
                ),
                "BaseCampWorkerEventType": _property(
                    "EPalBaseCampWorkerEventType::DodgeWork", "EnumProperty"
                ),
            },
        )
    )
    characters.append(
        _character(
            uuid.UUID(int=1),
            uuid.UUID(int=406),
            character_id="SheepBall",
            nickname="原始饱食值帕鲁",
            is_player=False,
            save_parameter_fields={
                "Hp": {
                    "type": "StructProperty",
                    "struct_type": "FixedPoint64",
                    "value": {"Value": _property(100_000, "Int64Property")},
                },
                "FullStomach": _property(30.0, "FloatProperty"),
                "HungerType": _property(
                    "EPalStatusHungerType::Default", "EnumProperty"
                ),
                "SanityValue": _property(100.0, "FloatProperty"),
                "PhysicalHealth": _property(
                    "EPalStatusPhysicalHealthType::Healthful", "EnumProperty"
                ),
                "WorkerSick": _property(
                    "EPalBaseCampWorkerSickType::None", "EnumProperty"
                ),
                "BaseCampWorkerEventType": _property(
                    "EPalBaseCampWorkerEventType::None", "EnumProperty"
                ),
            },
        )
    )
    cache = tmp_path / "world-cache-real-fields.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, _ = query_pal_roster(
        cache, page=1, page_size=60, search="真实字段帕鲁", marker="all", sort="balanced"
    )
    care = cast(dict[str, Any], items[0]["care"])

    assert care["currentHp"] == 125.0
    assert care["hunger"] == 30.0
    assert care["hungerRaw"] == 30.0
    assert care["hungerStatus"] == "EPalStatusHungerType::Starvation"
    assert care["sanity"] == 75.0
    assert care["physicalHealth"] == "EPalStatusPhysicalHealthType::MinorInjury"
    assert care["disease"] == "EPalBaseCampWorkerSickType::Cold"
    assert care["activity"] == "EPalBaseCampWorkerEventType::DodgeWork"
    assert care["diseaseRecorded"] is True
    assert care["activityRecorded"] is True

    raw_items, _ = query_pal_roster(
        cache, page=1, page_size=60, search="原始饱食值帕鲁", marker="all", sort="balanced"
    )
    raw_care = cast(dict[str, Any], raw_items[0]["care"])
    assert raw_care["hunger"] == 30.0
    assert raw_care["hungerRaw"] == 30.0
    assert raw_care["unavailable"] == []
    assert raw_care["severity"] == "healthy"


def test_pal_care_uses_current_work_suitability_as_snapshot_activity(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    characters = level["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]
    characters.append(
        _character(
            uuid.UUID(int=1),
            uuid.UUID(int=407),
            character_id="SheepBall",
            nickname="当前工作帕鲁",
            is_player=False,
            current_hp=100.0,
            hunger=100.0,
            sanity=100.0,
            save_parameter_fields={
                "CurrentWorkSuitability": _property(
                    "EPalWorkSuitability::Mining", "EnumProperty"
                )
            },
        )
    )
    cache = tmp_path / "world-cache-current-work.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    items, total = query_pal_roster(
        cache, page=1, page_size=60, search="当前工作帕鲁", marker="all", sort="balanced"
    )
    care = cast(dict[str, Any], items[0]["care"])

    assert total == 1
    assert care["activity"] == "EPalWorkSuitability::Mining"
    assert care["severity"] == "info"
    assert care["attention"] is False


def test_pal_care_species_lookup_tolerates_save_id_casing() -> None:
    assert max_full_stomach("SheepBall") == 100.0
    assert max_full_stomach("Sheepball") == 100.0
    assert max_full_stomach("FuturePal") is None


def test_entity_detail_links_pals_to_owner_base_and_container(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    pal_id = str(uuid.UUID(int=401))

    detail = entity_detail(cache, "pals", pal_id)

    assert detail is not None
    owner = detail["owner"]
    base = detail["base"]
    container = detail["container"]
    assert isinstance(owner, dict) and owner["name"] == "测试玩家"
    assert isinstance(base, dict) and base["name"] == "据点甲"
    assert isinstance(container, dict) and container["kind"] == "base_workers"


def test_cache_and_snapshot_keep_source_collection_and_parse_times(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    level, players = _synthetic_properties()
    level["worldSaveData"]["value"]["GameTimeSaveData"] = _property(
        {"GameDateTimeTicks": _property(110_628_000_000_000, "Int64Property")}
    )
    clock_values = iter([200, 201, 202, 203, 204, 205])
    service = WorldSnapshotService(
        database,
        lambda: None,
        tmp_path / "data",
        minimum_free_bytes=0,
        clock=lambda: next(clock_values),
    )
    service.snapshots_root.mkdir(parents=True)
    service.cache_root.mkdir(parents=True)

    def fake_worker(
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int,
        parse_started_at: int,
    ) -> dict[str, object]:
        build_world_cache(
            cache_path,
            level,
            players,
            snapshot_id=snapshot_id,
            source_observed_at=observed_at,
            collected_at=collected_at,
            parse_started_at=parse_started_at,
        )
        return {
            "parsedAt": 204,
            "durationMs": 5,
            "peakMemoryBytes": 6,
            "cacheSizeBytes": cache_path.stat().st_size,
        }

    monkeypatch.setattr(service, "_run_worker", fake_worker)
    service._capture_and_parse(world, service._fingerprint(world))

    current = database.current_snapshot_version()
    assert current is not None
    parse_result = json.loads(str(current["parse_result"]))
    metadata = read_cache_metadata(Path(str(current["cache_path"])))
    snapshot_metadata = json.loads(
        (service.snapshots_root / str(current["id"]) / "snapshot.json").read_text(
            encoding="utf-8"
        )
    )
    assert parse_result["collectedAt"] == 201
    assert parse_result["parsedAt"] == 204
    assert metadata["collected_at"] == "201"
    assert metadata["parse_started_at"] == "202"
    assert snapshot_metadata["collectedAt"] == 201
    status = service.status()
    assert status["observedAt"] == current["source_observed_at"]
    assert status["gameTimeTicks"] == 110_628_000_000_000
    contract = cast(dict[str, object], status["contract"])
    assert contract["metadataDataVersion"] == "2026.08.25.3"


def test_world_status_marks_cache_invalid_when_metadata_table_is_missing(
    tmp_path: Path,
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    cache = tmp_path / "data" / "cache" / "world-cache-invalid.sqlite"
    cache.parent.mkdir(parents=True)
    with sqlite3.connect(cache) as connection:
        connection.execute("CREATE TABLE unrelated (value TEXT)")
    database.record_snapshot_version(
        "invalid",
        str(cache),
        123,
        json.dumps({"durationMs": 3}),
        make_current=True,
    )
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    status = service.status()

    assert status["errorCode"] == "CACHE_INVALID"
    assert status["error"] == "最后成功缓存无法读取。"
    assert status["stale"] is True
    assert cache.is_file()


def test_world_api_enforces_page_limit(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    database = Database(settings.database_path)
    database.migrate()
    level, players = _synthetic_properties()
    characters = level["worldSaveData"]["value"]["CharacterSaveParameterMap"]["value"]
    boss_save = characters[1]["value"]["RawData"]["value"]["object"]["SaveParameter"]["value"]
    boss_save["PassiveSkillList"] = _property(
        [_property("Legend", "NameProperty")], "ArrayProperty"
    )
    cache_root = settings.data_dir / "cache"
    cache_root.mkdir(parents=True)
    cache = cache_root / "world-cache-fixture.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)
    database.record_snapshot_version("fixture", str(cache), 1, "success", make_current=True)
    service = WorldSnapshotService(database, lambda: None, settings.data_dir, poll_seconds=60)

    with TestClient(
        create_app(settings, world_service=service),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        response = client.get("/api/world/bases?page=1&pageSize=1")
        rejected = client.get("/api/world/pals?pageSize=201")
        replaced = client.get("/api/world/pals?snapshotId=superseded")
        inventory = client.get("/api/world/inventories?pageSize=60")
        inventory_detail = client.get("/api/world/inventories/Wood?pageSize=100")
        inventory_replaced = client.get("/api/world/inventories?snapshotId=superseded")
        inventory_invalid_scope = client.get("/api/world/inventories?scope=unknown")
        roster = client.get("/api/world/pals/roster?pageSize=60")
        aptitude_roster = client.get(
            "/api/world/pals/roster?minRarity=5&minHpIv=90&minAverageIv=80"
            "&workSuitability=Handcraft,Transport&minWorkLevel=1&sort=averageIv"
        )
        invalid_aptitude = client.get("/api/world/pals/roster?minHpIv=101")
        invalid_work = client.get(
            "/api/world/pals/roster?workSuitability=UnknownWork&minWorkLevel=1"
        )
        passive_roster = client.get("/api/world/pals/roster?passiveSkill=Legend")
        invalid_passive = client.get(
            "/api/world/pals/roster?passiveSkill=Legend,Legend"
        )
        roster_replaced = client.get("/api/world/pals/roster?snapshotId=superseded")
        pal_detail = client.get(f"/api/world/pals/{uuid.UUID(int=401)}")

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert len(response.json()["items"]) == 1
    assert response.json()["snapshotId"] == "fixture"
    assert response.json()["parseStatus"] == "failed"
    assert response.json()["dataCoverage"]["state"] == "complete"
    assert rejected.status_code == 422
    assert rejected.json()["errorCode"] == "INVALID_WORLD_PAGE"
    assert replaced.status_code == 409
    assert replaced.json()["errorCode"] == "SNAPSHOT_REPLACED"
    assert inventory.status_code == 200
    assert inventory.json()["total"] == 1
    assert inventory.json()["items"] == [
        {
            "itemId": "Wood",
            "name": "木材",
            "category": "Material / MaterialWood",
            "rarity": "0",
            "metadataKnown": True,
            "metadataLabel": None,
            "totalQuantity": 3,
            "locationCount": 1,
        }
    ]
    assert inventory_detail.status_code == 200
    assert inventory_detail.json()["locations"][0]["locationType"] == "player"
    assert inventory_detail.json()["locations"][0]["containerId"]
    assert inventory_replaced.status_code == 409
    assert inventory_replaced.json()["errorCode"] == "SNAPSHOT_REPLACED"
    assert inventory_invalid_scope.status_code == 422
    assert inventory_invalid_scope.json()["errorCode"] == "INVALID_INVENTORY_SCOPE"
    assert roster.status_code == 200
    assert roster.json()["pageSize"] == 60
    assert roster.json()["metadata"]["status"] == "ready"
    assert roster.json()["items"][0]["aptitude"]["metadataKnown"] is True
    assert roster.json()["passiveSkills"][0]["name"] == "传说"
    assert aptitude_roster.status_code == 200
    assert aptitude_roster.json()["total"] == 1
    assert aptitude_roster.json()["items"][0]["characterId"] == "BOSS_SheepBall"
    assert invalid_aptitude.status_code == 422
    assert invalid_aptitude.json()["errorCode"] == "INVALID_PAL_APTITUDE_FILTER"
    assert invalid_work.status_code == 422
    assert invalid_work.json()["errorCode"] == "INVALID_PAL_WORK_FILTER"
    assert passive_roster.status_code == 200
    assert passive_roster.json()["total"] == 1
    assert passive_roster.json()["items"][0]["characterId"] == "BOSS_SheepBall"
    assert invalid_passive.status_code == 422
    assert invalid_passive.json()["errorCode"] == "INVALID_PAL_PASSIVE_FILTER"
    assert roster_replaced.status_code == 409
    assert roster_replaced.json()["errorCode"] == "SNAPSHOT_REPLACED"
    assert pal_detail.status_code == 200
    assert pal_detail.json()["owner"]["name"] == "测试玩家"
    assert pal_detail.json()["aptitude"]["ivs"]["average"] == 80.0
    assert pal_detail.json()["metadata"]["status"] == "ready"


def test_source_change_discards_snapshot_before_parser(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    (world / "Players" / "fixture.sav").write_bytes(b"player")
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    service.snapshots_root.mkdir(parents=True)
    expected = service._fingerprint(world)
    monkeypatch.setattr(service, "_fingerprint", lambda _: (("changed", 1, 1),))

    with pytest.raises(WorldDataError, match="复制快照期间源文件发生变化") as raised:
        service._capture_and_parse(world, expected)

    assert raised.value.code == "SNAPSHOT_SOURCE_CHANGED"
    assert list(service.snapshots_root.iterdir()) == []


def test_parser_crash_is_reported_without_exiting_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 7, "", "decoder failed"),
    )

    with pytest.raises(WorldDataError, match="Parser exited with code 7") as raised:
        service._run_worker(tmp_path, tmp_path / "cache.tmp", "fixture", 1)

    assert raised.value.code == "PARSER_CRASHED"
    assert os.getpid() > 0


def test_frozen_worker_uses_portable_dispatcher(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    command: list[str] = []

    def fake_run(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        command.extend(arguments)
        return subprocess.CompletedProcess(arguments, 0, '{"ok":true}', "")

    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(subprocess, "run", fake_run)

    assert service._run_worker(tmp_path, tmp_path / "cache.tmp", "fixture", 1) == {"ok": True}
    assert command[:2] == [sys.executable, "--world-worker"]
    assert "-m" not in command


def test_unfrozen_worker_uses_python_module_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    command: list[str] = []

    def fake_run(arguments: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        command.extend(arguments)
        return subprocess.CompletedProcess(arguments, 0, '{"ok":true}', "")

    monkeypatch.setattr(sys, "frozen", False, raising=False)
    monkeypatch.setattr(subprocess, "run", fake_run)

    assert service._run_worker(tmp_path, tmp_path / "cache.tmp", "fixture", 1) == {"ok": True}
    assert command[:3] == [sys.executable, "-m", "palserver_console.world.worker"]


def _retention_pair(
    service: WorldSnapshotService,
    snapshot_id: str,
    collected_at: int,
    payload_size: int = 1,
) -> Path:
    snapshot = service.snapshots_root / snapshot_id
    snapshot.mkdir(parents=True, exist_ok=True)
    (snapshot / "snapshot.json").write_text(
        json.dumps({"snapshotId": snapshot_id, "collectedAt": collected_at}),
        encoding="utf-8",
    )
    (snapshot / "Level.sav").write_bytes(b"x" * payload_size)
    cache = service.cache_root / f"world-cache-{snapshot_id}.sqlite"
    cache.write_bytes(b"y" * payload_size)
    return cache


def test_snapshot_retention_keeps_current_and_bounds_count_and_age(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(
        database,
        lambda: None,
        tmp_path / "data",
        snapshot_retention_count=2,
        snapshot_retention_bytes=1024,
        snapshot_retention_age_seconds=100,
        minimum_free_bytes=0,
        clock=lambda: 1_000,
    )
    service.snapshots_root.mkdir(parents=True)
    service.cache_root.mkdir(parents=True)
    _retention_pair(service, "old", 700, payload_size=10)
    _retention_pair(service, "newer", 950, payload_size=10)
    current_cache = _retention_pair(service, "current", 700, payload_size=10)
    database.record_snapshot_version(
        "current", str(current_cache), 700, "success", make_current=True
    )

    report = service.cleanup_storage()

    assert report["removedSnapshots"] == 1
    assert not (service.snapshots_root / "old").exists()
    assert not (service.cache_root / "world-cache-old.sqlite").exists()
    assert (service.snapshots_root / "current").exists()
    assert current_cache.exists()
    assert (service.snapshots_root / "newer").exists()


def test_snapshot_cleanup_removes_temp_and_unreferenced_items(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(
        database,
        lambda: None,
        tmp_path / "data",
        minimum_free_bytes=0,
        clock=lambda: 1_000,
    )
    service.snapshots_root.mkdir(parents=True)
    service.cache_root.mkdir(parents=True)
    (service.snapshots_root / ".crashed.tmp").mkdir()
    (service.cache_root / ".world-cache-crashed.tmp.sqlite").write_bytes(b"tmp")
    (service.snapshots_root / "orphan-snapshot").mkdir()
    (service.cache_root / "world-cache-orphan-cache.sqlite").write_bytes(b"orphan")

    service.cleanup_storage()

    assert not (service.snapshots_root / ".crashed.tmp").exists()
    assert not (service.cache_root / ".world-cache-crashed.tmp.sqlite").exists()
    assert not (service.snapshots_root / "orphan-snapshot").exists()
    assert not (service.cache_root / "world-cache-orphan-cache.sqlite").exists()


def test_low_disk_preserves_last_successful_cache(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    data_dir = tmp_path / "data"
    cache_root = data_dir / "cache"
    cache_root.mkdir(parents=True)
    current_cache = cache_root / "world-cache-current.sqlite"
    current_cache.write_bytes(b"last-success")
    database.record_snapshot_version("current", str(current_cache), 1, "success", make_current=True)
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    service = WorldSnapshotService(
        database,
        lambda: None,
        data_dir,
        minimum_free_bytes=100,
        disk_usage_provider=lambda _: SimpleNamespace(free=50),
    )
    expected = service._fingerprint(world)

    with pytest.raises(WorldDataError) as raised:
        service._capture_and_parse(world, expected)

    assert raised.value.code == "DISK_SPACE_LOW"
    assert current_cache.read_bytes() == b"last-success"
    assert list(service.snapshots_root.glob("*") if service.snapshots_root.exists() else []) == []


@pytest.mark.parametrize("failure_kind", ["worker", "os_error"])
def test_watcher_retries_after_disk_space_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failure_kind: str
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    data_dir = tmp_path / "data"
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    service = WorldSnapshotService(
        database,
        lambda: None,
        data_dir,
        stability_seconds=0.01,
        poll_seconds=0.005,
        minimum_free_bytes=0,
    )
    monkeypatch.setattr(
        "palserver_console.world.service.DISK_SPACE_RETRY_INITIAL_SECONDS", 0.05
    )
    monkeypatch.setattr("palserver_console.world.service.DISK_SPACE_RETRY_MAX_SECONDS", 0.2)
    monkeypatch.setattr(service, "_world_directory", lambda: world)
    service.snapshots_root.mkdir(parents=True)
    service.cache_root.mkdir(parents=True)
    level, players = _synthetic_properties()
    attempts = 0
    failed = threading.Event()
    scheduled = threading.Event()
    retried = threading.Event()

    def fake_worker(
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int,
        parse_started_at: int,
    ) -> dict[str, object]:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            failed.set()
            if failure_kind == "worker":
                raise WorldDataError("DISK_SPACE_LOW", "disk full")
            raise OSError(errno.ENOSPC, "disk full")
        build_world_cache(
            cache_path,
            level,
            players,
            snapshot_id=snapshot_id,
            source_observed_at=observed_at,
            collected_at=collected_at,
            parse_started_at=parse_started_at,
        )
        retried.set()
        service._stop.set()
        service._wake.set()
        return {
            "parsedAt": 2,
            "durationMs": 1,
            "peakMemoryBytes": 2,
            "cacheSizeBytes": cache_path.stat().st_size,
        }

    monkeypatch.setattr(service, "_run_worker", fake_worker)
    original_schedule = service._schedule_disk_space_retry

    def schedule_disk_retry(expected: tuple[tuple[str, int, int], ...]) -> None:
        original_schedule(expected)
        scheduled.set()

    monkeypatch.setattr(service, "_schedule_disk_space_retry", schedule_disk_retry)
    thread = threading.Thread(target=service._watch_loop, daemon=True)
    thread.start()
    try:
        assert failed.wait(timeout=5)
        time.sleep(0.025)
        assert attempts == 1
        assert scheduled.wait(timeout=5)
        retry_delay = service.background_status()["retryDelaySeconds"]
        assert isinstance(retry_delay, (int, float))  # noqa: UP038
        assert retry_delay > 0
        assert retried.wait(timeout=5)
    finally:
        service._stop.set()
        service._wake.set()
        thread.join(timeout=5)

    assert not thread.is_alive()
    assert attempts == 2
    assert database.current_snapshot_version() is not None
    assert service._disk_space_retry_delay_seconds == 0.0


def test_disk_space_retry_backoff_is_bounded_and_reported(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    expected = (("Level.sav", 1, 1),)
    service._last_seen = expected
    now = 100.0
    monkeypatch.setattr("palserver_console.world.service.time.monotonic", lambda: now)

    observed: list[float] = []
    for delay in (30.0, 60.0, 120.0, 240.0, 300.0, 300.0):
        service._schedule_disk_space_retry(expected)
        retry_delay = service.background_status()["retryDelaySeconds"]
        assert isinstance(retry_delay, (int, float))  # noqa: UP038
        observed.append(float(retry_delay))
        now += delay

    assert observed == pytest.approx([30.0, 60.0, 120.0, 240.0, 300.0, 300.0])


@pytest.mark.parametrize("reset_mode", ["fingerprint", "request_reparse"])
def test_disk_space_retry_reset_allows_new_parse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, reset_mode: str
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    data_dir = tmp_path / "data"
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    service = WorldSnapshotService(
        database,
        lambda: None,
        data_dir,
        stability_seconds=0.01,
        poll_seconds=0.005,
        minimum_free_bytes=0,
    )
    monkeypatch.setattr(service, "_world_directory", lambda: world)
    service.snapshots_root.mkdir(parents=True)
    service.cache_root.mkdir(parents=True)
    expected = service._fingerprint(world)
    with service._lock:
        service._last_seen = expected
    service._schedule_disk_space_retry(expected)
    retry_delay = service.background_status()["retryDelaySeconds"]
    assert isinstance(retry_delay, (int, float))  # noqa: UP038
    assert retry_delay > 0
    if reset_mode == "fingerprint":
        (world / "Level.sav").write_bytes(b"level-changed")
    else:
        service.request_reparse()

    level, players = _synthetic_properties()
    parsed = threading.Event()

    def fake_worker(
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int,
        parse_started_at: int,
    ) -> dict[str, object]:
        build_world_cache(
            cache_path,
            level,
            players,
            snapshot_id=snapshot_id,
            source_observed_at=observed_at,
            collected_at=collected_at,
            parse_started_at=parse_started_at,
        )
        parsed.set()
        service._stop.set()
        service._wake.set()
        return {
            "parsedAt": 2,
            "durationMs": 1,
            "peakMemoryBytes": 2,
            "cacheSizeBytes": cache_path.stat().st_size,
        }

    monkeypatch.setattr(service, "_run_worker", fake_worker)
    thread = threading.Thread(target=service._watch_loop, daemon=True)
    thread.start()
    try:
        assert parsed.wait(timeout=5)
    finally:
        service._stop.set()
        service._wake.set()
        thread.join(timeout=5)

    assert not thread.is_alive()
    assert service._disk_space_retry_delay_seconds == 0.0


def test_ooz_discovery_result_is_cached_until_reparse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    dll = tmp_path / "libooz.dll"
    dll.write_bytes(b"dll")
    monkeypatch.setenv("PALSERVER_OOZ_DLL", str(dll))
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    assert service._find_ooz_dll() == dll.resolve()
    dll.unlink()
    assert service._find_ooz_dll() == dll.resolve()
    service.request_reparse()
    assert service._find_ooz_dll() is None


def test_typed_world_contract_pins_list_and_detail_to_one_snapshot(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    level, players = _synthetic_properties()
    cache = tmp_path / "data" / "cache" / "world-cache-fixture.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=10)
    database.record_snapshot_version(
        "fixture",
        str(cache),
        10,
        json.dumps({"status": "success", "collectedAt": 11, "parsedAt": 12}),
        make_current=True,
    )
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    summary = service.status()
    listing = service.list_resource(
        "players",
        page=1,
        page_size=50,
        search=None,
        owner_id=None,
        base_id=None,
        snapshot_id="fixture",
    )
    items = listing["items"]
    assert isinstance(items, list) and items
    first_item = items[0]
    assert isinstance(first_item, dict)
    detail = service.get_entity("players", str(first_item["id"]), snapshot_id="fixture")

    assert summary["parseStatus"] == "ready"
    assert summary["dataCoverage"] == {"state": "complete", "resources": {
        "players": True, "pals": True, "guilds": True, "bases": True,
        "inventories": True, "work-pals": True,
    }}
    assert listing["snapshotId"] == "fixture"
    assert listing["collectedAt"] == 11
    assert listing["parsedAt"] == 12
    assert detail["snapshotId"] == "fixture"


def test_incompatible_world_cache_is_not_used_and_requests_reparse(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    level, players = _synthetic_properties()
    cache = tmp_path / "data" / "cache" / "world-cache-legacy.sqlite"
    build_world_cache(cache, level, players, snapshot_id="legacy", source_observed_at=10)
    with sqlite3.connect(cache) as connection:
        connection.execute("UPDATE cache_info SET value = '1' WHERE key = 'schema_version'")
    database.record_snapshot_version("legacy", str(cache), 10, "success", make_current=True)
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    with pytest.raises(WorldCacheSchemaError):
        validate_cache_file(cache)
    status = service.status()
    with pytest.raises(WorldDataError) as raised:
        service.list_resource(
            "players", page=1, page_size=50, search=None, owner_id=None, base_id=None
        )

    assert status["errorCode"] == "CACHE_SCHEMA_INCOMPATIBLE"
    assert status["parseStatus"] == "incompatible"
    coverage = status["dataCoverage"]
    assert isinstance(coverage, dict)
    assert coverage["state"] == "unavailable"
    assert raised.value.code == "CACHE_SCHEMA_INCOMPATIBLE"

    service.request_reparse()
    requested = service.status()

    assert requested["parseStatus"] == "parsing"
    assert requested["parsing"] is True


def test_reparse_request_replaces_an_old_failed_status_with_parsing(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")
    service._set_error("SNAPSHOT_PARSE_FAILED", "old failure")
    assert service.status()["parseStatus"] == "failed"

    generation = service.request_reparse()
    status = service.status()

    assert generation == 1
    assert status["reparseGeneration"] == generation
    assert status["parseStatus"] == "parsing"
    assert status["parsing"] is True
    assert status["errorCode"] is None

    service._set_error("FAST_PARSE_FAILED", "fast failure")
    failed = service.status()
    assert failed["reparseGeneration"] == generation
    assert failed["parseStatus"] == "failed"
    assert failed["errorCode"] == "FAST_PARSE_FAILED"
    assert service.request_reparse() == 2


def test_service_start_rebuilds_legacy_current_cache_without_source_change(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    data_dir = tmp_path / "data"
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    level, players = _synthetic_properties()
    legacy_cache = data_dir / "cache" / "world-cache-legacy.sqlite"
    build_world_cache(
        legacy_cache, level, players, snapshot_id="legacy", source_observed_at=10
    )
    legacy_version = CACHE_SCHEMA_VERSION - 1
    with sqlite3.connect(legacy_cache) as connection:
        connection.execute(
            "UPDATE cache_info SET value = ? WHERE key = 'schema_version'",
            (str(legacy_version),),
        )
        connection.execute(f"PRAGMA user_version = {legacy_version}")
    database.record_snapshot_version(
        "legacy", str(legacy_cache), 10, "success", make_current=True
    )
    service = WorldSnapshotService(
        database,
        lambda: None,
        data_dir,
        stability_seconds=0.01,
        poll_seconds=0.005,
        minimum_free_bytes=0,
    )
    monkeypatch.setattr(service, "_world_directory", lambda: world)
    rebuilt = threading.Event()

    def fake_worker(
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int | None = None,
        parse_started_at: int | None = None,
    ) -> dict[str, Any]:
        build_world_cache(
            cache_path,
            level,
            players,
            snapshot_id=snapshot_id,
            source_observed_at=observed_at,
            collected_at=collected_at,
            parse_started_at=parse_started_at,
        )
        rebuilt.set()
        return {
            "parsedAt": 2,
            "durationMs": 1,
            "peakMemoryBytes": 2,
            "cacheSizeBytes": cache_path.stat().st_size,
        }

    monkeypatch.setattr(service, "_run_worker", fake_worker)
    service.request_reparse()
    assert service.status()["parseStatus"] == "parsing"
    service.start()
    try:
        assert rebuilt.wait(timeout=5)
    finally:
        service.stop()

    current = database.current_snapshot_version()
    assert current is not None and current["id"] != "legacy"
    current_cache = Path(str(current["cache_path"]))
    assert read_cache_metadata(current_cache)["schema_version"] == str(
        CACHE_SCHEMA_VERSION
    )
    validate_cache_file(current_cache)
    assert service.status()["parseStatus"] == "ready"
    assert service.status()["parsing"] is False


def test_failed_parse_keeps_last_compatible_cache_readable(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    data_dir = tmp_path / "data"
    service = WorldSnapshotService(database, lambda: None, data_dir, minimum_free_bytes=0)
    level, players = _synthetic_properties()
    old_cache = service.cache_root / "world-cache-old.sqlite"
    old_cache.parent.mkdir(parents=True)
    build_world_cache(old_cache, level, players, snapshot_id="old", source_observed_at=1)
    database.record_snapshot_version("old", str(old_cache), 1, "success", make_current=True)
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    service.snapshots_root.mkdir(parents=True)
    expected = service._fingerprint(world)

    def failed_worker(*_: object, **__: object) -> dict[str, object]:
        raise WorldDataError("PARSER_FAILED", "synthetic parser failure")

    service._run_worker = failed_worker  # type: ignore[method-assign]
    service.request_reparse()
    assert service.status()["parseStatus"] == "parsing"
    service._capture_and_parse(world, expected)
    listing = service.list_resource(
        "players", page=1, page_size=50, search=None, owner_id=None, base_id=None
    )

    assert database.current_snapshot_version()["id"] == "old"  # type: ignore[index]
    assert listing["snapshotId"] == "old"
    assert listing["stale"] is True
    assert listing["parseStatus"] == "failed"
    assert listing["errorCode"] == "PARSER_FAILED"


def test_reparse_requested_during_parse_is_not_cleared_by_older_attempt(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(
        database, lambda: None, tmp_path / "data", minimum_free_bytes=0
    )
    world = tmp_path / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    service.snapshots_root.mkdir(parents=True)
    expected = service._fingerprint(world)
    level, players = _synthetic_properties()

    def successful_worker(
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int | None = None,
        parse_started_at: int | None = None,
    ) -> dict[str, Any]:
        assert snapshot.is_dir()
        build_world_cache(
            cache_path,
            level,
            players,
            snapshot_id=snapshot_id,
            source_observed_at=observed_at,
            collected_at=collected_at,
            parse_started_at=parse_started_at,
        )
        assert service.request_reparse() == 2
        return {
            "parsedAt": 2,
            "durationMs": 1,
            "peakMemoryBytes": 2,
            "cacheSizeBytes": cache_path.stat().st_size,
        }

    service._run_worker = successful_worker  # type: ignore[method-assign]
    assert service.request_reparse() == 1
    service._capture_and_parse(world, expected)

    status = service.status()
    assert status["reparseGeneration"] == 2
    assert status["parseStatus"] == "parsing"
    assert status["parsing"] is True


def test_world_contract_reports_unavailable_without_a_successful_cache(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    status = service.status()
    with pytest.raises(WorldDataError) as raised:
        service.list_resource(
            "players", page=1, page_size=50, search=None, owner_id=None, base_id=None
        )

    assert status["snapshotId"] is None
    assert status["parseStatus"] == "unavailable"
    assert status["contract"] == {
        "queryVersion": 1,
        "cacheSchema": "world-asset-cache",
        "cacheSchemaVersion": CACHE_SCHEMA_VERSION,
        "metadataSchema": "palserver-console-world-metadata",
        "metadataSchemaVersion": 1,
        "metadataDataVersion": None,
    }
    coverage = status["dataCoverage"]
    assert isinstance(coverage, dict)
    assert coverage["state"] == "unavailable"
    assert raised.value.code == "WORLD_CACHE_UNAVAILABLE"


def test_world_asset_pressure_boundary_pages_players_and_aggregates_inventory_slots(
    tmp_path: Path,
) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache-pressure.sqlite"
    build_world_cache(cache, level, players, snapshot_id="pressure", source_observed_at=1)

    with sqlite3.connect(cache) as connection:
        connection.execute("DELETE FROM players")
        connection.execute("DELETE FROM inventory_items")
        connection.executemany(
            "INSERT INTO players(id, instance_id, name, level, guild_id, inventory_ids_json, "
            "party_container_id, storage_container_id, detail_json) "
            "VALUES(?, ?, ?, ?, NULL, '[]', NULL, NULL, ?)",
            (
                (f"player-{index:03d}", f"instance-{index:03d}", f"玩家-{index:03d}", index, "{}")
                for index in range(200)
            ),
        )
        connection.executemany(
            "INSERT INTO inventory_items(container_id, slot_index, item_id, item_name, "
            "item_category, item_rarity, metadata_known, quantity, owner_kind) "
            "VALUES(?, ?, ?, ?, 'Material', '1', 1, 1, 'world')",
            (
                (
                    f"container-{index // 100:03d}",
                    index % 100,
                    f"Item-{index % 100:03d}",
                    f"物品-{index % 100:03d}",
                )
                for index in range(50_000)
            ),
        )

    player_page, player_total = query_cache(
        cache, "players", page=4, page_size=50, search=None, sort="name"
    )
    inventory_page, inventory_total, categories = query_inventory(
        cache, page=1, page_size=60, search=None, category=None, scope="all",
        owner_id=None, base_id=None, sort="quantity",
    )

    assert player_total == 200
    assert len(player_page) == 50
    assert inventory_total == 100
    assert len(inventory_page) == 60
    assert sum(cast(int, item["totalQuantity"]) for item in inventory_page) == 30_000
    assert categories == ["Material"]


def test_world_contract_rejects_results_for_a_replaced_snapshot(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    level, players = _synthetic_properties()
    cache = tmp_path / "data" / "cache" / "world-cache-current.sqlite"
    build_world_cache(cache, level, players, snapshot_id="current", source_observed_at=10)
    database.record_snapshot_version("current", str(cache), 10, "success", make_current=True)
    service = WorldSnapshotService(database, lambda: None, tmp_path / "data")

    with pytest.raises(WorldDataError) as raised:
        service.list_resource(
            "players",
            page=1,
            page_size=50,
            search=None,
            owner_id=None,
            base_id=None,
            snapshot_id="superseded",
        )

    assert raised.value.code == "SNAPSHOT_REPLACED"


@pytest.mark.integration
@pytest.mark.private_fixture
def test_current_sanitized_save_uses_detailed_m5_decoder(tmp_path: Path) -> None:
    source = os.environ.get("PALSERVER_M5_LEVEL_SAV")
    dll = os.environ.get("PALSERVER_OOZ_DLL")
    if not source or not dll:
        pytest.skip("PALSERVER_M5_LEVEL_SAV and PALSERVER_OOZ_DLL are not configured.")
    analysis = verify_stable_parse(Path(source), ooz_dll_path=Path(dll))
    assert analysis.property_decode_mode == "m5_2026_07_read_only_compat"
    assert all(item.found for item in analysis.coverage)
    assert analysis.parse_durations_ms
    cache = tmp_path / "real-save-care.sqlite"
    properties = read_save_properties(Path(source), ooz_dll_path=Path(dll))
    counts = build_world_cache(
        cache,
        properties,
        [],
        snapshot_id="private-real-save",
        source_observed_at=1,
    )
    with sqlite3.connect(cache) as connection:
        total, hp, hunger, sanity, disease_available, activity_available = connection.execute(
            """
            SELECT COUNT(*),
                SUM(current_hp IS NOT NULL),
                SUM(hunger IS NOT NULL),
                SUM(sanity IS NOT NULL),
                SUM(COALESCE(json_extract(detail_json, '$.care.disease_recorded'), 0) = 1),
                SUM(COALESCE(json_extract(detail_json, '$.care.activity_recorded'), 0) = 1)
            FROM pals
            """
        ).fetchone()
    assert total == counts["pals"] and total > 0
    assert hp == total
    assert hunger > 0
    assert sanity == total
    assert disease_available == total
    assert activity_available == total
    assert query_pal_care_summary(cache)["unavailable"] < total

    world = world_cache._property(properties.get("worldSaveData"))
    assert isinstance(world, dict)
    raw_expectations: dict[str, dict[str, float | str]] = {}
    for entry in world_cache._list_property(world.get("CharacterSaveParameterMap")):
        entry_mapping = world_cache._mapping(entry)
        key = world_cache._mapping(entry_mapping.get("key"))
        raw = world_cache._property(world_cache._mapping(entry_mapping.get("value")).get("RawData"))
        if not isinstance(raw, dict):
            continue
        save_parameter = world_cache._property(
            world_cache._mapping(raw.get("object")).get("SaveParameter")
        )
        if not isinstance(save_parameter, dict) or bool(
            world_cache._scalar(save_parameter.get("IsPlayer"))
        ):
            continue
        instance_id = world_cache._id(world_cache._property(key.get("InstanceId")))
        character_id = world_cache._text(
            world_cache._scalar(save_parameter.get("CharacterID"))
        )
        if not instance_id or not character_id:
            continue
        expected: dict[str, float | str] = {}
        hp_value = world_cache._save_hp(save_parameter)
        if hp_value is not None:
            expected["currentHp"] = hp_value
        sanity_value = world_cache._save_number(save_parameter, "SanityValue")
        if sanity_value is not None:
            expected["sanity"] = sanity_value
        disease_value = world_cache._enum_text(save_parameter.get("WorkerSick"))
        if disease_value and world_cache._enum_key(disease_value) not in {"none", "healthy"}:
            expected["disease"] = disease_value
        activity_value = world_cache._enum_text(save_parameter.get("CurrentWorkSuitability"))
        if activity_value and world_cache._enum_key(activity_value) != "none":
            expected["activity"] = activity_value
        full_stomach = world_cache._save_number(save_parameter, "FullStomach")
        maximum = max_full_stomach(character_id)
        if full_stomach is not None and maximum:
            expected["hunger"] = min(100.0, max(0.0, full_stomach / maximum * 100.0))
        if expected:
            raw_expectations[instance_id] = expected

    items, item_total = query_pal_roster(
        cache,
        page=1,
        page_size=total,
        search=None,
        marker="all",
        sort="name",
        care="all",
    )
    cached_care = {str(item["id"]): cast(dict[str, Any], item["care"]) for item in items}
    assert item_total == total
    assert raw_expectations.keys() <= cached_care.keys()
    assert any("hunger" in expected for expected in raw_expectations.values())
    assert any("disease" in expected for expected in raw_expectations.values())
    assert any("activity" in expected for expected in raw_expectations.values())
    for instance_id, expected in raw_expectations.items():
        for field, raw_value in expected.items():
            if isinstance(raw_value, float):
                assert cached_care[instance_id][field] == pytest.approx(raw_value)
            else:
                assert cached_care[instance_id][field] == raw_value
