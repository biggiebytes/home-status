from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
import re

from homeassistant.components.weather import WeatherEntityFeature
from homeassistant.core import Event, State
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from ..const import (
    ALARM_ENTITY,
    APPLIANCE_CYCLES,
    APPLIANCE_MAINTENANCE,
    DOMAIN,
    EASYSTART_DIAGNOSTIC_DETAILS,
    EASYSTART_FAULT_COUNTER,
    PROVIDER_CLIMATE,
    PROVIDER_FAMILY,
    PROVIDER_LAUNDRY,
    PROVIDER_MAINTENANCE,
    PROVIDER_SCHEDULE,
    PROVIDER_SECURITY,
    PROVIDER_WEATHER,
    SYSTEM_UPDATES,
    normalize_providers,
    plain_entity_name,
)

_LOGGER = logging.getLogger(__name__)
ALARM_STATES = {
    "disarmed", "armed_home", "armed_away", "armed_night", "arming",
    "pending", "triggered",
}


class FamilyProviderMixin:
    def _presence_entity_ids(self) -> tuple[str, ...]:
        """Return enabled household person entities when Family is selected."""
        enabled = set(normalize_providers(
            self.options.get("enabled_providers")
        ))
        if PROVIDER_FAMILY not in enabled:
            return ()
        discovered = [
            state.entity_id for state in self.hass.states.async_all("person")
        ]
        registry = er.async_get(self.hass)
        registered = [
            entry.entity_id for entry in registry.entities.values()
            if entry.domain == "person" and entry.disabled_by is None
        ]
        return tuple(dict.fromkeys([*discovered, *registered]))


    def _build_presence_status_item(self) -> dict | None:
        """Build one quiet household location summary."""
        people = []
        for entity_id in self._presence_entity_ids():
            state = self.hass.states.get(entity_id)
            if not state or str(state.state).casefold() in {
                "unknown", "unavailable", "",
            }:
                continue
            people.append((
                entity_id,
                self._plain_entity_name(
                    entity_id, state.attributes.get("friendly_name")
                ),
                self._presence_location_label(state.state),
                state,
            ))
        if not people:
            return None

        people.sort(key=lambda item: item[1].casefold())
        home = [name for _, name, location, _ in people if location == "Home"]
        away = [
            (name, location)
            for _, name, location, _ in people
            if location != "Home"
        ]
        if len(home) == len(people):
            title = "Everyone Home"
            summary = self._join_names(home)
            priority = "normal"
            icon = "mdi:home-account"
        elif not home:
            title = "Everyone Away"
            summary = " • ".join(
                f"{name}: {location}" for name, location in away
            )
            priority = "activity"
            icon = "mdi:home-export-outline"
        else:
            title = f"{len(home)} of {len(people)} Home"
            away_summary = ", ".join(
                f"{name}: {location}" for name, location in away
            )
            summary = (
                f"Home: {self._join_names(home)}"
                f" • {away_summary}"
            )
            priority = "activity"
            icon = "mdi:account-group"
        changed = max(
            state.last_changed for _, _, _, state in people
        ).isoformat()
        return self._stream_item(
            f"current:{PROVIDER_FAMILY}",
            title,
            summary,
            PROVIDER_FAMILY,
            icon,
            priority,
            changed,
            entity_id=people[0][0],
            source="family_presence",
        )


    @staticmethod
    def _presence_location_label(value: str) -> str:
        normalized = str(value or "").strip().replace("_", " ")
        if normalized.casefold() == "not home":
            return "Away"
        if normalized.casefold() == "home":
            return "Home"
        return normalized.title() or "Away"


    @staticmethod
    def _join_names(names: list[str]) -> str:
        if len(names) < 2:
            return names[0] if names else ""
        if len(names) == 2:
            return f"{names[0]} and {names[1]}"
        return f"{', '.join(names[:-1])}, and {names[-1]}"

