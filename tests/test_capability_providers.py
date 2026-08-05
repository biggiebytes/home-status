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
        ("sensor.living_room_humidity", "state_trigger"),
        ("sensor.living_room_temperature", "state_trigger"),
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
        "source_entities": {
            "system_updates": ["update.home_assistant_core_update"],
        },
        "entities": ["sensor.legacy_default"],
        "entity_ids": ["sensor.older_legacy_default"],
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
            "binary_sensor.smoke_alarm": {
                "capability": "smoke", "priority": "critical",
                "publish_current": True,
            },
            "binary_sensor.internet": {"capability": "connectivity"},
            "sensor.washer_state": {
                "capability": "appliance_cycle",
                "appliance_type": "washer",
                "complete_states": ["DONE"],
                "idle_states": ["IDLE"],
                "remaining_entity": "sensor.washer_remaining",
            },
            "binary_sensor.dishwasher_clean": {
                "capability": "maintenance_alert",
                "active_message": "Clean Dishwasher",
                "resolved_message": "Dishwasher Cleaning Complete",
                "icon": "mdi:dishwasher-alert",
            },
            "camera.driveway": {"capability": "availability"},
            "light.porch": {
                "capability": "state_trigger",
                "trigger_state": "ON",
                "active_message": "Porch Light Left On",
                "resolved_message": "Porch Light Off",
            },
        }
    })

    assert "source_entities" not in normalized
    assert "entities" not in normalized
    assert "entity_ids" not in normalized

    assert normalized["capability_sensors"] == {
        "sensor.room_temperature": {
            "capability": "temperature",
            "low_threshold": 60.0,
            "high_threshold": 80.0,
            "priority": "attention",
            "publish_current": True,
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
        },
        "binary_sensor.smoke_alarm": {
            "capability": "smoke",
            "priority": "critical",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
        },
        "binary_sensor.internet": {
            "capability": "connectivity",
            "priority": "attention",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 30,
        },
        "sensor.washer_state": {
            "capability": "appliance_cycle",
            "priority": "activity",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
            "appliance_type": "washer",
            "complete_states": ["done"],
            "idle_states": ["idle"],
            "remaining_entity": "sensor.washer_remaining",
        },
        "binary_sensor.dishwasher_clean": {
            "capability": "maintenance_alert",
            "priority": "attention",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
            "active_message": "Clean Dishwasher",
            "resolved_message": "Dishwasher Cleaning Complete",
            "icon": "mdi:dishwasher-alert",
        },
        "camera.driveway": {
            "capability": "availability",
            "priority": "attention",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
            "alert_when_active": False,
        },
        "light.porch": {
            "capability": "state_trigger",
            "priority": "attention",
            "alert_behavior": "one_time",
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 0,
            "trigger_state": "on",
            "active_message": "Porch Light Left On",
            "resolved_message": "Porch Light Off",
        },
    }


async def test_selected_safety_capabilities_publish_only_when_active(hass):
    smoke = "binary_sensor.hallway_smoke"
    internet = "binary_sensor.internet_connection"
    hass.states.async_set(smoke, "off", {
        "device_class": "smoke", "friendly_name": "Hallway Smoke Alarm",
    })
    hass.states.async_set(internet, "on", {
        "device_class": "connectivity", "friendly_name": "Internet",
    })
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["security"],
        "capability_sensors": {
            smoke: {"capability": "smoke", "priority": "critical"},
            internet: {
                "capability": "connectivity", "priority": "attention",
                "trigger_delay_seconds": 0,
            },
        },
    }

    assert registry.active_items(hass.states.get(smoke), options) == []
    assert registry.active_items(hass.states.get(internet), options) == []

    hass.states.async_set(smoke, "on", {
        "device_class": "smoke", "friendly_name": "Hallway Smoke Alarm",
    })
    hass.states.async_set(internet, "off", {
        "device_class": "connectivity", "friendly_name": "Internet",
    })
    smoke_item = registry.active_items(hass.states.get(smoke), options)[0]
    connection_item = registry.active_items(hass.states.get(internet), options)[0]

    assert smoke_item["message"] == "Smoke Detected"
    assert smoke_item["priority"] == "critical"
    assert connection_item["message"] == "Connection Lost"
    assert connection_item["detail"] == "Internet is offline"


