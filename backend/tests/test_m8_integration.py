from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.main import create_app
from palserver_console.persistence import Database


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


def test_startup_recovery_is_recorded_as_an_operation_transition(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    database = Database(settings.database_path)
    database.migrate()
    operation = database.create_operation("restart-recovery", "restart", "restart-recovery-key")
    database.update_operation(str(operation["id"]), "running", "restarting")

    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ):
        recovered = database.operation("restart-recovery")
        events, _ = database.list_audit_events(event_type="server.operation.transition")

    assert recovered is not None
    assert recovered["state"] == "failed"
    assert recovered["stage"] == "interrupted"
    matching = [
        json.loads(str(event["detail_json"]))
        for event in events
        if json.loads(str(event["detail_json"])).get("operationId") == "restart-recovery"
    ]
    assert matching
    assert matching[-1]["state"] == "failed"
    assert matching[-1]["stage"] == "interrupted"


def test_audit_response_carries_freshness_metadata(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/api/audit")

    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert payload["source"] == "audit-db"
    assert payload["stale"] is False
    assert isinstance(payload["observedAt"], int)


def test_server_settings_requires_explicit_world_selection(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    root = executable.parent / "Pal" / "Saved" / "SaveGames" / "0"
    for world_id in ("world-a", "world-b"):
        world = root / world_id
        (world / "Players").mkdir(parents=True)
        (world / "Level.sav").write_bytes(b"level")
        (world / "LevelMeta.sav").write_bytes(b"meta")
    database = Database(settings.database_path)
    database.migrate()
    database.set_setting("server.executable", str(executable))

    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        auth = client.get("/api/auth/status").json()
        headers = {"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]}
        current = client.get("/api/server/settings")
        missing_selection = client.put(
            "/api/server/settings",
            headers=headers,
            json={"executablePath": str(executable), "launchArguments": ""},
        )
        selected = client.put(
            "/api/server/settings",
            headers=headers,
            json={
                "executablePath": str(executable),
                "launchArguments": "",
                "worldId": "world-b",
            },
        )
        saved = client.get("/api/server/settings")

    assert current.status_code == 200
    assert [item["worldId"] for item in current.json()["worldCandidates"]] == [
        "world-a",
        "world-b",
    ]
    assert missing_selection.status_code == 409
    assert missing_selection.json()["errorCode"] == "WORLD_SELECTION_REQUIRED"
    assert selected.status_code == 200
    assert saved.json()["worldId"] == "world-b"
