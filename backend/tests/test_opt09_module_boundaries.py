from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any, cast

from starlette.routing import Route

from palserver_console.api.contract import LEGACY_OPERATION_ALIASES, operation_public
from palserver_console.config import AppSettings
from palserver_console.main import create_app

EXPECTED_API_CONTRACT = {
    "DELETE /api/backups/{backup_id}",
    "DELETE /api/config/draft",
    "GET /api/audit",
    "GET /api/audit/capabilities",
    "GET /api/audit/export",
    "GET /api/audit/settings",
    "GET /api/auth/status",
    "GET /api/backups",
    "GET /api/backups/restore/recovery",
    "GET /api/bootstrap",
    "GET /api/config/current",
    "GET /api/config/diff",
    "GET /api/config/draft",
    "GET /api/events",
    "GET /api/health",
    "GET /api/live/{kind}",
    "GET /api/maintenance/notifications",
    "GET /api/monitoring/status",
    "GET /api/operations/health",
    "GET /api/server/discovery",
    "GET /api/server/operations/{operation_id}",
    "GET /api/server/settings",
    "GET /api/shell/status",
    "GET /api/world/players/{player_id}",
    "GET /api/world/{resource}/{entity_id}",
    "GET /api/world/snapshots/current",
    "GET /api/world/storage/cleanup-preview",
    "GET /api/world/{resource}",
    "POST /api/auth/login",
    "POST /api/auth/logout",
    "POST /api/backups/open-directory",
    "POST /api/backups/restore/resume",
    "POST /api/backups/restore/rollback",
    "POST /api/backups/{backup_id}/restore",
    "POST /api/config/apply",
    "POST /api/config/apply-with-restart",
    "POST /api/config/open-folder",
    "POST /api/live/announce",
    "POST /api/live/players/{player_id}/ban",
    "POST /api/live/players/{player_id}/kick",
    "POST /api/live/players/{player_id}/unban",
    "POST /api/maintenance/steamcmd-update",
    "POST /api/server/operations/{kind}",
    "POST /api/server/operations/{operation_id}/cancel",
    "POST /api/server/operations/{operation_id}/force-stop",
    "POST /api/world/reparse",
    "POST /api/world/storage/cleanup",
    "PUT /api/backups/retention",
    "PUT /api/audit/settings",
    "PUT /api/config/draft",
    "PUT /api/maintenance/notifications",
    "PUT /api/server/settings",
    "PUT /api/settings/network",
}


def test_api_method_and_path_contract_is_complete(tmp_path: Path) -> None:
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "missing-static")
    )

    api_routes = [
        cast(Route, route) for route in app.routes if getattr(route, "path", "").startswith("/api")
    ]
    actual = {
        f"{method} {route.path}"
        for route in api_routes
        for method in sorted(route.methods or set())
    }

    assert actual == EXPECTED_API_CONTRACT


def test_main_only_assembles_the_application() -> None:
    from palserver_console import main

    source = inspect.getsource(main)

    assert "@app.get(" not in source
    assert "@app.post(" not in source
    assert "@app.put(" not in source
    assert "@app.delete(" not in source
    assert "class HealthResponse" not in source


def test_operation_contract_documents_legacy_aliases_without_frontend_dependency() -> None:
    operation = {
        "id": "operation-1",
        "kind": "start",
        "state": "queued",
        "stage": "queued",
        "error_code": None,
        "detail": None,
        "created_at": 1,
        "updated_at": 2,
        "parent_operation_id": None,
        "target_pids": None,
        "confirmation_expires_at": None,
        "request_fingerprint": "internal-only",
    }

    public = operation_public(operation)

    assert LEGACY_OPERATION_ALIASES == {
        "id": "operationId",
        "error_code": "errorCode",
        "created_at": "createdAt",
        "updated_at": "updatedAt",
        "parent_operation_id": "parentOperationId",
        "target_pids": "targetPids",
        "confirmation_expires_at": "confirmationExpiresAt",
    }
    assert "request_fingerprint" not in public
    assert all(
        public[legacy] == public[canonical]
        for legacy, canonical in LEGACY_OPERATION_ALIASES.items()
    )


def test_dependency_factory_can_be_replaced(tmp_path: Path) -> None:
    from palserver_console.dependencies import AppDependencies, DefaultDependencyFactory

    class TrackingFactory:
        def __init__(self) -> None:
            self.called = False
            self.delegate = DefaultDependencyFactory()

        def create(
            self,
            settings: AppSettings,
            *,
            lifecycle_manager: Any = None,
            monitor: Any = None,
            world_service: Any = None,
        ) -> AppDependencies:
            self.called = True
            return self.delegate.create(
                settings,
                lifecycle_manager=lifecycle_manager,
                monitor=monitor,
                world_service=world_service,
            )

    factory = TrackingFactory()
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "missing-static"),
        dependency_factory=factory,
    )

    assert factory.called is True
    assert app.state.dependencies.database is app.state.database
