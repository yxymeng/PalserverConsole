from __future__ import annotations

import json
from pathlib import Path
from typing import cast
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


def test_crossplay_platforms_round_trip_as_tuple_without_injection(tmp_path: Path) -> None:
    service, _, config = make_service(tmp_path)
    config.write_text(
        config.read_text(encoding="utf-8").replace(
            "UnknownThing=(A=1,B=2),",
            "CrossplayPlatforms=(Steam,Xbox),UnknownThing=(A=1,B=2),",
        ),
        encoding="utf-8",
    )
    pending_path = tmp_path / "data" / "pending" / "PalWorldSettings.ini"
    current = service.current()
    current_fields = cast(dict[str, str], current["fields"])
    assert current_fields["CrossplayPlatforms"] == "(Steam,Xbox)"

    # Delete Xbox: a single platform must still be serialized as a tuple.
    service.save_draft({"CrossplayPlatforms": "Steam"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["CrossplayPlatforms"] == "(Steam)"
    assert draft["fields"]["AdminPassword"] == "已配置"
    pending = pending_path.read_text(encoding="utf-8")
    assert "CrossplayPlatforms=(Steam)" in pending
    assert 'CrossplayPlatforms="(Steam)"' not in pending
    assert "AdminPassword=secret-value" in pending

    service.apply()
    content = config.read_text(encoding="utf-8")
    assert "CrossplayPlatforms=(Steam)" in content
    reread = service.current()
    reread_fields = cast(dict[str, str], reread["fields"])
    assert reread_fields["CrossplayPlatforms"] == "(Steam)"
    assert reread_fields["AdminPassword"] == "已配置"
    assert reread_fields["UnknownThing"] == "(A=1,B=2)"

    # Add platforms: multiple values must remain one tuple, not one quoted string.
    service.save_draft({"CrossplayPlatforms": "Steam,Xbox,PS5,Mac"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["CrossplayPlatforms"] == "(Steam,Xbox,PS5,Mac)"
    pending = pending_path.read_text(encoding="utf-8")
    assert "CrossplayPlatforms=(Steam,Xbox,PS5,Mac)" in pending
    assert 'CrossplayPlatforms="(Steam,Xbox,PS5,Mac)"' not in pending
    assert "AdminPassword=secret-value" in pending

    service.apply()
    content = config.read_text(encoding="utf-8")
    assert "CrossplayPlatforms=(Steam,Xbox,PS5,Mac)" in content
    assert 'CrossplayPlatforms="(Steam,Xbox,PS5,Mac)"' not in content
    reread = service.current()
    reread_fields = cast(dict[str, str], reread["fields"])
    assert reread_fields["CrossplayPlatforms"] == "(Steam,Xbox,PS5,Mac)"
    assert reread_fields["AdminPassword"] == "已配置"
    assert reread_fields["ServerName"] == '"Test, world"'
    assert reread_fields["UnknownThing"] == "(A=1,B=2)"

    pending_before_rejected = pending_path.read_text(encoding="utf-8")
    for invalid_value in (
        '(Steam,abc"),RCONEnabled=True)',
        "(Steam,\nRCONEnabled=True)",
    ):
        with pytest.raises(ConfigError) as error:
            service.save_draft({"CrossplayPlatforms": invalid_value})
        assert error.value.code == "CONFIG_INVALID_FIELD_VALUE"
    assert pending_path.read_text(encoding="utf-8") == pending_before_rejected


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


def test_existing_unknown_field_can_save_apply_and_reread_without_side_effects(
    tmp_path: Path,
) -> None:
    service, _, config = make_service(tmp_path)

    service.save_draft({"UnknownThing": "(A=3,B=4)"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    draft_fields = draft["fields"]
    assert draft_fields["UnknownThing"] == "(A=3,B=4)"
    assert draft_fields["AdminPassword"] == "已配置"
    assert draft_fields["ServerName"] == '"Test, world"'
    assert draft_fields["AutoSaveSpan"] == "600.000000"

    pending = (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(
        encoding="utf-8"
    )
    assert "UnknownThing=(A=3,B=4)" in pending
    assert "AdminPassword=secret-value" in pending

    service.apply()
    reread = service.current()
    reread_fields = cast(dict[str, str], reread["fields"])
    assert reread_fields["UnknownThing"] == "(A=3,B=4)"
    assert reread_fields["AdminPassword"] == "已配置"
    assert reread_fields["ServerName"] == '"Test, world"'
    assert reread_fields["AutoSaveSpan"] == "600.000000"
    assert reread_fields["bEnableFastTravel"] == "True"

    content = config.read_text(encoding="utf-8")
    assert "UnknownThing=(A=3,B=4)" in content
    assert "AdminPassword=secret-value" in content


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


def test_admin_password_is_preserved_when_omitted_and_can_be_changed_safely(
    tmp_path: Path,
) -> None:
    service, _, config = make_service(tmp_path)
    old_password = "secret-value"

    def assert_not_visible(*payloads: object, secrets: tuple[str, ...]) -> None:
        for payload in payloads:
            text = str(payload)
            for secret in secrets:
                assert secret not in text

    service.save_draft({"AutoSaveSpan": "900"})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["AdminPassword"] == "已配置"
    pending = (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(
        encoding="utf-8"
    )
    assert f"AdminPassword={old_password}" in pending
    current = service.current()
    diff = service.diff()
    assert_not_visible(
        current,
        current["rawText"],
        draft,
        draft["rawText"],
        diff,
        diff["text"],
        secrets=(old_password,),
    )

    service.apply()
    assert f"AdminPassword={old_password}" in config.read_text(encoding="utf-8")
    current = service.current()
    assert_not_visible(
        current,
        current["rawText"],
        service.draft(),
        service.diff(),
        secrets=(old_password,),
    )

    new_password = 'abc"),RCONEnabled=True,(path)\\tail'
    service.save_draft({"AdminPassword": new_password})
    draft = service.draft()["draft"]
    assert isinstance(draft, dict)
    assert draft["fields"]["AdminPassword"] == "已配置"
    serialized_password = json.dumps(new_password, ensure_ascii=False)
    pending = (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(
        encoding="utf-8"
    )
    assert f"AdminPassword={serialized_password}" in pending
    diff = service.diff()
    assert_not_visible(
        current,
        current["rawText"],
        draft,
        draft["rawText"],
        diff,
        diff["text"],
        secrets=(old_password, new_password),
    )

    service.apply()
    content = config.read_text(encoding="utf-8")
    assert f"AdminPassword={serialized_password}" in content
    current = service.current()
    current_fields = cast(dict[str, str], current["fields"])
    assert current_fields["AdminPassword"] == "已配置"
    assert "RCONEnabled" not in current_fields
    assert_not_visible(
        current,
        current["rawText"],
        service.draft(),
        service.diff(),
        secrets=(old_password, new_password),
    )

    pending_before_rejected = (
        tmp_path / "data" / "pending" / "PalWorldSettings.ini"
    ).read_text(encoding="utf-8")
    with pytest.raises(ConfigError) as newline_error:
        service.save_draft({"AdminPassword": "line-one\nRCONEnabled=True"})
    assert newline_error.value.code == "CONFIG_INVALID_FIELD_VALUE"
    assert (
        tmp_path / "data" / "pending" / "PalWorldSettings.ini"
    ).read_text(encoding="utf-8") == pending_before_rejected

    running_root = tmp_path / "running"
    running_root.mkdir()
    running_service, _, _ = make_service(running_root, running=True)
    running_service.save_draft({"AdminPassword": '"new-admin-password"'})
    with pytest.raises(ConfigError) as running_error:
        running_service.apply()
    assert running_error.value.code == "SERVER_RUNNING"


def test_save_draft_preserves_pending_admin_password_when_omitted(tmp_path: Path) -> None:
    service, _, _ = make_service(tmp_path)
    new_password = "pending-admin-password"
    pending_path = tmp_path / "data" / "pending" / "PalWorldSettings.ini"

    service.save_draft({"AdminPassword": new_password})
    assert f"AdminPassword={json.dumps(new_password)}" in pending_path.read_text(
        encoding="utf-8"
    )

    service.save_draft({"AutoSaveSpan": "900"})

    pending = pending_path.read_text(encoding="utf-8")
    assert f"AdminPassword={json.dumps(new_password)}" in pending
    assert "AutoSaveSpan=900" in pending


def test_config_read_and_write_reject_intermediate_reparse_point(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    service, _, config = make_service(tmp_path)
    service.save_draft({"AutoSaveSpan": "900"})
    original_is_symlink = Path.is_symlink

    def fake_is_symlink(path: Path) -> bool:
        return path == config.parent or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)
    for action in (service.current, service.apply):
        with pytest.raises(ConfigError) as error:
            action()

        assert error.value.code == "PATH_REPARSE_POINT"
    assert config.read_text(encoding="utf-8").find("AutoSaveSpan=600.000000") >= 0


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
