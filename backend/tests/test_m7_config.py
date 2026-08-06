from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.config_editor import ConfigError, ConfigService
from palserver_console.main import create_app
from palserver_console.persistence import Database


def make_service(tmp_path: Path, running: bool = False) -> tuple[ConfigService, Path, Path]:
    exe = tmp_path / "PalServer.exe"
    exe.write_bytes(b"exe")
    config = exe.parent / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    config.parent.mkdir(parents=True)
    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="Test, world",AdminPassword=secret-value,'
        "UnknownThing=(A=1,B=2),"
        "AutoSaveSpan=600.000000,bEnableFastTravel=True)\n",
        encoding="utf-8",
    )
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    return ConfigService(database, tmp_path / "data", lambda: exe, lambda: running), exe, config


def test_ini_round_trip_preserves_order_unknown_and_masks_password(tmp_path: Path) -> None:
    service, _, _ = make_service(tmp_path)
    result = service.current()
    fields = result["fields"]
    assert isinstance(fields, dict)
    assert fields["ServerName"] == '"Test, world"'
    assert fields["UnknownThing"] == "(A=1,B=2)"
    assert fields["AdminPassword"] == "已配置"
    assert "secret-value" not in str(result["rawText"])
    service.save_draft({"ServerName": '"Changed, value"', "UnknownThing": "(A=3,B=4)"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["AdminPassword"] == "已配置"
    assert draft["fieldOrder"][:3] == ["ServerName", "AdminPassword", "UnknownThing"]


def test_raw_text_masks_quoted_password_with_delimiters(tmp_path: Path) -> None:
    service, _, config = make_service(tmp_path)
    config.write_text(
        "[/Script/Pal.PalGameWorldSettings]\n"
        'OptionSettings=(ServerName="Test",AdminPassword="test-only-alpha,beta)",'
        "AutoSaveSpan=600.000000)\n",
        encoding="utf-8",
    )

    raw_text = str(service.current()["rawText"])

    assert "test-only-alpha" not in raw_text
    assert "beta)" not in raw_text
    assert "AdminPassword=<已隐藏>" in raw_text


def test_external_change_blocks_apply_and_force_keeps_secret(tmp_path: Path) -> None:
    service, _, config = make_service(tmp_path)
    service.save_draft({"AutoSaveSpan": "900.000000"})
    config.write_text(config.read_text(encoding="utf-8") + "; external edit\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="外部修改") as error:
        service.apply()
    assert error.value.code == "CONFIG_CONFLICT"
    result = service.apply(force=True)
    assert Path(str(result["backupPath"])).is_file()
    content = config.read_text(encoding="utf-8")
    assert "AdminPassword=secret-value" in content
    assert "AutoSaveSpan=900.000000" in content


def test_running_server_and_secret_edits_are_rejected(tmp_path: Path) -> None:
    service, _, _ = make_service(tmp_path, running=True)
    with pytest.raises(ConfigError) as secret_error:
        service.save_draft({"AdminPassword": "exfiltrate"})
    assert secret_error.value.code == "SECRET_FIELD_FORBIDDEN"
    service.save_draft({"AutoSaveSpan": "900"})
    with pytest.raises(ConfigError) as running_error:
        service.apply()
    assert running_error.value.code == "SERVER_RUNNING"


def test_open_config_folder_starts_windows_explorer(tmp_path: Path) -> None:
    executable = tmp_path / "steamapps" / "common" / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=static_dir)
    app = create_app(settings)
    app.state.database.migrate()
    app.state.database.set_setting("server.executable", str(executable))

    with (
        patch("palserver_console.main.os.startfile") as open_folder,
        TestClient(
            app,
            base_url="http://127.0.0.1:8223",
            client=("127.0.0.1", 50000),
        ) as client,
    ):
        response = client.post(
            "/api/config/open-folder",
            headers={"Origin": "http://127.0.0.1:8223"},
        )

    expected = executable.parent / "Pal" / "Saved" / "Config" / "WindowsServer"
    assert response.status_code == 200
    assert response.json() == {"path": str(expected)}
    open_folder.assert_called_once_with(str(expected))
