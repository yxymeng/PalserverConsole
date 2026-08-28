import os
import socket
import subprocess
import urllib.request
import webbrowser
from collections.abc import Callable
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
import uvicorn
from pytest import MonkeyPatch

import palserver_console.__main__ as console_main


def test_main_binds_application_shutdown_to_uvicorn_server(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<!doctype html>", encoding="utf-8")
    settings = SimpleNamespace(
        static_dir=static_dir,
        database_path=tmp_path / "data" / "app.db",
        port=8223,
    )

    class FakeDatabase:
        def __init__(self, path: Path) -> None:
            assert path == settings.database_path

        def migrate(self) -> None:
            pass

        def get_setting(self, key: str) -> None:
            assert key == "network.port"
            return None

    class FakeAuth:
        def admin_password_configured(self) -> bool:
            return False

    class FakeApplicationUpdates:
        def __init__(self) -> None:
            self.requester: Callable[[], None] | None = None

        def bind_shutdown_requester(self, requester: Callable[[], None]) -> None:
            self.requester = requester

    application = SimpleNamespace(
        state=SimpleNamespace(application_updates=FakeApplicationUpdates())
    )

    class FakeConfig:
        def __init__(self, app: object, **kwargs: object) -> None:
            self.app = app
            self.kwargs = kwargs

    class FakeServer:
        def __init__(self, config: FakeConfig) -> None:
            self.config = config
            self.should_exit = False
            servers.append(self)

        def run(self, *, sockets: list[object]) -> None:
            assert sockets == [listener]
            requester = application.state.application_updates.requester
            assert requester is not None
            requester()

    servers: list[FakeServer] = []
    listener = object()
    monkeypatch.setattr(console_main, "default_settings", lambda: settings)
    monkeypatch.setattr(console_main, "Database", FakeDatabase)
    monkeypatch.setattr(console_main, "AuthStore", lambda *_args: FakeAuth())
    monkeypatch.setattr(console_main, "create_app", lambda _settings: application)
    monkeypatch.setattr(
        console_main,
        "_select_listeners",
        lambda _host, _port: ([listener], "http://127.0.0.1:8223", 8223),
    )
    monkeypatch.setattr(console_main, "_close_sockets", lambda _sockets: None)
    monkeypatch.setattr(uvicorn, "Config", FakeConfig)
    monkeypatch.setattr(uvicorn, "Server", FakeServer)

    console_main.main(["--no-browser"])

    assert len(servers) == 1
    assert servers[0].should_exit is True


def test_browser_url_has_a_palserver_console_cache_key() -> None:
    assert console_main._browser_url("http://127.0.0.1:8223") == (
        "http://127.0.0.1:8223/?app=palserver-console"
    )


def test_select_listeners_uses_a_separate_port_for_an_unrelated_service(
    monkeypatch: MonkeyPatch,
) -> None:
    bound: list[tuple[str, int]] = []

    def bind_ipv4_socket(host: str, port: int) -> socket.socket:
        bound.append((host, port))
        if port == 8223:
            raise RuntimeError("IPv4 wildcard listener is occupied")
        return object()  # type: ignore[return-value]

    monkeypatch.setattr(console_main, "_bind_ipv4_socket", bind_ipv4_socket)
    monkeypatch.setattr(console_main, "_is_running_instance", lambda _url: False)

    sockets, local_url, active_port = console_main._select_listeners("0.0.0.0", 8223)

    assert len(sockets) == 1
    assert local_url == "http://127.0.0.1:18223"
    assert active_port == 18223
    assert bound == [
        ("0.0.0.0", 8223),
        ("0.0.0.0", 18223),
    ]


def test_select_listeners_reuses_an_existing_ipv4_console(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        console_main,
        "_is_running_instance",
        lambda url: url == "http://127.0.0.1:8223",
    )

    assert console_main._select_listeners("0.0.0.0", 8223) == (
        [],
        "http://127.0.0.1:8223",
        8223,
    )


def test_select_listeners_reuses_a_legacy_ipv6_console_during_upgrade(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        console_main,
        "_is_running_instance",
        lambda url: url == "http://[::1]:8223",
    )

    assert console_main._select_listeners("0.0.0.0", 8223) == (
        [],
        "http://[::1]:8223",
        8223,
    )


def test_select_listeners_reuses_an_existing_console_on_the_fallback_port(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        console_main,
        "_bind_ipv4_socket",
        lambda _host, _port: (_ for _ in ()).throw(RuntimeError("occupied")),
    )
    monkeypatch.setattr(
        console_main,
        "_is_running_instance",
        lambda url: url == "http://127.0.0.1:18223",
    )

    assert console_main._select_listeners("0.0.0.0", 8223) == (
        [],
        "http://127.0.0.1:18223",
        18223,
    )


def test_select_listeners_uses_loopback_on_the_fallback_port_without_lan_password(
    monkeypatch: MonkeyPatch,
) -> None:
    bound: list[tuple[str, int]] = []

    def bind_ipv4_socket(host: str, port: int) -> socket.socket:
        bound.append((host, port))
        if port == 8223:
            raise RuntimeError("IPv4 loopback listener is occupied")
        return object()  # type: ignore[return-value]

    monkeypatch.setattr(console_main, "_bind_ipv4_socket", bind_ipv4_socket)
    monkeypatch.setattr(console_main, "_is_running_instance", lambda _url: False)

    sockets, local_url, active_port = console_main._select_listeners("127.0.0.1", 8223)

    assert len(sockets) == 1
    assert local_url == "http://127.0.0.1:18223"
    assert active_port == 18223
    assert bound == [("127.0.0.1", 8223), ("127.0.0.1", 18223)]


def test_select_listeners_reports_when_primary_and_fallback_ports_are_occupied(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        console_main,
        "_bind_ipv4_socket",
        lambda _host, _port: (_ for _ in ()).throw(RuntimeError("occupied")),
    )
    monkeypatch.setattr(console_main, "_is_running_instance", lambda _url: False)

    with pytest.raises(RuntimeError, match="Ports 8223 and 18223 are already in use"):
        console_main._select_listeners("127.0.0.1", 8223)


def test_close_sockets_ignores_an_already_closed_socket() -> None:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.close()

    console_main._close_sockets([listener])


def test_open_local_url_prefers_a_windows_browser(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    browser_path = tmp_path / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    browser_path.parent.mkdir(parents=True)
    browser_path.touch()
    launched: list[list[str]] = []

    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setenv("PROGRAMFILES(X86)", str(tmp_path))
    monkeypatch.delenv("PROGRAMFILES", raising=False)
    monkeypatch.delenv("LOCALAPPDATA", raising=False)
    monkeypatch.setattr(console_main, "_windows_default_browser_path", lambda: None)
    monkeypatch.setattr(subprocess, "Popen", launched.append)
    monkeypatch.setattr(webbrowser, "open", lambda _: False)

    console_main._open_local_url("http://127.0.0.1:8223/")

    assert launched == [[str(browser_path), "http://127.0.0.1:8223/"]]


def test_open_local_url_prefers_the_windows_default_browser(
    monkeypatch: MonkeyPatch, tmp_path: Path
) -> None:
    default_browser = tmp_path / "DefaultBrowser.exe"
    default_browser.touch()
    launched: list[list[str]] = []

    monkeypatch.setattr(os, "name", "nt")
    monkeypatch.setattr(console_main, "_windows_default_browser_path", lambda: default_browser)
    monkeypatch.setattr(console_main, "_windows_browser_paths", lambda: ())
    monkeypatch.setattr(subprocess, "Popen", launched.append)
    monkeypatch.setattr(webbrowser, "open", lambda _: False)

    console_main._open_local_url("http://127.0.0.1:8223/")

    assert launched == [[str(default_browser), "http://127.0.0.1:8223/"]]


def test_open_when_ready_only_opens_the_palserver_console(
    monkeypatch: MonkeyPatch,
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: nullcontext(
            BytesIO(b'{"service":"palserver-console","status":"ok"}')
        ),
    )
    monkeypatch.setattr(console_main, "_open_local_url", opened.append)

    console_main._open_when_ready("http://127.0.0.1:18223", max_attempts=1, delay_seconds=0)

    assert opened == ["http://127.0.0.1:18223/?app=palserver-console"]


def test_open_when_ready_does_not_open_another_service(
    monkeypatch: MonkeyPatch,
) -> None:
    opened: list[str] = []
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: nullcontext(BytesIO(b'{"service":"palworld-panel"}')),
    )
    monkeypatch.setattr(console_main, "_open_local_url", opened.append)

    console_main._open_when_ready("http://127.0.0.1:18223", max_attempts=1, delay_seconds=0)

    assert opened == []


def test_is_running_instance_accepts_palserver_console(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: nullcontext(
            BytesIO(b'{"service":"palserver-console","status":"ok"}')
        ),
    )

    assert console_main._is_running_instance("http://127.0.0.1:18223") is True


def test_is_running_instance_rejects_another_service(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: nullcontext(BytesIO(b'{"service":"another-service"}')),
    )

    assert console_main._is_running_instance("http://127.0.0.1:18223") is False


def test_bind_ipv4_socket_rejects_an_occupied_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        port = occupied.getsockname()[1]

        with pytest.raises(RuntimeError, match=rf"Port {port} is already in use"):
            console_main._bind_ipv4_socket("127.0.0.1", port)
