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


class LaundryProviderMixin:
    def _build_appliance_cycle_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Build one combined state and remaining-time item per appliance."""
        config = APPLIANCE_CYCLES.get(entity_id)
        if not config:
            return None
        value = str(state.state or "").strip()
        normalized = value.casefold()
        if normalized in {
            "", "unknown", "unavailable", "off", "idle", "ready",
            "complete", "completed", "finished", "done", "end", "power_off",
        }:
            return None
        name = config["name"]
        remaining_state = self.hass.states.get(config["remaining"])
        minutes = self._remaining_minutes(remaining_state)
        phase = value.replace("_", " ").replace("-", " ").title()
        details = [phase]
        if minutes is not None and minutes > 0:
            details.append(f"About {max(1, round(minutes))} minutes remaining")
        return {
            "id": f"{DOMAIN}:appliance_cycle:{entity_id}",
            "entity_id": entity_id,
            "event_type": "appliance_cycle",
            "behavior": "activity",
            "message": f"{name} Running",
            "detail": " · ".join(details),
            "category": PROVIDER_LAUNDRY,
            "provider": PROVIDER_LAUNDRY,
            "priority": "activity",
            "icon": config["icon"],
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }


    def _build_appliance_maintenance_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish dishwasher maintenance only while action is required."""
        config = APPLIANCE_MAINTENANCE.get(entity_id)
        if not config or str(state.state).casefold() != "on":
            return None
        return {
            "id": f"{DOMAIN}:appliance_maintenance:{entity_id}",
            "entity_id": entity_id,
            "event_type": "appliance_maintenance",
            "behavior": "maintenance",
            "message": config["message"],
            "detail": config["detail"],
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": config["icon"],
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }


    @staticmethod
    def _remaining_minutes(state: State | None) -> float | None:
        """Return a remaining-time sensor value as minutes."""
        if not state or str(state.state).casefold() in {
            "", "unknown", "unavailable", "none",
        }:
            return None
        value = str(state.state).strip()
        try:
            amount = float(value)
            unit = str(
                state.attributes.get("unit_of_measurement") or "min"
            ).casefold()
            if unit in {"s", "sec", "second", "seconds"}:
                return amount / 60
            if unit in {"h", "hr", "hour", "hours"}:
                return amount * 60
            return amount
        except (TypeError, ValueError):
            pass
        parts = value.split(":")
        if len(parts) in {2, 3}:
            try:
                numbers = [float(part) for part in parts]
            except ValueError:
                return None
            if len(numbers) == 2:
                hours, minutes = numbers
                return hours * 60 + minutes
            hours, minutes, seconds = numbers
            return hours * 60 + minutes + seconds / 60
        return None

