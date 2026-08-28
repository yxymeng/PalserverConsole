from __future__ import annotations

import io
import json
import math
import os
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, cast

import httpx
import psutil
import pytest

from palserver_console.application_updates import (
    RELEASE_API_URL,
    ApplicationUpdateError,
    ApplicationUpdateService,
    _InstallUpdateGuard,
    portable_application_update_in_progress,
)


def _release_zip(version: str) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("PalServerConsole.exe", b"launcher")
        archive.writestr("Program/PalServerConsole.exe", b"program")
        archive.writestr(
            "metadata/build-info.json",
            json.dumps({"version": version}),
        )
        archive.writestr("checksums.sha256", "fixture")
        archive.writestr("apply-downloaded-update.ps1", "Write-Host fixture")
        archive.writestr("upgrade-portable.ps1", "Write-Host fixture")
    return output.getvalue()


def _client_factory(release: dict[str, object], package: bytes) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == RELEASE_API_URL:
            return httpx.Response(200, json=release, request=request)
        return httpx.Response(
            200,
            content=package,
            headers={"content-length": str(len(package))},
            request=request,
        )

    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


def _enable_graceful_shutdown(service: ApplicationUpdateService) -> None:
    service.bind_shutdown_requester(lambda: None)


class _FakeHelperProcess:
    def __init__(
        self,
        *,
        returncode: int | None = None,
        terminate_error: bool = False,
        terminate_exits: bool = True,
        wait_timeout: bool = False,
        kill_error: bool = False,
        kill_exits: bool = True,
    ) -> None:
        self.pid = os.getpid()
        self.returncode = returncode
        self.terminated = False
        self.killed = False
        self.terminate_error = terminate_error
        self.terminate_exits = terminate_exits
        self.wait_timeout = wait_timeout
        self.kill_error = kill_error
        self.kill_exits = kill_exits

    def poll(self) -> int | None:
        return self.returncode

    def terminate(self) -> None:
        self.terminated = True
        if self.terminate_error:
            raise OSError("terminate failed")
        if self.terminate_exits:
            self.returncode = -15

    def kill(self) -> None:
        self.killed = True
        if self.kill_error:
            raise OSError("kill failed")
        self.terminated = True
        if self.kill_exits:
            self.returncode = -9

    def wait(self, timeout: float | None = None) -> int:
        if self.wait_timeout:
            raise subprocess.TimeoutExpired("fake-helper", timeout or 0.0)
        return self.returncode if self.returncode is not None else 0


def _handoff_runner(
    lock_path: Path,
    calls: list[list[str]] | None = None,
    process: _FakeHelperProcess | None = None,
) -> Any:
    helper = process or _FakeHelperProcess()

    def runner(command: list[str], **kwargs: object) -> _FakeHelperProcess:
        if calls is not None:
            calls.append(command)
        metadata = json.loads(lock_path.read_text(encoding="utf-8-sig"))
        metadata.update(
            {
                "pid": helper.pid,
                "processStartedAt": psutil.Process(helper.pid).create_time(),
                "phase": "helper",
            }
        )
        lock_path.write_text(json.dumps(metadata), encoding="utf-8")
        return helper

    return runner


def _write_update_lock(
    lock_path: Path, metadata: dict[str, object], *, bom: bool = False
) -> None:
    encoded = json.dumps(metadata).encode("utf-8")
    lock_path.write_bytes((b"\xef\xbb\xbf" if bom else b"") + encoded)


def _subprocess_environment(project_root: Path) -> dict[str, str]:
    environment = os.environ.copy()
    python_path = [str(project_root / "backend")]
    if environment.get("PYTHONPATH"):
        python_path.append(environment["PYTHONPATH"])
    environment["PYTHONPATH"] = os.pathsep.join(python_path)
    return environment


@pytest.mark.skipif(os.name != "nt", reason="Windows update guard contract")
def test_install_update_guard_uses_install_root_exclusive_file_handle(
    tmp_path: Path,
) -> None:
    project_root = Path(__file__).resolve().parents[2]
    source = (project_root / "backend" / "palserver_console" / "application_updates.py").read_text(
        encoding="utf-8"
    )
    assert "CreateFileW" in source
    assert "CreateMutexW" not in source
    assert "Local\\\\PalServerConsole.UpdateGuard." not in source

    install_root = tmp_path / "install"
    install_root.mkdir()
    with _InstallUpdateGuard(install_root):
        pass
    assert (install_root / ".palserver-console-update.guard").is_file()


