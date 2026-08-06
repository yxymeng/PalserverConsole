import gzip
import os
import stat
from pathlib import Path

import pytest

from palserver_console.world.adapter import verify_stable_parse


def _sanitized_fixture_path() -> Path:
    configured_path = os.environ.get("PALSERVER_M0_SANITIZED_FIXTURE")
    if configured_path:
        return Path(configured_path)
    return Path(__file__).resolve().parents[2] / "fixtures" / "sanitized" / "level.m0.json.gz"


@pytest.mark.integration
def test_sanitized_fixture_is_read_only_and_stably_parseable() -> None:
    fixture_path = _sanitized_fixture_path()
    if not fixture_path.is_file():
        pytest.skip("No local sanitized M0 fixture is available.")

    assert fixture_path.stat().st_mode & stat.S_IWRITE == 0
    with gzip.open(fixture_path, "rt", encoding="utf-8") as fixture_file:
        opening = fixture_file.read(128)
    assert opening.startswith("{")
    assert '"header"' in opening

    source_path = os.environ.get("PALSERVER_M0_SOURCE")
    ooz_dll_path = os.environ.get("PALSERVER_M0_OOZ")
    if not source_path or not ooz_dll_path:
        pytest.skip(
            "Source and local libooz.dll paths are required for the live integration check."
        )
    analysis = verify_stable_parse(Path(source_path), ooz_dll_path=Path(ooz_dll_path))

    assert analysis.parse_runs == 2
    assert analysis.source_size_bytes > 0
    assert all(duration >= 0 for duration in analysis.parse_durations_ms)
