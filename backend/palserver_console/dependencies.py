from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .audit import AuditService
from .auth import AuthStore
from .backups import BackupService
from .config import AppSettings, ProfileError, ServerProfileService, configure_logging
from .config_editor import ConfigService
from .lifecycle import LifecycleManager
from .monitoring import (
    MonitorCoordinator,
    MonitoringConfigError,
    ServerConnectionConfig,
    read_connection_config,
)
from .observability import OperationalHealthService
from .persistence import Database
from .world.service import WorldSnapshotService


@dataclass(frozen=True)
class AppDependencies:
    settings: AppSettings
    logger: logging.Logger
    database: Database
    auth: AuthStore
    profiles: ServerProfileService
    audit: AuditService
    lifecycle: LifecycleManager
    monitor: MonitorCoordinator
    world: WorldSnapshotService
    backups: BackupService
    config: ConfigService
    operational_health: OperationalHealthService


class DependencyFactory(Protocol):
    def create(
        self,
        settings: AppSettings,
        *,
        lifecycle_manager: LifecycleManager | None = None,
        monitor: MonitorCoordinator | None = None,
        world_service: WorldSnapshotService | None = None,
    ) -> AppDependencies: ...


class DefaultDependencyFactory:
    def create(
        self,
        settings: AppSettings,
        *,
        lifecycle_manager: LifecycleManager | None = None,
        monitor: MonitorCoordinator | None = None,
        world_service: WorldSnapshotService | None = None,
    ) -> AppDependencies:
        logger = configure_logging(settings.data_dir)
        database = Database(settings.database_path)
        auth = AuthStore(database, settings)
        profiles = ServerProfileService(database)

        def executable_for_audit() -> Path | None:
            raw = database.get_setting("server.executable")
            return Path(raw) if raw else None

        audit = AuditService(
            database,
            executable_for_audit,
            maintenance_callback=auth.cleanup_expired,
        )

        def monitor_config() -> tuple[Path, ServerConnectionConfig]:
            try:
                profile = profiles.profile()
                return profile.executable_path, read_connection_config(profile.install_path)
            except ProfileError as error:
                raise MonitoringConfigError(error.code, str(error)) from error

        def audit_operation(event_type: str, result: str, detail: dict[str, object]) -> None:
            audit.record(event_type, result=result, detail=detail)

        def audit_console_line(line: str) -> None:
            audit.ingest_line(line, "console-output")

        lifecycle = lifecycle_manager or LifecycleManager(
            database,
            process=None,
            audit_callback=audit_operation,
            console_output_sink=audit_console_line,
            profile_provider=profiles.profile,
        )
        live_monitor = monitor or MonitorCoordinator(
            monitor_config, players_observer=audit.observe_players
        )
        world_data = world_service or WorldSnapshotService(
            database,
            executable_for_audit,
            settings.data_dir,
            profile_provider=profiles.profile,
        )
        backups = BackupService(
            executable_for_audit,
            lambda: lifecycle.status()["state"] == "running",
            lambda: _backup_retention(database),
            lambda value: _set_backup_retention(database, value),
            audit_operation,
            lambda backup_id, relative_path, observed_at, validation: database.upsert_backup_index(
                backup_id, relative_path, observed_at, validation
            ),
            profiles.profile,
            database=database,
            control_lock=lifecycle.control_lock,
        )
        config = ConfigService(
            database,
            settings.data_dir,
            executable_for_audit,
            lambda: lifecycle.status()["state"] == "running",
            profiles.profile,
            control_lock=lifecycle.control_lock,
        )
        lifecycle.set_config_apply(config.apply)
        operational_health = OperationalHealthService(
            settings.data_dir,
            live_monitor,
            audit,
            world_data,
            backups,
        )

        return AppDependencies(
            settings=settings,
            logger=logger,
            database=database,
            auth=auth,
            profiles=profiles,
            audit=audit,
            lifecycle=lifecycle,
            monitor=live_monitor,
            world=world_data,
            backups=backups,
            config=config,
            operational_health=operational_health,
        )


def _backup_retention(database: Database) -> int | None:
    raw = database.get_setting("backup.retention")
    if raw in (None, "", "infinite"):
        return None
    try:
        value = int(str(raw))
    except ValueError:
        return None
    return value if value >= 0 else None


def _set_backup_retention(database: Database, value: int | None) -> None:
    database.set_setting("backup.retention", "infinite" if value is None else str(value))
