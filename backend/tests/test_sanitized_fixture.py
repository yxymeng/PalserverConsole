import gzip
import os
import stat
from pathlib import Path

import pytest

from palserver_console.world.adapter import verify_stable_parse


@pytest.mark.integration
@pytest.mark.private_fixture
def test_private_m0_fixture_is_read_only_and_stably_parseable() -> None:
    fixture_path_value = os.environ.get("PALSERVER_M0_SANITIZED_FIXTURE")
    source_path = os.environ.get("PALSERVER_M0_SOURCE")
    ooz_dll_path = os.environ.get("PALSERVER_M0_OOZ")
    if not fixture_path_value or not source_path or not ooz_dll_path:
        pytest.skip(
            "Private M0 fixture not configured: PALSERVER_M0_SANITIZED_FIXTURE, "
            "PALSERVER_M0_SOURCE and PALSERVER_M0_OOZ are required."
        )

    fixture_path = Path(fixture_path_value)
    assert fixture_path.is_file()

    assert fixture_path.stat().st_mode & stat.S_IWRITE == 0
    with gzip.open(fixture_path, "rt", encoding="utf-8") as fixture_file:
        opening = fixture_file.read(128)
    assert opening.startswith("{")
    assert '"header"' in opening

    analysis = verify_stable_parse(Path(source_path), ooz_dll_path=Path(ooz_dll_path))

    assert analysis.parse_runs == 2
    assert analysis.source_size_bytes > 0
    assert all(duration >= 0 for duration in analysis.parse_durations_ms)