@pytest.mark.skipif(os.name != "nt", reason="Windows update guard contract")
def test_install_update_guard_serializes_real_processes(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    install_root = tmp_path / "install"
    install_root.mkdir()
    child_script = """
import json
import sys
import time
from pathlib import Path

from palserver_console.application_updates import _InstallUpdateGuard

with _InstallUpdateGuard(Path(sys.argv[1])):
    entered = time.monotonic()
    print(json.dumps({"entered": entered}), flush=True)
    time.sleep(float(sys.argv[2]))
    print(json.dumps({"exited": time.monotonic()}), flush=True)
"""
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", child_script, str(install_root), "0.25"],
            cwd=str(project_root),
            env=_subprocess_environment(project_root),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(2)
    ]
    try:
        payloads: list[dict[str, float]] = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=15)
            assert process.returncode == 0, f"{stdout}\n{stderr}"
            lines = [line for line in stdout.splitlines() if line]
            assert len(lines) == 2, f"{stdout}\n{stderr}"
            payloads.append({**json.loads(lines[0]), **json.loads(lines[1])})
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)

    first, second = payloads
    assert first["exited"] <= second["entered"] or second["exited"] <= first["entered"]
    assert (install_root / ".palserver-console-update.guard").is_file()


@pytest.mark.skipif(os.name != "nt", reason="Windows update guard contract")
def test_abandoned_reclaim_with_real_processes_leaves_one_update_owner(tmp_path: Path) -> None:
    project_root = Path(__file__).resolve().parents[2]
    install_root = tmp_path / "install"
    install_root.mkdir()
    owner_script = """
import json
import os
import sys
from pathlib import Path

import psutil

from palserver_console.application_updates import _InstallUpdateGuard

root = Path(sys.argv[1])
with _InstallUpdateGuard(root):
    (root / ".palserver-console-update.lock").write_text(
        json.dumps({
            "lockId": "abandoned",
            "pid": os.getpid(),
            "processStartedAt": psutil.Process(os.getpid()).create_time(),
            "phase": "prepare",
        }),
        encoding="utf-8",
    )
print(json.dumps({"pid": os.getpid()}), flush=True)
"""
    owner = subprocess.run(
        [sys.executable, "-c", owner_script, str(install_root)],
        cwd=str(project_root),
        env=_subprocess_environment(project_root),
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert owner.returncode == 0, f"{owner.stdout}\n{owner.stderr}"
    owner_metadata = json.loads(owner.stdout.splitlines()[-1])
    assert owner_metadata["pid"] != os.getpid()

    start_path = tmp_path / "start"
    release_path = tmp_path / "release"
    contenders = []
    contender_scripts = """
import json
import sys
import time
from pathlib import Path

from palserver_console.application_updates import ApplicationUpdateError, ApplicationUpdateService

root = Path(sys.argv[1])
ready_path = Path(sys.argv[2])
result_path = Path(sys.argv[3])
start_path = Path(sys.argv[4])
release_path = Path(sys.argv[5])
ready_path.write_text("ready", encoding="ascii")
while not start_path.exists():
    time.sleep(0.01)
service = ApplicationUpdateService("0.1.1", root / "data", install_root=root)
try:
    lock_path, lock_id = service._acquire_update_lock()
except ApplicationUpdateError as error:
    result_path.write_text(
        json.dumps({"outcome": "error", "code": error.code}), encoding="utf-8"
    )
else:
    result_path.write_text(
        json.dumps({"outcome": "success", "lockId": lock_id}), encoding="utf-8"
    )
    while not release_path.exists():
        time.sleep(0.01)
    service._release_update_lock(lock_path)
"""
    try:
        for name in ("north", "south"):
            ready_path = tmp_path / f"{name}.ready"
            result_path = tmp_path / f"{name}.result"
            contenders.append(
                subprocess.Popen(
                    [
                        sys.executable,
                        "-c",
                        contender_scripts,
                        str(install_root),
                        str(ready_path),
                        str(result_path),
                        str(start_path),
                        str(release_path),
                    ],
                    cwd=str(project_root),
                    env=_subprocess_environment(project_root),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            )

        deadline = time.monotonic() + 15
        while not all((tmp_path / f"{name}.ready").is_file() for name in ("north", "south")):
            if time.monotonic() >= deadline:
                pytest.fail("contenders did not become ready")
            time.sleep(0.01)
        start_path.write_text("start", encoding="ascii")

        outcomes: list[dict[str, str]] | None = None
        while time.monotonic() < deadline:
            result_paths = [tmp_path / f"{name}.result" for name in ("north", "south")]
            if all(path.is_file() for path in result_paths):
                try:
                    outcomes = [
                        json.loads(path.read_text(encoding="utf-8")) for path in result_paths
                    ]
                except json.JSONDecodeError:
                    outcomes = None
                if outcomes is not None:
                    break
            time.sleep(0.01)
        if outcomes is None:
            pytest.fail("contenders did not publish outcomes")

        assert sorted(outcome["outcome"] for outcome in outcomes) == ["error", "success"]
        error = next(outcome for outcome in outcomes if outcome["outcome"] == "error")
        assert error["code"] == "APPLICATION_UPDATE_IN_PROGRESS"
        success = next(outcome for outcome in outcomes if outcome["outcome"] == "success")
        metadata = json.loads(
            (install_root / ".palserver-console-update.lock").read_text(encoding="utf-8")
        )
        assert metadata["lockId"] == success["lockId"]
    finally:
        release_path.write_text("release", encoding="ascii")
        for process in contenders:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def test_application_update_check_uses_fixed_release_asset() -> None:
    release: dict[str, object] = {
        "tag_name": "v0.2.0",
        "html_url": "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.2.0",
        "published_at": "2026-08-27T00:00:00Z",
        "assets": [
            {
                "name": "PalServerConsole-0.2.0-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": 123,
            }
        ],
    }
    service = ApplicationUpdateService(
        "0.1.1",
        Path("unused"),
        client_factory=_client_factory(release, b""),
    )

    status = service.check()

    assert status["currentVersion"] == "0.1.1"
    assert status["latestVersion"] == "0.2.0"
    assert status["updateAvailable"] is True
    assert status["portable"] is False
    assert status["assetUrl"] == "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip"


def test_application_update_requests_graceful_shutdown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = threading.Event()
    service = ApplicationUpdateService("0.1.1", Path("unused"))
    service.bind_shutdown_requester(requested.set)
    monkeypatch.setattr(time, "sleep", lambda _: None)

    service.schedule_shutdown()

    assert requested.wait(timeout=1.0)


def test_application_update_prepares_package_and_starts_external_helper(
    tmp_path: Path,
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "html_url": "https://github.com/yxymeng/PalserverConsole/releases/tag/v0.2.0",
        "published_at": "2026-08-27T00:00:00Z",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    data_directory = tmp_path / "data" / "instances" / "north"
    calls: list[tuple[list[str], dict[str, object]]] = []

    def runner(command: list[str], **kwargs: object) -> _FakeHelperProcess:
        calls.append((command, kwargs))
        metadata = json.loads(
            (install_root / ".palserver-console-update.lock").read_text(encoding="utf-8-sig")
        )
        metadata.update(
            {
                "pid": os.getpid(),
                "processStartedAt": psutil.Process(os.getpid()).create_time(),
                "phase": "helper",
            }
        )
        (install_root / ".palserver-console-update.lock").write_text(
            json.dumps(metadata), encoding="utf-8"
        )
        return _FakeHelperProcess()

    service = ApplicationUpdateService(
        "0.1.1",
        data_directory,
        client_factory=_client_factory(release, package),
        install_root=install_root,
        instance_id="north",
        port=18224,
        process_runner=cast(Any, runner),
    )
    _enable_graceful_shutdown(service)

    result = service.prepare(version)

    assert result == {
        "message": "更新包已校验，控制台将退出并完成升级。",
        "version": version,
        "restartScheduled": True,
    }
    package_root = (
        data_directory / "application-updates" / f"PalServerConsole-{version}-windows-x64"
    )
    assert (package_root / "Program" / "PalServerConsole.exe").is_file()
    assert len(calls) == 1
    command = calls[0][0]
    assert command[command.index("-DataDirectory") + 1] == str(data_directory)
    assert command[command.index("-UpdateLockId") + 1]
    assert command[command.index("-InstanceId") + 1] == "north"
    assert command[command.index("-Port") + 1] == "18224"
    lock_metadata = json.loads(
        (install_root / ".palserver-console-update.lock").read_text(encoding="utf-8")
    )
    assert lock_metadata["phase"] == "helper"
    assert lock_metadata["lockId"] == command[command.index("-UpdateLockId") + 1]
    assert lock_metadata["processStartedAt"] > 0


def test_application_update_requires_graceful_shutdown_before_starting_helper(
    tmp_path: Path,
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    calls: list[list[str]] = []

    def runner(command: list[str], **kwargs: object) -> Any:
        calls.append(command)
        return object()

    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=runner,
    )
    lock_path = install_root / ".palserver-console-update.lock"

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare(version)

    assert raised.value.code == "APPLICATION_SHUTDOWN_UNAVAILABLE"
    assert calls == []
    assert not lock_path.exists()


def test_application_update_rejects_overlapping_install_root(tmp_path: Path) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")

    runner = _handoff_runner(install_root / ".palserver-console-update.lock")

    first = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data" / "instances" / "north",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        instance_id="north",
        process_runner=runner,
    )
    _enable_graceful_shutdown(first)
    second = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data" / "instances" / "south",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        instance_id="south",
        process_runner=runner,
    )

    first.prepare(version)

    with pytest.raises(ApplicationUpdateError) as raised:
        second.prepare(version)

    assert raised.value.code == "APPLICATION_UPDATE_IN_PROGRESS"
    assert (install_root / ".palserver-console-update.lock").is_file()


@pytest.mark.parametrize("failure", ["download", "validation", "helper", "runner"])
def test_application_update_prepare_failure_releases_install_root_lock(
    tmp_path: Path, failure: str
) -> None:
    version = "0.2.0"
    package = _release_zip("0.1.1" if failure == "validation" else version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    if failure != "helper":
        (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")

    if failure == "download":
        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == RELEASE_API_URL:
                return httpx.Response(200, json=release, request=request)
            return httpx.Response(503, request=request)

        def failing_download_client_factory() -> httpx.Client:
            return httpx.Client(transport=httpx.MockTransport(handler))

        client_factory = failing_download_client_factory
    else:
        client_factory = _client_factory(release, package)

    def runner(command: list[str], **kwargs: object) -> Any:
        if failure == "runner":
            raise OSError("process runner failed")
        return object()

    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data" / "instances" / "north",
        client_factory=client_factory,
        install_root=install_root,
        process_runner=runner,
    )
    _enable_graceful_shutdown(service)
    lock_path = install_root / ".palserver-console-update.lock"

    with pytest.raises((ApplicationUpdateError, OSError)):
        service.prepare(version)
    assert not lock_path.exists()

    with pytest.raises((ApplicationUpdateError, OSError)) as retried:
        service.prepare(version)

    assert not (
        isinstance(retried.value, ApplicationUpdateError)
        and retried.value.code == "APPLICATION_UPDATE_IN_PROGRESS"
    )
    assert not lock_path.exists()


def test_application_update_rejects_other_instance_from_same_install_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    calls: list[list[str]] = []
    peer = type(
        "PeerProcess",
        (),
        {
            "pid": os.getpid() + 1,
            "info": {
                "exe": str(install_root / "Program" / "PalServerConsole.exe"),
                "cmdline": [str(install_root / "Program" / "PalServerConsole.exe")],
            },
        },
    )()
    monkeypatch.setattr(psutil, "process_iter", lambda attrs: [peer])

    def runner(command: list[str], **kwargs: object) -> Any:
        calls.append(command)
        return object()

    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data" / "instances" / "north",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=runner,
    )

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare(version)

    assert raised.value.code == "APPLICATION_UPDATE_INSTANCES_RUNNING"
    assert calls == []
    assert not (install_root / ".palserver-console-update.lock").exists()


def test_application_update_allows_other_install_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    peer = type(
        "PeerProcess",
        (),
        {
            "pid": os.getpid() + 1,
            "info": {
                "exe": str(tmp_path / "other-install" / "Program" / "PalServerConsole.exe")
            },
        },
    )()
    monkeypatch.setattr(psutil, "process_iter", lambda attrs: [peer])

    runner = _handoff_runner(install_root / ".palserver-console-update.lock")

    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=runner,
    )
    _enable_graceful_shutdown(service)

    assert service.prepare(version)["restartScheduled"] is True


