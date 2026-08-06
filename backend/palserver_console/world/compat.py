"""Read-only decoders for Palworld save layouts newer than upstream 0.24.0.

The layouts are adapted from the MIT-licensed oMaN-Rod/palworld-save-tools
fork (2026-07 format).  Only the fields required by M5 are decoded here;
unknown trailing bytes are retained and never written back to a save.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

from palworld_save_tools.archive import FArchiveReader, instance_id_reader, uuid_reader
from palworld_save_tools.paltypes import PALWORLD_CUSTOM_PROPERTIES


def _raw_bytes(value: Sequence[int]) -> bytes:
    return bytes(value)


def decode_character(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    inner = reader.internal_copy(_raw_bytes(value["value"]["values"]), debug=False)
    decoded = {
        "object": inner.properties_until_end(),
        "unknown_bytes": inner.byte_list(4),
        "group_id": inner.guid(),
        "trailing_bytes": inner.byte_list(4),
    }
    if not inner.eof():
        raise ValueError("M5 character decoder did not reach EOF.")
    value["value"] = decoded
    return value


def decode_character_container(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    raw = value["value"]["values"]
    if not raw:
        value["value"] = None
        return value
    inner = reader.internal_copy(_raw_bytes(raw), debug=False)
    decoded = {
        "player_uid": inner.guid(),
        "instance_id": inner.guid(),
        "permission_tribe_id": inner.byte(),
    }
    if not inner.eof():
        decoded["trailing_bytes"] = list(inner.read_to_end())
    value["value"] = decoded
    return value


def decode_item_slot(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    raw = value["value"]["values"]
    if not raw:
        value["value"] = None
        return value
    inner = reader.internal_copy(_raw_bytes(raw), debug=False)
    value["value"] = {
        "slot_index": inner.i32(),
        "count": inner.i32(),
        "item": {
            "static_id": inner.fstring(),
            "dynamic_id": {
                "created_world_id": inner.guid(),
                "local_id_in_created_world": inner.guid(),
            },
        },
        "trailing_bytes": list(inner.read_to_end()),
    }
    return value


def decode_base_camp(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    inner = reader.internal_copy(_raw_bytes(value["value"]["values"]), debug=False)
    decoded = {
        "id": inner.guid(),
        "name": inner.fstring(),
        "state": inner.byte(),
        "transform": inner.ftransform(),
        "area_range": inner.float(),
        "group_id_belong_to": inner.guid(),
        "fast_travel_local_transform": inner.ftransform(),
        "owner_map_object_instance_id": inner.guid(),
        "trailing_bytes": inner.byte_list(4),
    }
    if not inner.eof():
        raise ValueError("M5 base camp decoder did not reach EOF.")
    value["value"] = decoded
    return value


def decode_worker_director(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    inner = reader.internal_copy(_raw_bytes(value["value"]["values"]), debug=False)
    decoded = {
        "id": inner.guid(),
        "spawn_transform": inner.ftransform(),
        "current_order_type": inner.byte(),
        "current_battle_type": inner.byte(),
        "container_id": inner.guid(),
        "trailing_bytes": inner.byte_list(4),
    }
    if not inner.eof():
        raise ValueError("M5 worker director decoder did not reach EOF.")
    value["value"] = decoded
    return value


def _player_info(reader: FArchiveReader) -> dict[str, Any]:
    return {
        "player_uid": reader.guid(),
        "player_info": {
            "last_online_real_time": reader.i64(),
            "player_name": reader.fstring(),
        },
    }


def _guild_player_info(reader: FArchiveReader) -> dict[str, Any]:
    result = _player_info(reader)
    result["role"] = reader.byte()
    return result


def _guild_marker(reader: FArchiveReader) -> dict[str, Any]:
    return {
        "marker_id": reader.guid(),
        "icon_location": reader.vector_dict(),
        "icon_type": reader.i32(),
        "owner_player_uid": reader.guid(),
    }


def _role_permission(reader: FArchiveReader) -> dict[str, Any]:
    return {"role": reader.byte(), "permissions": reader.tarray(lambda item: item.byte())}


def _guild_tail(reader: FArchiveReader) -> dict[str, Any]:
    start = reader.data.tell()
    try:
        current = {
            "guild_chest_allowed_roles": reader.tarray(lambda item: item.byte()),
            "unknown_i32": reader.i32(),
            "admin_player_uid": reader.guid(),
            "players": reader.tarray(_guild_player_info),
            "role_permissions": reader.tarray(_role_permission),
            "trailing_bytes": reader.byte_list(4),
        }
        if reader.eof():
            return current
    except (IndexError, ValueError, OSError, UnicodeError):
        pass
    reader.data.seek(start)
    return {
        "admin_player_uid": reader.guid(),
        "players": reader.tarray(_player_info),
        "trailing_bytes": reader.byte_list(4),
    }


def _decode_group_bytes(
    parent: FArchiveReader, raw: Sequence[int], group_type: str
) -> dict[str, Any]:
    reader = parent.internal_copy(_raw_bytes(raw), debug=False)
    result: dict[str, Any] = {
        "group_type": group_type,
        "group_id": reader.guid(),
        "group_name": reader.fstring(),
        "individual_character_handle_ids": reader.tarray(instance_id_reader),
    }
    if group_type in {
        "EPalGroupType::Guild",
        "EPalGroupType::IndependentGuild",
        "EPalGroupType::Organization",
    }:
        result["org_type"] = reader.byte()
    if group_type == "EPalGroupType::Organization":
        result["trailing_bytes"] = reader.byte_list(12)
    elif group_type == "EPalGroupType::Guild":
        result.update(
            {
                "leading_bytes": reader.byte_list(4),
                "base_ids": reader.tarray(uuid_reader),
                "unknown_1": reader.i32(),
                "base_camp_level": reader.i32(),
                "map_object_instance_ids_base_camp_points": reader.tarray(uuid_reader),
                "guild_name": reader.fstring(),
                "last_guild_name_modifier_player_uid": reader.guid(),
                "guild_markers": reader.tarray(_guild_marker),
            }
        )
        result.update(_guild_tail(reader))
    elif group_type == "EPalGroupType::IndependentGuild":
        result.update(
            {
                "base_camp_level": reader.i32(),
                "map_object_instance_ids_base_camp_points": reader.tarray(uuid_reader),
                "guild_name": reader.fstring(),
                "player_uid": reader.guid(),
                "guild_name_2": reader.fstring(),
                "player_info": {
                    "last_online_real_time": reader.i64(),
                    "player_name": reader.fstring(),
                },
            }
        )
    if not reader.eof():
        raise ValueError(f"M5 group decoder did not reach EOF for {group_type}.")
    return result


def decode_groups(
    reader: FArchiveReader, type_name: str, size: int, path: str
) -> dict[str, Any]:
    value = cast(dict[str, Any], reader.property(type_name, size, path, nested_caller_path=path))
    for group in value["value"]:
        group_type = group["value"]["GroupType"]["value"]["value"]
        raw = group["value"]["RawData"]["value"]["values"]
        group["value"]["RawData"]["value"] = _decode_group_bytes(reader, raw, group_type)
    return value


def m5_custom_properties() -> dict[str, tuple[Any, Any]]:
    """Return the narrowly scoped read-only custom-property map used by M5."""
    selected = {
        ".worldSaveData.GroupSaveDataMap": decode_groups,
        ".worldSaveData.CharacterSaveParameterMap.Value.RawData": decode_character,
        ".worldSaveData.ItemContainerSaveData.Value.RawData": PALWORLD_CUSTOM_PROPERTIES[
            ".worldSaveData.ItemContainerSaveData.Value.RawData"
        ][0],
        ".worldSaveData.ItemContainerSaveData.Value.Slots.Slots.RawData": decode_item_slot,
        ".worldSaveData.CharacterContainerSaveData.Value.Slots.Slots.RawData": (
            decode_character_container
        ),
        ".worldSaveData.BaseCampSaveData.Value.RawData": decode_base_camp,
        ".worldSaveData.BaseCampSaveData.Value.WorkerDirector.RawData": decode_worker_director,
    }
    return {
        path: (decoder, PALWORLD_CUSTOM_PROPERTIES[path][1])
        for path, decoder in selected.items()
    }
