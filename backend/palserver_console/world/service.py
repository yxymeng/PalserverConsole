from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..config import ProfileError, ServerProfile
from ..persistence import Database
from .cache import player_detail, query_cache, validate_cache_file


class WorldDataError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class WorldSnapshotService:
    def __init__(
        self,
        database: Database,
        executable_provider: Callable[[], Path | None],
        data_dir: Path,
        *,
        stability_seconds: float = 5.0,
        poll_seconds: float = 1.0,
        worker_timeout_seconds: float = 180.0,
        profile_provider: Callable[[], ServerProfile] | None = None,
    ) -> None:
        self.database = database
        self.executable_provider = executable_provider
        self.snapshots_root = data_dir / "snapshots"
        self.cache_root = data_dir / "cache"
        self.stability_seconds = stability_seconds
        self.poll_seconds = poll_seconds
        self.worker_timeout_seconds = worker_timeout_seconds
        self.profile_provider = profile_provider
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.RLock()
        self._last_seen: tuple[tuple[str, int, int], ...] | None = None
        self._pending: tuple[tuple[str, int, int], ...] | None = None
        self._pending_since = 0.0
        self._parsing = False
        self._last_error: tuple[str, str] | None = None
        self._last_duration_ms: int | None = None
        self._last_peak_memory_bytes: int | None = None
        self._last_cache_size_bytes: int | None = None
        self._last_counts: dict[str, int] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.snapshots_root.mkdir(parents=True, exist_ok=True)
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self._stop.clear()
        self._thread = threading.Thread(target=self._watch_loop, name="world-snapshot", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread:
            self._thread.join(timeout=5)

    def request_reparse(self) -> None:
        with self._lock:
            self._last_seen = None
            self._pending = None
        self._wake.set()

    def status(self) -> dict[str, object]:
        current = self.database.current_snapshot_version()
        with self._lock:
            error = self._last_error
            parsing = self._parsing
            duration = self._last_duration_ms
            peak_memory = self._last_peak_memory_bytes
            cache_size = self._last_cache_size_bytes
            counts = dict(self._last_counts)
        if current and duration is None:
            try:
                persisted = json.loads(str(current["parse_result"]))
                if isinstance(persisted, dict):
                    duration = int(persisted.get("durationMs", 0)) or None
                    peak_memory = int(persisted.get("peakMemoryBytes", 0)) or None
                    cache_size = int(persisted.get("cacheSizeBytes", 0)) or None
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        if current and not counts:
            cache_path = Path(str(current["cache_path"]))
            if cache_path.is_file():
                try:
                    counts = validate_cache_file(cache_path)
                except (OSError, ValueError, json.JSONDecodeError):
                    error = ("CACHE_INVALID", "最后成功缓存无法读取。")
        observed_at = (
            int(str(current["source_observed_at"])) if current else int(time.time())
        )
        return {
            "source": "save-snapshot",
            "observedAt": observed_at,
            "stale": error is not None or current is None,
            "errorCode": error[0] if error else ("SNAPSHOT_PENDING" if current is None else None),
            "error": error[1] if error else None,
            "snapshotId": current["id"] if current else None,
            "parsing": parsing,
            "parseDurationMs": duration,
            "peakMemoryBytes": peak_memory,
            "cacheSizeBytes": cache_size,
            "counts": counts,
        }

    def list_resource(
        self,
        resource: str,
        *,
        page: int,
        page_size: int,
        search: str | None,
        owner_id: str | None,
        base_id: str | None,
    ) -> dict[str, object]:
        cache = self._current_cache()
        items, total = query_cache(
            cache,
            resource,
            page=page,
            page_size=page_size,
            search=search,
            owner_id=owner_id,
            base_id=base_id,
        )
        state = self.status()
        return {
            "items": items,
            "page": page,
            "pageSize": page_size,
            "total": total,
            "source": state["source"],
            "observedAt": state["observedAt"],
            "stale": state["stale"],
            "errorCode": state["errorCode"],
        }

    def get_player(self, player_id: str) -> dict[str, object]:
        result = player_detail(self._current_cache(), player_id)
        if result is None:
            raise WorldDataError("PLAYER_NOT_FOUND", "玩家不存在于当前存档缓存。")
        state = self.status()
        return {
            **result,
            "source": state["source"],
            "observedAt": state["observedAt"],
            "stale": state["stale"],
            "errorCode": state["errorCode"],
        }

    def _current_cache(self) -> Path:
        current = self.database.current_snapshot_version()
        if current is None:
            raise WorldDataError("WORLD_CACHE_UNAVAILABLE", "尚无成功的存档解析缓存。")
        path = Path(str(current["cache_path"])).resolve(strict=False)
        root = self.cache_root.resolve(strict=False)
        try:
            path.relative_to(root)
        except ValueError as error:
            raise WorldDataError("CACHE_PATH_INVALID", "当前缓存路径越界。") from error
        if not path.is_file() or path.suffix.casefold() != ".sqlite":
            raise WorldDataError("WORLD_CACHE_UNAVAILABLE", "最后成功缓存文件不存在。")
        return path

    def _watch_loop(self) -> None:
        while not self._stop.is_set():
            try:
                world = self._world_directory()
                fingerprint = self._fingerprint(world)
                now = time.monotonic()
                should_parse = False
                with self._lock:
                    if fingerprint != self._last_seen:
                        self._last_seen = fingerprint
                        self._pending = fingerprint
                        self._pending_since = now
                    elif (
                        self._pending == fingerprint
                        and now - self._pending_since >= self.stability_seconds
                    ):
                        self._pending = None
                        should_parse = True
                if should_parse:
                    self._capture_and_parse(world, fingerprint)
            except WorldDataError as error:
                self._set_error(error.code, str(error))
            except Exception as error:
                self._set_error("SNAPSHOT_WATCH_FAILED", f"{type(error).__name__}: {error}")
            self._wake.wait(self.poll_seconds)
            self._wake.clear()

    def _world_directory(self) -> Path:
        if self.profile_provider is not None:
            try:
                return self.profile_provider().world_path
            except ProfileError as error:
                raise WorldDataError(error.code, str(error)) from error
        executable = self.executable_provider()
        if executable is None:
            raise WorldDataError("SERVER_NOT_CONFIGURED", "尚未选择 PalServer.exe。")
        try:
            install = executable.resolve(strict=True).parent
            root = (install / "Pal" / "Saved" / "SaveGames" / "0").resolve(strict=True)
        except OSError as error:
            raise WorldDataError(
                "WORLD_PATH_UNAVAILABLE", f"{type(error).__name__}: {error}"
            ) from error
        candidates = [
            path for path in root.iterdir() if path.is_dir() and (path / "Level.sav").is_file()
        ]
        if not candidates:
            raise WorldDataError("WORLD_NOT_FOUND", "未发现包含 Level.sav 的当前世界。")
        if len(candidates) > 1:
            raise WorldDataError(
                "WORLD_SELECTION_REQUIRED", "Multiple worlds were found; select a World ID first."
            )
        return candidates[0]

    def _fingerprint(self, world: Path) -> tuple[tuple[str, int, int], ...]:
        required = [world / "Level.sav", world / "LevelMeta.sav", world / "Players"]
        if not required[0].is_file() or not required[1].is_file() or not required[2].is_dir():
            raise WorldDataError(
                "WORLD_INCOMPLETE", "当前世界必须包含 Level.sav、LevelMeta.sav 和 Players。"
            )
        paths = [required[0], required[1], *sorted(required[2].glob("*.sav"))]
        return tuple(
            (str(path.relative_to(world)), path.stat().st_size, path.stat().st_mtime_ns)
            for path in paths
            if path.is_file() and not path.is_symlink()
        )

    def _capture_and_parse(
        self, world: Path, expected: tuple[tuple[str, int, int], ...]
    ) -> None:
        snapshot_id = f"{int(time.time())}-{uuid.uuid4().hex[:12]}"
        temporary = self.snapshots_root / f".{snapshot_id}.tmp"
        ready = self.snapshots_root / snapshot_id
        self._assert_internal_path(temporary, self.snapshots_root)
        if temporary.exists():
            self._remove_internal_tree(temporary, self.snapshots_root)
        temporary.mkdir(parents=True)
        try:
            shutil.copy2(world / "Level.sav", temporary / "Level.sav")
            shutil.copy2(world / "LevelMeta.sav", temporary / "LevelMeta.sav")
            shutil.copytree(world / "Players", temporary / "Players")
            if self._fingerprint(world) != expected:
                raise WorldDataError(
                    "SNAPSHOT_SOURCE_CHANGED",
                    "复制快照期间源文件发生变化，本次副本已丢弃并等待重试。",
                )
            os.replace(temporary, ready)
        except Exception:
            if temporary.exists():
                self._remove_internal_tree(temporary, self.snapshots_root)
            raise

        cache_temp = self.cache_root / f".world-cache-{snapshot_id}.tmp.sqlite"
        cache_ready = self.cache_root / f"world-cache-{snapshot_id}.sqlite"
        self._assert_internal_path(cache_temp, self.cache_root)
        with self._lock:
            self._parsing = True
        try:
            result = self._run_worker(ready, cache_temp, snapshot_id, int(time.time()))
            if not cache_temp.is_file():
                raise WorldDataError("PARSER_NO_CACHE", "解析子进程未生成缓存文件。")
            counts = validate_cache_file(cache_temp)
            os.replace(cache_temp, cache_ready)
            self.database.record_snapshot_version(
                snapshot_id,
                str(cache_ready.resolve()),
                int(time.time()),
                json.dumps(
                    {
                        "status": "success",
                        "durationMs": int(result.get("durationMs", 0)),
                        "peakMemoryBytes": int(result.get("peakMemoryBytes", 0)),
                        "cacheSizeBytes": int(result.get("cacheSizeBytes", 0)),
                    },
                    separators=(",", ":"),
                ),
                make_current=True,
            )
            with self._lock:
                self._last_error = None
                self._last_duration_ms = int(result.get("durationMs", 0))
                self._last_peak_memory_bytes = int(result.get("peakMemoryBytes", 0))
                self._last_cache_size_bytes = int(result.get("cacheSizeBytes", 0))
                self._last_counts = counts
        except Exception as error:
            cache_temp.unlink(missing_ok=True)
            self.database.record_snapshot_version(
                snapshot_id,
                "",
                int(time.time()),
                f"failed:{type(error).__name__}",
                make_current=False,
            )
            if isinstance(error, WorldDataError):
                self._set_error(error.code, str(error))
            else:
                self._set_error("SNAPSHOT_PARSE_FAILED", f"{type(error).__name__}: {error}")
        finally:
            with self._lock:
                self._parsing = False

    def _run_worker(
        self, snapshot: Path, cache_path: Path, snapshot_id: str, observed_at: int
    ) -> dict[str, Any]:
        command = [
            sys.executable,
            "-m",
            "palserver_console.world.worker",
            "--snapshot",
            str(snapshot),
            "--cache",
            str(cache_path),
            "--snapshot-id",
            snapshot_id,
            "--source-observed-at",
            str(observed_at),
        ]
        ooz_dll = self._find_ooz_dll()
        if ooz_dll:
            command.extend(["--ooz-dll", str(ooz_dll)])
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=self.worker_timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise WorldDataError("PARSER_TIMEOUT", "解析子进程超时并已结束。") from error
        if completed.returncode != 0:
            detail = completed.stderr.strip().splitlines()[-1] if completed.stderr.strip() else ""
            raise WorldDataError(
                "PARSER_CRASHED",
                f"Parser exited with code {completed.returncode}: {detail}",
            )
        try:
            result = json.loads(completed.stdout.strip().splitlines()[-1])
        except (IndexError, json.JSONDecodeError) as error:
            raise WorldDataError("PARSER_OUTPUT_INVALID", "解析子进程返回了无效结果。") from error
        if not isinstance(result, dict) or result.get("ok") is not True:
            raise WorldDataError("PARSER_OUTPUT_INVALID", "解析子进程未确认成功。")
        return result

    def _find_ooz_dll(self) -> Path | None:
        configured = os.environ.get("PALSERVER_OOZ_DLL")
        if configured:
            candidate = Path(configured).resolve(strict=False)
            return candidate if candidate.is_file() else None
        executable: Path | None
        if self.profile_provider is not None:
            try:
                executable = self.profile_provider().executable_path
            except ProfileError:
                return None
        else:
            executable = self.executable_provider()
            if executable is None:
                return None
        try:
            return next(executable.resolve(strict=True).parent.rglob("libooz.dll"), None)
        except OSError:
            return None

    def _set_error(self, code: str, message: str) -> None:
        with self._lock:
            self._last_error = (code, message)

    @staticmethod
    def _assert_internal_path(path: Path, root: Path) -> None:
        resolved_root = root.resolve(strict=False)
        resolved = path.resolve(strict=False)
        try:
            relative = resolved.relative_to(resolved_root)
        except ValueError as error:
            raise WorldDataError("INTERNAL_PATH_INVALID", "运行数据路径越界。") from error
        if len(relative.parts) != 1 or resolved == resolved_root or path.is_symlink():
            raise WorldDataError("INTERNAL_PATH_INVALID", "运行数据路径不安全。")

    @classmethod
    def _remove_internal_tree(cls, path: Path, root: Path) -> None:
        cls._assert_internal_path(path, root)
        shutil.rmtree(path)
