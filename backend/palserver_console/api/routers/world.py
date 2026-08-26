from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...dependencies import AppDependencies
from ...metadata.loader import WORK_SUITABILITY_TYPES
from ...world.service import WorldDataError
from ..schemas import CleanupConfirmationRequest, WorldReparseResponse
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
        minLevel: int | None = None,
        minRank: int | None = None,
        minRarity: int | None = None,
        minHpIv: float | None = None,
        minAttackIv: float | None = None,
        minDefenseIv: float | None = None,
        minAverageIv: float | None = None,
        workSuitability: str | None = None,
        minWorkLevel: int = 1,
        passiveSkill: str | None = None,
        location: str = "all",
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
        if sort not in {"balanced", "name", "level", "rarity", "averageIv", "workSuitability"}:
            return error_response(422, "INVALID_PAL_ROSTER_SORT", "帕鲁排序方式不正确。")
        if care not in {"all", "attention"}:
            return error_response(422, "INVALID_PAL_ROSTER_CARE", "帕鲁照护筛选条件不正确。")
        if location not in {"all", "player", "base", "unassigned"}:
            return error_response(422, "INVALID_PAL_ROSTER_LOCATION", "帕鲁归属筛选条件不正确。")
        minimums = (minLevel, minRank, minRarity, minHpIv, minAttackIv, minDefenseIv, minAverageIv)
        if any(value is not None and value < 0 for value in minimums):
            return error_response(422, "INVALID_PAL_APTITUDE_FILTER", "帕鲁资质最低值不能小于 0。")
        if any(
            value is not None and value > 100
            for value in (minHpIv, minAttackIv, minDefenseIv, minAverageIv)
        ):
            return error_response(422, "INVALID_PAL_APTITUDE_FILTER", "个体值最低值不能大于 100。")
        work_suitabilities = tuple(
            name.strip() for name in (workSuitability or "").split(",") if name.strip()
        )
        if (
            any(name not in WORK_SUITABILITY_TYPES for name in work_suitabilities)
            or minWorkLevel < 1
            or minWorkLevel > 10
        ):
            return error_response(
                422, "INVALID_PAL_WORK_FILTER", "工作适应性或最低工作等级不正确。"
            )
        passive_skills = tuple(
            name.strip() for name in (passiveSkill or "").split(",") if name.strip()
        )
        if len(passive_skills) > 12 or len(set(passive_skills)) != len(passive_skills):
            return error_response(422, "INVALID_PAL_PASSIVE_FILTER", "被动技能筛选条件不正确。")
        try:
            return deps.world.list_pal_roster(
                page=page,
                page_size=pageSize,
                search=search,
                marker=marker,
                sort=sort,
                care=care,
                min_level=minLevel,
                min_rank=minRank,
                min_rarity=minRarity,
                min_hp_iv=minHpIv,
                min_attack_iv=minAttackIv,
                min_defense_iv=minDefenseIv,
                min_average_iv=minAverageIv,
                work_suitabilities=work_suitabilities,
                min_work_level=minWorkLevel,
                passive_skills=passive_skills,
                location=location,
                snapshot_id=snapshotId,
            )
        except WorldDataError as error:
            response_status = 409 if error.code == "SNAPSHOT_REPLACED" else 503
            return error_response(response_status, error.code, str(error))

    @api.get("/api/world/inventory-items", tags=["world"], response_model=None)
    def world_inventory(
        request: Request,
        page: int = 1,
        pageSize: int = 60,
        search: str | None = None,
        category: str | None = None,
        scope: str = "all",
        ownerId: str | None = None,
        baseId: str | None = None,
        guildId: str | None = None,
        sort: str = "name",
        metadata: str = "all",
        snapshotId: str | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if page < 1 or pageSize < 1 or pageSize > 60:
            return error_response(422, "INVALID_INVENTORY_PAGE", "仓库分页参数不正确。")
        if search is not None and len(search) > 100:
            return error_response(422, "INVALID_WORLD_SEARCH", "搜索文字不能超过 100 个字符。")
        if category is not None and len(category) > 100:
            return error_response(422, "INVALID_INVENTORY_CATEGORY", "物品分类筛选条件不正确。")
        if scope not in {"inventory", "all", "player", "base", "world"}:
            return error_response(422, "INVALID_INVENTORY_SCOPE", "仓库范围筛选条件不正确。")
        if sort not in {"name", "quantity"}:
            return error_response(422, "INVALID_INVENTORY_SORT", "仓库排序方式不正确。")
        if metadata not in {"all", "unknown"}:
            return error_response(422, "INVALID_INVENTORY_METADATA", "物品资料筛选条件不正确。")
        try:
            return deps.world.list_inventory(
                page=page,
                page_size=pageSize,
                search=search,
                category=category,
                scope=scope,
                owner_id=ownerId,
                base_id=baseId,
                guild_id=guildId,
                sort=sort,
                metadata=metadata,
                snapshot_id=snapshotId,
            )
        except WorldDataError as error:
            response_status = 409 if error.code == "SNAPSHOT_REPLACED" else 503
            return error_response(response_status, error.code, str(error))

    @api.get("/api/world/inventory-items/{item_id}", tags=["world"], response_model=None)
    def world_inventory_item(
        item_id: str,
        request: Request,
        page: int = 1,
        pageSize: int = 100,
        scope: str = "all",
        ownerId: str | None = None,
        baseId: str | None = None,
        guildId: str | None = None,
        locationType: str | None = None,
        groupId: str | None = None,
        snapshotId: str | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if page < 1 or pageSize < 1 or pageSize > 100:
            return error_response(422, "INVALID_INVENTORY_PAGE", "仓库位置分页参数不正确。")
        if scope not in {"inventory", "all", "player", "base", "world"}:
            return error_response(422, "INVALID_INVENTORY_SCOPE", "仓库范围筛选条件不正确。")
        if locationType is not None and locationType not in {
            "player",
            "base",
            "guild",
            "world",
            "unassigned",
        }:
            return error_response(
                422, "INVALID_INVENTORY_LOCATION_TYPE", "仓库存放分组不正确。"
            )
        if (locationType in {"player", "base", "guild"}) != bool(groupId):
            return error_response(
                422, "INVALID_INVENTORY_LOCATION_GROUP", "仓库存放分组 ID 不正确。"
            )
        try:
            return deps.world.get_inventory(
                item_id,
                page=page,
                page_size=pageSize,
                scope=scope,
                owner_id=ownerId,
                base_id=baseId,
                guild_id=guildId,
                location_type=locationType,
                group_id=groupId,
                snapshot_id=snapshotId,
            )
        except WorldDataError as error:
            response_status = (
                404
                if error.code == "INVENTORY_ITEM_NOT_FOUND"
                else 409
                if error.code == "SNAPSHOT_REPLACED"
                else 503
            )
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

    @api.post("/api/world/reparse", tags=["world"], response_model=WorldReparseResponse)
    def world_reparse(request: Request) -> WorldReparseResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        generation = deps.world.request_reparse()
        deps.audit.record(
            "world.reparse",
            result="queued",
            detail={"source": "save-snapshot"},
            peer_ip=peer_ip(request),
        )
        return WorldReparseResponse(
            message="已请求重新读取存档；文件稳定 5 秒后开始解析。",
            reparseGeneration=generation,
        )

    return api
