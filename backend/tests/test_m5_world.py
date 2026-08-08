from __future__ import annotations

import gzip
import os
import subprocess
import uuid
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings, ProfileError, ServerProfileService
from palserver_console.main import create_app
from palserver_console.persistence import Database
from palserver_console.world.adapter import verify_stable_parse
from palserver_console.world.cache import build_world_cache, query_cache
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
                            character_id="SheepBall",
                            nickname="工作帕鲁甲",
                            is_player=False,
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
    cache = tmp_path / "world-cache.sqlite"
    counts = build_world_cache(
        cache, level, players, snapshot_id="fixture", source_observed_at=1
    )

    assert counts["bases"] == 2
    assert counts["work_pals"] == 2
    bases, base_total = query_cache(cache, "bases", page=1, page_size=1)
    work_pals, work_total = query_cache(cache, "work-pals", page=1, page_size=50)
    assert base_total == 2
    assert len(bases) == 1
    assert work_total == 2
    assert {item["baseId"] for item in work_pals} == {
        str(uuid.UUID(int=101)),
        str(uuid.UUID(int=102)),
    }


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

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert len(response.json()["items"]) == 1
    assert rejected.status_code == 422
    assert rejected.json()["errorCode"] == "INVALID_WORLD_PAGE"


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


@pytest.mark.integration
def test_current_sanitized_save_uses_detailed_m5_decoder() -> None:
    source = os.environ.get("PALSERVER_M5_LEVEL_SAV")
    dll = os.environ.get("PALSERVER_OOZ_DLL")
    if not source or not dll:
        pytest.skip("PALSERVER_M5_LEVEL_SAV and PALSERVER_OOZ_DLL are not configured.")
    analysis = verify_stable_parse(Path(source), ooz_dll_path=Path(dll))
    assert analysis.property_decode_mode == "m5_2026_07_read_only_compat"
    assert all(item.found for item in analysis.coverage)
    assert analysis.parse_durations_ms


@pytest.mark.integration
def test_local_m5_fixture_contains_detailed_decoded_fields() -> None:
    fixture = (
        Path(__file__).resolve().parents[2]
        / "fixtures"
        / "sanitized"
        / "level.m5.json.gz"
    )
    if not fixture.is_file():
        pytest.skip("No local detailed M5 fixture is available.")
    assert fixture.stat().st_mode & 0o200 == 0
    required = {b'"SaveParameter"', b'"trailing_bytes"', b'"container_id"'}
    found: set[bytes] = set()
    with gzip.open(fixture, "rb") as source:
        while chunk := source.read(1024 * 1024):
            found.update(marker for marker in required if marker in chunk)
            if found == required:
                break
    assert found == required
