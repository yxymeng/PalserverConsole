from __future__ import annotations

import errno
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

DEFAULT_SNAPSHOT_RETENTION_COUNT = 8
DEFAULT_SNAPSHOT_RETENTION_BYTES = 4 * 1024 * 1024 * 1024
DEFAULT_SNAPSHOT_RETENTION_AGE_SECONDS = 30 * 24 * 60 * 60
DEFAULT_MINIMUM_FREE_BYTES = 512 * 1024 * 1024
DEFAULT_OOZ_DISCOVERY_CACHE_TTL_SECONDS = 300.0


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
        snapshot_retention_count: int = DEFAULT_SNAPSHOT_RETENTION_COUNT,
        snapshot_retention_bytes: int = DEFAULT_SNAPSHOT_RETENTION_BYTES,
        snapshot_retention_age_seconds: float = DEFAULT_SNAPSHOT_RETENTION_AGE_SECONDS,
        minimum_free_bytes: int = DEFAULT_MINIMUM_FREE_BYTES,
        cleanup_interval_seconds: float = 60.0,
        disk_usage_provider: Callable[[Path], Any] | None = None,
        clock: Callable[[], float] = time.time,
        ooz_discovery_cache_ttl_seconds: float = DEFAULT_OOZ_DISCOVERY_CACHE_TTL_SECONDS,
    ) -> None:
        self.database = database
        self.executable_provider = executable_provider
        self.data_dir = data_dir
        self.snapshots_root = data_dir / "snapshots"
        self.cache_root = data_dir / "cache"
        self.stability_seconds = stability_seconds
        self.poll_seconds = poll_seconds
        self.worker_timeout_seconds = worker_timeout_seconds
        self.profile_provider = profile_provider
        self.snapshot_retention_count = max(1, int(snapshot_retention_count))
        self.snapshot_retention_bytes = max(0, int(snapshot_retention_bytes))
        self.snapshot_retention_age_seconds = max(0.0, float(snapshot_retention_age_seconds))
        self.minimum_free_bytes = max(0, int(minimum_free_bytes))
        self.cleanup_interval_seconds = max(0.0, float(cleanup_interval_seconds))
        self.disk_usage_provider = disk_usage_provider or shutil.disk_usage
        self.clock = clock
        self.ooz_discovery_cache_ttl_seconds = max(
            0.0, float(ooz_discovery_cache_ttl_seconds)
        )
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
        self._last_cleanup_at: float | None = None
        self._ooz_discovery_cache: tuple[str, float, Path | None] | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.snapshots_root.mkdir(parents=True, exist_ok=True)
        self.cache_root.mkdir(parents=True, exist_ok=True)
        self._maybe_cleanup_storage(force=True)
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
            self._ooz_discovery_cache = None
        self._wake.set()

    def cleanup_storage(self) -> dict[str, int]:
        with self._lock:
            if self._parsing:
                return {
                    "removedSnapshots": 0,
                    "removedCaches": 0,
                    "removedTemp": 0,
                    "removedBytes": 0,
                    "errors": 0,
                }
            return self._cleanup_storage_locked()

    def status(self) -> dict[str, object]:
        current = self.database.current_snapshot_version()
        with self._lock:
            error = self._last_error
            parsing = self._parsing
            duration = self._last_duration_ms
            peak_memory = self._last_peak_memory_bytes
            cache_size = self._last_cache_size_bytes
            counts = dict(self._last_counts)
        collected_at: int | None = None
        parsed_at: int | None = None
        if current:
            try:
                persisted = json.loads(str(current["parse_result"]))
                if isinstance(persisted, dict):
                    duration = int(persisted.get("durationMs", 0)) or None
                    peak_memory = int(persisted.get("peakMemoryBytes", 0)) or None
                    cache_size = int(persisted.get("cacheSizeBytes", 0)) or None
                    collected_at = int(persisted.get("collectedAt", 0)) or None
                    parsed_at = int(persisted.get("parsedAt", 0)) or None
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
            "sourceObservedAt": observed_at,
            "collectedAt": collected_at,
            "parsedAt": parsed_at,
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
                if error.code == "DISK_SPACE_LOW":
                    with self._lock:
                        self._pending = self._last_seen
                        self._pending_since = time.monotonic()
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
        snapshot_id = f"{int(self.clock())}-{uuid.uuid4().hex[:12]}"
        temporary = self.snapshots_root / f".{snapshot_id}.tmp"
        ready = self.snapshots_root / snapshot_id
        collected_at = int(self.clock())
        source_observed_at = self._source_observed_at(expected, collected_at)
        self._assert_internal_path(temporary, self.snapshots_root)
        if temporary.exists():
            self._remove_internal_tree(temporary, self.snapshots_root)
        self._ensure_disk_space(self._fingerprint_size(expected))
        temporary.mkdir(parents=True)
        successful = False
        try:
            try:
                shutil.copy2(world / "Level.sav", temporary / "Level.sav")
                shutil.copy2(world / "LevelMeta.sav", temporary / "LevelMeta.sav")
                shutil.copytree(world / "Players", temporary / "Players")
            except OSError as error:
                if self._is_disk_full_error(error):
                    raise WorldDataError(
                        "DISK_SPACE_LOW", "磁盘剩余空间不足，已保留最后成功缓存。"
                    ) from error
                raise
            if self._fingerprint(world) != expected:
                raise WorldDataError(
                    "SNAPSHOT_SOURCE_CHANGED",
                    "复制快照期间源文件发生变化，本次副本已丢弃并等待重试。",
                )
            (temporary / "snapshot.json").write_text(
                json.dumps(
                    {
                        "snapshotId": snapshot_id,
                        "collectedAt": collected_at,
                        "sourceObservedAt": source_observed_at,
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
            os.replace(temporary, ready)
        except Exception:
            if temporary.exists():
                self._remove_internal_tree(temporary, self.snapshots_root)
            raise

        cache_temp = self.cache_root / f".world-cache-{snapshot_id}.tmp.sqlite"
        cache_ready = self.cache_root / f"world-cache-{snapshot_id}.sqlite"
        self._assert_internal_path(cache_temp, self.cache_root)
        parse_started_at = int(self.clock())
        with self._lock:
            self._parsing = True
        try:
            self._ensure_disk_space()
            result = self._run_worker(
                ready,
                cache_temp,
                snapshot_id,
                source_observed_at,
                collected_at=collected_at,
                parse_started_at=parse_started_at,
            )
            if not cache_temp.is_file():
                raise WorldDataError("PARSER_NO_CACHE", "解析子进程未生成缓存文件。")
            counts = validate_cache_file(cache_temp)
            self._ensure_disk_space()
            os.replace(cache_temp, cache_ready)
            parsed_at = self._result_timestamp(result, "parsedAt", int(self.clock()))
            duration_ms = self._result_int(result, "durationMs")
            peak_memory_bytes = self._result_int(result, "peakMemoryBytes")
            cache_size_bytes = self._result_int(result, "cacheSizeBytes")
            parse_result = {
                "status": "success",
                "collectedAt": collected_at,
                "sourceObservedAt": source_observed_at,
                "parseStartedAt": parse_started_at,
                "parsedAt": parsed_at,
                "durationMs": duration_ms,
                "peakMemoryBytes": peak_memory_bytes,
                "cacheSizeBytes": cache_size_bytes,
            }
            self.database.record_snapshot_version(
                snapshot_id,
                str(cache_ready.resolve()),
                source_observed_at,
                json.dumps(
                    parse_result,
                    separators=(",", ":"),
                ),
                make_current=True,
            )
            with self._lock:
                self._last_error = None
                self._last_duration_ms = duration_ms
                self._last_peak_memory_bytes = peak_memory_bytes
                self._last_cache_size_bytes = cache_size_bytes
                self._last_counts = counts
            successful = True
        except Exception as error:
            cache_temp.unlink(missing_ok=True)
            current_snapshot = self.database.current_snapshot_version()
            if cache_ready.exists() and (
                current_snapshot is None or str(current_snapshot["id"]) != snapshot_id
            ):
                cache_ready.unlink(missing_ok=True)
            if ready.exists() and (
                current_snapshot is None or str(current_snapshot["id"]) != snapshot_id
            ):
                self._remove_internal_tree(ready, self.snapshots_root)
            self.database.record_snapshot_version(
                snapshot_id,
                "",
                source_observed_at,
                f"failed:{type(error).__name__}",
                make_current=False,
            )
            if isinstance(error, WorldDataError):
                self._set_error(error.code, str(error))
            elif self._is_disk_full_error(error):
                self._set_error("DISK_SPACE_LOW", "磁盘剩余空间不足，已保留最后成功缓存。")
            else:
                self._set_error("SNAPSHOT_PARSE_FAILED", f"{type(error).__name__}: {error}")
        finally:
            with self._lock:
                self._parsing = False
        if successful:
            self._maybe_cleanup_storage()

    def _run_worker(
        self,
        snapshot: Path,
        cache_path: Path,
        snapshot_id: str,
        observed_at: int,
        *,
        collected_at: int | None = None,
        parse_started_at: int | None = None,
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
        if collected_at is not None:
            command.extend(["--collected-at", str(collected_at)])
        if parse_started_at is not None:
            command.extend(["--parse-started-at", str(parse_started_at)])
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
            try:
                failure = json.loads(detail)
            except json.JSONDecodeError:
                failure = None
            if isinstance(failure, dict) and failure.get("errorCode") == "DISK_SPACE_LOW":
                raise WorldDataError("DISK_SPACE_LOW", "磁盘剩余空间不足，已保留最后成功缓存。")
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
            cache_key = f"env:{configured}"
            found, cached = self._cached_ooz_result(cache_key)
            if found:
                return cached
            candidate = Path(configured).resolve(strict=False)
            result = candidate if candidate.is_file() else None
            self._store_ooz_result(cache_key, result)
            return result

        executable: Path | None
        if self.profile_provider is not None:
            try:
                executable = self.profile_provider().executable_path
            except ProfileError:
                executable = None
        else:
            executable = self.executable_provider()
        cache_key = (
            f"exe:{executable.resolve(strict=False)}" if executable is not None else "exe:none"
        )
        found, cached = self._cached_ooz_result(cache_key)
        if found:
            return cached
        if executable is None:
            self._store_ooz_result(cache_key, None)
            return None
        try:
            result = next(executable.resolve(strict=True).parent.rglob("libooz.dll"), None)
        except OSError:
            result = None
        self._store_ooz_result(cache_key, result)
        return result

    def _cached_ooz_result(self, key: str) -> tuple[bool, Path | None]:
        cached = self._ooz_discovery_cache
        if cached is None:
            return False, None
        cached_key, cached_at, result = cached
        if cached_key != key or self.clock() - cached_at >= self.ooz_discovery_cache_ttl_seconds:
            return False, None
        return True, result

    def _store_ooz_result(self, key: str, result: Path | None) -> None:
        self._ooz_discovery_cache = (key, self.clock(), result)

    def _ensure_disk_space(self, required_bytes: int = 0) -> None:
        if self.minimum_free_bytes <= 0:
            return
        try:
            free_bytes = int(self.disk_usage_provider(self.data_dir).free)
        except (AttributeError, OSError, TypeError, ValueError) as error:
            raise WorldDataError(
                "DISK_USAGE_UNAVAILABLE", "无法确认运行数据目录的剩余磁盘空间。"
            ) from error
        if free_bytes < self.minimum_free_bytes + max(0, int(required_bytes)):
            raise WorldDataError("DISK_SPACE_LOW", "磁盘剩余空间不足，已保留最后成功缓存。")

    @staticmethod
    def _is_disk_full_error(error: BaseException) -> bool:
        return (
            isinstance(error, OSError)
            and (
                error.errno == errno.ENOSPC
                or getattr(error, "winerror", None) == 112
                or any(
                    marker in str(error).casefold()
                    for marker in ("no space", "not enough space", "disk full")
                )
            )
        )

    @staticmethod
    def _fingerprint_size(expected: tuple[tuple[str, int, int], ...]) -> int:
        return sum(max(0, int(size)) for _, size, _ in expected)

    @staticmethod
    def _source_observed_at(
        expected: tuple[tuple[str, int, int], ...], fallback: int
    ) -> int:
        if not expected:
            return fallback
        return max(int(mtime_ns // 1_000_000_000) for _, _, mtime_ns in expected)

    @staticmethod
    def _result_int(result: dict[str, Any], key: str) -> int:
        try:
            return max(0, int(result.get(key, 0)))
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _result_timestamp(result: dict[str, Any], key: str, fallback: int) -> int:
        try:
            return max(0, int(result.get(key, fallback)))
        except (TypeError, ValueError):
            return fallback

    def _maybe_cleanup_storage(self, *, force: bool = False) -> None:
        now = self.clock()
        with self._lock:
            if self._parsing:
                return
            if (
                not force
                and self._last_cleanup_at is not None
                and now - self._last_cleanup_at < self.cleanup_interval_seconds
            ):
                return
        self.cleanup_storage()
        with self._lock:
            self._last_cleanup_at = now

    def _cleanup_storage_locked(self) -> dict[str, int]:
        report = {
            "removedSnapshots": 0,
            "removedCaches": 0,
            "removedTemp": 0,
            "removedBytes": 0,
            "errors": 0,
        }
        self.snapshots_root.mkdir(parents=True, exist_ok=True)
        self.cache_root.mkdir(parents=True, exist_ok=True)
        try:
            snapshot_entries = list(self.snapshots_root.iterdir())
            cache_entries = list(self.cache_root.iterdir())
        except OSError:
            report["errors"] += 1
            return report

        temp_entries = [
            path
            for path in [*snapshot_entries, *cache_entries]
            if self._is_temp_entry(path)
        ]
        for path in temp_entries:
            try:
                report["removedBytes"] += self._remove_internal_entry(
                    path,
                    self.snapshots_root if path.parent == self.snapshots_root else self.cache_root,
                )
                report["removedTemp"] += 1
            except (OSError, WorldDataError):
                report["errors"] += 1

        try:
            snapshot_map = {
                path.name: path
                for path in self.snapshots_root.iterdir()
                if path.is_dir() and not path.is_symlink() and not path.name.startswith(".")
            }
            cache_map = {
                path.name[len("world-cache-") : -len(".sqlite")]: path
                for path in self.cache_root.iterdir()
                if (
                    path.is_file()
                    and not path.is_symlink()
                    and path.name.startswith("world-cache-")
                    and path.name.endswith(".sqlite")
                )
            }
        except OSError:
            report["errors"] += 1
            return report

        current = self.database.current_snapshot_version()
        current_id = str(current["id"]) if current is not None else None
        protected_cache_name = self._current_cache_name(current)
        for snapshot_id in sorted(set(snapshot_map) - set(cache_map)):
            if snapshot_id == current_id:
                continue
            try:
                report["removedBytes"] += self._remove_internal_entry(
                    snapshot_map[snapshot_id], self.snapshots_root
                )
                report["removedSnapshots"] += 1
            except (OSError, WorldDataError):
                report["errors"] += 1
        for snapshot_id in sorted(set(cache_map) - set(snapshot_map)):
            if snapshot_id == current_id or cache_map[snapshot_id].name == protected_cache_name:
                continue
            try:
                report["removedBytes"] += self._remove_internal_entry(
                    cache_map[snapshot_id], self.cache_root
                )
                report["removedCaches"] += 1
            except (OSError, WorldDataError):
                report["errors"] += 1

        complete_ids = set(snapshot_map) & set(cache_map)
        items: dict[str, dict[str, Any]] = {}
        for snapshot_id in complete_ids:
            items[snapshot_id] = {
                "id": snapshot_id,
                "snapshot": snapshot_map[snapshot_id],
                "cache": cache_map[snapshot_id],
                "collectedAt": self._snapshot_collected_at(snapshot_map[snapshot_id]),
                "bytes": self._entry_size(snapshot_map[snapshot_id])
                + self._entry_size(cache_map[snapshot_id]),
            }

        non_current = [item for item in items.values() if item["id"] != current_id]
        keep_count = self.snapshot_retention_count - (1 if current_id in items else 0)
        newest = sorted(
            non_current,
            key=lambda item: (float(item["collectedAt"]), str(item["id"])),
            reverse=True,
        )[: max(0, keep_count)]
        keep_ids = {str(item["id"]) for item in newest}
        remove_ids = {
            str(item["id"])
            for item in non_current
            if str(item["id"]) not in keep_ids
        }
        now = self.clock()
        for item in non_current:
            if now - float(item["collectedAt"]) > self.snapshot_retention_age_seconds:
                remove_ids.add(str(item["id"]))

        remaining = [item for item in items.values() if str(item["id"]) not in remove_ids]
        total_bytes = sum(int(item["bytes"]) for item in remaining)
        if total_bytes > self.snapshot_retention_bytes:
            for item in sorted(
                remaining,
                key=lambda value: (float(value["collectedAt"]), str(value["id"])),
            ):
                snapshot_id = str(item["id"])
                if snapshot_id == current_id:
                    continue
                remove_ids.add(snapshot_id)
                total_bytes -= int(item["bytes"])
                if total_bytes <= self.snapshot_retention_bytes:
                    break

        for snapshot_id in sorted(remove_ids):
            snapshot_path = snapshot_map[snapshot_id]
            cache_path = cache_map[snapshot_id]
            for path, root, key in (
                (snapshot_path, self.snapshots_root, "removedSnapshots"),
                (cache_path, self.cache_root, "removedCaches"),
            ):
                try:
                    report["removedBytes"] += self._remove_internal_entry(path, root)
                    report[key] += 1
                except (OSError, WorldDataError):
                    report["errors"] += 1
        return report

    @staticmethod
    def _is_temp_entry(path: Path) -> bool:
        name = path.name
        return (
            (name.startswith(".") and name.endswith(".tmp"))
            or (name.startswith(".world-cache-") and ".tmp" in name)
        )

    @staticmethod
    def _snapshot_collected_at(path: Path) -> float:
        metadata = path / "snapshot.json"
        try:
            raw = json.loads(metadata.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return float(raw.get("collectedAt", raw.get("collected_at")))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            pass
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    def _current_cache_name(self, current: dict[str, object] | None) -> str | None:
        if current is None:
            return None
        try:
            path = Path(str(current["cache_path"])).resolve(strict=False)
            root = self.cache_root.resolve(strict=False)
            relative = path.relative_to(root)
            return path.name if len(relative.parts) == 1 else None
        except (KeyError, TypeError, ValueError):
            return None

    @classmethod
    def _entry_size(cls, path: Path) -> int:
        try:
            if path.is_file() and not path.is_symlink():
                return int(path.stat().st_size)
            if path.is_dir() and not path.is_symlink():
                return sum(
                    int(child.stat().st_size)
                    for child in path.rglob("*")
                    if child.is_file() and not child.is_symlink()
                )
        except OSError:
            return 0
        return 0

    @classmethod
    def _remove_internal_entry(cls, path: Path, root: Path) -> int:
        cls._assert_internal_path(path, root)
        size = cls._entry_size(path)
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.is_file() and not path.is_symlink():
            path.unlink()
        elif path.exists() or path.is_symlink():
            raise WorldDataError("INTERNAL_PATH_INVALID", "运行数据路径不安全。")
        return size

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
