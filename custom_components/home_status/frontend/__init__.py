"""Register the bundled Home Status frontend."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

from ..const import JSMODULES, URL_BASE

_LOGGER = logging.getLogger(__name__)


class JSModuleRegistration:
    """Serve and register Home Status JavaScript modules."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")

    async def async_register(self) -> None:
        await self._async_register_path()
        if self.lovelace is None:
            return
        mode = getattr(self.lovelace, "mode", getattr(self.lovelace, "resource_mode", "yaml"))
        if mode == "storage":
            await self._async_wait_for_resources()

    async def _async_register_path(self) -> None:
        try:
            await self.hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, Path(__file__).parent, False)]
            )
        except RuntimeError:
            # Another Home Status setup may already own the same static route.
            pass

    async def _async_wait_for_resources(self) -> None:
        async def _check(_now: Any) -> None:
            resources = getattr(self.lovelace, "resources", None)
            if resources is None:
                return
            if getattr(resources, "loaded", False):
                await self._async_register_modules()
            else:
                async_call_later(self.hass, 2, _check)

        await _check(None)

    async def _async_register_modules(self) -> None:
        resources = self.lovelace.resources
        existing = [
            item for item in resources.async_items()
            if str(item.get("url", "")).split("?", 1)[0].startswith(URL_BASE + "/")
        ]
        for module in JSMODULES:
            base_url = f"{URL_BASE}/{module['filename']}"
            versioned_url = f"{base_url}?v={module['version']}"
            match = next(
                (item for item in existing if str(item.get("url", "")).split("?", 1)[0] == base_url),
                None,
            )
            if match is None:
                await resources.async_create_item({"res_type": "module", "url": versioned_url})
            elif str(match.get("url", "")) != versioned_url:
                await resources.async_update_item(
                    match["id"],
                    {"res_type": "module", "url": versioned_url},
                )
