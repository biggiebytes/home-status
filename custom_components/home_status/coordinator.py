"""Clean discovery-first Home Status coordinator.

No category-driven routing or legacy source registry.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import DOMAIN
from .engine import HomeStatusEngine
from .presentation import place_items
from .presentation_config import presentation_preferences

_LOGGER = logging.getLogger(__name__)

_STORE_VERSION = 1
_STORE_KEY = f"{DOMAIN}.history_v2"


class HomeStatusCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinate selected Home Devices and publish one normalized Home Status snapshot."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN)
        self.entry = entry
        self.options = {**entry.data, **entry.options}
        self.engine = HomeStatusEngine(hass)
        self.store = Store(hass, _STORE_VERSION, _STORE_KEY)

        self.active: dict[str, dict[str, Any]] = {}
        self.history: list[dict[str, Any]] = []

        self._unsub_state = None
        self._unsub_timer = None
        self._observed: tuple[str, ...] = ()

    async def async_setup(self) -> None:
        stored = await self.store.async_load() or {}
        events = stored.get("events", [])
        self.history = self._retained_history(events if isinstance(events, list) else [])
        self._reconfigure_subscription()
        self._publish()
        self._configure_timer()

    def async_unload(self) -> None:
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None

    @callback
    def async_update_entities(self, _entity_ids: list[str] | None = None) -> None:
        """Compatibility entry point used by existing Home Status setup code."""
        self.options = {**self.entry.data, **self.entry.options}
        self._reconfigure_subscription()
        self._publish()

    def _configure_timer(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
        try:
            seconds = max(15, int(self.options.get("refresh_interval", 60)))
        except (TypeError, ValueError):
            seconds = 60
        self._unsub_timer = async_track_time_interval(
            self.hass, self._timer_tick, timedelta(seconds=seconds)
        )

    def _reconfigure_subscription(self) -> None:
        observed = self.engine.observed_entity_ids(self.options)
        if observed == self._observed and self._unsub_state:
            return
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        self._observed = observed
        if observed:
            self._unsub_state = async_track_state_change_event(
                self.hass, list(observed), self._state_changed
            )

    async def _timer_tick(self, _now) -> None:
        self.options = {**self.entry.data, **self.entry.options}
        self._reconfigure_subscription()
        self._publish()

    @callback
    def _state_changed(self, _event: Event) -> None:
        self._publish()

    def _publish(self) -> None:
        new_items = self.engine.build_active_items(self.options)
        new_active = {str(item["id"]): item for item in new_items if item.get("active")}
        previous = self.active

        # Preserve the original start time while an event remains active.
        for item_id, item in new_active.items():
            old = previous.get(item_id)
            if old:
                item["created_at"] = old.get("created_at", item.get("created_at"))

        resolved: list[dict[str, Any]] = []
        for item_id, old in previous.items():
            if item_id in new_active:
                continue
            item = self._resolve(old)
            if item is not None:
                resolved.append(item)

        if resolved:
            self.history = self._retained_history([*resolved, *self.history])
            self.hass.async_create_task(
                self.store.async_save({"events": self.history})
            )

        self.active = new_active
        self.history = self._retained_history([
            self._apply_current_display_name(item) for item in self.history
        ])

        active = self._sorted(list(self.active.values()))
        recent = self._recent_for_bottom(self.history)
        awareness = self.engine.build_awareness_items(self.options)

        left, right, bottom = place_items(active, recent, awareness, self.options)

        priority = self._priority(active)
        weather_effect = self._weather_visual_effect(awareness)

        self.async_set_updated_data({
            "health": priority,
            "priority": priority,
            "active_count": len(active),
            "active": active,
            "recent": self.history,
            "left": left,
            "right": right,
            "bottom": bottom,
            # Temporary aliases for the current card only.
            "hero": left,
            "sidebar": right,
            "footer": bottom,
            "weather_visual_effect": weather_effect,
            "display": {
                "rotation_seconds": self._int_option("rotation_seconds", 6, minimum=1),
                "media_enabled": bool(self.options.get("media_enabled", True)),
            },
            "presentation": presentation_preferences(self.options),
            "last_updated": self._now(),
        })

    def _resolve(self, old: dict[str, Any]) -> dict[str, Any] | None:
        """Turn one active HomeDevice event into one recent event."""
        event_type = str(old.get("event_type") or "")
        entity_id = str(old.get("entity_id") or "")
        state = self.hass.states.get(entity_id)
        name = (
            old.get("entity_name")
            or self.engine.display_name_for_item(self.options, old)
            or self._friendly_name(entity_id, state, old)
        )

        # Motion ending is intentionally silent.
        if event_type == "presence":
            return None

        item = dict(old)
        item.update({
            "active": False,
            "priority": "normal",
            "resolved_at": self._now(),
        })

        if event_type == "contact":
            item.update({
                "message": f"{name} Closed",
                "summary": f"{name} is closed",
                "detail": f"{name} is closed",
                "icon": "mdi:door-closed",
            })
        elif event_type == "lock":
            item.update({
                "message": f"{name} Locked",
                "summary": f"{name} is locked",
                "detail": f"{name} is locked",
                "icon": "mdi:lock",
            })
        elif event_type == "connectivity":
            item.update({
                "message": f"{name} Back Online",
                "summary": f"{name} is available again",
                "detail": f"{name} is available again",
                "icon": "mdi:lan-connect",
            })
        elif event_type == "safety":
            item.update({
                "message": f"{name} Clear",
                "summary": f"{name} returned to normal",
                "detail": f"{name} returned to normal",
                "icon": "mdi:check-circle-outline",
            })
        elif event_type == "appliance_cycle":
            # Only turn a vanished Running item into Complete when the appliance
            # actually reached an end/idle state or an explicit end-of-cycle
            # entity fired. Temporary unknown/unavailable/error states stay silent
            # instead of producing a false completion.
            completion_signal = False
            completion_entity_id = str(old.get("completion_entity_id") or "")
            if completion_entity_id:
                completion_state = self.hass.states.get(completion_entity_id)
                completion_signal = bool(
                    completion_state
                    and str(completion_state.state or "").strip().casefold() in {
                        "on", "true", "1", "complete", "completed", "finished", "done", "end",
                    }
                )

            current_state = str(state.state or "").strip().casefold() if state else "unavailable"
            completion_states = {
                "off", "power_off", "power off", "idle", "standby", "ready",
                "complete", "completed", "finished", "done", "end", "ended",
            }
            if not completion_signal and current_state not in completion_states:
                return None

            appliance_name = old.get("appliance_name") or old.get("home_device_name") or name
            item.update({
                "message": f"{appliance_name} Complete",
                "summary": f"{appliance_name} is ready",
                "detail": f"{appliance_name} is ready",
                "icon": "mdi:check-circle-outline",
            })
        elif event_type == "appliance_complete":
            # Completion is already the useful event; retain it as recent.
            pass
        elif event_type == "security":
            # Arming is a transient state. Reaching an armed state is not a
            # "Security Normal" event and should not leave stale/conflicting
            # activity in the bottom stream. Only a real alert/delay clearing
            # becomes recent history.
            previous_state = str(old.get("state") or "").casefold()
            if previous_state == "arming":
                return None
            if previous_state in {"pending", "triggered"}:
                item.update({
                    "message": "Security Cleared",
                    "summary": "Home security alert cleared",
                    "detail": "Home security alert cleared",
                    "icon": "mdi:shield-check",
                })
            else:
                return None
        else:
            return None

        return item

    def _apply_current_display_name(self, old: dict[str, Any]) -> dict[str, Any]:
        """Re-label stored history from the current Device/Source name override."""
        name = self.engine.display_name_for_item(self.options, old)
        if not name:
            return old

        item = dict(old)
        if item.get("home_device_id"):
            item["home_device_name"] = name
            if str(item.get("home_device_id") or "").startswith("entity:"):
                item["entity_name"] = name
        if item.get("source_id"):
            item["source_name"] = name

        event_type = str(item.get("event_type") or "")
        active = item.get("active") is not False

        if event_type == "contact":
            contact_name = str(item.get("entity_name") or name)
            suffix = "Open" if active else "Closed"
            item.update(message=f"{contact_name} {suffix}", summary=f"{contact_name} is {suffix.casefold()}", detail=f"{contact_name} is {suffix.casefold()}")
        elif event_type == "lock":
            lock_name = str(item.get("entity_name") or name)
            suffix = "Unlocked" if active else "Locked"
            item.update(message=f"{lock_name} {suffix}", summary=f"{lock_name} is {suffix.casefold()}", detail=f"{lock_name} is {suffix.casefold()}")
        elif event_type == "connectivity" and not active:
            item.update(message=f"{name} Back Online", summary=f"{name} is available again", detail=f"{name} is available again")
        elif event_type == "safety" and not active:
            item.update(message=f"{name} Clear", summary=f"{name} returned to normal", detail=f"{name} returned to normal")
        elif event_type in {"appliance_cycle", "appliance_complete"}:
            appliance_name = str(item.get("appliance_name") or name)
            if active and event_type == "appliance_cycle":
                # Keep live remaining-time detail if the active record supplied it.
                item.update(message=f"{appliance_name} Running")
            else:
                item.update(message=f"{appliance_name} Complete", summary=f"{appliance_name} is ready", detail=f"{appliance_name} is ready")

        return item

    def _recent_for_bottom(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            minutes = max(1, int(self.options.get("ticker_event_minutes", 10)))
        except (TypeError, ValueError):
            minutes = 10
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        result = []
        recent_appliance_completions: set[str] = set()
        for item in events:
            # Suppress stale security-normal records created by older builds.
            # They remain in retained history but never compete with the current
            # alarm state in the live bottom stream.
            if (
                str(item.get("event_type") or "") == "security"
                and str(item.get("message") or "").casefold() == "security normal"
            ):
                continue
            stamp = item.get("resolved_at") or item.get("created_at")
            try:
                when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc)
            except (TypeError, ValueError):
                continue
            if when >= cutoff:
                event_type = str(item.get("event_type") or "")
                message = str(item.get("message") or "")
                if event_type in {"appliance_cycle", "appliance_complete"} and message.endswith(" Complete"):
                    # Older builds could create one completion record per manually
                    # selected sibling entity. They all point back to the same
                    # physical appliance state entity. Keep only the newest one in
                    # the live bottom stream while preserving full retained history.
                    appliance_key = str(item.get("entity_id") or item.get("appliance_name") or message)
                    if appliance_key in recent_appliance_completions:
                        continue
                    recent_appliance_completions.add(appliance_key)
                result.append(item)
        return result

    def _retained_history(self, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
        try:
            days = max(1, int(self.options.get("history_retention_days", 7)))
        except (TypeError, ValueError):
            days = 7
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        retained = []
        for item in events:
            if not isinstance(item, dict):
                continue
            stamp = item.get("resolved_at") or item.get("created_at")
            try:
                when = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc)
            except (TypeError, ValueError):
                when = datetime.now(timezone.utc)
            if when >= cutoff:
                retained.append(item)
        try:
            limit = max(0, int(self.options.get("history_max_events", 200)))
        except (TypeError, ValueError):
            limit = 200
        return retained[:limit] if limit else retained

    @staticmethod
    def _sorted(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        order = {"critical": 0, "attention": 1, "activity": 2, "normal": 3}
        return sorted(
            items,
            key=lambda item: (
                order.get(str(item.get("priority") or "normal"), 3),
                str(item.get("created_at") or ""),
            ),
        )

    @staticmethod
    def _priority(active: list[dict[str, Any]]) -> str:
        priorities = {str(item.get("priority") or "normal") for item in active}
        if "critical" in priorities:
            return "critical"
        if "attention" in priorities:
            return "attention"
        if "activity" in priorities:
            return "activity"
        return "normal"

    @staticmethod
    def _friendly_name(entity_id: str, state: State | None, old: dict[str, Any]) -> str:
        if state:
            friendly = state.attributes.get("friendly_name")
            if friendly:
                return str(friendly)
        return str(old.get("home_device_name") or old.get("message") or entity_id)

    @staticmethod
    def _weather_visual_effect(awareness: list[dict[str, Any]]) -> str | None:
        for item in awareness:
            entity_id = str(item.get("entity_id") or "")
            if not entity_id.startswith("weather."):
                continue
            state = str(item.get("state") or "").casefold()
            if any(word in state for word in ("rain", "pour", "drizzle")):
                return "rain"
            if any(word in state for word in ("cloud", "overcast")):
                return "clouds"
            if "fog" in state:
                return "fog"
            if any(word in state for word in ("lightning", "storm", "thunder")):
                return "storm"
            if "wind" in state:
                return "wind"
            if any(word in state for word in ("clear-night", "night")):
                return "night"
            return "clear"
        return None

    def _int_option(self, key: str, default: int, *, minimum: int = 0) -> int:
        try:
            return max(minimum, int(self.options.get(key, default)))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
