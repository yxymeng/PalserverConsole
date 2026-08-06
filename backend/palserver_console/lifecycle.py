from __future__ import annotations

import base64
import ctypes
import os
import shlex
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol, TypedDict

import httpx
import psutil

from .monitoring import MonitoringConfigError, SensitiveValue, read_connection_config
from .persistence import Database
from .steam import validate_executable

OperationKind = Literal["start", "save", "stop", "restart", "force_stop"]


class ServerStatus(TypedDict):
    configured: bool
    state: Literal["not_configured", "stopped", "running"]
    pids: list[int]
    executablePath: str | None
    errorCode: str | None


class LifecycleError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ProcessHandle(Protocol):
    pid: int

    def poll(self) -> int | None: ...


class ProcessController(Protocol):
    def matching_pids(self, executable: Path) -> list[int]: ...
    def start(self, executable: Path, arguments: tuple[str, ...]) -> ProcessHandle: ...
    def wait_for_exit(self, pids: list[int], timeout: float) -> bool: ...
    def force_stop(self, pids: list[int]) -> None: ...


class RestController(Protocol):
    def announce(self, message: str) -> None: ...
    def save(self) -> None: ...
    def shutdown(self, wait_seconds: int, message: str) -> None: ...


class WindowsProcessController:
    def __init__(self, output_sink: Callable[[str], None] | None = None) -> None:
        self.output_sink = output_sink

    def matching_pids(self, executable: Path) -> list[int]:
        expected = _normalized_path(executable)
        matches: list[int] = []
        for process in psutil.process_iter(["pid", "exe"]):
            try:
                process_exe = process.info.get("exe")
                if process_exe and _normalized_path(Path(process_exe)) == expected:
                    matches.append(int(process.info["pid"]))
            except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
                continue
        return matches

    def start(self, executable: Path, arguments: tuple[str, ...]) -> subprocess.Popen[bytes]:
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        process = subprocess.Popen(
            [str(executable), *arguments],
            cwd=executable.parent,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if self.output_sink else subprocess.DEVNULL,
            stderr=subprocess.STDOUT if self.output_sink else subprocess.DEVNULL,
            creationflags=creation_flags,
        )

        # Keep the pipe drained so a verbose server cannot block on stdout.
        sink = self.output_sink
        if sink is not None and process.stdout is not None:
            def drain() -> None:
                assert process.stdout is not None
                for raw in iter(process.stdout.readline, b""):
                    sink(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
                process.stdout.close()

            threading.Thread(
                target=drain, name=f"palconsole-output-{process.pid}", daemon=True
            ).start()
        return process

    def wait_for_exit(self, pids: list[int], timeout: float) -> bool:
        processes = []
        for pid in pids:
            with suppress(psutil.NoSuchProcess):
                processes.append(psutil.Process(pid))
        _, alive = psutil.wait_procs(processes, timeout=timeout)
        return not alive

    def force_stop(self, pids: list[int]) -> None:
        for pid in pids:
            try:
                process = psutil.Process(pid)
                children = process.children(recursive=True)
                for child in reversed(children):
                    with suppress(psutil.NoSuchProcess):
                        child.kill()
                process.kill()
            except psutil.NoSuchProcess:
                continue


class PalServerRestController:
    def __init__(
        self, base_url: str, admin_password: SensitiveValue, timeout: float = 10.0
    ) -> None:
        token = base64.b64encode(f"admin:{admin_password.reveal()}".encode()).decode("ascii")
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Basic {token}"},
            timeout=timeout,
        )

    def announce(self, message: str) -> None:
        self._post("/v1/api/announce", {"message": message})

    def save(self) -> None:
        self._post("/v1/api/save", {})

    def shutdown(self, wait_seconds: int, message: str) -> None:
        self._post("/v1/api/shutdown", {"waittime": wait_seconds, "message": message})

    def _post(self, path: str, payload: dict[str, object]) -> None:
        try:
            response = self._client.post(path, json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as error:
            raise LifecycleError(
                "REST_HTTP_ERROR",
                f"PalServer REST returned HTTP {error.response.status_code} for {path}.",
            ) from error
        except httpx.HTTPError as error:
            raise LifecycleError("REST_UNAVAILABLE", f"{type(error).__name__}: {error}") from error


@dataclass(frozen=True)
class ServerConfiguration:
    executable: Path
    arguments: tuple[str, ...]
    rest_url: str
    admin_password: SensitiveValue


def parse_arguments(raw: str) -> tuple[str, ...]:
    if not raw.strip():
        return ()
    try:
        if os.name == "nt":
            count = ctypes.c_int()
            command = f"palserver-placeholder.exe {raw}"
            parser = ctypes.windll.shell32.CommandLineToArgvW
            parser.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
            parser.restype = ctypes.POINTER(ctypes.c_wchar_p)
            local_free = ctypes.windll.kernel32.LocalFree
            local_free.argtypes = [ctypes.c_void_p]
            local_free.restype = ctypes.c_void_p
            pointer = parser(command, ctypes.byref(count))
            if not pointer:
                raise ValueError("CommandLineToArgvW returned NULL.")
            try:
                return tuple(pointer[index] for index in range(1, count.value))
            finally:
                local_free(ctypes.cast(pointer, ctypes.c_void_p))
        return tuple(shlex.split(raw, posix=True))
    except ValueError as error:
        raise LifecycleError("INVALID_ARGUMENTS", f"Invalid launch arguments: {error}") from error


class LifecycleManager:
    def __init__(
        self,
        database: Database,
        process: ProcessController | None = None,
        rest_factory: Callable[[ServerConfiguration], RestController] | None = None,
        pending_config_sync: Callable[[], None] | None = None,
        now: Callable[[], float] = time.time,
        audit_callback: Callable[[str, str, dict[str, object]], None] | None = None,
        console_output_sink: Callable[[str], None] | None = None,
    ) -> None:
        self.database = database
        self.process = process or WindowsProcessController(output_sink=console_output_sink)
        self.rest_factory = rest_factory or (
            lambda config: PalServerRestController(config.rest_url, config.admin_password)
        )
        self.pending_config_sync = pending_config_sync
        self.audit_callback = audit_callback
        self.now = now
        self._lock = threading.Lock()
        self._cancellations: dict[str, threading.Event] = {}

    def status(self) -> ServerStatus:
        try:
            config = self.load_configuration()
        except LifecycleError as error:
            return {
                "configured": False,
                "state": "not_configured",
                "pids": [],
                "executablePath": None,
                "errorCode": error.code,
            }
        pids = self.process.matching_pids(config.executable)
        return {
            "configured": True,
            "state": "running" if pids else "stopped",
            "pids": pids,
            "executablePath": str(config.executable),
            "errorCode": None,
        }

    def load_configuration(self) -> ServerConfiguration:
        raw_executable = self.database.get_setting("server.executable")
        if not raw_executable:
            raise LifecycleError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        try:
            executable = validate_executable(Path(raw_executable))
        except (OSError, ValueError) as error:
            raise LifecycleError("INVALID_SERVER_PATH", str(error)) from error
        derived_url, password = _read_rest_configuration(executable.parent)
        return ServerConfiguration(
            executable=executable,
            arguments=parse_arguments(self.database.get_setting("server.arguments") or ""),
            rest_url=derived_url,
            admin_password=password,
        )

    def begin(
        self,
        kind: OperationKind,
        idempotency_key: str,
        countdown_seconds: int = 30,
        message: str = "服务器将在 30 秒后维护，请及时返回安全地点。",
    ) -> dict[str, object]:
        if not idempotency_key.strip():
            raise LifecycleError("IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key。")
        existing = self.database.operation_by_idempotency(idempotency_key)
        if existing is not None:
            return existing
        with self._lock:
            active = self.database.active_operation()
            if active is not None:
                raise LifecycleError("OPERATION_IN_PROGRESS", "已有服务器操作正在进行。")
            operation_id = uuid.uuid4().hex
            operation = self.database.create_operation(operation_id, kind, idempotency_key)
            cancel = threading.Event()
            self._cancellations[operation_id] = cancel
            thread = threading.Thread(
                target=self._run,
                args=(operation_id, kind, countdown_seconds, message, cancel),
                daemon=True,
            )
            thread.start()
            return operation

    def cancel(self, operation_id: str) -> None:
        operation = self.database.operation(operation_id)
        if operation is None:
            raise LifecycleError("OPERATION_NOT_FOUND", "操作不存在。")
        event = self._cancellations.get(operation_id)
        if event is None or operation["stage"] != "countdown":
            raise LifecycleError("OPERATION_NOT_CANCELLABLE", "当前阶段不能取消。")
        event.set()

    def confirm_force_stop(self, operation_id: str, idempotency_key: str) -> dict[str, object]:
        parent = self.database.operation(operation_id)
        if parent is None or parent["state"] != "awaiting_force_confirmation":
            raise LifecycleError("FORCE_CONFIRMATION_NOT_AVAILABLE", "当前没有待确认的强制停止。")
        return self.begin("force_stop", idempotency_key, countdown_seconds=0, message=operation_id)

    def _run(
        self,
        operation_id: str,
        kind: OperationKind,
        countdown_seconds: int,
        message: str,
        cancel: threading.Event,
    ) -> None:
        try:
            config = self.load_configuration()
            if kind == "start":
                self._start(operation_id, config)
            elif kind == "save":
                self._save(operation_id, config)
            elif kind == "force_stop":
                self._force_stop(operation_id, config)
            else:
                self._stop_or_restart(
                    operation_id, config, kind == "restart", countdown_seconds, message, cancel
                )
            final = self.database.operation(operation_id)
            self._audit(
                operation_id,
                "cancelled" if final and final["state"] == "cancelled" else "success",
            )
        except LifecycleError as error:
            self.database.update_operation(operation_id, "failed", "failed", error.code, str(error))
            self._audit(operation_id, "failed", {"errorCode": error.code, "error": str(error)})
        except Exception as error:
            self.database.update_operation(
                operation_id,
                "failed",
                "failed",
                "UNEXPECTED_ERROR",
                f"{type(error).__name__}: {error}",
            )
            self._audit(
                operation_id,
                "failed",
                {"errorCode": "UNEXPECTED_ERROR", "error": f"{type(error).__name__}: {error}"},
            )
        finally:
            self._cancellations.pop(operation_id, None)

    def _audit(
        self, operation_id: str, result: str, extra: dict[str, object] | None = None
    ) -> None:
        if self.audit_callback is None:
            return
        operation = self.database.operation(operation_id)
        if operation is None:
            return
        detail: dict[str, object] = {
            "operationId": operation_id,
            "kind": operation["kind"],
            "stage": operation["stage"],
        }
        if extra:
            detail.update(extra)
        self.audit_callback("server.operation", result, detail)

    def _start(self, operation_id: str, config: ServerConfiguration) -> None:
        if self.process.matching_pids(config.executable):
            raise LifecycleError("ALREADY_RUNNING", "该安装路径的 PalServer 已在运行。")
        self.database.update_operation(operation_id, "running", "starting")
        handle = self.process.start(config.executable, config.arguments)
        time.sleep(0.2)
        if handle.poll() is not None:
            raise LifecycleError("START_FAILED", "PalServer process exited during startup.")
        self.database.update_operation(operation_id, "succeeded", "process_running")

    def _save(self, operation_id: str, config: ServerConfiguration) -> None:
        self._require_running(config)
        self.database.update_operation(operation_id, "running", "saving")
        self.rest_factory(config).save()
        self.database.update_operation(operation_id, "succeeded", "saved")

    def _stop_or_restart(
        self,
        operation_id: str,
        config: ServerConfiguration,
        restart: bool,
        countdown_seconds: int,
        message: str,
        cancel: threading.Event,
    ) -> None:
        pids = self._require_running(config)
        rest = self.rest_factory(config)
        self.database.update_operation(operation_id, "running", "countdown")
        if countdown_seconds:
            rest.announce(message)
            if cancel.wait(countdown_seconds):
                self.database.update_operation(operation_id, "cancelled", "cancelled")
                return
        self.database.update_operation(operation_id, "running", "saving")
        rest.save()
        self.database.update_operation(operation_id, "running", "shutting_down")
        rest.shutdown(0, message)
        if not self.process.wait_for_exit(pids, timeout=30):
            self.database.update_operation(
                operation_id,
                "awaiting_force_confirmation",
                "shutdown_timeout",
                "SHUTDOWN_TIMEOUT",
                "PalServer did not exit within 30 seconds.",
            )
            return
        self.database.update_operation(operation_id, "running", "pending_config_sync")
        if self.pending_config_sync is not None:
            self.pending_config_sync()
        if restart:
            self.database.update_operation(operation_id, "running", "restarting")
            handle = self.process.start(config.executable, config.arguments)
            time.sleep(0.2)
            if handle.poll() is not None:
                raise LifecycleError("RESTART_FAILED", "PalServer process exited during restart.")
        self.database.update_operation(
            operation_id, "succeeded", "restarted" if restart else "stopped"
        )

    def _force_stop(self, operation_id: str, config: ServerConfiguration) -> None:
        pids = self._require_running(config)
        self.database.update_operation(operation_id, "running", "force_stopping")
        self.process.force_stop(pids)
        if not self.process.wait_for_exit(pids, timeout=10):
            raise LifecycleError(
                "FORCE_STOP_FAILED", "PalServer process remained alive after kill()."
            )
        self.database.update_operation(operation_id, "succeeded", "force_stopped")

    def _require_running(self, config: ServerConfiguration) -> list[int]:
        pids = self.process.matching_pids(config.executable)
        if not pids:
            raise LifecycleError("SERVER_NOT_RUNNING", "该安装路径的 PalServer 未运行。")
        return pids


def _normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.realpath(path))


def _read_rest_configuration(install_path: Path) -> tuple[str, SensitiveValue]:
    try:
        connection = read_connection_config(install_path)
    except MonitoringConfigError as error:
        raise LifecycleError(error.code, str(error)) from error
    if not connection.rest_enabled:
        raise LifecycleError("REST_DISABLED", "PalServer REST API is disabled.")
    return connection.rest_url, connection.admin_password
