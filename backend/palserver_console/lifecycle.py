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

from .config import ProfileError, ServerProfile
from .monitoring import MonitoringConfigError, SensitiveValue, read_connection_config
from .persistence import Database, OperationReservationError, OperationTransitionError
from .steam import validate_executable

OperationKind = Literal[
    "start", "save", "stop", "restart", "force_stop", "apply_config_and_restart"
]
FORCE_CONFIRMATION_TTL_SECONDS = 120
PROFILE_ERROR_CODES = frozenset(
    {
        "WORLD_PROFILE_REQUIRED",
        "WORLD_SELECTION_REQUIRED",
        "WORLD_NOT_FOUND",
        "WORLD_BINDING_INVALID",
        "WORLD_PATH_UNAVAILABLE",
        "SERVER_PROFILE_MISMATCH",
        "PATH_REPARSE_POINT",
    }
)


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
        now: Callable[[], float] = time.time,
        audit_callback: Callable[[str, str, dict[str, object]], None] | None = None,
        console_output_sink: Callable[[str], None] | None = None,
        profile_provider: Callable[[], ServerProfile] | None = None,
    ) -> None:
        self.database = database
        self.process = process or WindowsProcessController(output_sink=console_output_sink)
        self.rest_factory = rest_factory or (
            lambda config: PalServerRestController(config.rest_url, config.admin_password)
        )
        self._config_apply: Callable[[], dict[str, object]] | None = None
        self.audit_callback = audit_callback
        self.profile_provider = profile_provider
        self.now = now
        self._lock = threading.Lock()
        self._cancellations: dict[str, threading.Event] = {}

    def set_config_apply(self, apply: Callable[[], dict[str, object]]) -> None:
        """Register the only callback allowed to write a pending INI draft."""
        self._config_apply = apply

    def status(self) -> ServerStatus:
        try:
            config = self.load_configuration()
        except LifecycleError as error:
            raw_executable = self.database.get_setting("server.executable")
            if raw_executable and error.code in PROFILE_ERROR_CODES:
                return {
                    "configured": True,
                    "state": "stopped",
                    "pids": [],
                    "executablePath": raw_executable,
                    "errorCode": error.code,
                }
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
        if self.profile_provider is not None:
            try:
                executable = self.profile_provider().executable_path
            except ProfileError as error:
                raise LifecycleError(error.code, str(error)) from error
        else:
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
        *,
        parent_operation_id: str | None = None,
    ) -> dict[str, object]:
        if not idempotency_key.strip():
            raise LifecycleError("IDEMPOTENCY_KEY_REQUIRED", "缺少 Idempotency-Key。")
        if kind == "force_stop" and parent_operation_id is None:
            raise LifecycleError(
                "FORCE_CONFIRMATION_REQUIRED", "强制停止必须来自有效的停服确认。"
            )
        with self._lock:
            try:
                operation, created = self.database.reserve_operation(
                    uuid.uuid4().hex,
                    kind,
                    idempotency_key,
                    parent_operation_id=parent_operation_id,
                    now=self.now(),
                )
            except OperationReservationError as error:
                if error.code == "FORCE_CONFIRMATION_EXPIRED" and error.operation_id:
                    self._transition(
                        error.operation_id,
                        "failed",
                        "force_confirmation_expired",
                        error.code,
                        str(error),
                    )
                    self._audit(
                        error.operation_id,
                        "failed",
                        {"errorCode": error.code, "transition": "force_confirmation_expired"},
                    )
                raise LifecycleError(error.code, str(error)) from error
            if not created:
                return operation
            operation_id = str(operation["id"])
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
        return self.begin(
            "force_stop",
            idempotency_key,
            countdown_seconds=0,
            message=operation_id,
            parent_operation_id=operation_id,
        )

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
                self._complete_force_parent(operation_id, succeeded=True)
            elif kind == "apply_config_and_restart":
                self._apply_config_and_restart(
                    operation_id, config, countdown_seconds, message, cancel
                )
            else:
                self._stop_or_restart(
                    operation_id, config, kind == "restart", countdown_seconds, message, cancel
                )
            final = self.database.operation(operation_id)
            result = "success"
            if final and final["state"] == "cancelled":
                result = "cancelled"
            elif final and final["state"] == "awaiting_force_confirmation":
                result = "awaiting_confirmation"
            self._audit(
                operation_id,
                result,
            )
        except LifecycleError as error:
            self._transition(operation_id, "failed", "failed", error.code, str(error))
            self._complete_force_parent(
                operation_id, succeeded=False, error_code=error.code, detail=str(error)
            )
            self._audit(operation_id, "failed", {"errorCode": error.code, "error": str(error)})
        except Exception as error:
            detail = f"{type(error).__name__}: {error}"
            self._transition(
                operation_id,
                "failed",
                "failed",
                "UNEXPECTED_ERROR",
                detail,
            )
            self._complete_force_parent(
                operation_id,
                succeeded=False,
                error_code="UNEXPECTED_ERROR",
                detail=detail,
            )
            self._audit(
                operation_id,
                "failed",
                {"errorCode": "UNEXPECTED_ERROR", "error": detail},
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

    def _transition(
        self,
        operation_id: str,
        state: str,
        stage: str,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> dict[str, object]:
        before = self.database.operation(operation_id)
        updated = self.database.transition_operation(
            operation_id, state, stage, error_code, detail
        )
        if self.audit_callback is not None:
            transition_detail: dict[str, object] = {
                "operationId": operation_id,
                "kind": updated["kind"],
                "fromState": before["state"] if before else None,
                "fromStage": before["stage"] if before else None,
                "state": updated["state"],
                "stage": updated["stage"],
            }
            self.audit_callback("server.operation.transition", "state_changed", transition_detail)
        return updated

    def _complete_force_parent(
        self,
        operation_id: str,
        *,
        succeeded: bool,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> None:
        child = self.database.operation(operation_id)
        if child is None or not isinstance(child.get("parent_operation_id"), str):
            return
        parent_id = str(child["parent_operation_id"])
        parent = self.database.operation(parent_id)
        if parent is None or parent["state"] != "awaiting_force_confirmation":
            return
        try:
            if succeeded:
                self._transition(parent_id, "succeeded", "force_stopped")
                self._audit(parent_id, "success", {"forcedBy": operation_id})
            else:
                self._transition(
                    parent_id,
                    "failed",
                    "force_stop_failed",
                    error_code,
                    detail,
                )
                self._audit(
                    parent_id,
                    "failed",
                    {"errorCode": error_code, "forcedBy": operation_id},
                )
        except OperationTransitionError:
            # A console restart or another recovery path may have closed the parent.
            return

    def _start(self, operation_id: str, config: ServerConfiguration) -> None:
        if self.process.matching_pids(config.executable):
            raise LifecycleError("ALREADY_RUNNING", "该安装路径的 PalServer 已在运行。")
        self._transition(operation_id, "running", "starting")
        handle = self.process.start(config.executable, config.arguments)
        time.sleep(0.2)
        if handle.poll() is not None:
            raise LifecycleError("START_FAILED", "PalServer process exited during startup.")
        self._transition(operation_id, "succeeded", "process_running")

    def _save(self, operation_id: str, config: ServerConfiguration) -> None:
        self._require_running(config)
        self._transition(operation_id, "running", "saving")
        self.rest_factory(config).save()
        self._transition(operation_id, "succeeded", "saved")

    def _stop_or_restart(
        self,
        operation_id: str,
        config: ServerConfiguration,
        restart: bool,
        countdown_seconds: int,
        message: str,
        cancel: threading.Event,
    ) -> None:
        if not self._graceful_stop(operation_id, config, countdown_seconds, message, cancel):
            return
        if restart:
            self._restart(operation_id, config, error_code="RESTART_FAILED")
        self._transition(
            operation_id, "succeeded", "restarted" if restart else "stopped"
        )

    def _apply_config_and_restart(
        self,
        operation_id: str,
        config: ServerConfiguration,
        countdown_seconds: int,
        message: str,
        cancel: threading.Event,
    ) -> None:
        if self._config_apply is None:
            raise LifecycleError(
                "CONFIG_APPLY_UNAVAILABLE", "配置应用器不可用，未执行停服或写入操作。"
            )
        if not self._graceful_stop(operation_id, config, countdown_seconds, message, cancel):
            return
        self._transition(operation_id, "running", "applying_config")
        try:
            self._config_apply()
        except Exception as error:
            code = getattr(error, "code", "CONFIG_APPLY_FAILED")
            error_code = code if isinstance(code, str) else "CONFIG_APPLY_FAILED"
            raise LifecycleError(
                error_code,
                "配置应用失败，PalServer 已停止且不会重启。请检查草稿或备份后，"
                f"使用普通 start 恢复服务。原因: {error}",
            ) from error
        self._restart(operation_id, config, error_code="HEALTH_CHECK_FAILED")
        self._transition(operation_id, "succeeded", "applied_restarted")

    def _graceful_stop(
        self,
        operation_id: str,
        config: ServerConfiguration,
        countdown_seconds: int,
        message: str,
        cancel: threading.Event,
    ) -> bool:
        pids = self._require_running(config)
        rest = self.rest_factory(config)
        self.database.bind_operation_target(operation_id, pids)
        self._transition(operation_id, "running", "countdown")
        if countdown_seconds:
            rest.announce(message)
            if cancel.wait(countdown_seconds):
                self._transition(operation_id, "cancelled", "cancelled")
                return False
        self._transition(operation_id, "running", "saving")
        rest.save()
        self._transition(operation_id, "running", "stopping")
        # PalServer rejects waittime=0 with HTTP 400 even after our own countdown.
        rest.shutdown(1, message)
        if not self.process.wait_for_exit(pids, timeout=30):
            expires_at = int(self.now()) + FORCE_CONFIRMATION_TTL_SECONDS
            self.database.bind_operation_target(operation_id, pids, expires_at)
            self._transition(
                operation_id,
                "awaiting_force_confirmation",
                "shutdown_timeout",
                "SHUTDOWN_TIMEOUT",
                "PalServer did not exit within 30 seconds.",
            )
            return False
        return True

    def _restart(
        self, operation_id: str, config: ServerConfiguration, *, error_code: str
    ) -> None:
        self._transition(operation_id, "running", "restarting")
        handle = self.process.start(config.executable, config.arguments)
        self._transition(operation_id, "running", "health_check")
        time.sleep(0.2)
        if handle.poll() is not None:
            raise LifecycleError(error_code, "PalServer process exited during health check.")

    def _force_stop(self, operation_id: str, config: ServerConfiguration) -> None:
        operation = self.database.operation(operation_id)
        raw_pids = operation.get("target_pids") if operation else None
        if not isinstance(raw_pids, list) or not raw_pids:
            raise LifecycleError("FORCE_CONFIRMATION_TARGET_MISSING", "强制停止缺少原始 PID 集合。")
        target_pids = [int(pid) for pid in raw_pids]
        current_pids = self.process.matching_pids(config.executable)
        if current_pids and set(current_pids) != set(target_pids):
            raise LifecycleError(
                "FORCE_STOP_TARGET_CHANGED",
                "PalServer PID 集合已变化，未执行强制停止；请重新执行普通 stop。",
            )
        self._transition(operation_id, "running", "force_stopping")
        if current_pids:
            self.process.force_stop(target_pids)
        if not self.process.wait_for_exit(target_pids, timeout=10):
            raise LifecycleError(
                "FORCE_STOP_FAILED", "PalServer process remained alive after kill()."
            )
        self._transition(operation_id, "succeeded", "force_stopped")

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
