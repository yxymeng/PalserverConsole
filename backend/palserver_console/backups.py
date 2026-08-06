from __future__ import annotations

import builtins
import os
import re
import shutil
import subprocess
import time
from collections.abc import Callable
from pathlib import Path
from typing import TypedDict, cast

BACKUP_NAME = re.compile(r"^\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}$")
REQUIRED_FILES = ("Level.sav", "LevelMeta.sav")


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
    ) -> None:
        self.executable_provider = executable_provider
        self.running_provider = running_provider
        self.retention_provider = retention_provider
        self.retention_setter = retention_setter
        self.audit = audit
        self.index_upsert = index_upsert

    def world(self) -> Path:
        executable = self.executable_provider()
        if executable is None:
            raise BackupError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        try:
            root = (
                executable.resolve(strict=True).parent / "Pal" / "Saved" / "SaveGames" / "0"
            ).resolve(strict=True)
            candidates = [p for p in root.iterdir() if p.is_dir() and (p / "Level.sav").is_file()]
        except OSError as error:
            raise BackupError(
                "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
            ) from error
        if not candidates:
            raise BackupError("WORLD_NOT_FOUND", "未发现包含 Level.sav 的当前世界。")
        return max(candidates, key=lambda p: (p / "Level.sav").stat().st_mtime_ns)

    def backup_root(self) -> Path:
        root = (self.world() / "backup" / "world").resolve(strict=False)
        raw_root = self.world() / "backup" / "world"
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
            "items": items,
        }

    def set_retention(self, value: int | None) -> dict[str, object]:
        if value is not None and (value < 0 or value > 100000):
            raise BackupError("INVALID_RETENTION", "保留数量必须为无限或 0 到 100000。")
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "服务器运行时不能修改会清理备份的保留策略。")
        self.retention_setter(value)
        deleted = self.cleanup()
        self._audit("backup.retention", "success", {"retention": value, "deleted": deleted})
        return {"retention": value, "deleted": deleted}

    def cleanup(self) -> builtins.list[str]:
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
        root = self.backup_root()
        path = self._safe_child(root, backup_id)
        if not path.is_dir():
            raise BackupError("BACKUP_NOT_FOUND", "备份不存在。")
        shutil.rmtree(path)
        self._audit("backup.delete", "success", {"backupId": backup_id, "reason": "manual"})

    def restore(self, backup_id: str) -> None:
        if self.running_provider():
            raise BackupError("SERVER_RUNNING", "恢复前必须先停止 PalServer。")
        world = self.world()
        root = self.backup_root()
        source = self._safe_child(root, backup_id)
        valid, missing, _ = self._validate(source)
        if not source.is_dir() or not valid:
            raise BackupError(
                "BACKUP_INVALID", f"备份不完整，缺少：{', '.join(missing) or '目录'}。"
            )
        safe_id = time.strftime("%Y.%m.%d-%H.%M.%S")
        safe = root / safe_id
        while safe.exists():
            safe_id = time.strftime("%Y.%m.%d-%H.%M.%S", time.localtime(time.time() + 1))
            safe = root / safe_id
        shutil.copytree(world, safe, symlinks=False, ignore=shutil.ignore_patterns("backup"))
        if not self._validate(safe)[0]:
            shutil.rmtree(safe, ignore_errors=True)
            raise BackupError("SAFETY_COPY_FAILED", "恢复前安全副本校验失败，未执行恢复。")
        staging = world.parent / f".palconsole-restore-{int(time.time())}"
        try:
            staging.mkdir()
            for name in REQUIRED_FILES:
                shutil.copy2(source / name, staging / name)
            shutil.copytree(source / "Players", staging / "Players", symlinks=False)
            if not self._validate(staging)[0]:
                raise BackupError("STAGING_INVALID", "恢复 staging 校验失败。")
            for name in REQUIRED_FILES:
                os.replace(staging / name, world / name)
            if (world / "Players").exists():
                shutil.rmtree(world / "Players")
            os.replace(staging / "Players", world / "Players")
        except Exception as error:
            try:
                for name in REQUIRED_FILES:
                    shutil.copy2(safe / name, world / name)
                if (world / "Players").exists():
                    shutil.rmtree(world / "Players")
                shutil.copytree(safe / "Players", world / "Players", symlinks=False)
            except Exception as rollback:
                raise BackupError(
                    "ROLLBACK_FAILED", f"恢复失败且回滚失败: {type(rollback).__name__}: {rollback}"
                ) from rollback
            if isinstance(error, BackupError):
                raise
            raise BackupError(
                "RESTORE_FAILED", f"恢复失败: {type(error).__name__}: {error}"
            ) from error
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        self._audit("backup.restore", "success", {"backupId": backup_id, "safetyCopy": safe_id})

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
