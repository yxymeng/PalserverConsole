"""Generate the pinned shared offline metadata bundle used by world-data views."""

from __future__ import annotations

import hashlib
import json
import urllib.request
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
PALWORLD_SERVER_TOOL_REPOSITORY = "https://github.com/zaigie/palworld-server-tool"
PALWORLD_SERVER_TOOL_REVISION = "f45a48ef25ce08a5311a27e55b17062ba0bb4362"
PALWORLD_SERVER_TOOL_SKILLS = (
    "web/src/assets/skill.json",
    "88f80d0349de940cebed4225da327c8d3ad5e7aa43e502dbd025d64c9489f1c9",
)
DATA_VERSION = "2026.08.23.1"
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
            "partnerSkill": _partner_skill(raw),
        }
    skills: dict[str, object] = {}
    for raw in skill_payload["passives"]:
        asset = str(raw["asset"])
        localized = chinese_passives.get(asset)
        skills[asset] = {
            "kind": "passive",
            "name": _localized_text(localized, "name"),
            "description": _localized_text(localized, "desc"),
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
            "name": None,
            "description": None,
            "sourceName": str(raw["name"]),
            "rank": None,
            "element": _text_or_none(raw.get("element")),
            "power": _number_or_none(raw.get("display_power")),
            "cooldown": _number_or_none(raw.get("cooldown")),
        }
    collections = {
        "pals": dict(sorted(pals.items())),
        "skills": dict(sorted(skills.items())),
        "items": {},
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
        },
        "generatedBy": "backend/tools/generate_world_metadata.py",
        "collections": collections,
        "integrity": {
            "algorithm": "sha256",
            "collectionsSha256": hashlib.sha256(canonical).hexdigest(),
            "counts": {name: len(values) for name, values in collections.items()},
        },
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Generated {len(pals)} Pal rows and {len(skills)} skill rows at {OUTPUT}.")


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


def _partner_skill(raw: dict[str, Any]) -> dict[str, str] | None:
    identifier = _text_or_none(raw.get("partner_skill"))
    if not identifier:
        return None
    return {
        "id": identifier,
        "sourceName": identifier,
        "description": _text_or_none(raw.get("description")) or "",
    }


def _localized_text(value: object, key: str) -> str | None:
    return _text_or_none(value.get(key)) if isinstance(value, dict) else None


def _text_or_none(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _number_or_none(value: object) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


if __name__ == "__main__":
    main()
