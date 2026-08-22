"""Pinned, offline game metadata shared by world-data consumers."""

from .loader import (
    MetadataStatus,
    PalSpeciesMetadata,
    WorldMetadataBundle,
    WorldMetadataError,
    load_world_metadata,
)

__all__ = [
    "MetadataStatus",
    "PalSpeciesMetadata",
    "WorldMetadataBundle",
    "WorldMetadataError",
    "load_world_metadata",
]
