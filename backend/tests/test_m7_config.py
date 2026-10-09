from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import compress_gvas_to_sav

from palserver_console.auth import AuthStore
from palserver_console.config import AppSettings, ServerProfile, ServerProfileService
from palserver_console.config_editor import ConfigError, ConfigService, parse_config_request
from palserver_console.lifecycle import LifecycleManager, ServerConfiguration
from palserver_console.main import create_app
from palserver_console.monitoring import (
    MonitoringConfigError,
    read_admin_password,
    read_connection_config,
)
from palserver_console.persistence import Database
from palserver_console.world_option import (
    create_world_option,
    read_world_option,
    serialize_world_option,
)


def make_service(
    tmp_path: Path, *, running: bool = False
) -> tuple[ConfigService, dict[str, bool], Path, Path]:
    executable = tmp_path / "PalServer.exe"
    executable.write_bytes(b"exe")
    config = (
        executable.parent
        / "Pal"
        / "Saved"
        / "Config"
        / "WindowsServer"
        / "PalWorldSettings.ini"
    )
    config.parent.mkdir(parents=True)
    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="Test, world",AdminPassword="secret-value",'
        "UnknownThing=(A=1,B=2),CrossplayPlatforms=(Steam,Xbox),"
        "AutoSaveSpan=600.000000,bEnableFastTravel=True)\n",
        encoding="utf-8",
    )
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    state = {"running": running}
    service = ConfigService(
        database, tmp_path / "data", lambda: executable, lambda: state["running"]
    )
    return service, state, executable, config


def make_world_service(
    tmp_path: Path, *, running: bool = False
) -> tuple[ConfigService, dict[str, bool], Path]:
    _, state, executable, _ = make_service(tmp_path, running=running)
    world = executable.parent / "Pal" / "Saved" / "SaveGames" / "0" / "test-world"
    world.mkdir(parents=True)
    header = {
        "magic": 0x53415647,
        "save_game_version": 3,
        "package_file_version_ue4": 522,
        "package_file_version_ue5": 1008,
        "engine_version_major": 5,
        "engine_version_minor": 1,
        "engine_version_patch": 1,
        "engine_version_changelist": 0,
        "engine_version_branch": "++UE5+Release-5.1",
        "custom_version_format": 3,
        "custom_versions": [],
        "save_game_class_name": "/Script/Pal.PalWorldSaveGame",
    }
    level = GvasFile.load({"header": header, "properties": {}, "trailer": "AAAAAA=="})
    (world / "Level.sav").write_bytes(compress_gvas_to_sav(level.write(), 0x31))
    database = Database(tmp_path / "data" / "app.db")
    profile = ServerProfile(executable, executable.parent, "test-world", world)
    service = ConfigService(
        database,
        tmp_path / "data",
        lambda: executable,
        lambda: state["running"],
        lambda: profile,
    )
    return service, state, world


def test_current_always_reads_latest_ini_and_masks_password(tmp_path: Path) -> None:
    service, _, _, config = make_service(tmp_path)
    first = service.current()
    first_fields = cast(dict[str, str], first["fields"])
    assert first_fields["ServerName"] == '"Test, world"'
    assert first_fields["AdminPassword"] == "已配置"
    assert "secret-value" not in str(first)

    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="Manually edited",AdminPassword="new-secret",'
        "AutoSaveSpan=720)\n",
        encoding="utf-8",
    )
    latest = service.current()
    latest_fields = cast(dict[str, str], latest["fields"])
    assert latest_fields["ServerName"] == '"Manually edited"'
    assert latest_fields["AutoSaveSpan"] == "720"
    assert latest["sourceHash"] != first["sourceHash"]


def test_stopped_ini_save_applies_immediately_and_preserves_fields(tmp_path: Path) -> None:
    service, _, _, config = make_service(tmp_path)
    result = service.save_ini({"AutoSaveSpan": "900", "CrossplayPlatforms": "Steam,PS5"})

    assert result["applied"] is True
    assert result["pending"] is False
    actual = config.read_text(encoding="utf-8")
    assert "AutoSaveSpan=900" in actual
    assert "CrossplayPlatforms=(Steam,PS5)" in actual
    assert "UnknownThing=(A=1,B=2)" in actual
    assert 'AdminPassword="secret-value"' in actual
    assert Path(str(result["backupPath"])).is_file()
    assert service.current()["pendingApply"] is None


def test_running_ini_save_waits_then_applies_after_stop(tmp_path: Path) -> None:
    service, state, _, config = make_service(tmp_path, running=True)
    before = config.read_text(encoding="utf-8")
    saved = service.save_ini({"AutoSaveSpan": "900"})

    assert saved["pending"] is True
    assert saved["serverRunning"] is True
    assert config.read_text(encoding="utf-8") == before
    pending = cast(dict[str, object], service.current()["pendingApply"])
    assert pending["kind"] == "ini"

    state["running"] = False
    applied = service.apply_pending()
    assert applied["applied"] is True
    assert "AutoSaveSpan=900" in config.read_text(encoding="utf-8")
    assert service.current()["pendingApply"] is None


