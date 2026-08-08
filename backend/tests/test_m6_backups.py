from __future__ import annotations

import os
from pathlib import Path
from typing import cast

import pytest

from palserver_console.backups import BackupError, BackupService
from palserver_console.config import ServerProfileService
from palserver_console.persistence import Database


def make_world(tmp_path: Path) -> tuple[Path, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    exe = tmp_path / "PalServer.exe"
    exe.write_bytes(b"exe")
    world = exe.parent / "Pal" / "Saved" / "SaveGames" / "0" / "world-guid"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level-current")
    (world / "LevelMeta.sav").write_bytes(b"meta-current")
    return exe, world


def make_backup(world: Path, name: str, valid: bool = True) -> Path:
    path = world / "backup" / "world" / name
    (path / "Players").mkdir(parents=True)
    (path / "Level.sav").write_bytes(b"level-backup" if valid else b"")
    if valid:
        (path / "LevelMeta.sav").write_bytes(b"meta-backup")
    return path


def service(
    tmp_path: Path, running: bool = False
) -> tuple[BackupService, Path, dict[str, int | None]]:
    exe, world = make_world(tmp_path)
    state: dict[str, int | None] = {"retention": None}
    return (
        BackupService(
            lambda: exe,
            lambda: running,
            lambda: state["retention"],
            lambda value: state.__setitem__("retention", value),
        ),
        world,
        state,
    )


def test_list_validates_and_ignores_nested_or_unknown_dirs(tmp_path: Path) -> None:
    backups, world, _ = service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    make_backup(world, "2026.08.02-01.02.03", valid=False)
    (world / "backup" / "world" / "nested").mkdir(parents=True)
    result = backups.list()
    items = cast(list[dict[str, object]], result["items"])
    assert [item["id"] for item in items] == [
        "2026.08.02-01.02.03",
        "2026.08.01-01.02.03",
    ]
    assert items[0]["valid"] is False


def test_delete_rejects_traversal_and_running_server(tmp_path: Path) -> None:
    backups, world, _ = service(tmp_path, running=True)
    make_backup(world, "2026.08.01-01.02.03")
    with pytest.raises(BackupError, match="服务器运行时"):
        backups.delete("2026.08.01-01.02.03")
    backups, world, _ = service(tmp_path / "other")
    with pytest.raises(BackupError) as error:
        backups.delete("..")
    assert error.value.code == "INVALID_BACKUP_ID"


def test_retention_and_restore_with_safety_copy(tmp_path: Path) -> None:
    backups, world, state = service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    make_backup(world, "2026.08.02-01.02.03")
    backups.set_retention(1)
    assert state["retention"] == 1
    assert not (world / "backup" / "2026.08.01-01.02.03").exists()
    backups.restore("2026.08.02-01.02.03")
    assert (world / "Level.sav").read_bytes() == b"level-backup"
    assert len([p for p in (world / "backup" / "world").iterdir() if p.is_dir()]) >= 2


def test_retention_rejects_running_server_before_changing_or_deleting(tmp_path: Path) -> None:
    backups, world, state = service(tmp_path, running=True)
    oldest = make_backup(world, "2026.08.01-01.02.03")
    make_backup(world, "2026.08.02-01.02.03")

    with pytest.raises(BackupError) as error:
        backups.set_retention(1)

    assert error.value.code == "SERVER_RUNNING"
    assert state["retention"] is None
    assert oldest.is_dir()


def test_restore_requires_stopped_and_valid_backup(tmp_path: Path) -> None:
    backups, world, _ = service(tmp_path, running=True)
    make_backup(world, "2026.08.01-01.02.03", valid=False)
    with pytest.raises(BackupError, match="停止"):
        backups.restore("2026.08.01-01.02.03")
    backups, world, _ = service(tmp_path / "invalid")
    make_backup(world, "2026.08.01-01.02.03", valid=False)
    with pytest.raises(BackupError) as error:
        backups.restore("2026.08.01-01.02.03")
    assert error.value.code == "BACKUP_INVALID"


def test_bound_backup_world_does_not_follow_latest_level_mtime(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    root = executable.parent / "Pal" / "Saved" / "SaveGames" / "0"
    selected = root / "world-a"
    other = root / "world-b"
    for world in (selected, other):
        (world / "Players").mkdir(parents=True)
        (world / "Level.sav").write_bytes(b"level")
        (world / "LevelMeta.sav").write_bytes(b"meta")
    database.set_setting("server.executable", str(executable))
    profiles = ServerProfileService(database)
    profiles.bind(executable, "world-a")
    os.utime(other / "Level.sav", ns=(9_000_000_000, 9_000_000_000))

    backups = BackupService(
        lambda: executable,
        lambda: False,
        lambda: None,
        lambda _value: None,
        profile_provider=profiles.profile,
    )

    assert backups.world() == selected.resolve()


def test_backup_writes_fail_closed_when_bound_world_moves(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    world = executable.parent / "Pal" / "Saved" / "SaveGames" / "0" / "world-a"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    database.set_setting("server.executable", str(executable))
    profiles = ServerProfileService(database)
    profiles.bind(executable, "world-a")
    world.rename(world.parent / "moved")
    backups = BackupService(
        lambda: executable,
        lambda: False,
        lambda: None,
        lambda _value: None,
        profile_provider=profiles.profile,
    )

    for action in ("delete", "restore"):
        with pytest.raises(BackupError) as error:
            if action == "delete":
                backups.delete("2026.08.01-01.02.03")
            else:
                backups.restore("2026.08.01-01.02.03")
        assert error.value.code == "WORLD_BINDING_INVALID"
