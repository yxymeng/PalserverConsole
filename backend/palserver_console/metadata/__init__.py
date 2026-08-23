"""Pinned, offline game metadata shared by world-data consumers."""

from .loader import (
    ItemMetadata,
    MetadataStatus,
    PalSpeciesMetadata,
    WorldMetadataBundle,
    WorldMetadataError,
    load_world_metadata,
)

__all__ = [
    "MetadataStatus",
    "ItemMetadata",
    "PalSpeciesMetadata",
    "WorldMetadataBundle",
    "WorldMetadataError",
    "load_world_metadata",
]
