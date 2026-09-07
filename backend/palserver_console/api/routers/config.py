from __future__ import annotations

import os
import subprocess
import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...config_editor import ConfigError, parse_config_request
from ...dependencies import AppDependencies
from ...errors import freshness
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

    @api.put("/api/config/ini", tags=["config"], response_model=None)
    async def config_save_ini(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            fields = parse_config_request(await request.body())
            result = deps.config.save_ini(fields)
            deps.audit.record(
                "config.ini.save",
                result="success",
                detail={"fieldCount": len(fields), "pending": result.get("pending")},
                peer_ip=peer_ip(request),
            )
            return result
        except ConfigError as error:
            status = 413 if error.code == "CONFIG_REQUEST_TOO_LARGE" else 409
            return error_response(status, error.code, str(error))

    @api.put("/api/config/world-option", tags=["config"], response_model=None)
    async def config_save_world_option(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            fields = parse_config_request(await request.body())
            result = deps.config.save_world_option(fields)
            deps.audit.record(
                "config.world_option.save",
                result="success",
                detail={
                    "fieldCount": len(fields),
                    "backupPath": result.get("backupPath"),
                    "pending": result.get("pending"),
                },
                peer_ip=peer_ip(request),
            )
            return result
        except ConfigError as error:
            status = 413 if error.code == "CONFIG_REQUEST_TOO_LARGE" else 409
            return error_response(status, error.code, str(error))

    @api.post("/api/config/open-folder", tags=["config"], response_model=None)
    def config_open_folder(request: Request) -> dict[str, str] | JSONResponse:
        from ...auth import is_loopback

        if not is_loopback(peer_ip(request)):
            return error_response(403, "LOCAL_ONLY", "打开配置目录只能在服务器本机执行。")
        try:
            path = (
                deps.config.world_option_folder_path()
                if request.query_params.get("kind") == "world-option"
                else deps.config.folder_path()
            )
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