def test_application_update_ignores_same_install_world_worker(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": f"https://github.com/yxymeng/PalserverConsole/releases/download/v{version}/PalServerConsole-{version}-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    program = install_root / "Program" / "PalServerConsole.exe"
    peer = type(
        "WorldWorkerProcess",
        (),
        {
            "pid": os.getpid() + 1,
            "info": {"exe": str(program), "cmdline": [str(program), "--world-worker"]},
        },
    )()
    monkeypatch.setattr(psutil, "process_iter", lambda _attrs: [peer])
    lock_path = install_root / ".palserver-console-update.lock"
    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=_handoff_runner(lock_path),
    )
    _enable_graceful_shutdown(service)

    assert service.prepare(version)["restartScheduled"] is True


@pytest.mark.parametrize("cmdline", [None, "unknown"])
def test_application_update_fail_closed_when_same_install_cmdline_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, cmdline: object
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": f"https://github.com/yxymeng/PalserverConsole/releases/download/v{version}/PalServerConsole-{version}-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    program = install_root / "Program" / "PalServerConsole.exe"
    peer = type(
        "UnknownCommandLineProcess",
        (),
        {
            "pid": os.getpid() + 1,
            "info": {"exe": str(program), "cmdline": cmdline},
        },
    )()
    monkeypatch.setattr(psutil, "process_iter", lambda _attrs: [peer])
    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=cast(Any, lambda *args, **kwargs: object()),
    )
    _enable_graceful_shutdown(service)

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare(version)

    assert raised.value.code == "APPLICATION_UPDATE_INSTANCES_RUNNING"