@pytest.mark.parametrize("first_kind", ["ini", "world-option"])
def test_pending_other_config_target_is_rejected_without_losing_first_save(
    tmp_path: Path, first_kind: str,
) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    first_save, second_save = (
        (service.save_ini, service.save_world_option)
        if first_kind == "ini" else (service.save_world_option, service.save_ini)
    )
    first_save({"AutoSaveSpan": "901"})
    row = service.database.get_config_draft()
    assert row is not None
    pending = Path(str(row["draft_path"]))
    before = pending.read_bytes()

    with pytest.raises(ConfigError) as error:
        second_save({"bEnableFastTravel": "False"})
    assert error.value.code == "CONFIG_PENDING_TARGET_CONFLICT"
    assert service.database.get_config_draft() == row
    assert pending.read_bytes() == before
    assert len(list(pending.parent.glob("*.json"))) == 1

    state["running"] = False
    service.apply_pending()
    fields = (
        cast(dict[str, str], service.current()["fields"])
        if first_kind == "ini" else cast(dict[str, str], service.current()["worldOptionFields"])
    )
    assert float(fields["AutoSaveSpan"]) == 901
    assert fields["bEnableFastTravel"] == "True"


def test_save_uses_latest_external_ini_as_its_base(tmp_path: Path) -> None:
    service, _, _, config = make_service(tmp_path)
    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="External",AdminPassword="secret-value",'
        "ExternalOnly=42,AutoSaveSpan=700)\n",
        encoding="utf-8",
    )
    service.save_ini({"AutoSaveSpan": "901"})
    actual = config.read_text(encoding="utf-8")
    assert 'ServerName="External"' in actual
    assert "ExternalOnly=42" in actual
    assert "AutoSaveSpan=901" in actual


@pytest.mark.parametrize(
    "fields",
    [
        {"ServerName": "bad\nRCONEnabled=True"},
        {"bEnableFastTravel": "maybe"},
        {"bAllowEnemyCampSpawnNearBaseCamp": "maybe"},
        {"MaxBuildingLimitNumPerPlayer": "250.5"},
        {"UnknownThing": "(A=1,B=2"},
        {"NewUnknownField": "1"},
    ],
)
def test_ini_save_rejects_invalid_payloads(tmp_path: Path, fields: dict[str, str]) -> None:
    service, _, _, _ = make_service(tmp_path)
    with pytest.raises(ConfigError):
        service.save_ini(fields)


def test_config_json_rejects_duplicate_keys() -> None:
    with pytest.raises(ConfigError) as error:
        parse_config_request(b'{"fields":{"AutoSaveSpan":"600","AutoSaveSpan":"900"}}')
    assert error.value.code == "CONFIG_DUPLICATE_KEY"


