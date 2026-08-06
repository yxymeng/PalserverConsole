"""A read-only boundary around palworld-save-tools.

Only this module accesses the third-party parser's internal property tree.  Later
business modules must consume normalized outputs from this boundary instead of
depending on third-party dictionary paths.
"""

from __future__ import annotations

import ctypes
import gc
import gzip
import hashlib
import io
import json
import os
import stat
import tempfile
import time
import uuid
from collections.abc import Iterator, Mapping
from contextlib import ExitStack, redirect_stdout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

from palworld_save_tools.archive import UUID as PalworldUUID
from palworld_save_tools.gvas import GvasFile
from palworld_save_tools.json_tools import CustomEncoder
from palworld_save_tools.palsav import compress_gvas_to_sav, decompress_sav_to_gvas
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES, PALWORLD_TYPE_HINTS

from .compat import m5_custom_properties

PARSER_VERSION = "0.24.0"
MAX_EVIDENCE_PATHS = 5
STRUCTURAL_VALUE_KEYS = frozenset(
    {
        "array_type",
        "enum_type",
        "inner_type",
        "key_type",
        "struct_type",
        "type",
        "value_type",
    }
)


@dataclass(frozen=True)
class CoverageSpec:
    key: str
    label: str
    required_source_keys: tuple[str, ...]
    scope_note: str


FIELD_COVERAGE_SPECS: tuple[CoverageSpec, ...] = (
    CoverageSpec(
        key="players",
        label="玩家",
        required_source_keys=("CharacterSaveParameterMap",),
        scope_note="已定位角色映射；M5 再按稳定 ID 区分玩家。",
    ),
    CoverageSpec(
        key="inventories",
        label="背包",
        required_source_keys=("ItemContainerSaveData",),
        scope_note="已定位物品容器映射；M5 再关联持有者。",
    ),
    CoverageSpec(
        key="pals",
        label="帕鲁",
        required_source_keys=("CharacterSaveParameterMap",),
        scope_note="已定位角色映射；M5 再按角色数据区分帕鲁。",
    ),
    CoverageSpec(
        key="containers",
        label="帕鲁仓库/容器",
        required_source_keys=("CharacterContainerSaveData",),
        scope_note="已定位角色容器映射。",
    ),
    CoverageSpec(
        key="guilds",
        label="工会",
        required_source_keys=("GroupSaveDataMap",),
        scope_note="已定位组织和工会映射。",
    ),
    CoverageSpec(
        key="bases",
        label="据点",
        required_source_keys=("BaseCampSaveData",),
        scope_note="已定位据点映射。",
    ),
    CoverageSpec(
        key="base_inventories",
        label="据点库存",
        required_source_keys=("BaseCampSaveData", "ItemContainerSaveData"),
        scope_note="已定位据点与物品容器来源；M5 再以稳定 ID 建立归属关系。",
    ),
    CoverageSpec(
        key="work_pals",
        label="工作帕鲁",
        required_source_keys=("WorkSaveData",),
        scope_note="已定位工作数据映射；M5 再以稳定 ID 建立据点归属。",
    ),
)


@dataclass(frozen=True)
class FieldCoverage:
    key: str
    label: str
    required_source_keys: tuple[str, ...]
    source_key_counts: dict[str, int]
    evidence_paths: dict[str, tuple[str, ...]]
    status: str
    scope_note: str

    @property
    def found(self) -> bool:
        return self.status == "source_structure_found"

    def to_public_dict(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "required_source_keys": list(self.required_source_keys),
            "source_key_counts": self.source_key_counts,
            "evidence_paths": {key: list(value) for key, value in self.evidence_paths.items()},
            "status": self.status,
            "scope_note": self.scope_note,
        }


@dataclass(frozen=True)
class ParseAnalysis:
    parser_version: str
    compression_magic: str
    decoder: str
    property_decode_mode: str
    compatibility_note: str | None
    source_size_bytes: int
    save_type: int
    parse_runs: int
    parse_durations_ms: tuple[int, ...]
    coverage: tuple[FieldCoverage, ...]

    def to_public_dict(self) -> dict[str, object]:
        return {
            "parser_version": self.parser_version,
            "compression_magic": self.compression_magic,
            "decoder": self.decoder,
            "property_decode_mode": self.property_decode_mode,
            "compatibility_note": self.compatibility_note,
            "source_size_bytes": self.source_size_bytes,
            "save_type": self.save_type,
            "parse_runs": self.parse_runs,
            "parse_durations_ms": list(self.parse_durations_ms),
            "coverage": [item.to_public_dict() for item in self.coverage],
        }


