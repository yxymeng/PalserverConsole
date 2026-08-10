from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...config import ProfileError, WorldCandidate
from ...dependencies import AppDependencies
from ...lifecycle import LifecycleError
from ...steam import discover_palserver, validate_executable
from ..contract import operation_public
from ..schemas import (
    ApiOperationKind,
    DiscoveryCandidateResponse,
    LifecycleRequest,
    MessageResponse,
    ServerSettingsRequest,
    ServerSettingsResponse,
    WorldCandidateResponse,
)
from ..security import (
    error_response,
    peer_ip,
    require_authenticated_request,
    require_local_write,
    require_write,
)


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/server/settings", response_model=ServerSettingsResponse, tags=["server"])
    def server_settings(request: Request) -> ServerSettingsResponse | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        raw_executable = deps.database.get_setting("server.executable")
        candidates: list[WorldCandidate] = []
        binding_error: str | None = None
        profile = None
        if raw_executable:
            try:
                candidates = deps.profiles.candidates(raw_executable)
            except ProfileError as error:
                binding_error = error.code
            try:
                profile = deps.profiles.profile()
            except ProfileError as error:
                binding_error = error.code
        elif deps.database.get_server_profile() is not None:
            binding_error = "WORLD_PROFILE_REQUIRED"
        return ServerSettingsResponse(
            executablePath=raw_executable,
            launchArguments=deps.database.get_setting("server.arguments") or "",
            worldId=profile.world_id if profile else None,
            worldPath=str(profile.world_path) if profile else None,
            worldCandidates=[
                WorldCandidateResponse(
                    worldId=item.world_id,
                    worldPath=str(item.world_path),
                    modifiedAt=int(item.modified_at_ns),
                )
                for item in candidates
            ],
            bindingValid=profile is not None,
            bindingErrorCode=binding_error,
        )

    @api.put("/api/server/settings", response_model=MessageResponse, tags=["server"])
    def set_server_settings(
        request: Request, payload: ServerSettingsRequest
    ) -> MessageResponse | JSONResponse:
        denied = require_local_write(request, deps.auth)
        if denied:
            return denied
        try:
            executable = validate_executable(Path(payload.executablePath))
            candidates = deps.profiles.candidates(executable)
        except (OSError, ValueError, ProfileError) as error:
            code = (
                error.code
                if isinstance(error, ProfileError)
                else (
                    "PATH_REPARSE_POINT"
                    if "reparse point" in str(error).lower()
                    else "INVALID_SERVER_PATH"
                )
            )
            return error_response(422, code, str(error))
        selected_profile = None
        if payload.worldId is not None:
            try:
                selected_profile = deps.profiles.bind(
                    executable, payload.worldId, payload.launchArguments
                )
            except ProfileError as error:
                return error_response(422, error.code, str(error))
        else:
            try:
                existing = deps.profiles.profile()
            except ProfileError:
                existing = None
            if existing is not None and existing.executable_path == executable:
                try:
                    selected_profile = deps.profiles.bind(
                        executable, existing.world_id, payload.launchArguments
                    )
                except ProfileError as error:
                    return error_response(422, error.code, str(error))
            elif candidates:
                return error_response(
                    409,
                    "WORLD_SELECTION_REQUIRED",
                    "Select a World ID before saving server settings.",
                )
            else:
                try:
                    deps.profiles.clear()
                except ProfileError as error:
                    return error_response(422, error.code, str(error))
        deps.database.set_setting("server.executable", str(executable))
        deps.database.set_setting("server.arguments", payload.launchArguments)
        deps.audit.record(
            "config.server_settings",
            detail={
                "executablePath": str(executable),
                "hasLaunchArguments": bool(payload.launchArguments),
                "worldId": selected_profile.world_id if selected_profile else None,
            },
            peer_ip=peer_ip(request),
        )
        return MessageResponse(message="PalServer 路径和启动参数已保存。")

    @api.get(
        "/api/server/discovery",
        response_model=list[DiscoveryCandidateResponse],
        tags=["server"],
    )
    def discover(request: Request) -> list[DiscoveryCandidateResponse] | JSONResponse:
        def candidate_worlds(executable: Path) -> list[WorldCandidateResponse]:
            try:
                worlds = deps.profiles.candidates(executable)
            except ProfileError:
                return []
            return [
                WorldCandidateResponse(
                    worldId=world.world_id,
                    worldPath=str(world.world_path),
                    modifiedAt=int(world.modified_at_ns),
                )
                for world in worlds
            ]

        from ...auth import is_loopback

        if not is_loopback(peer_ip(request)):
            return error_response(403, "LOCAL_ONLY", "Steam 路径发现结果只在服务器本机显示。")
        return [
            DiscoveryCandidateResponse(
                libraryPath=str(item.library_path),
                installPath=str(item.install_path),
                executablePath=str(item.executable_path),
                manifestValid=item.manifest_valid,
                worldCandidates=candidate_worlds(item.executable_path),
            )
            for item in discover_palserver()
        ]

    @api.post("/api/server/operations/{kind}", tags=["server"], response_model=None)
    def begin_operation(
        kind: ApiOperationKind,
        request: Request,
        payload: LifecycleRequest | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            operation = deps.lifecycle.begin(
                kind,
                request.headers.get("Idempotency-Key", ""),
                countdown_seconds=payload.countdownSeconds if payload else 30,
                message=payload.message if payload else LifecycleRequest().message,
            )
            deps.audit.record(
                f"server.{kind}",
                result="queued",
                detail={"operationId": operation.get("id"), "stage": operation.get("stage")},
                peer_ip=peer_ip(request),
            )
            return operation_public(operation)
        except LifecycleError as error:
            return error_response(409, error.code, str(error))

    @api.get("/api/server/operations/{operation_id}", tags=["server"], response_model=None)
    def operation(operation_id: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        result = deps.database.operation(operation_id)
        if result:
            return operation_public(result)
        return error_response(404, "OPERATION_NOT_FOUND", "操作不存在。")

    @api.post(
        "/api/server/operations/{operation_id}/cancel",
        tags=["server"],
        response_model=MessageResponse,
    )
    def cancel_operation(operation_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            operation = deps.database.operation(operation_id)
            if operation and operation.get("kind") == "steamcmd_update":
                deps.updates.cancel(operation_id)
            else:
                deps.lifecycle.cancel(operation_id)
        except LifecycleError as error:
            return error_response(409, error.code, str(error))
        return MessageResponse(message="取消请求已提交。")

    @api.post(
        "/api/server/operations/{operation_id}/force-stop",
        tags=["server"],
        response_model=None,
    )
    def force_stop(operation_id: str, request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            return operation_public(
                deps.lifecycle.confirm_force_stop(
                    operation_id, request.headers.get("Idempotency-Key", "")
                )
            )
        except LifecycleError as error:
            return error_response(409, error.code, str(error))

    return api
