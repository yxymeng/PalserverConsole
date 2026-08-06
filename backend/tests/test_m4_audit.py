from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from palserver_console.audit import AuditService
from palserver_console.config import AppSettings
from palserver_console.main import create_app
from palserver_console.persistence import Database


def _service(tmp_path: Path) -> tuple[AuditService, Database, Path]:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    return AuditService(database, lambda: executable), database, executable


def test_player_diff_deduplicates_and_keeps_full_ip(tmp_path: Path) -> None:
    service, database, _ = _service(tmp_path)
    player = {"userId": "player-1", "name": "测试玩家", "ip": "203.0.113.9"}

    service.observe_players([player], "rest")
    service.observe_players([player], "rest")
    service.observe_players([], "rest")

    rows, total = database.list_audit_events(page_size=50)
    assert total == 1
    assert rows[0]["event_type"] == "player.left"
    assert "203.0.113.9" in str(rows[0]["detail_json"])
    assert service.record("live.announce", dedup_key="request-1") is not None
    assert service.record("live.announce", dedup_key="request-1") is None
    service.record("server.operation", result="failed", detail={"error": "password=secret-value"})
    rows, _ = database.list_audit_events(page_size=50)
    assert "secret-value" not in str(rows)
    assert "[REDACTED]" in str(rows)


def test_log_cursor_handles_repeat_and_truncation_without_fake_chat(tmp_path: Path) -> None:
    service, database, executable = _service(tmp_path)
    log_path = executable.parent / "Pal" / "Saved" / "Logs" / "PalServer.log"
    log_path.parent.mkdir(parents=True)
    log_path.write_text("ordinary diagnostic\n[Chat] Alice: hello\n", encoding="utf-8")

    assert service.ingest_logs_once() == 1
    assert service.ingest_logs_once() == 0
    assert service.capabilities()["chatSupported"] is True
    assert service.capabilities()["commandSupported"] is False

    log_path.write_text("[Command] SaveWorld\n", encoding="utf-8")
    assert service.ingest_logs_once() == 1
    rows, total = database.list_audit_events(page_size=50)
    assert total == 2
    assert {row["event_type"] for row in rows} == {"chat.message", "command.executed"}


def test_audit_api_filters_exports_and_retention(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    app = create_app(settings)
    with TestClient(
        app,
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        database = app.state.database
        database.record_audit_event(
            "live.ban", "failed", '{"error":"HTTP 500: upstream failed"}', "203.0.113.9"
        )
        database.record_audit_event("player.joined", "success", '{"playerId":"player-1"}')

        response = client.get("/api/audit?eventType=live.ban&page=1&pageSize=25")
        assert response.status_code == 200
        assert response.json()["total"] == 1
        assert response.json()["items"][0]["detail"]["error"] == "HTTP 500: upstream failed"

        exported = client.get("/api/audit/export?format=csv&eventType=live.ban")
        assert exported.status_code == 200
        assert "live.ban" in exported.text

        auth = client.get("/api/auth/status").json()
        saved = client.put(
            "/api/audit/settings",
            headers={"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]},
            json={"retentionDays": 0},
        )
        assert saved.status_code == 200
        assert saved.json()["retentionDays"] == 0
