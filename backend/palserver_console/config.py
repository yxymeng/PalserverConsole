from __future__ import annotations

import logging
import logging.handlers
import os
import re
from dataclasses import dataclass
from pathlib import Path

from .persistence import Database
from .steam import assert_no_reparse_points, validate_executable

WORLD_ROOT_PARTS = ("Pal", "Saved", "SaveGames", "0")
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 5

_SENSITIVE_LOG_VALUE = re.compile(
    r"(?i)\b(AdminPassword|RCONPassword|password|token|secret|cookie|authorization)\b"
    r"(\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^,\s;}\]]+)"
)


def redact_log_text(value: str) -> str:
    """Redact credential-like key/value pairs before they reach the persistent log."""

    return _SENSITIVE_LOG_VALUE.sub(r"\1\2[REDACTED]", value)[:4096]


class _RedactingFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact_log_text(super().format(record))


class _ConsoleRotatingFileHandler(logging.handlers.RotatingFileHandler):
    _palserver_console_handler = True


def configure_logging(
    data_dir: Path,
    *,
    max_bytes: int = LOG_MAX_BYTES,
    backup_count: int = LOG_BACKUP_COUNT,
) -> logging.Logger:
    """Configure the bounded application log for the current data directory."""

    log_directory = data_dir / "logs"
    log_directory.mkdir(parents=True, exist_ok=True)
    log_path = log_directory / "palserver-console.log"
    logger = logging.getLogger("palserver_console")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    for handler in tuple(logger.handlers):
        if getattr(handler, "_palserver_console_handler", False):
            logger.removeHandler(handler)
            handler.close()

    handler = _ConsoleRotatingFileHandler(
        log_path,
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    handler.setFormatter(
        _RedactingFormatter(
            "%(asctime)s %(levelname)s %(name)s %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )
    logger.addHandler(handler)
    return logger


@dataclass(frozen=True)
class WorldCandidate:
    world_id: str
    world_path: Path
    modified_at_ns: int


@dataclass(frozen=True)
class ServerProfile:
    executable_path: Path
    install_path: Path
    world_id: str
    world_path: Path


class ProfileError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ServerProfileService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def candidates(self, executable_path: Path | str) -> list[WorldCandidate]:
        executable = self._validated_executable(executable_path)
        root = self._world_root(executable, required=False)
        if root is None:
            return []
        try:
            entries = sorted(root.iterdir(), key=lambda path: path.name.casefold())
        except OSError as error:
            raise ProfileError(
                "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
            ) from error

        result: list[WorldCandidate] = []
        for path in entries:
            if not path.is_dir() or self._has_reparse_point(path):
                continue
            level = path / "Level.sav"
            if self._has_reparse_point(level) or not level.is_file():
                continue
            try:
                modified_at_ns = level.stat().st_mtime_ns
            except OSError as error:
                raise ProfileError(
                    "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
                ) from error
            result.append(
                WorldCandidate(
                    world_id=path.name,
                    world_path=path.resolve(strict=True),
                    modified_at_ns=modified_at_ns,
                )
            )
        return result

    def bind(self, executable_path: Path | str, world_id: str) -> ServerProfile:
        self._validate_world_id(world_id)
        executable = self._validated_executable(executable_path)
        candidates = self.candidates(executable)
        selected = next((item for item in candidates if item.world_id == world_id), None)
        if selected is None:
            raise ProfileError("WORLD_NOT_FOUND", "The selected World ID is not available.")
        profile = ServerProfile(
            executable_path=executable,
            install_path=executable.parent,
            world_id=selected.world_id,
            world_path=selected.world_path,
        )
        self.database.save_server_profile(
            str(profile.executable_path),
            str(profile.install_path),
            profile.world_id,
            str(profile.world_path),
        )
        return profile

    def profile(self) -> ServerProfile:
        row = self.database.get_server_profile()
        if row is None:
            raise ProfileError("WORLD_PROFILE_REQUIRED", "An explicit World ID must be selected.")

        try:
            stored_executable = self._validated_executable(str(row["executable_path"]))
            stored_install = self._validated_directory(Path(str(row["install_path"])))
        except ProfileError:
            raise
        if not self._same_path(stored_install, stored_executable.parent):
            raise ProfileError(
                "SERVER_PROFILE_MISMATCH",
                "The saved install path no longer matches PalServer.exe.",
            )

        configured = self.database.get_setting("server.executable")
        if not configured:
            raise ProfileError(
                "SERVER_PROFILE_MISMATCH", "The saved server profile is not configured."
            )
        try:
            configured_executable = self._validated_executable(configured)
        except ProfileError as error:
            raise ProfileError("SERVER_PROFILE_MISMATCH", str(error)) from error
        if not self._same_path(configured_executable, stored_executable):
            raise ProfileError(
                "SERVER_PROFILE_MISMATCH",
                "The saved World ID belongs to another PalServer.exe.",
            )

        world_id = str(row["world_id"])
        self._validate_world_id(world_id)
        root = self._world_root(stored_executable, required=True)
        if root is None:
            raise ProfileError("WORLD_PATH_UNAVAILABLE", "The PalServer world root does not exist.")
        raw_world = Path(str(row["world_path"])).expanduser()
        try:
            assert_no_reparse_points(raw_world)
            world = raw_world.resolve(strict=True)
            expected = (root / world_id).resolve(strict=True)
        except ValueError as error:
            raise ProfileError("PATH_REPARSE_POINT", str(error)) from error
        except (OSError, RuntimeError) as error:
            raise ProfileError(
                "WORLD_BINDING_INVALID", f"{type(error).__name__}: {error}"
            ) from error
        if not self._same_path(world, expected) or world.name != world_id:
            raise ProfileError(
                "WORLD_BINDING_INVALID", "The saved World ID path is outside its world root."
            )
        if not world.is_dir() or not (world / "Level.sav").is_file():
            raise ProfileError("WORLD_BINDING_INVALID", "The saved world is missing or incomplete.")
        try:
            assert_no_reparse_points(world / "Level.sav")
        except ValueError as error:
            raise ProfileError("PATH_REPARSE_POINT", str(error)) from error
        return ServerProfile(
            executable_path=stored_executable,
            install_path=stored_executable.parent,
            world_id=world_id,
            world_path=world,
        )

    def try_profile(self) -> ServerProfile | None:
        try:
            return self.profile()
        except ProfileError:
            return None

    @staticmethod
    def _same_path(left: Path, right: Path) -> bool:
        return os.path.normcase(str(left)) == os.path.normcase(str(right))

    @staticmethod
    def _has_reparse_point(path: Path) -> bool:
        try:
            assert_no_reparse_points(path)
        except ValueError:
            return True
        return False

    @staticmethod
    def _validate_world_id(world_id: str) -> None:
        if (
            not world_id
            or world_id in {".", ".."}
            or "/" in world_id
            or "\\" in world_id
            or ":" in world_id
            or "\x00" in world_id
            or Path(world_id).name != world_id
        ):
            raise ProfileError("INVALID_WORLD_ID", "World ID must be a single safe path component.")

    def _validated_executable(self, path: Path | str) -> Path:
        try:
            return validate_executable(Path(path))
        except ValueError as error:
            code = (
                "PATH_REPARSE_POINT"
                if "reparse point" in str(error).lower()
                else "INVALID_SERVER_PATH"
            )
            raise ProfileError(code, str(error)) from error
        except OSError as error:
            raise ProfileError("INVALID_SERVER_PATH", f"{type(error).__name__}: {error}") from error

    def _validated_directory(self, path: Path) -> Path:
        try:
            assert_no_reparse_points(path)
            resolved = path.resolve(strict=True)
        except ValueError as error:
            raise ProfileError("PATH_REPARSE_POINT", str(error)) from error
        except (OSError, RuntimeError) as error:
            raise ProfileError(
                "SERVER_PROFILE_MISMATCH", f"{type(error).__name__}: {error}"
            ) from error
        if not resolved.is_dir():
            raise ProfileError(
                "SERVER_PROFILE_MISMATCH", "The saved install path is not a directory."
            )
        return resolved

    def _world_root(self, executable: Path, *, required: bool) -> Path | None:
        raw_root = executable.parent.joinpath(*WORLD_ROOT_PARTS)
        try:
            assert_no_reparse_points(raw_root)
        except ValueError as error:
            raise ProfileError("PATH_REPARSE_POINT", str(error)) from error
        if not raw_root.exists():
            if required:
                raise ProfileError(
                    "WORLD_PATH_UNAVAILABLE", "The PalServer world root does not exist."
                )
            return None
        try:
            root = raw_root.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise ProfileError(
                "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
            ) from error
        if not root.is_dir():
            raise ProfileError(
                "WORLD_PATH_UNAVAILABLE", "The PalServer world root is not a directory."
            )
        return root

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