@dataclass(frozen=True)
class SanitizedFixture:
    output_format: str
    output_size_bytes: int
    redacted_strings: int
    redacted_uuids: int
    verification: ParseAnalysis


@dataclass
class _ParsedSave:
    source_size_bytes: int
    source_digest: str
    compression_magic: str
    decoder: str
    property_decode_mode: str
    compatibility_note: str | None
    save_type: int
    gvas_file: GvasFile
    coverage: tuple[FieldCoverage, ...]


@dataclass
class _RedactionState:
    string_replacements: dict[str, str] = field(default_factory=dict)
    uuid_replacements: dict[str, uuid.UUID] = field(default_factory=dict)
    redacted_strings: int = 0
    redacted_uuids: int = 0

    def replace_string(self, value: str) -> str:
        replacement = self.string_replacements.get(value)
        if replacement is None:
            replacement = f"anon-text-{len(self.string_replacements) + 1:06d}"
            self.string_replacements[value] = replacement
        self.redacted_strings += 1
        return replacement

    def replace_uuid(self, value: uuid.UUID | PalworldUUID) -> uuid.UUID | PalworldUUID:
        key = str(value)
        replacement = self.uuid_replacements.get(key)
        if replacement is None:
            replacement = uuid.uuid4()
            self.uuid_replacements[key] = replacement
        self.redacted_uuids += 1
        if isinstance(value, PalworldUUID):
            return PalworldUUID.from_str(str(replacement))
        return replacement


@dataclass(frozen=True)
class _SaveHeader:
    uncompressed_length: int
    compressed_length: int
    magic: bytes
    save_type: int
    data_start_offset: int


def verify_stable_parse(
    source_path: Path,
    *,
    iterations: int = 2,
    ooz_dll_path: Path | None = None,
) -> ParseAnalysis:
    """Parse a SAV repeatedly and fail if its contents change between runs."""
    if iterations < 2:
        raise ValueError("At least two parse iterations are required for stability validation.")

    expected_signature: tuple[object, ...] | None = None
    expected_digest: str | None = None
    expected_size: int | None = None
    expected_save_type: int | None = None
    expected_magic: str | None = None
    expected_decoder: str | None = None
    expected_property_decode_mode: str | None = None
    expected_compatibility_note: str | None = None
    coverage: tuple[FieldCoverage, ...] | None = None
    durations_ms: list[int] = []

    for _ in range(iterations):
        started = time.perf_counter()
        parsed = _parse_save(source_path, ooz_dll_path=ooz_dll_path)
        durations_ms.append(round((time.perf_counter() - started) * 1000))

        signature = _coverage_signature(parsed.coverage)
        if expected_signature is None:
            expected_signature = signature
            expected_digest = parsed.source_digest
            expected_size = parsed.source_size_bytes
            expected_save_type = parsed.save_type
            expected_magic = parsed.compression_magic
            expected_decoder = parsed.decoder
            expected_property_decode_mode = parsed.property_decode_mode
            expected_compatibility_note = parsed.compatibility_note
            coverage = parsed.coverage
        elif (
            signature != expected_signature
            or parsed.source_digest != expected_digest
            or parsed.source_size_bytes != expected_size
            or parsed.save_type != expected_save_type
            or parsed.compression_magic != expected_magic
            or parsed.decoder != expected_decoder
            or parsed.property_decode_mode != expected_property_decode_mode
            or parsed.compatibility_note != expected_compatibility_note
        ):
            raise RuntimeError(
                "The save changed or produced a different parse shape between validation runs."
            )

        del parsed
        gc.collect()

    if (
        coverage is None
        or expected_size is None
        or expected_save_type is None
        or expected_magic is None
        or expected_decoder is None
        or expected_property_decode_mode is None
    ):
        raise RuntimeError("No parse result was produced.")

    return ParseAnalysis(
        parser_version=PARSER_VERSION,
        compression_magic=expected_magic,
        decoder=expected_decoder,
        property_decode_mode=expected_property_decode_mode,
        compatibility_note=expected_compatibility_note,
        source_size_bytes=expected_size,
        save_type=expected_save_type,
        parse_runs=iterations,
        parse_durations_ms=tuple(durations_ms),
        coverage=coverage,
    )


