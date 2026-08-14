"""Guard the published component contract and bounded Recorder payload."""

import json
from pathlib import Path

from custom_components.home_status.sensor import (
    TRANSPORT_CHANNELS,
    HomeStatusSensor,
    HomeStatusTransportSensor,
)


ROOT = Path(__file__).parents[1]
COMPONENT = ROOT / "custom_components" / "home_status"


def test_manifest_and_frontend_use_the_current_release_versions():
    manifest = json.loads((COMPONENT / "manifest.json").read_text(encoding="utf-8"))
    constants = (COMPONENT / "const.py").read_text(encoding="utf-8")

    assert manifest["version"] == "0.9.4"
    assert '"version": "0.9.4"' in constants
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


def test_sensor_payload_keeps_household_presence_when_awareness_is_capped():
    ordinary = [
        {
            "id": f"awareness:{index}",
            "title": f"Awareness {index}",
            "category": "calendar",
        }
        for index in range(8)
    ]
    household = {
        "id": "home_status:household_presence:awareness",
        "title": "Everyone Home",
        "category": "location",
        "source_kind": "location",
    }
    news = {
        "id": "news:local:latest",
        "title": "Local news",
        "category": "news",
    }

    native = HomeStatusSensor._compact_native({
        "awareness": [*ordinary, household, news],
    })
    ids = [item["id"] for item in native["awareness"]]

    assert len(ids) == 8
    assert household["id"] in ids
    assert news["id"] in ids
    assert household["id"] in [
        *native["streams"]["left"],
        *native["streams"]["right"],
    ]


def test_transport_manifest_declares_all_fixed_channels_and_revision():
    native = {
        "streams": {"left": ["now"], "right": [], "bottom": []},
    }
    manifest = HomeStatusSensor._transport_manifest({"snapshot_revision": 42}, native)

    assert manifest["kind"] == "manifest"
    assert manifest["revision"] == 42
    assert set(manifest["channels"]) == set(TRANSPORT_CHANNELS)
    assert manifest["channels"]["household"]["entity_id"] == "sensor.home_status_household"
    assert manifest["streams"] == native["streams"]


def test_transport_channels_partition_awareness_without_cross_domain_loss():
    awareness = [
        {"id": "household", "title": "Everyone Home", "category": "location"},
        {"id": "weather", "title": "70°", "category": "weather"},
        {"id": "calendar", "title": "School", "category": "calendar"},
        {"id": "news", "title": "Headline", "category": "news"},
    ]
    data = {"native": {"awareness": awareness}}

    results = {}
    for channel in ("household", "weather", "calendar", "news"):
        sensor = HomeStatusTransportSensor.__new__(HomeStatusTransportSensor)
        sensor._channel = channel
        results[channel] = [item["id"] for item in sensor._items(data)]

    assert results == {
        "household": ["household"],
        "weather": ["weather"],
        "calendar": ["calendar"],
        "news": ["news"],
    }
