from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.main import create_app
from palserver_console.monitoring import (
    MonitorCoordinator,
    PalServerRestClient,
    SensitiveValue,
    ServerConnectionConfig,
    SourceError,
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
            "memoryBytes": 1048576,
            "diskReadBytes": 10,
            "diskWriteBytes": 20,
        }, None


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

        announcement = client.post(
            "/api/live/announce",
            headers={"Origin": "http://127.0.0.1:8223", "X-CSRF-Token": auth["csrfToken"]},
            json={"message": "维护通知"},
        )
        assert announcement.status_code == 200
        assert rest.actions == [("announce", ("维护通知",))]

        assert any(getattr(route, "path", None) == "/api/events" for route in app.routes)
        assert "event: snapshot" in next(monitor.stream())
