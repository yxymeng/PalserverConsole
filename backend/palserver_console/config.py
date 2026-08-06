from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AppSettings:
    data_dir: Path
    static_dir: Path
    port: int = 8223
    allowed_hosts: tuple[str, ...] = ("127.0.0.1", "localhost", "::1")
    session_ttl_seconds: int = 12 * 60 * 60
    login_window_seconds: int = 5 * 60
    login_max_failures: int = 5

    @property
    def database_path(self) -> Path:
        return self.data_dir / "app.db"


def default_settings() -> AppSettings:
    project_root = Path(__file__).resolve().parents[2]
    data_dir = Path(os.environ.get("PALSERVER_CONSOLE_DATA", project_root / "data"))
    static_dir = Path(
        os.environ.get("PALSERVER_CONSOLE_STATIC", project_root / "frontend" / "dist")
    )
    raw_port = os.environ.get("PALSERVER_CONSOLE_PORT", "8223")
    try:
        port = int(raw_port)
    except ValueError as error:
        raise ValueError("PALSERVER_CONSOLE_PORT must be an integer.") from error
    if not 1 <= port <= 65535:
        raise ValueError("PALSERVER_CONSOLE_PORT must be between 1 and 65535.")
    return AppSettings(data_dir=data_dir, static_dir=static_dir, port=port)
