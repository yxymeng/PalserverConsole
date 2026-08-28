from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from contextlib import suppress
from dataclasses import replace
from pathlib import Path

import uvicorn
from fastapi.testclient import TestClient

from .application_updates import _portable_install_root, portable_application_update_in_progress
from .auth import AuthStore
from .config import AppSettings, default_settings
from .main import create_app
from .persistence import Database

CONFLICT_FALLBACK_PORT = 18223


def _portable_update_blocks_launch() -> bool:
    install_root = _portable_install_root()
    return install_root is not None and portable_application_update_in_progress(install_root)


def main(argv: list[str] | None = None) -> None:
    arguments = sys.argv[1:] if argv is None else argv
    if _portable_update_blocks_launch():
        print(
            "PalServerConsole application update is in progress. "
            "Try again after the update completes."
        )
        return
    if arguments[:1] == ["--world-worker"]:
        from .world.worker import main as worker_main

        raise SystemExit(worker_main(arguments[1:]))

    parser = argparse.ArgumentParser(description="PalServerConsole local server")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser.")
    parser.add_argument(
        "--instance",
        "-InstanceId",
        dest="instance",
        metavar="ID",
        help="Run an isolated named console instance.",
    )
    parser.add_argument(
        "--port", "-Port", dest="port", type=int, help="Console port for this process."
    )
    parser.add_argument("--portable-self-check", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(arguments)

    if args.instance is not None:
        os.environ["PALSERVER_CONSOLE_INSTANCE"] = args.instance
    if args.port is not None:
        os.environ["PALSERVER_CONSOLE_PORT"] = str(args.port)
    settings = default_settings()
    if args.portable_self_check:
        _portable_self_check(settings)
        return
    if not (settings.static_dir / "index.html").is_file():
        raise RuntimeError(
            "Frontend build is missing. Run npm.cmd run build in the frontend directory."
        )
    database = Database(settings.database_path)
    database.migrate()
    stored_port = database.get_setting("network.port")
    if stored_port is not None:
        settings = replace(settings, port=int(stored_port))
    preferred_host = (
        "0.0.0.0"
        if AuthStore(database, settings).admin_password_configured()
        else "127.0.0.1"
    )
    should_open_browser = (
        not args.no_browser and os.environ.get("PALSERVER_CONSOLE_NO_BROWSER") != "1"
    )
    configured_port = settings.port
    sockets, local_url, active_port = _select_listeners(preferred_host, configured_port)
    if not sockets:
        print(
            f"PalServerConsole is already running at {local_url}. "
            "Reusing the existing instance."
        )
        if should_open_browser:
            _open_local_url(_browser_url(local_url))
        return
    if active_port != configured_port:
        print(
            f"Port {configured_port} is occupied by another service. "
            f"Starting PalServerConsole on fallback port {active_port} at {local_url}. "
            "The saved port setting is unchanged."
        )
        settings = replace(settings, port=active_port)
    if should_open_browser:
        threading.Thread(target=_open_when_ready, args=(local_url,), daemon=True).start()
    application = create_app(settings)
    server = uvicorn.Server(
        uvicorn.Config(
            application,
            host=preferred_host,
            port=settings.port,
            workers=1,
            log_level="info",
        )
    )
    application.state.application_updates.bind_shutdown_requester(
        lambda: setattr(server, "should_exit", True)
    )
    try:
        server.run(sockets=sockets)
    except KeyboardInterrupt:
        pass
    finally:
        _close_sockets(sockets)


def _portable_self_check(settings: AppSettings) -> None:
    """Exercise a frozen build without creating or migrating user data."""

    if not (settings.static_dir / "index.html").is_file():
        raise RuntimeError("Portable frontend build is missing from the application bundle.")
    with tempfile.TemporaryDirectory(prefix="palserver-console-portable-check-") as temporary_root:
        smoke_settings = replace(settings, data_dir=Path(temporary_root) / "data")
        app = create_app(smoke_settings)
        try:
            with TestClient(
                app,
                base_url="http://127.0.0.1:8223",
                client=("127.0.0.1", 50000),
            ) as client:
                response = client.get("/api/health")
                frontend_response = client.get("/")
        finally:
            for handler in tuple(app.state.logger.handlers):
                if getattr(handler, "_palserver_console_handler", False):
                    app.state.logger.removeHandler(handler)
                    handler.close()
    if response.status_code != 200 or response.json().get("status") != "ok":
        raise RuntimeError("Portable health self-check failed.")
    frontend_ok = (
        frontend_response.status_code == 200
        and "<!doctype html" in frontend_response.text.lower()
    )
    if not frontend_ok:
        raise RuntimeError("Portable frontend self-check failed.")
    print(
        json.dumps(
            {
                "service": "palserver-console",
                "portableSelfCheck": "ok",
                "health": "ok",
                "frontend": "ok",
            }
        )
    )


def _open_when_ready(url: str, max_attempts: int = 80, delay_seconds: float = 0.25) -> None:
    for _ in range(max_attempts):
        try:
            with urllib.request.urlopen(f"{url}/api/health", timeout=0.5) as response:
                if _is_own_health_response(response):
                    _open_local_url(_browser_url(url))
                    return
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(delay_seconds)


def _is_own_health_response(response: object) -> bool:
    try:
        payload = json.load(response)  # type: ignore[arg-type]
    except (OSError, json.JSONDecodeError, TypeError):
        return False
    return (
        isinstance(payload, dict)
        and payload.get("service") == "palserver-console"
        and payload.get("status") == "ok"
    )


def _is_running_instance(url: str) -> bool:
    try:
        with urllib.request.urlopen(f"{url}/api/health", timeout=1) as response:
            return _is_own_health_response(response)
    except (OSError, json.JSONDecodeError):
        return False


def _local_url(host: str, port: int) -> str:
    url_host = f"[{host}]" if ":" in host else host
    return f"http://{url_host}:{port}"


def _browser_url(service_url: str) -> str:
    return f"{service_url.rstrip('/')}/?app=palserver-console"


def _select_listeners(
    host: str, port: int
) -> tuple[list[socket.socket], str, int]:
    local_url = _local_url("127.0.0.1", port)
    if _is_running_instance(local_url):
        return [], local_url, port
    legacy_url = _local_url("::1", port)
    if _is_running_instance(legacy_url):
        return [], legacy_url, port
    try:
        listener = _bind_ipv4_socket(host, port)
    except RuntimeError as primary_error:
        if _is_running_instance(local_url):
            return [], local_url, port
        if port == CONFLICT_FALLBACK_PORT:
            raise primary_error from None
        fallback_url = _local_url("127.0.0.1", CONFLICT_FALLBACK_PORT)
        if _is_running_instance(fallback_url):
            return [], fallback_url, CONFLICT_FALLBACK_PORT
        fallback_legacy_url = _local_url("::1", CONFLICT_FALLBACK_PORT)
        if _is_running_instance(fallback_legacy_url):
            return [], fallback_legacy_url, CONFLICT_FALLBACK_PORT
        try:
            listener = _bind_ipv4_socket(host, CONFLICT_FALLBACK_PORT)
        except RuntimeError as fallback_error:
            if _is_running_instance(fallback_url):
                return [], fallback_url, CONFLICT_FALLBACK_PORT
            raise RuntimeError(
                f"Ports {port} and {CONFLICT_FALLBACK_PORT} are already in use. "
                "Close the programs using them or change the PalServerConsole port."
            ) from fallback_error
        return [listener], fallback_url, CONFLICT_FALLBACK_PORT
    return [listener], local_url, port


def _bind_ipv4_socket(host: str, port: int) -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind((host, port))
    except OSError as error:
        listener.close()
        raise RuntimeError(
            f"Port {port} is already in use. Close the program using it or change "
            "the PalServerConsole port."
        ) from error
    listener.set_inheritable(True)
    return listener


def _close_sockets(sockets: list[socket.socket]) -> None:
    for listener in sockets:
        with suppress(OSError):
            listener.close()


def _open_local_url(url: str) -> None:
    """Open the local site in the Windows default browser without using its URL handler."""
    if os.name == "nt":
        default_browser = _windows_default_browser_path()
        browser_paths = ((default_browser,) if default_browser is not None else ())
        for browser_path in (*browser_paths, *_windows_browser_paths()):
            if not browser_path.is_file():
                continue
            try:
                subprocess.Popen([str(browser_path), url])
                return
            except OSError:
                continue
    webbrowser.open(url)


def _windows_default_browser_path() -> Path | None:
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
        ) as key:
            prog_id, _ = winreg.QueryValueEx(key, "ProgId")
        with winreg.OpenKey(
            winreg.HKEY_CLASSES_ROOT,
            rf"{prog_id}\shell\open\command",
        ) as key:
            command, _ = winreg.QueryValueEx(key, "")
    except (ModuleNotFoundError, OSError):
        return None
    return _executable_path_from_command(str(command))


def _executable_path_from_command(command: str) -> Path | None:
    command = os.path.expandvars(command.strip())
    if command.startswith('"'):
        end_quote = command.find('"', 1)
        if end_quote == -1:
            return None
        executable = command[1:end_quote]
    else:
        executable = command.split(maxsplit=1)[0] if command else ""
    path = Path(executable)
    return path if path.is_file() else None


def _windows_browser_paths() -> tuple[Path, ...]:
    roots = [
        os.environ.get("PROGRAMFILES(X86)"),
        os.environ.get("PROGRAMFILES"),
        os.environ.get("LOCALAPPDATA"),
    ]
    browser_locations = (
        "Microsoft/Edge/Application/msedge.exe",
        "Google/Chrome/Application/chrome.exe",
    )
    return tuple(
        Path(root) / location
        for root in roots
        if root
        for location in browser_locations
    )


if __name__ == "__main__":
    main()