def test_application_update_fail_closed_on_process_metadata_access_denied(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()

    class AccessDeniedProcess:
        pid = os.getpid() + 1

        @property
        def info(self) -> dict[str, object]:
            raise psutil.AccessDenied(self.pid)

    monkeypatch.setattr(psutil, "process_iter", lambda _attrs: [AccessDeniedProcess()])

    assert ApplicationUpdateService._other_install_instances_running(install_root) is True


def test_application_update_allows_own_program_and_root_launcher(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": "https://github.com/yxymeng/PalserverConsole/releases/download/v0.2.0/PalServerConsole-0.2.0-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    own_program = type(
        "OwnProgramProcess",
        (),
        {
            "pid": os.getpid(),
            "info": {"exe": str(install_root / "Program" / "PalServerConsole.exe")},
        },
    )()
    root_launcher = type(
        "RootLauncherProcess",
        (),
        {"pid": os.getpid() + 1, "info": {"exe": str(install_root / "PalServerConsole.exe")}},
    )()
    monkeypatch.setattr(
        psutil, "process_iter", lambda attrs: [own_program, root_launcher]
    )
    runner = _handoff_runner(install_root / ".palserver-console-update.lock")

    service = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=runner,
    )
    _enable_graceful_shutdown(service)

    assert service.prepare(version)["restartScheduled"] is True


