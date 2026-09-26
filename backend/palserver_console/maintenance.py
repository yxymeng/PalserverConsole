from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from collections import deque
from collections.abc import Callable
from urllib.parse import urlsplit

import httpx

from .persistence import Database

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


NotificationSender = Callable[[str, dict[str, object], dict[str, str]], None]
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
        self._pending: deque[tuple[str, str, str, int]] = deque()
        self._dispatch_lock = threading.Lock()
        self._dispatching = False

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

    def send(
        self, event: str, title: str, message: str, occurred_at: int | None = None
    ) -> bool:
        if event not in _MAINTENANCE_EVENTS:
            raise NotificationError(
                "UNSUPPORTED_NOTIFICATION_EVENT", "Unsupported maintenance event."
            )
        if not self.status()["enabled"]:
            return False
        return self._deliver(event, title, message, occurred_at)

    def test(self) -> None:
        if not self.status()["configured"]:
            raise NotificationError(
                "NOTIFICATION_CONFIGURATION_REQUIRED",
                "Save an HTTPS Webhook URL and secret before sending a test notification.",
            )
        if not self._deliver(
            "maintenance.test", "测试告警", "PalServerConsole 运维事件推送连接测试。"
        ):
            raise NotificationError(
                "NOTIFICATION_TEST_FAILED", "Test notification delivery failed."
            )

    def on_operation_transition(self, detail: dict[str, object]) -> None:
        try:
            self._queue_operation_transition(detail)
        except Exception as error:
            logging.getLogger(__name__).warning(
                "notification enqueue failed errorCode=%s", type(error).__name__
            )

    def _queue_operation_transition(self, detail: dict[str, object]) -> None:
        kind = detail.get("kind")
        labels = {
            "start": "启动",
            "save": "保存",
            "stop": "停止",
            "restart": "重启",
            "force_stop": "强制停止",
        }
        if not isinstance(kind, str) or kind not in labels:
            return
        state, stage = detail.get("state"), detail.get("stage")
        event = None
        if state == "running" and stage == "countdown":
            event = "scheduled"
        elif state == "running" and (
            detail.get("fromState") == "queued" or detail.get("fromStage") == "countdown"
        ):
            event = "started"
        elif state in {"succeeded", "cancelled", "failed", "awaiting_force_confirmation"}:
            event = {"succeeded": "completed", "cancelled": "cancelled"}.get(str(state), "failed")
        if event is None:
            return
        operation_id = str(detail.get("operationId", ""))
        operation = self.database.operation(operation_id)
        error_code = operation.get("error_code") if operation else None
        result = {
            "scheduled": "已计划",
            "started": "已开始",
            "completed": "已完成",
            "cancelled": "已取消",
            "failed": "未完成",
        }[event]
        message = f"服务器{labels[kind]}{result}。"
        if error_code:
            message += f"错误标识：{error_code}。"
        if not self.status()["enabled"]:
            return
        with self._dispatch_lock:
            self._pending.append(
                (f"maintenance.{event}", f"服务器{labels[kind]}{result}", message, int(self.now()))
            )
            if not self._dispatching:
                threading.Thread(target=self._dispatch, daemon=True).start()
                self._dispatching = True

    def _dispatch(self) -> None:
        while True:
            with self._dispatch_lock:
                if not self._pending:
                    self._dispatching = False
                    return
                notice = self._pending.popleft()
            try:
                self.send(*notice)
            except Exception as error:
                # An unexpected notification error must not strand later events.
                logging.getLogger(__name__).warning(
                    "notification dispatch failed errorCode=%s", type(error).__name__
                )

    def _deliver(
        self, event: str, title: str, message: str, occurred_at: int | None = None
    ) -> bool:
        url = self.database.get_setting(_NOTIFICATION_URL_KEY)
        secret = self.database.get_setting(_NOTIFICATION_SECRET_KEY)
        if not url or not secret:
            return False
        payload: dict[str, object] = {
            "event": event,
            "title": title,
            "message": message,
            "instanceId": self.instance_id,
            "occurredAt": int(self.now()) if occurred_at is None else occurred_at,
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
