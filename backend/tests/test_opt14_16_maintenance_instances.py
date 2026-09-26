from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from palserver_console.config import (
    AppSettings,
    ProfileError,
    ServerProfileService,
    default_settings,
)
from palserver_console.control import create_control_lock
from palserver_console.instances import InstanceTargetRegistry
from palserver_console.lifecycle import LifecycleManager
from palserver_console.main import create_app
from palserver_console.maintenance import NotificationError, NotificationService
from palserver_console.persistence import Database


class FakeHandle:
    pid = 901

    def poll(self) -> int | None:
        return None


class FakeProcessController:
    def __init__(self) -> None:
        self.running = True
        self.started: list[tuple[Path, tuple[str, ...]]] = []

    def matching_pids(self, executable: Path) -> list[int]:
        return [701] if self.running else []

    def start(self, executable: Path, arguments: tuple[str, ...]) -> FakeHandle:
        self.started.append((executable, arguments))
        self.running = True
        return FakeHandle()

    def wait_for_exit(self, pids: list[int], timeout: float) -> bool:
        self.running = False
        return True

    def force_stop(self, pids: list[int]) -> None:
        self.running = False


class FakeRestController:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def announce(self, message: str) -> None:
        self.calls.append("announce")

    def save(self) -> None:
        self.calls.append("save")

    def shutdown(self, wait_seconds: int, message: str) -> None:
        self.calls.append("shutdown")


def _wait_for_terminal(database: Database, operation_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        operation = database.operation(operation_id)
        assert operation is not None
        if operation["state"] not in {"queued", "running"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not reach a terminal state")


def _configured_database(tmp_path: Path) -> tuple[Database, Path]:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    install = tmp_path / "PalServer"
    executable = install / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"test")
    ini = install / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    ini.parent.mkdir(parents=True)
    ini.write_text(
        'OptionSettings=(RESTAPIEnabled=True,RESTAPIPort=8212,AdminPassword="test-only-secret")',
        encoding="utf-8",
    )
    database.set_setting("server.executable", str(executable))
    return database, executable.resolve()


def _world(executable: Path, world_id: str) -> None:
    world = executable.parent / "Pal" / "Saved" / "SaveGames" / "0" / world_id
    world.mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")


def test_instance_settings_keep_namespace_port_and_lock_separate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_root = tmp_path / "console-data"
    monkeypatch.setenv("PALSERVER_CONSOLE_DATA", str(data_root))
    monkeypatch.setenv("PALSERVER_CONSOLE_INSTANCE", "north")
    monkeypatch.setenv("PALSERVER_CONSOLE_PORT", "18224")
    north = default_settings()

    monkeypatch.setenv("PALSERVER_CONSOLE_INSTANCE", "south")
    monkeypatch.setenv("PALSERVER_CONSOLE_PORT", "18225")
    south = default_settings()

    assert north.instance_id == "north"
    assert north.data_dir == data_root / "instances" / "north"
    assert north.instance_root == data_root
    assert north.port == 18224
    assert south.data_dir == data_root / "instances" / "south"
    assert south.port == 18225
    assert north.operation_lock_path != south.operation_lock_path


def test_instance_profile_registry_rejects_cross_instance_write_target(tmp_path: Path) -> None:
    root = tmp_path / "console-data"
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"test")
    _world(executable, "world-a")
    _world(executable, "world-b")
    registry = InstanceTargetRegistry(root)

    north_database = Database(root / "instances" / "north" / "app.db")
    south_database = Database(root / "instances" / "south" / "app.db")
    north_database.migrate()
    south_database.migrate()
    north = ServerProfileService(north_database, instance_id="north", target_registry=registry)
    south = ServerProfileService(south_database, instance_id="south", target_registry=registry)

    north.bind(executable, "world-a")
    north_database.set_setting("server.executable", str(executable.resolve()))
    with pytest.raises(ProfileError) as error:
        south.bind(executable, "world-b")

    assert error.value.code == "INSTANCE_TARGET_CONFLICT"
    assert north.profile().world_id == "world-a"
    assert south_database.get_server_profile() is None


