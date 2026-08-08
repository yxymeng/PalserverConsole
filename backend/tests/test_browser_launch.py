import os
import socket
import subprocess
import urllib.request
import webbrowser
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path

import pytest
from pytest import MonkeyPatch

import palserver_console.__main__ as console_main


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

    assert opened == ["http://127.0.0.1:18223"]


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


def test_require_available_port_rejects_an_occupied_port() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.bind(("127.0.0.1", 0))
        port = occupied.getsockname()[1]

        with pytest.raises(RuntimeError, match=rf"Port {port} is already in use"):
            console_main._require_available_port("127.0.0.1", port)
