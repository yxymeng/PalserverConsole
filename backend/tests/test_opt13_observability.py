from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from palserver_console.backups import BackupService
from palserver_console.config import AppSettings, ServerProfile
from palserver_console.main import create_app
from palserver_console.persistence import Database
from palserver_console.world.service import WorldDataError, WorldSnapshotService


def _world(root: Path) -> Path:
    world = root / "world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    (world / "Players" / "player.sav").write_bytes(b"player")
    return world


def _profile(world: Path) -> ServerProfile:
    executable = world.parent / "PalServer.exe"
    executable.write_bytes(b"exe")
    return ServerProfile(
        executable_path=executable,
        install_path=world.parent,
        world_id="fixture-world",
        world_path=world,
    )


def test_capacity_status_warns_before_and_blocks_snapshot_copy(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    world = _world(tmp_path)
    service = WorldSnapshotService(
        database,
        lambda: None,
        tmp_path / "data",
        profile_provider=lambda: _profile(world),
        minimum_free_bytes=128,
        disk_usage_provider=lambda _: SimpleNamespace(total=1000, free=140),
    )

    capacity = service.capacity_status()

    assert capacity["state"] == "blocked"
    assert capacity["copyBytes"] == len(b"levelmetaplayer")
    assert capacity["requiredFreeBytes"] == 128 + len(b"levelmetaplayer")
    with pytest.raises(WorldDataError, match="磁盘剩余空间不足") as raised:
        service._capture_and_parse(world, service._fingerprint(world))
    assert raised.value.code == "DISK_SPACE_LOW"


def test_backup_health_summary_is_read_only_and_reports_last_valid_backup(tmp_path: Path) -> None:
    world = _world(tmp_path)
    profile = _profile(world)
    backups = BackupService(
        lambda: profile.executable_path,
        lambda: False,
        lambda: None,
        lambda _: None,
        profile_provider=lambda: profile,
        clock=lambda: 500,
    )

    empty = backups.health_summary()
    assert empty["state"] == "no_data"
    assert not (world / "backup").exists()

    backup = world / "backup" / "world" / "2026.08.09-01.02.03"
    (backup / "Players").mkdir(parents=True)
    (backup / "Level.sav").write_bytes(b"level")
    (backup / "LevelMeta.sav").write_bytes(b"meta")
    (backup / "Players" / "player.sav").write_bytes(b"player")

    summary = backups.health_summary()

    assert summary["state"] == "healthy"
    assert summary["validCount"] == 1
    assert summary["lastValidAt"] == int(backup.stat().st_mtime)


def test_storage_cleanup_requires_preview_token_and_keeps_current_data_until_confirmation(
    tmp_path: Path,
) -> None:
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
    temporary = service.cache_root / ".world-cache-crashed.tmp.sqlite"
    temporary.write_bytes(b"temporary-cache")

    preview = service.cleanup_preview()

    assert temporary.exists()
    assert preview["candidateCount"] == 1
    assert preview["totalBytes"] == len(b"temporary-cache")
    assert preview["previewToken"]
    result = service.confirm_cleanup(str(preview["previewToken"]))
    assert result["removedTemp"] == 1
    assert not temporary.exists()


def test_storage_cleanup_rejects_nested_file_changes_after_preview(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    service = WorldSnapshotService(
        database,
        lambda: None,
        tmp_path / "data",
        minimum_free_bytes=0,
        clock=lambda: 1_000,
    )
    orphan = service.snapshots_root / "orphan-snapshot"
    orphan.mkdir(parents=True)
    changed = orphan / "Level.sav"
    changed.write_bytes(b"before")
    preview = service.cleanup_preview()

    changed.write_bytes(b"AFTER!")

    with pytest.raises(WorldDataError) as raised:
        service.confirm_cleanup(str(preview["previewToken"]))
    assert raised.value.code == "CLEANUP_PREVIEW_STALE"
    assert orphan.exists()


def test_operational_health_api_exposes_storage_freshness_and_background_health(
    tmp_path: Path,
) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        response = client.get("/api/operations/health")

    assert response.status_code == 200
    payload = response.json()
    assert isinstance(payload["observedAt"], int)
    assert {entry["name"] for entry in payload["directories"]} == {
        "runtime-data",
        "application-logs",
        "cache",
        "snapshots",
        "official-backups",
    }
    assert {entry["name"] for entry in payload["background"]} == {
        "live-monitor",
        "audit-log",
        "world-snapshot",
    }
    assert payload["capacity"]["state"] in {"ok", "warning", "blocked", "unavailable"}
    assert payload["world"]["state"] == "no_data"


def test_operational_health_api_degrades_backup_io_errors_to_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    app = create_app(settings)
    monkeypatch.setattr(
        app.state.backups,
        "health_summary",
        lambda: (_ for _ in ()).throw(OSError("permission denied")),
    )
    with TestClient(
        app,
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        response = client.get("/api/operations/health")

    assert response.status_code == 200
    assert response.json()["backups"]["state"] == "unavailable"
    assert response.json()["backups"]["errorCode"] == "BACKUP_SCAN_FAILED"


def test_cleanup_api_executes_only_the_previewed_generated_data(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    database = Database(settings.database_path)
    service = WorldSnapshotService(database, lambda: None, settings.data_dir, minimum_free_bytes=0)
    with TestClient(
        create_app(settings, world_service=service),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        service.cache_root.mkdir(parents=True, exist_ok=True)
        temporary = service.cache_root / ".world-cache-request.tmp.sqlite"
        temporary.write_bytes(b"request-preview")
        auth = client.get("/api/auth/status").json()
        preview = client.get("/api/world/storage/cleanup-preview")
        assert preview.status_code == 200
        token = preview.json()["previewToken"]
        result = client.post(
            "/api/world/storage/cleanup",
            headers={
                "Origin": "http://127.0.0.1:8223",
                "X-CSRF-Token": auth["csrfToken"],
            },
            json={"previewToken": token},
        )

    assert result.status_code == 200
    assert result.json()["removedTemp"] == 1
    assert not temporary.exists()
