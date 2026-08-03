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


class ScheduleProviderMixin:
    def _build_sprinkler_watering_item(
        self, entity_id: str
    ) -> dict | None:
        """Build one grouped item for all currently watering sprinkler zones."""
        sources = self._sources("sprinkler_valves")
        owner = next(
            (
                source for source in sources
                if (
                    (state := self.hass.states.get(source)) is not None
                    and str(state.state).casefold()
                    not in {"unknown", "unavailable"}
                )
            ),
            None,
        )
        if entity_id != owner:
            return None
        active = []
        for source in sources:
            state = self.hass.states.get(source)
            if not state or str(state.state).casefold() not in {
                "open", "opening", "on",
            }:
                continue
            active.append((source, state))
        if not active:
            return None
        zone_names = [self._sprinkler_zone_name(source) for source, _ in active]
        message = (
            f"Watering {zone_names[0]}"
            if len(zone_names) == 1
            else f"Watering {len(zone_names)} Zones"
        )
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, state in active
        )
        return {
            "id": f"{DOMAIN}:sprinkler_watering",
            "entity_id": owner,
            "event_type": "sprinkler_watering",
            "behavior": "activity",
            "message": message,
            "detail": ", ".join(zone_names),
            "category": PROVIDER_SCHEDULE,
            "provider": PROVIDER_SCHEDULE,
            "priority": "activity",
            "icon": "mdi:sprinkler-variant",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": "open",
        }


    @staticmethod
    def _sprinkler_zone_name(entity_id: str) -> str:
        match = re.search(r"zone[_\s-]*(\d+)", entity_id, re.IGNORECASE)
        return f"Zone {match.group(1)}" if match else plain_entity_name(entity_id)


    @staticmethod
    def _format_calendar_event(state: State) -> str:
        """Format the current or next calendar event for the schedule stream."""
        attributes = state.attributes
        start_value = attributes.get("start_time")
        end_value = attributes.get("end_time")
        all_day = bool(attributes.get("all_day"))
        location = str(attributes.get("location") or "").strip()
        now = dt_util.now()

        def parse_local(value):
            parsed = dt_util.parse_datetime(str(value)) if value else None
            if parsed is None and value:
                try:
                    parsed = datetime.fromisoformat(
                        str(value).replace("Z", "+00:00")
                    )
                except (TypeError, ValueError):
                    return None
            if parsed is None:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
            return dt_util.as_local(parsed)

        start = parse_local(start_value)
        end = parse_local(end_value)

        if start is None:
            when = "Scheduled"
        elif all_day:
            if start.date() == now.date():
                when = "Today • All day"
            elif start.date() == (now + timedelta(days=1)).date():
                when = "Tomorrow • All day"
            else:
                when = f"{start.strftime('%A, %B %d').replace(' 0', ' ')} • All day"
        elif state.state == "on":
            when = (
                f"Now • Until {end.strftime('%I:%M %p').lstrip('0')}"
                if end is not None
                else "Happening now"
            )
        else:
            clock = start.strftime("%I:%M %p").lstrip("0")
            if start.date() == now.date():
                when = f"Today at {clock}"
            elif start.date() == (now + timedelta(days=1)).date():
                when = f"Tomorrow at {clock}"
            else:
                date_label = start.strftime("%A, %B %d").replace(" 0", " ")
                when = f"{date_label} at {clock}"

        return " • ".join(part for part in (when, location) if part)


    @staticmethod
    def _format_schedule_value(value: str) -> str:
        try:
            date = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
            return date.strftime("%A at %I:%M %p").replace(" at 0", " at ")
        except (TypeError, ValueError):
            return str(value)


    @classmethod
    def _waste_collection_is_due(cls, state: State) -> bool:
        """Return true only for a collection due today or tomorrow."""
        collection_date = cls._waste_collection_date(state)
        if collection_date is None:
            return False
        today = datetime.now().astimezone().date()
        return 0 <= (collection_date - today).days <= 1


    @staticmethod
    def _waste_collection_date(state: State):
        """Return a valid next collection date from state or attributes."""
        value = str(state.state or "").strip()
        lowered = value.lower()
        if lowered in {"unknown", "unavailable", "none", ""}:
            return None
        today = datetime.now().astimezone().date()
        if re.search(r"\btoday\b", lowered):
            return today
        if re.search(r"\btomorrow\b", lowered):
            return today + timedelta(days=1)
        days_match = re.search(
            r"\b(?:in\s+)?(-?\d+)\s+days?\b", lowered
        )
        if days_match:
            days = int(days_match.group(1))
            return today + timedelta(days=days) if days >= 0 else None

        for key in ("days_until", "days_to", "days"):
            raw_days = state.attributes.get(key)
            try:
                days = int(raw_days)
                return today + timedelta(days=days) if days >= 0 else None
            except (TypeError, ValueError):
                continue

        candidates = [
            value,
            *(
                state.attributes.get(key)
                for key in (
                    "date",
                    "next_date",
                    "next_collection",
                    "collection_date",
                )
            ),
        ]
        for candidate in candidates:
            if candidate in (None, ""):
                continue
            candidate_value = re.sub(
                r"^\s*on\s+",
                "",
                str(candidate),
                flags=re.IGNORECASE,
            )
            try:
                collection = datetime.fromisoformat(
                    candidate_value.replace("Z", "+00:00")
                )
                if collection.tzinfo is not None:
                    collection_date = collection.astimezone().date()
                else:
                    collection_date = collection.date()
            except (TypeError, ValueError):
                try:
                    collection_date = datetime.strptime(
                        candidate_value,
                        "%Y-%m-%d",
                    ).date()
                except (TypeError, ValueError):
                    try:
                        collection_date = datetime.strptime(
                            candidate_value,
                            "%a, %d.%m.%Y",
                        ).date()
                    except (TypeError, ValueError):
                        continue
            return collection_date if collection_date >= today else None
        return None

