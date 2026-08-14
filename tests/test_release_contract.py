"""Guard the published component contract and bounded Recorder payload."""

import json
from pathlib import Path

from custom_components.home_status.sensor import HomeStatusSensor


ROOT = Path(__file__).parents[1]
COMPONENT = ROOT / "custom_components" / "home_status"


def test_manifest_and_frontend_use_the_current_release_versions():
    manifest = json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))
    constants = (COMPONENT / "const.py").read_text(encoding="utf-8")

    assert manifest["version"] == "0.9.2"
    assert '"version": "0.8.2"' in constants
    assert "recorder" in manifest["after_dependencies"]


def test_sensor_payload_budget_preserves_current_appliance_state():
    attributes = {
        "native": {
            "current": [{"entity_name": "Washer", "detail": "4 min remaining"}],
            "recent": [{"message": "Washer Completed"}] * 16,
            "awareness": [{"title": "Verbose", "body": "x" * 2_000}] * 8,
        }
    }

    compact = HomeStatusSensor._fit_attribute_budget(attributes)
    encoded_size = len(json.dumps(compact, separators=(",", ":")).encode("utf-8"))

    assert encoded_size <= 12_000
    assert compact["native"]["current"] == [{"entity_name": "Washer", "detail": "4 min remaining"}]


def test_current_appliance_cycle_is_prioritized_within_sensor_budget():
    neutral = [
        {"entity_id": f"binary_sensor.neutral_{index}", "attention": "none"}
        for index in range(8)
    ]
    dryer = {
        "entity_id": "sensor.dryer_machine_state",
        "entity_name": "Dryer",
        "capability": "appliance_cycle",
        "detail": "40 min remaining",
    }

    native = HomeStatusSensor._compact_native({"current": [*neutral, dryer]})

    assert len(native["current"]) == 8
    assert native["current"][0]["entity_name"] == "Dryer"
