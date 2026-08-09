from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

import palserver_console.__main__ as console_main
from palserver_console.config import AppSettings, default_settings


def _write_database(path: Path, schema_version: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as connection:
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute(f"PRAGMA user_version = {schema_version}")
        connection.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        connection.execute("INSERT INTO settings(key, value) VALUES('portable.fixture', 'keep-me')")


def _schema_version(path: Path) -> int:
    with sqlite3.connect(path) as connection:
        return int(connection.execute("PRAGMA user_version").fetchone()[0])


def _write_build_metadata(path: Path, maximum_schema_version: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "formatVersion": 1,
                "application": "PalServerConsole",
                "version": "0.1.0-test",
                "architecture": "x64",
                "database": {
                    "minimumSchemaVersion": 0,
                    "maximumSchemaVersion": maximum_schema_version,
                },
                "signing": {"status": "unsigned"},
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _write_checksum_manifest(root: Path, paths: list[Path]) -> None:
    lines = []
    for path in sorted(paths):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        relative = path.relative_to(root).as_posix()
        lines.append(f"{digest} *{relative}")
    (root / "checksums.sha256").write_text("\n".join(lines) + "\n", encoding="ascii")


def _run_upgrade(
    script: Path, install_root: Path, package_root: Path
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(script),
            "-InstallRoot",
            str(install_root),
            "-NewPackage",
            str(package_root),
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )


def test_frozen_default_settings_keep_data_outside_the_program_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    program_dir = tmp_path / "PalServerConsole" / "Program"
    internal_dir = program_dir / "_internal"
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(program_dir / "PalServerConsole.exe"))
    monkeypatch.setattr(sys, "_MEIPASS", str(internal_dir), raising=False)
    monkeypatch.delenv("PALSERVER_CONSOLE_DATA", raising=False)
    monkeypatch.delenv("PALSERVER_CONSOLE_STATIC", raising=False)

    settings = default_settings()

    assert settings.data_dir == program_dir.parent / "data"
    assert settings.static_dir == internal_dir / "frontend" / "dist"


def test_portable_self_check_runs_the_health_route_in_temporary_data(
    capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<!doctype html>", encoding="utf-8")

    console_main._portable_self_check(
        AppSettings(data_dir=tmp_path / "user-data", static_dir=static_dir)
    )

    assert json.loads(capsys.readouterr().out) == {
        "service": "palserver-console",
        "portableSelfCheck": "ok",
        "health": "ok",
        "frontend": "ok",
    }
    assert not (tmp_path / "user-data").exists()


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_preserves_data_and_blocks_incompatible_downgrade(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")
    database_path = install_root / "data" / "app.db"
    _write_database(database_path, schema_version=8)

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    (candidate_program / "release.txt").write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version=8)
    _write_checksum_manifest(
        package_root,
        [candidate_launcher, candidate_program / "release.txt", metadata_path],
    )

    upgraded = _run_upgrade(script, install_root, package_root)

    assert upgraded.returncode == 0, f"{upgraded.stdout}\n{upgraded.stderr}"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"new-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "new"
    assert _schema_version(database_path) == 8
    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT value FROM settings WHERE key = 'portable.fixture'"
        ).fetchone() == ("keep-me",)
    backups = sorted((install_root / "data" / "upgrade-backups").glob("*/app.db"))
    assert len(backups) == 1
    assert _schema_version(backups[0]) == 8
    launcher_backups = sorted((install_root / "program-backups").glob("PalServerConsole-*.exe"))
    assert len(launcher_backups) == 1
    assert launcher_backups[0].read_bytes() == b"old-launcher"

    downgrade_root = tmp_path / "incompatible-downgrade"
    downgrade_program = downgrade_root / "Program"
    downgrade_program.mkdir(parents=True)
    (downgrade_program / "release.txt").write_text("older", encoding="utf-8")
    downgrade_launcher = downgrade_root / "PalServerConsole.exe"
    downgrade_launcher.write_bytes(b"older-launcher")
    downgrade_metadata = downgrade_root / "metadata" / "build-info.json"
    _write_build_metadata(downgrade_metadata, maximum_schema_version=7)
    _write_checksum_manifest(
        downgrade_root,
        [downgrade_launcher, downgrade_program / "release.txt", downgrade_metadata],
    )

    blocked = _run_upgrade(script, install_root, downgrade_root)

    assert blocked.returncode != 0
    assert "INCOMPATIBLE_DOWNGRADE" in f"{blocked.stdout}\n{blocked.stderr}"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"new-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "new"


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
@pytest.mark.parametrize("unlisted_name", ["unlisted.dll", "checksums.sha256"])
def test_portable_upgrade_rejects_unlisted_program_files(
    tmp_path: Path, unlisted_name: str
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    release_file = candidate_program / "release.txt"
    release_file.write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    (candidate_program / unlisted_name).write_bytes(b"not-covered-by-the-manifest")
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version=8)
    _write_checksum_manifest(package_root, [candidate_launcher, release_file, metadata_path])

    blocked = _run_upgrade(script, install_root, package_root)

    output = f"{blocked.stdout}\n{blocked.stderr}"
    assert blocked.returncode != 0
    assert "CHECKSUM_MANIFEST_INVALID" in output
    assert "unlisted" in output.casefold()
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"old-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "old"


def test_license_collector_includes_bundled_frontend_runtime_dependencies(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    node_modules = tmp_path / "node_modules"
    packages: dict[str, dict[str, object]] = {
        "react": {"version": "19.1.1", "dependencies": {"scheduler": "1.0.0"}},
        "scheduler": {"version": "1.0.0"},
        "lucide-react": {"version": "0.468.0", "peerDependencies": {"react": "*"}},
    }
    package_lock = {
        "name": "frontend-license-fixture",
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"react": "19.1.1", "lucide-react": "0.468.0"}},
            **{f"node_modules/{name}": metadata for name, metadata in packages.items()},
        },
    }
    lock_path = tmp_path / "package-lock.json"
    lock_path.write_text(json.dumps(package_lock), encoding="utf-8")
    for name, metadata in packages.items():
        package_root = node_modules / name
        package_root.mkdir(parents=True)
        (package_root / "package.json").write_text(
            json.dumps({"name": name, **metadata, "license": "MIT"}),
            encoding="utf-8",
        )
        (package_root / "LICENSE").write_text(f"{name} fixture license", encoding="utf-8")

    output = tmp_path / "THIRD_PARTY_LICENSES.md"
    completed = subprocess.run(
        [
            sys.executable,
            str(project_root / "scripts" / "collect-third-party-licenses.py"),
            "--output",
            str(output),
            "--requirements",
            str(project_root / "requirements.lock"),
            "--requirements",
            str(project_root / "requirements-build.lock"),
            "--package-lock",
            str(lock_path),
            "--node-modules",
            str(node_modules),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    rendered = output.read_text(encoding="utf-8")
    assert "## npm runtime dependencies" in rendered
    assert "### react 19.1.1" in rendered
    assert "### scheduler 1.0.0" in rendered
    assert "### lucide-react 0.468.0" in rendered


def test_portable_build_contract_includes_runtime_integrity_and_unsigned_disclosure() -> None:
    project_root = Path(__file__).resolve().parents[2]
    source_launcher = (project_root / "start-console.bat").read_text(encoding="ascii")
    native_launcher_path = project_root / "scripts" / "portable-launcher.cs"
    build_script = (project_root / "scripts" / "build-portable.ps1").read_text(encoding="utf-8-sig")
    upgrade_script = (project_root / "scripts" / "upgrade-portable.ps1").read_text(
        encoding="utf-8-sig"
    )
    portable_readme = (project_root / "docs" / "windows-portable.md").read_text(encoding="utf-8")

    assert '"%~dp0PalServerConsole.exe"' in source_launcher
    assert "PALSERVER_CONSOLE_DATA" in source_launcher
    assert "%*" in source_launcher
    assert native_launcher_path.is_file()
    native_launcher = native_launcher_path.read_text(encoding="utf-8")
    assert 'Path.Combine(packageRoot, "Program", "PalServerConsole.exe")' in native_launcher
    assert 'Path.Combine(packageRoot, "data")' in native_launcher
    assert 'startInfo.EnvironmentVariables["PALSERVER_CONSOLE_DATA"]' in native_launcher
    assert "string.IsNullOrWhiteSpace" in native_launcher
    assert "UseShellExecute = false" in native_launcher
    assert "QuoteArgument" in native_launcher
    assert "requirements-build.lock" in build_script
    assert "PyInstaller" in build_script
    assert "--onedir" in build_script
    assert "--add-data" in build_script
    assert "checksums.sha256" in build_script
    assert "build-info.json" in build_script
    assert "THIRD_PARTY_LICENSES.md" in build_script
    assert '"status": "unsigned"' in build_script
    assert "SOURCE_TREE_DIRTY" in build_script
    assert "sourceTreeState" in build_script
    assert "AllowDirtySource" in build_script
    assert "Remove-Item -LiteralPath $temporaryRoot -Recurse -Force" in build_script
    assert "--package-lock" in build_script
    assert "--node-modules" in build_script
    assert "portable-launcher.cs" in build_script
    assert 'Join-Path $packageStage "PalServerConsole.exe"' in build_script
    assert 'Portable root executable self-check' in build_script
    assert 'Join-Path $temporaryRoot "self-check-data"' in build_script
    assert "INCOMPATIBLE_DOWNGRADE" in upgrade_script
    assert "upgrade-backups" in upgrade_script
    assert "Get-FileHash" in upgrade_script
    assert "unlisted file" in upgrade_script
    assert "Program rollback completed" in upgrade_script
    assert 'Join-Path $packageRootPath "PalServerConsole.exe"' in upgrade_script
    assert 'Join-Path $installRootPath "PalServerConsole.exe"' in upgrade_script
    assert "未签名" in portable_readme
    assert "双击根目录的 `PalServerConsole.exe`" in portable_readme
    assert "Python" in portable_readme and "Node.js" in portable_readme
