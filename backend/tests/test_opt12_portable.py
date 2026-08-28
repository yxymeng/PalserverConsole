from __future__ import annotations

import base64
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
from palserver_console.world import worker as world_worker


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


def _write_maintenance_scripts(root: Path, version: str) -> tuple[Path, Path]:
    update_helper = root / "apply-downloaded-update.ps1"
    upgrade_script = root / "upgrade-portable.ps1"
    update_helper.write_text(f"update helper {version}", encoding="utf-8")
    upgrade_script.write_text(f"upgrade script {version}", encoding="utf-8")
    return update_helper, upgrade_script


def _run_upgrade(
    script: Path,
    install_root: Path,
    package_root: Path,
    *,
    data_directory: Path | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [
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
    ]
    if data_directory is not None:
        command.extend(["-DataDirectory", str(data_directory)])
    return subprocess.run(
        command,
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )


def _run_encoded_powershell(script: str) -> subprocess.CompletedProcess[str]:
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )


def _powershell_literal(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _portable_upgrade_fixture(
    tmp_path: Path,
    *,
    default_schema: int = 8,
    named_schemas: dict[str, int] | None = None,
    maximum_schema_version: int = 8,
) -> tuple[Path, Path, dict[str, Path]]:
    project_root = Path(__file__).resolve().parents[2]
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")
    _write_maintenance_scripts(install_root, "old")
    databases = {"default": install_root / "data" / "app.db"}
    _write_database(databases["default"], default_schema)
    for instance_id, schema_version in (named_schemas or {}).items():
        databases[instance_id] = install_root / "data" / "instances" / instance_id / "app.db"
        _write_database(databases[instance_id], schema_version)

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    (candidate_program / "release.txt").write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    candidate_update_helper, candidate_upgrade_script = _write_maintenance_scripts(
        package_root, "new"
    )
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version)
    _write_checksum_manifest(
        package_root,
        [
            candidate_launcher,
            candidate_program / "release.txt",
            candidate_update_helper,
            candidate_upgrade_script,
            metadata_path,
        ],
    )
    assert (project_root / "scripts" / "upgrade-portable.ps1").is_file()
    return install_root, package_root, databases


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


