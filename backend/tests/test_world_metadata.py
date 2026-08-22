from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

import pytest

from palserver_console.metadata import WorldMetadataError, load_world_metadata


def test_pinned_world_metadata_loads_with_declared_collections() -> None:
    bundle = load_world_metadata()

    assert bundle.status == {
        "status": "ready",
        "schema": "palserver-console-world-metadata",
        "schemaVersion": 1,
        "dataVersion": "2026.08.22.1",
        "sourceRevision": "18b9554168ecf684c5f1e1e4d8e583083b942eb9",
        "errorCode": None,
    }
    sheep = bundle.pal("SheepBall")
    assert sheep is not None
    assert sheep.rarity == 1
    assert sheep.work_suitabilities == {
        "Handcraft": 1,
        "MonsterFarm": 1,
        "Transport": 1,
    }
    assert bundle.skills == {}
    assert bundle.items == {}


def test_world_metadata_integrity_failure_is_rejected(tmp_path: Path) -> None:
    source = files("palserver_console.metadata").joinpath(
        "data/world-metadata-v1.json"
    )
    payload = json.loads(source.read_text(encoding="utf-8"))
    payload["collections"]["pals"]["SheepBall"]["rarity"] = 99
    corrupted = tmp_path / "world-metadata-corrupted.json"
    corrupted.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(WorldMetadataError) as error:
        load_world_metadata(corrupted)

    assert error.value.code == "WORLD_METADATA_INTEGRITY_FAILED"


def test_world_metadata_missing_file_has_copyable_error_code(tmp_path: Path) -> None:
    with pytest.raises(WorldMetadataError) as error:
        load_world_metadata(tmp_path / "missing.json")

    assert error.value.code == "WORLD_METADATA_UNAVAILABLE"
