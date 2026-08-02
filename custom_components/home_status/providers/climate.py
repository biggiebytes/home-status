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


class ClimateProviderMixin:
    def _record_easystart_fault_count_change(self, event: Event) -> None:
        """Store a recent event only when EasyStart's lifetime count rises."""
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        if (
            old_state is None
            or new_state is None
            or new_state.entity_id not in self._sources("hvac_fault_counter")
        ):
            return
        try:
            old_value = int(float(old_state.state))
            new_value = int(float(new_state.state))
        except (TypeError, ValueError):
            # Initial availability and unknown states establish a baseline
            # without creating a false historical fault.
            return
        if new_value <= old_value:
            return
        increase = new_value - old_value
        stamp = self._now()
        message = (
            "EasyStart Fault Recorded"
            if increase == 1
            else f"{increase} EasyStart Faults Recorded"
        )
        event_item = {
            "id": f"easystart_fault_count:{new_value}:{stamp}",
            "event_type": "hvac_fault_counter",
            "entity_id": EASYSTART_FAULT_COUNTER,
            "provider": PROVIDER_CLIMATE,
            "category": PROVIDER_CLIMATE,
            "message": message,
            "detail": (
                f"Lifetime fault count increased from "
                f"{old_value} to {new_value}"
            ),
            "icon": "mdi:counter",
            "priority": "normal",
            "active": False,
            "created_at": stamp,
            "resolved_at": stamp,
            "source": "hvac_fault_counter",
            "ticker_eligible": False,
        }
        self.history = self._retained_history([event_item, *self.history])
        self.hass.async_create_task(
            self.store.async_save({"events": self.history})
        )


    def _build_hvac_diagnostic_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish Micro-Air only when its diagnostic state needs attention."""
        value = str(state.state or "").strip()
        normalized = value.casefold()
        if normalized in {"normal", "ok", "healthy", "clear"}:
            return None
        unavailable = normalized in {"unknown", "unavailable", ""}
        status_contract = {
            "unexpected curr flt": (
                "EasyStart Unexpected Current",
                "Unexpected compressor current was detected",
                "attention",
                "mdi:current-ac",
            ),
            "short cycle delay": (
                "EasyStart Short-Cycle Delay",
                "Compressor restart is being delayed for protection",
                "activity",
                "mdi:timer-sand",
            ),
            "pwr intrrptn fault": (
                "EasyStart Power Interruption",
                "Compressor power was interrupted",
                "attention",
                "mdi:transmission-tower-off",
            ),
            "stall fault": (
                "EasyStart Compressor Stall",
                "The compressor did not reach normal running speed",
                "critical",
                "mdi:engine-off-outline",
            ),
            "stuck sr fault": (
                "EasyStart Start Relay Fault",
                "The compressor start relay may be stuck",
                "critical",
                "mdi:electric-switch-closed",
            ),
            "open ovrld fault": (
                "EasyStart Open Overload",
                "The compressor overload protection opened",
                "critical",
                "mdi:alert-octagon",
            ),
            "overcurrent fault": (
                "EasyStart Overcurrent",
                "Compressor current exceeded its protection limit",
                "critical",
                "mdi:current-ac",
            ),
            "bad wiring fault": (
                "EasyStart Wiring Fault",
                "EasyStart detected an invalid wiring condition",
                "critical",
                "mdi:cable-data",
            ),
            "wrong voltage flt": (
                "EasyStart Voltage Fault",
                "EasyStart detected an invalid line voltage",
                "critical",
                "mdi:flash-alert",
            ),
        }
        if unavailable:
            message = "EasyStart Diagnostics Unavailable"
            description = "Micro-Air status is unavailable"
            priority = "attention"
            icon = "mdi:hvac-off"
        else:
            message, description, priority, icon = status_contract.get(
                normalized,
                (
                    "EasyStart Diagnostic Alert",
                    value,
                    "attention",
                    "mdi:hvac",
                ),
            )
        diagnostics = self._easystart_diagnostics()
        detail = " • ".join([
            description,
            *(
                f"{diagnostic['label']} {diagnostic['value']}"
                for diagnostic in diagnostics
            ),
        ])
        now = datetime.now(timezone.utc)
        short_cycle = normalized == "short cycle delay"
        return {
            "id": f"{DOMAIN}:hvac_diagnostic",
            "entity_id": entity_id,
            "event_type": (
                "hvac_short_cycle" if short_cycle else "hvac_diagnostic"
            ),
            "behavior": "fault",
            "message": message,
            "detail": detail,
            "diagnostics": diagnostics,
            "category": PROVIDER_CLIMATE,
            "provider": PROVIDER_CLIMATE,
            "priority": priority,
            "icon": icon,
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (
                None
                if short_cycle
                else (now + timedelta(minutes=45)).isoformat()
            ),
            "persistent": not short_cycle,
            "hero_eligible": priority in {"critical", "attention"},
            "state": state.state,
        }


    def _easystart_diagnostics(self) -> list[dict]:
        """Return available EasyStart readings as supporting alert fields."""
        diagnostics = []
        enabled_entities = set(self._sources("hvac_diagnostic_details"))
        for entity_id, label in EASYSTART_DIAGNOSTIC_DETAILS.items():
            if entity_id not in enabled_entities:
                continue
            state = self.hass.states.get(entity_id)
            raw_value = str(getattr(state, "state", "") or "").strip()
            if raw_value.casefold() in {"", "unknown", "unavailable"}:
                continue
            try:
                numeric = float(raw_value)
                display_value = (
                    str(int(numeric))
                    if numeric.is_integer()
                    else f"{numeric:.1f}".rstrip("0").rstrip(".")
                )
            except ValueError:
                display_value = raw_value
            unit = str(
                getattr(state, "attributes", {}).get(
                    "unit_of_measurement", ""
                )
            ).strip()
            diagnostics.append({
                "entity_id": entity_id,
                "label": label,
                "value": " ".join(
                    part for part in (display_value, unit) if part
                ),
            })
        return diagnostics

