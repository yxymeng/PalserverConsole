from palserver_console.world.adapter import build_field_coverage


def test_coverage_maps_known_source_structures() -> None:
    properties: dict[str, object] = {
        "worldSaveData": {
            "value": {
                "CharacterSaveParameterMap": {},
                "ItemContainerSaveData": {},
                "CharacterContainerSaveData": {},
                "GroupSaveDataMap": {},
                "BaseCampSaveData": {},
                "WorkSaveData": {},
            }
        }
    }

    coverage = {item.key: item for item in build_field_coverage(properties)}

    assert set(coverage) == {
        "players",
        "inventories",
        "pals",
        "containers",
        "guilds",
        "bases",
        "base_inventories",
        "work_pals",
    }
    assert all(item.found for item in coverage.values())
    assert coverage["base_inventories"].source_key_counts == {
        "BaseCampSaveData": 1,
        "ItemContainerSaveData": 1,
    }
