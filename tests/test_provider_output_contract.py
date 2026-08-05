"""Golden provider outputs captured before the coordinator split."""

from datetime import datetime, timezone
from types import SimpleNamespace

from custom_components.home_status.coordinator import HomeStatusCoordinator
from custom_components.home_status.source_registry import SourceRegistry


STAMP = datetime(2026, 8, 2, 12, 0, tzinfo=timezone.utc)


class FakeStates:
    def __init__(self, states=None):
        self._states = states or {}

    def get(self, entity_id):
        return self._states.get(entity_id)

    def async_all(self, domain=None):
        values = list(self._states.values())
        return [state for state in values if domain is None or state.entity_id.startswith(f"{domain}.")]


def fake_state(entity_id, value, attributes=None):
    return SimpleNamespace(
        entity_id=entity_id,
        state=value,
        attributes=attributes or {},
        last_changed=STAMP,
    )


def coordinator(states=None, options=None):
    instance = object.__new__(HomeStatusCoordinator)
    instance.hass = SimpleNamespace(states=FakeStates(states))
    instance.options = options or {}
    instance.registry = SourceRegistry.from_config()
    instance._condition_since = {}
    return instance


def compact(item):
    fields = (
        "id", "entity_id", "event_type", "behavior", "message", "detail",
        "category", "provider", "priority", "icon", "active", "persistent",
        "hero_eligible", "state",
    )
    return {key: item.get(key) for key in fields if key in item}


def test_weather_alert_output_contract():
    subject = coordinator()
    state = fake_state("sensor.weather_alerts", "1")
    item = subject._build_weather_item(state.entity_id, state, {
        "ID": "alert-1",
        "Event": "Flood Watch",
        "Headline": "Flood Watch...Heavy rain is possible",
        "Description": "Avoid flooded roads",
        "Severity": "Severe",
    })

    assert compact(item) == {
        "id": "sensor.weather_alerts:alert-1",
        "entity_id": "sensor.weather_alerts",
        "event_type": "weather_alert",
        "message": "Flood Watch",
        "detail": "Avoid flooded roads",
        "category": "weather",
        "provider": "weather",
        "priority": "critical",
        "active": True,
        "persistent": True,
    }


def test_legacy_hardcoded_laundry_cycle_is_retired():
    remaining = fake_state("sensor.washer_time_remaining", "00:12:00")
    machine = fake_state("sensor.washer_machine_state", "run")
    subject = coordinator({remaining.entity_id: remaining})

    assert subject._build_appliance_cycle_item(machine.entity_id, machine) is None


def test_filter_maintenance_output_contract():
    status = fake_state("binary_sensor.refrigerator_filter_status", "off")
    usage = fake_state(
        "sensor.refrigerator_water_filter_usage",
        "94",
        {"unit_of_measurement": "%"},
    )
    subject = coordinator({status.entity_id: status})

    assert compact(subject._build_filter_maintenance_item(usage.entity_id, usage)) == {
        "id": "home_status:refrigerator_water_filter",
        "entity_id": "sensor.refrigerator_water_filter_usage",
        "event_type": "filter_maintenance",
        "behavior": "maintenance",
        "message": "Replace Refrigerator Water Filter",
        "detail": "Water filter usage is 94%",
        "category": "maintenance",
        "provider": "maintenance",
        "priority": "activity",
        "icon": "mdi:water-sync",
        "active": True,
        "persistent": True,
        "hero_eligible": False,
        "state": "94",
    }


def test_legacy_hardcoded_sprinkler_output_is_retired():
    zone = fake_state("valve.sprinklers_zone1", "open")
    subject = coordinator({zone.entity_id: zone})

    assert subject._build_sprinkler_watering_item(zone.entity_id) is None


def test_waste_collection_due_dates_stay_with_schedule_provider():
    subject = coordinator()

    assert subject._waste_collection_is_due(
        fake_state("sensor.garbage_pickup", "Today")
    ) is True
    assert subject._waste_collection_is_due(
        fake_state("sensor.recycling_pickup", "Tomorrow")
    ) is True
    assert subject._waste_collection_is_due(
        fake_state("sensor.yard_waste_pickup", "In 2 days")
    ) is False
    assert subject._waste_collection_is_due(
        fake_state("sensor.unknown_pickup", "unknown")
    ) is False


def test_provider_methods_are_split_from_coordinator():
    expected_modules = {
        "_build_weather_item": "providers.weather",
        "_build_direct_history_event": "providers.security",
        "_build_filter_maintenance_item": "providers.maintenance",
        "_build_appliance_cycle_item": "providers.laundry",
        "_build_hvac_diagnostic_item": "providers.climate",
        "_build_sprinkler_watering_item": "providers.schedule",
        "_build_camera_health_item": "providers.cameras",
        "_build_presence_status_item": "providers.family",
    }
    for method_name, module_suffix in expected_modules.items():
        method = getattr(HomeStatusCoordinator, method_name)
        assert method.__module__.endswith(module_suffix)
