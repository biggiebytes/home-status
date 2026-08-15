"""Discover non-device Home Status Sources from Home Assistant."""

from __future__ import annotations

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import entity_registry as er

from .source import HomeSource

_SOURCE_DOMAINS = {"weather", "calendar", "person", "zone", "sensor"}


def _name(entry, state) -> str:
    return str(
        entry.name
        or entry.original_name
        or (state.attributes.get("friendly_name") if state else None)
        or entry.entity_id
    )


def _kind(domain: str) -> str:
    return {
        "weather": "weather",
        "calendar": "calendar",
        "person": "location",
        "zone": "location",
    }[domain]


def _is_traffic_sensor(entry, state) -> bool:
    """Identify a travel-time sensor without promoting ordinary durations."""
    if entry.entity_id.split(".", 1)[0] != "sensor" or state is None:
        return False
    attrs = state.attributes
    device_class = str(
        attrs.get("device_class")
        or getattr(entry, "original_device_class", None)
        or ""
    ).casefold()
    platform = str(getattr(entry, "platform", "") or "").casefold()
    return device_class == "duration" and (
        platform == "waze_travel_time"
        or (attrs.get("origin") is not None and attrs.get("destination") is not None)
    )


def _is_utility_source_sensor(entry, state) -> bool:
    """Identify a provider-neutral utility sensor offered to Home Status."""
    return (
        entry.entity_id.split(".", 1)[0] == "sensor"
        and state is not None
        and str(state.attributes.get("home_status_source") or "").casefold()
        == "utility"
    )


def discover_sources(hass: HomeAssistant) -> list[HomeSource]:
    """Return user-facing non-device information sources."""
    entities = er.async_get(hass)
    areas = ar.async_get(hass)
    result: list[HomeSource] = []

    for entry in entities.entities.values():
        domain = entry.entity_id.split(".", 1)[0]
        if domain not in _SOURCE_DOMAINS:
            continue
        if entry.disabled_by is not None or getattr(entry, "hidden_by", None) is not None:
            continue

        state = hass.states.get(entry.entity_id)
        kind = _kind(domain) if domain != "sensor" else None
        if domain == "sensor":
            if _is_traffic_sensor(entry, state):
                kind = "traffic"
            elif _is_utility_source_sensor(entry, state):
                kind = "utility"
            else:
                continue
        area_id = getattr(entry, "area_id", None)
        area = areas.async_get_area(area_id) if area_id else None
        result.append(
            HomeSource(
                id=f"source:{entry.entity_id}",
                name=_name(entry, state),
                kind=kind,
                entity_id=entry.entity_id,
                domain=domain,
                area_id=area_id,
                area_name=area.name if area else None,
            )
        )

    return sorted(result, key=lambda item: (item.kind, item.name.casefold(), item.entity_id))
