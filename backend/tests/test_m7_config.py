from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.palsav import compress_gvas_to_sav

from palserver_console.config import AppSettings, ServerProfile
from palserver_console.config_editor import ConfigError, ConfigService, parse_config_request
from palserver_console.main import create_app
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
    assert first["fields"]["ServerName"] == '"Test, world"'
    assert first["fields"]["AdminPassword"] == "已配置"
    assert "secret-value" not in str(first)

    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="Manually edited",AdminPassword="new-secret",'
        "AutoSaveSpan=720)\n",
        encoding="utf-8",
    )
    latest = service.current()
    assert latest["fields"]["ServerName"] == '"Manually edited"'
    assert latest["fields"]["AutoSaveSpan"] == "720"
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
    assert service.current()["pendingApply"]["kind"] == "ini"

    state["running"] = False
    applied = service.apply_pending()
    assert applied["applied"] is True
    assert "AutoSaveSpan=900" in config.read_text(encoding="utf-8")
    assert service.current()["pendingApply"] is None


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
    assert current["worldOptionFields"]["BaseCampWorkerMaxNum"] == "25"


def test_sparse_world_option_uses_pal_conf_defaults_for_missing_fields(
    tmp_path: Path,
) -> None:
    service, _, world = make_world_service(tmp_path)
    gvas, save_type = create_world_option(
        world / "Level.sav", {"BaseCampWorkerMaxNum": "25"}
    )
    (world / "WorldOption.sav").write_bytes(serialize_world_option(gvas, save_type))

    current = service.current()

    assert len(current["worldOptionSchema"]) == 107
    assert set(current["worldOptionFields"]) == set(current["worldOptionSchema"])
    assert "bEnableVoiceChat" not in current["worldOptionSchema"]
    assert current["worldOptionFields"]["BaseCampWorkerMaxNum"] == "25"
    assert current["worldOptionFields"]["AutoSaveSpan"] == "30"
    assert current["worldOptionFields"]["ServerName"] == '"Default Palworld Server"'
    assert current["worldOptionAdminPasswordConfigured"] is False
    assert current["worldOptionFields"]["AdminPassword"] == "未配置"


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
    assert service.current()["worldOptionFields"]["AutoSaveSpan"] == "30"


def test_running_world_option_save_waits_and_is_verified_after_stop(tmp_path: Path) -> None:
    service, state, world = make_world_service(tmp_path, running=True)
    result = service.save_world_option({"BaseCampWorkerMaxNum": "25"})
    assert result["pending"] is True
    assert not (world / "WorldOption.sav").exists()
    assert service.current()["pendingApply"]["kind"] == "world-option"

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
