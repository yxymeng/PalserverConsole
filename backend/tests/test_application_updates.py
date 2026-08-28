from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest

from palserver_console.application_updates import (
    RELEASE_API_URL,
    ApplicationUpdateError,
    ApplicationUpdateService,
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

    def runner(command: list[str], **kwargs: object) -> Any:
        calls.append((command, kwargs))
        return object()

    service = ApplicationUpdateService(
        "0.1.1",
        data_directory,
        client_factory=_client_factory(release, package),
        install_root=install_root,
        instance_id="north",
        port=18224,
        process_runner=runner,
    )

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
    assert command[command.index("-InstanceId") + 1] == "north"
    assert command[command.index("-Port") + 1] == "18224"
    assert (install_root / ".palserver-console-update.lock").is_file()


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

    def runner(command: list[str], **kwargs: object) -> Any:
        return object()

    first = ApplicationUpdateService(
        "0.1.1",
        tmp_path / "data" / "instances" / "north",
        client_factory=_client_factory(release, package),
        install_root=install_root,
        instance_id="north",
        process_runner=runner,
    )
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
