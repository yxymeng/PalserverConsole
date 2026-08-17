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
from typing import Any

import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings, ProfileError, ServerProfileService
from palserver_console.main import create_app
from palserver_console.persistence import Database
from palserver_console.world.adapter import verify_stable_parse
from palserver_console.world.cache import (
    build_world_cache,
    entity_detail,
    query_cache,
    read_cache_metadata,
)
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
                        ),
                        _character(
                            player_id,
                            pal_b,
                            character_id="CatMage",
                            nickname="工作帕鲁乙",
                            is_player=False,
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


def test_pal_list_includes_owner_base_names_and_display_traits(tmp_path: Path) -> None:
    level, players = _synthetic_properties()
    cache = tmp_path / "world-cache.sqlite"
    build_world_cache(cache, level, players, snapshot_id="fixture", source_observed_at=1)

    rows, total = query_cache(cache, "pals", page=1, page_size=50)
    boss = next(row for row in rows if row["characterId"] == "BOSS_SheepBall")

    assert total == 2
    assert boss["ownerName"] == "测试玩家"
    assert boss["baseName"] == "据点甲"
    assert boss["detail"] == {
        "gender": "EPalGenderType::Male",
        "rank": 3,
        "isBoss": True,
        "isPredator": False,
        "isLucky": True,
        "isAwakened": True,
        "isImported": True,
    }


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
        pal_detail = client.get(f"/api/world/pals/{uuid.UUID(int=401)}")

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert len(response.json()["items"]) == 1
    assert rejected.status_code == 422
    assert rejected.json()["errorCode"] == "INVALID_WORLD_PAGE"
    assert pal_detail.status_code == 200
    assert pal_detail.json()["owner"]["name"] == "测试玩家"


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
        assert failed.wait(timeout=1)
        time.sleep(0.025)
        assert attempts == 1
        assert scheduled.wait(timeout=1)
        retry_delay = service.background_status()["retryDelaySeconds"]
        assert isinstance(retry_delay, (int, float))  # noqa: UP038
        assert retry_delay > 0
        assert retried.wait(timeout=2)
    finally:
        service._stop.set()
        service._wake.set()
        thread.join(timeout=2)

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
        assert parsed.wait(timeout=1)
    finally:
        service._stop.set()
        service._wake.set()
        thread.join(timeout=2)

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


@pytest.mark.integration
@pytest.mark.private_fixture
def test_current_sanitized_save_uses_detailed_m5_decoder() -> None:
    source = os.environ.get("PALSERVER_M5_LEVEL_SAV")
    dll = os.environ.get("PALSERVER_OOZ_DLL")
    if not source or not dll:
        pytest.skip("PALSERVER_M5_LEVEL_SAV and PALSERVER_OOZ_DLL are not configured.")
    analysis = verify_stable_parse(Path(source), ooz_dll_path=Path(dll))
    assert analysis.property_decode_mode == "m5_2026_07_read_only_compat"
    assert all(item.found for item in analysis.coverage)
    assert analysis.parse_durations_ms
