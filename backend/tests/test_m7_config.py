from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from palserver_console.auth import COOKIE_NAME
from palserver_console.config import AppSettings
from palserver_console.config_editor import ConfigError, ConfigService, parse_draft_request
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


def test_save_draft_normalizes_values_without_injecting_or_losing_fields(tmp_path: Path) -> None:
    service, _, _ = make_service(tmp_path)

    service.save_draft(
        {
            "ServerName": "Changed, value",
            "AutoSaveSpan": "900.0000",
            "bEnableFastTravel": "true",
            "UnknownThing": "(A=3,B=4)",
        }
    )

    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    fields = draft["fields"]
    assert isinstance(fields, dict)
    assert fields["ServerName"] == '"Changed, value"'
    assert fields["AutoSaveSpan"] == "900"
    assert fields["bEnableFastTravel"] == "True"
    assert fields["UnknownThing"] == "(A=3,B=4)"
    assert fields["AdminPassword"] == "已配置"
    pending = (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(encoding="utf-8")
    assert "AdminPassword=secret-value" in pending
    assert "RCONEnabled=True" not in pending


def test_known_schema_field_can_be_added_and_applied(tmp_path: Path) -> None:
    service, _, config = make_service(tmp_path)

    service.save_draft({"ServerPlayerMaxNum": "32"})
    service.apply()

    assert "ServerPlayerMaxNum=32" in config.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    ("fields", "code"),
    [
        ({"UnknownInjected": "True"}, "CONFIG_UNKNOWN_FIELD"),
        ({"AutoSaveSpan": "900),RCONEnabled=True"}, "CONFIG_INVALID_FIELD_VALUE"),
        ({"ServerName\nRCONEnabled": "True"}, "CONFIG_INVALID_FIELD_KEY"),
        ({"ServerName": '"unterminated'}, "CONFIG_INVALID_FIELD_VALUE"),
    ],
)
def test_save_draft_rejects_malicious_config_payloads(
    tmp_path: Path, fields: dict[str, str], code: str
) -> None:
    service, _, _ = make_service(tmp_path)

    with pytest.raises(ConfigError) as error:
        service.save_draft(fields)

    assert error.value.code == code
    assert not (tmp_path / "data" / "pending" / "PalWorldSettings.ini").exists()


def test_draft_json_rejects_duplicate_keys_before_service_receives_it() -> None:
    with pytest.raises(ConfigError) as error:
        parse_draft_request(
            b'{"fields":{"AutoSaveSpan":"600","AutoSaveSpan":"900"}}'
        )

    assert error.value.code == "CONFIG_DUPLICATE_KEY"


def test_draft_api_returns_stable_error_for_duplicate_json_fields(tmp_path: Path) -> None:
    _, executable, _ = make_service(tmp_path)
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=static_dir))
    app.state.database.migrate()
    app.state.database.set_setting("server.executable", str(executable))
    cookie_value, session = app.state.auth.create_session("127.0.0.1", local=True)

    with TestClient(
        app,
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        client.cookies.set(COOKIE_NAME, cookie_value)
        response = client.put(
            "/api/config/draft",
            content=b'{"fields":{"AutoSaveSpan":"600","AutoSaveSpan":"900"}}',
            headers={
                "Content-Type": "application/json",
                "Origin": "http://127.0.0.1:8223",
                "X-CSRF-Token": session.csrf_token,
            },
        )

    assert response.status_code == 409
    assert response.json()["errorCode"] == "CONFIG_DUPLICATE_KEY"


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
    assert "AutoSaveSpan=900" in content


def test_admin_password_is_preserved_and_cannot_be_changed_in_draft(tmp_path: Path) -> None:
    service, _, _ = make_service(tmp_path, running=True)
    service.save_draft({"AdminPassword": "已配置", "AutoSaveSpan": "900"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["AdminPassword"] == "已配置"
    assert "secret-value" not in str(draft)
    assert "AdminPassword=secret-value" in (
        tmp_path / "data" / "pending" / "PalWorldSettings.ini"
    ).read_text(
        encoding="utf-8"
    )
    with pytest.raises(ConfigError) as secret_error:
        service.save_draft({"AdminPassword": '"new-admin-password"'})
    assert secret_error.value.code == "CONFIG_SECRET_FIELD_READ_ONLY"
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
