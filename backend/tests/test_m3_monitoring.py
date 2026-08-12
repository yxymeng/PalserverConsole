from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import httpx
import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.main import create_app
from palserver_console.monitoring import (
    MonitorCoordinator,
    PalServerRestClient,
    ProcessMetricsCollector,
    SensitiveValue,
    ServerConnectionConfig,
    SourceError,
    _safe_error_text,
    parse_connection_config,
)


class FakeRest:
    def __init__(self) -> None:
        self.failures: dict[str, SourceError] = {}
        self.actions: list[tuple[str, tuple[str, ...]]] = []
        self.close_count = 0

    def _value(self, name: str, value: Any) -> Any:
        if name in self.failures:
            raise self.failures[name]
        return value

    def info(self) -> Any:
        return self._value("info", {"version": "test-server"})

    def players(self) -> Any:
        return self._value(
            "players",
            [{"name": "测试玩家", "userId": "player-1", "ip": "203.0.113.9"}],
        )

    def metrics(self) -> Any:
        return self._value("metrics", {"serverFps": 60})

    def settings(self) -> Any:
        return self._value("settings", {"AdminPassword": "must-not-leak", "difficulty": "Normal"})

    def announce(self, message: str) -> None:
        self.actions.append(("announce", (message,)))

    def kick(self, player_id: str, message: str) -> None:
        self.actions.append(("kick", (player_id, message)))

    def ban(self, player_id: str, message: str) -> None:
        self.actions.append(("ban", (player_id, message)))

    def unban(self, player_id: str) -> None:
        self.actions.append(("unban", (player_id,)))

    def close(self) -> None:
        self.close_count += 1


class FakeRcon:
    def __init__(self) -> None:
        self.failures: dict[str, SourceError] = {}

    def info(self) -> Any:
        if "info" in self.failures:
            raise self.failures["info"]
        return {"raw": "RCON Info"}

    def players(self) -> Any:
        if "players" in self.failures:
            raise self.failures["players"]
        return [{"name": "RCON 玩家", "ip": "198.51.100.8"}]


class FakeProcessMetrics:
    def collect(self, executable: Path) -> tuple[dict[str, object], str | None]:
        assert executable.name == "PalServer.exe"
        return {
            "pids": [123],
            "cpuPercent": 12.5,
            "cpuReady": True,
            "memoryBytes": 1048576,
            "diskReadBytes": 10,
            "diskWriteBytes": 20,
            "diskReadBytesPerSecond": 1.0,
            "diskWriteBytesPerSecond": 2.0,
            "ioReady": True,
        }, None


class FakeProcess:
    def __init__(
        self,
        pid: int,
        started_at: float,
        *,
        cpu_seconds: float = 1.0,
        read_bytes: int = 10,
        write_bytes: int = 20,
        rss: int = 1024,
        executable: str = "C:/test/PalServer.exe",
        children: list[FakeProcess] | None = None,
    ) -> None:
        self.pid = pid
        self.started_at = started_at
        self.cpu_seconds = cpu_seconds
        self.read_bytes = read_bytes
        self.write_bytes = write_bytes
        self.rss = rss
        self.info = {"pid": pid, "exe": executable}
        self._children = children or []

    def cpu_times(self) -> SimpleNamespace:
        return SimpleNamespace(user=self.cpu_seconds, system=0.0)

    def memory_info(self) -> SimpleNamespace:
        return SimpleNamespace(rss=self.rss)

    def io_counters(self) -> SimpleNamespace:
        return SimpleNamespace(read_bytes=self.read_bytes, write_bytes=self.write_bytes)

    def create_time(self) -> float:
        return self.started_at

    def children(self, recursive: bool = False) -> list[FakeProcess]:
        assert recursive is True
        return self._children


def test_process_metrics_include_oldest_process_start_time() -> None:
    collector = ProcessMetricsCollector(
        process_lookup=lambda _: cast(
            Any,
            [FakeProcess(123, 1_786_000_120.8), FakeProcess(456, 1_786_000_000.2)],
        )
    )

    metrics, error = collector.collect(Path("C:/test/PalServer.exe"))

    assert error is None
    assert metrics["startedAt"] == 1_786_000_000
    assert metrics["cpuReady"] is False
    assert metrics["ioReady"] is False


def test_process_metrics_calculates_cpu_and_io_rates_from_two_samples() -> None:
    process = FakeProcess(
        123,
        1_786_000_000.2,
        cpu_seconds=1.0,
        read_bytes=100,
        write_bytes=200,
        rss=2048,
    )
    clock = [100.0]
    collector = ProcessMetricsCollector(
        process_lookup=lambda _: cast(Any, [process]),
        clock=lambda: clock[0],
        logical_cpu_count=lambda: 2,
    )

    first, first_error = collector.collect(Path("C:/test/PalServer.exe"))
    assert first_error is None
    assert first["cpuPercent"] == 0.0
    assert first["cpuReady"] is False
    assert first["ioReady"] is False

    process.cpu_seconds = 1.25
    process.read_bytes = 300
    process.write_bytes = 260
    clock[0] = 102.0
    second, second_error = collector.collect(Path("C:/test/PalServer.exe"))

    assert second_error is None
    assert second["cpuPercent"] == 6.25
    assert second["memoryBytes"] == 2048
    assert second["diskReadBytes"] == 300
    assert second["diskWriteBytes"] == 260
    assert second["diskReadBytesPerSecond"] == 100.0
    assert second["diskWriteBytesPerSecond"] == 30.0
    assert second["cpuReady"] is True
    assert second["ioReady"] is True