def create_sanitized_fixture(
    source_path: Path,
    output_path: Path,
    fixture_root: Path,
    *,
    ooz_dll_path: Path | None = None,
) -> SanitizedFixture:
    """Create a parseable fixture without writing to the source save.

    The output is restricted to ``fixture_root`` and is marked read-only after
    a second parser pass succeeds. The fixture is intentionally Git-ignored.
    """
    source = _resolve_save_file(source_path)
    output = _resolve_fixture_destination(output_path, fixture_root)
    if output.exists():
        raise FileExistsError("The sanitized fixture already exists; refusing to overwrite it.")

    parsed = _parse_save(source, ooz_dll_path=ooz_dll_path)
    source_digest_before_write = _sha256_file(source)
    if source_digest_before_write != parsed.source_digest:
        raise RuntimeError("The source save changed while it was being parsed.")

    redaction_state = _RedactionState()
    parsed.gvas_file.properties = _redact_value(parsed.gvas_file.properties, (), redaction_state)
    if output.name.casefold().endswith(".json.gz"):
        sanitized_snapshot = parsed.gvas_file.dump()
        del parsed
        gc.collect()
        _write_gzip_json_atomically(output, sanitized_snapshot)
        verification = verify_stable_parse(source, ooz_dll_path=ooz_dll_path)
        output.chmod(output.stat().st_mode & ~stat.S_IWRITE)
        return SanitizedFixture(
            output_format="gzip_json_structure_snapshot",
            output_size_bytes=output.stat().st_size,
            redacted_strings=redaction_state.redacted_strings,
            redacted_uuids=redaction_state.redacted_uuids,
            verification=verification,
        )

    custom_properties = (
        PALWORLD_CUSTOM_PROPERTIES
        if parsed.property_decode_mode == "full_custom_properties"
        else {}
    )
    sanitized_gvas = parsed.gvas_file.write(custom_properties)
    sanitized_save = compress_gvas_to_sav(sanitized_gvas, parsed.save_type)
    del parsed
    gc.collect()

    output.parent.mkdir(parents=True, exist_ok=True)
    temp_path = _write_temp_save(output.parent, sanitized_save)
    try:
        verification = verify_stable_parse(temp_path)
        os.replace(temp_path, output)
        output.chmod(output.stat().st_mode & ~stat.S_IWRITE)
    except Exception:
        if temp_path.exists():
            temp_path.unlink()
        raise

    return SanitizedFixture(
        output_format="sav",
        output_size_bytes=output.stat().st_size,
        redacted_strings=redaction_state.redacted_strings,
        redacted_uuids=redaction_state.redacted_uuids,
        verification=verification,
    )


def build_field_coverage(properties: Mapping[str, Any]) -> tuple[FieldCoverage, ...]:
    """Summarize only known structural keys, never values from a save."""
    occurrences: dict[str, list[str]] = {}
    for key, path in _iter_key_occurrences(properties):
        occurrences.setdefault(key, []).append(path)

    coverage: list[FieldCoverage] = []
    for spec in FIELD_COVERAGE_SPECS:
        counts = {
            source_key: len(occurrences.get(source_key, []))
            for source_key in spec.required_source_keys
        }
        evidence = {
            source_key: tuple(occurrences.get(source_key, [])[:MAX_EVIDENCE_PATHS])
            for source_key in spec.required_source_keys
        }
        status = (
            "source_structure_found"
            if all(counts[source_key] > 0 for source_key in spec.required_source_keys)
            else "source_structure_missing"
        )
        coverage.append(
            FieldCoverage(
                key=spec.key,
                label=spec.label,
                required_source_keys=spec.required_source_keys,
                source_key_counts=counts,
                evidence_paths=evidence,
                status=status,
                scope_note=spec.scope_note,
            )
        )
    return tuple(coverage)


def read_save_properties(
    source_path: Path, *, ooz_dll_path: Path | None = None
) -> Mapping[str, Any]:
    """Read a save through the adapter and return its decoded property tree."""
    return cast(
        Mapping[str, Any],
        _parse_save(source_path, ooz_dll_path=ooz_dll_path).gvas_file.properties,
    )


