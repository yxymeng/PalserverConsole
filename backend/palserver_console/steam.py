from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PALSERVER_APP_ID = "2394010"
WINDOWS_REPARSE_POINT = 0x400


@dataclass(frozen=True)
class SteamCandidate:
    library_path: Path
    install_path: Path
    executable_path: Path
    manifest_path: Path
    manifest_valid: bool


class VdfParseError(ValueError):
    pass


def is_reparse_point(path: Path) -> bool:
    """Return whether a path is a symlink, junction, or Windows reparse point."""
    try:
        if path.is_symlink():
            return True
        is_junction = getattr(path, "is_junction", None)
        if callable(is_junction) and is_junction():
            return True
        attributes = int(getattr(os.lstat(path), "st_file_attributes", 0))
        return bool(attributes & WINDOWS_REPARSE_POINT)
    except OSError:
        return False


def assert_no_reparse_points(path: Path) -> None:
    """Reject a path whose existing components can redirect outside its tree."""
    candidate = path.expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    components: list[Path] = []
    current = candidate
    while True:
        components.append(current)
        if current.parent == current:
            break
        current = current.parent
    for component in reversed(components):
        if is_reparse_point(component):
            raise ValueError(f"Path contains a Windows reparse point: {component}")


def parse_vdf(text: str) -> dict[str, Any]:
    tokens: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char.isspace():
            index += 1
            continue
        if text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end + 1
            continue
        if char in "{}":
            tokens.append(char)
            index += 1
            continue
        if char != '"':
            raise VdfParseError(f"Unexpected VDF token at offset {index}.")
        index += 1
        value: list[str] = []
        while index < len(text) and text[index] != '"':
            if text[index] == "\\" and index + 1 < len(text):
                next_char = text[index + 1]
                if next_char in {'"', "\\"}:
                    value.append(next_char)
                    index += 2
                    continue
            value.append(text[index])
            index += 1
        if index >= len(text):
            raise VdfParseError("Unterminated quoted VDF string.")
        tokens.append("".join(value))
        index += 1

    def parse_object(position: int, nested: bool) -> tuple[dict[str, Any], int]:
        result: dict[str, Any] = {}
        while position < len(tokens):
            if tokens[position] == "}":
                if not nested:
                    raise VdfParseError("Unexpected closing brace in VDF.")
                return result, position + 1
            key = tokens[position]
            position += 1
            if position >= len(tokens):
                raise VdfParseError(f"Missing value for VDF key {key!r}.")
            value: Any
            if tokens[position] == "{":
                value, position = parse_object(position + 1, True)
            else:
                value = tokens[position]
                position += 1
            result[key] = value
        if nested:
            raise VdfParseError("Missing closing brace in VDF.")
        return result, position

    parsed, final = parse_object(0, False)
    if final != len(tokens):
        raise VdfParseError("Trailing VDF content.")
    return parsed


def steam_install_path_from_registry() -> Path | None:
    if os.name != "nt":
        return None
    import winreg

    locations = (
        (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam"),
    )
    for hive, key_name in locations:
        try:
            with winreg.OpenKey(hive, key_name) as key:
                for value_name in ("SteamPath", "InstallPath"):
                    try:
                        value, _ = winreg.QueryValueEx(key, value_name)
                    except FileNotFoundError:
                        continue
                    path = Path(str(value)).expanduser()
                    if path.is_dir():
                        return path
        except (FileNotFoundError, OSError):
            continue
    return None


def discover_palserver(steam_path: Path | None = None) -> list[SteamCandidate]:
    root = steam_path or steam_install_path_from_registry()
    if root is None:
        return []
    libraries = [root.resolve()]
    library_file = root / "steamapps" / "libraryfolders.vdf"
    if library_file.is_file():
        parsed = parse_vdf(library_file.read_text(encoding="utf-8-sig", errors="strict"))
        folders = parsed.get("libraryfolders", {})
        if isinstance(folders, dict):
            for key, entry in folders.items():
                if not str(key).isdigit():
                    continue
                raw_path = entry.get("path") if isinstance(entry, dict) else entry
                if isinstance(raw_path, str):
                    candidate = Path(raw_path).expanduser().resolve()
                    if candidate not in libraries:
                        libraries.append(candidate)

    found: list[SteamCandidate] = []
    for library in libraries:
        manifest = library / "steamapps" / f"appmanifest_{PALSERVER_APP_ID}.acf"
        if not manifest.is_file():
            continue
        install_dir = "PalServer"
        manifest_valid = False
        try:
            app_state = parse_vdf(manifest.read_text(encoding="utf-8-sig"))
            raw_state = app_state.get("AppState", {})
            if isinstance(raw_state, dict):
                install_dir = str(raw_state.get("installdir", install_dir))
                manifest_valid = str(raw_state.get("appid")) == PALSERVER_APP_ID
        except (OSError, UnicodeError, VdfParseError):
            pass
        install = library / "steamapps" / "common" / install_dir
        executable = install / "PalServer.exe"
        if executable.is_file():
            found.append(
                SteamCandidate(
                    library_path=library,
                    install_path=install.resolve(),
                    executable_path=executable.resolve(),
                    manifest_path=manifest.resolve(),
                    manifest_valid=manifest_valid,
                )
            )
    return sorted(found, key=lambda item: (not item.manifest_valid, str(item.install_path)))


def validate_executable(path: Path) -> Path:
    assert_no_reparse_points(path)
    try:
        resolved = path.expanduser().resolve(strict=True)
    except RuntimeError as error:
        raise ValueError(f"Unable to resolve executable path: {error}") from error
    if not resolved.is_file() or resolved.name.casefold() != "palserver.exe":
        raise ValueError("所选路径必须指向存在的 PalServer.exe。")
    assert_no_reparse_points(resolved)
    return resolved