def test_application_update_lock_rejects_live_owner_with_matching_start_time(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": "active",
                "pid": 4321,
                "processStartedAt": 100.0,
                "phase": "helper",
            }
        ),
        encoding="utf-8",
    )
    actual_process = psutil.Process

    def process(pid: int) -> Any:
        if pid == 4321:
            return type("Owner", (), {"create_time": lambda self: 100.0})()
        return actual_process(pid)

    monkeypatch.setattr(psutil, "Process", process)
    service = ApplicationUpdateService("0.1.1", tmp_path / "data", install_root=install_root)

    with pytest.raises(ApplicationUpdateError) as raised:
        service._acquire_update_lock()

    assert raised.value.code == "APPLICATION_UPDATE_IN_PROGRESS"
    assert json.loads(lock_path.read_text(encoding="utf-8"))["lockId"] == "active"


@pytest.mark.parametrize(
    ("owner_process", "process_started_at"),
    [("dead", 100.0), ("reused", 100.0)],
)
def test_application_update_lock_reclaims_abandoned_owner(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    owner_process: str,
    process_started_at: float,
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": "abandoned",
                "pid": 4321,
                "processStartedAt": process_started_at,
                "phase": "prepare",
            }
        ),
        encoding="utf-8",
    )
    actual_process = psutil.Process

    def process(pid: int) -> Any:
        if pid != 4321:
            return actual_process(pid)
        if owner_process == "dead":
            raise psutil.NoSuchProcess(pid)
        return type("ReusedOwner", (), {"create_time": lambda self: 101.0})()

    monkeypatch.setattr(psutil, "Process", process)
    service = ApplicationUpdateService("0.1.1", tmp_path / "data", install_root=install_root)

    reclaimed_lock, lock_id = service._acquire_update_lock()

    assert reclaimed_lock == lock_path
    assert json.loads(lock_path.read_text(encoding="utf-8"))["lockId"] == lock_id
    service._release_update_lock(lock_path)


