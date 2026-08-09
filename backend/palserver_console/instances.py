from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import TypedDict

from .control import ControlLock, create_control_lock
from .steam import assert_no_reparse_points

INSTANCE_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
_SERVER_PORT_PATTERN = re.compile(
    r"(?i)(?<!\S)-(?P<name>port|queryport)(?:\s*=\s*|\s+)(?P<value>\S+)"
)
_DEFAULT_SERVER_PORTS = {"port": 8211, "queryport": 27015}


class InstanceTargetError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _TargetClaim(TypedDict):
    executablePath: str
    worldPath: str
    ports: list[int]


def validate_instance_id(value: str) -> str:
    if not INSTANCE_ID_PATTERN.fullmatch(value):
        raise ValueError(
            "PALSERVER_CONSOLE_INSTANCE must contain 1-64 letters, digits, '-' or '_', "
            "and must not start with punctuation."
        )
    return value


def server_ports_from_arguments(arguments: str) -> tuple[int, ...]:
    """Read PalServer game/query ports, treating omitted values as official defaults."""

    ports = dict(_DEFAULT_SERVER_PORTS)
    for match in _SERVER_PORT_PATTERN.finditer(arguments):
        raw = match.group("value").strip('"\'')
        try:
            port = int(raw)
        except ValueError as error:
            raise InstanceTargetError(
                "INSTANCE_PORT_INVALID", f"-{match.group('name')} must be an integer."
            ) from error
        if not 1 <= port <= 65535:
            raise InstanceTargetError(
                "INSTANCE_PORT_INVALID", f"-{match.group('name')} must be between 1 and 65535."
            )
        ports[match.group("name").casefold()] = port
    values = tuple(ports[name] for name in sorted(ports))
    if len(set(values)) != len(values):
        raise InstanceTargetError(
            "INSTANCE_PORT_INVALID", "PalServer game and query ports must be different."
        )
    return values


