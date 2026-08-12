"""Guard the published component contract and bounded Recorder payload."""

import json
from pathlib import Path

from custom_components.home_status.sensor import HomeStatusSensor


ROOT = Path(__file__).parents[1]
COMPONENT = ROOT / "custom_components" / "home_status"


def test_manifest_and_frontend_use_the_current_release_versions():
    manifest = json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))
    constants = (COMPONENT / "const.py").read_text(encoding="utf-8")

    assert manifest["version"] == "0.6.9"
    assert '"version": "0.5.2"' in constants
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
