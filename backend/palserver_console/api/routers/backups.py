from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ...backups import BackupError
from ...dependencies import AppDependencies
from ..schemas import BackupRetentionRequest, MessageResponse
from ..security import error_response, peer_ip, require_authenticated_request, require_write


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/backups", tags=["backups"], response_model=None)
    def backup_list(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.backups.list()
        except BackupError as error:
            return error_response(503, error.code, str(error))

    @api.put("/api/backups/retention", tags=["backups"], response_model=None)
    def backup_retention(
        request: Request, payload: BackupRetentionRequest
    ) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.backups.set_retention(payload.retention)
        except BackupError as error:
            return error_response(409, error.code, str(error))

    @api.delete("/api/backups/{backup_id}", tags=["backups"], response_model=None)
    def backup_delete(backup_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            deps.backups.delete(backup_id)
            return MessageResponse(message="历史备份已删除。")
        except BackupError as error:
            return error_response(409, error.code, str(error))

    @api.post("/api/backups/{backup_id}/restore", tags=["backups"], response_model=None)
    def backup_restore(backup_id: str, request: Request) -> MessageResponse | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            deps.backups.restore(backup_id)
            return MessageResponse(message="备份已恢复。")
        except BackupError as error:
            return error_response(409, error.code, str(error))

    @api.get("/api/backups/restore/recovery", tags=["backups"], response_model=None)
    def backup_restore_recovery(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.backups.recovery_status()

    @api.post("/api/backups/restore/resume", tags=["backups"], response_model=None)
    def backup_restore_resume(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.backups.resume_restore()
        except BackupError as error:
            status = 500 if error.code == "ROLLBACK_FAILED" else 409
            return error_response(status, error.code, str(error))

    @api.post("/api/backups/restore/rollback", tags=["backups"], response_model=None)
    def backup_restore_rollback(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        try:
            return deps.backups.rollback_restore()
        except BackupError as error:
            status = 500 if error.code == "ROLLBACK_FAILED" else 409
            return error_response(status, error.code, str(error))

    @api.post("/api/backups/open-directory", tags=["backups"], response_model=None)
    def backup_open_directory(request: Request) -> dict[str, str] | JSONResponse:
        from ...auth import is_loopback

        if not is_loopback(peer_ip(request)):
            return error_response(403, "LOCAL_ONLY", "打开备份目录只能在服务器本机执行。")
        try:
            return {"path": deps.backups.open_directory()}
        except BackupError as error:
            return error_response(503, error.code, str(error))

    return api
