from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path

from .config import redact_sensitive_text
from .persistence import Database

logger = logging.getLogger(__name__)

PARSER_VERSION = "audit-log-v1"
DEFAULT_RETENTION_DAYS = 30
MAX_DETAIL_LENGTH = 1000
def _safe_detail(value: object) -> object:
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key, item in value.items():
            name = str(key)
            if any(
                token in name.casefold()
                for token in ("password", "token", "secret", "cookie", "authorization")
            ):
                result[name] = "[REDACTED]"
            else:
                result[name] = _safe_detail(item)
        return result
    if isinstance(value, list):
        return [_safe_detail(item) for item in value]
    if isinstance(value, str):
        return redact_sensitive_text(value, max_length=MAX_DETAIL_LENGTH)
    return value


def detail_json(detail: Mapping[str, object] | None = None) -> str:
    return json.dumps(_safe_detail(detail or {}), ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class ParsedLogEvent:
    event_type: str
    detail: dict[str, object]
    capability: str | None = None


class VersionedLogParser:
    """Parse only explicit, versioned PalServer log markers.

    Unrecognised lines are ignored so ordinary diagnostics cannot become fake chat or
    command events. A capability becomes available only after a matching source line.
    """

    version = PARSER_VERSION
    _join = re.compile(r"(?i)\[(?:player|user)\s+(?:joined|connected)\]\s*(?P<body>.*)$")
    _leave = re.compile(r"(?i)\[(?:player|user)\s+(?:left|disconnected)\]\s*(?P<body>.*)$")
    _chat = re.compile(r"^\s*\[(?:Chat|CHAT)\]\s*(?P<name>[^:]{1,120}):\s*(?P<message>.+)$")
    _command = re.compile(r"^\s*\[(?:Command|COMMAND)\]\s*(?P<body>.+)$")

    def parse(self, line: str) -> ParsedLogEvent | None:
        text = line.strip()
        match = self._join.match(text)
        if match:
            return ParsedLogEvent("player.joined", {"raw": text, "subject": match.group("body")})
        match = self._leave.match(text)
        if match:
            return ParsedLogEvent("player.left", {"raw": text, "subject": match.group("body")})
        match = self._chat.match(text)
        if match:
            return ParsedLogEvent(
                "chat.message",
                {"raw": text, "name": match.group("name"), "message": match.group("message")},
                "chat",
            )
        match = self._command.match(text)
        if match:
            return ParsedLogEvent(
                "command.executed", {"raw": text, "command": match.group("body")}, "command"
            )
        return None


def _log_identity(stat: object) -> str:
    # st_ino is often zero on Windows; ctime_ns changes when a file is rotated in place.
    return f"{getattr(stat, 'st_ino', 0)}:{getattr(stat, 'st_ctime_ns', 0)}"


def discover_log_files(install_path: Path) -> list[Path]:
    candidates = [
        install_path / "Pal" / "Saved" / "Logs",
        install_path / "Saved" / "Logs",
        install_path / "Logs",
    ]
    files: list[Path] = []
    for directory in candidates:
        if not directory.is_dir():
            continue
        for path in directory.iterdir():
            if path.is_file() and path.suffix.casefold() in {".log", ".txt"}:
                files.append(path)
    return sorted(set(files), key=lambda item: str(item).casefold())


class AuditService:
    def __init__(
        self,
        database: Database,
        executable_loader: Callable[[], Path | None],
        poll_seconds: float = 5.0,
        retry_base_seconds: float = 1.0,
        retry_max_seconds: float = 60.0,
        maintenance_callback: Callable[[], object] | None = None,
    ) -> None:
        self.database = database
        self.executable_loader = executable_loader
        self.poll_seconds = poll_seconds
        self.retry_base_seconds = max(0.0, retry_base_seconds)
        self.retry_max_seconds = max(self.retry_base_seconds, retry_max_seconds)
        self.maintenance_callback = maintenance_callback
        self.parser = VersionedLogParser()
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._players: dict[str, dict[str, object]] | None = None
        self._capabilities = {"chat": False, "command": False}
        self._started_at: int | None = None
        self._last_run_at: int | None = None
        self._last_success_at: int | None = None
        self._last_error: dict[str, object] | None = None
        self._consecutive_failures = 0
        self._retry_delay_seconds = 0.0

    def start(self) -> None:
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._started_at = int(time.time())
            self._last_run_at = None
            self._last_success_at = None
            self._last_error = None
            self._consecutive_failures = 0
            self._retry_delay_seconds = 0.0
            self._thread = threading.Thread(target=self._run, name="palconsole-audit", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
        self._thread = None

    def status(self) -> dict[str, object]:
        with self._lock:
            thread = self._thread
            return {
                "name": "audit-log",
                "alive": bool(thread and thread.is_alive()),
                "startedAt": self._started_at,
                "lastRunAt": self._last_run_at,
                "lastSuccessAt": self._last_success_at,
                "lastError": dict(self._last_error) if self._last_error else None,
                "consecutiveFailures": self._consecutive_failures,
                "retryDelaySeconds": self._retry_delay_seconds,
            }

    def record(
        self,
        event_type: str,
        result: str = "success",
        detail: Mapping[str, object] | None = None,
        peer_ip: str | None = None,
        source: str = "console",
        dedup_key: str | None = None,
    ) -> int | None:
        return self.database.record_audit_event(
            event_type,
            result,
            detail_json(detail),
            peer_ip,
            source,
            dedup_key,
            self.parser.version if source in {"palserver-log", "console-output"} else None,
        )

    def observe_players(self, value: object, source: str) -> None:
        players = _players_from_value(value)
        current: dict[str, dict[str, object]] = {}
        for index, player in enumerate(players):
            player_id = _player_id(player) or f"unknown:{index}:{_player_name(player)}"
            current[player_id] = player
        with self._lock:
            previous = self._players
            self._players = current
        if previous is None:
            return
        for player_id in sorted(current.keys() - previous.keys()):
            self.record(
                "player.joined",
                detail={"playerId": player_id, "player": current[player_id], "source": source},
                source="player-diff",
            )
        for player_id in sorted(previous.keys() - current.keys()):
            self.record(
                "player.left",
                detail={"playerId": player_id, "player": previous[player_id], "source": source},
                source="player-diff",
            )

    def ingest_line(self, line: str, source: str, dedup_key: str | None = None) -> int | None:
        event = self.parser.parse(line)
        if event is None:
            return None
        with self._lock:
            if event.capability:
                self._capabilities[event.capability] = True
        return self.record(
            event.event_type,
            detail=event.detail,
            source=source,
            dedup_key=dedup_key,
        )

    def ingest_logs_once(self, executable: Path | None = None) -> int:
        executable = executable or self.executable_loader()
        if executable is None:
            return 0
        imported = 0
        for path in discover_log_files(executable.parent):
            try:
                stat = path.stat()
                identity = _log_identity(stat)
                key = str(path.resolve())
                cursor = self.database.log_cursor(key)
                offset = int(str(cursor["offset"])) if cursor else 0
                generation = int(str(cursor["generation"])) if cursor else 0
                if cursor and (
                    str(cursor["file_identity"]) != identity or int(stat.st_size) < offset
                ):
                    offset = 0
                    generation += 1
                with path.open("rb") as handle:
                    handle.seek(offset)
                    content = handle.read()
                next_offset = offset + len(content)
                for relative, raw_line in enumerate(content.splitlines(), start=offset):
                    line = raw_line.decode("utf-8", errors="replace")
                    dedup = hashlib.sha256(
                        f"{key}|{identity}|{generation}|{relative}|{line}".encode()
                    ).hexdigest()
                    if self.ingest_line(line, "palserver-log", dedup):
                        imported += 1
                self.database.set_log_cursor(key, identity, next_offset, generation)
            except OSError:
                continue
        return imported

    def capabilities(self) -> dict[str, object]:
        with self._lock:
            return {
                "parserVersion": self.parser.version,
                "chatSupported": self._capabilities["chat"],
                "commandSupported": self._capabilities["command"],
                "message": "当前数据源不支持聊天或命令事件。"
                if not any(self._capabilities.values())
                else None,
            }

    def prune(self, retention_days: int) -> int:
        if retention_days <= 0:
            return 0
        return self.database.prune_audit_events(int(time.time()) - retention_days * 86400)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                if self.maintenance_callback is not None:
                    self.maintenance_callback()
                self.ingest_logs_once()
                retention = self.database.get_setting("audit.retention_days")
                if retention:
                    with suppress(ValueError):
                        self.prune(int(retention))
                self._record_success()
            except Exception as error:
                self._record_failure("AUDIT_LOOP_ERROR", error)
            with self._lock:
                delay = (
                    self.poll_seconds
                    if self._consecutive_failures == 0
                    else self._retry_delay_seconds
                )
            if self._stop.wait(delay):
                return

    def _record_success(self) -> None:
        now = int(time.time())
        with self._lock:
            self._last_run_at = now
            self._last_success_at = now
            self._consecutive_failures = 0
            self._retry_delay_seconds = 0.0

    def _record_failure(self, code: str, error: BaseException) -> None:
        now = int(time.time())
        error_type = type(error).__name__
        with self._lock:
            self._last_run_at = now
            self._last_error = {"code": code, "type": error_type, "observedAt": now}
            self._consecutive_failures += 1
            exponent = min(self._consecutive_failures - 1, 30)
            self._retry_delay_seconds = min(
                self.retry_max_seconds, self.retry_base_seconds * (2**exponent)
            )
        logger.warning("audit background cycle failed code=%s error_type=%s", code, error_type)


def _players_from_value(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, Mapping) and isinstance(value.get("players"), list):
        return _players_from_value(value["players"])
    return []


def _player_id(player: Mapping[str, object]) -> str:
    for key in ("userId", "userid", "playerId", "playerUid", "id", "steamId"):
        value = player.get(key)
        if value is not None and str(value):
            return str(value)
    return ""


def _player_name(player: Mapping[str, object]) -> str:
    for key in ("name", "playerName", "accountName"):
        value = player.get(key)
        if value is not None and str(value):
            return str(value)
    return "unknown"


def export_json(rows: Iterable[Mapping[str, object]]) -> str:
    return json.dumps(list(rows), ensure_ascii=False, indent=2)


def export_csv(rows: Iterable[Mapping[str, object]]) -> str:
    materialized = list(rows)
    output = io.StringIO()
    fields = ["id", "created_at", "event_type", "result", "source", "peer_ip", "detail_json"]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(materialized)
    return output.getvalue()
