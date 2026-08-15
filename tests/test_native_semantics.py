"""Release-contract tests for the current device-first architecture."""

from custom_components.home_status.normalization import normalize_semantic_state
from custom_components.home_status.ha_native import present_current_items
from custom_components.home_status.home_device import HomeDevice, HomeDeviceEntity
from custom_components.home_status.interpreters import easystart_current_facts


def test_appliance_run_is_running_and_human_readable():
    normalized = normalize_semantic_state(
        "Run", capability="appliance_cycle", device_role="washer"
    )

    assert normalized["state"] == "running"
    assert normalized["display_state"] == "Running"
    assert normalized["semantic"]["active"] is True


def test_appliance_completion_is_not_active():
    normalized = normalize_semantic_state(
        "completed", capability="appliance_cycle", device_role="dryer"
    )

    assert normalized["state"] == "complete"
    assert normalized["display_state"] == "Complete"
    assert normalized["semantic"]["active"] is False


def test_contact_states_keep_open_and_closed_semantics():
    opened = normalize_semantic_state("on", device_class="door")
    closed = normalize_semantic_state("off", device_class="door")

    assert (opened["state"], opened["display_state"]) == ("open", "Open")
    assert (closed["state"], closed["display_state"]) == ("closed", "Closed")


def test_easystart_uses_two_current_items_for_all_requested_values(hass):
    device = HomeDevice(
        id="micro-air",
        name="Micro-Air",
        kind="climate",
        entities=[
            HomeDeviceEntity("sensor.micro_air_last_start_peak", "sensor", "Last Start Peak", unit="A"),
            HomeDeviceEntity("sensor.micro_air_line_frequency", "sensor", "Line Frequency", unit="Hz"),
            HomeDeviceEntity("sensor.micro_air_live_current", "sensor", "Live Current", unit="A"),
            HomeDeviceEntity("sensor.micro_air_scpt_delay", "sensor", "SCPT Delay", unit="s"),
            HomeDeviceEntity("sensor.micro_air_status", "sensor", "Status"),
            HomeDeviceEntity("sensor.micro_air_total_faults", "sensor", "Total Faults"),
            HomeDeviceEntity("sensor.micro_air_total_starts", "sensor", "Total Starts"),
        ],
    )
    states = {
        "sensor.micro_air_last_start_peak": "18.5",
        "sensor.micro_air_line_frequency": "60.0",
        "sensor.micro_air_live_current": "12.3",
        "sensor.micro_air_scpt_delay": "0",
        "sensor.micro_air_status": "Normal",
        "sensor.micro_air_total_faults": "2",
        "sensor.micro_air_total_starts": "87",
    }
    for entity_id, value in states.items():
        hass.states.async_set(entity_id, value)

    items = present_current_items(easystart_current_facts(hass, device))

    assert [item["title"] for item in items] == [
        "Micro-Air Current",
        "Micro-Air History",
    ]
    assert items[0]["summary"] == (
        "Line Frequency: 60 Hz | Live Current: 12.3 A | "
        "SCPT Delay: 0 s | Status: Normal"
    )
    assert items[1]["summary"] == (
        "Last Start Peak: 18.5 A | Total Faults: 2 | Total Starts: 87"
    )
    assert items[0]["id"] != items[1]["id"]
    assert all(item["category"] == "climate" for item in items)
