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


class SecurityProviderMixin:
    def _build_direct_history_event(self, old_state: State | None, new_state: State | None) -> dict | None:
        if old_state is None or new_state is None:
            return None
        old_value = str(old_state.state).lower()
        value = str(new_state.state).lower()
        if old_value == value or value in {"unknown", "unavailable"}:
            return None
        entity_id = new_state.entity_id
        if entity_id not in self._direct_history_entities:
            return None
        domain = entity_id.split(".", 1)[0]
        device_class = str(new_state.attributes.get("device_class") or "").lower()
        name = self._plain_entity_name(
            entity_id, new_state.attributes.get("friendly_name")
        )
        title = summary = icon = ""
        priority = "activity"

        if domain == "alarm_control_panel" and value in ALARM_STATES:
            labels = {
                "disarmed": ("Alarm Disarmed", "Security system is off", "mdi:shield-off", "activity"),
                "armed_home": ("Alarm Armed Home", "Home mode is active", "mdi:shield-home", "attention"),
                "armed_away": ("Alarm Armed Away", "Away mode is active", "mdi:shield-lock", "attention"),
                "armed_night": ("Alarm Armed Night", "Night mode is active", "mdi:shield-moon", "attention"),
                "arming": ("Alarm Arming", "Exit delay is active", "mdi:shield-sync", "attention"),
                "pending": ("Alarm Entry Delay", "Disarm before the delay expires", "mdi:shield-alert", "critical"),
                "triggered": ("Security Alarm Triggered", "Immediate attention required", "mdi:shield-alert", "critical"),
            }
            title, summary, icon, priority = labels[value]
        elif domain == "binary_sensor":
            if device_class in {"door", "window", "opening", "garage_door", "lock"}:
                opened = value in {"on", "open", "opening", "unlocked"}
                title = f"{name} {'Opened' if opened else 'Closed'}"
                summary = f"{name} is {'open' if opened else 'closed'}"
                icon = "mdi:door-open" if opened else "mdi:door-closed"
                priority = "attention" if opened else "activity"
            elif device_class in {"moisture", "smoke", "gas", "carbon_monoxide"}:
                detected = value in {"on", "wet", "moisture", "detected"}
                title = f"{name} {'Detected' if detected else 'Cleared'}"
                summary = "Immediate attention required" if detected else f"{name} is clear"
                icon = "mdi:water-alert" if device_class == "moisture" else "mdi:smoke-detector-alert"
                priority = "critical" if detected else "activity"
        elif domain == "lock" and value in {"locked", "unlocked", "locking", "unlocking"}:
            unlocked = value in {"unlocked", "unlocking"}
            title = f"{name} {'Unlocked' if unlocked else 'Locked'}"
            summary = f"{name} is {value.replace('_', ' ')}"
            icon = "mdi:lock-open-alert" if unlocked else "mdi:lock"
            priority = "attention" if unlocked else "activity"
        elif domain == "cover" and value in {"open", "closed", "opening", "closing"}:
            opened = value in {"open", "opening"}
            title = f"{name} {'Opened' if opened else 'Closed'}"
            summary = f"{name} is {value}"
            icon = "mdi:garage-open" if opened else "mdi:garage"
            priority = "attention" if opened else "activity"
        elif domain == "person":
            old_location = self._presence_location_label(old_value)
            location = self._presence_location_label(value)
            if value == "home":
                title = f"{name} Arrived Home"
                summary = f"{name} is home"
                icon = "mdi:home-account"
            elif old_value == "home":
                title = f"{name} Left Home"
                summary = (
                    f"{name} is away"
                    if value == "not_home"
                    else f"{name} is at {location}"
                )
                icon = "mdi:account-arrow-right"
            elif value == "not_home":
                title = (
                    f"{name} Left {old_location}"
                    if old_value not in {"not_home", "unknown", "unavailable"}
                    else f"{name} Is Away"
                )
                summary = f"{name} is away"
                icon = "mdi:account-arrow-right"
            else:
                title = f"{name} Arrived at {location}"
                summary = f"{name} is at {location}"
                icon = "mdi:map-marker-account"

        if not title:
            return None
        stamp = self._now()
        provider = (
            PROVIDER_FAMILY if domain == "person" else PROVIDER_SECURITY
        )
        return {
            "id": f"direct_history:{entity_id}:{value}:{stamp}",
            "event_type": "direct_state_transition",
            "entity_id": entity_id,
            "provider": provider,
            "category": provider,
            "message": title,
            "detail": summary,
            "icon": icon,
            "priority": priority,
            "active": False,
            "state": value,
            "created_at": stamp,
            "resolved_at": stamp,
            "source": "direct_history",
            "ticker_eligible": False,
        }


    @staticmethod
    def _behavior(domain: str, device_class: str | None) -> str:
        if domain == "binary_sensor":
            if device_class in {"door", "window", "opening", "garage_door", "lock"}:
                return "contact"
            if device_class in {"motion", "occupancy", "presence", "moving"}:
                return "detection"
            if device_class in {"moisture", "problem", "smoke", "gas", "carbon_monoxide"}:
                return "fault"
        if domain == "alarm_control_panel":
            return "alarm"
        if domain in {"input_boolean", "input_select", "input_datetime", "select"}:
            return "input"
        if domain in {"light", "switch"}:
            return "state"
        return "event"


    @staticmethod
    def _plain_entity_name(entity_id: str, value=None) -> str:
        """Return a consistent plain-English label without integration prefixes."""
        return plain_entity_name(entity_id, value)


    @staticmethod
    def _moisture_location(name: str) -> str:
        location = str(name or "").strip()
        for suffix in (" moisture sensor", " moisture", " leak sensor", " leak"):
            if location.lower().endswith(suffix):
                return location[:-len(suffix)].rstrip()
        return location


    @staticmethod
    def _is_active(domain: str, device_class: str | None, value: str) -> bool | None:
        if domain == "binary_sensor":
            return value == "on"
        if domain == "alarm_control_panel":
            return value in ALARM_STATES - {"disarmed"}
        if domain == "input_boolean":
            return value == "on"
        if domain in {"light", "switch"}:
            return value == "on"
        if domain in {"input_select", "select"}:
            return None
        return None


    def _build_status_items(self) -> list[dict]:
        status: list[dict] = []
        contact_sources = self._sources("contact_sensors")
        status_entities = (ALARM_ENTITY, *self._sources("alarm_panel"), *self._sources("contact_sensors"), *tuple(
            entity_id for entity_id in self._sources("sprinkler_schedule")
            if entity_id.startswith("switch.")
        ))
        entities = tuple(dict.fromkeys(status_entities))
        open_contacts = set()
        for entity_id in contact_sources:
            state = self.hass.states.get(entity_id)
            if state and state.state == "on":
                open_contacts.add(entity_id)
        for entity_id in entities:
            state = self.hass.states.get(entity_id)
            if not state or state.state in ("unknown", "unavailable"):
                continue
            name = self._plain_entity_name(
                entity_id, state.attributes.get("friendly_name")
            )
            override = self.options.get("entity_overrides", {}).get(entity_id, {})
            if override.get("publish_mode") in {"events", "disabled"}:
                continue
            value = str(state.state).lower()
            if entity_id == ALARM_ENTITY and value not in ALARM_STATES:
                continue
            if entity_id == "alarm_control_panel.alarmo":
                alarm_labels = {
                    "disarmed": ("Alarm Off", "Your home is not protected."),
                    "armed_home": ("Alarm On", "Your home is protected."),
                    "armed_away": ("Alarm On", "Your home is protected."),
                    "armed_night": ("Alarm On", "Your home is protected."),
                    "arming": ("Alarm Starting", "Leave before the countdown ends."),
                    "pending": ("Entry Delay", "Disarm the alarm before time expires."),
                    "triggered": ("🚨 Security Alert!", "Alarm has been triggered."),
                }
                title, summary = alarm_labels.get(value, ("Alarm Status", "Alarm status unavailable."))
                icon = "mdi:shield-check" if value == "disarmed" else "mdi:shield-alert"
                category = "security"
            elif (entity_id in contact_sources
                  and entity_id.split(".", 1)[0] == "binary_sensor"
                  and self._behavior("binary_sensor", state.attributes.get("device_class")) == "contact"):
                clean_name = name
                is_open = value in {"on", "open", "opening"}
                if not is_open:
                    continue
                title = f"{clean_name} {'Open' if is_open else 'Closed'}"
                summary = f"{clean_name} is {'open' if is_open else 'closed'}"
                icon = "mdi:door-open" if is_open else "mdi:door-closed"
                category = "security"
            elif entity_id == "switch.sprinklers_rain_delay":
                if value != "on":
                    # An inactive rain delay is the absence of a condition,
                    # not useful persistent ticker content.
                    continue
                title, summary, icon, category = "Rain Delay", "On" if value == "on" else "Off", "mdi:sprinkler", PROVIDER_SCHEDULE
            else:
                # Only Alarmo and the sprinkler switch produce status items.
                # Sensor-based schedules are emitted by _build_streams only.
                continue
            if not self.options.get("include_healthy_status", True) and entity_id != ALARM_ENTITY and value not in {"on", "open", "opening", "triggered", "pending", "arming", "disarming"}:
                continue
            title = override.get("label_override") or title
            icon = override.get("icon_override") or icon
            category = override.get("provider_override") or category
            computed_priority = "normal" if entity_id == "switch.sprinklers_rain_delay" else "critical" if value == "triggered" else "attention" if value in {"armed_home", "armed_away", "armed_night", "arming", "pending", "on", "open", "opening"} else "normal"
            status_priority = override.get("priority_override") or computed_priority
            _LOGGER.debug(
                "Home Status item: id=%s provider=%s computed=%s override=%s final=%s publish_mode=%s",
                f"status:{entity_id}", category, computed_priority,
                override.get("priority_override"), status_priority,
                override.get("publish_mode") or "status",
            )
            status.append(self._stream_item(
                f"status:{entity_id}", title, summary, category, icon, status_priority,
                state.last_changed.isoformat(), entity_id=entity_id, source="status",
            ))
        return status

