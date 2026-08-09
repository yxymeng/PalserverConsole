from __future__ import annotations

import os
import subprocess
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...config_editor import ConfigError, parse_draft_request
from ...dependencies import AppDependencies
from ...errors import freshness
from ...lifecycle import LifecycleError
from ..contract import operation_public
from ..schemas import ConfigApplyRequest, LifecycleRequest, MessageResponse
from ..security import error_response, peer_ip, require_authenticated_request, require_write


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/config/current", tags=["config"], response_model=None)
    def config_current(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            result = deps.config.current()
            result.update(freshness(source="config-file", observed_at=int(time.time())))
            return result
        except ConfigError as error:
            return error_response(503, error.code, str(error))

    @api.get("/api/config/draft", tags=["config"], response_model=None)
    def config_draft(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            result = deps.config.draft()
            result.update(freshness(source="config-file", observed_at=int(time.time())))
            return result
        except ConfigError as error:
            return error_response(503, error.code, str(error))

    @api.put("/api/config/draft", tags=["config"], response_model=None)
    async def config_save_draft(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            fields = parse_draft_request(await request.body())
            result = deps.config.save_draft(fields)
            deps.audit.record(
                "config.draft",
                result="success",
                detail={"fieldCount": len(fields)},
                peer_ip=peer_ip(request),
            )
            return result
        except ConfigError as error:
            status = 413 if error.code == "CONFIG_REQUEST_TOO_LARGE" else 409
            return error_response(status, error.code, str(error))

    @api.delete("/api/config/draft", tags=["config"], response_model=MessageResponse)
    def config_delete_draft(request: Request) -> MessageResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        deps.database.clear_config_draft()
        return MessageResponse(message="待应用草稿已删除。")

    @api.get("/api/config/diff", tags=["config"], response_model=None)
    def config_diff(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.config.diff()
        except ConfigError as error:
            return error_response(503, error.code, str(error))

    @api.post("/api/config/apply", tags=["config"], response_model=None)
    def config_apply(
        request: Request, payload: ConfigApplyRequest | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            result = deps.config.apply(force=bool(payload and payload.force))
            deps.audit.record(
                "config.apply",
                result="success",
                detail={"backupPath": result.get("backupPath")},
                peer_ip=peer_ip(request),
            )
            return result
        except ConfigError as error:
            return error_response(409, error.code, str(error))

    @api.post("/api/config/apply-with-restart", tags=["config"], response_model=None)
    def config_apply_with_restart(
        request: Request, payload: LifecycleRequest | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            config_diff = deps.config.diff()
            if not bool(config_diff.get("hasDraft")):
                raise ConfigError("CONFIG_DRAFT_NOT_FOUND", "没有待应用配置草稿。")
            if config_diff.get("conflict"):
                raise ConfigError("CONFIG_CONFLICT", "检测到外部修改，请先在配置页确认覆盖。")
            operation = deps.lifecycle.begin(
                "apply_config_and_restart",
                request.headers.get("Idempotency-Key", ""),
                countdown_seconds=payload.countdownSeconds if payload else 30,
                message=payload.message if payload else LifecycleRequest().message,
            )
            deps.audit.record(
                "config.apply_with_restart",
                result="queued",
                detail={"operationId": operation.get("id")},
                peer_ip=peer_ip(request),
            )
            return operation_public(operation)
        except (ConfigError, LifecycleError) as error:
            return error_response(409, getattr(error, "code", "CONFIG_APPLY_FAILED"), str(error))

    @api.post("/api/config/open-folder", tags=["config"], response_model=None)
    def config_open_folder(request: Request) -> dict[str, str] | JSONResponse:
        from ...auth import is_loopback

        if not is_loopback(peer_ip(request)):
            return error_response(403, "LOCAL_ONLY", "打开配置目录只能在服务器本机执行。")
        try:
            path = deps.config.folder_path()
            path.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                os.startfile(str(path))
            else:
                subprocess.Popen(["xdg-open", str(path)])
            return {"path": str(path)}
        except ConfigError as error:
            return error_response(503, error.code, str(error))
        except OSError as error:
            return error_response(503, "CONFIG_FOLDER_OPEN_FAILED", f"打开配置目录失败: {error}")

    return api