def test_application_update_lock_publishes_complete_metadata_atomically(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    real_replace = os.replace
    publication: dict[str, object] = {}

    def inspect_replace(
        source: str | os.PathLike[str], destination: str | os.PathLike[str]
    ) -> None:
        source_path = Path(source)
        destination_path = Path(destination)
        assert source_path.parent == destination_path.parent == install_root
        assert source_path.name.startswith(".palserver-console-update.lock.tmp-")
        assert source_path.is_file()
        assert not destination_path.exists()
        metadata = json.loads(source_path.read_text(encoding="utf-8"))
        assert {
            "lockId",
            "pid",
            "processStartedAt",
            "phase",
            "instanceId",
            "createdAt",
        } <= metadata.keys()
        assert metadata["phase"] == "prepare"
        publication["metadata"] = metadata
        real_replace(source, destination)

    monkeypatch.setattr(os, "replace", inspect_replace)
    service = ApplicationUpdateService(
        "0.1.1", tmp_path / "data", install_root=install_root, instance_id="north"
    )

    published_path, lock_id = service._acquire_update_lock()

    assert published_path == lock_path
    published_metadata = cast(dict[str, object], publication["metadata"])
    assert published_metadata["lockId"] == lock_id
    assert json.loads(lock_path.read_text(encoding="utf-8"))["lockId"] == lock_id
    service._release_update_lock(lock_path)


def test_application_update_lock_write_failure_never_exposes_final_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"

    def fail_dump(_metadata: object, _stream: object) -> None:
        assert not lock_path.exists()
        raise OSError("forced metadata serialization failure")

    monkeypatch.setattr(json, "dump", fail_dump)
    service = ApplicationUpdateService("0.1.1", tmp_path / "data", install_root=install_root)

    with pytest.raises(OSError, match="forced metadata serialization failure"):
        service._acquire_update_lock()

    assert not lock_path.exists()
    assert not list(install_root.glob(".palserver-console-update.lock.tmp-*"))


def test_application_update_lock_publish_failure_cleans_temp_and_final_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"

    def fail_replace(_source: str | os.PathLike[str], _destination: str | os.PathLike[str]) -> None:
        raise OSError("forced atomic publication failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    service = ApplicationUpdateService("0.1.1", tmp_path / "data", install_root=install_root)

    with pytest.raises(OSError, match="forced atomic publication failure"):
        service._acquire_update_lock()

    assert not lock_path.exists()
    assert not list(install_root.glob(".palserver-console-update.lock.tmp-*"))


def test_portable_application_update_in_progress_ignores_missing_lock(
    tmp_path: Path,
) -> None:
    assert portable_application_update_in_progress(tmp_path / "missing-install") is False


@pytest.mark.parametrize(
    ("owner_process", "expected_in_progress"),
    [
        ("live", True),
        ("access_denied", True),
        ("dead", False),
        ("reused", False),
    ],
)
def test_portable_application_update_in_progress_reclaims_only_abandoned_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    owner_process: str,
    expected_in_progress: bool,
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": "active",
                "pid": 4321,
                "processStartedAt": 100.0,
                "phase": "helper",
            }
        ),
        encoding="utf-8",
    )
    actual_process = psutil.Process

    def process(pid: int) -> Any:
        if pid != 4321:
            return actual_process(pid)
        if owner_process == "access_denied":
            raise psutil.AccessDenied(pid)
        if owner_process == "dead":
            raise psutil.NoSuchProcess(pid)
        start_time = 100.0 if owner_process == "live" else 101.0
        return type("Owner", (), {"create_time": lambda self: start_time})()

    monkeypatch.setattr(psutil, "Process", process)

    assert portable_application_update_in_progress(install_root) is expected_in_progress
    assert lock_path.exists() is expected_in_progress


