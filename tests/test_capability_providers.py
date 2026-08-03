from custom_components.home_status.const import normalize_provider_options
from custom_components.home_status.providers import CapabilityProviderRegistry
from custom_components.home_status.providers.environment import TemperatureProvider


def configured(entity_id, capability="temperature", **values):
    return {
        "enabled_providers": ["climate"],
        "capability_sensors": {
            entity_id: {"capability": capability, **values}
        },
    }


async def test_discovery_uses_standard_device_class_and_does_not_select(hass):
    hass.states.async_set(
        "sensor.living_room_temperature",
        "72",
        {
            "device_class": "temperature",
            "state_class": "measurement",
            "unit_of_measurement": "°F",
            "friendly_name": "Living Room Temperature",
        },
    )
    hass.states.async_set(
        "sensor.living_room_humidity",
        "45",
        {
            "device_class": "humidity",
            "state_class": "measurement",
            "unit_of_measurement": "%",
        },
    )
    registry = CapabilityProviderRegistry()

    discovered = registry.discover(hass)

    assert [(item.entity_id, item.capability) for item in discovered] == [
        ("sensor.living_room_humidity", "humidity"),
        ("sensor.living_room_temperature", "temperature"),
    ]
    assert registry.selected_entity_ids({}) == ()
    assert registry.active_items(
        hass.states.get("sensor.living_room_temperature"), {}
    ) == []


async def test_threshold_normalization_stable_ids_and_clearing(hass):
    entity_id = "sensor.utility_room_temperature"
    attributes = {
        "device_class": "temperature",
        "state_class": "measurement",
        "unit_of_measurement": "°C",
        "friendly_name": "Utility Room",
    }
    hass.states.async_set(entity_id, "31.5", attributes)
    options = configured(entity_id, high_threshold=30)

    first = CapabilityProviderRegistry().active_items(
        hass.states.get(entity_id), options
    )[0]
    restarted = CapabilityProviderRegistry().active_items(
        hass.states.get(entity_id), options
    )[0]

    assert first["id"] == restarted["id"] == (
        "capability:temperature:sensor.utility_room_temperature:high"
    )
    assert first["value"] == 31.5
    assert first["unit"] == "°C"
    assert first["active"] is True

    hass.states.async_set(entity_id, "25", attributes)
    assert CapabilityProviderRegistry().active_items(
        hass.states.get(entity_id), options
    ) == []


async def test_threshold_alerts_use_homeowner_friendly_names_and_values(hass):
    entity_id = "sensor.outdoor_temperature"
    hass.states.async_set(entity_id, "85.226", {
        "device_class": "temperature",
        "state_class": "measurement",
        "unit_of_measurement": "°F",
        "friendly_name": "Outdoor Temperature",
    })

    item = CapabilityProviderRegistry().active_items(
        hass.states.get(entity_id),
        configured(entity_id, high_threshold=85),
    )[0]

    assert item["message"] == "High Temperature"
    assert item["detail"] == "85.2°F — Above 85°F"


async def test_low_humidity_alert_uses_natural_language(hass):
    entity_id = "sensor.bedroom_humidity"
    hass.states.async_set(entity_id, "29.94", {
        "device_class": "humidity",
        "state_class": "measurement",
        "unit_of_measurement": "%",
        "friendly_name": "Bedroom Humidity",
    })

    item = CapabilityProviderRegistry().active_items(
        hass.states.get(entity_id),
        configured(entity_id, "humidity", low_threshold=30),
    )[0]

    assert item["message"] == "Low Humidity"
    assert item["detail"] == "29.9% — Below 30%"


async def test_unknown_unavailable_malformed_and_missing_units_are_explicit(hass):
    entity_id = "sensor.attic_humidity"
    registry = CapabilityProviderRegistry()
    options = configured(entity_id, "humidity", high_threshold=70)

    for value, reason in (
        ("unknown", "state_unknown"),
        ("unavailable", "state_unavailable"),
        ("not-a-number", "malformed_number"),
    ):
        hass.states.async_set(entity_id, value, {
            "device_class": "humidity", "unit_of_measurement": "%",
        })
        assert registry.evaluate(hass.states.get(entity_id), options).reason == reason

    hass.states.async_set(entity_id, "50", {"device_class": "humidity"})
    assert registry.evaluate(
        hass.states.get(entity_id), options
    ).reason == "missing_unit"


async def test_current_values_are_opt_in_and_diagnostics_explain_decision(hass):
    entity_id = "sensor.bedroom_humidity"
    hass.states.async_set(entity_id, "48", {
        "device_class": "humidity",
        "state_class": "measurement",
        "unit_of_measurement": "%",
    })
    registry = CapabilityProviderRegistry()
    silent = configured(entity_id, "humidity", low_threshold=35, high_threshold=65)
    visible = configured(
        entity_id, "humidity", low_threshold=35, high_threshold=65,
        publish_current=True,
    )

    assert registry.current_items(hass, silent) == []
    assert registry.current_items(hass, visible)[0]["summary"] == "48%"
    diagnostics = registry.diagnostics(hass, visible)
    selected = diagnostics["selected_entities"][0]
    assert selected["normalized_state"]["value"] == 48
    assert selected["produces_event"] is False
    assert selected["reason"] == "within_configured_thresholds"
    assert selected["thresholds"] == {"low": 35, "high": 65}

    missing_options = configured(
        "sensor.missing_temperature", high_threshold=80
    )
    missing = registry.diagnostics(hass, missing_options)[
        "selected_entities"
    ][0]
    assert missing["included"] is False
    assert missing["reason"] == "entity_not_found"

    hass.states.async_set(entity_id, "75", {
        "device_class": "humidity",
        "state_class": "measurement",
        "unit_of_measurement": "%",
    })
    assert registry.current_items(hass, visible) == []


async def test_one_provider_failure_does_not_break_another(hass):
    class BrokenTemperatureProvider(TemperatureProvider):
        def evaluate(self, state, config):
            raise ValueError("broken test provider")

    temperature = "sensor.office_temperature"
    humidity = "sensor.office_humidity"
    hass.states.async_set(temperature, "90", {
        "device_class": "temperature", "unit_of_measurement": "°F",
    })
    hass.states.async_set(humidity, "80", {
        "device_class": "humidity", "unit_of_measurement": "%",
    })
    registry = CapabilityProviderRegistry((
        BrokenTemperatureProvider(),
        CapabilityProviderRegistry().providers["humidity"],
    ))
    options = {
        "enabled_providers": ["climate"],
        "capability_sensors": {
            temperature: {"capability": "temperature", "high_threshold": 80},
            humidity: {"capability": "humidity", "high_threshold": 70},
        },
    }

    failed = registry.evaluate(hass.states.get(temperature), options)
    healthy = registry.active_items(hass.states.get(humidity), options)

    assert failed.reason == "provider_error"
    assert len(healthy) == 1
    assert healthy[0]["provider"] == "climate"


def test_capability_options_are_safely_normalized():
    normalized = normalize_provider_options({
        "capability_sensors": {
            "sensor.room_temperature": {
                "capability": "TEMPERATURE",
                "low_threshold": "60",
                "high_threshold": "80",
                "priority": "invalid",
                "publish_current": 1,
            },
            "light.invalid": {"capability": "temperature"},
            "sensor.unsupported": {"capability": "pressure"},
        }
    })

    assert normalized["capability_sensors"] == {
        "sensor.room_temperature": {
            "capability": "temperature",
            "low_threshold": 60.0,
            "high_threshold": 80.0,
            "priority": "attention",
            "publish_current": True,
        }
    }
