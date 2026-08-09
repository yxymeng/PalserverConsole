from __future__ import annotations

import threading
from types import TracebackType
from typing import Protocol


class ControlLock(Protocol):
    def __enter__(self) -> bool: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


def create_control_lock() -> ControlLock:
    """Return the reentrant lock shared by all PalServer-affecting actions."""

    return threading.RLock()
