from __future__ import annotations

import ipaddress
import json
import os
import subprocess
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .audit import DEFAULT_RETENTION_DAYS, AuditService, export_csv, export_json
from .auth import COOKIE_NAME, AuthStore, Session, is_loopback
from .backups import BackupError, BackupService
from .config import AppSettings, default_settings
from .config_editor import ConfigError, ConfigService
from .errors import error_payload, freshness
from .lifecycle import LifecycleError, LifecycleManager
from .monitoring import (
    MonitorCoordinator,
    MonitoringConfigError,
    ServerConnectionConfig,
    SourceError,
    read_connection_config,
)
from .persistence import Database
from .steam import discover_palserver, validate_executable
from .world.service import WorldDataError, WorldSnapshotService

CSRF_COOKIE_NAME = "palconsole_csrf"
COOKIE_MAX_AGE = 12 * 60 * 60
WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class HealthResponse(BaseModel):
    service: Literal["palserver-console"] = "palserver-console"
    status: Literal["ok"] = "ok"
    module: Literal["M2"] = "M2"
    # Keep the health contract stable for M0-M3 launchers; the internal DB is v3.
    schemaVersion: Literal[2] = 2


class AuthStatusResponse(BaseModel):
    local: bool
    authenticated: bool
    lanPasswordConfigured: bool
    csrfToken: str | None = None
    lanWarning: str | None = None
    port: int


class PasswordRequest(BaseModel):
    password: str = Field(min_length=10, max_length=256)


class MessageResponse(BaseModel):
    message: str


class NetworkSettingsRequest(BaseModel):
    port: int = Field(ge=1, le=65535)


class ShellStatusResponse(BaseModel):
    source: Literal["console"] = "console"
    observedAt: int
    stale: Literal[False] = False
    errorCode: str | None = None
    module: Literal["M2"] = "M2"
    serverState: Literal["not_configured", "stopped", "running"]
    configured: bool
    pids: list[int]
    executablePath: str | None


class ServerSettingsRequest(BaseModel):
    executablePath: str = Field(min_length=1, max_length=2048)
    launchArguments: str = Field(default="", max_length=4096)


class ServerSettingsResponse(BaseModel):
    executablePath: str | None
    launchArguments: str


class DiscoveryCandidateResponse(BaseModel):
    libraryPath: str
    installPath: str
    executablePath: str
    manifestValid: bool


class LifecycleRequest(BaseModel):
    countdownSeconds: int = Field(default=30, ge=5, le=300)
    message: str = Field(
        default="服务器将在 30 秒后维护，请及时返回安全地点。", min_length=1, max_length=500
    )


class LiveActionRequest(BaseModel):
    message: str = Field(default="由管理员发起的服务器管理操作。", min_length=1, max_length=500)


class AuditRetentionRequest(BaseModel):
    retentionDays: int = Field(ge=0, le=3650)


class BackupRetentionRequest(BaseModel):
    retention: int | None = Field(default=None, ge=0, le=100000)


class ConfigDraftRequest(BaseModel):
    fields: dict[str, str] = Field(default_factory=dict)


class ConfigApplyRequest(BaseModel):
    force: bool = False


ApiOperationKind = Literal["start", "save", "stop", "restart"]


