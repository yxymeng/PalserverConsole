from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

import pytest

from palserver_console.metadata import WorldMetadataError, load_world_metadata
from tools.generate_world_metadata import _fmodel_rows, _game_text, _partner_skill


def test_pinned_world_metadata_loads_with_declared_collections() -> None:
    bundle = load_world_metadata()

    assert bundle.status == {
        "status": "ready",
        "schema": "palserver-console-world-metadata",
        "schemaVersion": 1,
        "dataVersion": "2026.08.24.1",
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
    assert sheep.partner_skill is not None
    assert sheep.partner_skill["name"] == "茸茸盾牌"
    legend = bundle.skill("Legend")
    assert legend is not None
    assert legend["kind"] == "passive"
    assert legend["name"] == "传说"
    assert legend["rank"] == 4
    assert bundle.skill("aircanon") == {
        "kind": "active",
        "name": "空气弹",
        "description": "以急速射出空气团块。",
        "sourceName": "Air Cannon",
        "rank": None,
        "element": "Normal",
        "power": 40,
        "cooldown": 2.0,
    }
    assert len(bundle.skills) == 2_280
    assert bundle.items == {}


def test_fmodel_skill_tables_parse_localized_text_and_match_direct_keys(tmp_path: Path) -> None:
    table = tmp_path / "DT_SkillNameText_Common.json"
    table.write_text(
        json.dumps(
            [
                {
                    "Rows": {
                        "ACTION_SKILL_AirCanon": {
                            "TextData": {
                                "SourceString": "Air Cannon",
                                "LocalizedString": "空气弹",
                            }
                        },
                        "PARTNERSKILL_Anubis": {
                            "TextData": {
                                "SourceString": "Guardian of the Desert",
                                "LocalizedString": "沙漠守护神",
                            }
                        },
                        "PASSIVE_Invalid": {
                            "TextData": {
                                "SourceString": "zh-Hans Text",
                                "LocalizedString": "zh-Hans Text",
                            }
                        },
                        "PASSIVE_SourceFallback": {
                            "TextData": {
                                "SourceString": "来源回退",
                                "LocalizedString": "",
                            }
                        },
                    }
                }
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    rows = _fmodel_rows(table)

    assert _game_text(rows, "ACTION_SKILL_", "AirCanon") == "空气弹"
    assert _game_text(rows, "PASSIVE_", "Invalid") is None
    assert _game_text(rows, "PASSIVE_", "SourceFallback") == "来源回退"
    assert _game_text(rows, "ACTION_SKILL_", "Missing") is None
    assert _partner_skill(
        {
            "asset": "Anubis",
            "partner_skill": "Guardian of the Desert",
            "description": "English fallback description.",
        },
        rows,
        {},
    ) == {
        "id": "Guardian of the Desert",
        "name": "沙漠守护神",
        "sourceName": "Guardian of the Desert",
        "description": "English fallback description.",
    }
    assert _partner_skill(
        {
            "asset": "Missing",
            "partner_skill": "Unknown Partner Skill",
            "description": "Existing fallback.",
        },
        rows,
        {},
    ) == {
        "id": "Unknown Partner Skill",
        "name": None,
        "sourceName": "Unknown Partner Skill",
        "description": "Existing fallback.",
    }


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
