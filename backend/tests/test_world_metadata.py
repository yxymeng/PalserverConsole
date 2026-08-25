from __future__ import annotations

import json
from importlib.resources import files
from pathlib import Path

import pytest

from palserver_console.metadata import WorldMetadataError, load_world_metadata
from tools.generate_world_metadata import (
    _build_items,
    _fmodel_rows,
    _game_text,
    _partner_skill,
)


def test_pinned_world_metadata_loads_with_declared_collections() -> None:
    bundle = load_world_metadata()

    assert bundle.status == {
        "status": "ready",
        "schema": "palserver-console-world-metadata",
        "schemaVersion": 1,
        "dataVersion": "2026.08.25.3",
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
    accessory = bundle.item("Accessory_AT_1")
    assert accessory is not None
    assert accessory.name == "攻击吊坠"
    assert accessory.category == "Accessory / Accessory"
    assert accessory.rarity == "2"
    assert bundle.item("unknown-item") is None
    unnamed = bundle.item("AnimalSkin")
    assert unnamed is not None
    assert unnamed.name is None
    assert unnamed.category
    assert unnamed.rarity == "0"
    assert len(bundle.items) == 2_466


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


def test_item_metadata_merges_common_and_matches_official_fields() -> None:
    base = {
        "BaseOnly": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialOre",
            "Rarity": 0,
        },
        "Overridden": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialWood",
            "Rarity": 0,
        },
        "DirectKey": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Consume",
            "TypeB": "EPalItemTypeB::ConsumeOther",
            "Rarity": 2,
        },
        "Placeholder": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialStone",
            "Rarity": 1,
        },
        "Missing": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialStone",
            "Rarity": 1,
        },
    }
    common = {
        "Overridden": {
            "OverrideName": "CUSTOM_OVERRIDDEN_NAME",
            "TypeA": "EPalItemTypeA::Weapon",
            "TypeB": "EPalItemTypeB::WeaponMelee",
            "Rarity": 4,
        }
    }
    names = {
        "ITEM_NAME_BaseOnly": {
            "TextData": {"LocalizedString": "基础物品", "SourceString": "Base item"}
        },
        "CUSTOM_OVERRIDDEN_NAME": {
            "TextData": {"LocalizedString": "覆盖名称", "SourceString": "Override"}
        },
        "ITEM_NAME_Overridden": {
            "TextData": {"LocalizedString": "低优先级名称", "SourceString": "Lower priority"}
        },
        "directkey": {
            "TextData": {"LocalizedString": "直接键名称", "SourceString": "Direct key"}
        },
        "ITEM_NAME_Placeholder": {
            "TextData": {"LocalizedString": "zh_Hans_Text", "SourceString": "-"}
        },
    }

    items, stats = _build_items(base, common, names, {})

    assert items == {
        "BaseOnly": {
            "name": "基础物品",
            "category": "Material / MaterialOre",
            "rarity": "0",
        },
        "Overridden": {
            "name": "覆盖名称",
            "category": "Weapon / WeaponMelee",
            "rarity": "4",
        },
        "DirectKey": {
            "name": "直接键名称",
            "category": "Consume / ConsumeOther",
            "rarity": "2",
        },
        "Placeholder": {
            "category": "Material / MaterialStone",
            "rarity": "1",
        },
        "Missing": {
            "category": "Material / MaterialStone",
            "rarity": "1",
        },
    }
    assert stats == {
        "dataTableRows": 5,
        "nameMatched": 3,
        "nameUnmatched": 2,
        "placeholder": 1,
        "missingLocalizationKey": 1,
        "invalidLocalizationRow": 0,
        "typeAValid": 5,
        "typeBValid": 5,
        "rarityValid": 5,
        "runtimeMarkupItems": 0,
        "characterNameTemplates": 0,
        "runtimeMarkupResolved": 0,
        "runtimeMarkupUnresolved": 0,
        "unknownMarkup": 0,
    }


def test_item_character_name_markup_reuses_existing_character_metadata() -> None:
    rows = {
        "BossDefeatReward_FlowerPrince": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialMonster",
            "Rarity": 1,
        },
        "BossDefeatReward_Mothman": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialMonster",
            "Rarity": 1,
        },
        "UnknownCharacter": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialMonster",
            "Rarity": 1,
        },
        "UnknownMarkup": {
            "OverrideName": "None",
            "TypeA": "EPalItemTypeA::Material",
            "TypeB": "EPalItemTypeB::MaterialMonster",
            "Rarity": 1,
        },
    }
    names = {
        "ITEM_NAME_BossDefeatReward_FlowerPrince": {
            "TextData": {"LocalizedString": "<characterName id=|FlowerPrince|/>的花瓣"}
        },
        "ITEM_NAME_BossDefeatReward_Mothman": {
            "TextData": {"LocalizedString": "<characterName id=|Mothman|>的羽毛"}
        },
        "ITEM_NAME_UnknownCharacter": {
            "TextData": {"LocalizedString": "<characterName id=|MissingPal|/>的鳞片"}
        },
        "ITEM_NAME_UnknownMarkup": {
            "TextData": {"LocalizedString": "<unknown value=|FlowerPrince|/>的碎片"}
        },
    }

    items, stats = _build_items(
        rows,
        {},
        names,
        {"flowerprince": "夜蔓爵", "mothman": "暮尘蛾"},
    )

    assert items["BossDefeatReward_FlowerPrince"]["name"] == "夜蔓爵的花瓣"
    assert items["BossDefeatReward_Mothman"]["name"] == "暮尘蛾的羽毛"
    assert "name" not in items["UnknownCharacter"]
    assert "name" not in items["UnknownMarkup"]
    assert all("<" not in str(item.get("name", "")) for item in items.values())
    assert stats["runtimeMarkupItems"] == 4
    assert stats["characterNameTemplates"] == 3
    assert stats["runtimeMarkupResolved"] == 2
    assert stats["runtimeMarkupUnresolved"] == 1
    assert stats["unknownMarkup"] == 1


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
