"""Diagnostics for discovery-first Home Status."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict:
    coordinator = entry.runtime_data
    data = coordinator.data or {}
    return {
        "selected_entities": list(
            entry.options.get("selected_entities", entry.data.get("selected_entities", []))
        ),
        "selected_devices": list(
            entry.options.get("selected_devices", entry.data.get("selected_devices", []))
        ),
        "selected_sources": list(
            entry.options.get("selected_sources", entry.data.get("selected_sources", []))
        ),
        "name_override_count": len(entry.options.get("name_overrides", {})),
        "entity_name_override_count": len(entry.options.get("entity_name_overrides", {})),
        "observed_entity_count": len(getattr(coordinator, "_observed", ())),
        "active_count": data.get("active_count", 0),
        "health": data.get("health", "normal"),
        "left_count": len(data.get("left", [])),
        "right_count": len(data.get("right", [])),
        "bottom_count": len(data.get("bottom", [])),
        "recent_count": len(data.get("recent", [])),
    }