class InstanceTargetRegistry:
    """Keep managed PalServer write targets exclusive across console instances."""

    def __init__(self, instance_root: Path) -> None:
        self.instance_root = instance_root
        self.registry_path = instance_root / "instances" / "targets.json"
        self._lock: ControlLock = create_control_lock(
            instance_root / "instances" / "targets.lock"
        )

    def claim(
        self,
        instance_id: str,
        executable_path: Path,
        world_path: Path,
        ports: tuple[int, ...] = (),
    ) -> None:
        owner = validate_instance_id(instance_id).casefold()
        executable = self._normalise_target(executable_path)
        world = self._normalise_target(world_path)
        claimed_ports = self._normalise_ports(ports)
        with self._lock:
            claims = self._read_claims()
            self._claim_locked(claims, owner, executable, world, claimed_ports)

    def ensure_owned(
        self,
        instance_id: str,
        executable_path: Path,
        world_path: Path,
        ports: tuple[int, ...] = (),
    ) -> None:
        owner = validate_instance_id(instance_id).casefold()
        executable = self._normalise_target(executable_path)
        world = self._normalise_target(world_path)
        claimed_ports = self._normalise_ports(ports)
        with self._lock:
            claims = self._read_claims()
            claim = claims.get(owner)
            if claim is None:
                self._claim_locked(claims, owner, executable, world, claimed_ports)
                return
            if not (
                self._same_path(Path(claim["executablePath"]), executable)
                and self._same_path(Path(claim["worldPath"]), world)
            ):
                raise InstanceTargetError(
                    "INSTANCE_TARGET_NOT_OWNED",
                    "The saved server profile no longer belongs to this console instance.",
                )
            self._claim_locked(claims, owner, executable, world, claimed_ports)

    def release(self, instance_id: str) -> None:
        owner = validate_instance_id(instance_id).casefold()
        with self._lock:
            claims = self._read_claims()
            if owner in claims:
                del claims[owner]
                self._write_claims(claims)

    def _claim_locked(
        self,
        claims: dict[str, _TargetClaim],
        owner: str,
        executable: Path,
        world: Path,
        ports: tuple[int, ...],
    ) -> None:
        for claimed_owner, claim in claims.items():
            if claimed_owner == owner:
                continue
            if (
                self._same_path(Path(claim["executablePath"]), executable)
                or self._same_path(Path(claim["worldPath"]), world)
            ):
                raise InstanceTargetError(
                    "INSTANCE_TARGET_CONFLICT",
                    "The PalServer executable or World path is already owned by another "
                    "console instance.",
                )
            if ports and set(claim["ports"]).intersection(ports):
                raise InstanceTargetError(
                    "INSTANCE_PORT_CONFLICT",
                    "A PalServer game or query port is already owned by another console instance.",
                )
        claims[owner] = {
            "executablePath": str(executable),
            "worldPath": str(world),
            "ports": list(ports),
        }
        self._write_claims(claims)

    def _read_claims(self) -> dict[str, _TargetClaim]:
        try:
            assert_no_reparse_points(self.registry_path)
        except ValueError as error:
            raise InstanceTargetError("PATH_REPARSE_POINT", str(error)) from error
        if not self.registry_path.exists():
            return {}
        try:
            raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise InstanceTargetError(
                "INSTANCE_REGISTRY_INVALID", f"{type(error).__name__}: {error}"
            ) from error
        if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(
            raw.get("claims"), dict
        ):
            raise InstanceTargetError(
                "INSTANCE_REGISTRY_INVALID", "The instance target registry has an invalid shape."
            )
        claims: dict[str, _TargetClaim] = {}
        for owner, claim in raw["claims"].items():
            raw_ports = claim.get("ports", []) if isinstance(claim, dict) else None
            if (
                not isinstance(owner, str)
                or not isinstance(claim, dict)
                or not isinstance(claim.get("executablePath"), str)
                or not isinstance(claim.get("worldPath"), str)
                or not isinstance(raw_ports, list)
                or not all(
                    isinstance(port, int) and 1 <= port <= 65535 for port in raw_ports
                )
                or len(set(raw_ports)) != len(raw_ports)
            ):
                raise InstanceTargetError(
                    "INSTANCE_REGISTRY_INVALID",
                    "The instance target registry contains an invalid claim.",
                )
            claims[owner] = {
                "executablePath": claim["executablePath"],
                "worldPath": claim["worldPath"],
                "ports": list(raw_ports),
            }
        return claims

    def _write_claims(self, claims: dict[str, _TargetClaim]) -> None:
        directory = self.registry_path.parent
        try:
            assert_no_reparse_points(directory)
            directory.mkdir(parents=True, exist_ok=True)
            assert_no_reparse_points(directory)
            temporary = directory / f".{self.registry_path.name}.{uuid.uuid4().hex}.tmp"
            temporary.write_text(
                json.dumps({"version": 1, "claims": claims}, ensure_ascii=False, sort_keys=True),
                encoding="utf-8",
            )
            os.replace(temporary, self.registry_path)
        except ValueError as error:
            raise InstanceTargetError("PATH_REPARSE_POINT", str(error)) from error
        except OSError as error:
            raise InstanceTargetError(
                "INSTANCE_REGISTRY_WRITE_FAILED", f"{type(error).__name__}: {error}"
            ) from error

    @staticmethod
    def _normalise_target(path: Path) -> Path:
        try:
            assert_no_reparse_points(path)
            return path.resolve(strict=True)
        except ValueError as error:
            raise InstanceTargetError("PATH_REPARSE_POINT", str(error)) from error
        except (OSError, RuntimeError) as error:
            raise InstanceTargetError(
                "INSTANCE_TARGET_INVALID", f"{type(error).__name__}: {error}"
            ) from error

    @staticmethod
    def _normalise_ports(ports: tuple[int, ...]) -> tuple[int, ...]:
        if not all(isinstance(port, int) and 1 <= port <= 65535 for port in ports):
            raise InstanceTargetError(
                "INSTANCE_PORT_INVALID", "Instance ports must be integers between 1 and 65535."
            )
        if len(set(ports)) != len(ports):
            raise InstanceTargetError("INSTANCE_PORT_INVALID", "Instance ports must be unique.")
        return tuple(sorted(ports))

    @staticmethod
    def _same_path(left: Path, right: Path) -> bool:
        return os.path.normcase(str(left)) == os.path.normcase(str(right))
