from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

import httpx

from .lifecycle import LifecycleError, LifecycleManager, ServerConfiguration
from .persistence import Database, OperationReservationError
from .steam import PALSERVER_APP_ID, assert_no_reparse_points, validate_executable

_NOTIFICATION_ENABLED_KEY = "maintenance.notification.enabled"
_NOTIFICATION_URL_KEY = "maintenance.notification.webhook_url"
_NOTIFICATION_SECRET_KEY = "maintenance.notification.secret"
_MAINTENANCE_EVENTS = frozenset(
    {
        "maintenance.scheduled",
        "maintenance.cancelled",
        "maintenance.started",
        "maintenance.completed",
        "maintenance.failed",
    }
)


class NotificationError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class MaintenanceNotifier(Protocol):
    def send(self, event: str, title: str, message: str) -> bool: ...


class MonitorReader(Protocol):
    def collect_once(self) -> dict[str, object]: ...


NotificationSender = Callable[[str, dict[str, object], dict[str, str]], None]
SteamCmdRunner = Callable[[Path, Path], None]
AuditCallback = Callable[[str, str, dict[str, object]], None]


class NotificationService:
    """Backend-only generic HTTPS Webhook adapter for high-value maintenance events."""

    def __init__(
        self,
        database: Database,
        instance_id: str,
        *,
        sender: NotificationSender | None = None,
        audit_callback: AuditCallback | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.database = database
        self.instance_id = instance_id
        self.sender = sender or _send_webhook
        self.audit_callback = audit_callback
        self.now = now

    def status(self) -> dict[str, bool]:
        enabled = self.database.get_setting(_NOTIFICATION_ENABLED_KEY) == "1"
        configured = bool(
            self.database.get_setting(_NOTIFICATION_URL_KEY)
            and self.database.get_setting(_NOTIFICATION_SECRET_KEY)
        )
        return {"enabled": enabled and configured, "configured": configured}

    def configure(
        self,
        *,
        enabled: bool,
        webhook_url: str | None,
        secret: str | None,
    ) -> dict[str, bool]:
        existing_url = self.database.get_setting(_NOTIFICATION_URL_KEY)
        existing_secret = self.database.get_setting(_NOTIFICATION_SECRET_KEY)
        new_url = _validate_webhook_url(webhook_url) if webhook_url is not None else None
        new_secret = _validate_notification_secret(secret) if secret is not None else None
        url = new_url or existing_url
        resolved_secret = new_secret or existing_secret
        if enabled and (not url or not resolved_secret):
            raise NotificationError(
                "NOTIFICATION_CONFIGURATION_REQUIRED",
                "An HTTPS Webhook URL and a secret are required before notifications "
                "can be enabled.",
            )
        if new_url is not None:
            self.database.set_setting(_NOTIFICATION_URL_KEY, new_url)
        if new_secret is not None:
            self.database.set_setting(_NOTIFICATION_SECRET_KEY, new_secret)
        self.database.set_setting(_NOTIFICATION_ENABLED_KEY, "1" if enabled else "0")
        return self.status()

    def send(self, event: str, title: str, message: str) -> bool:
        if event not in _MAINTENANCE_EVENTS:
            raise NotificationError(
                "UNSUPPORTED_NOTIFICATION_EVENT", "Unsupported maintenance event."
            )
        if not self.status()["enabled"]:
            return False
        url = self.database.get_setting(_NOTIFICATION_URL_KEY)
        secret = self.database.get_setting(_NOTIFICATION_SECRET_KEY)
        if not url or not secret:
            return False
        payload: dict[str, object] = {
            "event": event,
            "title": title,
            "message": message,
            "instanceId": self.instance_id,
            "occurredAt": int(self.now()),
        }
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(secret.encode("utf-8"), encoded, hashlib.sha256).hexdigest()
        try:
            self.sender(
                url,
                payload,
                {
                    "Content-Type": "application/json",
                    "X-PalServerConsole-Signature": f"sha256={signature}",
                },
            )
        except Exception as error:
            self._audit(
                "maintenance.notification",
                "failed",
                {"event": event, "errorCode": type(error).__name__},
            )
            return False
        self._audit("maintenance.notification", "sent", {"event": event})
        return True

    def _audit(self, event_type: str, result: str, detail: dict[str, object]) -> None:
        if self.audit_callback is not None:
            self.audit_callback(event_type, result, detail)


def _validate_webhook_url(value: str) -> str:
    url = value.strip()
    try:
        parsed = urlsplit(url)
    except ValueError as error:
        raise NotificationError("INVALID_NOTIFICATION_URL", str(error)) from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise NotificationError(
            "INVALID_NOTIFICATION_URL",
            "Webhook URL must be HTTPS and must not contain credentials, a query, or a fragment.",
        )
    return url


def _validate_notification_secret(value: str) -> str:
    if not value or len(value) > 4096:
        raise NotificationError(
            "INVALID_NOTIFICATION_SECRET", "Webhook secret must contain 1-4096 characters."
        )
    return value


def _send_webhook(url: str, payload: dict[str, object], headers: dict[str, str]) -> None:
    with httpx.Client(timeout=10.0, trust_env=False, follow_redirects=False) as client:
        response = client.post(url, json=payload, headers=headers)
        response.raise_for_status()


def validate_steamcmd(path: Path | str) -> Path:
    candidate = Path(path).expanduser()
    try:
        assert_no_reparse_points(candidate)
        resolved = candidate.resolve(strict=True)
    except ValueError as error:
        raise LifecycleError("PATH_REPARSE_POINT", str(error)) from error
    except (OSError, RuntimeError) as error:
        raise LifecycleError("INVALID_STEAMCMD_PATH", f"{type(error).__name__}: {error}") from error
    if not resolved.is_file() or resolved.name.casefold() != "steamcmd.exe":
        raise LifecycleError(
            "INVALID_STEAMCMD_PATH", "SteamCMD path must point to an existing steamcmd.exe."
        )
    return resolved


def run_steamcmd_update(steamcmd: Path, install_path: Path) -> None:
    command = [
        str(steamcmd),
        "+force_install_dir",
        str(install_path),
        "+login",
        "anonymous",
        "+app_update",
        PALSERVER_APP_ID,
        "validate",
        "+quit",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=steamcmd.parent,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=60 * 60,
        )
    except subprocess.TimeoutExpired as error:
        raise LifecycleError(
            "STEAMCMD_TIMEOUT", "SteamCMD did not finish within 60 minutes."
        ) from error
    except OSError as error:
        raise LifecycleError("STEAMCMD_START_FAILED", f"{type(error).__name__}: {error}") from error
    if completed.returncode != 0:
        raise LifecycleError(
            "STEAMCMD_UPDATE_FAILED", f"SteamCMD exited with code {completed.returncode}."
        )


class SteamCmdUpdateService:
    """Manual, fail-closed SteamCMD update workflow for one managed instance."""

    def __init__(
        self,
        database: Database,
        lifecycle: LifecycleManager,
        monitor: MonitorReader,
        notifications: MaintenanceNotifier,
        *,
        runner: SteamCmdRunner = run_steamcmd_update,
        instance_id: str = "default",
        health_check: Callable[[], bool] | None = None,
        audit_callback: AuditCallback | None = None,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.database = database
        self.lifecycle = lifecycle
        self.monitor = monitor
        self.notifications = notifications
        self.runner = runner
        self.instance_id = instance_id
        self.health_check = health_check or self._monitor_health
        self.audit_callback = audit_callback
        self.sleep = sleep
        self.now = now
        self._lock = threading.Lock()
        self._cancellations: dict[str, threading.Event] = {}

    def begin(
        self,
        steamcmd_path: Path | str,
        idempotency_key: str,
        *,
        confirmation: str,
        countdown_seconds: int = 30,
        message: str = "服务器将进行维护更新，请及时返回安全地点。",
    ) -> dict[str, object]:
        if confirmation != "UPDATE":
            raise LifecycleError(
                "UPDATE_CONFIRMATION_REQUIRED",
                "Enter UPDATE to explicitly confirm the SteamCMD update.",
            )
        if not idempotency_key.strip():
            raise LifecycleError("IDEMPOTENCY_KEY_REQUIRED", "Missing Idempotency-Key.")
        if countdown_seconds < 0 or countdown_seconds > 600:
            raise LifecycleError(
                "INVALID_COUNTDOWN", "Countdown seconds must be between 0 and 600."
            )
        steamcmd = validate_steamcmd(steamcmd_path)
        with self._lock:
            try:
                operation, created = self.database.reserve_operation(
                    uuid.uuid4().hex,
                    "steamcmd_update",
                    idempotency_key,
                    now=self.now(),
                    request_fingerprint=_update_request_fingerprint(
                        steamcmd, countdown_seconds, message
                    ),
                )
            except OperationReservationError as error:
                raise LifecycleError(error.code, str(error)) from error
            if not created:
                return operation
            operation_id = str(operation["id"])
            cancellation = threading.Event()
            self._cancellations[operation_id] = cancellation
            threading.Thread(
                target=self._run,
                args=(operation_id, steamcmd, countdown_seconds, message, cancellation),
                name=f"palconsole-steamcmd-update-{operation_id[:8]}",
                daemon=True,
            ).start()
            return operation

    def cancel(self, operation_id: str) -> None:
        operation = self.database.operation(operation_id)
        cancellation = self._cancellations.get(operation_id)
        if (
            operation is None
            or operation.get("kind") != "steamcmd_update"
            or operation.get("stage") != "countdown"
            or cancellation is None
        ):
            raise LifecycleError(
                "OPERATION_NOT_CANCELLABLE", "The update is not in its cancellable countdown."
            )
        cancellation.set()

    def _run(
        self,
        operation_id: str,
        steamcmd: Path,
        countdown_seconds: int,
        message: str,
        cancellation: threading.Event,
    ) -> None:
        config: ServerConfiguration | None = None
        server_stopped = False
        try:
            with self.lifecycle.control_lock:
                config = self.lifecycle.load_configuration()
                pids = self.lifecycle.process.matching_pids(config.executable)
                if not pids:
                    raise LifecycleError(
                        "SERVER_NOT_RUNNING",
                        "PalServer must be running before a managed SteamCMD update can begin.",
                    )
                self._assert_no_online_players()
                rest = self.lifecycle.rest_factory(config)
                self._transition(operation_id, "running", "countdown")
                self._notify("maintenance.scheduled", "维护更新已计划", message)
                rest.announce(message)
                if countdown_seconds and cancellation.wait(countdown_seconds):
                    self._transition(operation_id, "cancelled", "cancelled")
                    self._notify("maintenance.cancelled", "维护更新已取消", "更新在停服前取消。")
                    self._audit(operation_id, "cancelled", {"stage": "countdown"})
                    return
                self._assert_no_online_players()
                self._transition(operation_id, "running", "saving")
                rest.save()
                self._transition(operation_id, "running", "stopping")
                rest.shutdown(1, message)
                if not self.lifecycle.process.wait_for_exit(pids, timeout=30):
                    raise LifecycleError(
                        "SHUTDOWN_TIMEOUT",
                        "PalServer did not exit within 30 seconds; SteamCMD was not started.",
                    )
                server_stopped = True
                self._transition(operation_id, "running", "updating")
                self._notify(
                    "maintenance.started",
                    "维护更新开始",
                    "PalServer 已停止，正在执行 SteamCMD 校验更新。",
                )
                self.runner(steamcmd, config.executable.parent)
                self._transition(operation_id, "running", "validating")
                validate_executable(config.executable)
                self._start_and_check(operation_id, config, "UPDATE_START_FAILED")
                server_stopped = False
                self._transition(operation_id, "succeeded", "updated")
                self._notify(
                    "maintenance.completed", "维护更新完成", "PalServer 已通过启动健康检查。"
                )
                self._audit(operation_id, "success", {"stage": "updated"})
        except LifecycleError as error:
            recovered = False
            if config is not None and server_stopped:
                recovered = self._recover(operation_id, config)
            stage = "recovered_after_failure" if recovered else "failed"
            self._transition(operation_id, "failed", stage, error.code, str(error))
            self._notify("maintenance.failed", "维护更新失败", f"更新未完成：{error.code}。")
            self._audit(
                operation_id,
                "failed",
                {"stage": stage, "errorCode": error.code, "recovered": recovered},
            )
        except Exception as error:
            detail = f"{type(error).__name__}: {error}"
            recovered = False
            if config is not None and server_stopped:
                recovered = self._recover(operation_id, config)
            stage = "recovered_after_failure" if recovered else "failed"
            self._transition(operation_id, "failed", stage, "UNEXPECTED_ERROR", detail)
            self._notify("maintenance.failed", "维护更新失败", "更新遇到未预期错误。")
            self._audit(
                operation_id,
                "failed",
                {"stage": stage, "errorCode": "UNEXPECTED_ERROR", "recovered": recovered},
            )
        finally:
            self._cancellations.pop(operation_id, None)

    def _assert_no_online_players(self) -> None:
        try:
            snapshot = self.monitor.collect_once()
        except Exception as error:
            raise LifecycleError(
                "PLAYER_CHECK_UNAVAILABLE",
                f"{type(error).__name__}: player status could not be refreshed.",
            ) from error
        players = snapshot.get("players")
        if not isinstance(players, dict) or players.get("stale") is not False:
            raise LifecycleError(
                "PLAYER_CHECK_UNAVAILABLE",
                "Player status is unavailable or stale; update was not started.",
            )
        value = players.get("data")
        if not isinstance(value, list):
            raise LifecycleError(
                "PLAYER_CHECK_INVALID",
                "Player status has an unexpected shape; update was not started.",
            )
        if value:
            raise LifecycleError(
                "PLAYERS_ONLINE", "Online players were detected; update was not started."
            )

    def _start_and_check(
        self, operation_id: str, config: ServerConfiguration, error_code: str
    ) -> None:
        self._transition(operation_id, "running", "restarting")
        handle = self.lifecycle.process.start(config.executable, config.arguments)
        self._transition(operation_id, "running", "health_check")
        self.sleep(0.2)
        if handle.poll() is not None:
            raise LifecycleError(error_code, "PalServer process exited during update health check.")
        if not self.health_check():
            raise LifecycleError(
                "UPDATE_HEALTH_CHECK_FAILED", "PalServer did not pass the post-update health check."
            )

    def _recover(self, operation_id: str, config: ServerConfiguration) -> bool:
        try:
            self._transition(operation_id, "running", "recovering")
            if not self.lifecycle.process.matching_pids(config.executable):
                handle = self.lifecycle.process.start(config.executable, config.arguments)
                self.sleep(0.2)
                if handle.poll() is not None:
                    return False
            return self.health_check()
        except Exception:
            return False

    def _monitor_health(self) -> bool:
        try:
            snapshot = self.monitor.collect_once()
        except Exception:
            return False
        info = snapshot.get("info")
        return isinstance(info, dict) and info.get("stale") is False

    def _transition(
        self,
        operation_id: str,
        state: str,
        stage: str,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> None:
        self.database.transition_operation(operation_id, state, stage, error_code, detail)

    def _notify(self, event: str, title: str, message: str) -> None:
        try:
            self.notifications.send(event, title, message)
        except Exception:
            return

    def _audit(self, operation_id: str, result: str, detail: dict[str, object]) -> None:
        if self.audit_callback is None:
            return
        self.audit_callback(
            "server.steamcmd_update",
            result,
            {"operationId": operation_id, "instanceId": self.instance_id, **detail},
        )


def _update_request_fingerprint(steamcmd: Path, countdown_seconds: int, message: str) -> str:
    payload = json.dumps(
        {
            "steamcmdPath": str(steamcmd),
            "countdownSeconds": countdown_seconds,
            "message": message,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
