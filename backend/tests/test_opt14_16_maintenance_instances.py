from __future__ import annotations

import json
import subprocess
import sys
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
from palserver_console.lifecycle import LifecycleError, LifecycleManager
from palserver_console.main import create_app
from palserver_console.maintenance import NotificationService, SteamCmdUpdateService
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


class FakeMonitor:
    def __init__(self, players: list[object]) -> None:
        self.players = players
        self.calls = 0

    def collect_once(self) -> dict[str, object]:
        self.calls += 1
        return {
            "players": {
                "data": list(self.players),
                "stale": False,
                "errorCode": None,
            }
        }


class RecordingNotifications:
    def __init__(self) -> None:
        self.events: list[str] = []

    def send(self, event: str, title: str, message: str) -> bool:
        self.events.append(event)
        return True


class RecordingSteamCmdRunner:
    def __init__(self, error: LifecycleError | None = None) -> None:
        self.calls: list[tuple[Path, Path]] = []
        self.error = error

    def __call__(self, steamcmd: Path, install_path: Path) -> None:
        self.calls.append((steamcmd, install_path))
        if self.error is not None:
            raise self.error


def _wait_for_terminal(database: Database, operation_id: str) -> dict[str, object]:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        operation = database.operation(operation_id)
        assert operation is not None
        if operation["state"] not in {"queued", "running"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not reach a terminal state")


def _configured_database(tmp_path: Path) -> tuple[Database, Path, Path]:
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
    steamcmd = tmp_path / "SteamCMD" / "steamcmd.exe"
    steamcmd.parent.mkdir()
    steamcmd.write_bytes(b"test")
    database.set_setting("server.executable", str(executable))
    return database, executable.resolve(), steamcmd.resolve()


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
    assert rejected_update.status_code == 409
    assert rejected_update.json()["errorCode"] == "INVALID_STEAMCMD_PATH"


def test_steamcmd_update_runs_safe_sequence_and_starts_after_validation(tmp_path: Path) -> None:
    database, executable, steamcmd = _configured_database(tmp_path)
    process = FakeProcessController()
    rest = FakeRestController()
    monitor = FakeMonitor(players=[])
    notifications = RecordingNotifications()
    runner = RecordingSteamCmdRunner()
    lifecycle = LifecycleManager(database, process=process, rest_factory=lambda _: rest)
    service = SteamCmdUpdateService(
        database,
        lifecycle,
        monitor,
        notifications,
        runner=runner,
        instance_id="north",
        health_check=lambda: True,
    )

    created = service.begin(
        steamcmd,
        "update-once",
        confirmation="UPDATE",
        countdown_seconds=0,
        message="维护更新",
    )
    result = _wait_for_terminal(database, str(created["id"]))

    assert result["state"] == "succeeded"
    assert result["stage"] == "updated"
    assert rest.calls == ["announce", "save", "shutdown"]
    assert runner.calls == [(steamcmd, executable.parent)]
    assert process.started == [(executable, ())]
    assert monitor.calls >= 2
    assert notifications.events == [
        "maintenance.scheduled",
        "maintenance.started",
        "maintenance.completed",
    ]


def test_steamcmd_update_fails_closed_when_players_are_online(tmp_path: Path) -> None:
    database, _, steamcmd = _configured_database(tmp_path)
    process = FakeProcessController()
    rest = FakeRestController()
    runner = RecordingSteamCmdRunner()
    lifecycle = LifecycleManager(database, process=process, rest_factory=lambda _: rest)
    service = SteamCmdUpdateService(
        database,
        lifecycle,
        FakeMonitor(players=[{"name": "player"}]),
        RecordingNotifications(),
        runner=runner,
        instance_id="north",
        health_check=lambda: True,
    )

    created = service.begin(steamcmd, "players-online", confirmation="UPDATE", countdown_seconds=0)
    result = _wait_for_terminal(database, str(created["id"]))

    assert result["state"] == "failed"
    assert result["error_code"] == "PLAYERS_ONLINE"
    assert rest.calls == []
    assert runner.calls == []
    assert process.running is True


def test_steamcmd_update_is_blocked_by_unfinished_restore(tmp_path: Path) -> None:
    database, _, steamcmd = _configured_database(tmp_path)
    database.begin_restore_journal(
        "restore-journal",
        "world-a",
        "C:/fixture/world-a",
        "backup-a",
        "C:/fixture/source",
        "C:/fixture/safety",
        "C:/fixture/staging",
        "prepared",
    )
    runner = RecordingSteamCmdRunner()
    lifecycle = LifecycleManager(
        database,
        process=FakeProcessController(),
        rest_factory=lambda _: FakeRestController(),
    )
    service = SteamCmdUpdateService(
        database,
        lifecycle,
        FakeMonitor(players=[]),
        RecordingNotifications(),
        runner=runner,
        health_check=lambda: True,
    )

    with pytest.raises(LifecycleError) as error:
        service.begin(steamcmd, "restore-blocked", confirmation="UPDATE", countdown_seconds=0)

    assert error.value.code == "RESTORE_RECOVERY_REQUIRED"
    assert runner.calls == []


def test_steamcmd_update_recovers_the_server_after_update_failure(tmp_path: Path) -> None:
    database, executable, steamcmd = _configured_database(tmp_path)
    process = FakeProcessController()
    rest = FakeRestController()
    runner = RecordingSteamCmdRunner(LifecycleError("STEAMCMD_UPDATE_FAILED", "SteamCMD failed."))
    lifecycle = LifecycleManager(database, process=process, rest_factory=lambda _: rest)
    service = SteamCmdUpdateService(
        database,
        lifecycle,
        FakeMonitor(players=[]),
        RecordingNotifications(),
        runner=runner,
        instance_id="north",
        health_check=lambda: True,
    )

    created = service.begin(
        steamcmd,
        "recover-after-failure",
        confirmation="UPDATE",
        countdown_seconds=0,
    )
    result = _wait_for_terminal(database, str(created["id"]))

    assert result["state"] == "failed"
    assert result["error_code"] == "STEAMCMD_UPDATE_FAILED"
    assert result["stage"] == "recovered_after_failure"
    assert process.started == [(executable, ())]
    assert process.running is True
