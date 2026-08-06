"""Create a local, Git-ignored M0 fixture from a real Level.sav."""

from __future__ import annotations

import argparse
from pathlib import Path

from palserver_console.world.adapter import create_sanitized_fixture


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Create a read-only, sanitized M0 Level.sav fixture without modifying the source."
        )
    )
    parser.add_argument("--source", required=True, type=Path, help="Read-only source Level.sav")
    parser.add_argument(
        "--ooz-dll",
        type=Path,
        help="Optional local libooz.dll for PlM decoding; never copied into this project.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=_repository_root() / "fixtures" / "sanitized" / "level.m0.json.gz",
        help="Must remain inside fixtures/sanitized",
    )
    args = parser.parse_args()

    result = create_sanitized_fixture(
        source_path=args.source,
        output_path=args.output,
        fixture_root=_repository_root() / "fixtures" / "sanitized",
        ooz_dll_path=args.ooz_dll,
    )
    print("Sanitized fixture created and verified.")
    print(f"Output format: {result.output_format}")
    print(f"Output bytes: {result.output_size_bytes}")
    print(f"Redacted strings: {result.redacted_strings}")
    print(f"Redacted UUIDs: {result.redacted_uuids}")
    print(f"Verification parse runs: {result.verification.parse_runs}")


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


if __name__ == "__main__":
    main()
