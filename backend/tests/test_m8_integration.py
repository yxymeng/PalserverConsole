from __future__ import annotations

from pathlib import Path
from typing import Any, cast

from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.main import create_app


def _client(tmp_path: Path) -> TestClient:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    return TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    )


def test_bootstrap_exposes_cross_module_freshness(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/api/bootstrap")

    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert set(payload) == {"shell", "live", "world", "version"}
    for name in ("shell", "world"):
        value = cast(dict[str, object], payload[name])
        assert isinstance(value["observedAt"], int)
        assert isinstance(value["stale"], bool)
        assert "errorCode" in value
    live = cast(dict[str, dict[str, object]], payload["live"])
    assert set(live) == {"info", "players", "metrics", "settings"}
    assert all("observedAt" in value and "stale" in value for value in live.values())


def test_operation_and_error_contracts_are_stable(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        app = cast(Any, client).app
        operation = app.state.database.create_operation("m8-operation", "save", "m8-key")
        operation_response = client.get(f"/api/server/operations/{operation['id']}")
        missing_response = client.get("/api/server/operations/missing")

    assert operation_response.status_code == 200
    public = cast(dict[str, object], operation_response.json())
    assert public["operationId"] == "m8-operation"
    assert public["errorCode"] is None
    assert public["updatedAt"] == public["updated_at"]

    assert missing_response.status_code == 404
    error = cast(dict[str, object], missing_response.json())
    assert error == {
        "errorCode": "OPERATION_NOT_FOUND",
        "message": "操作不存在。",
        "retryable": False,
    }


def test_audit_response_carries_freshness_metadata(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/api/audit")

    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert payload["source"] == "audit-db"
    assert payload["stale"] is False
    assert isinstance(payload["observedAt"], int)
