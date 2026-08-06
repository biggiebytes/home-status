from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
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
    def _calendar_entity_ids(self) -> tuple[str, ...]:
        """Return calendar entities selected in integration settings."""
        if PROVIDER_SCHEDULE not in set(normalize_providers(
            self.options.get("enabled_providers")
        )):
            return ()
        configured = self.options.get("calendar_entities")
        if isinstance(configured, list):
            return tuple(
                entity_id for entity_id in configured
                if isinstance(entity_id, str)
                and entity_id.startswith("calendar.")
                and self.hass.states.get(entity_id) is not None
            )
        return tuple(
            entity_id
            for role in (
                "family_calendar", "waste_schedule", "sprinkler_schedule"
            )
            for entity_id in self._sources(role)
            if entity_id.startswith("calendar.")
        )

    async def _async_refresh_calendar_events(self) -> None:
        """Read all future events in the user-selected calendar window."""
        self._calendar_items = []
        entity_ids = self._calendar_entity_ids()
        if not entity_ids or not self.hass.services.has_service(
            "calendar", "get_events"
        ):
            return
        try:
            calendar_days = max(1, min(90, int(
                self.options.get("calendar_lookahead_days", 14)
            )))
        except (TypeError, ValueError):
            calendar_days = 14
        try:
            waste_days = max(0, min(30, int(
                self.options.get("waste_collection_window_days", 7)
            )))
        except (TypeError, ValueError):
            waste_days = 7
        lookahead_days = max(calendar_days, waste_days)
        now = dt_util.now()
        try:
            response = await self.hass.services.async_call(
                "calendar", "get_events",
                {
                    "start_date_time": now.isoformat(),
                    "end_date_time": (now + timedelta(days=lookahead_days)).isoformat(),
                },
                target={"entity_id": list(entity_ids)},
                blocking=True,
                return_response=True,
            )
        except Exception:
            _LOGGER.debug("Home Status calendar refresh failed", exc_info=True)
            return
        for entity_id, payload in (response or {}).items():
            for event in (payload or {}).get("events", []):
                if not isinstance(event, dict):
                    continue
                starts_at = self._calendar_event_start(event.get("start"))
                is_all_day = self._calendar_event_is_all_day(event.get("start"))
                if starts_at is None or (
                    starts_at < now and not (is_all_day and starts_at.date() == now.date())
                ):
                    continue
                title = str(event.get("summary") or "Calendar event").strip()
                if not title:
                    continue
                source, icon = self._calendar_event_source(entity_id, title)
                if source == "waste_calendar":
                    days_away = (starts_at.date() - now.date()).days
                    if days_away < 0 or days_away > waste_days:
                        continue
                    if "pickup" not in title.casefold():
                        title = f"{title} pickup"
                elif source == "calendar" and starts_at > now + timedelta(days=calendar_days):
                    continue
                self._calendar_items.append(self._stream_item(
                    f"upcoming:calendar:{entity_id}:{starts_at.isoformat()}:{title}",
                    title,
                    self._format_calendar_event_time(starts_at, is_all_day),
                    PROVIDER_SCHEDULE,
                    icon,
                    "normal",
                    starts_at.isoformat(),
                    entity_id=entity_id,
                    source="calendar",
                ))
        self._calendar_items.sort(key=lambda item: item.get("timestamp") or "")

    def _calendar_event_source(self, entity_id: str, title: str) -> tuple[str, str]:
        """Preserve waste and irrigation meaning for calendar-backed sources."""
        if entity_id in self._sources("waste_schedule"):
            label = title.casefold()
            if "recycl" in label:
                return "waste_calendar", "mdi:recycle"
            if "yard" in label or "garden" in label or "green" in label:
                return "waste_calendar", "mdi:leaf"
            return "waste_calendar", "mdi:trash-can"
        if entity_id in self._sources("sprinkler_schedule"):
            return "sprinkler_calendar", "mdi:sprinkler"
        return "calendar", "mdi:calendar-clock"

    @staticmethod
    def _calendar_event_start(value) -> datetime | None:
        """Normalize calendar date-only and timestamp starts."""
        if isinstance(value, datetime):
            parsed = value
        elif isinstance(value, date):
            parsed = datetime.combine(value, time.min)
        else:
            raw = str(value or "").strip()
            if not raw:
                return None
            try:
                parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                try:
                    parsed = datetime.combine(date.fromisoformat(raw), time.min)
                except ValueError:
                    return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
        return dt_util.as_local(parsed)

    @staticmethod
    def _calendar_event_is_all_day(value) -> bool:
        return (
            isinstance(value, date) and not isinstance(value, datetime)
        ) or bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(value or "").strip()))

    @staticmethod
    def _format_calendar_event_time(starts_at: datetime, is_all_day: bool) -> str:
        if is_all_day:
            return starts_at.strftime("%A, %B %d").replace(" 0", " ")
        return starts_at.strftime("%A at %I:%M %p").replace(" at 0", " at ")

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


    def _waste_collection_is_due(self, state: State) -> bool:
        """Return true when collection falls inside the configured window."""
        collection_date = self._waste_collection_date(state)
        if collection_date is None:
            return False
        try:
            window_days = max(0, min(30, int(
                self.options.get("waste_collection_window_days", 7)
            )))
        except (TypeError, ValueError):
            window_days = 7
        today = datetime.now().astimezone().date()
        return 0 <= (collection_date - today).days <= window_days


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