@pytest.mark.parametrize(
    ("owner_process", "expected_in_progress"),
    [
        ("live", True),
        ("dead", False),
        ("reused", False),
    ],
)
def test_portable_application_update_in_progress_handles_bom_lock(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    owner_process: str,
    expected_in_progress: bool,
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    _write_update_lock(
        lock_path,
        {
            "lockId": "active",
            "pid": 4321,
            "processStartedAt": 100.0,
            "phase": "helper",
        },
        bom=True,
    )
    actual_process = psutil.Process

    def process(pid: int) -> Any:
        if pid != 4321:
            return actual_process(pid)
        if owner_process == "dead":
            raise psutil.NoSuchProcess(pid)
        start_time = 100.0 if owner_process == "live" else 101.0
        return type("Owner", (), {"create_time": lambda self: start_time})()

    monkeypatch.setattr(psutil, "Process", process)

    assert portable_application_update_in_progress(install_root) is expected_in_progress
    assert lock_path.exists() is expected_in_progress


def test_portable_application_update_in_progress_blocks_malformed_lock(
    tmp_path: Path,
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text("not-json", encoding="utf-8")

    assert portable_application_update_in_progress(install_root) is True
    assert lock_path.is_file()


def test_portable_application_update_in_progress_keeps_incomplete_lock(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps({"pid": 4321, "processStartedAt": 100.0, "phase": "helper"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        psutil,
        "Process",
        lambda _pid: pytest.fail("incomplete lock must not be reclaimed"),
    )

    assert portable_application_update_in_progress(install_root) is True
    assert lock_path.is_file()


def test_concurrent_reclaimers_leave_only_one_active_update_owner(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    install_root = tmp_path / "install"
    install_root.mkdir()
    lock_path = install_root / ".palserver-console-update.lock"
    lock_path.write_text(
        json.dumps(
            {
                "lockId": "abandoned",
                "pid": 4321,
                "processStartedAt": 100.0,
                "phase": "prepare",
            }
        ),
        encoding="utf-8",
    )
    actual_process = psutil.Process

    def process(pid: int) -> Any:
        if pid == 4321:
            raise psutil.NoSuchProcess(pid)
        return actual_process(pid)

    monkeypatch.setattr(psutil, "Process", process)
    barrier = threading.Barrier(2)
    outcomes: list[tuple[str, str]] = []
    outcome_lock = threading.Lock()

    def contend(instance_id: str) -> None:
        barrier.wait()
        service = ApplicationUpdateService(
            "0.1.1", tmp_path / "data" / instance_id, install_root=install_root
        )
        try:
            _, lock_id = service._acquire_update_lock()
            outcome = ("success", lock_id)
        except ApplicationUpdateError as error:
            outcome = ("error", error.code)
        with outcome_lock:
            outcomes.append(outcome)

    threads = [
        threading.Thread(target=contend, args=("north",)),
        threading.Thread(target=contend, args=("south",)),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)
    assert all(not thread.is_alive() for thread in threads)
    assert sorted(outcome[0] for outcome in outcomes) == ["error", "success"]
    assert next(outcome[1] for outcome in outcomes if outcome[0] == "error") == (
        "APPLICATION_UPDATE_IN_PROGRESS"
    )
    metadata = json.loads(lock_path.read_text(encoding="utf-8"))
    assert metadata["lockId"] == next(
        outcome[1] for outcome in outcomes if outcome[0] == "success"
    )
    ApplicationUpdateService._release_update_lock(lock_path)


def _handoff_service_fixture(
    tmp_path: Path,
    runner: Any,
    *,
    timeout: float = 10.0,
) -> tuple[ApplicationUpdateService, Path, Path, threading.Event]:
    version = "0.2.0"
    package = _release_zip(version)
    release: dict[str, object] = {
        "tag_name": f"v{version}",
        "assets": [
            {
                "name": f"PalServerConsole-{version}-windows-x64.zip",
                "browser_download_url": f"https://github.com/yxymeng/PalserverConsole/releases/download/v{version}/PalServerConsole-{version}-windows-x64.zip",
                "size": len(package),
            }
        ],
    }
    install_root = tmp_path / "install"
    install_root.mkdir()
    (install_root / "apply-downloaded-update.ps1").write_text("fixture", encoding="utf-8")
    data_directory = tmp_path / "data"
    requested = threading.Event()
    service = ApplicationUpdateService(
        "0.1.1",
        data_directory,
        client_factory=_client_factory(release, package),
        install_root=install_root,
        process_runner=runner,
        helper_handoff_timeout_seconds=timeout,
    )
    service.bind_shutdown_requester(requested.set)
    return service, install_root, data_directory, requested


def test_application_update_confirms_helper_handoff_before_shutdown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"
    service, install_root, _, requested = _handoff_service_fixture(
        tmp_path, _handoff_runner(lock_path)
    )

    result = service.prepare("0.2.0")
    assert result["restartScheduled"] is True
    metadata = json.loads(lock_path.read_text(encoding="utf-8"))
    assert metadata["phase"] == "helper"
    assert metadata["pid"] == os.getpid()
    assert math.isclose(
        float(metadata["processStartedAt"]), psutil.Process(os.getpid()).create_time(), abs_tol=0.01
    )
    monkeypatch.setattr(time, "sleep", lambda _: None)
    service.schedule_shutdown()
    assert requested.wait(timeout=1.0)
    assert install_root.is_dir()


def test_application_update_handoff_timeout_terminates_helper_and_releases_lock(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess()
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"

    def runner(*args: Any, **kwargs: Any) -> _FakeHelperProcess:
        return helper

    service, _, _, requested = _handoff_service_fixture(tmp_path, runner, timeout=0.01)

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_TIMEOUT"
    assert helper.terminated is True
    assert not lock_path.exists()
    assert not requested.is_set()


def test_application_update_handoff_termination_exception_keeps_lock(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess(terminate_error=True)
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"
    service, _, _, requested = _handoff_service_fixture(
        tmp_path,
        lambda *args, **kwargs: helper,
        timeout=0.01,
    )

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_TIMEOUT"
    assert helper.terminated is True
    assert lock_path.exists()
    assert not requested.is_set()


def test_application_update_handoff_kills_helper_after_terminate_timeout(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess(terminate_exits=False, wait_timeout=True)
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"
    service, _, _, requested = _handoff_service_fixture(
        tmp_path,
        lambda *args, **kwargs: helper,
        timeout=0.01,
    )

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_TIMEOUT"
    assert helper.killed is True
    assert not lock_path.exists()
    assert not requested.is_set()


def test_application_update_handoff_keeps_lock_when_kill_fails(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess(
        terminate_exits=False,
        wait_timeout=True,
        kill_error=True,
    )
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"
    service, _, _, requested = _handoff_service_fixture(
        tmp_path,
        lambda *args, **kwargs: helper,
        timeout=0.01,
    )

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_TIMEOUT"
    assert helper.killed is True
    assert lock_path.exists()
    assert not requested.is_set()


def test_application_update_handoff_early_exit_does_not_shutdown(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess(returncode=1)
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"
    service, _, _, requested = _handoff_service_fixture(
        tmp_path,
        lambda *args, **kwargs: helper,
        timeout=1.0,
    )

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_FAILED"
    assert not lock_path.exists()
    assert not requested.is_set()


def test_application_update_handoff_wrong_lock_id_is_not_deleted(
    tmp_path: Path,
) -> None:
    helper = _FakeHelperProcess()
    lock_path = tmp_path / "install" / ".palserver-console-update.lock"

    def runner(*args: Any, **kwargs: Any) -> _FakeHelperProcess:
        metadata = json.loads(lock_path.read_text(encoding="utf-8"))
        metadata.update(
            {
                "lockId": "wrong-lock-id",
                "pid": helper.pid,
                "processStartedAt": psutil.Process(helper.pid).create_time(),
                "phase": "helper",
            }
        )
        lock_path.write_text(json.dumps(metadata), encoding="utf-8")
        return helper

    service, _, _, requested = _handoff_service_fixture(tmp_path, runner)

    with pytest.raises(ApplicationUpdateError) as raised:
        service.prepare("0.2.0")

    assert raised.value.code == "APPLICATION_UPDATE_HANDOFF_FAILED"
    assert json.loads(lock_path.read_text(encoding="utf-8"))["lockId"] == "wrong-lock-id"
    assert helper.terminated is True
    assert not requested.is_set()
