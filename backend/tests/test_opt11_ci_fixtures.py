from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path
from typing import Any, cast

from palserver_console.world.adapter import build_field_coverage

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "windows-ci.yml"
GOLDEN_FIXTURE = ROOT / "fixtures" / "golden" / "world-structure-v1.json"
DEV_LOCK = ROOT / "requirements-dev.lock"


def _load_golden_fixture() -> dict[str, Any]:
    return cast(
        dict[str, Any],
        json.loads(GOLDEN_FIXTURE.read_text(encoding="utf-8")),
    )


def test_windows_ci_uses_single_python_313_build_and_node_lts() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    assert "runs-on: windows-latest" in workflow
    assert "actions/setup-python@v6" in workflow
    assert 'python-version: "3.13"' in workflow
    assert workflow.count("architecture: x64") == 2
    assert '"3.11"' not in workflow
    assert '"3.12"' not in workflow
    backend_job = workflow.split("  backend:", maxsplit=1)[1].split(
        "\n  frontend:", maxsplit=1
    )[0]
    assert "matrix:" not in backend_job
    assert "actions/setup-node@v6" in workflow
    assert re.search(r"node-version:\s*[\"']24[\"']", workflow)


def test_project_and_static_analysis_require_python_313() -> None:
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert project["project"]["requires-python"] == ">=3.13,<3.14"
    assert project["tool"]["ruff"]["target-version"] == "py313"
    assert project["tool"]["mypy"]["python_version"] == "3.13"


def test_source_launcher_requires_64_bit_cpython_313() -> None:
    launcher = (ROOT / "scripts" / "start-console.ps1").read_text(encoding="utf-8")

    assert "64-bit CPython 3.13" in launcher
    assert 'sys.version_info[:2] == (3,13)' in launcher
    assert "platform.python_implementation() == 'CPython'" in launcher
    assert "struct.calcsize('P') == 8" in launcher


def test_published_build_docs_use_single_python_313_baseline() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    gitignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    lock_header = (ROOT / "requirements.lock").read_text(encoding="utf-8").splitlines()[0]

    assert "64 位 CPython 3.13" in readme
    assert "最终用户无需安装 Python/Node.js" in readme
    assert "/plan.md" in gitignore
    assert "/CODEX_OPTIMIZATION_ROADMAP.md" in gitignore
    assert lock_header == (
        "# Runtime dependencies resolved for 64-bit Windows CPython 3.13. "
        "Regenerate intentionally when pyproject.toml changes."
    )


def test_windows_ci_runs_required_checks_and_reports_private_fixture_state() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")

    required_commands = (
        "ruff check backend",
        "mypy",
        "pytest backend/tests",
        "npm.cmd ci",
        "npm.cmd run lint",
        "npm.cmd run typecheck",
        "npm.cmd run test",
        "npm.cmd run build",
        "npm.cmd run test:e2e",
    )
    assert all(command in workflow for command in required_commands)
    assert "workflow_dispatch:" in workflow
    assert "run_private_fixture" in workflow
    assert "PALSERVER_M5_LEVEL_SAV" in workflow
    assert "PALSERVER_OOZ_DLL" in workflow
    assert "not configured" in workflow
    assert "required-checks" in workflow


def test_windows_ci_uses_a_hashed_lock_for_test_tools_and_transitive_dependencies() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    lock_lines = [
        line.strip()
        for line in DEV_LOCK.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    locked_names = {line.split("==", maxsplit=1)[0].casefold() for line in lock_lines}

    assert {
        "mypy",
        "pytest",
        "ruff",
        "types-psutil",
        "mypy_extensions",
        "iniconfig",
        "packaging",
        "pluggy",
    } <= locked_names
    assert all("==" in line and "--hash=sha256:" in line for line in lock_lines)
    assert workflow.count("--require-hashes -r requirements-dev.lock") == 2
    assert "pip install --disable-pip-version-check mypy==" not in workflow
    assert "pip install --disable-pip-version-check pytest==" not in workflow


def test_committed_golden_fixture_matches_parser_coverage_contract() -> None:
    fixture = _load_golden_fixture()
    properties = fixture["properties"]
    expected = fixture["expectedCoverage"]

    actual = {
        item.key: {
            "status": item.status,
            "sourceKeyCounts": item.source_key_counts,
        }
        for item in build_field_coverage(properties)
    }

    assert fixture["fixtureVersion"] == 1
    assert fixture["privacy"] == "synthetic-no-player-data"
    assert actual == expected


def test_committed_golden_fixture_contains_no_sensitive_identifiers() -> None:
    serialized = GOLDEN_FIXTURE.read_text(encoding="utf-8")

    assert "AdminPassword" not in serialized
    assert not re.search(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", serialized)
    assert not re.search(r"\b[0-9A-Fa-f]{32}\b", serialized)
    assert not re.search(
        r"\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-"
        r"[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b",
        serialized,
    )
