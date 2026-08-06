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
    PROVIDER_CAMERAS,
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


class CameraProviderMixin:
    def _camera_health_groups(self) -> dict[str, tuple[str, ...]]:
        """Group enabled camera streams by their physical HA device."""
        groups: dict[str, list[str]] = {}
        registry = er.async_get(self.hass)
        for entry in registry.entities.values():
            if (
                entry.domain != "camera"
                or entry.disabled_by is not None
                or entry.device_id is None
            ):
                continue
            groups.setdefault(entry.device_id, []).append(entry.entity_id)
        return {
            device_id: tuple(sorted(entity_ids))
            for device_id, entity_ids in groups.items()
        }


    def _camera_health_entity_ids(self) -> tuple[str, ...]:
        return tuple(
            entity_id
            for entity_ids in self._camera_health_groups().values()
            for entity_id in entity_ids
        )


    def _build_camera_health_item(self) -> dict | None:
        """Build one alert for physical cameras whose streams are all offline."""
        offline: list[tuple[str, str, State]] = []
        for entity_ids in self._camera_health_groups().values():
            states = [
                state for entity_id in entity_ids
                if (state := self.hass.states.get(entity_id)) is not None
            ]
            if not states or not all(
                str(state.state).casefold() == "unavailable"
                for state in states
            ):
                continue
            owner = min(entity_ids, key=self._camera_entity_rank)
            owner_state = self.hass.states.get(owner) or states[0]
            offline.append((
                owner,
                self._camera_name(owner, owner_state),
                min(states, key=lambda state: state.last_changed),
            ))
        if not offline:
            return None

        offline.sort(key=lambda item: item[1].casefold())
        names = [name for _, name, _ in offline]
        message = (
            f"{names[0]} Camera Offline"
            if len(names) == 1
            else f"{len(names)} Cameras Offline"
        )
        now = datetime.now(timezone.utc)
        ticker_minutes = max(1, int(self.options.get("ticker_event_minutes", 10)))
        reminder_minutes = max(0, int(self.options.get("ticker_reminder_minutes", 45)))
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, _, state in offline
        )
        return {
            "id": f"{DOMAIN}:camera_health",
            "entity_id": offline[0][0],
            "event_type": "camera_offline",
            "behavior": "fault",
            "message": message,
            "detail": ", ".join(names),
            "offline_names": names,
            "category": PROVIDER_CAMERAS,
            "provider": PROVIDER_CAMERAS,
            "priority": "critical",
            "icon": "mdi:cctv-off",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=ticker_minutes)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=reminder_minutes)).isoformat() if reminder_minutes else None,
            "persistent": True,
            "hero_eligible": True,
            "state": "unavailable",
        }


    @staticmethod
    def _camera_entity_rank(entity_id: str) -> tuple[int, int, str]:
        duplicate_suffix = bool(re.search(
            r"_(?:fluent|clear|snapshot|sub(?:stream)?|main(?:stream)?)$",
            entity_id,
            re.IGNORECASE,
        ))
        return (1 if duplicate_suffix else 0, len(entity_id), entity_id)


    @staticmethod
    def _camera_name(entity_id: str, state: State) -> str:
        name = plain_entity_name(
            entity_id, state.attributes.get("friendly_name")
        )
        name = re.sub(
            r"\s+(?:fluent|clear|snapshot|substream|mainstream)$",
            "",
            name,
            flags=re.IGNORECASE,
        )
        return re.sub(r"\s+camera$", "", name, flags=re.IGNORECASE).strip()

