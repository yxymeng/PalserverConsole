from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 8

MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE auth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash BLOB NOT NULL,
        salt BLOB NOT NULL,
        n INTEGER NOT NULL,
        r INTEGER NOT NULL,
        p INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        csrf_hash BLOB NOT NULL,
        peer_ip TEXT NOT NULL,
        is_local INTEGER NOT NULL CHECK (is_local IN (0, 1)),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
    );
    CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
    CREATE TABLE login_attempts (
        peer_ip TEXT NOT NULL,
        attempted_at INTEGER NOT NULL,
        succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1))
    );
    CREATE INDEX login_attempts_peer_time_idx
        ON login_attempts(peer_ip, attempted_at);
    CREATE TABLE operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        stage TEXT,
        error_code TEXT,
        idempotency_key TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        peer_ip TEXT,
        result TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE config_drafts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        draft_path TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_mtime_ns INTEGER NOT NULL,
        state TEXT NOT NULL,
        conflict_json TEXT,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE snapshot_versions (
        id TEXT PRIMARY KEY,
        cache_path TEXT NOT NULL,
        source_observed_at INTEGER NOT NULL,
        parse_result TEXT NOT NULL,
        is_current INTEGER NOT NULL CHECK (is_current IN (0, 1)),
        created_at INTEGER NOT NULL
    );
    CREATE TABLE backup_index (
        id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        observed_at INTEGER NOT NULL,
        validation_result TEXT NOT NULL,
        restore_result TEXT
    );
    """,
    """
    ALTER TABLE operations ADD COLUMN detail TEXT;
    CREATE INDEX operations_state_updated_idx ON operations(state, updated_at);
    """,
    """
    ALTER TABLE audit_events ADD COLUMN source TEXT NOT NULL DEFAULT 'console';
    ALTER TABLE audit_events ADD COLUMN dedup_key TEXT;
    ALTER TABLE audit_events ADD COLUMN parser_version TEXT;
    CREATE UNIQUE INDEX audit_events_dedup_idx
        ON audit_events(dedup_key) WHERE dedup_key IS NOT NULL;
    CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC, id DESC);
    CREATE INDEX audit_events_type_idx ON audit_events(event_type, created_at DESC);
    CREATE TABLE log_cursors (
        source_path TEXT PRIMARY KEY,
        file_identity TEXT NOT NULL,
        offset INTEGER NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
    );
    """,
    """
    DROP TABLE IF EXISTS auth_config;
    DELETE FROM sessions WHERE is_local = 0;
    """,
    """
    ALTER TABLE operations ADD COLUMN parent_operation_id TEXT;
    ALTER TABLE operations ADD COLUMN target_pids TEXT;
    ALTER TABLE operations ADD COLUMN confirmation_expires_at INTEGER;
    CREATE INDEX operations_confirmation_idx
        ON operations(state, confirmation_expires_at);
    """,
    """
    CREATE TABLE IF NOT EXISTS server_profiles (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        executable_path TEXT NOT NULL,
        install_path TEXT NOT NULL,
        world_id TEXT NOT NULL,
        world_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS restore_journal (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        journal_id TEXT NOT NULL UNIQUE,
        world_id TEXT NOT NULL,
        world_path TEXT NOT NULL,
        source_backup_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        safety_copy_path TEXT NOT NULL,
        staging_path TEXT NOT NULL,
        phase TEXT NOT NULL,
        component TEXT,
        completed_components_json TEXT NOT NULL DEFAULT '[]',
        checksums_json TEXT NOT NULL DEFAULT '{}',
        error_type TEXT,
        error_message TEXT,
        original_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    """,
    """
    ALTER TABLE operations ADD COLUMN request_fingerprint TEXT;
    """,
)


class OperationReservationError(RuntimeError):
    def __init__(self, code: str, message: str, operation_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.operation_id = operation_id


class OperationTransitionError(RuntimeError):
    pass


class RestoreJournalConflictError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


_OPERATION_COLUMNS = """
    id, kind, state, stage, error_code, detail, created_at, updated_at,
    parent_operation_id, target_pids, confirmation_expires_at, request_fingerprint
"""
RESTORE_TERMINAL_PHASES = frozenset({"completed", "rolled_back"})
RESTORE_BLOCKED_OPERATION_KINDS = frozenset(
    {"start", "save", "restart", "apply_config_and_restart"}
)
_ALLOWED_OPERATION_TRANSITIONS: dict[str, frozenset[str]] = {
    "queued": frozenset({"running", "failed"}),
    "running": frozenset(
        {"running", "succeeded", "failed", "cancelled", "awaiting_force_confirmation"}
    ),
    "awaiting_force_confirmation": frozenset({"succeeded", "failed"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "cancelled": frozenset(),
}


def _operation_from_row(row: sqlite3.Row | None) -> dict[str, object] | None:
    if row is None:
        return None
    operation = dict(row)
    raw_pids = operation.get("target_pids")
    if isinstance(raw_pids, str):
        try:
            parsed = json.loads(raw_pids)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, list) and all(isinstance(pid, int) for pid in parsed):
            operation["target_pids"] = parsed
        else:
            operation["target_pids"] = None
    return operation


def _encode_pids(pids: list[int] | None) -> str | None:
    if pids is None:
        return None
    return json.dumps([int(pid) for pid in pids], separators=(",", ":"))


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def migrate(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            current = int(connection.execute("PRAGMA user_version").fetchone()[0])
            if current > SCHEMA_VERSION:
                raise RuntimeError(
                    f"app.db schema version {current} is newer than supported {SCHEMA_VERSION}."
                )
            for version in range(current + 1, SCHEMA_VERSION + 1):
                if version == 5:
                    self._migrate_operation_targets(connection)
                elif version == 8:
                    self._migrate_operation_request_fingerprint(connection)
                else:
                    connection.executescript(MIGRATIONS[version - 1])
                connection.execute(f"PRAGMA user_version = {version}")

    @staticmethod
    def _migrate_operation_targets(connection: sqlite3.Connection) -> None:
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(operations)").fetchall()
        }
        if "parent_operation_id" not in columns:
            connection.execute("ALTER TABLE operations ADD COLUMN parent_operation_id TEXT")
        if "target_pids" not in columns:
            connection.execute("ALTER TABLE operations ADD COLUMN target_pids TEXT")
        if "confirmation_expires_at" not in columns:
            connection.execute(
                "ALTER TABLE operations ADD COLUMN confirmation_expires_at INTEGER"
            )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS operations_confirmation_idx
            ON operations(state, confirmation_expires_at)
            """
        )

    @staticmethod
    def _migrate_operation_request_fingerprint(connection: sqlite3.Connection) -> None:
        columns = {
            str(row[1]) for row in connection.execute("PRAGMA table_info(operations)").fetchall()
        }
        if "request_fingerprint" not in columns:
            connection.execute("ALTER TABLE operations ADD COLUMN request_fingerprint TEXT")

    def schema_version(self) -> int:
        with self.connect() as connection:
            return int(connection.execute("PRAGMA user_version").fetchone()[0])

    def get_setting(self, key: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return None if row is None else str(row["value"])

    def set_setting(self, key: str, value: str) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
                """,
                (key, value, int(time.time())),
            )

    def get_server_profile(self) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT executable_path, install_path, world_id, world_path,
                    created_at, updated_at
                    FROM server_profiles WHERE id = 1"""
            ).fetchone()
        return None if row is None else dict(row)

    def save_server_profile(
        self,
        executable_path: str,
        install_path: str,
        world_id: str,
        world_path: str,
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO server_profiles(
                    id, executable_path, install_path, world_id, world_path, created_at, updated_at
                ) VALUES(1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    executable_path=excluded.executable_path,
                    install_path=excluded.install_path,
                    world_id=excluded.world_id,
                    world_path=excluded.world_path,
                    updated_at=excluded.updated_at""",
                (executable_path, install_path, world_id, world_path, now, now),
            )

    def clear_server_profile(self) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM server_profiles WHERE id = 1")

    def get_config_draft(self) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT draft_path, source_hash, source_mtime_ns, state, conflict_json, updated_at
                FROM config_drafts WHERE id = 1"""
            ).fetchone()
        return None if row is None else dict(row)

    def save_config_draft(
        self,
        draft_path: str,
        source_hash: str,
        source_mtime_ns: int,
        state: str,
        conflict_json: str | None,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO config_drafts(
                    id, draft_path, source_hash, source_mtime_ns, state, conflict_json, updated_at
                )
                VALUES(1, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    draft_path=excluded.draft_path, source_hash=excluded.source_hash,
                    source_mtime_ns=excluded.source_mtime_ns, state=excluded.state,
                    conflict_json=excluded.conflict_json, updated_at=excluded.updated_at""",
                (draft_path, source_hash, source_mtime_ns, state, conflict_json, int(time.time())),
            )

    def update_config_draft_state(self, state: str, conflict_json: str | None) -> None:
        with self.connect() as connection:
            connection.execute(
                """UPDATE config_drafts
                SET state = ?, conflict_json = ?, updated_at = ? WHERE id = 1""",
                (state, conflict_json, int(time.time())),
            )

    def clear_config_draft(self) -> None:
        with self.connect() as connection:
            connection.execute("DELETE FROM config_drafts WHERE id = 1")

    def record_snapshot_version(
        self,
        snapshot_id: str,
        cache_path: str,
        source_observed_at: int,
        parse_result: str,
        *,
        make_current: bool,
    ) -> None:
        with self.connect() as connection:
            if make_current:
                connection.execute("UPDATE snapshot_versions SET is_current = 0")
            connection.execute(
                """
                INSERT INTO snapshot_versions(
                    id, cache_path, source_observed_at, parse_result, is_current, created_at
                ) VALUES(?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    cache_path=excluded.cache_path,
                    source_observed_at=excluded.source_observed_at,
                    parse_result=excluded.parse_result,
                    is_current=excluded.is_current
                """,
                (
                    snapshot_id,
                    cache_path,
                    source_observed_at,
                    parse_result,
                    int(make_current),
                    int(time.time()),
                ),
            )

    def current_snapshot_version(self) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT id, cache_path, source_observed_at, parse_result, created_at
                FROM snapshot_versions WHERE is_current = 1
                ORDER BY created_at DESC LIMIT 1"""
            ).fetchone()
        return dict(row) if row is not None else None

    def restore_journal(self) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT journal_id, world_id, world_path, source_backup_id,
                source_path, safety_copy_path, staging_path, phase, component,
                completed_components_json, checksums_json, error_type,
                error_message, original_error, created_at, updated_at
                FROM restore_journal WHERE id = 1"""
            ).fetchone()
        return dict(row) if row is not None else None

    def restore_recovery_active(self) -> bool:
        journal = self.restore_journal()
        return bool(
            journal is not None and str(journal.get("phase")) not in RESTORE_TERMINAL_PHASES
        )

    def begin_restore_journal(
        self,
        journal_id: str,
        world_id: str,
        world_path: str,
        source_backup_id: str,
        source_path: str,
        safety_copy_path: str,
        staging_path: str,
        phase: str,
        checksums_json: str = "{}",
    ) -> None:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            active_operation = connection.execute(
                """
                SELECT id FROM operations
                WHERE state IN ('queued', 'running')
                   OR (
                       state = 'awaiting_force_confirmation'
                       AND (confirmation_expires_at IS NULL OR confirmation_expires_at > ?)
                   )
                ORDER BY created_at LIMIT 1
                """,
                (now,),
            ).fetchone()
            if active_operation is not None:
                raise RestoreJournalConflictError(
                    "OPERATION_IN_PROGRESS",
                    "A server operation is active; restore was not started.",
                )
            existing = connection.execute(
                "SELECT phase FROM restore_journal WHERE id = 1"
            ).fetchone()
            if existing is not None and str(existing["phase"]) not in RESTORE_TERMINAL_PHASES:
                raise RestoreJournalConflictError(
                    "RESTORE_RECOVERY_REQUIRED",
                    "A restore journal requires resume or rollback before another restore.",
                )
            connection.execute(
                """
                INSERT INTO restore_journal(
                    id, journal_id, world_id, world_path, source_backup_id,
                    source_path, safety_copy_path, staging_path, phase, component,
                    completed_components_json, checksums_json, error_type,
                    error_message, original_error, created_at, updated_at
                ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, NULL, NULL, NULL, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    journal_id=excluded.journal_id,
                    world_id=excluded.world_id,
                    world_path=excluded.world_path,
                    source_backup_id=excluded.source_backup_id,
                    source_path=excluded.source_path,
                    safety_copy_path=excluded.safety_copy_path,
                    staging_path=excluded.staging_path,
                    phase=excluded.phase,
                    component=excluded.component,
                    completed_components_json=excluded.completed_components_json,
                    checksums_json=excluded.checksums_json,
                    error_type=excluded.error_type,
                    error_message=excluded.error_message,
                    original_error=excluded.original_error,
                    created_at=excluded.created_at,
                    updated_at=excluded.updated_at
                """,
                (
                    journal_id,
                    world_id,
                    world_path,
                    source_backup_id,
                    source_path,
                    safety_copy_path,
                    staging_path,
                    phase,
                    checksums_json,
                    now,
                    now,
                ),
            )

    def update_restore_journal(
        self,
        *,
        phase: str,
        component: str | None,
        completed_components_json: str,
        checksums_json: str,
        error_type: str | None = None,
        error_message: str | None = None,
        original_error: str | None = None,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE restore_journal
                SET phase = ?, component = ?, completed_components_json = ?,
                    checksums_json = ?, error_type = ?, error_message = ?,
                    original_error = ?, updated_at = ?
                WHERE id = 1
                """,
                (
                    phase,
                    component,
                    completed_components_json,
                    checksums_json,
                    error_type,
                    error_message,
                    original_error,
                    int(time.time()),
                ),
            )

    def create_operation(
        self,
        operation_id: str,
        kind: str,
        idempotency_key: str,
        *,
        parent_operation_id: str | None = None,
        target_pids: list[int] | None = None,
        confirmation_expires_at: int | None = None,
        request_fingerprint: str | None = None,
    ) -> dict[str, object]:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO operations(
                    id, kind, state, stage, error_code, idempotency_key, created_at, updated_at,
                    parent_operation_id, target_pids, confirmation_expires_at, request_fingerprint
                ) VALUES(?, ?, 'queued', 'queued', NULL, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    operation_id,
                    kind,
                    idempotency_key,
                    now,
                    now,
                    parent_operation_id,
                    _encode_pids(target_pids),
                    confirmation_expires_at,
                    request_fingerprint,
                ),
            )
        operation = self.operation(operation_id)
        if operation is None:
            raise RuntimeError("Operation insert did not persist.")
        return operation

    def reserve_operation(
        self,
        operation_id: str,
        kind: str,
        idempotency_key: str,
        *,
        parent_operation_id: str | None = None,
        now: float | None = None,
        request_fingerprint: str | None = None,
    ) -> tuple[dict[str, object], bool]:
        """Atomically replay an idempotent operation or reserve a new one."""

        now_value = int(time.time() if now is None else now)
        with self.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            existing_operation = _operation_from_row(existing)
            if existing_operation is not None:
                if (
                    existing_operation.get("kind") != kind
                    or existing_operation.get("parent_operation_id") != parent_operation_id
                    or existing_operation.get("request_fingerprint") != request_fingerprint
                ):
                    raise OperationReservationError(
                        "IDEMPOTENCY_KEY_CONFLICT",
                        "Idempotency-Key was already used for a different request.",
                        str(existing_operation["id"]),
                    )
                return existing_operation, False

            if kind in RESTORE_BLOCKED_OPERATION_KINDS:
                journal = connection.execute(
                    "SELECT phase FROM restore_journal WHERE id = 1"
                ).fetchone()
                if journal is not None and str(journal["phase"]) not in RESTORE_TERMINAL_PHASES:
                    raise OperationReservationError(
                        "RESTORE_RECOVERY_REQUIRED",
                        "An unfinished restore requires resume or rollback before this operation.",
                    )

            bound_pids: list[int] | None = None
            if parent_operation_id is not None:
                parent_row = connection.execute(
                    f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE id = ?",
                    (parent_operation_id,),
                ).fetchone()
                parent = _operation_from_row(parent_row)
                if parent is None or parent["state"] != "awaiting_force_confirmation":
                    raise OperationReservationError(
                        "FORCE_CONFIRMATION_NOT_AVAILABLE",
                        "当前没有待确认的强制停止。",
                        parent_operation_id,
                    )
                expires_at = parent.get("confirmation_expires_at")
                if not isinstance(expires_at, int) or expires_at <= now_value:
                    raise OperationReservationError(
                        "FORCE_CONFIRMATION_EXPIRED",
                        "强制停止确认已过期，未执行任何停止操作。",
                        parent_operation_id,
                    )
                raw_pids = parent.get("target_pids")
                if not isinstance(raw_pids, list) or not raw_pids:
                    raise OperationReservationError(
                        "FORCE_CONFIRMATION_TARGET_MISSING",
                        "待确认操作没有可用的原始 PID 集合。",
                        parent_operation_id,
                    )
                bound_pids = [int(pid) for pid in raw_pids]

            active_sql = f"""
                SELECT {_OPERATION_COLUMNS}
                FROM operations
                WHERE (
                    state IN ('queued', 'running')
                    OR (
                        state = 'awaiting_force_confirmation'
                        AND (confirmation_expires_at IS NULL OR confirmation_expires_at > ?)
                    )
                )
            """
            active_values: list[object] = [now_value]
            if parent_operation_id is not None:
                active_sql += " AND id != ?"
                active_values.append(parent_operation_id)
            active_sql += " ORDER BY created_at LIMIT 1"
            active = _operation_from_row(connection.execute(active_sql, active_values).fetchone())
            if active is not None:
                raise OperationReservationError(
                    "OPERATION_IN_PROGRESS",
                    "已有服务器操作正在进行。",
                    str(active["id"]),
                )

            now_created = int(time.time() if now is None else now)
            connection.execute(
                """
                INSERT INTO operations(
                    id, kind, state, stage, error_code, idempotency_key, created_at, updated_at,
                    parent_operation_id, target_pids, confirmation_expires_at, request_fingerprint
                ) VALUES(?, ?, 'queued', 'queued', NULL, ?, ?, ?, ?, ?, NULL, ?)
                """,
                (
                    operation_id,
                    kind,
                    idempotency_key,
                    now_created,
                    now_created,
                    parent_operation_id,
                    _encode_pids(bound_pids),
                    request_fingerprint,
                ),
            )
            created = _operation_from_row(
                connection.execute(
                    f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE id = ?",
                    (operation_id,),
                ).fetchone()
            )
            if created is None:
                raise RuntimeError("Operation reservation did not persist.")
            return created, True

    def update_operation(
        self,
        operation_id: str,
        state: str,
        stage: str,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> None:
        self.transition_operation(operation_id, state, stage, error_code, detail)

    def transition_operation(
        self,
        operation_id: str,
        state: str,
        stage: str,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> dict[str, object]:
        with self.connect() as connection:
            current_row = connection.execute(
                "SELECT state FROM operations WHERE id = ?", (operation_id,)
            ).fetchone()
            if current_row is None:
                raise OperationTransitionError(f"Operation {operation_id} does not exist.")
            current_state = str(current_row["state"])
            if current_state != state and state not in _ALLOWED_OPERATION_TRANSITIONS.get(
                current_state, frozenset()
            ):
                raise OperationTransitionError(
                    f"Invalid operation transition: {current_state} -> {state}."
                )
            connection.execute(
                """
                UPDATE operations
                SET state = ?, stage = ?, error_code = ?, detail = ?, updated_at = ?
                WHERE id = ?
                """,
                (state, stage, error_code, detail, int(time.time()), operation_id),
            )
            row = connection.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE id = ?",
                (operation_id,),
            ).fetchone()
        operation = _operation_from_row(row)
        if operation is None:
            raise RuntimeError("Operation transition did not persist.")
        return operation

    def bind_operation_target(
        self, operation_id: str, target_pids: list[int], confirmation_expires_at: int | None = None
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE operations
                SET target_pids = ?, confirmation_expires_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    _encode_pids(target_pids),
                    confirmation_expires_at,
                    int(time.time()),
                    operation_id,
                ),
            )

    def operation(self, operation_id: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE id = ?",
                (operation_id,),
            ).fetchone()
        return _operation_from_row(row)

    def operation_by_idempotency(self, idempotency_key: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                f"SELECT {_OPERATION_COLUMNS} FROM operations WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return _operation_from_row(row)

    def active_operation(self, now: float | None = None) -> dict[str, object] | None:
        now_value = int(time.time() if now is None else now)
        with self.connect() as connection:
            row = connection.execute(
                f"""
                SELECT {_OPERATION_COLUMNS}
                FROM operations
                WHERE state IN ('queued', 'running')
                   OR (
                       state = 'awaiting_force_confirmation'
                       AND (confirmation_expires_at IS NULL OR confirmation_expires_at > ?)
                   )
                ORDER BY created_at LIMIT 1
                """,
                (now_value,),
            ).fetchone()
        return _operation_from_row(row)

    def recover_incomplete_operations(self) -> list[dict[str, object]]:
        now = int(time.time())
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT {_OPERATION_COLUMNS}
                FROM operations
                WHERE state IN ('queued', 'running', 'awaiting_force_confirmation')
                ORDER BY created_at
                """
            ).fetchall()
            connection.execute(
                """
                UPDATE operations
                SET state = 'failed', stage = 'interrupted',
                    error_code = 'CONSOLE_RESTARTED',
                    detail = 'Console exited before the operation completed.',
                    updated_at = ?
                WHERE state IN ('queued', 'running', 'awaiting_force_confirmation')
                """,
                (now,),
            )
        return [operation for row in rows if (operation := _operation_from_row(row)) is not None]

    def fail_incomplete_operations(self) -> int:
        return len(self.recover_incomplete_operations())

    def record_audit_event(
        self,
        event_type: str,
        result: str,
        detail_json: str = "{}",
        peer_ip: str | None = None,
        source: str = "console",
        dedup_key: str | None = None,
        parser_version: str | None = None,
    ) -> int | None:
        with self.connect() as connection:
            try:
                cursor = connection.execute(
                    """
                    INSERT INTO audit_events(
                        event_type, peer_ip, result, detail_json, created_at,
                        source, dedup_key, parser_version
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        event_type,
                        peer_ip,
                        result,
                        detail_json,
                        int(time.time()),
                        source,
                        dedup_key,
                        parser_version,
                    ),
                )
            except sqlite3.IntegrityError:
                return None
        return int(cursor.lastrowid or 0)

    def list_audit_events(
        self,
        page: int = 1,
        page_size: int = 50,
        event_type: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> tuple[list[dict[str, object]], int]:
        page = max(1, page)
        page_size = min(200, max(1, page_size))
        clauses: list[str] = []
        values: list[object] = []
        if event_type:
            clauses.append("event_type = ?")
            values.append(event_type)
        if result:
            clauses.append("result = ?")
            values.append(result)
        if source:
            clauses.append("source = ?")
            values.append(source)
        if since is not None:
            clauses.append("created_at >= ?")
            values.append(since)
        if until is not None:
            clauses.append("created_at <= ?")
            values.append(until)
        where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
        with self.connect() as connection:
            total = int(
                connection.execute(
                    f"SELECT COUNT(*) AS count FROM audit_events{where}", values
                ).fetchone()["count"]
            )
            rows = connection.execute(
                f"""
                SELECT id, event_type, peer_ip, result, detail_json, created_at,
                       source, dedup_key, parser_version
                FROM audit_events{where}
                ORDER BY created_at DESC, id DESC
                LIMIT ? OFFSET ?
                """,
                [*values, page_size, (page - 1) * page_size],
            ).fetchall()
        return [dict(row) for row in rows], total

    def audit_events_for_export(
        self,
        event_type: str | None = None,
        result: str | None = None,
        source: str | None = None,
        since: int | None = None,
        until: int | None = None,
    ) -> list[dict[str, object]]:
        rows, total = self.list_audit_events(
            page=1,
            page_size=200,
            event_type=event_type,
            result=result,
            source=source,
            since=since,
            until=until,
        )
        if total > 200:
            # Export is intentionally bounded to avoid materialising an unbounded log.
            raise ValueError("AUDIT_EXPORT_TOO_LARGE")
        return rows

    def prune_audit_events(self, before: int) -> int:
        with self.connect() as connection:
            cursor = connection.execute("DELETE FROM audit_events WHERE created_at < ?", (before,))
        return cursor.rowcount

    def log_cursor(self, source_path: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT source_path, file_identity, offset, generation, updated_at "
                "FROM log_cursors WHERE source_path = ?",
                (source_path,),
            ).fetchone()
        return None if row is None else dict(row)

    def set_log_cursor(
        self,
        source_path: str,
        file_identity: str,
        offset: int,
        generation: int,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO log_cursors(source_path, file_identity, offset, generation, updated_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(source_path) DO UPDATE SET
                    file_identity=excluded.file_identity,
                    offset=excluded.offset,
                    generation=excluded.generation,
                    updated_at=excluded.updated_at
                """,
                (source_path, file_identity, offset, generation, int(time.time())),
            )

    def upsert_backup_index(
        self,
        backup_id: str,
        relative_path: str,
        observed_at: int,
        validation_result: str,
        restore_result: str | None = None,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO backup_index(
                    id, relative_path, observed_at, validation_result, restore_result
                )
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    relative_path=excluded.relative_path,
                    observed_at=excluded.observed_at,
                    validation_result=excluded.validation_result,
                    restore_result=COALESCE(excluded.restore_result, backup_index.restore_result)
                """,
                (backup_id, relative_path, observed_at, validation_result, restore_result),
            )
