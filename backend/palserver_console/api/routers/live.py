from __future__ import annotations

import time
from typing import cast

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from ...dependencies import AppDependencies
from ...monitoring import SourceError
from ..schemas import LiveActionRequest
from ..security import error_response, peer_ip, require_authenticated_request, require_write


def _live_action(
    deps: AppDependencies, request: Request, name: str, *args: str
) -> dict[str, object] | JSONResponse:
    denied = require_write(request, deps.auth)
    if denied:
        return denied
    try:
        deps.monitor.action(name, *args)
    except SourceError as error:
        status = error.status_code or {
            "REST_UNAUTHORIZED": 401,
            "REST_FORBIDDEN": 403,
            "REST_NOT_FOUND": 404,
            "REST_CONFLICT": 409,
            "REST_TIMEOUT": 504,
            "REST_CONNECTION_REFUSED": 503,
        }.get(error.code, 502)
        deps.audit.record(
            f"live.{name}",
            result="failed",
            detail={"errorCode": error.code, "error": str(error), "arguments": list(args[:1])},
            peer_ip=peer_ip(request),
        )
        return error_response(status, error.code, str(error))
    deps.audit.record(
        f"live.{name}", detail={"arguments": list(args[:1])}, peer_ip=peer_ip(request)
    )
    return {
        "message": "管理操作已发送。",
        "source": "rest",
        "observedAt": int(time.time()),
        "stale": False,
        "errorCode": None,
    }


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/live/{kind}", tags=["live"], response_model=None)
    def live_data(kind: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if kind not in {"info", "players", "metrics", "settings"}:
            return error_response(404, "LIVE_DATA_NOT_FOUND", "实时数据类型不存在。")
        return cast(dict[str, object], deps.monitor.snapshot()[kind])

    @api.post("/api/live/announce", tags=["live"], response_model=None)
    def live_announce(
        request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(deps, request, "announce", payload.message)

    @api.post("/api/live/players/{player_id}/kick", tags=["live"], response_model=None)
    def live_kick(
        player_id: str, request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(deps, request, "kick", player_id, payload.message)

    @api.post("/api/live/players/{player_id}/ban", tags=["live"], response_model=None)
    def live_ban(
        player_id: str, request: Request, payload: LiveActionRequest
    ) -> dict[str, object] | JSONResponse:
        return _live_action(deps, request, "ban", player_id, payload.message)

    @api.post("/api/live/players/{player_id}/unban", tags=["live"], response_model=None)
    def live_unban(player_id: str, request: Request) -> dict[str, object] | JSONResponse:
        return _live_action(deps, request, "unban", player_id)

    @api.get("/api/events", tags=["live"], response_model=None)
    def events(request: Request) -> StreamingResponse | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return StreamingResponse(
            deps.monitor.stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    return api
