from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Literal, cast

import httpx
import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings, ServerProfileService
from palserver_console.config_editor import ConfigError, ConfigService
from palserver_console.lifecycle import (
    LifecycleError,
    LifecycleManager,
    PalServerRestController,
    WindowsProcessController,
    parse_arguments,
)
from palserver_console.main import create_app
from palserver_console.monitoring import SensitiveValue
from palserver_console.persistence import Database
from palserver_console.steam import discover_palserver, parse_vdf, validate_executable


class FakeHandle:
    pid = 901

    def poll(self) -> int | None:
        return None


class FakeProcessController:
    def __init__(self, running: bool = True, exits: bool = True) -> None:
        self.running = running
        self.exits = exits
        self.pids = [701]
        self.started: list[tuple[Path, tuple[str, ...]]] = []
        self.force_stopped: list[int] = []

    def matching_pids(self, executable: Path) -> list[int]:
        return list(self.pids) if self.running else []

    def start(self, executable: Path, arguments: tuple[str, ...]) -> FakeHandle:
        self.started.append((executable, arguments))
        self.running = True
        return FakeHandle()

    def wait_for_exit(self, pids: list[int], timeout: float) -> bool:
        if self.exits:
            self.running = False
        return self.exits

    def force_stop(self, pids: list[int]) -> None:
        self.force_stopped.extend(pids)
        self.running = False


class FakeRestController:
    def __init__(self, fail_save: bool = False) -> None:
        self.fail_save = fail_save
        self.calls: list[str] = []

    def announce(self, message: str) -> None:
        self.calls.append("announce")

    def save(self) -> None:
        self.calls.append("save")
        if self.fail_save:
            raise LifecycleError("REST_HTTP_ERROR", "HTTP 500: save failed")

    def shutdown(self, wait_seconds: int, message: str) -> None:
        self.calls.append("shutdown")


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
        "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(RESTAPIEnabled=True,"
        'RESTAPIPort=8212,AdminPassword="test-only-secret")',
        encoding="utf-8",
    )
    database.set_setting("server.executable", str(executable))
    database.set_setting("server.arguments", "-useperfthreads -NoAsyncLoadingThread")
    return database, executable.resolve()


def _wait_for_terminal(
    database: Database, operation_id: str, timeout_seconds: float = 1.0
) -> dict[str, object]:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        operation = database.operation(operation_id)
        assert operation is not None
        if operation["state"] not in {"queued", "running"}:
            return operation
        time.sleep(0.01)
    raise AssertionError("operation did not reach a terminal state")


def test_vdf_parser_and_manifest_discovery(tmp_path: Path) -> None:
    steam = tmp_path / "Steam"
    library = tmp_path / "Library With Spaces"
    (steam / "steamapps").mkdir(parents=True)
    (library / "steamapps" / "common" / "PalServer").mkdir(parents=True)
    (library / "steamapps" / "common" / "PalServer" / "PalServer.exe").write_bytes(b"exe")
    (steam / "steamapps" / "libraryfolders.vdf").write_text(
        f'"libraryfolders" {{ "0" {{ "path" "{steam}" }} '
        f'"1" {{ "path" "{str(library).replace(chr(92), chr(92) * 2)}" }} }}',
        encoding="utf-8",
    )
    (library / "steamapps" / "appmanifest_2394010.acf").write_text(
        '"AppState" { "appid" "2394010" "installdir" "PalServer" }', encoding="utf-8"
    )

    assert parse_vdf('"root" { "quoted" "a\\"b" }')["root"]["quoted"] == 'a"b'
    candidates = discover_palserver(steam)
    assert len(candidates) == 1
    assert candidates[0].manifest_valid is True
    assert candidates[0].executable_path.name == "PalServer.exe"


def test_windows_launch_arguments_preserve_quoted_value() -> None:
    assert parse_arguments('-ServerName="My Pal Server" -port=8211') == (
        "-ServerName=My Pal Server",
        "-port=8211",
    )