def create_app(
    settings: AppSettings | None = None,
    lifecycle_manager: LifecycleManager | None = None,
    monitor: MonitorCoordinator | None = None,
    world_service: WorldSnapshotService | None = None,
) -> FastAPI:
    resolved_settings = settings or default_settings()
    database = Database(resolved_settings.database_path)
    auth = AuthStore(database, resolved_settings)

    def executable_for_audit() -> Path | None:
        raw = database.get_setting("server.executable")
        return Path(raw) if raw else None

    audit = AuditService(database, executable_for_audit)

    def monitor_config() -> tuple[Path, ServerConnectionConfig]:
        raw_executable = database.get_setting("server.executable")
        if not raw_executable:
            raise MonitoringConfigError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        try:
            executable = validate_executable(Path(raw_executable))
            return executable, read_connection_config(executable.parent)
        except (OSError, ValueError) as error:
            raise MonitoringConfigError("INVALID_SERVER_PATH", str(error)) from error

    def audit_operation(event_type: str, result: str, detail: dict[str, object]) -> None:
        audit.record(event_type, result=result, detail=detail)

    def audit_console_line(line: str) -> None:
        audit.ingest_line(line, "console-output")

    lifecycle = lifecycle_manager or LifecycleManager(
        database,
        process=None,
        audit_callback=audit_operation,
        console_output_sink=audit_console_line,
    )
    live_monitor = monitor or MonitorCoordinator(
        monitor_config, players_observer=audit.observe_players
    )
    world_data = world_service or WorldSnapshotService(
        database, executable_for_audit, resolved_settings.data_dir
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
    )
    lifecycle_holder: dict[str, LifecycleManager] = {}
    config_editor = ConfigService(
        database,
        resolved_settings.data_dir,
        executable_for_audit,
        lambda: bool(
            lifecycle_holder and lifecycle_holder["manager"].status()["state"] == "running"
        ),
    )
    lifecycle.pending_config_sync = config_editor.apply_pending_if_safe
    lifecycle_holder["manager"] = lifecycle

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        database.migrate()
        database.fail_incomplete_operations()
        if database.get_setting("audit.retention_days") is None:
            database.set_setting("audit.retention_days", str(DEFAULT_RETENTION_DAYS))
        audit.start()
        live_monitor.start()
        world_data.start()
        try:
            yield
        finally:
            world_data.stop()
            live_monitor.stop()
            audit.stop()

    app = FastAPI(
        title="PalServerConsole",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.database = database
    app.state.auth = auth
    app.state.lifecycle = lifecycle
    app.state.monitor = live_monitor
    app.state.audit = audit
    app.state.world_data = world_data
    app.state.backups = backups
    app.state.config_editor = config_editor

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, _: RequestValidationError) -> JSONResponse:
        if request.url.path.startswith("/api/auth/"):
            return _error(422, "INVALID_AUTH_INPUT", "认证输入格式不正确。")
        return _error(422, "INVALID_INPUT", "请求输入格式不正确。")

    @app.middleware("http")
    async def security_boundary(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        peer_ip = _peer_ip(request)
        local = is_loopback(peer_ip)
        if not local and not auth.password_configured():
            return _error(403, "LAN_PASSWORD_REQUIRED", "尚未设置局域网密码，只允许本机访问。")
        if not _valid_host(request, resolved_settings):
            return _error(400, "INVALID_HOST", "Host 不在允许范围内。")
        if request.method in WRITE_METHODS and not _valid_origin(request):
            return _error(403, "ORIGIN_REJECTED", "Origin 与当前 Host 不匹配。")

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

    @app.get("/api/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/api/bootstrap", tags=["system"], response_model=None)
    def bootstrap(request: Request) -> dict[str, object] | JSONResponse:
        """Return the read-only state needed to render the application shell."""

        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        shell = lifecycle.status()
        now = int(time.time())
        return {
            "shell": {
                "source": "console",
                "observedAt": now,
                "stale": False,
                "errorCode": shell["errorCode"],
                "serverState": shell["state"],
                "configured": shell["configured"],
                "pids": shell["pids"],
                "executablePath": shell["executablePath"],
            },
            "live": live_monitor.snapshot(),
            "world": world_data.status(),
            "version": app.version,
        }

    @app.get("/api/auth/status", response_model=AuthStatusResponse, tags=["auth"])
    def auth_status(request: Request, response: Response) -> AuthStatusResponse:
        peer_ip = _peer_ip(request)
        local = is_loopback(peer_ip)
        session = auth.read_session(request.cookies.get(COOKIE_NAME), peer_ip)
        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_token = (
            csrf_cookie
            if session is not None and auth.verify_csrf(session.id, csrf_cookie)
            else None
        )
        if local and session is None:
            cookie_value, new_session = auth.create_session(peer_ip, local=True)
            csrf_token = new_session.csrf_token
            _set_session_cookies(response, cookie_value, csrf_token)
            session = new_session
        return AuthStatusResponse(
            local=local,
            authenticated=local or session is not None,
            lanPasswordConfigured=auth.password_configured(),
            csrfToken=csrf_token,
            lanWarning=None if local else "仅可信内网使用，禁止公网暴露。",
            port=resolved_settings.port,
        )

    @app.post("/api/auth/lan-password", response_model=MessageResponse, tags=["auth"])
    def set_lan_password(
        request: Request, payload: PasswordRequest
    ) -> MessageResponse | JSONResponse:
        peer_ip = _peer_ip(request)
        if not is_loopback(peer_ip):
            return _error(403, "LOCAL_ONLY", "LAN 密码只能从本机设置或重置。")
        session = _require_session(request, auth, peer_ip)
        if isinstance(session, JSONResponse):
            return session
        csrf_error = _require_csrf(request, auth, session)
        if csrf_error:
            return csrf_error
        try:
            auth.set_password(payload.password)
        except ValueError as error:
            return _error(422, "PASSWORD_POLICY", str(error))
        return MessageResponse(message="局域网管理员密码已保存，重启控制台后将监听局域网。")

    @app.post("/api/auth/login", response_model=MessageResponse, tags=["auth"])
    def login(
        request: Request, payload: PasswordRequest, response: Response
    ) -> MessageResponse | JSONResponse:
        peer_ip = _peer_ip(request)
        if is_loopback(peer_ip):
            return MessageResponse(message="本机访问无需登录。")
        if auth.too_many_failures(peer_ip):
            return _error(429, "LOGIN_RATE_LIMITED", "登录失败次数过多，请稍后再试。")
        if not auth.verify_password(payload.password):
            auth.record_login(peer_ip, False)
            return _error(401, "INVALID_CREDENTIALS", "局域网管理员密码错误。")
        auth.record_login(peer_ip, True)
        cookie_value, session = auth.create_session(peer_ip, local=False)
        _set_session_cookies(response, cookie_value, session.csrf_token)
        return MessageResponse(message="登录成功。")

    @app.post("/api/auth/logout", response_model=MessageResponse, tags=["auth"])
    def logout(request: Request, response: Response) -> MessageResponse | JSONResponse:
        peer_ip = _peer_ip(request)
        session = _require_session(request, auth, peer_ip)
        if isinstance(session, JSONResponse):
            return session
        csrf_error = _require_csrf(request, auth, session)
        if csrf_error:
            return csrf_error
        auth.delete_session(session.id)
        response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict")
        response.delete_cookie(CSRF_COOKIE_NAME, path="/", samesite="strict")
        return MessageResponse(message="已退出登录。")

    @app.put("/api/settings/network", response_model=MessageResponse, tags=["settings"])
    def set_network_settings(
        request: Request, payload: NetworkSettingsRequest
    ) -> MessageResponse | JSONResponse:
        peer_ip = _peer_ip(request)
        if not is_loopback(peer_ip):
            return _error(403, "LOCAL_ONLY", "监听端口只能从本机修改。")
        session = _require_session(request, auth, peer_ip)
        if isinstance(session, JSONResponse):
            return session
        csrf_error = _require_csrf(request, auth, session)
        if csrf_error:
            return csrf_error
        database.set_setting("network.port", str(payload.port))
        audit.record(
            "config.network",
            detail={"port": payload.port},
            peer_ip=_peer_ip(request),
        )
        return MessageResponse(message="监听端口已保存，重启控制台后生效。")

    @app.get("/api/shell/status", response_model=ShellStatusResponse, tags=["system"])
    def shell_status(request: Request) -> ShellStatusResponse | JSONResponse:
        peer_ip = _peer_ip(request)
        if not is_loopback(peer_ip):
            session = _require_session(request, auth, peer_ip)
            if isinstance(session, JSONResponse):
                return session
        status = lifecycle.status()
        return ShellStatusResponse(
            observedAt=int(time.time()),
            serverState=status["state"],
            configured=bool(status["configured"]),
            pids=list(status["pids"]),
            executablePath=status["executablePath"],
            errorCode=status["errorCode"],
        )

    @app.get("/api/server/settings", response_model=ServerSettingsResponse, tags=["server"])
    def server_settings(request: Request) -> ServerSettingsResponse | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        return ServerSettingsResponse(
            executablePath=database.get_setting("server.executable"),
            launchArguments=database.get_setting("server.arguments") or "",
        )

    @app.put("/api/server/settings", response_model=MessageResponse, tags=["server"])
    def set_server_settings(
        request: Request, payload: ServerSettingsRequest
    ) -> MessageResponse | JSONResponse:
        denied = _require_local_write(request, auth)
        if denied:
            return denied
        try:
            executable = validate_executable(Path(payload.executablePath))
        except (OSError, ValueError) as error:
            return _error(422, "INVALID_SERVER_PATH", str(error))
        database.set_setting("server.executable", str(executable))
        database.set_setting("server.arguments", payload.launchArguments)
        audit.record(
            "config.server_settings",
            detail={
                "executablePath": str(executable),
                "hasLaunchArguments": bool(payload.launchArguments),
            },
            peer_ip=_peer_ip(request),
        )
        return MessageResponse(message="PalServer 路径和启动参数已保存。")

    @app.get(
        "/api/server/discovery",
        response_model=list[DiscoveryCandidateResponse],
        tags=["server"],
    )
    def discover(request: Request) -> list[DiscoveryCandidateResponse] | JSONResponse:
        if not is_loopback(_peer_ip(request)):
            return _error(403, "LOCAL_ONLY", "Steam 路径发现结果只在服务器本机显示。")
        return [
            DiscoveryCandidateResponse(
                libraryPath=str(item.library_path),
                installPath=str(item.install_path),
                executablePath=str(item.executable_path),
                manifestValid=item.manifest_valid,
            )
            for item in discover_palserver()
        ]

    @app.post("/api/server/operations/{kind}", tags=["server"], response_model=None)
    def begin_operation(
        kind: ApiOperationKind,
        request: Request,
        payload: LifecycleRequest | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            operation = lifecycle.begin(
                kind,
                request.headers.get("Idempotency-Key", ""),
                countdown_seconds=payload.countdownSeconds if payload else 30,
                message=(payload.message if payload else LifecycleRequest().message),
            )
            audit.record(
                f"server.{kind}",
                result="queued",
                detail={"operationId": operation.get("id"), "stage": operation.get("stage")},
                peer_ip=_peer_ip(request),
            )
            return _operation_public(operation)
        except LifecycleError as error:
            return _error(409, error.code, str(error))

    @app.get("/api/server/operations/{operation_id}", tags=["server"], response_model=None)
    def operation(operation_id: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        result = database.operation(operation_id)
        if result:
            return _operation_public(result)
        return _error(404, "OPERATION_NOT_FOUND", "操作不存在。")

    @app.post(
        "/api/server/operations/{operation_id}/cancel",
        tags=["server"],
        response_model=MessageResponse,
    )
    def cancel_operation(operation_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            lifecycle.cancel(operation_id)
        except LifecycleError as error:
            return _error(409, error.code, str(error))
        return MessageResponse(message="取消请求已提交。")

    @app.get("/api/live/{kind}", tags=["live"], response_model=None)
    def live_data(kind: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        if kind not in {"info", "players", "metrics", "settings"}:
            return _error(404, "LIVE_DATA_NOT_FOUND", "实时数据类型不存在。")
        return cast(dict[str, object], live_monitor.snapshot()[kind])

    @app.post("/api/live/announce", tags=["live"], response_model=None)
    def live_announce(
        request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(request, "announce", auth, live_monitor, audit, payload.message)

    @app.post("/api/live/players/{player_id}/kick", tags=["live"], response_model=None)
    def live_kick(
        player_id: str, request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(request, "kick", auth, live_monitor, audit, player_id, payload.message)

    @app.post("/api/live/players/{player_id}/ban", tags=["live"], response_model=None)
    def live_ban(
        player_id: str, request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(request, "ban", auth, live_monitor, audit, player_id, payload.message)

    @app.post("/api/live/players/{player_id}/unban", tags=["live"], response_model=None)
    def live_unban(player_id: str, request: Request) -> dict[str, object] | JSONResponse:
        return _live_action(request, "unban", auth, live_monitor, audit, player_id)

    @app.get("/api/audit", tags=["audit"], response_model=None)
    def audit_events(
        request: Request,
        page: int = 1,
        pageSize: int = 50,
        eventType: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        if page < 1 or pageSize < 1 or pageSize > 200:
            return _error(422, "INVALID_AUDIT_PAGE", "审计分页参数不正确。")
        rows, total = database.list_audit_events(
            page, pageSize, eventType, result, source, since, until
        )
        return {
            "items": [_audit_public(row) for row in rows],
            "page": page,
            "pageSize": pageSize,
            "total": total,
            **freshness(source="audit-db", observed_at=int(time.time())),
        }

    @app.get("/api/world/snapshots/current", tags=["world"], response_model=None)
    def world_snapshot(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        return world_data.status()

    @app.get("/api/world/players/{player_id}", tags=["world"], response_model=None)
    def world_player(player_id: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        try:
            return world_data.get_player(player_id)
        except WorldDataError as error:
            status = 404 if error.code == "PLAYER_NOT_FOUND" else 503
            return _error(status, error.code, str(error))

    @app.get("/api/world/{resource}", tags=["world"], response_model=None)
    def world_resource(
        resource: str,
        request: Request,
        page: int = 1,
        pageSize: int = 50,
        search: str | None = None,
        ownerId: str | None = None,
        baseId: str | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        if resource not in {"players", "pals", "guilds", "bases", "inventories", "work-pals"}:
            return _error(404, "WORLD_RESOURCE_NOT_FOUND", "世界数据类型不存在。")
        if page < 1 or pageSize < 1 or pageSize > 200:
            return _error(422, "INVALID_WORLD_PAGE", "世界数据分页参数不正确。")
        if search is not None and len(search) > 100:
            return _error(422, "INVALID_WORLD_SEARCH", "搜索文字不能超过 100 个字符。")
        try:
            return world_data.list_resource(
                resource,
                page=page,
                page_size=pageSize,
                search=search,
                owner_id=ownerId,
                base_id=baseId,
            )
        except WorldDataError as error:
            return _error(503, error.code, str(error))

    @app.post("/api/world/reparse", tags=["world"], response_model=MessageResponse)
    def world_reparse(request: Request) -> MessageResponse | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        world_data.request_reparse()
        audit.record(
            "world.reparse",
            result="queued",
            detail={"source": "save-snapshot"},
            peer_ip=_peer_ip(request),
        )
        return MessageResponse(message="已请求重新读取存档；文件稳定 5 秒后开始解析。")

    @app.get("/api/config/current", tags=["config"], response_model=None)
    def config_current(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        try:
            result = config_editor.current()
            result.update(freshness(source="config-file", observed_at=int(time.time())))
            return result
        except ConfigError as error:
            return _error(503, error.code, str(error))

    @app.get("/api/config/draft", tags=["config"], response_model=None)
    def config_draft(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        try:
            result = config_editor.draft()
            result.update(freshness(source="config-file", observed_at=int(time.time())))
            return result
        except ConfigError as error:
            return _error(503, error.code, str(error))

    @app.put("/api/config/draft", tags=["config"], response_model=None)
    def config_save_draft(
        request: Request, payload: ConfigDraftRequest
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            result = config_editor.save_draft(payload.fields)
            audit.record(
                "config.draft",
                result="success",
                detail={"fieldCount": len(payload.fields)},
                peer_ip=_peer_ip(request),
            )
            return result
        except ConfigError as error:
            return _error(409, error.code, str(error))

    @app.delete("/api/config/draft", tags=["config"], response_model=MessageResponse)
    def config_delete_draft(request: Request) -> MessageResponse | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        database.clear_config_draft()
        return MessageResponse(message="待应用草稿已删除。")

    @app.get("/api/config/diff", tags=["config"], response_model=None)
    def config_diff(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        try:
            return config_editor.diff()
        except ConfigError as error:
            return _error(503, error.code, str(error))

    @app.post("/api/config/apply", tags=["config"], response_model=None)
    def config_apply(
        request: Request, payload: ConfigApplyRequest | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            result = config_editor.apply(force=bool(payload and payload.force))
            audit.record(
                "config.apply",
                result="success",
                detail={"backupPath": result.get("backupPath")},
                peer_ip=_peer_ip(request),
            )
            return result
        except ConfigError as error:
            return _error(409, error.code, str(error))

    @app.post("/api/config/apply-with-restart", tags=["config"], response_model=None)
    def config_apply_with_restart(
        request: Request, payload: LifecycleRequest | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            config_diff = config_editor.diff()
            if not bool(config_diff.get("hasDraft")):
                raise ConfigError("CONFIG_DRAFT_NOT_FOUND", "没有待应用配置草稿。")
            if config_diff.get("conflict"):
                raise ConfigError("CONFIG_CONFLICT", "检测到外部修改，请先在配置页确认覆盖。")
            operation = lifecycle.begin(
                "restart",
                request.headers.get("Idempotency-Key", ""),
                countdown_seconds=payload.countdownSeconds if payload else 30,
                message=payload.message if payload else LifecycleRequest().message,
            )
            audit.record(
                "config.apply_with_restart",
                result="queued",
                detail={"operationId": operation.get("id")},
                peer_ip=_peer_ip(request),
            )
            return _operation_public(operation)
        except (ConfigError, LifecycleError) as error:
            return _error(409, getattr(error, "code", "CONFIG_APPLY_FAILED"), str(error))

    @app.post("/api/config/open-folder", tags=["config"], response_model=None)
    def config_open_folder(request: Request) -> dict[str, str] | JSONResponse:
        if not is_loopback(_peer_ip(request)):
            return _error(403, "LOCAL_ONLY", "打开配置目录只能在服务器本机执行。")
        try:
            path = config_editor.path().parent
            path.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(path))
            else:
                subprocess.Popen(["xdg-open", str(path)])
            return {"path": str(path)}
        except ConfigError as error:
            return _error(503, error.code, str(error))
        except OSError as error:
            return _error(503, "CONFIG_FOLDER_OPEN_FAILED", f"打开配置目录失败: {error}")

    @app.get("/api/backups", tags=["backups"], response_model=None)
    def backup_list(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        try:
            return backups.list()
        except BackupError as error:
            return _error(503, error.code, str(error))

    @app.put("/api/backups/retention", tags=["backups"], response_model=None)
    def backup_retention(
        request: Request, payload: BackupRetentionRequest
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            result = backups.set_retention(payload.retention)
            return result
        except BackupError as error:
            return _error(409, error.code, str(error))

    @app.delete("/api/backups/{backup_id}", tags=["backups"], response_model=None)
    def backup_delete(backup_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            backups.delete(backup_id)
            return MessageResponse(message="历史备份已删除。")
        except BackupError as error:
            return _error(409, error.code, str(error))

    @app.post("/api/backups/{backup_id}/restore", tags=["backups"], response_model=None)
    def backup_restore(backup_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            backups.restore(backup_id)
            return MessageResponse(message="备份已恢复。")
        except BackupError as error:
            return _error(409, error.code, str(error))

    @app.post("/api/backups/open-directory", tags=["backups"], response_model=None)
    def backup_open_directory(request: Request) -> dict[str, str] | JSONResponse:
        if not is_loopback(_peer_ip(request)):
            return _error(403, "LOCAL_ONLY", "打开备份目录只能在服务器本机执行。")
        try:
            return {"path": backups.open_directory()}
        except BackupError as error:
            return _error(503, error.code, str(error))

    @app.get("/api/audit/export", tags=["audit"], response_model=None)
    def audit_export(
        request: Request,
        format: str = "json",
        eventType: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> Response | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        if format not in {"json", "csv"}:
            return _error(422, "INVALID_EXPORT_FORMAT", "只支持 JSON 或 CSV 导出。")
        try:
            rows = database.audit_events_for_export(eventType, result, source, since, until)
            body = export_csv(rows) if format == "csv" else export_json(rows)
        except ValueError:
            return _error(413, "AUDIT_EXPORT_TOO_LARGE", "导出结果超过 200 条，请先筛选或分页。")
        media_type = "text/csv; charset=utf-8" if format == "csv" else "application/json"
        return Response(
            content=body,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="palserver-audit.{format}"'},
        )

    @app.get("/api/audit/capabilities", tags=["audit"], response_model=None)
    def audit_capabilities(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        return audit.capabilities()

    @app.get("/api/audit/settings", tags=["audit"], response_model=None)
    def audit_settings(request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        raw = database.get_setting("audit.retention_days")
        try:
            days = int(raw) if raw is not None else DEFAULT_RETENTION_DAYS
        except ValueError:
            days = DEFAULT_RETENTION_DAYS
        return {"retentionDays": days}

    @app.put("/api/audit/settings", tags=["audit"], response_model=None)
    def set_audit_settings(
        request: Request, payload: AuditRetentionRequest
    ) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        database.set_setting("audit.retention_days", str(payload.retentionDays))
        removed = audit.prune(payload.retentionDays)
        audit.record(
            "audit.retention",
            detail={"retentionDays": payload.retentionDays, "removed": removed},
            peer_ip=_peer_ip(request),
        )
        return {
            "message": "审计保留天数已保存。",
            "retentionDays": payload.retentionDays,
            "removed": removed,
        }

    @app.get("/api/events", tags=["live"], response_model=None)
    def events(request: Request) -> StreamingResponse | JSONResponse:
        denied = _require_authenticated_request(request, auth)
        if denied:
            return denied
        return StreamingResponse(
            live_monitor.stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.post(
        "/api/server/operations/{operation_id}/force-stop",
        tags=["server"],
        response_model=None,
    )
    def force_stop(operation_id: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = _require_write(request, auth)
        if denied:
            return denied
        try:
            return _operation_public(
                lifecycle.confirm_force_stop(
                    operation_id, request.headers.get("Idempotency-Key", "")
                )
            )
        except LifecycleError as error:
            return _error(409, error.code, str(error))

    _mount_frontend(app, resolved_settings.static_dir)
    return app


def _peer_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def _valid_host(request: Request, settings: AppSettings) -> bool:
    hostname = request.url.hostname
    if hostname is None:
        return False
    if hostname.casefold() in {item.casefold() for item in settings.allowed_hosts}:
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return address.is_private or address.is_loopback


def _valid_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return False
    parsed = urlsplit(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.casefold() == request.url.netloc.casefold()
    )


def _require_session(request: Request, auth: AuthStore, peer_ip: str) -> Session | JSONResponse:
    session = auth.read_session(request.cookies.get(COOKIE_NAME), peer_ip)
    if session is None:
        return _error(401, "AUTH_REQUIRED", "需要管理员登录。")
    return session


def _require_csrf(request: Request, auth: AuthStore, session: Session) -> JSONResponse | None:
    if auth.verify_csrf(session.id, request.headers.get("X-CSRF-Token")):
        return None
    return _error(403, "CSRF_REJECTED", "CSRF token 无效或缺失。")


def _require_authenticated_request(request: Request, auth: AuthStore) -> JSONResponse | None:
    peer_ip = _peer_ip(request)
    if is_loopback(peer_ip):
        return None
    session = _require_session(request, auth, peer_ip)
    return session if isinstance(session, JSONResponse) else None


def _require_write(request: Request, auth: AuthStore) -> JSONResponse | None:
    peer_ip = _peer_ip(request)
    session = _require_session(request, auth, peer_ip)
    if isinstance(session, JSONResponse):
        return session
    return _require_csrf(request, auth, session)


def _require_local_write(request: Request, auth: AuthStore) -> JSONResponse | None:
    if not is_loopback(_peer_ip(request)):
        return _error(403, "LOCAL_ONLY", "此设置只能从服务器本机修改。")
    return _require_write(request, auth)


def _set_session_cookies(response: Response, cookie_value: str, csrf_token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        cookie_value,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        secure=False,
        samesite="strict",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE_NAME,
        csrf_token,
        max_age=COOKIE_MAX_AGE,
        httponly=False,
        secure=False,
        samesite="strict",
        path="/",
    )


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content=error_payload(code, message, status))


def _operation_public(operation: Mapping[str, object]) -> dict[str, object]:
    """Expose one operation contract while keeping snake_case legacy keys."""

    result = dict(operation)
    result.update(
        {
            "operationId": operation.get("id"),
            "errorCode": operation.get("error_code"),
            "createdAt": operation.get("created_at"),
            "updatedAt": operation.get("updated_at"),
        }
    )
    return result


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


def _live_action(
    request: Request,
    name: str,
    auth: AuthStore,
    monitor: MonitorCoordinator,
    audit: AuditService,
    *args: str,
) -> dict[str, object] | JSONResponse:
    denied = _require_write(request, auth)
    if denied:
        return denied
    try:
        monitor.action(name, *args)
    except SourceError as error:
        status = error.status_code or {
            "REST_UNAUTHORIZED": 401,
            "REST_FORBIDDEN": 403,
            "REST_NOT_FOUND": 404,
            "REST_CONFLICT": 409,
            "REST_TIMEOUT": 504,
            "REST_CONNECTION_REFUSED": 503,
        }.get(error.code, 502)
        audit.record(
            f"live.{name}",
            result="failed",
            detail={"errorCode": error.code, "error": str(error), "arguments": list(args[:1])},
            peer_ip=_peer_ip(request),
        )
        return _error(status, error.code, str(error))
    audit.record(
        f"live.{name}",
        detail={"arguments": list(args[:1])},
        peer_ip=_peer_ip(request),
    )
    return {
        "message": "管理操作已发送。",
        "source": "rest",
        "observedAt": int(time.time()),
        "stale": False,
        "errorCode": None,
    }


def _audit_public(row: Mapping[str, object]) -> dict[str, object]:
    raw_detail = row.get("detail_json")
    try:
        detail = json.loads(str(raw_detail)) if raw_detail else {}
    except json.JSONDecodeError:
        detail = {"raw": str(raw_detail)}
    return {
        "id": row.get("id"),
        "eventType": row.get("event_type"),
        "peerIp": row.get("peer_ip"),
        "result": row.get("result"),
        "detail": detail,
        "createdAt": row.get("created_at"),
        "source": row.get("source"),
        "parserVersion": row.get("parser_version"),
    }


def _mount_frontend(app: FastAPI, static_dir: Path) -> None:
    index_path = static_dir / "index.html"
    if not index_path.is_file():
        return

    assets_dir = static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{frontend_path:path}", include_in_schema=False)
    def frontend(frontend_path: str) -> FileResponse:
        candidate = (static_dir / frontend_path).resolve()
        root = static_dir.resolve()
        if candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index_path)


app = create_app()
