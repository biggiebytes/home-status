from custom_components.home_status.source_registry import SourceRegistry


def test_discovered_role_sources_keep_their_provider_behavior():
    registry = SourceRegistry.from_config(
        {
            "maintenance_sensors": ["binary_sensor.hvac_filter_problem"],
            "family_calendar": ["calendar.household"],
            "laundry_state": ["sensor.utility_room_washer_state"],
        }
    )

    assert "binary_sensor.hvac_filter_problem" in registry.get("maintenance_sensors")
    assert "calendar.household" in registry.get("family_calendar")
    assert "sensor.utility_room_washer_state" in registry.get("laundry_state")


def test_live_security_entities_are_not_backend_notification_sources():
    registry = SourceRegistry.from_config(
        {"contact_sensors": ["binary_sensor.front_entry"]}
    )

    assert "binary_sensor.front_entry" not in registry.get("contact_sensors")
