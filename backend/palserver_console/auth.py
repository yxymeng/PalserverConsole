from __future__ import annotations

import hashlib
import hmac
import ipaddress
import secrets
import time
from base64 import urlsafe_b64decode, urlsafe_b64encode
from dataclasses import dataclass
from pathlib import Path

from .config import AppSettings
from .monitoring import MonitoringConfigError, read_admin_password
from .persistence import Database

COOKIE_NAME = "palconsole_session"


def is_loopback(peer_ip: str) -> bool:
    try:
        return ipaddress.ip_address(peer_ip).is_loopback
    except ValueError:
        return False


def secret_hash(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


@dataclass(frozen=True)
class Session:
    id: str
    peer_ip: str
    is_local: bool
    csrf_token: str


class AuthStore:
    def __init__(self, database: Database, settings: AppSettings) -> None:
        self.database = database
        self.settings = settings

    def admin_password_configured(self) -> bool:
        return self._game_admin_password() is not None

    def verify_admin_password(self, password: str) -> bool:
        configured = self._game_admin_password()
        return configured is not None and hmac.compare_digest(password, configured)

    def create_session(
        self, peer_ip: str, *, local: bool, now: int | None = None
    ) -> tuple[str, Session]:
        timestamp = int(time.time()) if now is None else now
        session_id = secrets.token_urlsafe(18)
        raw_token = secrets.token_urlsafe(32)
        csrf_token = secrets.token_urlsafe(24)
        expires_at = timestamp + self.settings.session_ttl_seconds
        self.cleanup_expired(now=timestamp)
        with self.database.connect() as connection:
            connection.execute(
                """
                INSERT INTO sessions(
                    id, token_hash, csrf_hash, peer_ip, is_local, created_at, expires_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    secret_hash(raw_token),
                    secret_hash(csrf_token),
                    peer_ip,
                    int(local),
                    timestamp,
                    expires_at,
                ),
            )
        unsigned_cookie = f"{session_id}.{raw_token}"
        signature = hmac.new(
            self._signing_secret(), unsigned_cookie.encode("ascii"), hashlib.sha256
        ).hexdigest()
        cookie_value = f"{unsigned_cookie}.{signature}"
        return cookie_value, Session(session_id, peer_ip, local, csrf_token)

    def read_session(
        self, cookie_value: str | None, peer_ip: str, now: int | None = None
    ) -> Session | None:
        if not cookie_value or cookie_value.count(".") != 2:
            return None
        session_id, raw_token, signature = cookie_value.split(".", 2)
        expected_signature = hmac.new(
            self._signing_secret(), f"{session_id}.{raw_token}".encode("ascii"), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(signature, expected_signature):
            return None
        timestamp = int(time.time()) if now is None else now
        self.cleanup_expired(now=timestamp)
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id, token_hash, csrf_hash, peer_ip, is_local
                FROM sessions WHERE id = ? AND expires_at > ?
                """,
                (session_id, timestamp),
            ).fetchone()
        if row is None or row["peer_ip"] != peer_ip:
            return None
        if not hmac.compare_digest(secret_hash(raw_token), row["token_hash"]):
            return None
        return Session(row["id"], row["peer_ip"], bool(row["is_local"]), "")

    def verify_csrf(self, session_id: str, csrf_token: str | None) -> bool:
        if not csrf_token:
            return False
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT csrf_hash FROM sessions WHERE id = ?", (session_id,)
            ).fetchone()
        return row is not None and hmac.compare_digest(secret_hash(csrf_token), row["csrf_hash"])

    def delete_session(self, session_id: str) -> None:
        with self.database.connect() as connection:
            connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))

    def cleanup_expired(self, now: int | None = None) -> dict[str, int]:
        """Remove expired sessions and login attempts outside the rate-limit window."""

        timestamp = int(time.time()) if now is None else now
        cutoff = timestamp - max(0, self.settings.login_window_seconds)
        with self.database.connect() as connection:
            sessions_removed = connection.execute(
                "DELETE FROM sessions WHERE expires_at <= ?", (timestamp,)
            ).rowcount
            attempts_removed = connection.execute(
                "DELETE FROM login_attempts WHERE attempted_at < ?", (cutoff,)
            ).rowcount
        return {
            "sessions": max(0, int(sessions_removed)),
            "loginAttempts": max(0, int(attempts_removed)),
        }

    def too_many_failures(self, peer_ip: str, now: int | None = None) -> bool:
        timestamp = int(time.time()) if now is None else now
        self.cleanup_expired(now=timestamp)
        cutoff = timestamp - self.settings.login_window_seconds
        with self.database.connect() as connection:
            count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM login_attempts
                    WHERE peer_ip = ? AND attempted_at >= ? AND succeeded = 0
                    """,
                    (peer_ip, cutoff),
                ).fetchone()[0]
            )
        return count >= self.settings.login_max_failures

    def record_login(self, peer_ip: str, succeeded: bool, now: int | None = None) -> None:
        timestamp = int(time.time()) if now is None else now
        self.cleanup_expired(now=timestamp)
        with self.database.connect() as connection:
            connection.execute(
                "INSERT INTO login_attempts(peer_ip, attempted_at, succeeded) VALUES(?, ?, ?)",
                (peer_ip, timestamp, int(succeeded)),
            )
            if succeeded:
                connection.execute("DELETE FROM login_attempts WHERE peer_ip = ?", (peer_ip,))

    def _signing_secret(self) -> bytes:
        key = "auth.session_signing_secret"
        with self.database.connect() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
            if row is None:
                encoded = urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii")
                connection.execute(
                    "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?, ?, ?)",
                    (key, encoded, int(time.time())),
                )
                row = connection.execute(
                    "SELECT value FROM settings WHERE key = ?", (key,)
                ).fetchone()
        if row is None:
            raise RuntimeError("Unable to initialize the session signing secret.")
        return urlsafe_b64decode(row["value"].encode("ascii"))

    def _game_admin_password(self) -> str | None:
        executable = self.database.get_setting("server.executable")
        if not executable:
            return None
        try:
            return read_admin_password(Path(executable).parent)
        except (MonitoringConfigError, OSError):
            return None
