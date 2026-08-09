from __future__ import annotations

import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from . import __version__
from .api.frontend import mount_frontend
from .api.routers import (
    audit_router,
    auth_router,
    backups_router,
    config_router,
    live_router,
    maintenance_router,
    server_router,
    system_router,
    world_router,
)
from .api.security import (
    CSRF_COOKIE_NAME,
    WRITE_METHODS,
    error_response,
    peer_ip,
    valid_host,
    valid_origin,
)
from .audit import DEFAULT_RETENTION_DAYS
from .auth import is_loopback
from .config import AppSettings, default_settings
from .dependencies import AppDependencies, DefaultDependencyFactory, DependencyFactory
from .lifecycle import LifecycleManager
from .monitoring import MonitorCoordinator
from .world.service import WorldSnapshotService

__all__ = ["CSRF_COOKIE_NAME", "app", "create_app", "os"]


def _lifespan(deps: AppDependencies) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        deps.database.migrate()
        cleanup = deps.auth.cleanup_expired()
        deps.logger.info(
            "console startup data_dir=%s cleaned_sessions=%d cleaned_login_attempts=%d",
            deps.settings.data_dir,
            cleanup["sessions"],
            cleanup["loginAttempts"],
        )
        interrupted_operations = deps.database.recover_incomplete_operations()
        for interrupted in interrupted_operations:
            deps.audit.record(
                "server.operation.transition",
                result="interrupted",
                detail={
                    "operationId": interrupted.get("id"),
                    "kind": interrupted.get("kind"),
                    "fromState": interrupted.get("state"),
                    "fromStage": interrupted.get("stage"),
                    "state": "failed",
                    "stage": "interrupted",
                    "errorCode": "CONSOLE_RESTARTED",
                },
            )
        recovery = deps.backups.recovery_status()
        if recovery["active"]:
            journal = recovery.get("journal")
            detail = journal if isinstance(journal, dict) else {}
            deps.audit.record(
                "backup.restore.recovery_required",
                result="blocked",
                detail={
                    "journalId": detail.get("journalId"),
                    "worldId": detail.get("worldId"),
                    "sourceBackupId": detail.get("sourceBackupId"),
                    "phase": detail.get("phase"),
                },
            )
        if deps.database.get_setting("audit.retention_days") is None:
            deps.database.set_setting("audit.retention_days", str(DEFAULT_RETENTION_DAYS))
        deps.audit.start()
        deps.monitor.start()
        deps.world.start()
        try:
            yield
        finally:
            deps.world.stop()
            deps.monitor.stop()
            deps.audit.stop()
            deps.logger.info("console shutdown")

    return lifespan


def create_app(
    settings: AppSettings | None = None,
    lifecycle_manager: LifecycleManager | None = None,
    monitor: MonitorCoordinator | None = None,
    world_service: WorldSnapshotService | None = None,
    dependency_factory: DependencyFactory | None = None,
) -> FastAPI:
    resolved_settings = settings or default_settings()
    factory = dependency_factory or DefaultDependencyFactory()
    deps = factory.create(
        resolved_settings,
        lifecycle_manager=lifecycle_manager,
        monitor=monitor,
        world_service=world_service,
    )
    app = FastAPI(
        title="PalServerConsole",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        lifespan=_lifespan(deps),
    )

    app.state.dependencies = deps
    app.state.settings = deps.settings
    app.state.database = deps.database
    app.state.logger = deps.logger
    app.state.auth = deps.auth
    app.state.lifecycle = deps.lifecycle
    app.state.monitor = deps.monitor
    app.state.audit = deps.audit
    app.state.world_data = deps.world
    app.state.backups = deps.backups
    app.state.config_editor = deps.config
    app.state.operational_health = deps.operational_health
    app.state.notifications = deps.notifications
    app.state.updates = deps.updates

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _: RequestValidationError) -> JSONResponse:
        if request.url.path.startswith("/api/auth/"):
            return error_response(422, "INVALID_AUTH_INPUT", "认证输入格式不正确。")
        return error_response(422, "INVALID_INPUT", "请求输入格式不正确。")

    @app.middleware("http")
    async def security_boundary(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        request_ip = peer_ip(request)
        local = is_loopback(request_ip)
        if not local and not deps.auth.admin_password_configured():
            return error_response(
                403,
                "GAME_ADMIN_PASSWORD_REQUIRED",
                "游戏 AdminPassword 未配置，只允许本机访问。",
            )
        if not valid_host(request, deps.settings):
            return error_response(400, "INVALID_HOST", "Host 不在允许范围内。")
        if request.method in WRITE_METHODS and not valid_origin(request):
            return error_response(403, "ORIGIN_REJECTED", "Origin 与当前 Host 不匹配。")

        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'"
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    app.include_router(system_router(deps, app.version))
    app.include_router(auth_router(deps))
    app.include_router(server_router(deps))
    app.include_router(maintenance_router(deps))
    app.include_router(live_router(deps))
    app.include_router(audit_router(deps))
    app.include_router(world_router(deps))
    app.include_router(config_router(deps))
    app.include_router(backups_router(deps))
    mount_frontend(app, deps.settings.static_dir)
    return app


app = create_app()
