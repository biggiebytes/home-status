"""Traffic-source presentation contracts."""

from custom_components.home_status.source import HomeSource
from custom_components.home_status.source_interpreters import interpret_source


def test_waze_travel_time_uses_source_name_without_address_details(hass):
    hass.states.async_set(
        "sensor.downtown_traffic",
        "18.4",
        {
            "device_class": "duration",
            "unit_of_measurement": "min",
            "origin": "28.1234,-81.5678",
            "destination": "123 Private Street",
            "route": "Private Route",
        },
    )
    source = HomeSource(
        id="source:sensor.downtown_traffic",
        name="Downtown",
        kind="traffic",
        entity_id="sensor.downtown_traffic",
        domain="sensor",
    )

    items = interpret_source(hass, source)

    assert len(items) == 1
    assert items[0]["title"] == "Downtown: 18 min"
    assert items[0]["summary"] == "Travel time"
    assert items[0]["category"] == "traffic"
    assert items[0]["icon"] == "mdi:car-clock"
    assert "Private" not in str(items[0])
