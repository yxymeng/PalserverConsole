from __future__ import annotations

import argparse
import errno
import json
import sys
import time
from pathlib import Path

import psutil

from .adapter import read_save_properties
from .cache import build_world_cache


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Parse a read-only Palworld snapshot.")
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--snapshot-id", required=True)
    parser.add_argument("--source-observed-at", type=int, required=True)
    parser.add_argument("--collected-at", type=int)
    parser.add_argument("--parse-started-at", type=int)
    parser.add_argument("--ooz-dll", type=Path)
    arguments = parser.parse_args(argv)
    started = time.perf_counter()
    parse_started_at = arguments.parse_started_at or int(time.time())
    try:
        snapshot = arguments.snapshot.resolve(strict=True)
        level_path = (snapshot / "Level.sav").resolve(strict=True)
        players_root = (snapshot / "Players").resolve(strict=True)
        level_path.relative_to(snapshot)
        players_root.relative_to(snapshot)
        if not level_path.is_file() or not players_root.is_dir():
            raise ValueError("Snapshot must contain Level.sav and Players.")
        player_paths = sorted(
            path for path in players_root.glob("*.sav") if path.is_file() and not path.is_symlink()
        )
        level = read_save_properties(level_path, ooz_dll_path=arguments.ooz_dll)
        players = [
            read_save_properties(path, ooz_dll_path=arguments.ooz_dll)
            for path in player_paths
        ]
        counts = build_world_cache(
            arguments.cache,
            level,
            players,
            snapshot_id=arguments.snapshot_id,
            source_observed_at=arguments.source_observed_at,
            collected_at=arguments.collected_at,
            parse_started_at=parse_started_at,
        )
        parsed_at = int(time.time())
        duration_ms = round((time.perf_counter() - started) * 1000)
        memory = psutil.Process().memory_info()
        peak_memory = int(getattr(memory, "peak_wset", memory.rss))
        print(
            json.dumps(
                {
                    "ok": True,
                    "parsedAt": parsed_at,
                    "parseStartedAt": parse_started_at,
                    "durationMs": duration_ms,
                    "peakMemoryBytes": peak_memory,
                    "cacheSizeBytes": arguments.cache.stat().st_size,
                    "counts": counts,
                },
                separators=(",", ":"),
            )
        )
        return 0
    except Exception as error:
        error_code = "DISK_SPACE_LOW" if _is_disk_full_error(error) else "PARSER_FAILED"
        print(
            json.dumps(
                {
                    "ok": False,
                    "errorCode": error_code,
                    "errorType": type(error).__name__,
                    "error": str(error),
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