async def test_connectivity_startup_flicker_waits_for_configured_delay(hass):
    entity_id = "binary_sensor.internet_connection"
    hass.states.async_set(entity_id, "off", {
        "device_class": "connectivity", "friendly_name": "Internet",
    })
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["security"],
        "capability_sensors": {
            entity_id: {"capability": "connectivity"},
        },
    }

    assert registry.active_items(hass.states.get(entity_id), options) == []


async def test_appliance_cycle_is_discovered_configured_and_resolved(hass):
    machine = "sensor.utility_room_washer_state"
    remaining = "sensor.utility_room_washer_remaining"
    attributes = {
        "device_class": "enum",
        "friendly_name": "Utility Room Washer",
        "options": ["idle", "run", "complete"],
    }
    hass.states.async_set(machine, "run", attributes)
    hass.states.async_set(
        remaining, "00:12:00", {"unit_of_measurement": "min"}
    )
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["laundry"],
        "capability_sensors": {
            machine: {
                "capability": "appliance_cycle",
                "appliance_type": "washer",
                "complete_states": ["complete"],
                "idle_states": ["idle"],
                "remaining_entity": remaining,
                "priority": "activity",
            },
        },
    }

    assert (machine, "appliance_cycle") in {
        (item.entity_id, item.capability) for item in registry.discover(hass)
    }
    item = registry.active_items(
        hass.states.get(machine), options, hass
    )[0]
    assert item["message"] == "Utility Room Washer Running"
    assert item["detail"] == "Run · About 12 minutes remaining"
    assert item["icon"] == "mdi:washing-machine"

    hass.states.async_set(machine, "complete", attributes)
    resolved = registry.resolution_fields(
        hass.states.get(machine), options, item
    )
    assert resolved["message"] == "Utility Room Washer Cycle Complete"
    assert resolved["detail"] == "Utility Room Washer is ready"


async def test_maintenance_alert_is_selected_configured_and_resolved(hass):
    entity_id = "binary_sensor.dishwasher_cleaning_required"
    attributes = {
        "device_class": "problem",
        "friendly_name": "Dishwasher Cleaning",
    }
    hass.states.async_set(entity_id, "on", attributes)
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["maintenance"],
        "capability_sensors": {
            entity_id: {
                "capability": "maintenance_alert",
                "active_message": "Clean Dishwasher",
                "resolved_message": "Dishwasher Cleaning Complete",
                "icon": "mdi:dishwasher-alert",
            },
        },
    }

    assert (entity_id, "maintenance_alert") in {
        (item.entity_id, item.capability) for item in registry.discover(hass)
    }
    item = registry.active_items(hass.states.get(entity_id), options)[0]
    assert item["message"] == "Clean Dishwasher"
    assert item["icon"] == "mdi:dishwasher-alert"

    hass.states.async_set(entity_id, "off", attributes)
    resolved = registry.resolution_fields(
        hass.states.get(entity_id), options, item
    )
    assert resolved["message"] == "Dishwasher Cleaning Complete"
    assert resolved["priority"] == "normal"


async def test_any_entity_can_use_an_exact_state_trigger(hass):
    entity_id = "light.porch"
    hass.states.async_set(
        entity_id, "on", {"friendly_name": "Porch Light"}
    )
    registry = CapabilityProviderRegistry()
    options = {
        "capability_sensors": {
            entity_id: {
                "capability": "state_trigger",
                "trigger_state": "on",
                "display_name": "Outside Light",
                "active_message": "Outside Light Left On",
                "resolved_message": "Outside Light Turned Off",
                "display_route": "main_then_footer",
            },
        },
    }

    assert (entity_id, "state_trigger") in {
        (item.entity_id, item.capability) for item in registry.discover(hass)
    }
    item = registry.active_items(hass.states.get(entity_id), options)[0]
    assert item["message"] == "Outside Light Left On"
    assert item["display_name"] == "Outside Light"

    hass.states.async_set(entity_id, "off", {"friendly_name": "Porch Light"})
    assert registry.active_items(hass.states.get(entity_id), options) == []
    resolved = registry.resolution_fields(
        hass.states.get(entity_id), options, item
    )
    assert resolved["message"] == "Outside Light Turned Off"
    assert resolved["detail"] == "Outside Light is now off"


