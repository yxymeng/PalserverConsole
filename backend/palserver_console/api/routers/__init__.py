from .audit import router as audit_router
from .auth import router as auth_router
from .backups import router as backups_router
from .config import router as config_router
from .live import router as live_router
from .server import router as server_router
from .system import router as system_router
from .world import router as world_router

__all__ = [
    "audit_router",
    "auth_router",
    "backups_router",
    "config_router",
    "live_router",
    "server_router",
    "system_router",
    "world_router",
]