def test_ini_api_rejects_duplicate_json_fields(tmp_path: Path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    with TestClient(app, base_url="http://127.0.0.1:8210", client=("127.0.0.1", 50000)) as client:
        auth = client.get("/api/auth/status").json()
        response = client.put(
            "/api/config/ini",
            headers={"Origin": "http://127.0.0.1:8210", "X-CSRF-Token": auth["csrfToken"]},
            content=b'{"fields":{"AutoSaveSpan":"600","AutoSaveSpan":"900"}}',
        )
    assert response.status_code == 409
    assert response.json()["errorCode"] == "CONFIG_DUPLICATE_KEY"


def test_stopped_world_option_save_creates_and_reads_effective_file(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    before_create = 621355968000000000 + time.time_ns() // 100
    result = service.save_world_option(
        {
            "AutoSaveSpan": "900",
            "BaseCampWorkerMaxNum": "25",
            "bEnableFastTravel": "False",
            "ServerName": '"Converted"',
            "DeathPenalty": "Item",
            "CrossplayPlatforms": "(Steam,PS5)",
        }
    )
    target = world / "WorldOption.sav"

    assert result["applied"] is True
    assert target.is_file()
    gvas, _, fields = read_world_option(target)
    assert gvas.properties["Timestamp"]["struct_type"] == "DateTime"
    timestamp = gvas.properties["Timestamp"]["value"]
    assert before_create <= timestamp <= 621355968000000000 + time.time_ns() // 100
    assert fields["AutoSaveSpan"] == "900"
    assert fields["BaseCampWorkerMaxNum"] == "25"
    assert fields["bEnableFastTravel"] == "False"
    assert fields["ServerName"] == '"Converted"'
    assert fields["DeathPenalty"] == "Item"
    assert fields["CrossplayPlatforms"] == "(Steam,PS5)"
    current = service.current()
    assert current["effectiveSource"] == "world-option"
    world_fields = cast(dict[str, str], current["worldOptionFields"])
    assert world_fields["BaseCampWorkerMaxNum"] == "25"


@pytest.mark.parametrize("kind", ["ini", "world-option-create", "world-option-update"])
@pytest.mark.parametrize("running", [False, True])
def test_new_world_rules_round_trip_with_independent_building_limits(
    tmp_path: Path, kind: str, running: bool,
) -> None:
    service, state, world = make_world_service(tmp_path, running=running)
    target = service.path() if kind == "ini" else world / "WorldOption.sav"
    if kind == "world-option-update":
        gvas, save_type = create_world_option(world / "Level.sav", {"ExpRate": "3"})
        target.write_bytes(serialize_world_option(gvas, save_type))
    original = target.read_bytes() if target.exists() else None
    fields = {
        "bAllowEnemyCampSpawnNearBaseCamp": "True",
        "FishingDifficultyRate": "0.5",
        "MaxBuildingLimitNum": "1000",
        "MaxBuildingLimitNumPerPlayer": "250",
    }
    save = service.save_ini if kind == "ini" else service.save_world_option
    saved = save(fields)
    assert saved["pending"] is running
    if running:
        assert (target.read_bytes() if target.exists() else None) == original
        state["running"] = False
        assert service.apply_pending()["applied"] is True

    if kind == "ini":
        saved_fields = cast(dict[str, str], service.current()["fields"])
        assert "UnknownThing=(A=1,B=2)" in target.read_text()
    else:
        gvas, _, saved_fields = read_world_option(target)
        settings = gvas.properties["OptionWorldData"]["value"]["Settings"]["value"]
        assert settings["bAllowEnemyCampSpawnNearBaseCamp"]["type"] == "BoolProperty"
        assert settings["FishingDifficultyRate"]["type"] == "FloatProperty"
        assert settings["MaxBuildingLimitNumPerPlayer"]["type"] == "IntProperty"
        if kind == "world-option-update":
            assert saved_fields["ExpRate"] == "3"
    assert {key: saved_fields[key] for key in fields} == fields
    assert set(fields).issubset(cast(list[str], service.current()["schema"]))


def test_world_option_creation_inherits_new_rules_from_ini(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    new_fields = {
        "bAllowEnemyCampSpawnNearBaseCamp": "True",
        "FishingDifficultyRate": "0.5",
        "MaxBuildingLimitNumPerPlayer": "250",
    }
    service.save_ini(new_fields)
    service.save_world_option({"ExpRate": "3"})

    _, _, saved_fields = read_world_option(world / "WorldOption.sav")
    assert {key: saved_fields[key] for key in new_fields} == new_fields


def test_new_world_rules_reset_to_defaults_removes_only_changed_properties(
    tmp_path: Path,
) -> None:
    service, _, world = make_world_service(tmp_path)
    service.save_world_option({
        "bAllowEnemyCampSpawnNearBaseCamp": "True",
        "FishingDifficultyRate": "0.5",
        "MaxBuildingLimitNum": "1000",
        "MaxBuildingLimitNumPerPlayer": "250",
    })
    defaults = {
        "bAllowEnemyCampSpawnNearBaseCamp": "False",
        "FishingDifficultyRate": "1.0",
        "MaxBuildingLimitNumPerPlayer": "0",
    }
    service.save_world_option(defaults)

    _, _, saved_fields = read_world_option(world / "WorldOption.sav")
    assert set(defaults).isdisjoint(saved_fields)
    assert saved_fields["MaxBuildingLimitNum"] == "1000"
    current = cast(dict[str, str], service.current()["worldOptionFields"])
    assert current["bAllowEnemyCampSpawnNearBaseCamp"] == "False"
    assert current["FishingDifficultyRate"] == "1"
    assert current["MaxBuildingLimitNumPerPlayer"] == "0"


def test_sparse_world_option_uses_pal_conf_defaults_for_missing_fields(
    tmp_path: Path,
) -> None:
    service, _, world = make_world_service(tmp_path)
    gvas, save_type = create_world_option(
        world / "Level.sav", {"BaseCampWorkerMaxNum": "25"}
    )
    (world / "WorldOption.sav").write_bytes(serialize_world_option(gvas, save_type))

    current = service.current()
    schema = cast(list[str], current["worldOptionSchema"])
    world_fields = cast(dict[str, str], current["worldOptionFields"])

    assert len(schema) == 109
    assert "Difficulty" not in schema
    assert set(world_fields) == set(schema)
    assert "bEnableVoiceChat" not in schema
    assert world_fields["BaseCampWorkerMaxNum"] == "25"
    assert world_fields["AutoSaveSpan"] == "30"
    assert world_fields["ServerName"] == '"Default Palworld Server"'
    assert world_fields["bAllowEnemyCampSpawnNearBaseCamp"] == "False"
    assert world_fields["FishingDifficultyRate"] == "1"
    assert world_fields["MaxBuildingLimitNumPerPlayer"] == "0"
    assert current["worldOptionAdminPasswordConfigured"] is False
    assert world_fields["AdminPassword"] == "未配置"


def test_world_option_reset_to_default_removes_explicit_field(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    gvas, save_type = create_world_option(
        world / "Level.sav",
        {"AutoSaveSpan": "900", "BaseCampWorkerMaxNum": "25"},
    )
    (world / "WorldOption.sav").write_bytes(serialize_world_option(gvas, save_type))

    service.save_world_option({"AutoSaveSpan": "30"})

    _, _, saved_fields = read_world_option(world / "WorldOption.sav")
    assert "AutoSaveSpan" not in saved_fields
    assert "Difficulty" not in saved_fields
    assert saved_fields["BaseCampWorkerMaxNum"] == "25"
    current_fields = cast(dict[str, str], service.current()["worldOptionFields"])
    assert current_fields["AutoSaveSpan"] == "30"


def test_running_world_option_save_waits_and_is_verified_after_stop(tmp_path: Path) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    result = service.save_world_option({"BaseCampWorkerMaxNum": "25"})
    assert result["pending"] is True
    assert not (world / "WorldOption.sav").exists()
    pending = cast(dict[str, object], service.current()["pendingApply"])
    assert pending["kind"] == "world-option"

    state["running"] = False
    applied = service.apply_pending()
    assert applied["applied"] is True
    _, _, fields = read_world_option(world / "WorldOption.sav")
    assert fields["BaseCampWorkerMaxNum"] == "25"


def test_config_read_rejects_reparse_point(tmp_path: Path) -> None:
    service, _, _, _ = make_service(tmp_path)
    with patch(
        "palserver_console.config_editor.assert_no_reparse_points",
        side_effect=ValueError("reparse point"),
    ), pytest.raises(ConfigError) as error:
        service.current()
    assert error.value.code == "PATH_REPARSE_POINT"


def test_world_option_creation_preview_includes_defaults(tmp_path: Path) -> None:
    service, _, _ = make_world_service(tmp_path)
    current = service.current()
    fields = cast(dict[str, str], current["worldOptionFields"])
    assert set(fields) == set(cast(list[str], current["worldOptionSchema"]))
    assert fields["DayTimeSpeedRate"] == "1"
    assert fields["bEnableInvaderEnemy"] == "True"
    assert fields["AutoSaveSpan"] == "600.000000"
    assert fields["bAllowEnemyCampSpawnNearBaseCamp"] == "False"
    assert fields["FishingDifficultyRate"] == "1"
    assert fields["MaxBuildingLimitNumPerPlayer"] == "0"


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_pending_changes_preserve_external_edits_before_save_and_apply(
    tmp_path: Path, kind: str,
) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    ini = service.path()
    sav = world / "WorldOption.sav"
    if kind == "world-option":
        gvas, save_type = create_world_option(world / "Level.sav", {"ExpRate": "2"})
        sav.write_bytes(serialize_world_option(gvas, save_type))

    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"AutoSaveSpan": "900"})
    if kind == "ini":
        ini.write_text(ini.read_text().replace('"Test, world"', '"External"'), encoding="utf-8")
    else:
        gvas, save_type = create_world_option(world / "Level.sav", {"ExpRate": "3"})
        sav.write_bytes(serialize_world_option(gvas, save_type))
    save({"bEnableFastTravel": "False"})

    # A separate edit after the last save must also survive shutdown/application.
    if kind == "ini":
        ini.write_text(
            ini.read_text().replace("UnknownThing=(A=1,B=2)", "UnknownThing=(A=4,B=5)"),
            encoding="utf-8",
        )
    else:
        gvas, save_type = create_world_option(
            world / "Level.sav", {"ExpRate": "3", "WorkSpeedRate": "4"}
        )
        sav.write_bytes(serialize_world_option(gvas, save_type))
    state["running"] = False
    service.apply_pending()

    if kind == "ini":
        actual = ini.read_text()
        assert 'ServerName="External"' in actual
        assert "UnknownThing=(A=4,B=5)" in actual
        assert "AutoSaveSpan=900" in actual
        assert "bEnableFastTravel=False" in actual
    else:
        _, _, fields = read_world_option(sav)
        assert fields["ExpRate"] == "3"
        assert fields["WorkSpeedRate"] == "4"
        assert fields["AutoSaveSpan"] == "900"
        assert fields["bEnableFastTravel"] == "False"


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_pending_same_field_conflict_preserves_files_until_explicit_resave(
    tmp_path: Path, kind: str,
) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    target = service.path() if kind == "ini" else world / "WorldOption.sav"
    save = service.save_ini if kind == "ini" else service.save_world_option
    if kind == "world-option":
        gvas, save_type = create_world_option(world / "Level.sav", {"AutoSaveSpan": "600"})
        target.write_bytes(serialize_world_option(gvas, save_type))
    save({"AutoSaveSpan": "900"})
    if kind == "ini":
        target.write_text(
            target.read_text(encoding="utf-8").replace(
                "AutoSaveSpan=600.000000", "AutoSaveSpan=777",
            ),
            encoding="utf-8",
        )
    else:
        gvas, save_type = create_world_option(world / "Level.sav", {"AutoSaveSpan": "777"})
        target.write_bytes(serialize_world_option(gvas, save_type))
    # Saving another field must not erase the original field's conflict baseline.
    save({"bEnableFastTravel": "False"})
    before = target.read_bytes()
    row = service.database.get_config_draft()
    assert row is not None
    pending = Path(str(row["draft_path"]))
    pending_before = pending.read_bytes()
    state["running"] = False
    with pytest.raises(ConfigError) as error:
        service.apply_pending()
    assert error.value.code == "CONFIG_CONFLICT"
    assert target.read_bytes() == before
    assert pending.read_bytes() == pending_before
    assert service.database.get_config_draft() == row
    assert not list(target.parent.glob(f"{target.name}.*.bak"))

    save({"AutoSaveSpan": "901"})
    current = service.current()
    fields = cast(dict[str, str], current["fields" if kind == "ini" else "worldOptionFields"])
    assert float(fields["AutoSaveSpan"]) == 901
    assert fields["bEnableFastTravel"] == "False"
    assert service.database.get_config_draft() is None


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_same_second_saves_keep_distinct_original_backups(tmp_path: Path, kind: str) -> None:
    service, _, world = make_world_service(tmp_path)
    target = service.path() if kind == "ini" else world / "WorldOption.sav"
    save = service.save_ini if kind == "ini" else service.save_world_option
    if kind == "world-option":
        save({"AutoSaveSpan": "700"})
    original = target.read_bytes()
    with patch("palserver_console.config_editor.time.strftime", return_value="same-second"):
        first = save({"AutoSaveSpan": "900"})
        second = save({"AutoSaveSpan": "901"})
    assert first["backupPath"] != second["backupPath"]
    assert Path(str(first["backupPath"])).read_bytes() == original


def test_world_option_credentials_and_ports_reach_runtime_readers(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    saved_password = 'test-only, quoted "credential"'
    service.save_world_option({
        "AdminPassword": json.dumps(saved_password),
        "RESTAPIEnabled": "True", "RESTAPIPort": "9001",
        "RCONEnabled": "True", "RCONPort": "9002",
    })
    connection = read_connection_config(service.path().parents[4], world)
    assert connection.rest_url == "http://127.0.0.1:9001"
    assert connection.rest_enabled is True
    assert connection.rcon_port == 9002
    assert connection.rcon_enabled is True
    password_matches = connection.admin_password.reveal() == saved_password
    assert password_matches
    auth_password_matches = read_admin_password(service.path().parents[4], world) == saved_password
    assert auth_password_matches


def test_sav_password_rotation_runs_only_after_successful_application(tmp_path: Path) -> None:
    service, state, _ = make_world_service(tmp_path, running=True)
    rotations: list[bool] = []
    service.admin_password_rotation_callback = lambda: rotations.append(True)
    service.save_world_option({"AdminPassword": '"new-test-only-secret"'})
    assert not rotations
    state["running"] = False
    service.apply_pending()
    assert rotations == [True]
    service.save_world_option({"AutoSaveSpan": "901"})
    service.save_ini({"AdminPassword": '"ignored-test-only-secret"'})
    assert rotations == [True]


def test_bound_world_sav_reaches_auth_and_lifecycle_consumers(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    service.database.save_server_profile(
        str(executable), str(executable.parent), world.name, str(world)
    )
    auth = AuthStore(
        service.database, AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    )
    service.admin_password_rotation_callback = auth.revoke_lan_sessions
    lan_cookie, _ = auth.create_session("192.0.2.55", local=False)
    local_cookie, _ = auth.create_session("127.0.0.1", local=True)
    service.save_world_option({
        "AdminPassword": '"new-test-only-secret"',
        "RESTAPIEnabled": "True", "RESTAPIPort": "9001",
    })
    assert auth.verify_admin_password("new-test-only-secret")
    assert not auth.verify_admin_password("secret-value")
    assert auth.read_session(lan_cookie, "192.0.2.55") is None
    assert auth.read_session(local_cookie, "127.0.0.1") is not None
    manager = LifecycleManager(service.database, profile_provider=service.profile_provider)
    assert manager.load_configuration().rest_url == "http://127.0.0.1:9001"


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_restart_applies_latest_config_after_exit_and_before_launch(
    tmp_path: Path, kind: str,
) -> None:
    service, state, world = make_world_service(tmp_path)
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    service.save_ini({"RESTAPIEnabled": "True", "AdminPassword": '"test-only-secret"'})
    if kind == "world-option":
        service.save_world_option({"RESTAPIEnabled": "True"})
    state["running"] = True
    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"RESTAPIPort": "9001"})
    process = MagicMock()
    rest = MagicMock()
    events: list[str] = []
    process.matching_pids.side_effect = lambda _: [701] if state["running"] else []

    def exit_server(pids: list[int], timeout: float) -> bool:
        assert read_connection_config(executable.parent, world).rest_url.endswith(":8212")
        events.append("exit")
        state["running"] = False
        return True

    def start_server(path: Path, arguments: tuple[str, ...]) -> MagicMock:
        assert not state["running"]
        assert service.database.get_config_draft() is None
        assert read_connection_config(executable.parent, world).rest_url.endswith(":9001")
        events.append("start")
        state["running"] = True
        handle = MagicMock()
        handle.poll.return_value = None
        return handle

    process.wait_for_exit.side_effect = exit_server
    process.start.side_effect = start_server
    manager = LifecycleManager(
        service.database, process=process, rest_factory=lambda _: rest,
        profile_provider=service.profile_provider,
    )
    manager.set_pending_config_apply(service.apply_pending)
    result = manager.begin("restart", "restart-with-pending", countdown_seconds=0)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        operation = service.database.operation(cast(str, result["id"]))
        if operation and operation["state"] not in {"queued", "running"}:
            break
        time.sleep(0.01)
    assert operation and operation["state"] == "succeeded"
    assert events == ["exit", "start"]


def test_sparse_or_unreadable_sav_does_not_use_ini_credentials(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    gvas, save_type = create_world_option(world / "Level.sav", {"BaseCampWorkerMaxNum": "25"})
    target = world / "WorldOption.sav"
    target.write_bytes(serialize_world_option(gvas, save_type))
    assert read_admin_password(service.path().parents[4], world) is None
    target.write_bytes(b"invalid synthetic sav")
    with pytest.raises(MonitoringConfigError) as error:
        read_connection_config(service.path().parents[4], world)
    assert error.value.code == "WORLD_OPTION_READ_FAILED"


def test_legacy_pending_requires_resave_without_overwriting_latest_ini(tmp_path: Path) -> None:
    service, _, _, ini = make_service(tmp_path)
    pending = tmp_path / "data" / "pending" / "PalWorldSettings.ini"
    pending.parent.mkdir()
    pending.write_text(ini.read_text(), encoding="utf-8")
    service.database.save_config_draft(str(pending), "", 0, "pending-ini", None)
    latest = ini.read_bytes()
    with pytest.raises(ConfigError) as error:
        service.apply_pending()
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert ini.read_bytes() == latest
    assert pending.is_file()
    service.save_ini({"AutoSaveSpan": "901"})
    assert "AutoSaveSpan=901" in ini.read_text()


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_raw_legacy_pending_rejects_partial_resave(tmp_path: Path, kind: str) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    save = service.save_ini if kind == "ini" else service.save_world_option
    pending = tmp_path / "data" / "pending" / (
        "PalWorldSettings.ini" if kind == "ini" else "WorldOption.sav"
    )
    pending.parent.mkdir()
    if kind == "ini":
        pending.write_text(
            service.path().read_text().replace("600.000000", "900").replace(
                "bEnableFastTravel=True", "bEnableFastTravel=False"
            ),
            encoding="utf-8",
        )
    else:
        state["running"] = False
        save({"AutoSaveSpan": "600"})
        state["running"] = True
        original = read_world_option(world / "WorldOption.sav")[2]
        gvas, save_type = create_world_option(
            world / "Level.sav",
            {**original, "AutoSaveSpan": "900", "bEnableFastTravel": "False"},
        )
        pending.write_bytes(serialize_world_option(gvas, save_type))
    service.database.save_config_draft(str(pending), "", 0, f"pending-{kind}", None)
    row = service.database.get_config_draft()
    original_pending = pending.read_bytes()
    with pytest.raises(ConfigError) as error:
        save({"AutoSaveSpan": "901"})
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert pending.read_bytes() == original_pending
    assert service.database.get_config_draft() == row

    state["running"] = False
    save({"AutoSaveSpan": "901", "bEnableFastTravel": "False"})
    current = service.current()
    fields = cast(dict[str, str], current["fields" if kind == "ini" else "worldOptionFields"])
    assert float(fields["AutoSaveSpan"]) == 901
    assert fields["bEnableFastTravel"] == "False"
    assert service.database.get_config_draft() is None


def test_removed_difficulty_control_preserves_existing_sav_field(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    gvas, save_type = create_world_option(world / "Level.sav", {"Difficulty": "Custom"})
    (world / "WorldOption.sav").write_bytes(serialize_world_option(gvas, save_type))
    current = service.current()
    assert "Difficulty" not in cast(dict[str, str], current["worldOptionFields"])
    with pytest.raises(ConfigError) as error:
        service.save_world_option({"Difficulty": "Normal"})
    assert error.value.code == "WORLD_OPTION_UNSUPPORTED_FIELD"
    service.save_world_option({"AutoSaveSpan": "900"})
    _, _, fields = read_world_option(world / "WorldOption.sav")
    assert fields["Difficulty"] == "Custom"


def test_disabled_rest_does_not_allow_config_apply_while_process_is_running(tmp_path: Path) -> None:
    service, state, world = make_world_service(tmp_path)
    service.save_world_option({"RESTAPIEnabled": "False"})
    target = world / "WorldOption.sav"
    before = target.read_bytes()
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    process = MagicMock()
    process.matching_pids.return_value = [701]
    manager = LifecycleManager(
        service.database, process=process, profile_provider=service.profile_provider
    )
    service.running = lambda: manager.status()["state"] == "running"
    state["running"] = True
    assert service.save_world_option({"AutoSaveSpan": "901"})["pending"] is True
    assert target.read_bytes() == before


def test_saved_config_applies_after_exit_outside_console(tmp_path: Path) -> None:
    service, state, _, ini = make_service(tmp_path, running=True)
    service.save_ini({"AutoSaveSpan": "901"})
    service.start()
    try:
        state["running"] = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and service.database.get_config_draft() is not None:
            time.sleep(0.01)
        assert service.database.get_config_draft() is None
        assert "AutoSaveSpan=901" in ini.read_text()
    finally:
        service.stop()


def test_restore_recovery_blocks_pending_apply_without_losing_changes(tmp_path: Path) -> None:
    service, state, _, ini = make_service(tmp_path, running=True)
    original = ini.read_bytes()
    service.save_ini({"AutoSaveSpan": "901"})
    state["running"] = False
    with (
        patch.object(service.database, "restore_recovery_active", return_value=True),
        pytest.raises(ConfigError) as error,
    ):
        service.apply_pending()
    assert error.value.code == "RESTORE_RECOVERY_REQUIRED"
    assert ini.read_bytes() == original
    assert service.database.get_config_draft() is not None
    service.apply_pending()
    assert "AutoSaveSpan=901" in ini.read_text()


def test_failed_sav_write_keeps_pending_and_does_not_rotate_password(tmp_path: Path) -> None:
    service, state, world = make_world_service(tmp_path)
    service.save_world_option({"AutoSaveSpan": "700"})
    target = world / "WorldOption.sav"
    original = target.read_bytes()
    rotations: list[bool] = []
    service.admin_password_rotation_callback = lambda: rotations.append(True)
    state["running"] = True
    service.save_world_option({"AdminPassword": '"new-test-only-secret"'})
    state["running"] = False
    with (
        patch(
            "palserver_console.config_editor.os.replace", side_effect=OSError("synthetic failure")
        ),
        pytest.raises(ConfigError) as error,
    ):
        service.apply_pending()
    assert error.value.code == "WORLD_OPTION_WRITE_FAILED"
    assert not rotations
    assert target.read_bytes() == original
    assert service.database.get_config_draft() is not None


def bind_two_test_worlds(
    service: ConfigService, world: Path,
) -> tuple[ServerProfileService, Path]:
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    other_world = world.parent / "other-world"
    other_world.mkdir()
    (other_world / "Level.sav").write_bytes((world / "Level.sav").read_bytes())
    for candidate in (world, other_world):
        gvas, save_type = create_world_option(candidate / "Level.sav", {"AutoSaveSpan": "600"})
        (candidate / "WorldOption.sav").write_bytes(serialize_world_option(gvas, save_type))
    profiles = ServerProfileService(service.database)
    profiles.bind(executable, world.name)
    service.profile_provider = profiles.profile
    return profiles, other_world


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_pending_apply_is_bound_to_saved_world(tmp_path: Path, kind: str) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    profiles, other_world = bind_two_test_worlds(service, world)
    save = service.save_ini if kind == "ini" else service.save_world_option
    original_ini = service.path().read_bytes()
    original_savs = [
        (candidate / "WorldOption.sav").read_bytes() for candidate in (world, other_world)
    ]
    save({"AutoSaveSpan": "900"})
    profiles.bind(profiles.profile().executable_path, other_world.name)
    state["running"] = False
    with pytest.raises(ConfigError) as error:
        service.apply_pending()
    assert error.value.code == "CONFIG_PENDING_TARGET_MISMATCH"

    attempted = threading.Event()
    apply = service._apply_pending_exclusive

    def observe_apply() -> dict[str, object]:
        try:
            return apply()
        finally:
            attempted.set()

    with patch.object(service, "_apply_pending_exclusive", side_effect=observe_apply):
        service.start()
        try:
            assert attempted.wait(3)
        finally:
            service.stop()
    assert service.path().read_bytes() == original_ini
    assert [
        (candidate / "WorldOption.sav").read_bytes() for candidate in (world, other_world)
    ] == original_savs
    assert service.database.get_config_draft() is not None
    profiles.bind(profiles.profile().executable_path, world.name)
    assert service.apply_pending()["applied"] is True


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_resaving_after_world_switch_does_not_merge_other_world_pending(
    tmp_path: Path, kind: str,
) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    profiles, other_world = bind_two_test_worlds(service, world)
    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"AutoSaveSpan": "900"})
    profiles.bind(profiles.profile().executable_path, other_world.name)
    save({"bEnableFastTravel": "False"})
    state["running"] = False
    service.apply_pending()
    if kind == "ini":
        fields = cast(dict[str, str], service.current()["fields"])
    else:
        fields = read_world_option(other_world / "WorldOption.sav")[2]
    assert float(fields["AutoSaveSpan"]) == 600
    assert fields["bEnableFastTravel"] == "False"


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_pending_without_baseline_preserves_fields_until_complete_resave(
    tmp_path: Path, kind: str,
) -> None:
    service, state, _ = make_world_service(tmp_path, running=True)
    save = service.save_ini if kind == "ini" else service.save_world_option
    changes = {
        "AutoSaveSpan": "900", "bEnableFastTravel": "False", "AdminPassword": "new-secret",
    }
    save(changes)
    row = service.database.get_config_draft()
    assert row is not None
    pending = Path(str(row["draft_path"]))
    payload = json.loads(pending.read_text(encoding="utf-8"))
    del payload["baseline"]
    pending.write_text(json.dumps(payload), encoding="utf-8")
    original_pending = pending.read_bytes()

    with pytest.raises(ConfigError) as error:
        save({"AutoSaveSpan": "901"})
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert pending.read_bytes() == original_pending
    assert service.database.get_config_draft() == row
    with pytest.raises(ConfigError) as error:
        save({**changes, "AdminPassword": "已配置"})
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert pending.read_bytes() == original_pending
    assert service.database.get_config_draft() == row
    state["running"] = False
    with pytest.raises(ConfigError) as error:
        service.apply_pending()
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert pending.read_bytes() == original_pending

    save({**changes, "AutoSaveSpan": "901"})
    current = service.current()
    fields = cast(dict[str, str], current["fields" if kind == "ini" else "worldOptionFields"])
    assert float(fields["AutoSaveSpan"]) == 901
    assert fields["bEnableFastTravel"] == "False"
    assert service.database.get_config_draft() is None


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_pending_without_target_binding_requires_resave(tmp_path: Path, kind: str) -> None:
    service, state, _ = make_world_service(tmp_path, running=True)
    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"AutoSaveSpan": "900"})
    row = service.database.get_config_draft()
    assert row is not None
    pending = Path(str(row["draft_path"]))
    pending.write_text(json.dumps({"fields": {"AutoSaveSpan": "900"}}), encoding="utf-8")
    state["running"] = False
    with pytest.raises(ConfigError) as error:
        service.apply_pending()
    assert error.value.code == "CONFIG_PENDING_RESAVE_REQUIRED"
    assert pending.is_file()
    save({"AutoSaveSpan": "901"})
    assert service.database.get_config_draft() is None


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_start_applies_pending_before_loading_rest_configuration(tmp_path: Path, kind: str) -> None:
    service, state, _ = make_world_service(tmp_path)
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"RESTAPIEnabled": "False"})
    state["running"] = True
    save({"RESTAPIEnabled": "True", "RESTAPIPort": "9001"})
    state["running"] = False
    process = MagicMock()
    process.matching_pids.return_value = []
    process.start.return_value.poll.return_value = None
    manager = LifecycleManager(
        service.database, process=process, profile_provider=service.profile_provider,
        control_lock=service.control_lock,
    )
    manager.set_pending_config_apply(service.apply_pending)
    events: list[str] = []
    load = manager.load_configuration

    def load_after_apply() -> ServerConfiguration:
        config = load()
        assert service.database.get_config_draft() is None
        assert config.rest_url.endswith(":9001")
        events.append("load")
        return config

    with patch.object(manager, "load_configuration", side_effect=load_after_apply):
        created = manager.begin("start", f"start-pending-before-rest-{kind}")
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            result = service.database.operation(cast(str, created["id"]))
            if result and result["state"] not in {"queued", "running"}:
                break
            time.sleep(0.01)
    assert result and result["state"] == "succeeded", result
    assert events == ["load"]
    assert process.start.call_count == 1