def test_process_lookup_includes_palserver_descendants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    child = FakeProcess(
        456,
        1_786_000_001.0,
        rss=1_400_000_000,
        executable="C:/test/Pal/Binaries/Win64/PalServer-Win64-Shipping-Cmd.exe",
    )
    root = FakeProcess(123, 1_786_000_000.0, rss=7_000_000, children=[child])
    unrelated = FakeProcess(789, 1_786_000_000.0, executable="C:/test/Other.exe")
    monkeypatch.setattr(
        "palserver_console.monitoring.psutil.process_iter",
        lambda _: cast(Any, [root, unrelated]),
    )

    processes = ProcessMetricsCollector._find_processes(Path("C:/test/PalServer.exe"))

    assert [process.pid for process in processes] == [123, 456]


def _monitor() -> tuple[MonitorCoordinator, FakeRest, FakeRcon]:
    rest = FakeRest()
    rcon = FakeRcon()
    config = ServerConnectionConfig(
        rest_url="http://127.0.0.1:8212",
        rest_enabled=True,
        rcon_host="127.0.0.1",
        rcon_port=25575,
        rcon_enabled=True,
        admin_password=SensitiveValue("must-not-leak"),
    )
    monitor = MonitorCoordinator(
        config_loader=lambda: (Path("C:/test/PalServer.exe"), config),
        rest_factory=lambda _: rest,
        rcon_factory=lambda _: rcon,
        process_metrics=FakeProcessMetrics(),  # type: ignore[arg-type]
        interval_seconds=60,
    )
    return monitor, rest, rcon


def test_connection_config_parses_ports_and_redacts_password() -> None:
    config = parse_connection_config(
        'OptionSettings=(RESTAPIEnabled=True,RESTAPIPort=8312,RCONEnabled=True,RCONPort=25585,AdminPassword="must-not-leak")'
    )
    assert config.rest_url == "http://127.0.0.1:8312"
    assert config.rcon_port == 25585
    assert "must-not-leak" not in repr(config)
    assert "must-not-leak" not in str(config.admin_password)


def test_rest_error_redaction_consumes_complex_quoted_secret() -> None:
    secret = 'abc"),RCONEnabled=True,(path)\\tail'
    encoded = json.dumps(secret)
    for payload in (
        f"AdminPassword={encoded}",
        json.dumps(f"AdminPassword={encoded}"),
        json.dumps({"AdminPassword": secret}),
        json.dumps({"error": {"AdminPassword": secret}}),
    ):
        result = _safe_error_text(payload)
        assert "abc" not in result
        assert "RCONEnabled=True" not in result
        assert "path" not in result


def test_rest_client_bypasses_environment_proxies_for_loopback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            body = b'{"version":"local-rest"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            return None

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
            monkeypatch.setenv(name, "http://127.0.0.1:1")
        monkeypatch.setenv("NO_PROXY", "")
        config = ServerConnectionConfig(
            rest_url=f"http://127.0.0.1:{server.server_port}",
            rest_enabled=True,
            rcon_host="127.0.0.1",
            rcon_port=25575,
            rcon_enabled=False,
            admin_password=SensitiveValue("must-not-leak"),
        )
        client = PalServerRestClient(config)
        try:
            assert client.info() == {"version": "local-rest"}
            assert client._client._trust_env is False
        finally:
            client.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (httpx.Response(401, text="unauthorized"), "REST_UNAUTHORIZED"),
        (httpx.Response(404, text="missing"), "REST_NOT_FOUND"),
        (httpx.Response(409, text="conflict"), "REST_CONFLICT"),
        (httpx.Response(500, text="broken"), "REST_SERVER_ERROR"),
        (httpx.Response(200, text="not-json"), "REST_NON_JSON"),
    ],
)
def test_rest_client_classifies_http_and_non_json_failures(
    response: httpx.Response, expected: str
) -> None:
    config = ServerConnectionConfig(
        rest_url="http://127.0.0.1:8212",
        rest_enabled=True,
        rcon_host="127.0.0.1",
        rcon_port=25575,
        rcon_enabled=False,
        admin_password=SensitiveValue("must-not-leak"),
    )
    client = PalServerRestClient(config)
    client._client = httpx.Client(
        base_url=config.rest_url,
        transport=httpx.MockTransport(lambda _: response),
    )
    with pytest.raises(SourceError) as error:
        client.info()
    assert error.value.code == expected
    assert "must-not-leak" not in str(error.value)


