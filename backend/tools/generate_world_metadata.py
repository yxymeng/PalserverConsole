"""Generate the pinned shared offline metadata bundle used by Ticket 05."""

from __future__ import annotations

import hashlib
import json
import urllib.request
from pathlib import Path
from typing import Any

SOURCE_REPOSITORY = "https://github.com/deafdudecomputers/PalworldSaveTools"
SOURCE_REVISION = "18b9554168ecf684c5f1e1e4d8e583083b942eb9"
SOURCE_PATH = "resources/game_data/characters.json"
SOURCE_SHA256 = "83373a0e6dab7f3feac88a08928356b955e07804e0da94b2d452e641ab2609f2"
SOURCE_URL = f"https://raw.githubusercontent.com/deafdudecomputers/PalworldSaveTools/{SOURCE_REVISION}/{SOURCE_PATH}"
DATA_VERSION = "2026.08.22.1"
OUTPUT = (
    Path(__file__).resolve().parents[1]
    / "palserver_console/metadata/data/world-metadata-v1.json"
)


def main() -> None:
    source = urllib.request.urlopen(SOURCE_URL, timeout=30).read()  # noqa: S310
    source_digest = hashlib.sha256(source).hexdigest()
    if source_digest != SOURCE_SHA256:
        raise ValueError(f"Unexpected characters.json SHA-256: {source_digest}")
    payload: dict[str, Any] = json.loads(source)
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
        }
    collections = {"pals": dict(sorted(pals.items())), "skills": {}, "items": {}}
    canonical = json.dumps(
        collections, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    bundle = {
        "schema": "palserver-console-world-metadata",
        "schemaVersion": 1,
        "dataVersion": DATA_VERSION,
        "source": {
            "repository": SOURCE_REPOSITORY,
            "revision": SOURCE_REVISION,
            "path": SOURCE_PATH,
            "sha256": SOURCE_SHA256,
            "license": "MIT",
            "licenseFile": "frontend/public/assets/pals/LICENSE-PalworldSaveTools.txt",
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
    print(f"Generated {len(pals)} Pal metadata rows at {OUTPUT}.")


if __name__ == "__main__":
    main()
