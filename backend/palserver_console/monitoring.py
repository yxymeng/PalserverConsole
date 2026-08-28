from __future__ import annotations

import base64
import csv
import io
import json
import logging
import re
import socket
import struct
import threading
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import httpx
import psutil

from .config import redact_sensitive_text

logger = logging.getLogger(__name__)


class MonitoringConfigError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class SourceError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class SensitiveValue:
    """A small wrapper that prevents credentials from appearing in logs or repr()."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "SensitiveValue([REDACTED])"

    def __str__(self) -> str:
        return "[REDACTED]"


@dataclass(frozen=True)
class ServerConnectionConfig:
    rest_url: str
    rest_enabled: bool
    rcon_host: str
    rcon_port: int
    rcon_enabled: bool
    admin_password: SensitiveValue


def read_connection_config(install_path: Path) -> ServerConnectionConfig:
    ini_path = install_path / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    try:
        text = ini_path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise MonitoringConfigError(
            "INI_UNAVAILABLE", f"PalWorldSettings.ini: {type(error).__name__}"
        ) from error
    return parse_connection_config(text)


def read_admin_password(install_path: Path) -> str | None:
    """Read the game administrator password without exposing it in a response or log."""

    ini_path = install_path / "Pal" / "Saved" / "Config" / "WindowsServer" / "PalWorldSettings.ini"
    try:
        text = ini_path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise MonitoringConfigError(
            "INI_UNAVAILABLE", f"PalWorldSettings.ini: {type(error).__name__}"
        ) from error
    password = _ini_value(text, "AdminPassword")
    return password or None


def parse_connection_config(text: str) -> ServerConnectionConfig:
    password = _ini_value(text, "AdminPassword")
    if password is None:
        raise MonitoringConfigError("ADMIN_PASSWORD_MISSING", "AdminPassword is not configured.")
    rest_enabled = _ini_bool(text, "RESTAPIEnabled", True)
    rest_port = _ini_int(text, "RESTAPIPort", 8212)
    rcon_enabled = _ini_bool(text, "RCONEnabled", False)
    rcon_port = _ini_int(text, "RCONPort", 25575)
    if not 1 <= rest_port <= 65535 or not 1 <= rcon_port <= 65535:
        raise MonitoringConfigError(
            "INVALID_API_PORT", "REST/RCON port must be between 1 and 65535."
        )
    return ServerConnectionConfig(
        rest_url=f"http://127.0.0.1:{rest_port}",
        rest_enabled=rest_enabled,
        rcon_host="127.0.0.1",
        rcon_port=rcon_port,
        rcon_enabled=rcon_enabled,
        admin_password=SensitiveValue(password),
    )


def _ini_value(text: str, key: str) -> str | None:
    match = re.search(
        rf"(?i)(?:^|[,(\rn])\s*{re.escape(key)}\s*=\s*(?:\"((?:\\\\.|[^\"\\\\])*)\"|([^,)\rn]+))",
        text,
    )
    if match is None:
        return None
    value = match.group(1) if match.group(1) is not None else (match.group(2) or "")
    return value.replace(r"\"", '"').replace(r"\\", "\\").strip()


def _ini_bool(text: str, key: str, default: bool) -> bool:
    value = _ini_value(text, key)
    return default if value is None else value.casefold() == "true"


def _ini_int(text: str, key: str, default: int) -> int:
    value = _ini_value(text, key)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError as error:
        raise MonitoringConfigError("INVALID_API_PORT", f"{key} must be an integer.") from error


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]"
            if any(token in str(key).casefold() for token in ("password", "token", "secret"))
            else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


class RestReadonly(Protocol):
    def info(self) -> Any: ...

    def players(self) -> Any: ...

    def metrics(self) -> Any: ...

    def settings(self) -> Any: ...


class RestActions(RestReadonly, Protocol):
    def announce(self, message: str) -> None: ...

    def kick(self, player_id: str, message: str) -> None: ...

    def ban(self, player_id: str, message: str) -> None: ...

    def unban(self, player_id: str) -> None: ...

    def close(self) -> None: ...


class PalServerRestClient:
    def __init__(self, config: ServerConnectionConfig, timeout: float = 5.0) -> None:
        credential = base64.b64encode(f"admin:{config.admin_password.reveal()}".encode()).decode(
            "ascii"
        )
        self._client = httpx.Client(
            base_url=config.rest_url.rstrip("/"),
            headers={"Authorization": f"Basic {credential}"},
            timeout=timeout,
            trust_env=False,
        )

    def info(self) -> Any:
        return self._get("/v1/api/info")

    def players(self) -> Any:
        return self._get("/v1/api/players")

    def metrics(self) -> Any:
        return self._get("/v1/api/metrics")

    def settings(self) -> Any:
        return _redact(self._get("/v1/api/settings"))

    def announce(self, message: str) -> None:
        self._post("/v1/api/announce", {"message": message})

    def kick(self, player_id: str, message: str) -> None:
        self._post("/v1/api/kick", {"userid": player_id, "message": message})

    def ban(self, player_id: str, message: str) -> None:
        self._post("/v1/api/ban", {"userid": player_id, "message": message})

    def unban(self, player_id: str) -> None:
        self._post("/v1/api/unban", {"userid": player_id})

    def close(self) -> None:
        self._client.close()

    def _get(self, path: str) -> Any:
        return self._request("GET", path)

    def _post(self, path: str, payload: dict[str, object]) -> None:
        self._request("POST", path, payload)

    def _request(self, method: str, path: str, payload: dict[str, object] | None = None) -> Any:
        try:
            response = self._client.request(method, path, json=payload)
        except httpx.TimeoutException as error:
            raise SourceError(
                "REST_TIMEOUT", f"{type(error).__name__}: request timed out"
            ) from error
        except httpx.ConnectError as error:
            raise SourceError(
                "REST_CONNECTION_REFUSED", f"{type(error).__name__}: {error}"
            ) from error
        except httpx.HTTPError as error:
            raise SourceError("REST_REQUEST_ERROR", f"{type(error).__name__}: {error}") from error
        if response.status_code >= 400:
            code = {
                401: "REST_UNAUTHORIZED",
                403: "REST_FORBIDDEN",
                404: "REST_NOT_FOUND",
                409: "REST_CONFLICT",
            }.get(
                response.status_code,
                "REST_SERVER_ERROR" if response.status_code >= 500 else "REST_HTTP_ERROR",
            )
            detail = _safe_error_text(response.text)
            raise SourceError(code, f"HTTP {response.status_code}: {detail}", response.status_code)
        if method == "POST":
            return None
        try:
            return _redact(response.json())
        except ValueError as error:
            raise SourceError(
                "REST_NON_JSON", "REST response was not valid JSON.", response.status_code
            ) from error


def _safe_error_text(text: str) -> str:
    return redact_sensitive_text(text, max_length=300)


class RconReadonly(Protocol):
    def info(self) -> Any: ...

    def players(self) -> Any: ...


class PalServerRconClient:
    """Minimal Source RCON client exposing only the two read-only commands."""

    def __init__(self, config: ServerConnectionConfig, timeout: float = 3.0) -> None:
        self.host = config.rcon_host
        self.port = config.rcon_port
        self.password = config.admin_password
        self.timeout = timeout

    def info(self) -> Any:
        return self._command("Info")

    def players(self) -> Any:
        payload = self._command("ShowPlayers")
        if isinstance(payload, Mapping) and isinstance(payload.get("raw"), str):
            payload = payload["raw"]
        if not isinstance(payload, str):
            raise SourceError(
                "RCON_PLAYERS_UNSUPPORTED_FORMAT",
                "RCON ShowPlayers response is not a supported text format.",
            )
        return _parse_showplayers_text(payload)

    def _command(self, command: str) -> Any:
        try:
            with socket.create_connection(
                (self.host, self.port), timeout=self.timeout
            ) as connection:
                connection.settimeout(self.timeout)
                request_id = int(uuid.uuid4().int & 0x7FFFFFFF)
                self._send(connection, request_id, 3, self.password.reveal())
                auth = self._receive(connection)
                if auth is None or auth[0] == -1:
                    raise SourceError("RCON_UNAUTHORIZED", "RCON authentication failed.")
                self._send(connection, request_id, 2, command)
                packet = self._receive(connection)
                if packet is None:
                    raise SourceError("RCON_EMPTY_RESPONSE", "RCON returned an empty response.")
                return _parse_rcon_payload(packet[2])
        except SourceError:
            raise
        except TimeoutError as error:
            raise SourceError("RCON_TIMEOUT", "RCON request timed out.") from error
        except ConnectionRefusedError as error:
            raise SourceError(
                "RCON_CONNECTION_REFUSED", f"ConnectionRefusedError: {error}"
            ) from error
        except OSError as error:
            raise SourceError(
                "RCON_CONNECTION_ERROR", f"{type(error).__name__}: {error}"
            ) from error

    @staticmethod
    def _send(connection: socket.socket, request_id: int, packet_type: int, body: str) -> None:
        payload = struct.pack("<ii", request_id, packet_type) + body.encode() + b"\x00\x00"
        connection.sendall(struct.pack("<i", len(payload)) + payload)

    @staticmethod
    def _receive(connection: socket.socket) -> tuple[int, int, str] | None:
        size_bytes = _receive_exact(connection, 4)
        if not size_bytes:
            return None
        size = struct.unpack("<i", size_bytes)[0]
        if size < 10 or size > 4 * 1024 * 1024:
            raise SourceError("RCON_INVALID_PACKET", "RCON packet length is invalid.")
        payload = _receive_exact(connection, size)
        if payload is None or len(payload) < 10:
            raise SourceError("RCON_INVALID_PACKET", "RCON packet is truncated.")
        request_id, packet_type = struct.unpack("<ii", payload[:8])
        body = payload[8:-2].decode("utf-8", errors="replace")
        return request_id, packet_type, body


def _receive_exact(connection: socket.socket, size: int) -> bytes | None:
    result = bytearray()
    while len(result) < size:
        chunk = connection.recv(size - len(result))
        if not chunk:
            return None
        result.extend(chunk)
    return bytes(result)


def _parse_rcon_payload(payload: str) -> Any:
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"raw": payload}


def _parse_showplayers_text(payload: str) -> list[dict[str, str]]:
    """Parse the documented ``name,playeruid,steamid`` ShowPlayers response."""

    try:
        rows = [
            row
            for row in csv.reader(io.StringIO(payload))
            if any(cell.strip() for cell in row)
        ]
    except csv.Error as error:
        raise SourceError(
            "RCON_PLAYERS_UNSUPPORTED_FORMAT",
            "RCON ShowPlayers response is not a supported CSV format.",
        ) from error
    if not rows or [cell.strip().casefold() for cell in rows[0]] != [
        "name",
        "playeruid",
        "steamid",
    ]:
        raise SourceError(
            "RCON_PLAYERS_UNSUPPORTED_FORMAT",
            "RCON ShowPlayers response is missing the name,playeruid,steamid header.",
        )
    players: list[dict[str, str]] = []
    for row in rows[1:]:
        if len(row) != 3:
            raise SourceError(
                "RCON_PLAYERS_UNSUPPORTED_FORMAT",
                "RCON ShowPlayers response contains a malformed player row.",
            )
        name, player_uid, steam_id = (value.strip() for value in row)
        if not name or not player_uid or not steam_id:
            raise SourceError(
                "RCON_PLAYERS_UNSUPPORTED_FORMAT",
                "RCON ShowPlayers response contains an incomplete player row.",
            )
        players.append({"name": name, "playerUid": player_uid, "steamId": steam_id})
    return players


@dataclass(frozen=True)
class _ProcessSample:
    created_at: float
    observed_at: float
    cpu_seconds: float
    read_bytes: int
    write_bytes: int


class ProcessMetricsCollector:
    def __init__(
        self,
        process_lookup: Callable[[Path], list[psutil.Process]] | None = None,
        clock: Callable[[], float] | None = None,
        logical_cpu_count: Callable[[], int | None] | None = None,
    ) -> None:
        self._process_lookup = process_lookup or self._find_processes
        self._clock = clock or time.monotonic
        self._logical_cpu_count = max(
            1, int((logical_cpu_count or psutil.cpu_count)() or 1)
        )
        self._samples: dict[int, _ProcessSample] = {}
        self._lock = threading.Lock()

    def collect(self, executable: Path) -> tuple[dict[str, object], str | None]:
        processes = self._process_lookup(executable)
        if not processes:
            with self._lock:
                self._samples.clear()
            return self._empty_metrics(), "PROCESS_NOT_RUNNING"

        observed_at = self._clock()
        with self._lock:
            cpu_percent = 0.0
            read_bytes_per_second = 0.0
            write_bytes_per_second = 0.0
            memory = 0
            read_bytes = 0
            write_bytes = 0
            started_at: float | None = None
            pids: list[int] = []
            ready_samples = 0
            current_samples: dict[int, _ProcessSample] = {}
            for process in processes:
                try:
                    pid = int(process.pid)
                    process_started_at = float(process.create_time())
                    cpu_times = process.cpu_times()
                    cpu_seconds = float(cpu_times.user) + float(cpu_times.system)
                    rss = int(process.memory_info().rss)
                    io = process.io_counters()
                    process_read_bytes = int(io.read_bytes)
                    process_write_bytes = int(io.write_bytes)
                except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                    continue

                pids.append(pid)
                memory += rss
                read_bytes += process_read_bytes
                write_bytes += process_write_bytes
                if process_started_at > 0 and (
                    started_at is None or process_started_at < started_at
                ):
                    started_at = process_started_at

                previous = self._samples.get(pid)
                if (
                    previous is not None
                    and previous.created_at == process_started_at
                    and observed_at > previous.observed_at
                ):
                    elapsed = observed_at - previous.observed_at
                    cpu_percent += (
                        max(0.0, cpu_seconds - previous.cpu_seconds)
                        / elapsed
                        * 100
                        / self._logical_cpu_count
                    )
                    read_bytes_per_second += (
                        max(0, process_read_bytes - previous.read_bytes) / elapsed
                    )
                    write_bytes_per_second += (
                        max(0, process_write_bytes - previous.write_bytes) / elapsed
                    )
                    ready_samples += 1
                current_samples[pid] = _ProcessSample(
                    created_at=process_started_at,
                    observed_at=observed_at,
                    cpu_seconds=cpu_seconds,
                    read_bytes=process_read_bytes,
                    write_bytes=process_write_bytes,
                )
            self._samples = current_samples

        if not pids:
            return self._empty_metrics(), "PROCESS_METRICS_UNAVAILABLE"
        sampled = ready_samples > 0
        return {
            "pids": pids,
            # Match Windows Task Manager: 100% means all logical processors are saturated.
            "cpuPercent": round(cpu_percent, 2),
            "cpuReady": sampled,
            "memoryBytes": memory,
            # Keep cumulative counters for API compatibility; the UI uses the explicit rates below.
            "diskReadBytes": read_bytes,
            "diskWriteBytes": write_bytes,
            "diskReadBytesPerSecond": round(read_bytes_per_second, 2),
            "diskWriteBytesPerSecond": round(write_bytes_per_second, 2),
            "ioReady": sampled,
            "startedAt": int(started_at) if started_at is not None else None,
        }, None

    @staticmethod
    def _empty_metrics() -> dict[str, object]:
        return {
            "pids": [],
            "cpuPercent": 0.0,
            "cpuReady": False,
            "memoryBytes": 0,
            "diskReadBytes": 0,
            "diskWriteBytes": 0,
            "diskReadBytesPerSecond": 0.0,
            "diskWriteBytesPerSecond": 0.0,
            "ioReady": False,
            "startedAt": None,
        }

    @staticmethod
    def _find_processes(executable: Path) -> list[psutil.Process]:
        expected = str(executable.resolve()).casefold()
        roots: list[psutil.Process] = []
        for process in psutil.process_iter(["pid", "exe"]):
            try:
                value = process.info.get("exe")
                if value and str(Path(value).resolve()).casefold() == expected:
                    roots.append(process)
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                continue

        # PalServer.exe is a small launcher.  The real server load lives in its
        # PalServer-Win64-Shipping-Cmd.exe child, so metrics must cover the tree.
        result = {int(process.pid): process for process in roots}
        for root in roots:
            try:
                for child in root.children(recursive=True):
                    result[int(child.pid)] = child
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                continue
        return [result[pid] for pid in sorted(result)]


@dataclass
class LiveValue:
    value: Any = None
    source: str = "unavailable"
    observed_at: int = 0
    stale: bool = True
    error_code: str | None = "NOT_COLLECTED"

    def as_dict(self) -> dict[str, Any]:
        return {
            "data": self.value,
            "source": self.source,
            "observedAt": self.observed_at,
            "stale": self.stale,
            "errorCode": self.error_code,
        }


@dataclass
class LiveState:
    info: LiveValue = field(default_factory=lambda: LiveValue(value={}))
    players: LiveValue = field(default_factory=lambda: LiveValue(value=[]))
    metrics: LiveValue = field(default_factory=lambda: LiveValue(value={}))
    settings: LiveValue = field(default_factory=lambda: LiveValue(value={}))

    def as_dict(self) -> dict[str, Any]:
        return {
            "info": self.info.as_dict(),
            "players": self.players.as_dict(),
            "metrics": self.metrics.as_dict(),
            "settings": self.settings.as_dict(),
        }


class MonitorCoordinator:
    def __init__(
        self,
        config_loader: Callable[[], tuple[Path, ServerConnectionConfig]],
        rest_factory: Callable[[ServerConnectionConfig], RestReadonly] | None = None,
        rcon_factory: Callable[[ServerConnectionConfig], RconReadonly] | None = None,
        process_metrics: ProcessMetricsCollector | None = None,
        interval_seconds: float = 5.0,
        players_observer: Callable[[Any, str], None] | None = None,
        retry_base_seconds: float = 1.0,
        retry_max_seconds: float = 60.0,
    ) -> None:
        self.config_loader = config_loader
        self.rest_factory = rest_factory or PalServerRestClient
        self.rcon_factory = rcon_factory or PalServerRconClient
        self.process_metrics = process_metrics or ProcessMetricsCollector()
        self.players_observer = players_observer
        self.interval_seconds = interval_seconds
        self.retry_base_seconds = max(0.0, retry_base_seconds)
        self.retry_max_seconds = max(self.retry_base_seconds, retry_max_seconds)
        self.state = LiveState()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._sequence = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._started_at: int | None = None
        self._last_run_at: int | None = None
        self._last_success_at: int | None = None
        self._last_error: dict[str, object] | None = None
        self._consecutive_failures = 0
        self._retry_delay_seconds = 0.0
        self._cycle_succeeded = False

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
            self._cycle_succeeded = False
            self._thread = threading.Thread(target=self._run, name="palconsole-live", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._condition:
            self._condition.notify_all()
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)
        self._thread = None

    def status(self) -> dict[str, object]:
        with self._lock:
            thread = self._thread
            return {
                "name": "live-monitor",
                "alive": bool(thread and thread.is_alive()),
                "startedAt": self._started_at,
                "lastRunAt": self._last_run_at,
                "lastSuccessAt": self._last_success_at,
                "lastError": dict(self._last_error) if self._last_error else None,
                "consecutiveFailures": self._consecutive_failures,
                "retryDelaySeconds": self._retry_delay_seconds,
            }

    def collect_once(self) -> dict[str, Any]:
        try:
            executable, config = self.config_loader()
        except MonitoringConfigError as error:
            self._record_failure(error.code, error)
            self._mark_error(error.code)
            return self.snapshot()
        now = int(time.time())
        rest: RestReadonly | None = None
        if config.rest_enabled:
            rest = self.rest_factory(config)
        rcon: RconReadonly | None = None
        try:
            rcon = self.rcon_factory(config) if config.rcon_enabled else None
        except Exception:
            rcon = None
        try:
            self._collect_value("info", rest, rcon, "info", now)
            self._collect_value("players", rest, rcon, "players", now)
            if self.players_observer is not None:
                with self._lock:
                    players_value = self.state.players.value
                    players_source = self.state.players.source
                    players_stale = self.state.players.stale
                if not players_stale:
                    self.players_observer(players_value, players_source)
            rest_metrics, rest_error = self._source_value(rest, "metrics")
            process_value, process_error = self.process_metrics.collect(executable)
            self._set_value(
                "metrics",
                {"server": rest_metrics, "process": process_value},
                "rest+process",
                now,
                _join_errors(rest_error, process_error),
            )
            self._collect_value("settings", rest, None, "settings", now, fallback=False)
        finally:
            _close_source(rest)
        self._publish()
        self._record_success()
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self.state.as_dict()

    def stream(self) -> Iterator[str]:
        with self._lock:
            sequence = self._sequence
            initial = self.snapshot()
        yield _sse_event("snapshot", initial)
        while not self._stop.is_set():
            with self._condition:
                expected_sequence = sequence

                def has_new_snapshot(expected: int = expected_sequence) -> bool:
                    return self._sequence != expected or self._stop.is_set()

                self._condition.wait_for(
                    has_new_snapshot,
                    timeout=15,
                )
                if self._stop.is_set():
                    return
                sequence = self._sequence
                snapshot = self.snapshot()
            yield _sse_event("snapshot", snapshot)

    def action(self, name: str, *args: str) -> None:
        try:
            _, config = self.config_loader()
            if not config.rest_enabled:
                raise SourceError("REST_DISABLED", "PalServer REST API is disabled.")
            client = self.rest_factory(config)
            try:
                method = getattr(client, name)
                method(*args)
            finally:
                _close_source(client)
        except MonitoringConfigError as error:
            raise SourceError(error.code, str(error)) from error

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.collect_once()
            except Exception as error:
                self._record_failure("MONITOR_LOOP_ERROR", error)
            with self._lock:
                delay = (
                    self.interval_seconds
                    if self._cycle_succeeded
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
            self._cycle_succeeded = True

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
            self._cycle_succeeded = False
        logger.warning("monitor background cycle failed code=%s error_type=%s", code, error_type)

    def _collect_value(
        self,
        name: str,
        rest: RestReadonly | None,
        rcon: RconReadonly | None,
        method: str,
        now: int,
        fallback: bool = True,
    ) -> None:
        value, error = self._source_value(rest, method)
        source = "rest"
        if error and fallback and rcon is not None:
            value, rcon_error = self._source_value(rcon, method)
            if rcon_error is None:
                error, source = None, "rcon"
            else:
                error = f"{error};{rcon_error}"
        self._set_value(name, value, source if error is None else source, now, error)

    @staticmethod
    def _source_value(source: Any, method: str) -> tuple[Any, str | None]:
        if source is None:
            return {}, "SOURCE_DISABLED"
        try:
            return getattr(source, method)(), None
        except SourceError as error:
            return None, error.code
        except (httpx.HTTPError, OSError) as error:
            return None, type(error).__name__.upper()

    def _set_value(
        self, name: str, value: Any, source: str, observed_at: int, error: str | None
    ) -> None:
        with self._lock:
            current = getattr(self.state, name)
            if error is None:
                (
                    current.value,
                    current.source,
                    current.observed_at,
                    current.stale,
                    current.error_code,
                ) = _redact(value), source, observed_at, False, None
            else:
                current.stale, current.error_code = True, error

    def _mark_error(self, code: str) -> None:
        with self._lock:
            for value in (
                self.state.info,
                self.state.players,
                self.state.metrics,
                self.state.settings,
            ):
                value.stale, value.error_code = True, code
        self._publish()

    def _publish(self) -> None:
        with self._condition:
            self._sequence += 1
            self._condition.notify_all()


def _join_errors(*errors: str | None) -> str | None:
    values = [error for error in errors if error]
    return ";".join(values) if values else None


def _close_source(source: object | None) -> None:
    closer = getattr(source, "close", None)
    if callable(closer):
        closer()


def _sse_event(event: str, data: Any) -> str:
    return (
        f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, separators=(',', ':'))}\n\n"
    )
