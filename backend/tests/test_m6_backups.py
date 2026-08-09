from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, cast

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
    (path / "Players" / "slot.sav").write_bytes(b"player-backup")
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


def persistent_service(
    tmp_path: Path, running: bool = False
) -> tuple[BackupService, Path, Database, Path]:
    exe, world = make_world(tmp_path)
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    backup = BackupService(
        lambda: exe,
        lambda: running,
        lambda: None,
        lambda _value: None,
        database=database,
    )
    return backup, world, database, exe


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


@pytest.mark.parametrize("action", ["list", "delete", "retention", "restore"])
def test_backup_operations_reject_intermediate_reparse_point(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    backups, world, state = service(tmp_path)
    backup = make_backup(world, "2026.08.01-01.02.03")
    redirected_parent = world / "backup"
    original_is_symlink = Path.is_symlink

    def fake_is_symlink(path: Path) -> bool:
        return path == redirected_parent or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)
    with pytest.raises(BackupError) as error:
        if action == "list":
            backups.list()
        elif action == "delete":
            backups.delete("2026.08.01-01.02.03")
        elif action == "retention":
            backups.set_retention(0)
        else:
            backups.restore("2026.08.01-01.02.03")

    assert error.value.code == "BACKUP_PATH_INVALID"
    assert backup.is_dir()
    assert state["retention"] is None


def test_restore_rejects_active_lifecycle_operation(tmp_path: Path) -> None:
    backups, world, database, _ = persistent_service(tmp_path)
    backup = make_backup(world, "2026.08.01-01.02.03")
    database.create_operation("queued-start", "start", "queued-start")

    with pytest.raises(BackupError) as error:
        backups.restore("2026.08.01-01.02.03")

    assert error.value.code == "OPERATION_IN_PROGRESS"
    assert database.restore_journal() is None
    assert backup.is_dir()


def test_restore_journal_resumes_after_replacement_crash(tmp_path: Path) -> None:
    backups, world, database, executable = persistent_service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    original_replace = backups._replace

    def crash_once(source: Path, target: Path) -> None:
        if target.name == "Level.sav":
            raise SystemExit("simulated power loss")
        original_replace(source, target)

    backups._replace = crash_once
    with pytest.raises(SystemExit, match="simulated power loss"):
        backups.restore("2026.08.01-01.02.03")

    journal = database.restore_journal()
    assert journal is not None
    assert journal["phase"] == "replacing"
    assert str(journal["world_id"]) == world.name
    assert Path(str(journal["staging_path"])).is_dir()

    resumed = BackupService(
        lambda: executable,
        lambda: False,
        lambda: None,
        lambda _value: None,
        database=database,
    )
    result = resumed.resume_restore()

    assert result["phase"] == "completed"
    assert (world / "Level.sav").read_bytes() == b"level-backup"
    assert (world / "LevelMeta.sav").read_bytes() == b"meta-backup"
    assert not Path(str(journal["staging_path"])).exists()
    assert resumed.recovery_status()["active"] is False


@pytest.mark.parametrize("component", ["Level.sav", "LevelMeta.sav", "Players"])
def test_each_replacement_failure_has_deterministic_rollback(
    tmp_path: Path, component: str
) -> None:
    backups, world, database, _ = persistent_service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    original_replace = backups._replace

    def fail_component(source: Path, target: Path) -> None:
        if target.name == component:
            raise OSError(f"injected failure at {component}")
        original_replace(source, target)

    backups._replace = fail_component
    with pytest.raises(BackupError) as raised:
        backups.restore("2026.08.01-01.02.03")

    assert raised.value.code == "RESTORE_FAILED"
    assert "injected failure" in str(raised.value)
    assert (world / "Level.sav").read_bytes() == b"level-current"
    assert (world / "LevelMeta.sav").read_bytes() == b"meta-current"
    journal = database.restore_journal()
    assert journal is not None
    assert journal["phase"] == "rolled_back"
    assert "injected failure" in str(journal["original_error"])


def test_rollback_failure_preserves_original_english_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    backups, world, database, _ = persistent_service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    original_replace = backups._replace

    def fail_forward(source: Path, target: Path) -> None:
        if target.name == "Level.sav":
            raise OSError("injected forward failure")
        original_replace(source, target)

    original_copy2 = shutil.copy2

    def fail_rollback_copy(
        source: Path, target: Path, *, follow_symlinks: bool = True
    ) -> Any:
        if target == world / "Level.sav":
            raise OSError("injected rollback failure")
        return original_copy2(source, target, follow_symlinks=follow_symlinks)

    backups._replace = fail_forward
    monkeypatch.setattr(shutil, "copy2", fail_rollback_copy)

    with pytest.raises(BackupError) as raised:
        backups.restore("2026.08.01-01.02.03")

    assert raised.value.code == "ROLLBACK_FAILED"
    assert "injected forward failure" in str(raised.value)
    assert "injected rollback failure" in str(raised.value)
    journal = database.restore_journal()
    assert journal is not None
    assert journal["phase"] == "rollback_failed"
    assert "injected forward failure" in str(journal["original_error"])


def test_incomplete_restore_blocks_conflicting_backup_writes(tmp_path: Path) -> None:
    backups, world, database, _ = persistent_service(tmp_path)
    make_backup(world, "2026.08.01-01.02.03")
    original_replace = backups._replace

    def crash(source: Path, target: Path) -> None:
        if target.name == "Level.sav":
            raise SystemExit("simulated power loss")
        original_replace(source, target)

    backups._replace = crash
    with pytest.raises(SystemExit):
        backups.restore("2026.08.01-01.02.03")

    with pytest.raises(BackupError) as raised:
        backups.delete("2026.08.01-01.02.03")

    assert raised.value.code == "RESTORE_RECOVERY_REQUIRED"
    public = backups.recovery_status()
    assert public["active"] is True
    assert isinstance(public["journal"], dict)
    checksums = cast(dict[str, object], public["journal"])["checksums"]
    assert isinstance(checksums, dict)
    assert json.dumps(checksums, ensure_ascii=False)
