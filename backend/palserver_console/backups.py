from __future__ import annotations

import builtins
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict, cast

from .config import ProfileError, ServerProfile
from .persistence import Database, RestoreJournalConflictError

BACKUP_NAME = re.compile(r"^\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}$")
REQUIRED_FILES = ("Level.sav", "LevelMeta.sav")
RESTORE_COMPONENTS = (*REQUIRED_FILES, "Players")
RESTORE_TERMINAL_PHASES = frozenset({"completed", "rolled_back"})


class BackupError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class BackupItem(TypedDict):
    id: str
    observedAt: int
    sizeBytes: int
    valid: bool
    missing: list[str]
    path: str


class BackupService:
    def __init__(
        self,
        executable_provider: Callable[[], Path | None],
        running_provider: Callable[[], bool],
        retention_provider: Callable[[], int | None],
        retention_setter: Callable[[int | None], None],
        audit: Callable[[str, str, dict[str, object]], None] | None = None,
        index_upsert: Callable[[str, str, int, str], None] | None = None,
        profile_provider: Callable[[], ServerProfile] | None = None,
        database: Database | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.executable_provider = executable_provider
        self.running_provider = running_provider
        self.retention_provider = retention_provider
        self.retention_setter = retention_setter
        self.audit = audit
        self.index_upsert = index_upsert
        self.profile_provider = profile_provider
        self.database = database
        self.clock = clock
        self._replace: Callable[[Path, Path], None] = os.replace
        self._volatile_journal: dict[str, object] | None = None

    def world(self) -> Path:
        if self.profile_provider is not None:
            try:
                return self.profile_provider().world_path
            except ProfileError as error:
                raise BackupError(error.code, str(error)) from error
        executable = self.executable_provider()
        if executable is None:
            raise BackupError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        try:
            root = (
                executable.resolve(strict=True).parent / "Pal" / "Saved" / "SaveGames" / "0"
            ).resolve(strict=True)
            candidates = [
                p
                for p in root.iterdir()
                if p.is_dir()
                and not p.name.startswith(".palconsole-restore-")
                and (p / "Level.sav").is_file()
            ]
        except OSError as error:
            raise BackupError(
                "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
            ) from error
        if not candidates:
            raise BackupError("WORLD_NOT_FOUND", "未发现包含 Level.sav 的当前世界。")
        if len(candidates) > 1:
            raise BackupError(
                "WORLD_SELECTION_REQUIRED", "Multiple worlds were found; select a World ID first."
            )
        return candidates[0]

    def backup_root(self) -> Path:
        return self._backup_root_for_world(self.world())

    @staticmethod
    def _backup_root_for_world(world: Path) -> Path:
        raw_root = world / "backup" / "world"
        root = raw_root.resolve(strict=False)
        if raw_root.is_symlink() or _is_junction(raw_root):
            raise BackupError("BACKUP_PATH_INVALID", "官方备份根目录不能是链接。")
        root.mkdir(parents=True, exist_ok=True)
        return root

    @staticmethod
    def _assert_backup_id(backup_id: str) -> None:
        if not BACKUP_NAME.fullmatch(backup_id) or Path(backup_id).name != backup_id:
            raise BackupError("INVALID_BACKUP_ID", "备份 ID 必须是官方时间目录名。")

    @staticmethod
    def _safe_child(root: Path, name: str) -> Path:
        BackupService._assert_backup_id(name)
        resolved_root = root.resolve(strict=False)
        candidate = (root / name).resolve(strict=False)
        try:
            relative = candidate.relative_to(resolved_root)
        except ValueError as error:
            raise BackupError("BACKUP_PATH_INVALID", "备份路径越界。") from error
        raw_candidate = root / name
        if (
            len(relative.parts) != 1
            or candidate == resolved_root
            or raw_candidate.is_symlink()
            or _is_junction(raw_candidate)
        ):
            raise BackupError("BACKUP_PATH_INVALID", "备份目录不能是链接或越界路径。")
        return candidate

    def _validate(self, path: Path) -> tuple[bool, list[str], int]:
        missing = [name for name in REQUIRED_FILES if not (path / name).is_file()]
        players = path / "Players"
        if not players.is_dir() or players.is_symlink():
            missing.append("Players")
        if not missing:
            try:
                self._component_checksums(path)
            except BackupError:
                missing.append("UnsafeTree")
        size = 0
        if path.is_dir() and not path.is_symlink():
            for child in path.rglob("*"):
                if child.is_file() and not child.is_symlink():
                    size += child.stat().st_size
        return not missing, missing, size

    def list(self) -> dict[str, object]:
        root = self.backup_root()
        items: builtins.list[BackupItem] = []
        for path in root.iterdir():
            if not path.is_dir() or path.is_symlink() or not BACKUP_NAME.fullmatch(path.name):
                continue
            valid, missing, size = self._validate(path)
            validation = "valid" if valid else "invalid"
            items.append(
                {
                    "id": path.name,
                    "observedAt": int(path.stat().st_mtime),
                    "sizeBytes": size,
                    "valid": valid,
                    "missing": missing,
                    "path": str(path),
                }
            )
            if self.index_upsert:
                self.index_upsert(path.name, path.name, int(path.stat().st_mtime), validation)
        items.sort(key=lambda item: str(item["id"]), reverse=True)
        return {
            "source": "official-backup",
            "observedAt": int(time.time()),
            "stale": False,
            "errorCode": None,
            "retention": self.retention_provider(),
            "worldPath": str(self.world()),
            "backupRoot": str(root),
            "restoreRecovery": self.recovery_status(),
            "items": items,
        }

    def set_retention(self, value: int | None) -> dict[str, object]:
        if value is not None and (value < 0 or value > 100000):
            raise BackupError("INVALID_RETENTION", "保留数量必须为无限或 0 到 100000。")
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "服务器运行时不能修改会清理备份的保留策略。")
        self._ensure_no_recovery()
        self.retention_setter(value)
        deleted = self.cleanup()
        self._audit("backup.retention", "success", {"retention": value, "deleted": deleted})
        return {"retention": value, "deleted": deleted}

    def cleanup(self) -> builtins.list[str]:
        self._ensure_no_recovery()
        retention = self.retention_provider()
        if retention is None:
            return []
        items = cast(builtins.list[BackupItem], self.list()["items"])
        deletable = [item for item in items if bool(item["valid"])]
        victims = deletable[max(0, retention) :]
        deleted: list[str] = []
        root = self.backup_root()
        for item in victims:
            backup_id = str(item["id"])
            path = self._safe_child(root, backup_id)
            shutil.rmtree(path)
            deleted.append(backup_id)
            self._audit("backup.delete", "success", {"backupId": backup_id, "reason": "retention"})
        return deleted

    def delete(self, backup_id: str) -> None:
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "服务器运行时不能删除备份。")
        self._ensure_no_recovery()
        root = self.backup_root()
        path = self._safe_child(root, backup_id)
        if not path.is_dir():
            raise BackupError("BACKUP_NOT_FOUND", "备份不存在。")
        shutil.rmtree(path)
        self._audit("backup.delete", "success", {"backupId": backup_id, "reason": "manual"})

    def restore(self, backup_id: str) -> None:
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "恢复前必须先停止 PalServer。")
        self._ensure_no_recovery()
        world = self.world()
        root = self.backup_root()
        source = self._safe_child(root, backup_id)
        valid, missing, _ = self._validate(source)
        if not source.is_dir() or not valid:
            raise BackupError(
                "BACKUP_INVALID", f"备份不完整，缺少：{', '.join(missing) or '目录'}。"
            )
        source_checksums = self._component_checksums(source)
        self._assert_tree_safe(world, skip_backup=True)
        safe_id, safe = self._allocate_safety_copy(root)
        staging = world.parent / f".palconsole-restore-{uuid.uuid4().hex}"
        journal_id = f"restore-{uuid.uuid4().hex}"
        journal_checksums: dict[str, object] = {"source": source_checksums}
        journal = self._begin_journal(
            journal_id=journal_id,
            world_id=self._world_id(world),
            world_path=world,
            source_backup_id=backup_id,
            source_path=source,
            safety_copy_path=safe,
            staging_path=staging,
            phase="safety_copy",
            checksums=journal_checksums,
        )
        try:
            journal = self._prepare_safety_copy(journal)
            journal = self._prepare_staging(journal)
            self._execute_forward(journal)
        except Exception as error:
            self._handle_restore_failure(error)
        self._audit("backup.restore", "success", {"backupId": backup_id, "safetyCopy": safe_id})

    def recovery_status(self) -> dict[str, object]:
        journal = self._journal()
        if journal is None:
            return {"active": False, "journal": None}
        phase = str(journal.get("phase", ""))
        return {
            "active": phase not in RESTORE_TERMINAL_PHASES,
            "journal": self._public_journal(journal),
        }

    def resume_restore(self) -> dict[str, object]:
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "恢复前必须先停止 PalServer。")
        journal = self._require_active_journal()
        if str(journal.get("phase")) == "rollback_failed":
            raise BackupError(
                "RESTORE_RECOVERY_REQUIRED", "回滚失败，请先修复安全副本后执行 rollback。"
            )
        journal = self._assert_journal_target(journal)
        try:
            journal = self._prepare_safety_copy(journal)
            journal = self._prepare_staging(journal)
            self._execute_forward(journal)
        except Exception as error:
            self._handle_restore_failure(error)
        completed = self._journal()
        if completed is None:
            raise BackupError("RESTORE_JOURNAL_MISSING", "恢复 journal 在完成后丢失。")
        return self._public_journal(completed)

    def rollback_restore(self) -> dict[str, object]:
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "回滚前必须先停止 PalServer。")
        journal = self._require_active_journal()
        journal = self._assert_journal_target(journal)
        checksums = self._journal_checksums(journal)
        completed = self._completed_components(journal)
        try:
            journal = self._rollback_from_safety(journal)
            checksums = self._journal_checksums(journal)
            journal = self._update_journal(
                journal,
                phase="rolled_back",
                component=None,
                completed=completed,
                checksums=checksums,
                error_type=journal.get("error_type"),
                error_message=journal.get("error_message"),
                original_error=journal.get("original_error"),
            )
        except Exception as error:
            original = str(journal.get("original_error") or self._english_error(error))
            self._update_journal(
                journal,
                phase="rollback_failed",
                component=journal.get("component"),
                completed=completed,
                checksums=checksums,
                error_type="ROLLBACK_FAILED",
                error_message=self._english_error(error),
                original_error=original,
            )
            raise BackupError(
                "ROLLBACK_FAILED",
                f"回滚失败: {self._english_error(error)}; original error: {original}",
            ) from error
        self._audit(
            "backup.restore.rollback",
            "success",
            {"journalId": journal.get("journal_id")},
        )
        return self._public_journal(journal)

    def _journal(self) -> dict[str, object] | None:
        if self.database is not None:
            return self.database.restore_journal()
        return self._volatile_journal

    def _begin_journal(
        self,
        *,
        journal_id: str,
        world_id: str,
        world_path: Path,
        source_backup_id: str,
        source_path: Path,
        safety_copy_path: Path,
        staging_path: Path,
        phase: str,
        checksums: dict[str, object],
    ) -> dict[str, object]:
        if self.database is not None:
            try:
                self.database.begin_restore_journal(
                    journal_id,
                    world_id,
                    str(world_path.resolve()),
                    source_backup_id,
                    str(source_path.resolve()),
                    str(safety_copy_path.resolve(strict=False)),
                    str(staging_path.resolve(strict=False)),
                    phase,
                    self._dump_json(checksums),
                )
            except RestoreJournalConflictError as error:
                raise BackupError("RESTORE_RECOVERY_REQUIRED", str(error)) from error
            journal = self.database.restore_journal()
            if journal is None:
                raise BackupError("RESTORE_JOURNAL_MISSING", "无法创建恢复 journal。")
            return journal
        if self._volatile_journal is not None and self._journal_active(self._volatile_journal):
            raise BackupError(
                "RESTORE_RECOVERY_REQUIRED", "请先完成当前恢复事务的 resume 或 rollback。"
            )
        self._volatile_journal = {
            "journal_id": journal_id,
            "world_id": world_id,
            "world_path": str(world_path.resolve()),
            "source_backup_id": source_backup_id,
            "source_path": str(source_path.resolve()),
            "safety_copy_path": str(safety_copy_path.resolve(strict=False)),
            "staging_path": str(staging_path.resolve(strict=False)),
            "phase": phase,
            "component": None,
            "completed_components_json": "[]",
            "checksums_json": self._dump_json(checksums),
            "error_type": None,
            "error_message": None,
            "original_error": None,
        }
        return self._volatile_journal

    def _update_journal(
        self,
        journal: dict[str, object],
        *,
        phase: str,
        component: object,
        completed: builtins.list[str],
        checksums: dict[str, object],
        error_type: object = None,
        error_message: object = None,
        original_error: object = None,
    ) -> dict[str, object]:
        component_value = None if component is None else str(component)
        error_type_value = None if error_type is None else str(error_type)
        error_message_value = None if error_message is None else str(error_message)
        original_error_value = None if original_error is None else str(original_error)
        completed_json = self._dump_json(completed)
        checksums_json = self._dump_json(checksums)
        if self.database is not None:
            self.database.update_restore_journal(
                phase=phase,
                component=component_value,
                completed_components_json=completed_json,
                checksums_json=checksums_json,
                error_type=error_type_value,
                error_message=error_message_value,
                original_error=original_error_value,
            )
            updated = self.database.restore_journal()
            if updated is None:
                raise BackupError("RESTORE_JOURNAL_MISSING", "恢复 journal 更新后无法读取。")
            return updated
        journal.update(
            {
                "phase": phase,
                "component": component_value,
                "completed_components_json": completed_json,
                "checksums_json": checksums_json,
                "error_type": error_type_value,
                "error_message": error_message_value,
                "original_error": original_error_value,
            }
        )
        return journal

    def _prepare_safety_copy(self, journal: dict[str, object]) -> dict[str, object]:
        world, _, safety, _ = self._journal_paths(journal)
        checksums = self._journal_checksums(journal)
        expected = checksums.get("safety")
        if safety.exists():
            try:
                actual = self._component_checksums(safety)
            except BackupError:
                actual = None
            if expected is not None and actual != expected:
                raise BackupError("SAFETY_COPY_INVALID", "安全副本校验失败，无法继续恢复。")
            if expected is None and actual is not None:
                checksums["safety"] = actual
                return self._update_journal(
                    journal,
                    phase=(
                        "staging"
                        if str(journal.get("phase")) == "safety_copy"
                        else str(journal["phase"])
                    ),
                    component=journal.get("component"),
                    completed=self._completed_components(journal),
                    checksums=checksums,
                    error_type=journal.get("error_type"),
                    error_message=journal.get("error_message"),
                    original_error=journal.get("original_error"),
                )
            if expected is not None and actual == expected:
                return journal
            shutil.rmtree(safety, ignore_errors=False)
        self._assert_tree_safe(world, skip_backup=True)
        shutil.copytree(world, safety, symlinks=False, ignore=shutil.ignore_patterns("backup"))
        checksums["safety"] = self._component_checksums(safety)
        return self._update_journal(
            journal,
            phase=(
                "staging"
                if str(journal.get("phase")) == "safety_copy"
                else str(journal["phase"])
            ),
            component=journal.get("component"),
            completed=self._completed_components(journal),
            checksums=checksums,
            error_type=journal.get("error_type"),
            error_message=journal.get("error_message"),
            original_error=journal.get("original_error"),
        )

    def _prepare_staging(self, journal: dict[str, object]) -> dict[str, object]:
        _, source, _, staging = self._journal_paths(journal)
        checksums = self._journal_checksums(journal)
        expected_source = checksums.get("source")
        actual_source = self._component_checksums(source)
        if expected_source != actual_source:
            raise BackupError("BACKUP_CHANGED", "官方备份在恢复前发生变化，已停止恢复。")
        expected_staging = checksums.get("staging")
        actual_staging: dict[str, str] | None = None
        if staging.exists():
            try:
                actual_staging = self._component_checksums(staging)
            except BackupError:
                actual_staging = None
        if expected_staging is None or not staging.exists() or actual_staging != expected_staging:
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=False)
            staging.mkdir()
            for name in REQUIRED_FILES:
                shutil.copy2(source / name, staging / name)
            shutil.copytree(source / "Players", staging / "Players", symlinks=False)
            actual_staging = self._component_checksums(staging)
        checksums["staging"] = actual_staging
        phase = str(journal.get("phase"))
        if phase in {"safety_copy", "staging"}:
            phase = "ready"
        return self._update_journal(
            journal,
            phase=phase,
            component=journal.get("component"),
            completed=self._completed_components(journal),
            checksums=checksums,
            error_type=journal.get("error_type"),
            error_message=journal.get("error_message"),
            original_error=journal.get("original_error"),
        )

    def _execute_forward(self, journal: dict[str, object]) -> dict[str, object]:
        world, _, _, staging = self._journal_paths(journal)
        checksums = self._journal_checksums(journal)
        source_checksums = cast(dict[str, str], checksums.get("source", {}))
        completed = self._completed_components(journal)
        for name in RESTORE_COMPONENTS:
            if name in completed:
                continue
            target = world / name
            expected = source_checksums.get(name)
            if expected is None:
                raise BackupError("RESTORE_CHECKSUM_MISSING", f"缺少 {name} 的源校验信息。")
            if self._component_matches(target, expected):
                completed.append(name)
                journal = self._update_journal(
                    journal,
                    phase="replacing",
                    component=None,
                    completed=completed,
                    checksums=checksums,
                    error_type=journal.get("error_type"),
                    error_message=journal.get("error_message"),
                    original_error=journal.get("original_error"),
                )
                continue
            staged = staging / name
            if not self._component_matches(staged, expected):
                raise BackupError("STAGING_INVALID", f"恢复 staging 的 {name} 校验失败。")
            journal = self._update_journal(
                journal,
                phase="replacing",
                component=name,
                completed=completed,
                checksums=checksums,
                error_type=None,
                error_message=None,
                original_error=journal.get("original_error"),
            )
            if name == "Players":
                self._remove_component_target(target)
            self._replace(staged, target)
            if not self._component_matches(target, expected):
                raise BackupError("TARGET_VERIFY_FAILED", f"恢复后的 {name} 校验失败。")
            completed.append(name)
            journal = self._update_journal(
                journal,
                phase="replacing",
                component=None,
                completed=completed,
                checksums=checksums,
                error_type=None,
                error_message=None,
                original_error=journal.get("original_error"),
            )
        journal = self._update_journal(
            journal,
            phase="committing",
            component=None,
            completed=completed,
            checksums=checksums,
            error_type=None,
            error_message=None,
            original_error=journal.get("original_error"),
        )
        final_checksums = self._component_checksums(world)
        if final_checksums != source_checksums:
            raise BackupError("TARGET_VERIFY_FAILED", "恢复目标最终校验失败。")
        checksums["worldAfter"] = final_checksums
        journal = self._update_journal(
            journal,
            phase="completed",
            component=None,
            completed=completed,
            checksums=checksums,
            error_type=None,
            error_message=None,
            original_error=journal.get("original_error"),
        )
        shutil.rmtree(staging, ignore_errors=True)
        return journal

    def _handle_restore_failure(self, error: Exception) -> None:
        journal = self._journal()
        if journal is None:
            raise BackupError("RESTORE_JOURNAL_MISSING", "恢复失败后找不到 journal。") from error
        original = self._english_error(error)
        phase = str(journal.get("phase"))
        checksums = self._journal_checksums(journal)
        completed = self._completed_components(journal)
        journal = self._update_journal(
            journal,
            phase="rollback_pending",
            component=journal.get("component"),
            completed=completed,
            checksums=checksums,
            error_type=type(error).__name__,
            error_message=str(error),
            original_error=original,
        )
        if phase not in {"replacing", "committing", "rollback_pending", "rollback_failed"}:
            journal = self._update_journal(
                journal,
                phase="rolled_back",
                component=None,
                completed=completed,
                checksums=checksums,
                error_type=type(error).__name__,
                error_message=str(error),
                original_error=original,
            )
            self._cleanup_staging(journal)
            self._raise_restore_error(error, original)
        try:
            journal = self._rollback_from_safety(journal)
        except Exception as rollback:
            rollback_text = self._english_error(rollback)
            self._update_journal(
                journal,
                phase="rollback_failed",
                component=journal.get("component"),
                completed=completed,
                checksums=checksums,
                error_type="ROLLBACK_FAILED",
                error_message=rollback_text,
                original_error=original,
            )
            raise BackupError(
                "ROLLBACK_FAILED",
                f"恢复失败且回滚失败: {rollback_text}; original error: {original}",
            ) from rollback
        self._update_journal(
            journal,
            phase="rolled_back",
            component=None,
            completed=completed,
            checksums=self._journal_checksums(journal),
            error_type=type(error).__name__,
            error_message=str(error),
            original_error=original,
        )
        self._cleanup_staging(journal)
        self._raise_restore_error(error, original)

    def _rollback_from_safety(self, journal: dict[str, object]) -> dict[str, object]:
        world, _, safety, _ = self._journal_paths(journal)
        checksums = self._journal_checksums(journal)
        expected_safety = checksums.get("safety")
        actual_safety = self._component_checksums(safety)
        if expected_safety != actual_safety:
            raise BackupError("SAFETY_COPY_INVALID", "安全副本校验失败，无法回滚。")
        for name in REQUIRED_FILES:
            shutil.copy2(safety / name, world / name)
        self._remove_component_target(world / "Players")
        shutil.copytree(safety / "Players", world / "Players", symlinks=False)
        restored = self._component_checksums(world)
        if restored != expected_safety:
            raise BackupError("ROLLBACK_VERIFY_FAILED", "回滚后的世界校验失败。")
        checksums["worldAfterRollback"] = restored
        return self._update_journal(
            journal,
            phase="rollback_pending",
            component=None,
            completed=self._completed_components(journal),
            checksums=checksums,
            error_type=journal.get("error_type"),
            error_message=journal.get("error_message"),
            original_error=journal.get("original_error"),
        )

    def _assert_journal_target(self, journal: dict[str, object]) -> dict[str, object]:
        world, source, safety, staging = self._journal_paths(journal)
        current_world = self.world().resolve(strict=False)
        if os.path.normcase(str(current_world)) != os.path.normcase(str(world)):
            raise BackupError("RESTORE_TARGET_MISMATCH", "恢复目标路径已发生变化。")
        if world.name != str(journal.get("world_id")):
            raise BackupError("RESTORE_TARGET_MISMATCH", "恢复目标 World ID 已发生变化。")
        if str(world.resolve()) != str(Path(str(journal["world_path"])).resolve(strict=False)):
            raise BackupError("RESTORE_TARGET_MISMATCH", "恢复目标路径已发生变化。")
        if str(source.resolve()) != str(Path(str(journal["source_path"])).resolve(strict=False)):
            raise BackupError("RESTORE_SOURCE_MISMATCH", "恢复源路径已发生变化。")
        if safety.parent.resolve() != self._backup_root_for_world(world).resolve():
            raise BackupError("RESTORE_PATH_INVALID", "安全副本路径越界。")
        if staging.parent.resolve() != world.parent.resolve():
            raise BackupError("RESTORE_PATH_INVALID", "staging 路径越界。")
        return journal

    def _journal_paths(self, journal: dict[str, object]) -> tuple[Path, Path, Path, Path]:
        world = Path(str(journal["world_path"])).resolve(strict=False)
        root = self._backup_root_for_world(world)
        source = self._safe_child(root, str(journal["source_backup_id"]))
        safety = self._safe_child(root, Path(str(journal["safety_copy_path"])).name)
        staging = Path(str(journal["staging_path"])).resolve(strict=False)
        return world, source, safety, staging

    def _require_active_journal(self) -> dict[str, object]:
        journal = self._journal()
        if journal is None or not self._journal_active(journal):
            raise BackupError("RESTORE_RECOVERY_NOT_FOUND", "没有待恢复的 restore journal。")
        return journal

    def _ensure_no_recovery(self) -> None:
        journal = self._journal()
        if journal is not None and self._journal_active(journal):
            raise BackupError(
                "RESTORE_RECOVERY_REQUIRED", "请先完成当前恢复事务的 resume 或 rollback。"
            )

    @staticmethod
    def _journal_active(journal: dict[str, object]) -> bool:
        return str(journal.get("phase")) not in RESTORE_TERMINAL_PHASES

    @staticmethod
    def _journal_checksums(journal: dict[str, object]) -> dict[str, object]:
        try:
            value = json.loads(str(journal.get("checksums_json", "{}")))
        except json.JSONDecodeError:
            return {}
        return cast(dict[str, object], value) if isinstance(value, dict) else {}

    @staticmethod
    def _completed_components(journal: dict[str, object]) -> builtins.list[str]:
        try:
            value = json.loads(str(journal.get("completed_components_json", "[]")))
        except json.JSONDecodeError:
            return []
        return [str(item) for item in value] if isinstance(value, list) else []

    @classmethod
    def _public_journal(cls, journal: dict[str, object]) -> dict[str, object]:
        checksums = cls._journal_checksums(journal)
        completed = cls._completed_components(journal)
        return {
            "journalId": journal.get("journal_id"),
            "worldId": journal.get("world_id"),
            "worldPath": journal.get("world_path"),
            "sourceBackupId": journal.get("source_backup_id"),
            "sourcePath": journal.get("source_path"),
            "safetyCopyPath": journal.get("safety_copy_path"),
            "stagingPath": journal.get("staging_path"),
            "phase": journal.get("phase"),
            "component": journal.get("component"),
            "completedComponents": completed,
            "checksums": checksums,
            "errorType": journal.get("error_type"),
            "errorMessage": journal.get("error_message"),
            "originalError": journal.get("original_error"),
            "createdAt": journal.get("created_at"),
            "updatedAt": journal.get("updated_at"),
        }

    @staticmethod
    def _dump_json(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def _english_error(error: BaseException) -> str:
        return f"{type(error).__name__}: {error}"

    @staticmethod
    def _raise_restore_error(error: Exception, original: str) -> None:
        if isinstance(error, BackupError):
            raise error
        raise BackupError("RESTORE_FAILED", f"恢复失败: {original}") from error

    def _allocate_safety_copy(self, root: Path) -> tuple[str, Path]:
        base = int(self.clock())
        for offset in range(0, 100000):
            safe_id = time.strftime(
                "%Y.%m.%d-%H.%M.%S", time.localtime(base + offset)
            )
            safe = self._safe_child(root, safe_id)
            if not safe.exists():
                return safe_id, safe
        raise BackupError("SAFETY_COPY_UNAVAILABLE", "无法为恢复创建唯一安全副本目录。")

    def _cleanup_staging(self, journal: dict[str, object]) -> None:
        try:
            _, _, _, staging = self._journal_paths(journal)
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)
        except (BackupError, OSError):
            pass

    @staticmethod
    def _world_id(world: Path) -> str:
        return world.name

    @staticmethod
    def _assert_tree_safe(root: Path, *, skip_backup: bool = False) -> None:
        if not root.is_dir() or root.is_symlink() or _is_junction(root):
            raise BackupError("RESTORE_TREE_INVALID", "恢复目录不能是链接或非目录。")
        try:
            children = root.rglob("*")
            for child in children:
                relative = child.relative_to(root)
                if skip_backup and relative.parts and relative.parts[0] == "backup":
                    continue
                if child.is_symlink() or _is_junction(child):
                    raise BackupError(
                        "RESTORE_TREE_INVALID", f"恢复目录包含链接：{relative}。"
                    )
        except OSError as error:
            raise BackupError(
                "RESTORE_TREE_INVALID", f"恢复目录校验失败: {type(error).__name__}: {error}"
            ) from error

    @classmethod
    def _component_checksums(cls, root: Path) -> dict[str, str]:
        cls._assert_tree_safe(root)
        checksums: dict[str, str] = {}
        for name in RESTORE_COMPONENTS:
            path = root / name
            if name == "Players":
                if not path.is_dir() or path.is_symlink() or _is_junction(path):
                    raise BackupError("RESTORE_TREE_INVALID", "Players 目录无效。")
                checksums[name] = cls._digest_tree(path)
            else:
                if not path.is_file() or path.is_symlink() or _is_junction(path):
                    raise BackupError("RESTORE_TREE_INVALID", f"{name} 文件无效。")
                checksums[name] = cls._digest_file(path)
        return checksums

    @classmethod
    def _digest_file(cls, path: Path) -> str:
        digest = hashlib.sha256()
        try:
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
        except OSError as error:
            raise BackupError(
                "RESTORE_CHECKSUM_FAILED", f"读取校验文件失败: {type(error).__name__}: {error}"
            ) from error
        return digest.hexdigest()

    @classmethod
    def _digest_tree(cls, root: Path) -> str:
        digest = hashlib.sha256()
        try:
            children = sorted(root.rglob("*"), key=lambda path: path.relative_to(root).as_posix())
            for child in children:
                relative = child.relative_to(root)
                if child.is_symlink() or _is_junction(child):
                    raise BackupError(
                        "RESTORE_TREE_INVALID", f"恢复目录包含链接：{relative}。"
                    )
                if child.is_file():
                    digest.update(relative.as_posix().encode("utf-8"))
                    digest.update(b"\0")
                    digest.update(bytes.fromhex(cls._digest_file(child)))
        except OSError as error:
            raise BackupError(
                "RESTORE_CHECKSUM_FAILED", f"读取校验目录失败: {type(error).__name__}: {error}"
            ) from error
        return digest.hexdigest()

    @classmethod
    def _component_matches(cls, path: Path, expected: str) -> bool:
        try:
            actual = cls._digest_tree(path) if path.name == "Players" else cls._digest_file(path)
            return actual == expected
        except (BackupError, OSError):
            return False

    @staticmethod
    def _remove_component_target(path: Path) -> None:
        if not path.exists() and not path.is_symlink():
            return
        if path.is_symlink() or _is_junction(path):
            raise BackupError("RESTORE_TARGET_INVALID", "恢复目标组件不能是链接。")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()

    def open_directory(self) -> str:
        root = self.backup_root()
        if os.name == "nt":
            os.startfile(str(root))
        else:
            subprocess.Popen(["xdg-open", str(root)])
        return str(root)

    def _audit(self, event: str, result: str, detail: dict[str, object]) -> None:
        if self.audit:
            self.audit(event, result, detail)


def _is_junction(path: Path) -> bool:
    checker = getattr(path, "is_junction", None)
    return bool(checker and checker())