def test_process_matching_compares_full_executable_path(monkeypatch: pytest.MonkeyPatch) -> None:
    entries = [
        SimpleNamespace(info={"pid": 1, "exe": r"C:\A\PalServer.exe"}),
        SimpleNamespace(info={"pid": 2, "exe": r"C:\B\PalServer.exe"}),
    ]
    monkeypatch.setattr("palserver_console.lifecycle.psutil.process_iter", lambda _: entries)
    controller = WindowsProcessController()
    assert controller.matching_pids(Path(r"C:\B\PalServer.exe")) == [2]


def test_save_failure_aborts_shutdown_and_preserves_english_error(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController()
    rest = FakeRestController(fail_save=True)
    manager = LifecycleManager(database, process=process, rest_factory=lambda _: rest)

    created = manager.begin("stop", "stop-once", countdown_seconds=0)
    result = _wait_for_terminal(database, cast(str, created["id"]))

    assert result["state"] == "failed"
    assert result["error_code"] == "REST_HTTP_ERROR"
    assert result["detail"] == "HTTP 500: save failed"
    assert rest.calls == ["save"]
    assert process.running is True


def test_rest_http_error_does_not_expose_response_body() -> None:
    controller = PalServerRestController(
        "http://127.0.0.1:8212", SensitiveValue("test-only-password")
    )
    controller._client = httpx.Client(
        base_url="http://127.0.0.1:8212",
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                500,
                text='AdminPassword="test-only-alpha,beta)"',
                request=request,
            )
        ),
    )

    with pytest.raises(LifecycleError) as error:
        controller.save()

    assert error.value.code == "REST_HTTP_ERROR"
    assert "test-only-alpha" not in str(error.value)
    assert "beta)" not in str(error.value)
    assert str(error.value) == "PalServer REST returned HTTP 500 for /v1/api/save."


def test_rest_shutdown_uses_palserver_accepted_waittime() -> None:
    captured: dict[str, object] = {}

    def respond(request: httpx.Request) -> httpx.Response:
        captured.update(cast(dict[str, object], json.loads(request.content)))
        return httpx.Response(200, request=request)

    controller = PalServerRestController(
        "http://127.0.0.1:8212", SensitiveValue("test-only-password")
    )
    controller._client = httpx.Client(
        base_url="http://127.0.0.1:8212", transport=httpx.MockTransport(respond)
    )

    controller.shutdown(1, "maintenance")

    assert captured == {"waittime": 1, "message": "maintenance"}


def test_shutdown_timeout_requires_confirmation_before_force_stop(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=False)
    rest = FakeRestController()
    manager = LifecycleManager(database, process=process, rest_factory=lambda _: rest)

    created = manager.begin("stop", "graceful-stop", countdown_seconds=0)
    operation_id = cast(str, created["id"])
    result = _wait_for_terminal(database, operation_id)
    assert result["state"] == "awaiting_force_confirmation"
    assert process.force_stopped == []

    process.exits = True
    forced = manager.confirm_force_stop(operation_id, "confirmed-force-stop")
    forced_result = _wait_for_terminal(database, cast(str, forced["id"]))
    assert forced_result["state"] == "succeeded"
    assert process.force_stopped == [701]


