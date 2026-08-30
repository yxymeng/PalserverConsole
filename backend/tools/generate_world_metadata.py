"""Generate the pinned shared offline metadata bundle used by world-data views."""

from __future__ import annotations

import hashlib
import json
import re
import urllib.request
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

PALWORLD_SAVE_TOOLS_REPOSITORY = "https://github.com/deafdudecomputers/PalworldSaveTools"
PALWORLD_SAVE_TOOLS_REVISION = "18b9554168ecf684c5f1e1e4d8e583083b942eb9"
PALWORLD_SAVE_TOOLS_FILES = {
    "characters": (
        "resources/game_data/characters.json",
        "83373a0e6dab7f3feac88a08928356b955e07804e0da94b2d452e641ab2609f2",
    ),
    "skills": (
        "resources/game_data/skills.json",
        "b9172f389bf56a307194d25b70aca23f8610ef81de32bb44bda827f65b83add1",
    ),
}
PALWORLD_SAVE_TOOLS_PROGRESS_REVISION = "79da8fb0ef289027217ea2cd66c4e1364a319898"
PALWORLD_SAVE_TOOLS_PROGRESS_FILES = {
    "fastTravel": (
        "resources/game_data/fast_travel_points.json",
        "4361025dd056ba595b59a8bf76bf714437154e270f69f45e2c8c67bea2f42981",
    ),
    "exploredAreas": (
        "resources/game_data/world_map_areas.json",
        "a6fbb258cc33890c3098b069d340a775bebb23f123b8ad79713fd68b086bcce4",
    ),
}
PALWORLD_MODDING_KIT_REPOSITORY = "https://github.com/localcc/PalworldModdingKit"
PALWORLD_MODDING_KIT_REVISION = "e6632458b97af0083eb81715775651b08104ef6a"
PALWORLD_BOSS_TYPE_FILE = (
    "Source/Pal/Public/EPalBossType.h",
    "0b9fd73e8eb876357b1e3664ac94ba0af975e866ffafe175445104f937264cae",
)
PALWORLD_OILRIG_TYPE_FILE = (
    "Source/Pal/Public/EPalOilrigType.h",
    "df4c8f4c0a37ec41ecb2204bbb39c75c72b0c80522d5b78e7185694e5c1edadb",
)
PALWORLD_SERVER_TOOL_REPOSITORY = "https://github.com/zaigie/palworld-server-tool"
PALWORLD_SERVER_TOOL_REVISION = "f45a48ef25ce08a5311a27e55b17062ba0bb4362"
PALWORLD_SERVER_TOOL_SKILLS = (
    "web/src/assets/skill.json",
    "88f80d0349de940cebed4225da327c8d3ad5e7aa43e502dbd025d64c9489f1c9",
)
PALWORLD_ZH_HANS_DIRECTORY = (
    Path(__file__).resolve().parents[2]
    / ".scratch/world-asset-console/palworld-l10n/zh-Hans"
)
PALWORLD_ZH_HANS_FILES = {
    "skillNames": (
        "DT_SkillNameText_Common.json",
        "7f7000a2101db1cc18b42da5bf35b46331867f695e3ba249222c81908eb84d1d",
    ),
    "skillDescriptions": (
        "DT_SkillDescText_Common.json",
        "1e76362386b77d2cbcc68d74eafba47ad39f691ea368a7cfb68c9f00d7565564",
    ),
}
PALWORLD_ITEM_DIRECTORY = (
    Path(__file__).resolve().parents[2]
    / ".scratch/world-asset-console/palworld-item-data"
)
PALWORLD_ITEM_FILES = {
    "itemData": (
        "DT_ItemDataTable.json",
        "8825b7dd80597177a832b52842ba32b4d2600b815b917769aca031a59cbc59e0",
    ),
    "itemDataCommon": (
        "DT_ItemDataTable_Common.json",
        "3e405ff0585280fcf684caaea3493df17b1f82f1433b20c6c42a9c048ade0ed0",
    ),
    "itemNamesZhHans": (
        "zh-Hans/DT_ItemNameText_Common.json",
        "b37500780c6f9183753cd1a48de63f61814d38676c55561211b02938c57f1ea7",
    ),
}
PALWORLD_ITEM_REVISION = "630da112426c0600edb3204b76e13528d336455f"
INVALID_LOCALIZED_TEXT = frozenset(
    value.casefold() for value in ("-", "None", "zh-Hans Text", "zh_Hans_Text")
)
PAL_CATALOG_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend/src/features/world/palCatalogData.json"
)
RUNTIME_MARKUP_RE = re.compile(r"<[^>]+>")
CHARACTER_NAME_MARKUP_RE = re.compile(
    r"<characterName id=\|([^|<>]+)\|/?>"
)
DATA_VERSION = "2026.08.25.3"
PROGRESS_TOTALS_DATA_VERSION = "2026.08.30.2"
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "palserver_console/metadata/data/world-metadata-v1.json"
)