def test_instance_profile_registry_rejects_game_or_query_port_conflicts(tmp_path: Path) -> None:
    root = tmp_path / "console-data"
    north_executable = tmp_path / "north" / "PalServer.exe"
    south_executable = tmp_path / "south" / "PalServer.exe"
    for executable, world_id in ((north_executable, "world-a"), (south_executable, "world-b")):
        executable.parent.mkdir(parents=True)
        executable.write_bytes(b"test")
        _world(executable, world_id)

    registry = InstanceTargetRegistry(root)
    north_database = Database(root / "instances" / "north" / "app.db")
    south_database = Database(root / "instances" / "south" / "app.db")
    north_database.migrate()
    south_database.migrate()
    north = ServerProfileService(north_database, instance_id="north", target_registry=registry)
    south = ServerProfileService(south_database, instance_id="south", target_registry=registry)

    north.bind(north_executable, "world-a", "-port=8211 -queryport=27015")
    with pytest.raises(ProfileError) as error:
        south.bind(south_executable, "world-b", "-Port 8211 -QueryPort 27016")

    assert error.value.code == "INSTANCE_PORT_CONFLICT"
    south.bind(south_executable, "world-b", "-Port=8212 -QueryPort=27016")


def test_invalid_instance_registry_fails_closed_without_writing_profile(tmp_path: Path) -> None:
    root = tmp_path / "console-data"
    registry_path = root / "instances" / "targets.json"
    registry_path.parent.mkdir(parents=True)
    registry_path.write_text("{", encoding="utf-8")
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"test")
    _world(executable, "world-a")
    database = Database(root / "instances" / "north" / "app.db")
    database.migrate()
    profiles = ServerProfileService(
        database,
        instance_id="north",
        target_registry=InstanceTargetRegistry(root),
    )

    with pytest.raises(ProfileError) as error:
        profiles.bind(executable, "world-a")

    assert error.value.code == "INSTANCE_REGISTRY_INVALID"
    assert database.get_server_profile() is None


