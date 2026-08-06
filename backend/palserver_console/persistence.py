from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 3

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
)


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
                connection.executescript(MIGRATIONS[version - 1])
                connection.execute(f"PRAGMA user_version = {version}")

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

    def create_operation(
        self, operation_id: str, kind: str, idempotency_key: str
    ) -> dict[str, object]:
        now = int(time.time())
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO operations(
                    id, kind, state, stage, error_code, idempotency_key, created_at, updated_at
                ) VALUES(?, ?, 'queued', 'queued', NULL, ?, ?, ?)
                """,
                (operation_id, kind, idempotency_key, now, now),
            )
        operation = self.operation(operation_id)
        if operation is None:
            raise RuntimeError("Operation insert did not persist.")
        return operation

    def update_operation(
        self,
        operation_id: str,
        state: str,
        stage: str,
        error_code: str | None = None,
        detail: str | None = None,
    ) -> None:
        with self.connect() as connection:
            connection.execute(
                """
                UPDATE operations
                SET state = ?, stage = ?, error_code = ?, detail = ?, updated_at = ?
                WHERE id = ?
                """,
                (state, stage, error_code, detail, int(time.time()), operation_id),
            )

    def operation(self, operation_id: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, kind, state, stage, error_code, detail, created_at, updated_at
                FROM operations WHERE id = ?
                """,
                (operation_id,),
            ).fetchone()
        return None if row is None else dict(row)

    def operation_by_idempotency(self, idempotency_key: str) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, kind, state, stage, error_code, detail, created_at, updated_at
                FROM operations WHERE idempotency_key = ?
                """,
                (idempotency_key,),
            ).fetchone()
        return None if row is None else dict(row)

    def active_operation(self) -> dict[str, object] | None:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT id, kind, state, stage, error_code, detail, created_at, updated_at
                FROM operations
                WHERE state IN ('queued', 'running')
                ORDER BY created_at LIMIT 1
                """
            ).fetchone()
        return None if row is None else dict(row)

    def fail_incomplete_operations(self) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                """
                UPDATE operations
                SET state = 'failed', stage = 'interrupted',
                    error_code = 'CONSOLE_RESTARTED',
                    detail = 'Console exited before the operation completed.',
                    updated_at = ?
                WHERE state IN ('queued', 'running')
                """,
                (int(time.time()),),
            )
        return cursor.rowcount

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
