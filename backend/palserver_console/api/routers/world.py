from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...dependencies import AppDependencies
from ...world.service import WorldDataError
from ..schemas import CleanupConfirmationRequest, MessageResponse
from ..security import error_response, peer_ip, require_authenticated_request, require_write

WORLD_STATUS_FILTERS = {
    "players": {"all", "guilded", "unguilded"},
    "pals": {"all", "player", "base", "unassigned"},
    "guilds": {"all", "active", "empty"},
    "bases": {"all", "guilded", "unguilded"},
}
WORLD_SORTS = {
    "players": {"name", "level-desc", "id"},
    "pals": {"name", "level-desc", "id"},
    "guilds": {"name", "count-desc", "id"},
    "bases": {"name", "id"},
}


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/world/snapshots/current", tags=["world"], response_model=None)
    def world_snapshot(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.world.status()

    @api.get("/api/world/storage/cleanup-preview", tags=["world"], response_model=None)
    def world_cleanup_preview(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.world.cleanup_preview()

    @api.post("/api/world/storage/cleanup", tags=["world"], response_model=None)
    def world_cleanup(
        request: Request, payload: CleanupConfirmationRequest
    ) -> dict[str, int] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            result = deps.world.confirm_cleanup(payload.previewToken)
        except WorldDataError as error:
            return error_response(409, error.code, str(error))
        deps.audit.record(
            "world.storage.cleanup",
            result="success",
            detail=result,
            peer_ip=peer_ip(request),
        )
        return result

    @api.get("/api/world/players/{player_id}", tags=["world"], response_model=None)
    def world_player(
        player_id: str, request: Request, snapshotId: str | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.world.get_player(player_id, snapshot_id=snapshotId)
        except WorldDataError as error:
            status = (
                404
                if error.code == "PLAYER_NOT_FOUND"
                else 409
                if error.code == "SNAPSHOT_REPLACED"
                else 503
            )
            return error_response(status, error.code, str(error))

    @api.get("/api/world/pals/roster", tags=["world"], response_model=None)
    def world_pal_roster(
        request: Request,
        page: int = 1,
        pageSize: int = 60,
        search: str | None = None,
        marker: str = "all",
        sort: str = "balanced",
        care: str = "all",
        snapshotId: str | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if page < 1 or pageSize < 1 or pageSize > 60:
            return error_response(422, "INVALID_PAL_ROSTER_PAGE", "帕鲁名册分页参数不正确。")
        if search is not None and len(search) > 100:
            return error_response(422, "INVALID_WORLD_SEARCH", "搜索文字不能超过 100 个字符。")
        if marker not in {"all", "lucky", "boss"}:
            return error_response(422, "INVALID_PAL_ROSTER_MARKER", "帕鲁快捷筛选条件不正确。")
        if sort not in {"balanced", "name", "level"}:
            return error_response(422, "INVALID_PAL_ROSTER_SORT", "帕鲁排序方式不正确。")
        if care not in {"all", "attention"}:
            return error_response(422, "INVALID_PAL_ROSTER_CARE", "帕鲁照护筛选条件不正确。")
        try:
            return deps.world.list_pal_roster(
                page=page,
                page_size=pageSize,
                search=search,
                marker=marker,
                sort=sort,
                care=care,
                snapshot_id=snapshotId,
            )
        except WorldDataError as error:
            response_status = 409 if error.code == "SNAPSHOT_REPLACED" else 503
            return error_response(response_status, error.code, str(error))

    @api.get("/api/world/{resource}/{entity_id}", tags=["world"], response_model=None)
    def world_entity(
        resource: str, entity_id: str, request: Request, snapshotId: str | None = None
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.world.get_entity(resource, entity_id, snapshot_id=snapshotId)
        except WorldDataError as error:
            status = (
                404
                if error.code in {"WORLD_ENTITY_NOT_FOUND", "WORLD_RESOURCE_NOT_FOUND"}
                else 409
                if error.code == "SNAPSHOT_REPLACED"
                else 503
            )
            return error_response(status, error.code, str(error))

    @api.get("/api/world/{resource}", tags=["world"], response_model=None)
    def world_resource(
        resource: str,
        request: Request,
        page: int = 1,
        pageSize: int = 50,
        search: str | None = None,
        ownerId: str | None = None,
        baseId: str | None = None,
        snapshotId: str | None = None,
        status: str = "all",
        sort: str = "name",
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if resource not in {"players", "pals", "guilds", "bases", "inventories", "work-pals"}:
            return error_response(404, "WORLD_RESOURCE_NOT_FOUND", "世界数据类型不存在。")
        if page < 1 or pageSize < 1 or pageSize > 200:
            return error_response(422, "INVALID_WORLD_PAGE", "世界数据分页参数不正确。")
        if search is not None and len(search) > 100:
            return error_response(422, "INVALID_WORLD_SEARCH", "搜索文字不能超过 100 个字符。")
        if resource in WORLD_STATUS_FILTERS and status not in WORLD_STATUS_FILTERS[resource]:
            return error_response(422, "INVALID_WORLD_FILTER", "世界数据筛选条件不正确。")
        if resource in WORLD_SORTS and sort not in WORLD_SORTS[resource]:
            return error_response(422, "INVALID_WORLD_SORT", "世界数据排序条件不正确。")
        try:
            return deps.world.list_resource(
                resource,
                page=page,
                page_size=pageSize,
                search=search,
                owner_id=ownerId,
                base_id=baseId,
                snapshot_id=snapshotId,
                status=status,
                sort=sort,
            )
        except WorldDataError as error:
            response_status = 409 if error.code == "SNAPSHOT_REPLACED" else 503
            return error_response(response_status, error.code, str(error))

    @api.post("/api/world/reparse", tags=["world"], response_model=MessageResponse)
    def world_reparse(request: Request) -> MessageResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        deps.world.request_reparse()
        deps.audit.record(
            "world.reparse",
            result="queued",
            detail={"source": "save-snapshot"},
            peer_ip=peer_ip(request),
        )
        return MessageResponse(message="已请求重新读取存档；文件稳定 5 秒后开始解析。")

    return api
