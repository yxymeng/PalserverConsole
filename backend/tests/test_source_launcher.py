from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(os.name != "nt", reason="Windows batch launcher only")
def test_batch_launcher_does_not_pass_foreign_powershell_modules(tmp_path: Path) -> None:
    launcher = tmp_path / "start-console.bat"
    shutil.copyfile(ROOT / "start-console.bat", launcher)
    scripts = tmp_path / "scripts"
    scripts.mkdir()
    (scripts / "start-console.ps1").write_text(
        """
if ($env:PSModulePath -like '*foreign-modules*') {
    Write-Error 'foreign PSModulePath leaked into Windows PowerShell'
    exit 23
}
Write-Output 'launcher-environment-ok'
""".strip(),
        encoding="utf-8-sig",
    )
    environment = os.environ.copy()
    environment["PSModulePath"] = str(tmp_path / "foreign-modules")

    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(launcher)],
        cwd=tmp_path,
        env=environment,
        input="\n\n",
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert completed.returncode == 0
    assert "launcher-environment-ok" in completed.stdout
    assert "foreign PSModulePath leaked" not in completed.stderr
