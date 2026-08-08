from __future__ import annotations

import time
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from palserver_console.audit import AuditService
from palserver_console.config import AppSettings, configure_logging
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


def test_audit_background_reports_error_and_recovers_with_backoff(tmp_path: Path) -> None:
    service, _, executable = _service(tmp_path)
    calls = 0

    def flaky_maintenance() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("injected audit failure")

    service = AuditService(
        service.database,
        lambda: executable,
        poll_seconds=0.01,
        retry_base_seconds=0.01,
        retry_max_seconds=0.05,
        maintenance_callback=flaky_maintenance,
    )
    service.start()
    try:
        deadline = time.monotonic() + 2
        status = service.status()
        while status["lastSuccessAt"] is None and time.monotonic() < deadline:
            time.sleep(0.01)
            status = service.status()
        assert calls >= 2
        assert status["alive"] is True
        assert status["lastSuccessAt"] is not None
        assert status["consecutiveFailures"] == 0
        last_error = cast(dict[str, object], status["lastError"])
        assert last_error["code"] == "AUDIT_LOOP_ERROR"
        assert status["retryDelaySeconds"] == 0.0
    finally:
        service.stop()


def test_rolling_log_is_bounded_and_redacts_credentials(tmp_path: Path) -> None:
    logger = configure_logging(tmp_path / "data", max_bytes=180, backup_count=1)
    secret = "never-print-this-password"
    for _ in range(8):
        logger.info("auth login rejected password=%s", secret)
    for handler in logger.handlers:
        handler.flush()

    log_directory = tmp_path / "data" / "logs"
    log_files = sorted(log_directory.glob("palserver-console.log*"))
    contents = "".join(path.read_text(encoding="utf-8") for path in log_files)
    assert (log_directory / "palserver-console.log.1").is_file()
    assert not (log_directory / "palserver-console.log.2").exists()
    assert secret not in contents
    assert "password=[REDACTED]" in contents


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
