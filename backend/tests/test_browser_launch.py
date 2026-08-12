import os
import socket
import subprocess
import urllib.request
import webbrowser
from contextlib import nullcontext
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import psutil
import pytest
from pytest import MonkeyPatch

import palserver_console.__main__ as console_main


def test_browser_url_has_a_palserver_console_cache_key() -> None:
    assert console_main._browser_url("http://127.0.0.1:8223") == (
        "http://127.0.0.1:8223/?app=palserver-console"
    )


def test_select_listeners_falls_back_to_specific_ipv4_addresses(
    monkeypatch: MonkeyPatch,
) -> None:
    bound: list[str] = []

    def bind_ipv4_socket(host: str, _port: int) -> socket.socket:
        bound.append(host)
        if host == "0.0.0.0":
            raise RuntimeError("IPv4 wildcard listener is occupied")
        return object()  # type: ignore[return-value]

    monkeypatch.setattr(console_main, "_bind_ipv4_socket", bind_ipv4_socket)
    monkeypatch.setattr(console_main, "_interface_ipv4_addresses", lambda: ("192.168.50.2",))
    monkeypatch.setattr(console_main, "_is_running_instance", lambda _url: False)

    sockets, local_url, addresses = console_main._select_listeners("0.0.0.0", 8223)

    assert len(sockets) == 2
    assert local_url == "http://127.0.0.1:8223"
    assert addresses == ("127.0.0.1", "192.168.50.2")
    assert bound == [
        "0.0.0.0",
        "127.0.0.1",
        "192.168.50.2",
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
        (),
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
        (),
    )


@pytest.mark.parametrize(
    ("address", "expected"),
    [
        ("10.0.0.5", True),
        ("100.64.1.5", True),
        ("192.168.50.2", True),
        ("127.0.0.1", False),
        ("169.254.1.5", False),
        ("198.18.0.1", False),
        ("203.0.113.5", False),
    ],
)
def test_is_bindable_ipv4(address: str, expected: bool) -> None:
    assert console_main._is_bindable_ipv4(address) is expected


def test_interface_ipv4_addresses_keeps_vpn_but_excludes_meta_and_inactive(
    monkeypatch: MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        psutil,
        "net_if_stats",
        lambda: {
            "Ethernet": SimpleNamespace(isup=True),
            "Tailscale": SimpleNamespace(isup=True),
            "Meta": SimpleNamespace(isup=True),
            "WLAN": SimpleNamespace(isup=False),
        },
    )
    monkeypatch.setattr(
        psutil,
        "net_if_addrs",
        lambda: {
            "Ethernet": [SimpleNamespace(family=socket.AF_INET, address="192.168.50.2")],
            "Tailscale": [SimpleNamespace(family=socket.AF_INET, address="100.64.0.2")],
            "Meta": [SimpleNamespace(family=socket.AF_INET, address="198.18.0.1")],
            "WLAN": [SimpleNamespace(family=socket.AF_INET, address="192.168.60.2")],
        },
    )

    assert console_main._interface_ipv4_addresses() == ("100.64.0.2", "192.168.50.2")


def test_select_listeners_rejects_an_unrelated_loopback_service_without_lan_password(
    monkeypatch: MonkeyPatch,
) -> None:
    bound: list[str] = []

    def bind_ipv4_socket(host: str, _port: int) -> socket.socket:
        bound.append(host)
        raise RuntimeError("IPv4 loopback listener is occupied")

    monkeypatch.setattr(console_main, "_bind_ipv4_socket", bind_ipv4_socket)
    monkeypatch.setattr(console_main, "_is_running_instance", lambda _url: False)

    with pytest.raises(RuntimeError, match="loopback listener is occupied"):
        console_main._select_listeners("127.0.0.1", 8223)

    assert bound == ["127.0.0.1"]


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
