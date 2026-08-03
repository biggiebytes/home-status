"""Diagnostics support for Home Status."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .providers import CapabilityProviderRegistry

TO_REDACT = {
    "access_token", "address", "api_key", "client_id", "client_secret",
    "code", "coordinates", "host", "latitude", "longitude", "password",
    "precise_location", "token", "unique_id",
    "url",
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """Return bounded provider diagnostics without precise locations."""
    options = {**entry.data, **entry.options}
    coordinator = getattr(entry, "runtime_data", None)
    registry = (
        getattr(coordinator, "capability_registry", None)
        or CapabilityProviderRegistry()
    )
    return async_redact_data({
        "entry": {
            "title": entry.title,
            "data": entry.data,
            "options": entry.options,
        },
        "capability_providers": registry.diagnostics(hass, options),
    }, TO_REDACT)