@pytest.mark.parametrize("kind", ["ini", "world-option"])
def test_start_does_not_apply_pending_to_running_server_with_disabled_rest(
    tmp_path: Path, kind: str,
) -> None:
    service, state, _ = make_world_service(tmp_path)
    executable = service.path().parents[4] / "PalServer.exe"
    service.database.set_setting("server.executable", str(executable))
    save = service.save_ini if kind == "ini" else service.save_world_option
    save({"RESTAPIEnabled": "False"})
    state["running"] = True
    save({"RESTAPIEnabled": "True"})
    process = MagicMock()
    process.matching_pids.return_value = [701]
    manager = LifecycleManager(
        service.database, process=process, profile_provider=service.profile_provider,
        control_lock=service.control_lock,
    )
    apply = MagicMock(wraps=service.apply_pending)
    manager.set_pending_config_apply(apply)
    created = manager.begin("start", f"running-rest-disabled-{kind}")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = service.database.operation(cast(str, created["id"]))
        if result and result["state"] not in {"queued", "running"}:
            break
        time.sleep(0.01)
    assert result and result["state"] == "failed"
    assert result["error_code"] == "ALREADY_RUNNING"
    assert not apply.called
    assert not process.start.called
    assert service.database.get_config_draft() is not None


def test_server_profile_api_switch_waits_for_config_control_lock(tmp_path: Path) -> None:
    service, _, world = make_world_service(tmp_path)
    _, other_world = bind_two_test_worlds(service, world)
    executable = service.path().parents[4] / "PalServer.exe"
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    deps = app.state.dependencies
    reached = threading.Event()
    bound = threading.Event()
    candidates = deps.profiles.candidates
    bind = deps.profiles.bind

    def observe_candidates(path: Path) -> object:
        reached.set()
        return candidates(path)

    def observe_bind(path: Path, world_id: str, arguments: str) -> object:
        bound.set()
        return bind(path, world_id, arguments)

    with (
        TestClient(app, base_url="http://127.0.0.1:8223", client=("127.0.0.1", 50000)) as client,
        patch.object(deps.profiles, "candidates", side_effect=observe_candidates),
        patch.object(deps.profiles, "bind", side_effect=observe_bind),
        ThreadPoolExecutor(max_workers=1) as executor,
    ):
        auth = client.get("/api/auth/status").json()
        with deps.lifecycle.control_lock:
            request = executor.submit(
                client.put, "/api/server/settings",
                headers={"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]},
                json={"executablePath": str(executable), "worldId": other_world.name},
            )
            assert reached.wait(3)
            assert not bound.wait(0.1)
        assert request.result(timeout=3).status_code == 200
        assert bound.is_set()
