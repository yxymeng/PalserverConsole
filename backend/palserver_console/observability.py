from __future__ import annotations

import shutil
import time
from collections.abc import Callable
from pathlib import Path

from .audit import AuditService
from .backups import BackupError, BackupService
from .monitoring import MonitorCoordinator
from .world.cache import inspect_storage
from .world.service import WorldSnapshotService

WORLD_STALE_AFTER_SECONDS = 24 * 60 * 60
BACKUP_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60


class OperationalHealthService:
    """Collect a read-only, bounded operational-health snapshot for the console."""

    def __init__(
        self,
        data_dir: Path,
        monitor: MonitorCoordinator,
        audit: AuditService,
        world: WorldSnapshotService,
        backups: BackupService,
        *,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.data_dir = data_dir
        self.monitor = monitor
        self.audit = audit
        self.world = world
        self.backups = backups
        self.clock = clock

    def snapshot(self) -> dict[str, object]:
        now = int(self.clock())
        capacity = self.world.capacity_status()
        backup = self._backup_health(now)
        world = self._world_health(now)
        directories = self._directory_health(backup)
        background = [
            self._background_health(
                self.monitor.status(),
                stale_after_seconds=max(15, int(self.monitor.interval_seconds * 3)),
                now=now,
            ),
            self._background_health(
                self.audit.status(),
                stale_after_seconds=max(15, int(self.audit.poll_seconds * 3)),
                now=now,
            ),
            self._background_health(
                self.world.background_status(),
                stale_after_seconds=max(15, int(self.world.poll_seconds * 3)),
                now=now,
            ),
        ]
        return {
            "observedAt": now,
            "capacity": capacity,
            "directories": directories,
            "world": world,
            "backups": backup,
            "background": background,
            "alerts": self._alerts(capacity, directories, world, backup, background),
        }

    def _backup_health(self, now: int) -> dict[str, object]:
        try:
            summary = self.backups.health_summary()
        except (BackupError, OSError) as error:
            return {
                "state": "unavailable",
                "checkedAt": now,
                "lastSuccessAt": None,
                "errorCode": error.code if isinstance(error, BackupError) else "BACKUP_SCAN_FAILED",
                "itemCount": 0,
                "validCount": 0,
                "invalidCount": 0,
                "totalBytes": 0,
                "backupRoot": None,
            }
        state = str(summary["state"])
        last_valid_at = summary.get("lastValidAt")
        if (
            state == "healthy"
            and isinstance(last_valid_at, int)
            and now - last_valid_at > BACKUP_STALE_AFTER_SECONDS
        ):
            state = "stale"
        return {
            **summary,
            "state": state,
            "lastSuccessAt": last_valid_at,
            "errorCode": None,
        }

    def _world_health(self, now: int) -> dict[str, object]:
        status = self.world.status()
        snapshot_id = status.get("snapshotId")
        error_code = status.get("errorCode")
        parsed_at = status.get("parsedAt")
        last_success_at = parsed_at if isinstance(parsed_at, int) else None
        if last_success_at is None and snapshot_id is not None:
            observed_at = status.get("observedAt")
            last_success_at = observed_at if isinstance(observed_at, int) else None

        no_data_codes = {
            "SNAPSHOT_PENDING",
            "SERVER_NOT_CONFIGURED",
            "WORLD_PROFILE_REQUIRED",
            "WORLD_NOT_FOUND",
            "WORLD_SELECTION_REQUIRED",
        }
        if snapshot_id is None and (error_code is None or error_code in no_data_codes):
            state = "no_data"
        elif error_code:
            state = "failed"
        elif last_success_at is not None and now - last_success_at > WORLD_STALE_AFTER_SECONDS:
            state = "stale"
        else:
            state = "healthy"
        return {
            "state": state,
            "lastSuccessAt": last_success_at,
            "snapshotId": snapshot_id,
            "parsing": bool(status.get("parsing")),
            "errorCode": error_code,
            "cacheSizeBytes": status.get("cacheSizeBytes"),
        }

    def _directory_health(self, backup: dict[str, object]) -> list[dict[str, object]]:
        backup_root = backup.get("backupRoot")
        targets: list[tuple[str, str, Path | None]] = [
            ("runtime-data", "运行数据", self.data_dir),
            ("application-logs", "应用日志", self.data_dir / "logs"),
            ("cache", "解析缓存", self.world.cache_root),
            ("snapshots", "存档快照", self.world.snapshots_root),
            (
                "official-backups",
                "官方备份",
                Path(backup_root) if isinstance(backup_root, str) else None,
            ),
        ]
        return [self._directory_entry(name, label, path) for name, label, path in targets]

    @staticmethod
    def _nearest_existing_path(path: Path) -> Path:
        current = path
        while not current.exists() and current.parent != current:
            current = current.parent
        return current

    def _directory_entry(self, name: str, label: str, path: Path | None) -> dict[str, object]:
        if path is None:
            return {
                "name": name,
                "label": label,
                "path": None,
                "state": "unavailable",
                "sizeBytes": 0,
                "fileCount": 0,
                "freeBytes": None,
                "totalBytes": None,
                "errorCode": "PATH_UNAVAILABLE",
            }
        usage = inspect_storage(path)
        try:
            disk = shutil.disk_usage(self._nearest_existing_path(path))
            free_bytes: int | None = int(disk.free)
            total_bytes: int | None = int(disk.total)
        except OSError:
            free_bytes, total_bytes = None, None
        errors = int(usage["errors"])
        skipped = int(usage["skippedEntries"])
        exists = bool(usage["exists"])
        state = (
            "unavailable"
            if errors or free_bytes is None
            else "no_data"
            if not exists
            else "warning"
            if skipped
            else "ok"
        )
        return {
            "name": name,
            "label": label,
            "path": str(path),
            "state": state,
            "sizeBytes": int(usage["sizeBytes"]),
            "fileCount": int(usage["fileCount"]),
            "freeBytes": free_bytes,
            "totalBytes": total_bytes,
            "errorCode": (
                "STORAGE_SCAN_FAILED"
                if errors
                else "REPARSE_POINT_SKIPPED"
                if skipped
                else None
            ),
        }

    @staticmethod
    def _background_health(
        status: dict[str, object], *, stale_after_seconds: int, now: int
    ) -> dict[str, object]:
        alive = bool(status.get("alive"))
        last_success_at = status.get("lastSuccessAt")
        last_error = status.get("lastError")
        failures = status.get("consecutiveFailures")
        consecutive_failures = failures if isinstance(failures, int) else 0
        if not alive:
            state = "stopped"
        elif not isinstance(last_success_at, int):
            state = "failed" if last_error else "no_data"
        elif now - last_success_at > stale_after_seconds:
            state = "stale"
        elif consecutive_failures > 0:
            state = "failed"
        else:
            state = "healthy"
        error_code = last_error.get("code") if isinstance(last_error, dict) else None
        return {
            "name": status.get("name"),
            "state": state,
            "alive": alive,
            "startedAt": status.get("startedAt"),
            "lastSuccessAt": last_success_at,
            "lastRunAt": status.get("lastRunAt"),
            "errorCode": error_code,
        }

    @staticmethod
    def _alerts(
        capacity: dict[str, object],
        directories: list[dict[str, object]],
        world: dict[str, object],
        backup: dict[str, object],
        background: list[dict[str, object]],
    ) -> list[dict[str, str]]:
        alerts: list[dict[str, str]] = []
        state_labels = {
            "no_data": "无数据",
            "stale": "数据较旧",
            "unavailable": "不可用",
            "failed": "失败",
            "invalid": "校验无效",
            "stopped": "已停止",
        }
        capacity_state = capacity.get("state")
        if capacity_state == "blocked":
            alerts.append(
                {
                    "severity": "critical",
                    "code": "DISK_SPACE_LOW",
                    "message": "运行数据磁盘空间不足，下次存档快照复制将被阻止。",
                }
            )
        elif capacity_state == "warning":
            alerts.append(
                {
                    "severity": "warning",
                    "code": "DISK_SPACE_WARNING",
                    "message": "运行数据剩余空间接近下次存档快照复制的安全余量。",
                }
            )
        elif capacity_state == "unavailable":
            alerts.append(
                {
                    "severity": "warning",
                    "code": "DISK_USAGE_UNAVAILABLE",
                    "message": "无法确认运行数据目录的剩余磁盘空间。",
                }
            )
        for directory in directories:
            if directory.get("state") in {"warning", "unavailable"}:
                alerts.append(
                    {
                        "severity": "warning",
                        "code": str(directory.get("errorCode") or "STORAGE_WARNING"),
                        "message": f"{directory.get('label')} 的容量巡检不完整。",
                    }
                )
        for component, label in ((world, "存档解析"), (backup, "官方备份")):
            state = component.get("state")
            if state == "failed" or state == "invalid":
                alerts.append(
                    {
                        "severity": "critical",
                        "code": str(component.get("errorCode") or f"{label}_FAILED"),
                        "message": f"{label}存在失败或无效数据。",
                    }
                )
            elif state in {"no_data", "stale", "unavailable"}:
                alerts.append(
                    {
                        "severity": "warning",
                        "code": str(component.get("errorCode") or f"{label}_ATTENTION"),
                        "message": f"{label}需要关注：{state_labels.get(str(state), '状态异常')}。",
                    }
                )
        for service in background:
            state = service.get("state")
            if state in {"failed", "stale", "stopped"}:
                alerts.append(
                    {
                        "severity": "critical" if state == "stopped" else "warning",
                        "code": str(service.get("errorCode") or "BACKGROUND_UNHEALTHY"),
                        "message": (
                            f"后台服务 {service.get('name')} 状态为 "
                            f"{state_labels.get(str(state), '异常')}。"
                        ),
                    }
                )
        return alerts
