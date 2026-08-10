from __future__ import annotations

import json
import time
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as distribution_version
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ... import __version__
from ...dependencies import AppDependencies
from ..schemas import ComponentVersions, HealthResponse, ShellStatusResponse
from ..security import require_authenticated_request


def _frontend_build_version(static_dir: Path) -> str:
    try:
        payload = json.loads((static_dir / "build-info.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "unavailable"
    if not isinstance(payload, dict):
        return "unavailable"
    version = payload.get("frontendVersion")
    return version if isinstance(version, str) and version else "unavailable"


def _parser_version() -> str:
    try:
        return distribution_version("palworld-save-tools")
    except PackageNotFoundError:
        return "unavailable"


def router(deps: AppDependencies, api_version: str) -> APIRouter:
    api = APIRouter()

    def component_versions() -> ComponentVersions:
        return ComponentVersions(
            application=__version__,
            api=api_version,
            database=deps.database.schema_version(),
            frontend=_frontend_build_version(deps.settings.static_dir),
            parser=_parser_version(),
        )

    @api.get("/api/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse(versions=component_versions())

    @api.get("/api/monitoring/status", tags=["system"], response_model=None)
    def monitoring_status(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return {"monitor": deps.monitor.status(), "audit": deps.audit.status()}

    @api.get("/api/operations/health", tags=["system"], response_model=None)
    def operational_health(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.operational_health.snapshot()

    @api.get("/api/bootstrap", tags=["system"], response_model=None)
    def bootstrap(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        shell = deps.lifecycle.status()
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
                "instanceId": deps.settings.instance_id,
            },
            "live": deps.monitor.snapshot(),
            "world": deps.world.status(),
            "version": api_version,
            "versions": component_versions().model_dump(),
        }

    @api.get("/api/shell/status", response_model=ShellStatusResponse, tags=["system"])
    def shell_status(request: Request) -> ShellStatusResponse | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        status = deps.lifecycle.status()
        return ShellStatusResponse(
            observedAt=int(time.time()),
            serverState=status["state"],
            configured=bool(status["configured"]),
            pids=list(status["pids"]),
            executablePath=status["executablePath"],
            errorCode=status["errorCode"],
            instanceId=deps.settings.instance_id,
        )

    return api
