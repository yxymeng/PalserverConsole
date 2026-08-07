from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from palserver_console.auth import COOKIE_NAME
from palserver_console.config import AppSettings
from palserver_console.main import CSRF_COOKIE_NAME, create_app
from palserver_console.persistence import SCHEMA_VERSION, Database


def _settings(tmp_path: Path) -> AppSettings:
    return AppSettings(
        data_dir=tmp_path / "data",
        static_dir=tmp_path / "missing-static",
        allowed_hosts=("127.0.0.1", "192.0.2.20", "localhost", "::1"),
        login_max_failures=2,
    )


def _local_client(settings: AppSettings) -> TestClient:
    return TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 51000),
    )


def _lan_client(settings: AppSettings) -> TestClient:
    return TestClient(
        create_app(settings),
        base_url="http://192.0.2.20:8223",
        client=("192.0.2.55", 51001),
    )


def _origin(host: str) -> dict[str, str]:
    return {"Origin": host}


def _configure_game_admin_password(
    settings: AppSettings, password: str = "correct-horse-42"
) -> Path:
    executable = settings.data_dir.parent / "PalServer" / "PalServer.exe"
    config = (
        executable.parent
        / "Pal"
        / "Saved"
        / "Config"
        / "WindowsServer"
        / "PalWorldSettings.ini"
    )
    config.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    config.write_text(
        f"[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword=\"{password}\")\n",
        encoding="utf-8",
    )
    database = Database(settings.database_path)
    database.migrate()
    database.set_setting("server.executable", str(executable))
    return config


