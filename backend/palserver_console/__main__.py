from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import webbrowser
from dataclasses import replace
from pathlib import Path

import uvicorn
from fastapi.testclient import TestClient

from .auth import AuthStore
from .config import AppSettings, default_settings
from .main import create_app
from .persistence import Database


def main() -> None:
    parser = argparse.ArgumentParser(description="PalServerConsole local server")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the browser.")
    parser.add_argument("--portable-self-check", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

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
    host = "0.0.0.0" if AuthStore(database, settings).admin_password_configured() else "127.0.0.1"
    local_url = f"http://127.0.0.1:{settings.port}"
    should_open_browser = (
        not args.no_browser and os.environ.get("PALSERVER_CONSOLE_NO_BROWSER") != "1"
    )
    try:
        _require_available_port(host, settings.port)
    except RuntimeError:
        if not _is_running_instance(local_url):
            raise
        print(
            f"PalServerConsole is already running at {local_url}. "
            "Reusing the existing instance."
        )
        if should_open_browser:
            _open_local_url(local_url)
        return
    if should_open_browser:
        threading.Thread(target=_open_when_ready, args=(local_url,), daemon=True).start()
    uvicorn.run(create_app(settings), host=host, port=settings.port, workers=1, log_level="info")


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
                    _open_local_url(url)
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


def _require_available_port(host: str, port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
        except OSError as error:
            raise RuntimeError(
                f"Port {port} is already in use. Close the program using it or change "
                "the PalServerConsole port."
            ) from error


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
