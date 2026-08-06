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


class MaintenanceProviderMixin:
    def _build_filter_maintenance_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish one refrigerator water-filter reminder without duplicates."""
        status_entity = next(iter(self._sources("filter_status")), None)
        status_state = (
            self.hass.states.get(status_entity) if status_entity else None
        )
        status_active = (
            status_state is not None
            and str(status_state.state).casefold() == "on"
        )
        is_status = entity_id == status_entity
        if is_status:
            if not status_active:
                return None
            summary = "The refrigerator reports that its water filter needs attention"
        else:
            if status_active:
                return None
            try:
                usage = float(state.state)
            except (TypeError, ValueError):
                return None
            if usage < 90:
                return None
            unit = str(state.attributes.get("unit_of_measurement") or "%").strip()
            summary = f"Water filter usage is {state.state}{unit}"
        now = datetime.now(timezone.utc)
        ticker_minutes = max(1, int(self.options.get("ticker_event_minutes", 10)))
        reminder_minutes = max(0, int(self.options.get("ticker_reminder_minutes", 45)))
        return {
            "id": f"{DOMAIN}:refrigerator_water_filter",
            "entity_id": entity_id,
            "event_type": "filter_maintenance",
            "behavior": "maintenance",
            "message": "Replace Refrigerator Water Filter",
            "detail": summary,
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": "mdi:water-sync",
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=ticker_minutes)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=reminder_minutes)).isoformat() if reminder_minutes else None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }


    def _build_system_update_item(self) -> dict | None:
        """Build one maintenance item for core Home Assistant updates."""
        updates: list[tuple[str, str, str, State]] = []
        for entity_id in self._sources("system_updates"):
            state = self.hass.states.get(entity_id)
            if not state or str(state.state).casefold() != "on":
                continue
            name = SYSTEM_UPDATES.get(
                entity_id, self._plain_entity_name(
                    entity_id, state.attributes.get("friendly_name")
                )
            )
            latest = str(
                state.attributes.get("latest_version")
                or state.attributes.get("latest")
                or ""
            ).strip()
            updates.append((entity_id, name, latest, state))
        if not updates:
            return None

        updates.sort(key=lambda item: item[1].casefold())
        if len(updates) == 1:
            message = f"{updates[0][1]} Update Available"
        else:
            message = f"{len(updates)} Home Assistant Updates Available"
        detail = ", ".join(
            f"{name} {latest}".strip()
            for _, name, latest, _ in updates
        )
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, _, _, state in updates
        )
        return {
            "id": f"{DOMAIN}:system_updates",
            "entity_id": updates[0][0],
            "event_type": "system_updates",
            "behavior": "maintenance",
            "message": message,
            "detail": detail,
            "active_entities": [
                entity_id for entity_id, _, _, _ in updates
            ],
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": "mdi:update",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": "on",
        }


    def _build_refrigerator_door_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish a refrigerator door only after it has remained open."""
        if str(state.state).casefold() not in {"on", "open", "opening"}:
            return None
        delay = max(
            1, int(self.options.get("refrigerator_door_delay_minutes", 3))
        )
        changed = state.last_changed.astimezone(timezone.utc)
        if datetime.now(timezone.utc) - changed < timedelta(minutes=delay):
            return None
        location = "Freezer" if "freezer" in entity_id else "Refrigerator"
        return self._refrigerator_safety_item(
            entity_id=entity_id,
            state=state,
            event_type="refrigerator_door_alert",
            message=f"{location} Door Left Open",
            detail=f"Open for more than {delay} minutes",
            icon="mdi:fridge-alert-outline",
            created_at=changed,
            priority="attention",
        )


    def _build_refrigerator_temperature_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish only sustained unsafe refrigerator temperatures."""
        try:
            temperature = float(state.state)
        except (TypeError, ValueError):
            return None
        freezer = "freezer" in entity_id
        threshold_f = float(self.options.get(
            "refrigerator_freezer_high_temperature" if freezer
            else "refrigerator_fridge_high_temperature",
            10 if freezer else 42,
        ))
        unit = str(state.attributes.get("unit_of_measurement") or "°F")
        threshold = (
            (threshold_f - 32) * 5 / 9
            if "c" in unit.casefold()
            else threshold_f
        )
        tracker = getattr(self, "_condition_since", None)
        if tracker is None:
            tracker = self._condition_since = {}
        if temperature <= threshold:
            tracker.pop(entity_id, None)
            return None
        now = datetime.now(timezone.utc)
        ticker_minutes = max(1, int(self.options.get("ticker_event_minutes", 10)))
        reminder_minutes = max(0, int(self.options.get("ticker_reminder_minutes", 45)))
        started = tracker.setdefault(entity_id, now)
        delay = max(
            1,
            int(
                self.options.get(
                    "refrigerator_temperature_delay_minutes", 10
                )
            ),
        )
        if now - started < timedelta(minutes=delay):
            return None
        location = "Freezer" if freezer else "Refrigerator"
        return self._refrigerator_safety_item(
            entity_id=entity_id,
            state=state,
            event_type="refrigerator_temperature_alert",
            message=f"{location} Temperature High",
            detail=f"{state.state}{unit} · Safe limit {threshold_f:g}°F",
            icon="mdi:thermometer-alert",
            created_at=started,
            priority="critical",
        )


    def _refrigerator_safety_item(
        self,
        *,
        entity_id: str,
        state: State,
        event_type: str,
        message: str,
        detail: str,
        icon: str,
        created_at: datetime,
        priority: str,
    ) -> dict:
        now = datetime.now(timezone.utc)
        return {
            "id": f"{DOMAIN}:{entity_id}",
            "entity_id": entity_id,
            "event_type": event_type,
            "behavior": "fault",
            "message": message,
            "detail": detail,
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": priority,
            "icon": icon,
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=ticker_minutes)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=reminder_minutes)).isoformat() if reminder_minutes else None,
            "persistent": True,
            "hero_eligible": True,
            "state": state.state,
        }