@pytest.mark.parametrize("kind", ["stop", "restart"])
def test_normal_stop_and_restart_never_apply_pending_config(
    tmp_path: Path, kind: Literal["stop", "restart"]
) -> None:
    database, executable = _configured_database(tmp_path)
    process = FakeProcessController(exits=True)
    rest = FakeRestController()
    service = ConfigService(
        database, tmp_path / "data", lambda: executable, lambda: process.running
    )
    service.save_draft({"AutoSaveSpan": "900"})
    config_path = (
        executable.parent / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    )
    source_before = config_path.read_text(encoding="utf-8")
    pending_before = (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(
        encoding="utf-8"
    )
    manager = LifecycleManager(
        database,
        process=process,
        rest_factory=lambda _: rest,
    )
    manager.set_config_apply(service.apply)

    created = manager.begin(kind, f"normal-{kind}", countdown_seconds=0)
    result = _wait_for_terminal(database, cast(str, created["id"]))
    assert result["state"] == "succeeded"
    assert rest.calls == ["save", "shutdown"]
    assert config_path.read_text(encoding="utf-8") == source_before
    assert (tmp_path / "data" / "pending" / "PalWorldSettings.ini").read_text(
        encoding="utf-8"
    ) == pending_before
    assert database.get_config_draft() is not None


def test_explicit_apply_and_restart_stops_before_apply_then_checks_health(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=True)
    rest = FakeRestController()
    apply_calls: list[bool] = []
    manager = LifecycleManager(database, process=process, rest_factory=lambda _: rest)

    def apply_config() -> dict[str, object]:
        apply_calls.append(process.running)
        return {"message": "applied"}

    manager.set_config_apply(apply_config)

    created = manager.begin("apply_config_and_restart", "apply-and-restart", countdown_seconds=0)
    result = _wait_for_terminal(database, cast(str, created["id"]))

    assert result["state"] == "succeeded"
    assert result["stage"] == "applied_restarted"
    assert rest.calls == ["save", "shutdown"]
    assert apply_calls == [False]
    assert len(process.started) == 1


def test_apply_failure_keeps_server_stopped_and_provides_recovery_action(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=True)
    rest = FakeRestController()
    manager = LifecycleManager(database, process=process, rest_factory=lambda _: rest)

    def fail_apply() -> dict[str, object]:
        raise ConfigError("CONFIG_CONFLICT", "检测到配置冲突。")

    manager.set_config_apply(fail_apply)
    created = manager.begin("apply_config_and_restart", "apply-fails", countdown_seconds=0)
    result = _wait_for_terminal(database, cast(str, created["id"]))

    assert result["state"] == "failed"
    assert result["error_code"] == "CONFIG_CONFLICT"
    assert "PalServer 已停止且不会重启" in str(result["detail"])
    assert "普通 start" in str(result["detail"])
    assert process.running is False
    assert process.started == []


def test_apply_with_restart_api_creates_explicit_operation(tmp_path: Path) -> None:
    database, executable = _configured_database(tmp_path)
    world = executable.parent / "Pal" / "Saved" / "SaveGames" / "0" / "configured-world"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    ServerProfileService(database).bind(executable, "configured-world")
    process = FakeProcessController(exits=True)
    lifecycle = LifecycleManager(
        database, process=process, rest_factory=lambda _: FakeRestController()
    )
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static"),
        lifecycle_manager=lifecycle,
    )

    with TestClient(
        app,
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        auth = client.get("/api/auth/status").json()
        headers = {
            "Origin": "http://127.0.0.1:8223",
            "X-CSRF-Token": auth["csrfToken"],
        }
        draft = client.put(
            "/api/config/draft",
            headers=headers,
            json={"fields": {"AutoSaveSpan": "900"}},
        )
        assert draft.status_code == 200

        response = client.post(
            "/api/config/apply-with-restart",
            headers={**headers, "Idempotency-Key": "explicit-config-restart"},
            json={"countdownSeconds": 5, "message": "apply test"},
        )

    assert response.status_code == 200
    assert response.json()["kind"] == "apply_config_and_restart"
    result = _wait_for_terminal(
        database, cast(str, response.json()["operationId"]), timeout_seconds=7.0
    )
    assert result["state"] == "succeeded"
    assert result["stage"] == "applied_restarted"
    assert process.started


def test_idempotency_returns_same_operation(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(running=False)
    manager = LifecycleManager(
        database, process=process, rest_factory=lambda _: FakeRestController()
    )
    first = manager.begin("start", "same-request")
    second = manager.begin("start", "same-request")
    assert first["id"] == second["id"]
    _wait_for_terminal(database, cast(str, first["id"]))
    assert len(process.started) == 1


def test_operation_state_transitions_are_audited(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(running=False)
    events: list[tuple[str, str, dict[str, object]]] = []
    manager = LifecycleManager(
        database,
        process=process,
        rest_factory=lambda _: FakeRestController(),
        audit_callback=lambda event_type, result, detail: events.append(
            (event_type, result, detail)
        ),
    )

    created = manager.begin("start", "audited-start")
    _wait_for_terminal(database, cast(str, created["id"]))

    transitions = [event for event in events if event[0] == "server.operation.transition"]
    stages = [event[2]["stage"] for event in transitions]
    assert stages[0] == "starting"
    assert "process_running" in stages
    assert all(event[1] == "state_changed" for event in transitions)


def test_concurrent_idempotency_across_managers_returns_one_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database, _ = _configured_database(tmp_path)
    managers = [
        LifecycleManager(
            database,
            process=FakeProcessController(running=False),
            rest_factory=lambda _: FakeRestController(),
        )
        for _ in range(2)
    ]
    original_create = Database.create_operation
    barrier = threading.Barrier(2)

    def block_legacy_create(
        self: Database, operation_id: str, kind: str, idempotency_key: str
    ) -> dict[str, object]:
        barrier.wait(timeout=2)
        return original_create(self, operation_id, kind, idempotency_key)

    monkeypatch.setattr(Database, "create_operation", block_legacy_create)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(manager.begin, "start", "concurrent-request")
            for manager in managers
        ]
        results = [future.result(timeout=3) for future in futures]

    assert results[0]["id"] == results[1]["id"]
    assert len(database.operation_by_idempotency("concurrent-request") or {}) > 0
    assert len([row for row in (database.operation(str(results[0]["id"])),) if row]) == 1


def test_waiting_force_confirmation_blocks_other_operations(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=False)
    manager = LifecycleManager(
        database, process=process, rest_factory=lambda _: FakeRestController()
    )

    created = manager.begin("stop", "waiting-stop", countdown_seconds=0)
    operation_id = cast(str, created["id"])
    result = _wait_for_terminal(database, operation_id)
    assert result["state"] == "awaiting_force_confirmation"

    with pytest.raises(LifecycleError, match="已有服务器操作正在进行") as error:
        manager.begin("start", "blocked-by-confirmation")
    assert error.value.code == "OPERATION_IN_PROGRESS"


def test_force_stop_rejects_pid_set_changed_after_confirmation_request(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=False)
    manager = LifecycleManager(
        database, process=process, rest_factory=lambda _: FakeRestController()
    )

    created = manager.begin("stop", "pid-bound-stop", countdown_seconds=0)
    parent_id = cast(str, created["id"])
    waiting = _wait_for_terminal(database, parent_id)
    assert waiting["state"] == "awaiting_force_confirmation"
    assert waiting["target_pids"] == [701]
    assert isinstance(waiting["confirmation_expires_at"], int)

    process.pids = [902]
    forced = manager.confirm_force_stop(parent_id, "pid-bound-force")
    child_id = cast(str, forced["id"])
    child = _wait_for_terminal(database, child_id)

    assert child["parent_operation_id"] == parent_id
    assert child["target_pids"] == [701]
    assert child["state"] == "failed"
    assert child["error_code"] == "FORCE_STOP_TARGET_CHANGED"
    assert process.force_stopped == []


def test_expired_force_confirmation_is_invalidated_and_unblocks_operations(
    tmp_path: Path,
) -> None:
    database, _ = _configured_database(tmp_path)
    process = FakeProcessController(exits=False)
    clock = [100.0]
    manager = LifecycleManager(
        database,
        process=process,
        rest_factory=lambda _: FakeRestController(),
        now=lambda: clock[0],
    )

    created = manager.begin("stop", "expiring-stop", countdown_seconds=0)
    parent_id = cast(str, created["id"])
    waiting = _wait_for_terminal(database, parent_id)
    expires_at = cast(int, waiting["confirmation_expires_at"])
    clock[0] = float(expires_at + 1)

    with pytest.raises(LifecycleError) as error:
        manager.confirm_force_stop(parent_id, "expired-force")
    assert error.value.code == "FORCE_CONFIRMATION_EXPIRED"
    expired = database.operation(parent_id)
    assert expired is not None
    assert expired["state"] == "failed"
    assert expired["stage"] == "force_confirmation_expired"

    process.running = False
    next_operation = manager.begin("start", "after-expiration")
    assert next_operation["kind"] == "start"


def test_startup_recovery_invalidates_waiting_confirmation(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    operation = database.create_operation("awaiting-before-restart", "stop", "old-stop")
    database.update_operation(str(operation["id"]), "running", "stopping")
    database.bind_operation_target(str(operation["id"]), [701], 9_999_999_999)
    database.update_operation(
        str(operation["id"]),
        "awaiting_force_confirmation",
        "shutdown_timeout",
        "SHUTDOWN_TIMEOUT",
        "PalServer did not exit within 30 seconds.",
    )

    assert database.fail_incomplete_operations() == 1
    recovered = database.operation("awaiting-before-restart")
    assert recovered is not None
    assert recovered["state"] == "failed"
    assert recovered["stage"] == "interrupted"
    assert recovered["error_code"] == "CONSOLE_RESTARTED"


def test_incomplete_operation_is_recovered_after_console_restart(tmp_path: Path) -> None:
    database, _ = _configured_database(tmp_path)
    operation = database.create_operation("left-running", "restart", "previous-request")
    database.update_operation(str(operation["id"]), "running", "saving")
    assert database.fail_incomplete_operations() == 1
    recovered = database.operation("left-running")
    assert recovered is not None
    assert recovered["state"] == "failed"
    assert recovered["error_code"] == "CONSOLE_RESTARTED"


def test_m2_api_settings_and_force_stop_boundary(tmp_path: Path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    executable = tmp_path / "PalServer.exe"
    executable.write_bytes(b"exe")
    ini = tmp_path / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    ini.parent.mkdir(parents=True)
    ini.write_text(
        'OptionSettings=(RESTAPIEnabled=True,RESTAPIPort=8212,AdminPassword="test-only")',
        encoding="utf-8",
    )
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
        response = client.put(
            "/api/server/settings",
            headers=headers,
            json={"executablePath": str(executable), "launchArguments": "-port=8211"},
        )
        assert response.status_code == 200
        status = client.get("/api/shell/status").json()
        assert status["module"] == "M2"
        assert status["serverState"] == "stopped"
        denied = client.post(
            "/api/server/operations/force_stop",
            headers={**headers, "Idempotency-Key": "bypass"},
            json={"countdownSeconds": 30, "message": "test"},
        )
    assert denied.status_code == 422


def test_lifecycle_profile_provider_fails_closed_without_world_binding(tmp_path: Path) -> None:
    database, executable = _configured_database(tmp_path)
    profiles = ServerProfileService(database)
    manager = LifecycleManager(
        database,
        process=FakeProcessController(running=False),
        profile_provider=profiles.profile,
    )

    with pytest.raises(LifecycleError) as error:
        manager.load_configuration()

    assert error.value.code == "WORLD_PROFILE_REQUIRED"
    assert executable.exists()


def test_config_writes_fail_closed_when_bound_world_moves(tmp_path: Path) -> None:
    database, executable = _configured_database(tmp_path)
    world = executable.parent / "Pal" / "Saved" / "SaveGames" / "0" / "world-a"
    (world / "Players").mkdir(parents=True)
    (world / "Level.sav").write_bytes(b"level")
    (world / "LevelMeta.sav").write_bytes(b"meta")
    profiles = ServerProfileService(database)
    profiles.bind(executable, "world-a")
    world.rename(world.parent / "moved")
    editor = ConfigService(
        database,
        tmp_path / "data",
        lambda: executable,
        lambda: False,
        profiles.profile,
    )

    with pytest.raises(ConfigError) as error:
        editor.save_draft({"AutoSaveSpan": "900"})

    assert error.value.code == "WORLD_BINDING_INVALID"


def test_validate_executable_rejects_windows_reparse_point(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "PalServer" / "PalServer.exe"
    executable.parent.mkdir(parents=True)
    executable.write_bytes(b"exe")
    original_is_symlink = Path.is_symlink

    def fake_is_symlink(path: Path) -> bool:
        return path == executable.parent or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)
    with pytest.raises(ValueError, match="reparse point"):
        validate_executable(executable)