def write_coverage_reports(analysis: ParseAnalysis, markdown_path: Path, json_path: Path) -> None:
    """Write value-free M0 coverage reports to the supplied project report paths."""
    public_data = analysis.to_public_dict()
    _write_text_atomically(json_path, json.dumps(public_data, ensure_ascii=False, indent=2) + "\n")
    _write_text_atomically(markdown_path, _coverage_markdown(analysis))


def _parse_save(source_path: Path, *, ooz_dll_path: Path | None = None) -> _ParsedSave:
    source = _resolve_save_file(source_path)
    with source.open("rb") as source_file:
        source_bytes = source_file.read()
    if not source_bytes:
        raise ValueError("The save file is empty.")

    raw_gvas, save_type, compression_magic, decoder = _decode_save(
        source_bytes,
        ooz_dll_path=ooz_dll_path,
    )
    gvas_file, property_decode_mode, compatibility_note = _read_gvas_with_compatibility(raw_gvas)
    return _ParsedSave(
        source_size_bytes=len(source_bytes),
        source_digest=hashlib.sha256(source_bytes).hexdigest(),
        compression_magic=compression_magic,
        decoder=decoder,
        property_decode_mode=property_decode_mode,
        compatibility_note=compatibility_note,
        save_type=save_type,
        gvas_file=gvas_file,
        coverage=build_field_coverage(gvas_file.properties),
    )


def _read_gvas_with_compatibility(raw_gvas: bytes) -> tuple[GvasFile, str, str | None]:
    try:
        return (
            _read_gvas_without_console_noise(raw_gvas, PALWORLD_CUSTOM_PROPERTIES),
            "full_custom_properties",
            None,
        )
    except Exception as error:
        if str(error) != "Warning: EOF not reached":
            raise

    try:
        return (
            _read_gvas_without_console_noise(raw_gvas, m5_custom_properties()),
            "m5_2026_07_read_only_compat",
            "Upstream 0.24.0 RawData layouts were supplemented by the M5 read-only "
            "compatibility layer.",
        )
    except Exception:
        pass

    generic_gvas = _read_gvas_without_console_noise(raw_gvas, {})
    return (
        generic_gvas,
        "generic_structure_fallback",
        "palworld-save-tools full RawData decoder raised: Warning: EOF not reached",
    )


def _read_gvas_without_console_noise(
    raw_gvas: bytes,
    custom_properties: Mapping[str, Any],
) -> GvasFile:
    with redirect_stdout(io.StringIO()):
        return GvasFile.read(raw_gvas, PALWORLD_TYPE_HINTS, dict(custom_properties))


def _decode_save(
    source_bytes: bytes,
    *,
    ooz_dll_path: Path | None,
) -> tuple[bytes, int, str, str]:
    header = _read_save_header(source_bytes)
    if header.magic == b"PlM":
        if header.compressed_length != len(source_bytes) - header.data_start_offset:
            raise ValueError("The PlM save header has an incorrect compressed length.")
        if ooz_dll_path is None:
            raise RuntimeError(
                "Oodle-compressed (PlM) save detected. "
                "Supply a local libooz.dll path for M0 validation."
            )
        raw_gvas = _decompress_plm(
            source_bytes[header.data_start_offset :],
            header.uncompressed_length,
            ooz_dll_path,
        )
        if len(raw_gvas) != header.uncompressed_length:
            raise RuntimeError("The local libooz.dll returned an unexpected decompressed length.")
        return raw_gvas, header.save_type, "PlM", "local libooz.dll"

    raw_gvas, save_type = decompress_sav_to_gvas(source_bytes)
    return raw_gvas, save_type, "PlZ", "palworld-save-tools built-in zlib"


def _read_save_header(source_bytes: bytes) -> _SaveHeader:
    if len(source_bytes) < 12:
        raise ValueError("The save file is too short to contain a Palworld header.")

    uncompressed_length = int.from_bytes(source_bytes[0:4], byteorder="little")
    compressed_length = int.from_bytes(source_bytes[4:8], byteorder="little")
    magic = source_bytes[8:11]
    save_type = source_bytes[11]
    data_start_offset = 12
    if magic == b"CNK":
        if len(source_bytes) < 24:
            raise ValueError("The CNK save header is incomplete.")
        uncompressed_length = int.from_bytes(source_bytes[12:16], byteorder="little")
        compressed_length = int.from_bytes(source_bytes[16:20], byteorder="little")
        magic = source_bytes[20:23]
        save_type = source_bytes[23]
        data_start_offset = 24

    return _SaveHeader(
        uncompressed_length=uncompressed_length,
        compressed_length=compressed_length,
        magic=magic,
        save_type=save_type,
        data_start_offset=data_start_offset,
    )