def test_named_instance_requires_an_explicit_console_port(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PALSERVER_CONSOLE_DATA", str(tmp_path / "console-data"))
    monkeypatch.setenv("PALSERVER_CONSOLE_INSTANCE", "north")
    monkeypatch.delenv("PALSERVER_CONSOLE_PORT", raising=False)

    with pytest.raises(ValueError, match="PALSERVER_CONSOLE_PORT is required"):
        default_settings()


def test_instance_operation_lock_serializes_another_process(tmp_path: Path) -> None:
    lock_path = tmp_path / "data" / "instances" / "north" / "operation.lock"
    acquired_marker = tmp_path / "child-acquired.txt"
    child_code = """
from pathlib import Path
import sys
from palserver_console.control import create_control_lock

with create_control_lock(Path(sys.argv[1])):
    Path(sys.argv[2]).write_text("acquired", encoding="utf-8")
"""

    with create_control_lock(lock_path):
        child = subprocess.Popen(
            [sys.executable, "-c", child_code, str(lock_path), str(acquired_marker)]
        )
        time.sleep(0.2)
        assert not acquired_marker.exists()
    assert child.wait(timeout=5) == 0
    assert acquired_marker.read_text(encoding="utf-8") == "acquired"


def test_notification_status_and_delivery_do_not_expose_secret(tmp_path: Path) -> None:
    database = Database(tmp_path / "data" / "app.db")
    database.migrate()
    deliveries: list[tuple[str, dict[str, object], dict[str, str]]] = []
    service = NotificationService(
        database,
        "north",
        sender=lambda url, payload, headers: deliveries.append((url, payload, headers)),
    )

    service.configure(
        enabled=True,
        webhook_url="https://notify.example.test/maintenance",
        secret="test-only-webhook-secret",
    )
    status = service.status()
    assert status == {"enabled": True, "configured": True}
    assert "test-only-webhook-secret" not in json.dumps(status)

    assert service.send("maintenance.scheduled", "维护通知", "服务器将在 30 秒后维护") is True
    assert deliveries[0][0] == "https://notify.example.test/maintenance"
    assert deliveries[0][1]["instanceId"] == "north"
    assert "test-only-webhook-secret" not in json.dumps(deliveries[0][1])
    assert deliveries[0][2]["X-PalServerConsole-Signature"] != "test-only-webhook-secret"


def test_notification_api_never_returns_secret(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        auth = client.get("/api/auth/status").json()
        headers = {
            "Origin": "http://127.0.0.1:8223",
            "X-CSRF-Token": auth["csrfToken"],
        }
        saved = client.put(
            "/api/maintenance/notifications",
            headers=headers,
            json={
                "enabled": True,
                "webhookUrl": "https://notify.example.test/maintenance",
                "secret": "test-only-webhook-secret",
            },
        )
        current = client.get("/api/maintenance/notifications")
        rejected_update = client.post(
            "/api/maintenance/steamcmd-update",
            headers={**headers, "Idempotency-Key": "invalid-steamcmd"},
            json={
                "steamCmdPath": str(tmp_path / "missing" / "steamcmd.exe"),
                "confirmation": "UPDATE",
            },
        )

    assert saved.status_code == 200
    assert current.status_code == 200
    assert saved.json() == {"enabled": True, "configured": True}
    assert "test-only-webhook-secret" not in json.dumps(current.json())
    assert rejected_update.status_code == 404


def test_test_notification_uses_saved_signature_even_when_disabled(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.migrate()
    deliveries: list[tuple[str, dict[str, object], dict[str, str]]] = []
    service = NotificationService(database, "north", sender=lambda *args: deliveries.append(args))
    with pytest.raises(NotificationError, match="Save an HTTPS"):
        service.test()
    service.configure(
        enabled=False, webhook_url="https://example.test/webhook", secret="test-secret"
    )
    assert not service.send("maintenance.started", "开始", "测试")
    service.test()
    url, payload, headers = deliveries[0]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    expected = hmac.new(b"test-secret", encoded, hashlib.sha256).hexdigest()
    assert url == "https://example.test/webhook"
    assert payload["event"] == "maintenance.test"
    assert headers["X-PalServerConsole-Signature"] == f"sha256={expected}"
    assert "test-secret" not in json.dumps(payload)


def test_notification_test_failure_does_not_expose_transport_details(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.migrate()

    def fail(*args: object) -> None:
        raise RuntimeError("private-url-and-secret")

    audit: list[dict[str, object]] = []
    service = NotificationService(
        database, "north", sender=fail, audit_callback=lambda _, __, detail: audit.append(detail)
    )
    service.configure(
        enabled=True, webhook_url="https://example.test/webhook", secret="test-secret"
    )
    assert not service.send("maintenance.failed", "失败", "测试")
    with pytest.raises(NotificationError) as error:
        service.test()
    assert error.value.code == "NOTIFICATION_TEST_FAILED"
    assert "private-url-and-secret" not in str(error.value)
    assert all(item["errorCode"] == "RuntimeError" for item in audit)


def test_lifecycle_pushes_actual_stages_without_blocking_server_control(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    rest = FakeRestController()
    release = threading.Event()
    entered = threading.Event()
    delivered = threading.Event()
    events: list[str] = []

    def sender(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
        entered.set()
        release.wait(3)
        events.append(str(payload["event"]))
        if len(events) == 3:
            delivered.set()

    service = NotificationService(database, "north", sender=sender)
    service.configure(
        enabled=True, webhook_url="https://example.test/webhook", secret="test-secret"
    )
    lifecycle = LifecycleManager(
        database,
        process=FakeProcessController(),
        rest_factory=lambda _: rest,
        audit_callback=lambda event, _, detail: service.on_operation_transition(detail)
        if event == "server.operation.transition"
        else None,
    )
    try:
        created = lifecycle.begin("stop", "stop-with-notification", countdown_seconds=0)
        result = _wait_for_terminal(database, str(created["id"]))
        assert entered.wait(1)
        assert result["state"] == "succeeded"
        assert rest.calls == ["save", "shutdown"]
    finally:
        release.set()
    assert delivered.wait(3)
    assert events == [
        "maintenance.scheduled",
        "maintenance.started",
        "maintenance.completed",
    ]


def test_notification_queue_keeps_cancel_after_slow_failed_schedule(tmp_path: Path) -> None:
    database = Database(tmp_path / "app.db")
    database.migrate()
    entered, release, cancelled = threading.Event(), threading.Event(), threading.Event()
    events: list[str] = []
    timestamps: list[object] = []
    clock = [10.0]

    def sender(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
        event = str(payload["event"])
        timestamps.append(payload["occurredAt"])
        if event == "maintenance.scheduled":
            entered.set()
            assert release.wait(3)
            events.append(event)
            raise RuntimeError("synthetic delivery failure")
        events.append(event)
        cancelled.set()

    service = NotificationService(database, "north", sender=sender, now=lambda: clock[0])
    service.configure(enabled=True, webhook_url="https://example.test/webhook", secret="test")
    service.on_operation_transition({"kind": "stop", "state": "running", "stage": "countdown"})
    try:
        assert entered.wait(2)
        clock[0] = 11.0
        service.on_operation_transition({"kind": "stop", "state": "cancelled"})
        assert not cancelled.wait(0.1)
    finally:
        clock[0] = 99.0
        release.set()
    assert cancelled.wait(3)
    assert events == ["maintenance.scheduled", "maintenance.cancelled"]
    assert timestamps == [10, 11]


def test_notification_lookup_error_cannot_fail_server_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    app.state.database.migrate()
    app.state.database.create_operation("synthetic-start", "start", "synthetic-start")

    def fail(*args: object) -> None:
        raise RuntimeError("synthetic-private-detail")

    monkeypatch.setattr(app.state.notifications, "status", fail)
    operation = app.state.lifecycle._transition("synthetic-start", "running", "starting")
    assert operation["state"] == "running"
    with TestClient(app):
        assert app.state.database.operation("synthetic-start")["error_code"] == "CONSOLE_RESTARTED"
    log = (tmp_path / "data" / "logs" / "palserver-console.log").read_text(encoding="utf-8")
    assert "notification enqueue failed errorCode=RuntimeError" in log
    assert "synthetic-private-detail" not in log


def test_startup_recovery_pushes_interrupted_operation_failures_once(tmp_path: Path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    database = app.state.database
    database.migrate()
    payloads: list[dict[str, object]] = []
    delivered = threading.Event()

    def sender(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
        payloads.append(payload)
        if len(payloads) == 2:
            delivered.set()

    app.state.notifications.sender = sender
    app.state.notifications.configure(
        enabled=True, webhook_url="https://example.test/webhook", secret="test"
    )
    for kind in ("restart", "stop"):
        database.create_operation(kind, kind, kind)
        database.transition_operation(kind, "running", "countdown")
    with TestClient(app):
        assert delivered.wait(3)
        for kind in ("restart", "stop"):
            operation = database.operation(kind)
            assert operation and operation["state"] == "failed"
            assert operation["error_code"] == "CONSOLE_RESTARTED"
    assert [payload["event"] for payload in payloads] == ["maintenance.failed"] * 2
    assert all("CONSOLE_RESTARTED" in str(payload["message"]) for payload in payloads)
    with TestClient(app):
        assert len(payloads) == 2


@pytest.mark.parametrize(
    ("state", "stage", "expected"),
    [
        ("cancelled", "cancelled", "maintenance.cancelled"),
        ("failed", "failed", "maintenance.failed"),
        ("awaiting_force_confirmation", "shutdown_timeout", "maintenance.failed"),
    ],
)
def test_notification_terminal_events(
    tmp_path: Path, state: str, stage: str, expected: str
) -> None:
    database = Database(tmp_path / "app.db")
    database.migrate()
    delivered = threading.Event()
    payloads: list[dict[str, object]] = []

    def sender(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
        payloads.append(payload)
        delivered.set()

    service = NotificationService(database, "north", sender=sender)
    service.configure(
        enabled=True, webhook_url="https://example.test/webhook", secret="test-secret"
    )
    service.on_operation_transition({"kind": "restart", "state": state, "stage": stage})
    assert delivered.wait(2)
    assert payloads[0]["event"] == expected


def test_notification_test_api_requires_local_csrf_and_reports_failure(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    app = create_app(settings)
    deliveries: list[dict[str, object]] = []
    app.state.notifications.sender = lambda url, payload, headers: deliveries.append(payload)
    with TestClient(app, base_url="http://127.0.0.1:8223", client=("127.0.0.1", 50000)) as client:
        auth = client.get("/api/auth/status").json()
        headers = {"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]}
        assert client.post("/api/maintenance/notifications/test").status_code == 403
        assert (
            client.post("/api/maintenance/notifications/test", headers=headers).status_code == 422
        )
        app.state.notifications.configure(
            enabled=False, webhook_url="https://example.test/webhook", secret="test-secret"
        )
        assert (
            client.post("/api/maintenance/notifications/test", headers=headers).status_code == 200
        )

        def fail(*args: object) -> None:
            raise RuntimeError("private-url-and-secret")

        app.state.notifications.sender = fail
        failed = client.post("/api/maintenance/notifications/test", headers=headers)
        assert failed.status_code == 502
        assert failed.json()["errorCode"] == "NOTIFICATION_TEST_FAILED"
        assert "private-url-and-secret" not in failed.text
        assert len(deliveries) == 1
    with TestClient(
        app, base_url="http://192.168.1.20:8223", client=("192.168.1.21", 50000)
    ) as lan:
        assert lan.post("/api/maintenance/notifications/test").status_code == 403


def test_default_dependencies_wire_lifecycle_notifications(tmp_path: Path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"))
    app.state.database.migrate()
    delivered = threading.Event()
    payloads: list[dict[str, object]] = []

    def sender(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
        payloads.append(payload)
        delivered.set()

    app.state.notifications.sender = sender
    app.state.notifications.configure(
        enabled=True, webhook_url="https://example.test/webhook", secret="test-secret"
    )
    app.state.database.create_operation("synthetic-start", "start", "synthetic-start")
    app.state.lifecycle._transition("synthetic-start", "running", "starting")
    assert delivered.wait(2)
    assert payloads[0]["event"] == "maintenance.started"
