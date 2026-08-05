"""Configurable appliance-cycle capability provider."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import State

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation


DEFAULT_COMPLETE_STATES = frozenset({
    "complete", "completed", "finished", "done", "end",
})
DEFAULT_IDLE_STATES = frozenset({
    "off", "idle", "ready", "power_off",
})
APPLIANCE_ICONS = {
    "washer": "mdi:washing-machine",
    "dryer": "mdi:tumble-dryer",
    "dishwasher": "mdi:dishwasher",
    "appliance": "mdi:home-automation",
}


def _configured_states(
    config: dict[str, Any], key: str, defaults: frozenset[str]
) -> frozenset[str]:
    value = config.get(key)
    if not isinstance(value, (list, tuple, set)):
        return defaults
    normalized = {
        str(state).strip().casefold() for state in value if str(state).strip()
    }
    return frozenset(normalized) or defaults


def _remaining_minutes(state: State | None) -> float | None:
    if not state or str(state.state).casefold() in {
        "", "unknown", "unavailable", "none",
    }:
        return None
    value = str(state.state).strip()
    try:
        amount = float(value)
        unit = str(state.attributes.get("unit_of_measurement") or "min").casefold()
        if unit in {"s", "sec", "second", "seconds"}:
            return amount / 60
        if unit in {"h", "hr", "hour", "hours"}:
            return amount * 60
        return amount
    except (TypeError, ValueError):
        pass
    parts = value.split(":")
    if len(parts) not in {2, 3}:
        return None
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None
    if len(numbers) == 2:
        hours, minutes = numbers
        return hours * 60 + minutes
    hours, minutes, seconds = numbers
    return hours * 60 + minutes + seconds / 60


class ApplianceCycleProvider(CapabilityProvider):
    """Interpret a user-selected enum-like appliance state sensor."""

    capability = "appliance_cycle"
    provider = "laundry"
    entity_domains = frozenset({"sensor"})
    device_classes = frozenset({"enum"})
    icon = "mdi:home-automation"

    def interpret(self, normalized, config):
        """The provider performs state validation in its custom evaluator."""
        raise NotImplementedError

    def discover(self, hass) -> list[DiscoveredEntity]:
        discovered = []
        for state in hass.states.async_all():
            if state.entity_id.split(".", 1)[0] != "sensor":
                continue
            device_class = self._metadata_value(
                state.attributes.get("device_class")
            )
            options = state.attributes.get("options")
            if device_class != "enum" and not isinstance(options, (list, tuple)):
                continue
            discovered.append(DiscoveredEntity(
                entity_id=state.entity_id,
                capability=self.capability,
                name=str(
                    state.attributes.get("friendly_name")
                    or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
                ),
                device_class=device_class,
                state_class=self._metadata_value(
                    state.attributes.get("state_class")
                ),
                unit=None,
            ))
        return sorted(discovered, key=lambda item: item.name.casefold())

    def evaluate(
        self, state: State | None, config: dict[str, Any]
    ) -> ProviderEvaluation:
        entity_id = str(config.get("entity_id") or getattr(state, "entity_id", ""))
        if state is None:
            return ProviderEvaluation(
                entity_id, self.capability, None, None, None, False,
                "entity_not_found",
            )
        if state.entity_id.split(".", 1)[0] != "sensor":
            return ProviderEvaluation(
                entity_id, self.capability, str(state.state), None, None,
                False, "unsupported_domain",
            )
        raw_state = str(state.state or "").strip()
        normalized_value = raw_state.casefold()
        if normalized_value in {"", "unknown", "unavailable", "none"}:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, None, None, False,
                f"state_{normalized_value or 'empty'}",
            )
        name = str(
            config.get("display_name")
            or state.attributes.get("friendly_name")
            or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
        ).strip()
        normalized = {
            "entity_id": state.entity_id,
            "name": name,
            "state": normalized_value,
            "raw_state": raw_state,
            "created_at": state.last_changed.isoformat(),
            "metadata": {
                "device_class": self._metadata_value(
                    state.attributes.get("device_class")
                ),
                "options": list(state.attributes.get("options") or []),
            },
        }
        complete_states = _configured_states(
            config, "complete_states", DEFAULT_COMPLETE_STATES
        )
        idle_states = _configured_states(
            config, "idle_states", DEFAULT_IDLE_STATES
        )
        if normalized_value in complete_states:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, None, True,
                "complete",
            )
        if normalized_value in idle_states:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, None, True,
                "idle",
            )
        appliance_type = str(config.get("appliance_type") or "appliance")
        icon = APPLIANCE_ICONS.get(appliance_type, APPLIANCE_ICONS["appliance"])
        now = datetime.now(timezone.utc)
        item = {
            "id": f"capability:appliance_cycle:{entity_id}:active",
            "entity_id": entity_id,
            "event_type": "appliance_cycle",
            "provider": self.provider,
            "category": self.provider,
            "message": f"{name} Running",
            "detail": raw_state.replace("_", " ").replace("-", " ").title(),
            "resolved_message": f"{name} Cycle Complete",
            "resolved_detail": f"{name} is ready",
            "resolved_icon": icon,
            "resolved_priority": "normal",
            "icon": icon,
            "priority": str(config.get("priority") or "activity"),
            "active": True,
            "state": normalized_value,
            "created_at": normalized["created_at"],
            "source": "capability:appliance_cycle",
            "metadata": normalized["metadata"],
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "persistent": True,
            "hero_eligible": False,
        }
        return ProviderEvaluation(
            entity_id, self.capability, raw_state, normalized, item, True,
            "running",
        )

    def enrich_item(self, hass, item, config):
        remaining_entity = str(config.get("remaining_entity") or "").strip()
        minutes = _remaining_minutes(
            hass.states.get(remaining_entity) if remaining_entity else None
        )
        if minutes is not None and minutes > 0:
            phase = str(item.get("detail") or "").strip()
            item["detail"] = (
                f"{phase} · About {max(1, round(minutes))} minutes remaining"
            )
        return item

    def resolution_fields(self, state, config, old):
        name = str(
            config.get("display_name")
            or old.get("display_name")
            or old.get("message")
            or "Appliance"
        ).removesuffix(" Running")
        value = str(getattr(state, "state", "")).strip().casefold()
        completed = value in _configured_states(
            config, "complete_states", DEFAULT_COMPLETE_STATES
        )
        return {
            "message": (
                f"{name} Cycle Complete" if completed else f"{name} Cycle Ended"
            ),
            "detail": (
                f"{name} is ready" if completed else f"{name} is no longer running"
            ),
            "icon": old.get("resolved_icon", old.get("icon")),
            "priority": "normal",
        }
