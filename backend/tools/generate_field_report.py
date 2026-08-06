"""Generate a value-free M0 coverage report from a read-only Level.sav."""

from __future__ import annotations

import argparse
from pathlib import Path

from palserver_console.world.adapter import verify_stable_parse, write_coverage_reports


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Validate a Level.sav twice and write value-free M0 coverage reports."
    )
    parser.add_argument("--source", required=True, type=Path, help="Read-only source Level.sav")
    parser.add_argument(
        "--ooz-dll",
        type=Path,
        help="Optional local libooz.dll for PlM decoding; never copied into this project.",
    )
    args = parser.parse_args()

    root = _repository_root()
    analysis = verify_stable_parse(args.source, ooz_dll_path=args.ooz_dll)
    write_coverage_reports(
        analysis,
        root / "docs" / "reports" / "M0-field-coverage.md",
        root / "docs" / "reports" / "M0-field-coverage.json",
    )
    print("M0 field coverage reports written without save values or source paths.")
    print(f"Parser version: {analysis.parser_version}")
    print(f"Compression magic: {analysis.compression_magic}")
    print(f"Parse runs: {analysis.parse_runs}")
    found_count = sum(item.found for item in analysis.coverage)
    print(f"Source structures found: {found_count}/{len(analysis.coverage)}")


def _repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


if __name__ == "__main__":
    main()
