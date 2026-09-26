from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...application_updates import ApplicationUpdateError
from ...dependencies import AppDependencies
from ...maintenance import NotificationError
from ..schemas import (
    ApplicationUpdateRequest,
    MessageResponse,
    NotificationSettingsRequest,
    NotificationStatusResponse,
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

    @api.post(
        "/api/maintenance/notifications/test", response_model=MessageResponse, tags=["maintenance"]
    )
    def test_notification(request: Request) -> MessageResponse | JSONResponse:
        denied = require_local_write(request, deps.auth)
        if denied:
            return denied
        try:
            deps.notifications.test()
        except NotificationError as error:
            return error_response(
                502 if error.code == "NOTIFICATION_TEST_FAILED" else 422, error.code, str(error)
            )
        return MessageResponse(message="测试告警消息已发送。")

    @api.get("/api/maintenance/application-update", response_model=None, tags=["maintenance"])
    def application_update_status(
        request: Request,
        force: bool = False,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.application_updates.check(force=force)
        except ApplicationUpdateError as error:
            return {"state": "unavailable", "errorCode": error.code, "message": str(error)}

    @api.get(
        "/api/maintenance/application-update/progress",
        response_model=None,
        tags=["maintenance"],
    )
    def application_update_progress(
        request: Request,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.application_updates.progress()

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
            status = (
                409
                if error.code
                in {
                    "PORTABLE_REQUIRED",
                    "RELEASE_CHANGED",
                    "RELEASE_ASSET_MISSING",
                    "APPLICATION_UPDATE_IN_PROGRESS",
                    "APPLICATION_UPDATE_INSTANCES_RUNNING",
                }
                else 502
            )
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