async def test_safety_capabilities_are_discovered_but_respect_provider_toggle(hass):
    entity_id = "binary_sensor.utility_co"
    hass.states.async_set(entity_id, "on", {
        "device_class": "carbon_monoxide", "friendly_name": "Utility CO",
    })
    registry = CapabilityProviderRegistry()

    discovered = registry.discover(hass)
    assert (entity_id, "carbon_monoxide") in {
        (item.entity_id, item.capability) for item in discovered
    }
    options = {
        "enabled_providers": ["climate"],
        "capability_sensors": {entity_id: {"capability": "carbon_monoxide"}},
    }
    assert registry.active_items(hass.states.get(entity_id), options) == []


async def test_availability_monitor_is_explicit_and_alerts_only_when_unavailable(hass):
    entity_id = "camera.driveway"
    hass.states.async_set("sensor.home_status", "Ready")
    hass.states.async_set(entity_id, "idle", {"friendly_name": "Driveway"})
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["security"],
        "capability_sensors": {entity_id: {"capability": "availability"}},
    }

    assert (entity_id, "availability") in {
        (item.entity_id, item.capability) for item in registry.discover(hass)
    }
    assert "sensor.home_status" not in {
        item.entity_id for item in registry.discover(hass)
    }
    assert registry.active_items(hass.states.get(entity_id), options) == []

    hass.states.async_set(
        entity_id, "unavailable", {"friendly_name": "Driveway"}
    )
    item = registry.active_items(hass.states.get(entity_id), options)[0]

    assert item["message"] == "Device Offline"
    assert item["detail"] == "Driveway is unavailable"
    assert item["id"] == "capability:availability:camera.driveway:unavailable"
    assert item["retention_minutes"] == 10


async def test_selected_contact_can_also_alert_while_open(hass):
    entity_id = "binary_sensor.back_door"
    hass.states.async_set(entity_id, "on", {
        "device_class": "door", "friendly_name": "Back Door",
    })
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["security"],
        "capability_sensors": {
            entity_id: {
                "capability": "availability", "alert_when_active": True,
                "display_name": "Bathroom Door",
            },
        },
    }

    item = registry.active_items(hass.states.get(entity_id), options)[0]

    assert item["message"] == "Bathroom Door"
    assert item["capability_message"] == "Door Open"
    assert item["display_name"] == "Bathroom Door"
    assert item["detail"] == "Bathroom Door is open"
    assert item["resolved_message"] == "Door Closed"
    assert item["resolved_detail"] == "Bathroom Door is closed"
    assert item["id"] == "capability:availability:binary_sensor.back_door:active"
    assert item["retention_minutes"] == 120
    assert item["display_route"] == "main_then_footer"
    assert item["main_until"] is not None
    assert item["footer_eligible"] is True


async def test_selected_motion_can_alert_while_active(hass):
    entity_id = "binary_sensor.living_room_motion"
    hass.states.async_set(entity_id, "on", {
        "device_class": "motion", "friendly_name": "Living Room Motion",
    })
    registry = CapabilityProviderRegistry()
    options = {
        "enabled_providers": ["security"],
        "capability_sensors": {
            entity_id: {
                "capability": "availability", "alert_when_active": True,
                "retention_minutes": 5,
                "display_route": "footer_only",
            },
        },
    }

    item = registry.active_items(hass.states.get(entity_id), options)[0]

    assert item["message"] == "Motion Detected"
    assert item["detail"] == "Living Room Motion"
    assert item["resolved_message"] == "Motion Detected"
    assert item["id"] == "capability:availability:binary_sensor.living_room_motion:active"
    assert item["retention_minutes"] == 5
    assert item["display_route"] == "footer_only"
    assert item["main_until"] is None
    assert item["footer_eligible"] is True