def _decompress_plm(compressed_data: bytes, uncompressed_length: int, ooz_dll_path: Path) -> bytes:
    library_path = ooz_dll_path.resolve(strict=True)
    if not library_path.is_file() or library_path.suffix.casefold() != ".dll":
        raise ValueError("The supplied local Oodle decoder must be a .dll file.")

    try:
        library = ctypes.CDLL(str(library_path))
        decompressor = library.Ooz_Decompress
    except OSError as error:
        raise RuntimeError("Unable to load the supplied local libooz.dll.") from error
    except AttributeError as error:
        raise RuntimeError("The supplied DLL does not export Ooz_Decompress.") from error

    decompressor.argtypes = [
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_char_p,
        ctypes.c_size_t,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_int,
    ]
    decompressor.restype = ctypes.c_int

    compressed_buffer = ctypes.create_string_buffer(compressed_data)
    output_buffer = ctypes.create_string_buffer(uncompressed_length + 64)
    result = decompressor(
        ctypes.cast(compressed_buffer, ctypes.c_char_p),
        len(compressed_data),
        ctypes.cast(output_buffer, ctypes.c_char_p),
        uncompressed_length,
        0,
        0,
        0,
        None,
        0,
        None,
        None,
        None,
        0,
        0,
    )
    if result != uncompressed_length:
        raise RuntimeError(f"Ooz_Decompress returned {result}, expected {uncompressed_length}.")
    return output_buffer.raw[:uncompressed_length]


def _resolve_save_file(path: Path) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError("The source must be a regular .sav file.")
    if resolved.suffix.casefold() != ".sav":
        raise ValueError("The source must have a .sav extension.")
    return resolved


def _resolve_fixture_destination(output_path: Path, fixture_root: Path) -> Path:
    root = fixture_root.resolve(strict=False)
    output = output_path.resolve(strict=False)
    try:
        output.relative_to(root)
    except ValueError as error:
        message = "The sanitized fixture must be written under fixtures/sanitized."
        raise ValueError(message) from error
    if output.is_symlink():
        raise ValueError("The sanitized fixture path must not be a symbolic link.")
    if output.suffix.casefold() == ".sav" or output.name.casefold().endswith(".json.gz"):
        return output
    raise ValueError("The sanitized fixture must have a .sav or .json.gz extension.")


def _iter_key_occurrences(
    value: Any,
    path: tuple[str, ...] = (),
    seen: set[int] | None = None,
) -> Iterator[tuple[str, str]]:
    visited = seen if seen is not None else set()
    if isinstance(value, Mapping):
        identity = id(value)
        if identity in visited:
            return
        visited.add(identity)
        for key, nested_value in value.items():
            key_text = str(key)
            nested_path = path + (key_text,)
            yield key_text, _format_path(nested_path)
            yield from _iter_key_occurrences(nested_value, nested_path, visited)
    elif isinstance(value, list):
        identity = id(value)
        if identity in visited:
            return
        visited.add(identity)
        for index, nested_value in enumerate(value):
            yield from _iter_key_occurrences(nested_value, path + (f"[{index}]",), visited)


def _coverage_signature(coverage: tuple[FieldCoverage, ...]) -> tuple[object, ...]:
    return tuple(
        (
            item.key,
            item.status,
            tuple(item.source_key_counts.items()),
            tuple((key, value) for key, value in item.evidence_paths.items()),
        )
        for item in coverage
    )


def _redact_value(value: Any, path: tuple[str, ...], state: _RedactionState) -> Any:
    if isinstance(value, uuid.UUID | PalworldUUID):
        return state.replace_uuid(value)
    if isinstance(value, Mapping):
        redacted: dict[Any, Any] = {}
        for key, nested_value in value.items():
            redacted_key = _redact_map_key(key, state)
            child_path = path + (str(key),)
            redacted[redacted_key] = _redact_value(nested_value, child_path, state)
        return redacted
    if isinstance(value, list):
        return [_redact_value(item, path + ("[]",), state) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item, path + ("[]",), state) for item in value)
    if isinstance(value, str) and _should_redact_string(path):
        return state.replace_string(value)
    return value


