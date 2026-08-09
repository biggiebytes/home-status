from custom_components.home_status.normalization import (
    humanize_raw_value,
    normalize_semantic_state,
)


def test_common_appliance_values_normalize_without_exposing_raw_enums():
    power = normalize_semantic_state("power_off", capability="appliance_cycle")
    assert power["raw"] == {"state": "power_off"}
    assert power["semantic"]["state"] == "off"
    assert power["presentation"]["state"] == "Off"
    assert normalize_semantic_state(
        "night_dry", entity_id="sensor.dishwasher_current_status",
        provider="appliance", capability="cycle_stage",
    )["source"]["entity_id"] == "sensor.dishwasher_current_status"
    assert normalize_semantic_state("night_dry", capability="cycle_stage")["display_state"] == "Drying"
    assert normalize_semantic_state("cleaning_is_complete", capability="completion")["state"] == "complete"
    water = normalize_semantic_state("water_supply_error", capability="fault")
    assert water["state"] == "error"
    assert water["display_state"] == "Water Supply Error"


def test_unknown_values_are_humanized_safely():
    assert humanize_raw_value("rinselevel_2") == "Rinse Level 2"
    assert humanize_raw_value("unknown_custom_state") == "Unknown Custom State"
    assert humanize_raw_value("camelCaseState") == "Camel Case State"
    unknown = normalize_semantic_state("rinselevel_2", capability="cycle_stage")
    assert unknown["state"] == "unknown"
    assert unknown["display_state"] == "Rinse Level 2"


def test_context_changes_the_meaning_of_on():
    assert normalize_semantic_state("on", capability="appliance_cycle")["state"] == "running"
    clean = normalize_semantic_state("on", capability="clean_indicator")
    assert clean["state"] == "complete"
    assert clean["display_state"] == "Clean"
    leak = normalize_semantic_state("on", domain="binary_sensor", device_class="moisture")
    assert leak["state"] == "detected"
    assert leak["display_state"] == "Leak Detected"


def test_binary_device_classes_and_explicit_context_are_semantic_not_boolean():
    assert normalize_semantic_state("on", domain="binary_sensor", device_class="door")["state"] == "open"
    assert normalize_semantic_state("off", domain="binary_sensor", device_class="window")["state"] == "closed"
    assert normalize_semantic_state("on", domain="binary_sensor", device_class="motion")["display_state"] == "Motion Detected"
    assert normalize_semantic_state("unlocked", domain="lock")["state"] == "unlocked"
    assert normalize_semantic_state("off", domain="binary_sensor", device_class="moisture")["state"] == "clear"
    assert normalize_semantic_state("off", domain="binary_sensor", device_class="door")["display_state"] == "Closed"


def test_adapter_aliases_override_generic_meaning():
    value = normalize_semantic_state(
        "vendor_rinse", capability="cycle_stage",
        aliases={"vendor_rinse": {"state": "rinsing", "display": "Rinsing"}},
    )
    assert value["state"] == "rinsing"
    assert value["display_state"] == "Rinsing"


def test_explicit_override_precedes_provider_adapter_and_preserves_context():
    value = normalize_semantic_state(
        "vendor_cycle", entity_id="sensor.washer_cycle", domain="sensor",
        provider="appliance", device_role="washer", capability="cycle_stage",
        overrides={"vendor_cycle": {"state": "drying", "display": "Drying"}},
        aliases={"vendor_cycle": {"state": "washing", "display": "Washing"}},
    )
    assert value["semantic"]["state"] == "drying"
    assert value["presentation"]["state"] == "Drying"
    assert value["source"] == {
        "entity_id": "sensor.washer_cycle", "domain": "sensor",
        "provider": "appliance", "device_role": "washer",
    }