def main() -> None:
    payload = _pinned_json(
        PALWORLD_SAVE_TOOLS_REPOSITORY,
        PALWORLD_SAVE_TOOLS_REVISION,
        *PALWORLD_SAVE_TOOLS_FILES["characters"],
    )
    skill_payload = _pinned_json(
        PALWORLD_SAVE_TOOLS_REPOSITORY,
        PALWORLD_SAVE_TOOLS_REVISION,
        *PALWORLD_SAVE_TOOLS_FILES["skills"],
    )
    localized_skills = _pinned_json(
        PALWORLD_SERVER_TOOL_REPOSITORY,
        PALWORLD_SERVER_TOOL_REVISION,
        *PALWORLD_SERVER_TOOL_SKILLS,
    )
    chinese_passives = localized_skills.get("zh", {})
    if not isinstance(chinese_passives, dict):
        raise ValueError("Unexpected Chinese skill localization payload.")
    skill_names = _fmodel_rows(
        PALWORLD_ZH_HANS_DIRECTORY / PALWORLD_ZH_HANS_FILES["skillNames"][0],
        PALWORLD_ZH_HANS_FILES["skillNames"][1],
    )
    skill_descriptions = _fmodel_rows(
        PALWORLD_ZH_HANS_DIRECTORY / PALWORLD_ZH_HANS_FILES["skillDescriptions"][0],
        PALWORLD_ZH_HANS_FILES["skillDescriptions"][1],
    )
    item_rows_base = _fmodel_rows(
        PALWORLD_ITEM_DIRECTORY / PALWORLD_ITEM_FILES["itemData"][0],
        PALWORLD_ITEM_FILES["itemData"][1],
    )
    item_rows_common = _fmodel_rows(
        PALWORLD_ITEM_DIRECTORY / PALWORLD_ITEM_FILES["itemDataCommon"][0],
        PALWORLD_ITEM_FILES["itemDataCommon"][1],
    )
    item_names = _fmodel_rows(
        PALWORLD_ITEM_DIRECTORY / PALWORLD_ITEM_FILES["itemNamesZhHans"][0],
        PALWORLD_ITEM_FILES["itemNamesZhHans"][1],
    )
    fast_travel = _pinned_json(
        PALWORLD_SAVE_TOOLS_REPOSITORY,
        PALWORLD_SAVE_TOOLS_PROGRESS_REVISION,
        *PALWORLD_SAVE_TOOLS_PROGRESS_FILES["fastTravel"],
    )
    map_areas = _pinned_json(
        PALWORLD_SAVE_TOOLS_REPOSITORY,
        PALWORLD_SAVE_TOOLS_PROGRESS_REVISION,
        *PALWORLD_SAVE_TOOLS_PROGRESS_FILES["exploredAreas"],
    )
    boss_types = _pinned_text(
        PALWORLD_MODDING_KIT_REPOSITORY,
        PALWORLD_MODDING_KIT_REVISION,
        *PALWORLD_BOSS_TYPE_FILE,
    )
    oilrig_types = _pinned_text(
        PALWORLD_MODDING_KIT_REPOSITORY,
        PALWORLD_MODDING_KIT_REVISION,
        *PALWORLD_OILRIG_TYPE_FILE,
    )
    area_rows = map_areas.get("areas")
    if not isinstance(area_rows, list) or not all(
        isinstance(value, str) for value in area_rows
    ):
        raise ValueError("Unexpected world_map_areas.json areas payload.")
    progress_totals = {
        "fastTravel": len(fast_travel),
        "exploredAreas": len(area_rows),
        "towerBosses": _tower_boss_total(boss_types),
        "oilRigLocations": _oil_rig_total(oilrig_types),
    }
    pals: dict[str, object] = {}
    for raw in payload["pals"]:
        work = {
            str(name): int(level)
            for name, level in raw.get("work_suitabilities", {}).items()
            if int(level) > 0
        }
        pals[str(raw["asset"])] = {
            "rarity": int(raw["stats"]["rarity"]),
            "workSuitabilities": dict(sorted(work.items())),
            "partnerSkill": _partner_skill(raw, skill_names, skill_descriptions),
        }
    skills: dict[str, object] = {}
    for raw in skill_payload["passives"]:
        asset = str(raw["asset"])
        localized = chinese_passives.get(asset)
        skills[asset] = {
            "kind": "passive",
            "name": _game_text(skill_names, "PASSIVE_", asset)
            or _localized_text(localized, "name"),
            "description": _game_text(skill_descriptions, "PASSIVE_", asset)
            or _localized_text(localized, "desc"),
            "sourceName": str(raw["name"]),
            "rank": int(raw["rank"]),
            "element": None,
            "power": None,
            "cooldown": None,
        }
    for raw in skill_payload["skills"]:
        asset = str(raw["asset"])
        skills[asset] = {
            "kind": "active",
            "name": _game_text(skill_names, "ACTION_SKILL_", asset),
            "description": _game_text(skill_descriptions, "ACTION_SKILL_", asset),
            "sourceName": str(raw["name"]),
            "rank": None,
            "element": _text_or_none(raw.get("element")),
            "power": _number_or_none(raw.get("display_power")),
            "cooldown": _number_or_none(raw.get("cooldown")),
        }
    character_names = _character_names(PAL_CATALOG_PATH)
    items, item_stats = _build_items(
        item_rows_base, item_rows_common, item_names, character_names
    )
    collections = {
        "pals": dict(sorted(pals.items())),
        "skills": dict(sorted(skills.items())),
        "items": dict(sorted(items.items())),
    }
    canonical = json.dumps(
        collections, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    bundle = {
        "schema": "palserver-console-world-metadata",
        "schemaVersion": 1,
        "dataVersion": DATA_VERSION,
        "source": {
            "repository": PALWORLD_SAVE_TOOLS_REPOSITORY,
            "revision": PALWORLD_SAVE_TOOLS_REVISION,
            "path": PALWORLD_SAVE_TOOLS_FILES["characters"][0],
            "sha256": PALWORLD_SAVE_TOOLS_FILES["characters"][1],
            "license": "MIT",
            "licenseFile": "frontend/public/assets/pals/LICENSE-PalworldSaveTools.txt",
        },
        "sources": {
            "palworldSaveTools": {
                "repository": PALWORLD_SAVE_TOOLS_REPOSITORY,
                "revision": PALWORLD_SAVE_TOOLS_REVISION,
                "license": "MIT",
                "files": {
                    name: {"path": path, "sha256": digest}
                    for name, (path, digest) in PALWORLD_SAVE_TOOLS_FILES.items()
                },
            },
            "palworldServerTool": {
                "repository": PALWORLD_SERVER_TOOL_REPOSITORY,
                "revision": PALWORLD_SERVER_TOOL_REVISION,
                "license": "Apache-2.0",
                "files": {
                    "skills": {
                        "path": PALWORLD_SERVER_TOOL_SKILLS[0],
                        "sha256": PALWORLD_SERVER_TOOL_SKILLS[1],
                    }
                },
            },
            "palworldZhHans": {
                "repository": "Palworld official zh-Hans game resources exported with FModel",
                "revision": "9c8c9eeb8b10bd144ed4ac3aa47b427df72661b7",
                "license": "Palworld game content",
                "files": {
                    name: {
                        "path": (
                            ".scratch/world-asset-console/palworld-l10n/zh-Hans/"
                            f"{path}"
                        ),
                        "sha256": digest,
                    }
                    for name, (path, digest) in PALWORLD_ZH_HANS_FILES.items()
                },
            },
            "palworldItems": {
                "repository": (
                    "Palworld official game resources exported with FModel Save Properties"
                ),
                "revision": PALWORLD_ITEM_REVISION,
                "license": "Palworld game content",
                "files": {
                    name: {
                        "path": (
                            ".scratch/world-asset-console/palworld-item-data/"
                            f"{path}"
                        ),
                        "sha256": digest,
                    }
                    for name, (path, digest) in PALWORLD_ITEM_FILES.items()
                },
            },
            "palworldProgress": {
                "repository": PALWORLD_SAVE_TOOLS_REPOSITORY,
                "revision": PALWORLD_SAVE_TOOLS_PROGRESS_REVISION,
                "license": "MIT",
                "files": {
                    name: {"path": path, "sha256": digest}
                    for name, (path, digest) in PALWORLD_SAVE_TOOLS_PROGRESS_FILES.items()
                },
            },
            "palworldModdingKit": {
                "repository": PALWORLD_MODDING_KIT_REPOSITORY,
                "revision": PALWORLD_MODDING_KIT_REVISION,
                "license": "MIT",
                "files": {
                    "towerBossTypes": {
                        "path": PALWORLD_BOSS_TYPE_FILE[0],
                        "sha256": PALWORLD_BOSS_TYPE_FILE[1],
                    },
                    "oilRigTypes": {
                        "path": PALWORLD_OILRIG_TYPE_FILE[0],
                        "sha256": PALWORLD_OILRIG_TYPE_FILE[1],
                    },
                },
            },
        },
        "generatedBy": "backend/tools/generate_world_metadata.py",
        "progressTotalsDataVersion": PROGRESS_TOTALS_DATA_VERSION,
        "progressTotals": progress_totals,
        "collections": collections,
        "integrity": {
            "algorithm": "sha256",
            "collectionsSha256": hashlib.sha256(canonical).hexdigest(),
            "progressTotalsSha256": hashlib.sha256(
                json.dumps(
                    progress_totals,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest(),
            "counts": {name: len(values) for name, values in collections.items()},
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Generated {len(pals)} Pal rows, {len(skills)} skill rows, and "
        f"{len(items)} item rows at {OUTPUT}."
    )
    print(
        "Items: "
        f"DataTable rows={item_stats['dataTableRows']}, "
        f"metadata items={len(items)}, "
        f"Chinese names matched={item_stats['nameMatched']}, "
        f"Chinese names unmatched={item_stats['nameUnmatched']}, "
        f"placeholders={item_stats['placeholder']}, "
        f"valid TypeA={item_stats['typeAValid']}, "
        f"valid TypeB={item_stats['typeBValid']}, "
        f"valid Rarity={item_stats['rarityValid']}."
    )
    print(
        "Item runtime markup: "
        f"items={item_stats['runtimeMarkupItems']}, "
        f"characterName templates={item_stats['characterNameTemplates']}, "
        f"resolved={item_stats['runtimeMarkupResolved']}, "
        f"unresolved={item_stats['runtimeMarkupUnresolved']}, "
        f"unknown markup={item_stats['unknownMarkup']}."
    )
    print(
        "Unmatched item names: "
        f"placeholder={item_stats['placeholder']}, "
        f"missing localization key={item_stats['missingLocalizationKey']}, "
        f"invalid localization row={item_stats['invalidLocalizationRow']}."
    )


def _pinned_json(repository: str, revision: str, path: str, expected_sha256: str) -> dict[str, Any]:
    url = f"{repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/{revision}/{path}"
    source = urllib.request.urlopen(url, timeout=30).read()  # noqa: S310
    actual_sha256 = hashlib.sha256(source).hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError(f"Unexpected {path} SHA-256: {actual_sha256}")
    payload = json.loads(source)
    if not isinstance(payload, dict):
        raise ValueError(f"Unexpected {path} payload.")
    return payload


def _pinned_text(
    repository: str, revision: str, path: str, expected_sha256: str
) -> str:
    url = (
        f"{repository.replace('https://github.com/', 'https://raw.githubusercontent.com/')}"
        f"/{revision}/{path}"
    )
    source: bytes = urllib.request.urlopen(url, timeout=30).read()  # noqa: S310
    actual_sha256 = hashlib.sha256(source).hexdigest()
    if actual_sha256 != expected_sha256:
        raise ValueError(f"Unexpected {path} SHA-256: {actual_sha256}")
    return source.decode("utf-8")


def _tower_boss_total(source: str) -> int:
    match = re.search(
        r"enum class EPalBossType\s*:\s*uint8\s*\{(?P<body>.*?)\};", source, re.S
    )
    if match is None:
        raise ValueError("Unexpected EPalBossType enum payload.")
    members = [
        value
        for value in re.findall(
            r"(?m)^\s*([A-Za-z][A-Za-z0-9_]*)\s*,?\s*$", match.group("body")
        )
        if value not in {"None", "Max"}
    ]
    if not members:
        raise ValueError("EPalBossType enum has no gameplay members.")
    return len(members)


def _oil_rig_total(source: str) -> int:
    match = re.search(
        r"enum class EPalOilrigType\s*:\s*uint8\s*\{(?P<body>.*?)\};", source, re.S
    )
    if match is None:
        raise ValueError("Unexpected EPalOilrigType enum payload.")
    members = [
        value
        for value in re.findall(
            r"(?m)^\s*([A-Za-z][A-Za-z0-9_]*)\s*,?\s*$", match.group("body")
        )
        if value != "Debug"
    ]
    if not members:
        raise ValueError("EPalOilrigType enum has no gameplay members.")
    return len(members)


def _fmodel_rows(path: Path, expected_sha256: str | None = None) -> dict[str, object]:
    source = path.read_bytes()
    if expected_sha256 is not None:
        actual_sha256 = hashlib.sha256(source).hexdigest()
        if actual_sha256 != expected_sha256:
            raise ValueError(f"Unexpected {path.name} SHA-256: {actual_sha256}")
    payload = json.loads(source)
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ValueError(f"Unexpected {path.name} FModel payload.")
    rows = payload[0].get("Rows")
    if not isinstance(rows, dict):
        raise ValueError(f"Unexpected {path.name} FModel Rows payload.")
    return rows


def _game_text(rows: dict[str, object], prefix: str, identifier: str) -> str | None:
    return _fmodel_text(rows, f"{prefix}{identifier}")


def _fmodel_text(rows: Mapping[str, object], key: str) -> str | None:
    row = rows.get(key)
    if not isinstance(row, dict):
        return None
    text_data = row.get("TextData")
    if not isinstance(text_data, dict):
        return None
    for key in ("LocalizedString", "SourceString"):
        value = _valid_localized_text(text_data.get(key))
        if value is not None:
            return value
    return None


def _build_items(
    base_rows: Mapping[str, object],
    common_rows: Mapping[str, object],
    name_rows: Mapping[str, object],
    character_names_casefold: dict[str, str],
) -> tuple[dict[str, dict[str, object]], dict[str, int]]:
    merged_rows = {**base_rows, **common_rows}
    name_keys_casefold = {key.casefold(): key for key in name_rows}
    items: dict[str, dict[str, object]] = {}
    stats = {
        "dataTableRows": len(merged_rows),
        "nameMatched": 0,
        "nameUnmatched": 0,
        "placeholder": 0,
        "missingLocalizationKey": 0,
        "invalidLocalizationRow": 0,
        "typeAValid": 0,
        "typeBValid": 0,
        "rarityValid": 0,
        "runtimeMarkupItems": 0,
        "characterNameTemplates": 0,
        "runtimeMarkupResolved": 0,
        "runtimeMarkupUnresolved": 0,
        "unknownMarkup": 0,
    }
    for item_id, raw in merged_rows.items():
        if not isinstance(item_id, str) or not item_id or not isinstance(raw, dict):
            continue
        type_a = _enum_member(raw.get("TypeA"), "EPalItemTypeA::")
        type_b = _enum_member(raw.get("TypeB"), "EPalItemTypeB::")
        rarity = raw.get("Rarity")
        if type_a:
            stats["typeAValid"] += 1
        if type_b:
            stats["typeBValid"] += 1
        if isinstance(rarity, int) and not isinstance(rarity, bool):
            stats["rarityValid"] += 1

        override = _valid_localized_text(raw.get("OverrideName"))
        candidates = dict.fromkeys(
            key for key in (override, f"ITEM_NAME_{item_id}", item_id) if key
        )
        name = _item_name(
            name_rows,
            name_keys_casefold,
            candidates,
            character_names_casefold,
            stats,
        )
        if name is None:
            stats["nameUnmatched"] += 1
            stats[_unmatched_name_reason(name_rows, name_keys_casefold, candidates)] += 1
        else:
            stats["nameMatched"] += 1
        if not type_a or not type_b or not isinstance(rarity, int) or isinstance(rarity, bool):
            continue
        item = {
            "category": f"{type_a} / {type_b}",
            "rarity": str(rarity),
        }
        if name is not None:
            item["name"] = name
        items[item_id] = item
    return items, stats


def _character_names(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Unexpected existing Pal catalog payload.")
    return {
        character_id.casefold(): name
        for character_id, raw in payload.items()
        if isinstance(character_id, str)
        and isinstance(raw, dict)
        and (name := _text_or_none(raw.get("name"))) is not None
    }


def _item_name(
    name_rows: Mapping[str, object],
    name_keys_casefold: dict[str, str],
    candidates: Iterable[str],
    character_names_casefold: dict[str, str],
    stats: dict[str, int],
) -> str | None:
    for key in candidates:
        text = _fmodel_text(name_rows, name_keys_casefold.get(key.casefold(), key))
        if text is None:
            continue
        markup = RUNTIME_MARKUP_RE.findall(text)
        if not markup:
            return text
        stats["runtimeMarkupItems"] += 1
        character_matches = [CHARACTER_NAME_MARKUP_RE.fullmatch(value) for value in markup]
        character_count = sum(match is not None for match in character_matches)
        stats["characterNameTemplates"] += character_count
        if character_count != len(markup):
            stats["unknownMarkup"] += 1
            return None
        resolved = text
        for raw_markup, match in zip(markup, character_matches, strict=True):
            assert match is not None
            character_name = character_names_casefold.get(match.group(1).casefold())
            if character_name is None:
                stats["runtimeMarkupUnresolved"] += 1
                return None
            resolved = resolved.replace(raw_markup, character_name)
        if RUNTIME_MARKUP_RE.search(resolved):
            stats["runtimeMarkupUnresolved"] += 1
            return None
        stats["runtimeMarkupResolved"] += 1
        return resolved
    return None


def _unmatched_name_reason(
    name_rows: Mapping[str, object],
    name_keys_casefold: dict[str, str],
    candidates: Iterable[str],
) -> str:
    found_row = False
    found_placeholder = False
    for key in candidates:
        row = name_rows.get(name_keys_casefold.get(key.casefold(), key))
        if not isinstance(row, dict):
            continue
        found_row = True
        text_data = row.get("TextData")
        if not isinstance(text_data, dict):
            continue
        for field in ("LocalizedString", "SourceString"):
            value = _text_or_none(text_data.get(field))
            if value is not None and value.casefold() in INVALID_LOCALIZED_TEXT:
                found_placeholder = True
    if found_placeholder:
        return "placeholder"
    return "invalidLocalizationRow" if found_row else "missingLocalizationKey"


def _enum_member(value: object, prefix: str) -> str | None:
    text = _text_or_none(value)
    return text.removeprefix(prefix) if text and text.startswith(prefix) else None


def _partner_skill(
    raw: dict[str, Any], skill_names: dict[str, object], skill_descriptions: dict[str, object]
) -> dict[str, object] | None:
    identifier = _text_or_none(raw.get("partner_skill"))
    if not identifier:
        return None
    asset = str(raw["asset"])
    return {
        "id": identifier,
        "name": _game_text(skill_names, "PARTNERSKILL_", asset),
        "sourceName": identifier,
        "description": _game_text(skill_descriptions, "PARTNERSKILL_", asset)
        or _text_or_none(raw.get("description"))
        or "",
    }


def _localized_text(value: object, key: str) -> str | None:
    return _text_or_none(value.get(key)) if isinstance(value, dict) else None


def _text_or_none(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _valid_localized_text(value: object) -> str | None:
    text = _text_or_none(value)
    return text if text is not None and text.casefold() not in INVALID_LOCALIZED_TEXT else None


def _number_or_none(value: object) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


if __name__ == "__main__":
    main()