@pytest.mark.parametrize(
    ("failure", "expected"),
    [
        (httpx.ReadTimeout("timeout"), "REST_TIMEOUT"),
        (httpx.ConnectError("refused"), "REST_CONNECTION_REFUSED"),
    ],
)
def test_rest_client_classifies_timeout_and_connection_refusal(
    failure: httpx.HTTPError, expected: str
) -> None:
    config = ServerConnectionConfig(
        rest_url="http://127.0.0.1:8212",
        rest_enabled=True,
        rcon_host="127.0.0.1",
        rcon_port=25575,
        rcon_enabled=False,
        admin_password=SensitiveValue("must-not-leak"),
    )
    client = PalServerRestClient(config)

    def fail(_: httpx.Request) -> httpx.Response:
        raise failure

    client._client = httpx.Client(base_url=config.rest_url, transport=httpx.MockTransport(fail))
    with pytest.raises(SourceError) as error:
        client.info()
    assert error.value.code == expected


def test_monitor_uses_read_only_rcon_fallback_and_preserves_stale_values() -> None:
    monitor, rest, rcon = _monitor()
    first = monitor.collect_once()
    assert first["info"]["source"] == "rest"
    assert first["players"]["data"][0]["ip"] == "203.0.113.9"
    assert first["settings"]["data"]["AdminPassword"] == "[REDACTED]"

    rest.failures["info"] = SourceError("REST_TIMEOUT", "timeout")
    rest.failures["players"] = SourceError("REST_CONNECTION_REFUSED", "refused")
    rest.failures["metrics"] = SourceError("REST_SERVER_ERROR", "HTTP 500")
    rcon.failures["players"] = SourceError("RCON_TIMEOUT", "timeout")
    second = monitor.collect_once()

    assert second["info"]["source"] == "rcon"
    assert second["info"]["stale"] is False
    assert second["players"]["stale"] is True
    assert second["players"]["data"][0]["ip"] == "203.0.113.9"
    assert second["players"]["errorCode"] == "REST_CONNECTION_REFUSED;RCON_TIMEOUT"
    assert second["metrics"]["stale"] is True
    assert "REST_SERVER_ERROR" in str(second["metrics"]["errorCode"])
    assert rest.close_count == 2


def test_monitor_background_reports_error_and_recovers_with_backoff() -> None:
    rest = FakeRest()
    rcon = FakeRcon()
    config = ServerConnectionConfig(
        rest_url="http://127.0.0.1:8212",
        rest_enabled=True,
        rcon_host="127.0.0.1",
        rcon_port=25575,
        rcon_enabled=True,
        admin_password=SensitiveValue("must-not-leak"),
    )
    calls = 0

    def flaky_factory(_: ServerConnectionConfig) -> FakeRest:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("injected monitor failure")
        return rest

    monitor = MonitorCoordinator(
        config_loader=lambda: (Path("C:/test/PalServer.exe"), config),
        rest_factory=flaky_factory,
        rcon_factory=lambda _: rcon,
        process_metrics=FakeProcessMetrics(),  # type: ignore[arg-type]
        interval_seconds=0.01,
        retry_base_seconds=0.01,
        retry_max_seconds=0.05,
    )
    monitor.start()
    try:
        deadline = time.monotonic() + 2
        status = monitor.status()
        while status["lastSuccessAt"] is None and time.monotonic() < deadline:
            time.sleep(0.01)
            status = monitor.status()
        assert calls >= 2
        assert status["alive"] is True
        assert status["lastSuccessAt"] is not None
        assert status["consecutiveFailures"] == 0
        last_error = cast(dict[str, object], status["lastError"])
        assert last_error["code"] == "MONITOR_LOOP_ERROR"
        assert status["retryDelaySeconds"] == 0.0
    finally:
        monitor.stop()


def test_m3_api_exposes_full_ip_sse_and_never_returns_admin_password(tmp_path: Path) -> None:
    monitor, rest, _ = _monitor()
    monitor.collect_once()
    settings = AppSettings(data_dir=tmp_path / "data", static_dir=tmp_path / "static")
    app = create_app(settings, monitor=monitor)
    with TestClient(
        app,
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        auth = client.get("/api/auth/status").json()
        players = client.get("/api/live/players")
        assert players.status_code == 200
        assert players.json()["data"][0]["ip"] == "203.0.113.9"
        settings_response = client.get("/api/live/settings")
        assert "must-not-leak" not in settings_response.text
        assert settings_response.json()["data"]["AdminPassword"] == "[REDACTED]"
        background = client.get("/api/monitoring/status")
        assert background.status_code == 200
        assert set(background.json()) == {"monitor", "audit"}

        announcement = client.post(
            "/api/live/announce",
            headers={"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]},
            json={"message": "维护通知"},
        )
        assert announcement.status_code == 200
        assert rest.actions == [("announce", ("维护通知",))]

        assert any(getattr(route, "path", None) == "/api/events" for route in app.routes)
        assert "event: snapshot" in next(monitor.stream())