def test_database_migration_is_idempotent_and_creates_m1_tables(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    database.migrate()

    with sqlite3.connect(database.path) as connection:
        tables = {
            cast(str, row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        version = cast(int, connection.execute("PRAGMA user_version").fetchone()[0])

    assert version == SCHEMA_VERSION
    assert {
        "settings",
        "sessions",
        "operations",
        "audit_events",
        "config_drafts",
        "snapshot_versions",
        "backup_index",
    } <= tables


def test_legacy_lan_credentials_and_sessions_are_removed_by_migration(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    with database.connect() as connection:
        connection.execute(
            """
            CREATE TABLE auth_config (
                id INTEGER PRIMARY KEY CHECK (id = 1), password_hash BLOB NOT NULL,
                salt BLOB NOT NULL, n INTEGER NOT NULL, r INTEGER NOT NULL, p INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO auth_config VALUES(1, X'01', X'02', 1, 1, 1, 1)"
        )
        connection.execute(
            """
            INSERT INTO sessions(
                id, token_hash, csrf_hash, peer_ip, is_local, created_at, expires_at
            )
            VALUES('legacy-lan-session', X'01', X'02', '192.0.2.55', 0, 1, 9999999999)
            """
        )
        connection.execute("PRAGMA user_version = 3")

    database.migrate()

    with sqlite3.connect(database.path) as connection:
        auth_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_config'"
        ).fetchone()
        lan_sessions = connection.execute(
            "SELECT COUNT(*) FROM sessions WHERE is_local = 0"
        ).fetchone()[0]
    assert auth_table is None
    assert lan_sessions == 0


def test_local_access_gets_session_without_legacy_lan_password_settings(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with _local_client(settings) as client:
        status_response = client.get("/api/auth/status")
        status = status_response.json()
        assert status == {
            "local": True,
            "authenticated": True,
            "adminPasswordConfigured": False,
            "csrfToken": status["csrfToken"],
            "lanWarning": None,
            "port": 8223,
        }
        assert status["csrfToken"]
        assert "HttpOnly" in status_response.headers.get_list("set-cookie")[0]
        assert all(
            "SameSite=strict" in item for item in status_response.headers.get_list("set-cookie")
        )

        response = client.post(
            "/api/auth/lan-password",
            headers={**_origin("http://127.0.0.1:8223"), "X-CSRF-Token": status["csrfToken"]},
            json={"password": "legacy-password"},
        )
        assert response.status_code == 404


def test_lan_is_blocked_until_game_admin_password_exists_and_xff_is_ignored(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with _lan_client(settings) as client:
        response = client.get(
            "/api/health",
            headers={"X-Forwarded-For": "127.0.0.1"},
        )
        assert response.status_code == 403
        assert response.json()["errorCode"] == "GAME_ADMIN_PASSWORD_REQUIRED"

    _configure_game_admin_password(settings)
    with _lan_client(settings) as client:
        response = client.get(
            "/api/shell/status",
            headers={"X-Forwarded-For": "127.0.0.1"},
        )
        assert response.status_code == 401
        assert response.json()["errorCode"] == "AUTH_REQUIRED"


def test_lan_login_session_csrf_logout_and_rate_limit(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    password = "correct-horse-42"
    _configure_game_admin_password(settings, password)

    with _lan_client(settings) as client:
        status = client.get("/api/auth/status").json()
        assert status["authenticated"] is False
        login = client.post(
            "/api/auth/login",
            headers=_origin("http://192.0.2.20:8223"),
            json={"password": password},
        )
        assert login.status_code == 200
        assert client.cookies.get(COOKIE_NAME)
        assert client.cookies.get(CSRF_COOKIE_NAME)

        authenticated = client.get("/api/auth/status").json()
        assert authenticated["authenticated"] is True
        assert authenticated["local"] is False
        assert client.get("/api/shell/status").status_code == 200

        original_cookie = client.cookies.get(COOKIE_NAME)
        assert original_cookie is not None
        client.cookies.set(COOKIE_NAME, f"{original_cookie}x")
        assert client.get("/api/shell/status").status_code == 401
        client.cookies.set(COOKIE_NAME, original_cookie)

        rejected = client.post(
            "/api/auth/logout",
            headers={**_origin("http://192.0.2.20:8223"), "X-CSRF-Token": "wrong"},
            json={},
        )
        assert rejected.status_code == 403
        logout = client.post(
            "/api/auth/logout",
            headers={
                **_origin("http://192.0.2.20:8223"),
                "X-CSRF-Token": authenticated["csrfToken"],
            },
            json={},
        )
        assert logout.status_code == 200
        assert client.get("/api/shell/status").status_code == 401

    with _lan_client(settings) as client:
        for _ in range(2):
            failed = client.post(
                "/api/auth/login",
                headers=_origin("http://192.0.2.20:8223"),
                json={"password": "incorrect-password"},
            )
            assert failed.status_code == 401
        limited = client.post(
            "/api/auth/login",
            headers=_origin("http://192.0.2.20:8223"),
            json={"password": "incorrect-password"},
        )
        assert limited.status_code == 429


def test_network_settings_reject_missing_origin_and_csrf(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with _local_client(settings) as client:
        status = client.get("/api/auth/status").json()
        no_origin = client.put(
            "/api/settings/network",
            headers={"X-CSRF-Token": status["csrfToken"]},
            json={"port": 8333},
        )
        assert no_origin.status_code == 403
        assert no_origin.json()["errorCode"] == "ORIGIN_REJECTED"

        no_csrf = client.put(
            "/api/settings/network",
            headers=_origin("http://127.0.0.1:8223"),
            json={"port": 8333},
        )
        assert no_csrf.status_code == 403
        assert no_csrf.json()["errorCode"] == "CSRF_REJECTED"

        invalid = client.put(
            "/api/settings/network",
            headers={
                **_origin("http://127.0.0.1:8223"),
                "X-CSRF-Token": status["csrfToken"],
            },
            json={"port": 0},
        )
        assert invalid.status_code == 422


def test_network_port_can_only_be_changed_locally_with_csrf(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with _local_client(settings) as client:
        status = client.get("/api/auth/status").json()
        response = client.put(
            "/api/settings/network",
            headers={
                **_origin("http://127.0.0.1:8223"),
                "X-CSRF-Token": status["csrfToken"],
            },
            json={"port": 8333},
        )
        assert response.status_code == 200
        assert client.get("/api/auth/status").json()["port"] == 8223
        assert Database(settings.database_path).get_setting("network.port") == "8333"

    _configure_game_admin_password(settings)
    with _lan_client(settings) as client:
        login = client.post(
            "/api/auth/login",
            headers=_origin("http://192.0.2.20:8223"),
            json={"password": "correct-horse-42"},
        )
        assert login.status_code == 200
        status = client.get("/api/auth/status").json()
        response = client.put(
            "/api/settings/network",
            headers={
                **_origin("http://192.0.2.20:8223"),
                "X-CSRF-Token": status["csrfToken"],
            },
            json={"port": 8444},
        )
        assert response.status_code == 403
        assert response.json()["errorCode"] == "LOCAL_ONLY"


def test_password_never_appears_in_error_or_logs(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    settings = _settings(tmp_path)
    secret = "never-print-this-password"
    _configure_game_admin_password(settings, secret)
    with _lan_client(settings) as client:
        response = client.post(
            "/api/auth/login",
            headers=_origin("http://192.0.2.20:8223"),
            json={"password": "different-password"},
        )
    assert secret not in response.text
    assert secret not in caplog.text
