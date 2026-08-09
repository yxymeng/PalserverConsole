from __future__ import annotations

import time

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ...audit import DEFAULT_RETENTION_DAYS, export_csv, export_json
from ...dependencies import AppDependencies
from ...errors import freshness
from ..contract import audit_public
from ..schemas import AuditRetentionRequest
from ..security import error_response, peer_ip, require_authenticated_request, require_write


def router(deps: AppDependencies) -> APIRouter:
    api = APIRouter()

    @api.get("/api/audit", tags=["audit"], response_model=None)
    def audit_events(
        request: Request,
        page: int = 1,
        pageSize: int = 50,
        eventType: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if page < 1 or pageSize < 1 or pageSize > 200:
            return error_response(422, "INVALID_AUDIT_PAGE", "审计分页参数不正确。")
        rows, total = deps.database.list_audit_events(
            page, pageSize, eventType, result, source, since, until
        )
        return {
            "items": [audit_public(row) for row in rows],
            "page": page,
            "pageSize": pageSize,
            "total": total,
            **freshness(source="audit-db", observed_at=int(time.time())),
        }

    @api.get("/api/audit/export", tags=["audit"], response_model=None)
    def audit_export(
        request: Request,
        format: str = "json",
        eventType: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> Response | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        if format not in {"json", "csv"}:
            return error_response(422, "INVALID_EXPORT_FORMAT", "只支持 JSON 或 CSV 导出。")
        try:
            rows = deps.database.audit_events_for_export(eventType, result, source, since, until)
            body = export_csv(rows) if format == "csv" else export_json(rows)
        except ValueError:
            return error_response(
                413, "AUDIT_EXPORT_TOO_LARGE", "导出结果超过 200 条，请先筛选或分页。"
            )
        media_type = "text/csv; charset=utf-8" if format == "csv" else "application/json"
        return Response(
            content=body,
            media_type=media_type,
            headers={"Content-Disposition": f'attachment; filename="palserver-audit.{format}"'},
        )

    @api.get("/api/audit/capabilities", tags=["audit"], response_model=None)
    def audit_capabilities(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        return deps.audit.capabilities()

    @api.get("/api/audit/settings", tags=["audit"], response_model=None)
    def audit_settings(request: Request) -> dict[str, object] | JSONResponse:
        denied = require_authenticated_request(request, deps.auth)
        if denied:
            return denied
        raw = deps.database.get_setting("audit.retention_days")
        try:
            days = int(raw) if raw is not None else DEFAULT_RETENTION_DAYS
        except ValueError:
            days = DEFAULT_RETENTION_DAYS
        return {"retentionDays": days}

    @api.put("/api/audit/settings", tags=["audit"], response_model=None)
    def set_audit_settings(
        request: Request, payload: AuditRetentionRequest
    ) -> dict[str, object] | JSONResponse:
        denied = require_write(request, deps.auth)
        if denied:
            return denied
        deps.database.set_setting("audit.retention_days", str(payload.retentionDays))
        removed = deps.audit.prune(payload.retentionDays)
        deps.audit.record(
            "audit.retention",
            detail={"retentionDays": payload.retentionDays, "removed": removed},
            peer_ip=peer_ip(request),
        )
        return {
            "message": "审计保留天数已保存。",
            "retentionDays": payload.retentionDays,
            "removed": removed,
        }

    return api
