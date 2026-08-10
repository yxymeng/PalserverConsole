from __future__ import annotations

import json
import sqlite3
import tomllib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import palserver_console.persistence as persistence
from palserver_console import __version__
from palserver_console.config import AppSettings
from palserver_console.main import create_app


def _create_schema_v7(path: Path) -> None:
    path.parent.mkdir(parents=True)
    with sqlite3.connect(path) as connection:
        for migration in persistence.MIGRATIONS[:7]:
            connection.executescript(migration)
        connection.execute("PRAGMA user_version = 7")
        connection.execute(
            """INSERT INTO settings(key, value, updated_at)
            VALUES('opt08.fixture', 'before-upgrade', 1)"""
        )


def _migration_backups(path: Path) -> list[Path]:
    return sorted((path.parent / "migration-backups").glob("app.db.pre-migration-v7.*.sqlite3"))


def test_historical_schema_upgrade_keeps_a_readable_pre_migration_backup(tmp_path: Path) -> None:
    database_path = tmp_path / "data" / "app.db"
    _create_schema_v7(database_path)

    database = persistence.Database(database_path)
    database.migrate()

    assert database.schema_version() == persistence.SCHEMA_VERSION
    with sqlite3.connect(database_path) as connection:
        operation_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(operations)")
        }
        assert connection.execute(
            "SELECT value FROM settings WHERE key = 'opt08.fixture'"
        ).fetchone() == ("before-upgrade",)
    assert "request_fingerprint" in operation_columns

    backups = _migration_backups(database_path)
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA user_version").fetchone() == (7,)
        backup_columns = {str(row[1]) for row in backup.execute("PRAGMA table_info(operations)")}
        assert "request_fingerprint" not in backup_columns
        assert backup.execute(
            "SELECT value FROM settings WHERE key = 'opt08.fixture'"
        ).fetchone() == ("before-upgrade",)


def test_failed_migration_rolls_back_partial_schema_and_preserves_backup(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    database_path = tmp_path / "data" / "app.db"
    _create_schema_v7(database_path)

    def partial_failing_migration(connection: sqlite3.Connection) -> None:
        connection.execute("ALTER TABLE operations ADD COLUMN opt08_probe TEXT")
        connection.execute("THIS IS NOT VALID SQL")

    monkeypatch.setattr(
        persistence.Database,
        "_migrate_operation_request_fingerprint",
        staticmethod(partial_failing_migration),
    )

    database = persistence.Database(database_path)
    with pytest.raises(sqlite3.OperationalError, match="near"):
        database.migrate()

    with sqlite3.connect(database_path) as connection:
        assert connection.execute("PRAGMA user_version").fetchone() == (7,)
        operation_columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(operations)")
        }
        assert "opt08_probe" not in operation_columns
        assert connection.execute(
            "SELECT value FROM settings WHERE key = 'opt08.fixture'"
        ).fetchone() == ("before-upgrade",)

    backups = _migration_backups(database_path)
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA user_version").fetchone() == (7,)


def test_project_metadata_and_launcher_use_lock_based_versioning() -> None:
    project_root = Path(__file__).resolve().parents[2]
    pyproject = tomllib.loads((project_root / "pyproject.toml").read_text(encoding="utf-8"))
    package = json.loads((project_root / "frontend" / "package.json").read_text(encoding="utf-8"))
    launcher = (project_root / "scripts" / "start-console.ps1").read_text(encoding="utf-8-sig")
    lock_lines = [
        line.strip()
        for line in (project_root / "requirements.lock").read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]

    assert pyproject["project"].get("version") is None
    assert "version" in pyproject["project"]["dynamic"]
    assert pyproject["tool"]["setuptools"]["dynamic"]["version"] == {
        "attr": "palserver_console.__version__"
    }
    assert package["version"] == __version__
    assert lock_lines
    assert all("==" in line and "--hash=sha256:" in line for line in lock_lines)
    assert "requirements.lock" in launcher
    assert "Get-FileHash" in launcher
    assert "--require-hashes" in launcher
    assert "package-lock.json" in launcher
    assert "$frontendBuildInputStamp" in launcher
    assert "$frontendBuildFingerprint" in launcher
    assert "backend\\palserver_console\\__init__.py" in launcher
    assert "vite.config.ts" in launcher
    assert "Set-Content -LiteralPath $frontendBuildInputStamp" in launcher
    assert "LastWriteTimeUtc" not in launcher


def test_bootstrap_and_health_agree_on_frontend_build_version(tmp_path: Path) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "build-info.json").write_text(
        json.dumps({"frontendVersion": __version__}), encoding="utf-8"
    )
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=static_dir)

    with TestClient(
        create_app(settings), base_url="http://127.0.0.1:8223", client=("127.0.0.1", 50000)
    ) as client:
        health = client.get("/api/health")
        bootstrap = client.get("/api/bootstrap")

    assert health.status_code == 200
    assert bootstrap.status_code == 200
    assert health.json()["versions"] == bootstrap.json()["versions"]
    assert health.json()["versions"]["application"] == __version__
    assert health.json()["versions"]["api"] == __version__
    assert health.json()["versions"]["frontend"] == __version__
