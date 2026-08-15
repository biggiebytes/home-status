"""Utility-source presentation contracts."""

from types import SimpleNamespace

from custom_components.home_status.source import HomeSource
from custom_components.home_status.source_interpreters import interpret_source
from custom_components.home_status.source_discovery import _is_utility_source_sensor


def test_only_marked_sensors_are_discovered_as_utility_sources():
    utility_state = SimpleNamespace(attributes={"home_status_source": "utility"})
    ordinary_state = SimpleNamespace(attributes={})

    assert _is_utility_source_sensor(
        SimpleNamespace(entity_id="sensor.utility_balance_due"), utility_state
    )
    assert not _is_utility_source_sensor(
        SimpleNamespace(entity_id="sensor.other_balance_due"), ordinary_state
    )
    assert not _is_utility_source_sensor(
        SimpleNamespace(entity_id="binary_sensor.utility_connected"), utility_state
    )
from custom_components.home_status.source_interpreters import interpret_source


def test_utility_balance_is_presented_as_a_compact_awareness_item(hass):
    hass.states.async_set(
        "sensor.utility_balance_due",
        "550",
        {"device_class": "monetary", "unit_of_measurement": "USD"},
    )
    source = HomeSource(
        id="source:sensor.utility_balance_due",
        name="Balance Due",
        kind="utility",
        entity_id="sensor.utility_balance_due",
        domain="sensor",
    )

    items = interpret_source(hass, source)

    assert len(items) == 1
    assert items[0]["title"] == "Balance Due: $550.00"
    assert items[0]["summary"] == "Utility account"
    assert items[0]["category"] == "utility"
    assert items[0]["icon"] == "mdi:cash"
    assert items[0]["stream_preference"] == "footer"


def test_utility_usage_and_due_date_keep_their_units(hass):
    hass.states.async_set(
        "sensor.utility_water_current_billing_period_usage",
        "4718.6",
        {"device_class": "volume", "unit_of_measurement": "gal"},
    )
    usage = HomeSource(
        id="source:sensor.utility_water_current_billing_period_usage",
        name="Water Current Billing Period Usage",
        kind="utility",
        entity_id="sensor.utility_water_current_billing_period_usage",
        domain="sensor",
    )
    hass.states.async_set(
        "sensor.utility_bill_due_date",
        "2026-08-20",
        {"device_class": "date"},
    )
    due_date = HomeSource(
        id="source:sensor.utility_bill_due_date",
        name="Bill Due Date",
        kind="utility",
        entity_id="sensor.utility_bill_due_date",
        domain="sensor",
    )

    usage_items = interpret_source(hass, usage)
    due_date_items = interpret_source(hass, due_date)

    assert usage_items[0]["title"] == "Water Current Billing Period Usage: 4,718.60 gal"
    assert usage_items[0]["icon"] == "mdi:water"
    assert due_date_items[0]["title"] == "Bill Due Date: Thu, Aug 20"
    assert due_date_items[0]["icon"] == "mdi:calendar-clock"