def _redact_map_key(key: Any, state: _RedactionState) -> Any:
    if isinstance(key, uuid.UUID | PalworldUUID):
        return state.replace_uuid(key)
    if isinstance(key, str) and _looks_like_identifier(key):
        return state.replace_string(key)
    return key


def _should_redact_string(path: tuple[str, ...]) -> bool:
    if not path:
        return True
    return path[-1].casefold() not in STRUCTURAL_VALUE_KEYS


def _looks_like_identifier(value: str) -> bool:
    compact = value.replace("-", "")
    return (
        len(compact) == 32 and all(character in "0123456789abcdefABCDEF" for character in compact)
    ) or (value.isdecimal() and len(value) >= 10)


def _format_path(path: tuple[str, ...]) -> str:
    result = ""
    for part in path:
        if part.startswith("["):
            result += part
        elif result:
            result += f".{part}"
        else:
            result = part
    return result


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_temp_save(directory: Path, content: bytes) -> Path:
    descriptor, raw_path = tempfile.mkstemp(prefix=".m0-sanitized-", suffix=".sav", dir=directory)
    temp_path = Path(raw_path)
    try:
        with os.fdopen(descriptor, "wb") as output_file:
            output_file.write(content)
            output_file.flush()
            os.fsync(output_file.fileno())
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    return temp_path


def _write_text_atomically(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_path = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
    temp_path = Path(raw_path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output_file:
            output_file.write(content)
            output_file.flush()
            os.fsync(output_file.fileno())
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _write_gzip_json_atomically(path: Path, content: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, raw_path = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".tmp", dir=path.parent)
    temp_path = Path(raw_path)
    try:
        with os.fdopen(descriptor, "wb") as raw_file:
            with ExitStack() as stack:
                compressed_file = stack.enter_context(
                    gzip.GzipFile(fileobj=raw_file, mode="wb", mtime=0)
                )
                output_file = stack.enter_context(
                    io.TextIOWrapper(compressed_file, encoding="utf-8", newline="\n")
                )
                json.dump(content, output_file, ensure_ascii=False, indent=2, cls=CustomEncoder)
                output_file.write("\n")
            raw_file.flush()
            os.fsync(raw_file.fileno())
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _coverage_markdown(analysis: ParseAnalysis) -> str:
    lines = [
        "# M0 字段覆盖报告",
        "",
        "本报告只记录解析结构键、数量和无值路径；不包含玩家名称、ID、IP、真实路径或存档内容。",
        "",
        f"- 解析器：`palworld-save-tools=={analysis.parser_version}`",
        f"- 存档压缩标识：`{analysis.compression_magic}`",
        f"- 解码路径：`{analysis.decoder}`",
        f"- 自定义字段解码模式：`{analysis.property_decode_mode}`",
        f"- 输入大小：`{analysis.source_size_bytes}` bytes",
        f"- 压缩类型：`0x{analysis.save_type:02X}`",
        f"- 一致性解析次数：`{analysis.parse_runs}`",
        f"- 单次解析耗时：`{', '.join(str(item) for item in analysis.parse_durations_ms)}` ms",
        "",
        "| 范围 | 需要的源结构 | 结果 | 结构键出现次数 |",
        "| --- | --- | --- | --- |",
    ]
    for item in analysis.coverage:
        required = "<br>".join(f"`{key}`" for key in item.required_source_keys)
        counts = "<br>".join(f"`{key}`: {count}" for key, count in item.source_key_counts.items())
        result = "已定位源结构" if item.found else "当前样本未定位源结构"
        lines.append(f"| {item.label} | {required} | {result} | {counts} |")

    if analysis.compatibility_note:
        lines.extend(["", "## 兼容性限制", "", f"- `{analysis.compatibility_note}`"])

    lines.extend(
        [
            "",
            "## M0 边界",
            "",
            "- 该报告证明解析器能读取当前样本中的上述源结构，不等同于 M5 的规范化模型或页面功能。",
            "- 当解码模式为 `generic_structure_fallback` 时，RawData 内的详细玩家、帕鲁、物品、"
            "据点和工作数据尚未被验证；M5 必须先补充并回归测试这些字段解码。",
            "- 据点库存和工作帕鲁的稳定 ID 关联将在 M5 实现；M0 不按距离推测归属。",
            "- 解析样本位于 Git 忽略目录，不能提交或作为公开发布资产。",
            "",
        ]
    )
    return "\n".join(lines)
