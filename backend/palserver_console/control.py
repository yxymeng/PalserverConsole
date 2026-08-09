from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, Protocol


class ControlLock(Protocol):
    def __enter__(self) -> bool: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class FileControlLock:
    """A reentrant per-data-namespace lock that also serializes other processes."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._thread_lock = threading.RLock()
        self._owner: int | None = None
        self._depth = 0
        self._handle: BinaryIO | None = None

    def __enter__(self) -> bool:
        self._thread_lock.acquire()
        owner = threading.get_ident()
        if self._owner == owner:
            self._depth += 1
            return True
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            handle = self.path.open("a+b")
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            self._lock_file(handle)
        except Exception:
            self._thread_lock.release()
            raise
        self._owner = owner
        self._depth = 1
        self._handle = handle
        return True

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._owner != threading.get_ident():
            raise RuntimeError("Control lock can only be released by its owning thread.")
        self._depth -= 1
        try:
            if self._depth == 0:
                handle = self._handle
                self._handle = None
                self._owner = None
                if handle is not None:
                    try:
                        self._unlock_file(handle)
                    finally:
                        handle.close()
        finally:
            self._thread_lock.release()

    @staticmethod
    def _lock_file(handle: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    return
                except OSError:
                    time.sleep(0.05)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)  # type: ignore[attr-defined]

    @staticmethod
    def _unlock_file(handle: BinaryIO) -> None:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)  # type: ignore[attr-defined]


def create_control_lock(path: Path | None = None) -> ControlLock:
    """Return the reentrant lock shared by all PalServer-affecting actions."""

    return threading.RLock() if path is None else FileControlLock(path)
