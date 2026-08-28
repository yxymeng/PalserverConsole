from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...application_updates import ApplicationUpdateError
from ...dependencies import AppDependencies
from ...lifecycle import LifecycleError
from ...maintenance import NotificationError
from ..contract import operation_public
from ..schemas import (
    ApplicationUpdateRequest,
    NotificationSettingsRequest,
    NotificationStatusResponse,
    SteamCmdUpdateRequest,
)
from ..security import error_response, peer_ip, require_authenticated_request, require_local_write


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get(
        "/api/maintenance/notifications",
        response_model=NotificationStatusResponse,
        tags=["maintenance"],
    )
    def notification_status(request: Request) -> NotificationStatusResponse | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return NotificationStatusResponse(**deps.notifications.status())

    @api.put(
        "/api/maintenance/notifications",
        response_model=NotificationStatusResponse,
        tags=["maintenance"],
    )
    def save_notification_settings(
        request: Request, payload: NotificationSettingsRequest
    ) -> NotificationStatusResponse | JSONResponse:
        denied = require_local_write(request, deps.auth)
        if denied:
            return denied
        try:
            status = deps.notifications.configure(
                enabled=payload.enabled,
                webhook_url=payload.webhookUrl,
                secret=payload.secret,
            )
        except NotificationError as error:
            return error_response(422, error.code, str(error))
        deps.audit.record(
            "maintenance.notification_config",
            detail={"enabled": status["enabled"], "configured": status["configured"]},
            peer_ip=peer_ip(request),
        )
        return NotificationStatusResponse(**status)

    @api.post("/api/maintenance/steamcmd-update", response_model=None, tags=["maintenance"])
    def steamcmd_update(
        request: Request, payload: SteamCmdUpdateRequest
    ) -> dict[str, object] | JSONResponse:
        denied = require_local_write(request, deps.auth)
        if denied:
            return denied
        try:
            operation = deps.updates.begin(
                payload.steamCmdPath,
                request.headers.get("Idempotency-Key", ""),
                confirmation=payload.confirmation,
                countdown_seconds=payload.countdownSeconds,
                message=payload.message,
            )
        except LifecycleError as error:
            return error_response(409, error.code, str(error))
        deps.audit.record(
            "server.steamcmd_update",
            result="queued",
            detail={"operationId": operation.get("id"), "stage": operation.get("stage")},
            peer_ip=peer_ip(request),
        )
        return operation_public(operation)

    @api.get("/api/maintenance/application-update", response_model=None, tags=["maintenance"])
    def application_update_status(
        request: Request,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.application_updates.check()
        except ApplicationUpdateError as error:
            return error_response(502, error.code, str(error))

    @api.post("/api/maintenance/application-update", response_model=None, tags=["maintenance"])
    def install_application_update(
        request: Request, payload: ApplicationUpdateRequest
    ) -> dict[str, object] | JSONResponse:
        denied = require_local_write(request, deps.auth)
        if denied:
            return denied
        try:
            result = deps.application_updates.prepare(payload.expectedVersion)
        except ApplicationUpdateError as error:
            status = 409 if error.code in {
                "PORTABLE_REQUIRED",
                "RELEASE_CHANGED",
                "RELEASE_ASSET_MISSING",
                "APPLICATION_UPDATE_IN_PROGRESS",
            } else 502
            return error_response(status, error.code, str(error))
        deps.audit.record(
            "console.application_update",
            result="scheduled",
            detail={"version": result["version"]},
            peer_ip=peer_ip(request),
        )
        deps.application_updates.schedule_shutdown()
        return result

    return api