def test_portable_worker_dispatches_without_initializing_the_console(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    received: list[list[str] | None] = []

    def fake_worker(arguments: list[str] | None = None) -> int:
        received.append(arguments)
        return 17

    def unexpected_settings() -> AppSettings:
        pytest.fail("The portable worker must not initialize console settings.")

    monkeypatch.setattr(world_worker, "main", fake_worker)
    monkeypatch.setattr(console_main, "default_settings", unexpected_settings)

    with pytest.raises(SystemExit) as raised:
        console_main.main(["--world-worker", "--snapshot", "snapshot", "--cache", "cache"])

    assert raised.value.code == 17
    assert received == [["--snapshot", "snapshot", "--cache", "cache"]]


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_preserves_data_and_blocks_incompatible_downgrade(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")
    _write_maintenance_scripts(install_root, "old")
    database_path = install_root / "data" / "app.db"
    _write_database(database_path, schema_version=8)

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    (candidate_program / "release.txt").write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    candidate_update_helper, candidate_upgrade_script = _write_maintenance_scripts(
        package_root, "new"
    )
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version=8)
    _write_checksum_manifest(
        package_root,
        [
            candidate_launcher,
            candidate_program / "release.txt",
            candidate_update_helper,
            candidate_upgrade_script,
            metadata_path,
        ],
    )

    upgraded = _run_upgrade(script, install_root, package_root)

    assert upgraded.returncode == 0, f"{upgraded.stdout}\n{upgraded.stderr}"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"new-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "new"
    assert (install_root / "apply-downloaded-update.ps1").read_text(
        encoding="utf-8"
    ) == "update helper new"
    assert (install_root / "upgrade-portable.ps1").read_text(
        encoding="utf-8"
    ) == "upgrade script new"
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
    update_helper_backups = sorted(
        (install_root / "program-backups").glob("apply-downloaded-update-*.ps1")
    )
    upgrade_script_backups = sorted(
        (install_root / "program-backups").glob("upgrade-portable-*.ps1")
    )
    assert [path.read_text(encoding="utf-8") for path in update_helper_backups] == [
        "update helper old"
    ]
    assert [path.read_text(encoding="utf-8") for path in upgrade_script_backups] == [
        "upgrade script old"
    ]

    downgrade_root = tmp_path / "incompatible-downgrade"
    downgrade_program = downgrade_root / "Program"
    downgrade_program.mkdir(parents=True)
    (downgrade_program / "release.txt").write_text("older", encoding="utf-8")
    downgrade_launcher = downgrade_root / "PalServerConsole.exe"
    downgrade_launcher.write_bytes(b"older-launcher")
    downgrade_update_helper, downgrade_upgrade_script = _write_maintenance_scripts(
        downgrade_root, "older"
    )
    downgrade_metadata = downgrade_root / "metadata" / "build-info.json"
    _write_build_metadata(downgrade_metadata, maximum_schema_version=7)
    _write_checksum_manifest(
        downgrade_root,
        [
            downgrade_launcher,
            downgrade_program / "release.txt",
            downgrade_update_helper,
            downgrade_upgrade_script,
            downgrade_metadata,
        ],
    )

    blocked = _run_upgrade(script, install_root, downgrade_root)

    assert blocked.returncode != 0
    assert "INCOMPATIBLE_DOWNGRADE" in f"{blocked.stdout}\n{blocked.stderr}"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"new-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "new"


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_uses_named_instance_data_directory(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")
    _write_maintenance_scripts(install_root, "old")
    default_database = install_root / "data" / "app.db"
    _write_database(default_database, schema_version=8)
    named_data_directory = install_root / "data" / "instances" / "north"
    named_database = named_data_directory / "app.db"
    _write_database(named_database, schema_version=8)

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    (candidate_program / "release.txt").write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    candidate_update_helper, candidate_upgrade_script = _write_maintenance_scripts(
        package_root, "new"
    )
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version=8)
    _write_checksum_manifest(
        package_root,
        [
            candidate_launcher,
            candidate_program / "release.txt",
            candidate_update_helper,
            candidate_upgrade_script,
            metadata_path,
        ],
    )

    upgraded = _run_upgrade(
        script,
        install_root,
        package_root,
        data_directory=named_data_directory,
    )

    assert upgraded.returncode == 0, f"{upgraded.stdout}\n{upgraded.stderr}"
    assert (install_root / "apply-downloaded-update.ps1").read_text(
        encoding="utf-8"
    ) == "update helper new"
    assert (install_root / "upgrade-portable.ps1").read_text(
        encoding="utf-8"
    ) == "upgrade script new"
    assert _schema_version(named_database) == 8
    assert len(list((named_data_directory / "upgrade-backups").glob("*/app.db"))) == 1
    assert _schema_version(default_database) == 8
    assert len(list((install_root / "data" / "upgrade-backups").glob("*/app.db"))) == 1


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_scans_and_backups_all_managed_databases(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root, package_root, databases = _portable_upgrade_fixture(
        tmp_path, named_schemas={"north": 8, "south": 8}
    )
    (install_root / "data" / "instances" / "empty").mkdir()

    upgraded = _run_upgrade(
        script,
        install_root,
        package_root,
        data_directory=databases["north"].parent,
    )

    assert upgraded.returncode == 0, f"{upgraded.stdout}\n{upgraded.stderr}"
    for database in databases.values():
        assert _schema_version(database) == 8
        backups = list((database.parent / "upgrade-backups").glob("*/app.db"))
        assert len(backups) == 1
        assert _schema_version(backups[0]) == 8
    assert not (install_root / "data" / "instances" / "empty" / "upgrade-backups").exists()


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_rejects_incompatible_non_current_named_database(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root, package_root, databases = _portable_upgrade_fixture(
        tmp_path, named_schemas={"north": 8, "south": 9}
    )

    blocked = _run_upgrade(
        script,
        install_root,
        package_root,
        data_directory=databases["north"].parent,
    )

    output = f"{blocked.stdout}\n{blocked.stderr}"
    assert blocked.returncode != 0
    assert "INCOMPATIBLE_DOWNGRADE" in output
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"old-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "old"
    assert not (install_root / "data" / "upgrade-backups").exists()


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_rejects_sidecar_in_non_current_named_database(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root, package_root, databases = _portable_upgrade_fixture(
        tmp_path, named_schemas={"north": 8, "south": 8}
    )
    sidecar = databases["south"].with_name("app.db-wal")
    sidecar.write_bytes(b"pending wal")

    blocked = _run_upgrade(
        script,
        install_root,
        package_root,
        data_directory=databases["north"].parent,
    )

    output = f"{blocked.stdout}\n{blocked.stderr}"
    assert blocked.returncode != 0
    assert "DATABASE_SIDECAR_PRESENT" in output
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"old-launcher"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "old"


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_does_not_follow_reparse_instance_directory(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root, package_root, _ = _portable_upgrade_fixture(tmp_path)
    outside = tmp_path / "outside"
    outside_database = outside / "app.db"
    _write_database(outside_database, schema_version=99)
    link = install_root / "data" / "instances" / "linked"
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.symlink(outside, link, target_is_directory=True)
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"directory symlink unavailable: {error}")

    upgraded = _run_upgrade(script, install_root, package_root)

    assert upgraded.returncode == 0, f"{upgraded.stdout}\n{upgraded.stderr}"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"new-launcher"
    assert _schema_version(outside_database) == 99
    assert not (outside / "upgrade-backups").exists()


@pytest.mark.skipif(os.name != "nt", reason="OPT-12 packages and upgrade tooling target Windows")
def test_portable_upgrade_rolls_back_maintenance_scripts_after_late_failure(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    upgrade_script = project_root / "scripts" / "upgrade-portable.ps1"
    install_root = tmp_path / "installed"
    (install_root / "Program").mkdir(parents=True)
    (install_root / "Program" / "release.txt").write_text("old", encoding="utf-8")
    (install_root / "PalServerConsole.exe").write_bytes(b"old-launcher")
    _write_maintenance_scripts(install_root, "old")

    package_root = tmp_path / "candidate"
    candidate_program = package_root / "Program"
    candidate_program.mkdir(parents=True)
    (candidate_program / "release.txt").write_text("new", encoding="utf-8")
    candidate_launcher = package_root / "PalServerConsole.exe"
    candidate_launcher.write_bytes(b"new-launcher")
    candidate_update_helper, candidate_upgrade_script = _write_maintenance_scripts(
        package_root, "new"
    )
    metadata_path = package_root / "metadata" / "build-info.json"
    _write_build_metadata(metadata_path, maximum_schema_version=8)
    _write_checksum_manifest(
        package_root,
        [
            candidate_launcher,
            candidate_program / "release.txt",
            candidate_update_helper,
            candidate_upgrade_script,
            metadata_path,
        ],
    )

    def powershell_literal(path: Path) -> str:
        return "'" + str(path).replace("'", "''") + "'"

    command = f"""
$upgradeScript = {powershell_literal(upgrade_script)}
$installRoot = {powershell_literal(install_root)}
$packageRoot = {powershell_literal(package_root)}
function Move-Item {{
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Destination)
    if ($LiteralPath -like "*.upgrade-portable-upgrade-staging-*.ps1") {{
        throw "forced later maintenance script failure"
    }}
    Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters
}}
& $upgradeScript -InstallRoot $installRoot -NewPackage $packageRoot
"""
    encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
    rolled_back = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encoded,
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )

    assert rolled_back.returncode != 0
    assert "UPGRADE_FAILED" in f"{rolled_back.stdout}\n{rolled_back.stderr}"
    assert (install_root / "Program" / "release.txt").read_text(encoding="utf-8") == "old"
    assert (install_root / "PalServerConsole.exe").read_bytes() == b"old-launcher"
    assert (install_root / "apply-downloaded-update.ps1").read_text(
        encoding="utf-8"
    ) == "update helper old"
    assert (install_root / "upgrade-portable.ps1").read_text(
        encoding="utf-8"
    ) == "upgrade script old"


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
    application_update_helper = (
        project_root / "scripts" / "apply-downloaded-update.ps1"
    ).read_text(encoding="utf-8-sig")
    portable_readme = (project_root / "docs" / "windows-portable.md").read_text(encoding="utf-8")
    root_readme = (project_root / "README.md").read_text(encoding="utf-8-sig")

    assert '"%~dp0PalServerConsole.exe"' in source_launcher
    assert "PALSERVER_CONSOLE_DATA" in source_launcher
    assert "%*" in source_launcher
    assert native_launcher_path.is_file()
    native_launcher = native_launcher_path.read_text(encoding="utf-8")
    assert 'Path.Combine(packageRoot, "Program", "PalServerConsole.exe")' in native_launcher
    assert 'Path.Combine(packageRoot, "data")' in native_launcher
    assert 'Environment.GetEnvironmentVariable("PALSERVER_CONSOLE_DATA")' in native_launcher
    assert 'startInfo.EnvironmentVariables["PALSERVER_CONSOLE_DATA"]' in native_launcher
    assert "string.IsNullOrWhiteSpace" in native_launcher
    assert "UseShellExecute = false" in native_launcher
    assert "QuoteArgument" in native_launcher
    assert "requirements-build.lock" in build_script
    assert "PyInstaller" in build_script
    assert "function Assert-NodeRuntime" in build_script
    assert "UNSUPPORTED_NODE_VERSION" in build_script
    assert "function Assert-NpmPolicy" in build_script
    assert "UNSUPPORTED_NPM_VERSION" in build_script
    assert "function Assert-NpmInstallScriptsApproved" in build_script
    assert "No packages with unreviewed install scripts" in build_script
    assert "UNREVIEWED_INSTALL_SCRIPT" in build_script
    assert build_script.index("Get-Command node.exe") < build_script.index(
        "Assert-NodeRuntime $node.Source"
    )
    assert build_script.index("Assert-NodeRuntime $node.Source") < build_script.index(
        "Get-Command npm.cmd"
    )
    assert build_script.index("Assert-NodeRuntime $node.Source") < build_script.index(
        "& $npm.Source ci"
    )
    assert build_script.index("Assert-NpmPolicy $npm.Source") < build_script.index(
        "& $npm.Source ci"
    )
    assert build_script.index("Assert-NpmInstallScriptsApproved $npm.Source") < build_script.index(
        "& $npm.Source run build"
    )
    assert "--onedir" in build_script
    assert "--add-data" in build_script
    assert "checksums.sha256" in build_script
    assert "build-info.json" in build_script
    assert "THIRD_PARTY_LICENSES.md" in build_script
    assert 'Join-Path $projectRoot "LICENSE"' in build_script
    assert 'Copy-Item -LiteralPath $projectLicense -Destination $packageStage' in build_script
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
    assert 'Portable worker executable self-check' in build_script
    assert '--world-worker --help' in build_script
    assert 'Join-Path $temporaryRoot "self-check-data"' in build_script
    assert build_script.index('Portable worker executable self-check') < build_script.index(
        "$selfCheck ="
    )
    assert 'Get-ChildItem -LiteralPath $portableData -Force -Recurse' in build_script
    assert "Portable self-check wrote runtime data into the release package." in build_script
    assert "INCOMPATIBLE_DOWNGRADE" in upgrade_script
    assert "upgrade-backups" in upgrade_script
    assert "function Get-Sha256Hash" in upgrade_script
    assert "System.Security.Cryptography.SHA256" in upgrade_script
    assert "unlisted file" in upgrade_script
    assert "maintenance scripts" in upgrade_script
    assert "apply-downloaded-update.ps1" in build_script
    assert "CONSOLE_EXIT_TIMEOUT" in application_update_helper
    assert "Start-Process" in application_update_helper
    assert "Restore-ConsoleLauncher" in application_update_helper
    assert "$updateError = $_" in application_update_helper
    assert "UPDATE_FAILURE_RELAUNCH_FAILED" in application_update_helper
    assert '[string]$UpdateLockId' in application_update_helper
    assert "Set-UpdateLockOwner" in application_update_helper
    assert "Set-Content -Encoding UTF8" not in application_update_helper
    assert "System.Text.UTF8Encoding" in application_update_helper
    assert "ArgumentList $false" in application_update_helper
    assert "[System.IO.File]::WriteAllText" in application_update_helper
    assert "Release-UpdateLockForLaunch" in application_update_helper
    assert "Remove-UpdateLockIfOwned" in application_update_helper
    assert ".palserver-console-update.lock" in application_update_helper
    assert "finally" in application_update_helper
    assert "Remove-UpdateLockIfOwned -UpdateLockPath $updateLockPath" in application_update_helper
    release_call = (
        "Release-UpdateLockForLaunch `\n"
        "        -UpdateLockPath $updateLockPath `\n"
        "        -ExpectedLockId $UpdateLockId"
    )
    success_release = application_update_helper.index(release_call)
    success_launch = application_update_helper.index(
        "Start-ConsoleLauncher -Launcher $launcher", success_release
    )
    failure_release = application_update_helper.rindex(release_call)
    failure_restore = application_update_helper.index(
        "Restore-ConsoleLauncher -Launcher $launcher"
    )
    assert success_release < success_launch
    assert failure_release < failure_restore
    assert 'Join-Path $packageRootPath "PalServerConsole.exe"' in upgrade_script
    assert 'Join-Path $installRootPath "PalServerConsole.exe"' in upgrade_script
    assert '[string]$DataDirectory = ""' in upgrade_script
    assert "function Get-CurrentInstallConsoleProcesses" in upgrade_script
    assert upgrade_script.count('Get-Process -Name "PalServerConsole"') == 1
    assert "$currentInstallProcesses = @(Get-CurrentInstallConsoleProcesses" in upgrade_script
    assert "Get-ReleaseManagedEntry" in upgrade_script
    assert "Assert-ReleaseManagedFileChecksum" in upgrade_script
    assert "function Get-ManagedDatabaseCandidates" in upgrade_script
    assert "function Test-ReparsePoint" in upgrade_script
    assert 'Join-Path $installDataDirectory "instances"' in upgrade_script
    assert "$databaseCandidates = @(Get-ManagedDatabaseCandidates" in upgrade_script
    assert "DATABASE_SIDECAR_PRESENT" in upgrade_script
    assert 'Join-Path $packageRootPath "apply-downloaded-update.ps1"' in upgrade_script
    assert 'Join-Path $packageRootPath "upgrade-portable.ps1"' in upgrade_script
    assert "未签名" in portable_readme
    assert "双击根目录的 `PalServerConsole.exe`" in portable_readme
    assert "Python" in portable_readme and "Node.js" in portable_readme
    assert "npm >= 11.17" in root_readme
    assert "npm 11.17.0" in root_readme


@pytest.mark.skipif(os.name != "nt", reason="portable builder targets Windows")
@pytest.mark.parametrize("version", ["v24.0.0", "v24.15.0"])
def test_portable_builder_accepts_supported_node_versions(tmp_path: Path, version: str) -> None:
    project_root = Path(__file__).resolve().parents[2]
    node_path = tmp_path / "node.cmd"
    node_path.write_text(
        f'@echo off\r\nif "%~1"=="--version" echo {version}\r\n', encoding="ascii"
    )
    script = f"""
$buildPath = {_powershell_literal(project_root / "scripts" / "build-portable.ps1")}
$nodePath = {_powershell_literal(node_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $buildPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Assert-NodeRuntime"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Assert-NodeRuntime -NodePath $nodePath
"""

    completed = _run_encoded_powershell(script)

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    assert "Node.js runtime accepted" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="portable builder targets Windows")
@pytest.mark.parametrize(
    ("version_output", "exit_code"),
    [
        ("v23.11.0", 0),
        ("v25.0.0", 0),
        ("not-a-node-version", 0),
        ("v24.0.0", 1),
    ],
)
def test_portable_builder_rejects_unsupported_node_before_install(
    tmp_path: Path, version_output: str, exit_code: int
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    node_path = tmp_path / "node.cmd"
    node_path.write_text(
        "@echo off\r\n"
        'if "%~1"=="--version" (\r\n'
        f"  echo {version_output}\r\n"
        f"  exit /b {exit_code}\r\n"
        ")\r\n",
        encoding="ascii",
    )
    script = f"""
$buildPath = {_powershell_literal(project_root / "scripts" / "build-portable.ps1")}
$nodePath = {_powershell_literal(node_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $buildPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Assert-NodeRuntime"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Assert-NodeRuntime -NodePath $nodePath
"""

    completed = _run_encoded_powershell(script)

    assert completed.returncode != 0
    assert "UNSUPPORTED_NODE_VERSION" in f"{completed.stdout}\n{completed.stderr}"


@pytest.mark.skipif(os.name != "nt", reason="portable builder targets Windows")
@pytest.mark.parametrize("version", ["11.17.0", "12.0.0"])
def test_portable_builder_accepts_supported_npm_versions(tmp_path: Path, version: str) -> None:
    project_root = Path(__file__).resolve().parents[2]
    npm_path = tmp_path / "npm.cmd"
    npm_path.write_text(
        f'@echo off\r\nif "%~1"=="--version" echo {version}\r\n', encoding="ascii"
    )
    script = f"""
$buildPath = {_powershell_literal(project_root / "scripts" / "build-portable.ps1")}
$npmPath = {_powershell_literal(npm_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $buildPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Assert-NpmPolicy"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Assert-NpmPolicy -NpmPath $npmPath
"""

    completed = _run_encoded_powershell(script)

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    assert "npm policy accepted" in completed.stdout


@pytest.mark.skipif(os.name != "nt", reason="portable builder targets Windows")
def test_portable_builder_rejects_unsupported_npm_before_install(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    npm_path = tmp_path / "npm.cmd"
    npm_path.write_text('@echo off\r\nif "%~1"=="--version" echo 11.16.9\r\n', encoding="ascii")
    script = f"""
$buildPath = {_powershell_literal(project_root / "scripts" / "build-portable.ps1")}
$npmPath = {_powershell_literal(npm_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $buildPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Assert-NpmPolicy"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Assert-NpmPolicy -NpmPath $npmPath
"""

    completed = _run_encoded_powershell(script)

    assert completed.returncode != 0
    assert "UNSUPPORTED_NPM_VERSION" in f"{completed.stdout}\n{completed.stderr}"


@pytest.mark.skipif(os.name != "nt", reason="portable builder targets Windows")
@pytest.mark.parametrize(
    ("approval_output", "expected_success"),
    [
        ("No packages with unreviewed install scripts.", True),
        ("Packages with unreviewed install scripts remain.", False),
    ],
)
def test_portable_builder_enforces_install_script_policy(
    tmp_path: Path, approval_output: str, expected_success: bool
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    npm_path = tmp_path / "npm.cmd"
    npm_path.write_text(
        f'@echo off\r\nif "%~1"=="approve-scripts" echo {approval_output}\r\n',
        encoding="ascii",
    )
    script = f"""
$buildPath = {_powershell_literal(project_root / "scripts" / "build-portable.ps1")}
$npmPath = {_powershell_literal(npm_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $buildPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Assert-NpmInstallScriptsApproved"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Assert-NpmInstallScriptsApproved -NpmPath $npmPath
"""

    completed = _run_encoded_powershell(script)

    assert (completed.returncode == 0) is expected_success, (
        f"{completed.stdout}\n{completed.stderr}"
    )
    if not expected_success:
        assert "UNREVIEWED_INSTALL_SCRIPT" in f"{completed.stdout}\n{completed.stderr}"


def test_portable_update_waits_for_current_installation_console_processes() -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = (
        project_root / "scripts" / "apply-downloaded-update.ps1"
    ).read_text(encoding="utf-8-sig")

    assert "function Get-CurrentInstallConsoleProcesses" in update_helper
    assert 'Join-Path $InstallRootPath "PalServerConsole.exe"' in update_helper
    assert 'Join-Path $InstallRootPath "Program\\PalServerConsole.exe"' in update_helper
    assert "$process.MainModule.FileName" in update_helper
    assert "$currentInstallProcesses.Count -eq 0" in update_helper
    assert "CONSOLE_EXIT_TIMEOUT" in update_helper
    assert update_helper.index("Get-CurrentInstallConsoleProcesses") < update_helper.index(
        "& $upgradeScript"
    )


@pytest.mark.skipif(os.name != "nt", reason="portable update helper targets Windows")
def test_portable_update_helper_releases_lock_after_failed_update(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / "apply-downloaded-update.ps1"
    install_root = tmp_path / "install"
    install_root.mkdir()
    data_directory = tmp_path / "data"
    lock_path = install_root / ".palserver-console-update.lock"
    lock_id = "matching-lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": lock_id,
                "pid": 1,
                "processStartedAt": 1.0,
                "phase": "prepare",
                "instanceId": "north",
                "createdAt": 2,
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(update_helper),
            "-WaitPid",
            "999999",
            "-InstallRoot",
            str(install_root),
            "-UpdateLockId",
            lock_id,
            "-DataDirectory",
            str(data_directory),
            "-NewPackage",
            str(tmp_path / "missing-package"),
            "-InstanceId",
            "north",
            "-Port",
            "18224",
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 1, f"{completed.stdout}\n{completed.stderr}"
    assert not lock_path.exists()
    assert "UPDATE_HELPER_INVALID" in (
        data_directory / "application-updates" / "apply-update.log"
    ).read_text(encoding="utf-8")


@pytest.mark.skipif(os.name != "nt", reason="portable update helper targets Windows")
def test_portable_update_helper_releases_lock_after_successful_update(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / "apply-downloaded-update.ps1"
    install_root = tmp_path / "install"
    install_root.mkdir()
    launcher = install_root / "PalServerConsole.exe"
    launcher.write_bytes(Path(os.environ["COMSPEC"]).read_bytes())
    data_directory = tmp_path / "data"
    package_root = tmp_path / "package"
    package_root.mkdir()
    (package_root / "upgrade-portable.ps1").write_text("exit 0", encoding="utf-8")
    lock_id = "successful-lock"
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": lock_id,
                "pid": 1,
                "processStartedAt": 1.0,
                "phase": "prepare",
                "instanceId": "north",
                "createdAt": 2,
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(update_helper),
            "-WaitPid",
            "999999",
            "-InstallRoot",
            str(install_root),
            "-UpdateLockId",
            lock_id,
            "-DataDirectory",
            str(data_directory),
            "-NewPackage",
            str(package_root),
            "-InstanceId",
            "north",
            "-Port",
            "18224",
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    assert not lock_path.exists()


@pytest.mark.skipif(os.name != "nt", reason="portable update helper targets Windows")
def test_portable_update_helper_transfers_lock_ownership(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / "apply-downloaded-update.ps1"
    lock_path = tmp_path / ".palserver-console-update.lock"
    lock_id = "transfer-lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": lock_id,
                "pid": 1,
                "processStartedAt": 1.0,
                "phase": "prepare",
                "instanceId": "north",
                "createdAt": 2,
            }
        ),
        encoding="utf-8",
    )

    def powershell_literal(path: Path) -> str:
        return "'" + str(path).replace("'", "''") + "'"

    script = f"""
$helperPath = {powershell_literal(update_helper)}
$lockPath = {powershell_literal(lock_path)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $helperPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Set-UpdateLockOwner"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))
Set-UpdateLockOwner -UpdateLockPath $lockPath -ExpectedLockId "{lock_id}"
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
[pscustomobject]@{{
    lockId = $lock.lockId
    pid = $lock.pid
    processStartedAt = $lock.processStartedAt
    phase = $lock.phase
    instanceId = $lock.instanceId
}} | ConvertTo-Json -Compress
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    completed = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    lock = json.loads(completed.stdout)
    assert lock["lockId"] == lock_id
    assert lock["pid"] > 0
    assert lock["processStartedAt"] > 0
    assert lock["phase"] == "helper"
    assert lock["instanceId"] == "north"
    assert lock_path.read_bytes()[:3] != b"\xef\xbb\xbf"


@pytest.mark.skipif(os.name != "nt", reason="portable update helper targets Windows")
def test_portable_update_helper_does_not_delete_another_lock(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / "apply-downloaded-update.ps1"
    install_root = tmp_path / "install"
    install_root.mkdir()
    data_directory = tmp_path / "data"
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": "another-update",
                "pid": 1,
                "processStartedAt": 1.0,
                "phase": "helper",
            }
        ),
        encoding="utf-8",
    )

    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(update_helper),
            "-WaitPid",
            "999999",
            "-InstallRoot",
            str(install_root),
            "-UpdateLockId",
            "expected-update",
            "-DataDirectory",
            str(data_directory),
            "-NewPackage",
            str(tmp_path / "missing-package"),
            "-InstanceId",
            "north",
            "-Port",
            "18224",
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 1, f"{completed.stdout}\n{completed.stderr}"
    assert json.loads(lock_path.read_text(encoding="utf-8"))["lockId"] == "another-update"


@pytest.mark.skipif(os.name != "nt", reason="portable update helpers target Windows")
@pytest.mark.parametrize(
    "script_name",
    ["apply-downloaded-update.ps1", "upgrade-portable.ps1"],
)
def test_portable_process_filter_scopes_to_the_current_installation(
    tmp_path: Path, script_name: str
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / script_name
    install_root = tmp_path / "current"
    other_install_root = tmp_path / "other"

    def powershell_literal(path: Path) -> str:
        return "'" + str(path).replace("'", "''") + "'"

    script = f"""
$helperPath = {powershell_literal(update_helper)}
$installRoot = {powershell_literal(install_root)}
$otherInstallRoot = {powershell_literal(other_install_root)}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $helperPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Get-CurrentInstallConsoleProcesses"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))

$currentRoot = Join-Path $installRoot "PalServerConsole.exe"
$currentProgram = Join-Path $installRoot "Program\\PalServerConsole.exe"
$otherRoot = Join-Path $otherInstallRoot "PalServerConsole.exe"
$script:fakeProcesses = @(
    [pscustomobject]@{{ Id = 101; MainModule = [pscustomobject]@{{ FileName = $currentRoot }} }},
    [pscustomobject]@{{ Id = 102; MainModule = [pscustomobject]@{{ FileName = $currentProgram }} }},
    [pscustomobject]@{{ Id = 103; MainModule = [pscustomobject]@{{ FileName = $otherRoot }} }}
)
function Get-Process {{
    param([string]$Name, [object]$ErrorAction)
    $script:fakeProcesses
}}
$matchingIds = @(
    Get-CurrentInstallConsoleProcesses -InstallRootPath $installRoot |
        ForEach-Object {{ $_.Id }}
)
$script:fakeProcesses = @($script:fakeProcesses[2])
$otherInstallMatchCount = @(Get-CurrentInstallConsoleProcesses -InstallRootPath $installRoot).Count
[pscustomobject]@{{
    matchingIds = $matchingIds
    otherInstallMatchCount = $otherInstallMatchCount
}} |
    ConvertTo-Json -Compress
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    completed = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-EncodedCommand",
            encoded,
        ],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    assert json.loads(completed.stdout) == {
        "matchingIds": [101, 102],
        "otherInstallMatchCount": 0,
    }


@pytest.mark.skipif(os.name != "nt", reason="portable update helper targets Windows")
def test_portable_update_failure_relaunches_only_when_current_installation_is_stopped(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    update_helper = project_root / "scripts" / "apply-downloaded-update.ps1"

    def powershell_literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"

    script = f"""
$helperPath = {powershell_literal(str(update_helper))}
$parsed = [ScriptBlock]::Create((Get-Content -Raw -LiteralPath $helperPath))
$definition = $parsed.Ast.FindAll({{
    param($ast)
    $ast -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $ast.Name -eq "Restore-ConsoleLauncher"
}}, $true) | Select-Object -First 1
. ([ScriptBlock]::Create($definition.Extent.Text))

$script:running = @()
$script:starts = @()
function Get-CurrentInstallConsoleProcesses {{
    param([string]$InstallRootPath)
    $script:running
}}
function Start-ConsoleLauncher {{
    param([string]$Launcher, [string]$InstallRootPath, [string]$InstanceId, [int]$Port)
    $script:starts += [pscustomobject]@{{ InstanceId = $InstanceId; Port = $Port }}
}}

$restoreParameters = @{{
    Launcher = "launcher.exe"
    InstallRootPath = "current"
    InstanceId = "north"
    Port = 18224
}}
Restore-ConsoleLauncher @restoreParameters
$caseA = @($script:starts)
$script:running = @([pscustomobject]@{{ Id = 1 }})
$script:starts = @()
Restore-ConsoleLauncher @restoreParameters
$caseBStartCount = @($script:starts).Count
$script:running = @()
function Start-ConsoleLauncher {{ throw "forced relaunch failure" }}
$caseC = try {{
    Restore-ConsoleLauncher @restoreParameters
    "no failure"
}}
catch {{
    $_.Exception.Message
}}
[pscustomobject]@{{
    caseAStartCount = $caseA.Count
    caseAInstanceId = $caseA[0].InstanceId
    caseAPort = $caseA[0].Port
    caseBStartCount = $caseBStartCount
    caseC = $caseC
}} | ConvertTo-Json -Compress
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    completed = subprocess.run(
        ["powershell.exe", "-NoLogo", "-NoProfile", "-EncodedCommand", encoded],
        check=False,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )

    assert completed.returncode == 0, f"{completed.stdout}\n{completed.stderr}"
    assert json.loads(completed.stdout) == {
        "caseAStartCount": 1,
        "caseAInstanceId": "north",
        "caseAPort": 18224,
        "caseBStartCount": 0,
        "caseC": "UPDATE_FAILURE_RELAUNCH_FAILED: forced relaunch failure",
    }
