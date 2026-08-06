"""Read-only Palworld save parsing boundary."""

from .adapter import (
    FieldCoverage,
    ParseAnalysis,
    SanitizedFixture,
    build_field_coverage,
    create_sanitized_fixture,
    read_save_properties,
    verify_stable_parse,
    write_coverage_reports,
)

__all__ = [
    "FieldCoverage",
    "ParseAnalysis",
    "SanitizedFixture",
    "build_field_coverage",
    "create_sanitized_fixture",
    "read_save_properties",
    "verify_stable_parse",
    "write_coverage_reports",
]
