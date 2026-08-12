"""Diagnostics for discovery-first Home Status."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict:
    coordinator = entry.runtime_data
    data = coordinator.data or {}
    native = data.get("native", {}) if isinstance(data.get("native"), dict) else {}
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
        "native_current_count": len(native.get("current", [])),
        "native_recent_count": len(native.get("recent", [])),
        "native_awareness_count": len(native.get("awareness", [])),
        "health": data.get("health", "normal"),
    }
