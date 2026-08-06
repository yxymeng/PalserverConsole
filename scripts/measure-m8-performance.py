"""Measure the M8 local API baseline without touching a real PalServer.

The script starts an isolated FastAPI TestClient, samples the process RSS and
times read-only endpoints. Parser metrics are read from the persisted snapshot
when PALSERVER_CONSOLE_DATA points at a data directory that has a successful
parse; otherwise the report explicitly records that no parser run was made.
"""

from __future__ import annotations

import json
import os
import sqlite3
import statistics
import time
from pathlib import Path
from typing import Any

import psutil
from fastapi.testclient import TestClient

from palserver_console.config import AppSettings
from palserver_console.main import create_app


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return ordered[index]


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    data_dir = Path(os.environ.get("PALSERVER_CONSOLE_DATA", root / "data"))
    settings = AppSettings(data_dir=data_dir, static_dir=root / "frontend" / "dist")
    process = psutil.Process()
    timings: list[float] = []
    rss_samples: list[int] = []
    with TestClient(
        create_app(settings),
        base_url="http://127.0.0.1:8223",
        client=("127.0.0.1", 50000),
    ) as client:
        # Warm up the same read-only path used by the launcher smoke check.
        assert client.get("/api/health").status_code == 200
        idle_rss = process.memory_info().rss
        for _ in range(30):
            started = time.perf_counter()
            response = client.get("/api/health")
            response.raise_for_status()
            timings.append((time.perf_counter() - started) * 1000)
            rss_samples.append(process.memory_info().rss)
        peak_rss = max(rss_samples, default=idle_rss)
        bootstrap = client.get("/api/bootstrap")
        bootstrap.raise_for_status()

    parser: dict[str, Any]
    snapshot_db = data_dir / "app.db"
    has_snapshot = False
    parse_result: dict[str, Any] | None = None
    if snapshot_db.is_file():
        with sqlite3.connect(snapshot_db) as connection:
            row = connection.execute(
                "SELECT parse_result FROM snapshot_versions WHERE is_current = 1 LIMIT 1"
            ).fetchone()
            has_snapshot = row is not None
            if row is not None:
                try:
                    loaded = json.loads(str(row[0]))
                    if isinstance(loaded, dict):
                        parse_result = loaded
                except json.JSONDecodeError:
                    parse_result = None
    if has_snapshot:
        # Reopen through the application would start workers; the persisted
        # metrics are already available in the status payload when configured.
        parser = {
            "status": "reported-by-world-service",
            "source": str(snapshot_db),
            "durationMs": parse_result.get("durationMs") if parse_result else None,
            "peakMemoryBytes": parse_result.get("peakMemoryBytes") if parse_result else None,
            "cacheSizeBytes": parse_result.get("cacheSizeBytes") if parse_result else None,
        }
    else:
        parser = {
            "status": "not-measured",
            "source": None,
            "note": "当前工作区没有成功存档解析缓存；未连接真实 PalServer。",
        }

    report = {
        "generatedAt": int(time.time()),
        "environment": "isolated FastAPI TestClient; no PalServer writes",
        "idleRssBytes": idle_rss,
        "peakRssBytes": peak_rss,
        "apiHealth": {
            "samples": len(timings),
            "meanMs": round(statistics.mean(timings), 3),
            "p50Ms": round(percentile(timings, 0.50), 3),
            "p95Ms": round(percentile(timings, 0.95), 3),
            "maxMs": round(max(timings), 3),
        },
        "parser": parser,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
