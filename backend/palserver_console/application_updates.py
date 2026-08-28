from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import psutil

RELEASE_API_URL = "https://api.github.com/repos/yxymeng/PalserverConsole/releases/latest"
MAX_RELEASE_BYTES = 500 * 1024 * 1024


class ApplicationUpdateError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ApplicationUpdateService:
    def __init__(
        self,
        current_version: str,
        data_dir: Path,
        *,
        client_factory: Callable[[], httpx.Client] | None = None,
        install_root: Path | None = None,
        instance_id: str = "default",
        port: int = 8223,
        process_runner: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self.current_version = current_version
        self.data_dir = data_dir
        self.client_factory = client_factory or self._default_client
        self.install_root = install_root or _portable_install_root()
        self.instance_id = instance_id
        self.port = port
        self.process_runner = process_runner
        self._shutdown_requester: Callable[[], None] | None = None

    def check(self) -> dict[str, object]:
        try:
            with self.client_factory() as client:
                response = client.get(RELEASE_API_URL)
                response.raise_for_status()
                release = response.json()
        except (httpx.HTTPError, json.JSONDecodeError, ValueError) as error:
            raise ApplicationUpdateError(
                "RELEASE_CHECK_FAILED",
                f"GitHub Release check failed: {type(error).__name__}: {error}",
            ) from error
        return self._release_status(release)

    def prepare(self, expected_version: str) -> dict[str, object]:
        install_root = self.install_root
        if install_root is None:
            raise ApplicationUpdateError(
                "PORTABLE_REQUIRED",
                "Automatic installation is only available in the Windows portable package.",
            )
        lock_path, update_lock_id = self._acquire_update_lock()
        helper_started = False
        try:
            if self._other_install_instances_running(install_root):
                raise ApplicationUpdateError(
                    "APPLICATION_UPDATE_INSTANCES_RUNNING",
                    "Another PalServerConsole instance from this portable installation "
                    "is still running.",
                )
            status = self.check()
            latest = str(status["latestVersion"])
            if expected_version != latest or not status["updateAvailable"]:
                raise ApplicationUpdateError(
                    "RELEASE_CHANGED",
                    "GitHub Release changed or no newer version is currently available.",
                )
            asset_url = status.get("assetUrl")
            if not isinstance(asset_url, str) or not asset_url:
                raise ApplicationUpdateError(
                    "RELEASE_ASSET_MISSING",
                    f"Release asset PalServerConsole-{latest}-windows-x64.zip is missing.",
                )

            update_root = self.data_dir / "application-updates"
            update_root.mkdir(parents=True, exist_ok=True)
            download_path = update_root / f"PalServerConsole-{latest}-windows-x64.zip"
            staging_root = update_root / f".staging-{uuid.uuid4().hex}"
            package_root = update_root / f"PalServerConsole-{latest}-windows-x64"
            if package_root.exists():
                shutil.rmtree(package_root)
            try:
                self._download(asset_url, download_path)
                staging_root.mkdir()
                _extract_release(download_path, staging_root)
                _validate_release_root(staging_root, latest)
                staging_root.replace(package_root)
            except Exception:
                shutil.rmtree(staging_root, ignore_errors=True)
                raise
            helper = install_root / "apply-downloaded-update.ps1"
            powershell = (
                Path(os.environ.get("SYSTEMROOT", r"C:\Windows"))
                / "System32"
                / "WindowsPowerShell"
                / "v1.0"
                / "powershell.exe"
            )
            if not helper.is_file() or not powershell.is_file():
                raise ApplicationUpdateError(
                    "UPDATE_HELPER_MISSING",
                    "Portable update helper or Windows PowerShell 5.1 is missing.",
                )
            if self._shutdown_requester is None:
                raise ApplicationUpdateError(
                    "APPLICATION_SHUTDOWN_UNAVAILABLE",
                    "Graceful application shutdown is unavailable.",
                )
            self.process_runner(
                [
                    str(powershell),
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(helper),
                    "-WaitPid",
                    str(os.getpid()),
                    "-InstallRoot",
                    str(install_root),
                    "-UpdateLockId",
                    update_lock_id,
                    "-DataDirectory",
                    str(self.data_dir),
                    "-NewPackage",
                    str(package_root),
                    "-InstanceId",
                    self.instance_id,
                    "-Port",
                    str(self.port),
                ],
                cwd=str(install_root),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            helper_started = True
            return {
                "message": "更新包已校验，控制台将退出并完成升级。",
                "version": latest,
                "restartScheduled": True,
            }
        except Exception:
            if not helper_started:
                self._release_update_lock(lock_path)
            raise

    def bind_shutdown_requester(self, requester: Callable[[], None]) -> None:
        self._shutdown_requester = requester

    def schedule_shutdown(self) -> None:
        requester = self._shutdown_requester
        if requester is None:
            raise RuntimeError("Graceful application shutdown is unavailable.")

        def shutdown() -> None:
            time.sleep(1.0)
            requester()

        threading.Thread(target=shutdown, name="application-update-shutdown", daemon=True).start()

    def _acquire_update_lock(self) -> tuple[Path, str]:
        if self.install_root is None:
            raise ApplicationUpdateError(
                "PORTABLE_REQUIRED",
                "Automatic installation is only available in the Windows portable package.",
            )
        lock_path = self.install_root / ".palserver-console-update.lock"
        for attempt in range(2):
            lock_id = str(uuid.uuid4())
            try:
                descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError as error:
                if attempt == 0 and self._reclaim_abandoned_update_lock(lock_path):
                    continue
                raise ApplicationUpdateError(
                    "APPLICATION_UPDATE_IN_PROGRESS",
                    "Another application update is already in progress.",
                ) from error
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                    json.dump(
                        {
                            "lockId": lock_id,
                            "pid": os.getpid(),
                            "processStartedAt": psutil.Process(os.getpid()).create_time(),
                            "phase": "prepare",
                            "instanceId": self.instance_id,
                            "createdAt": int(time.time()),
                        },
                        stream,
                    )
            except Exception:
                self._release_update_lock(lock_path)
                raise
            return lock_path, lock_id
        raise AssertionError("update lock acquisition retry was exhausted")

    @staticmethod
    def _reclaim_abandoned_update_lock(lock_path: Path) -> bool:
        try:
            metadata = json.loads(lock_path.read_text(encoding="utf-8-sig"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            return False
        if not isinstance(metadata, dict):
            return False
        lock_id = metadata.get("lockId")
        phase = metadata.get("phase")
        pid = metadata.get("pid")
        process_started_at = metadata.get("processStartedAt")
        if not isinstance(lock_id, str) or not lock_id:
            return False
        if not isinstance(phase, str) or not phase:
            return False
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            return False
        try:
            process = psutil.Process(pid)
        except psutil.NoSuchProcess:
            ApplicationUpdateService._release_update_lock(lock_path)
            return True
        except psutil.AccessDenied:
            return False
        if (
            isinstance(process_started_at, bool)
            or not isinstance(process_started_at, int | float)
            or not math.isfinite(float(process_started_at))
        ):
            return False
        try:
            owner_is_current = math.isclose(
                process.create_time(), float(process_started_at), abs_tol=0.01
            )
        except psutil.NoSuchProcess:
            ApplicationUpdateService._release_update_lock(lock_path)
            return True
        except psutil.AccessDenied:
            return False
        if owner_is_current:
            return False
        ApplicationUpdateService._release_update_lock(lock_path)
        return True

    @staticmethod
    def _other_install_instances_running(install_root: Path) -> bool:
        program_path = os.path.normcase(
            os.path.abspath(install_root / "Program" / "PalServerConsole.exe")
        )
        try:
            processes = psutil.process_iter(["pid", "exe", "cmdline"])
        except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
            return True
        for process in processes:
            try:
                info = process.info
                pid = int(info.get("pid", process.pid))
                if pid <= 0 or pid == os.getpid():
                    continue
                executable = info.get("exe")
                if isinstance(executable, str):
                    if os.path.normcase(os.path.abspath(executable)) != program_path:
                        continue
                    cmdline = _normalized_process_cmdline(info.get("cmdline"))
                    if cmdline is None:
                        return True
                else:
                    cmdline = _normalized_process_cmdline(info.get("cmdline"))
                    if cmdline is None:
                        return True
                    commandline_paths = {
                        os.path.normcase(os.path.abspath(argument))
                        for argument in cmdline
                        if os.path.splitext(argument)[1].casefold() == ".exe"
                    }
                    if program_path not in commandline_paths:
                        continue
                if any(argument.casefold() == "--world-worker" for argument in cmdline):
                    continue
                return True
            except psutil.NoSuchProcess:
                # A process that disappeared during inspection is not a live peer.
                continue
            except (psutil.AccessDenied, OSError, TypeError, ValueError):
                # Fail closed when process metadata cannot be classified reliably.
                return True
        return False

    @staticmethod
    def _release_update_lock(lock_path: Path) -> None:
        with suppress(FileNotFoundError):
            lock_path.unlink()

    def _release_status(self, release: object) -> dict[str, object]:
        if not isinstance(release, dict):
            raise ApplicationUpdateError(
                "RELEASE_RESPONSE_INVALID", "GitHub Release response is not an object."
            )
        latest = _version(str(release.get("tag_name", "")))
        current = _version(self.current_version)
        asset_name = f"PalServerConsole-{latest}-windows-x64.zip"
        assets = release.get("assets")
        if not isinstance(assets, list):
            raise ApplicationUpdateError(
                "RELEASE_RESPONSE_INVALID", "GitHub Release assets are not a list."
            )
        asset = next(
            (
                item
                for item in assets
                if isinstance(item, dict) and item.get("name") == asset_name
            ),
            None,
        )
        asset_url = asset.get("browser_download_url") if isinstance(asset, dict) else None
        if asset_url is not None and not _valid_release_asset_url(asset_url, latest):
            raise ApplicationUpdateError(
                "RELEASE_RESPONSE_INVALID",
                "GitHub Release asset URL is outside the fixed project repository.",
            )
        return {
            "currentVersion": self.current_version,
            "latestVersion": latest,
            "updateAvailable": _version_tuple(latest) > _version_tuple(current),
            "portable": self.install_root is not None,
            "releaseUrl": release.get("html_url"),
            "publishedAt": release.get("published_at"),
            "assetSizeBytes": asset.get("size") if isinstance(asset, dict) else None,
            "assetUrl": asset_url,
        }

    def _download(self, url: str, output: Path) -> None:
        temporary = output.with_suffix(".download")
        temporary.unlink(missing_ok=True)
        try:
            with self.client_factory() as client, client.stream("GET", url) as response:
                response.raise_for_status()
                declared = int(response.headers.get("content-length", "0") or 0)
                if declared > MAX_RELEASE_BYTES:
                    raise ApplicationUpdateError(
                        "RELEASE_ASSET_TOO_LARGE", "Release asset exceeds the 500 MiB limit."
                    )
                written = 0
                with temporary.open("wb") as target:
                    for chunk in response.iter_bytes():
                        written += len(chunk)
                        if written > MAX_RELEASE_BYTES:
                            raise ApplicationUpdateError(
                                "RELEASE_ASSET_TOO_LARGE",
                                "Release asset exceeds the 500 MiB limit.",
                            )
                        target.write(chunk)
            temporary.replace(output)
        except httpx.HTTPError as error:
            raise ApplicationUpdateError(
                "RELEASE_DOWNLOAD_FAILED",
                f"GitHub Release download failed: {type(error).__name__}: {error}",
            ) from error
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _default_client() -> httpx.Client:
        return httpx.Client(
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "PalServerConsole-update-check",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )


def _version(value: str) -> str:
    normalized = value.removeprefix("v")
    _version_tuple(normalized)
    return normalized


def _version_tuple(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if len(parts) != 3 or any(not part.isdecimal() for part in parts):
        raise ApplicationUpdateError(
            "RELEASE_VERSION_INVALID", f"Unsupported release version: {value or '<empty>'}"
        )
    return tuple(int(part) for part in parts)  # type: ignore[return-value]


def _portable_install_root() -> Path | None:
    if not getattr(sys, "frozen", False):
        return None
    program = Path(sys.executable).resolve().parent
    root = program.parent
    return root if program.name.casefold() == "program" else None


def _normalized_process_cmdline(value: object) -> tuple[str, ...] | None:
    if not isinstance(value, list | tuple) or not value or any(
        not isinstance(argument, str) for argument in value
    ):
        return None
    return tuple(value)


def portable_application_update_in_progress(install_root: Path) -> bool:
    lock_path = install_root / ".palserver-console-update.lock"
    for _ in range(2):
        if not lock_path.is_file():
            return False
        if ApplicationUpdateService._reclaim_abandoned_update_lock(lock_path):
            continue
        if not lock_path.is_file():
            continue
        return True
    return lock_path.is_file()


def _valid_release_asset_url(value: object, version: str) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value)
    expected = (
        f"/yxymeng/PalserverConsole/releases/download/v{version}/"
        f"PalServerConsole-{version}-windows-x64.zip"
    )
    return (
        parsed.scheme == "https"
        and parsed.netloc.casefold() == "github.com"
        and parsed.path == expected
        and not parsed.query
        and not parsed.fragment
    )


def _extract_release(source: Path, destination: Path) -> None:
    try:
        with zipfile.ZipFile(source) as archive:
            for entry in archive.infolist():
                target = (destination / entry.filename).resolve()
                try:
                    target.relative_to(destination.resolve())
                except ValueError as error:
                    raise ApplicationUpdateError(
                        "RELEASE_ARCHIVE_INVALID", "Release archive contains an unsafe path."
                    ) from error
            archive.extractall(destination)
    except (OSError, zipfile.BadZipFile) as error:
        raise ApplicationUpdateError(
            "RELEASE_ARCHIVE_INVALID",
            f"Release archive could not be extracted: {type(error).__name__}: {error}",
        ) from error


def _validate_release_root(root: Path, version: str) -> None:
    required = (
        root / "PalServerConsole.exe",
        root / "Program" / "PalServerConsole.exe",
        root / "metadata" / "build-info.json",
        root / "checksums.sha256",
        root / "apply-downloaded-update.ps1",
        root / "upgrade-portable.ps1",
    )
    if any(not path.is_file() for path in required):
        raise ApplicationUpdateError(
            "RELEASE_PACKAGE_INVALID", "Release package is missing required portable files."
        )
    try:
        metadata = json.loads(required[2].read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ApplicationUpdateError(
            "RELEASE_PACKAGE_INVALID", "Release build metadata is unreadable."
        ) from error
    if not isinstance(metadata, dict) or metadata.get("version") != version:
        raise ApplicationUpdateError(
            "RELEASE_PACKAGE_INVALID", "Release build metadata version does not match."
        )
