from __future__ import annotations

import argparse
import json
import re
import sys
from importlib.metadata import Distribution, distributions
from pathlib import Path
from typing import Any


def _normalise_distribution_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).casefold()


def _locked_distribution_names(lock_paths: list[Path]) -> list[str]:
    names: set[str] = set()
    for lock_path in lock_paths:
        for line in lock_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            name, separator, _ = stripped.partition("==")
            if not separator:
                raise RuntimeError(f"Unsupported lock entry: {stripped}")
            names.add(_normalise_distribution_name(name.strip()))
    return sorted(names)


def _installed_distributions() -> dict[str, Distribution]:
    result: dict[str, Distribution] = {}
    for distribution in distributions():
        name = distribution.metadata.get("Name")
        if name:
            result[_normalise_distribution_name(name)] = distribution
    return result


def _license_text(distribution: Distribution) -> str:
    candidate_files: list[Path] = []
    for relative_path in distribution.files or ():
        filename = Path(str(relative_path)).name.casefold()
        if (
            "license" in filename
            or filename.startswith("copying")
            or filename.startswith("notice")
        ):
            candidate = Path(distribution.locate_file(relative_path))
            if candidate.is_file():
                candidate_files.append(candidate)
    unique_files = sorted(set(candidate_files), key=lambda path: str(path).casefold())
    contents = [path.read_text(encoding="utf-8", errors="replace").strip() for path in unique_files]
    return "\n\n".join(content for content in contents if content)


def _python_license() -> str:
    candidates = [Path(sys.base_prefix) / "LICENSE.txt", Path(sys.base_prefix) / "LICENSE"]
    for candidate in candidates:
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8", errors="replace").strip()
    raise RuntimeError(f"CPython license file was not found below {sys.base_prefix}")


def _read_json_object(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise RuntimeError(f"Expected a JSON object: {path}")
    return raw


def _resolve_npm_lock_path(
    packages: dict[str, Any], requester_path: str, dependency_name: str
) -> str | None:
    requester_parts = [part for part in requester_path.split("/") if part]
    for end in range(len(requester_parts), -1, -1):
        prefix = "/".join(requester_parts[:end])
        candidate = f"{prefix + '/' if prefix else ''}node_modules/{dependency_name}"
        if candidate in packages:
            return candidate
    return None


def _npm_runtime_packages(package_lock: Path) -> list[tuple[str, str, dict[str, Any]]]:
    lock = _read_json_object(package_lock)
    raw_packages = lock.get("packages")
    if not isinstance(raw_packages, dict) or not isinstance(raw_packages.get(""), dict):
        raise RuntimeError(f"Unsupported npm package-lock structure: {package_lock}")
    packages: dict[str, Any] = raw_packages
    root = packages[""]
    root_dependencies = root.get("dependencies", {})
    if not isinstance(root_dependencies, dict):
        raise RuntimeError(f"package-lock root dependencies are invalid: {package_lock}")

    pending: list[tuple[str, str]] = []
    for name in sorted(root_dependencies):
        resolved = _resolve_npm_lock_path(packages, "", name)
        if resolved is None:
            raise RuntimeError(f"Locked npm runtime dependency is missing: {name}")
        pending.append((name, resolved))

    seen_paths: set[str] = set()
    result: list[tuple[str, str, dict[str, Any]]] = []
    while pending:
        name, lock_path = pending.pop(0)
        if lock_path in seen_paths:
            continue
        seen_paths.add(lock_path)
        metadata = packages.get(lock_path)
        if not isinstance(metadata, dict):
            raise RuntimeError(f"Invalid npm lock entry: {lock_path}")
        version = metadata.get("version")
        if not isinstance(version, str) or not version:
            raise RuntimeError(f"npm lock entry has no version: {lock_path}")
        result.append((name, lock_path, metadata))
        dependency_groups = (
            metadata.get("dependencies", {}),
            metadata.get("optionalDependencies", {}),
            metadata.get("peerDependencies", {}),
        )
        for group in dependency_groups:
            if not isinstance(group, dict):
                continue
            for child_name in sorted(group):
                child_path = _resolve_npm_lock_path(packages, lock_path, child_name)
                if child_path is not None:
                    pending.append((child_name, child_path))
    return sorted(result, key=lambda item: (item[0].casefold(), item[1].casefold()))


def _npm_license_text(package_root: Path) -> str:
    candidates = sorted(
        (
            path
            for path in package_root.iterdir()
            if path.is_file()
            and (
                "license" in path.name.casefold()
                or path.name.casefold().startswith("copying")
                or path.name.casefold().startswith("notice")
            )
        ),
        key=lambda path: path.name.casefold(),
    )
    contents = [path.read_text(encoding="utf-8", errors="replace").strip() for path in candidates]
    return "\n\n".join(content for content in contents if content)


def _render_npm_distributions(package_lock: Path, node_modules: Path) -> list[str]:
    sections = ["## npm runtime dependencies"]
    install_root = node_modules.resolve(strict=True).parent
    for name, lock_path, metadata in _npm_runtime_packages(package_lock):
        package_root = (install_root / Path(lock_path)).resolve(strict=True)
        try:
            package_root.relative_to(node_modules.resolve(strict=True))
        except ValueError as error:
            raise RuntimeError(f"npm package path escapes node_modules: {lock_path}") from error
        installed = _read_json_object(package_root / "package.json")
        version = str(metadata["version"])
        if installed.get("name") != name or installed.get("version") != version:
            raise RuntimeError(
                f"Installed npm package does not match package-lock: {name} {version}"
            )
        text = _npm_license_text(package_root)
        if not text:
            raise RuntimeError(f"No license text was found for npm package {name} {version}")
        license_expression = metadata.get("license") or installed.get("license") or "not declared"
        sections.extend(
            [
                "",
                f"### {name} {version}",
                "",
                f"Declared license: {license_expression}",
                "",
                "```text",
                text,
                "```",
            ]
        )
    return sections


def _render_distribution(name: str, distribution: Distribution) -> str:
    metadata = distribution.metadata
    license_expression = (
        metadata.get("License-Expression") or metadata.get("License") or "not declared"
    )
    text = _license_text(distribution)
    if not text:
        raise RuntimeError(f"No license text was found for {name} {distribution.version}")
    return "\n".join(
        [
            f"## {metadata['Name']} {distribution.version}",
            "",
            f"Declared license: {license_expression}",
            "",
            "```text",
            text,
            "```",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate portable-package third-party licenses")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--requirements", type=Path, action="append", required=True)
    parser.add_argument("--package-lock", type=Path, required=True)
    parser.add_argument("--node-modules", type=Path, required=True)
    args = parser.parse_args()

    locked_names = _locked_distribution_names(args.requirements)
    installed = _installed_distributions()
    missing = [name for name in locked_names if name not in installed]
    if missing:
        raise RuntimeError(f"Locked distributions are not installed: {', '.join(missing)}")

    sections = [
        "# Third-party licenses for the PalServerConsole portable package",
        "",
        "Generated from the exact runtime and build lock files. The package also includes "
        "THIRD_PARTY_NOTICES.md for Palworld-specific attribution and non-bundled "
        "libooz.dll notes.",
        "",
        "## CPython runtime",
        "",
        "```text",
        _python_license(),
        "```",
    ]
    for name in locked_names:
        sections.extend(["", _render_distribution(name, installed[name])])
    sections.extend(["", *_render_npm_distributions(args.package_lock, args.node_modules)])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(sections) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
