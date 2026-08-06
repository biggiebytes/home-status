"""Universal exact-state trigger provider."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import State

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation


class StateTriggerProvider(CapabilityProvider):
    """Publish any explicitly selected entity while it matches one state."""

    capability = "state_trigger"
    provider = "activity"
    entity_domains = frozenset()
    device_classes = frozenset()
    icon = "mdi:bell-outline"

    def interpret(self, normalized, config):
        """The provider performs state validation in its custom evaluator."""
        raise NotImplementedError

    def discover(self, hass) -> list[DiscoveredEntity]:
        discovered = []
        for state in hass.states.async_all():
            if state.entity_id == "sensor.home_status":
                continue
            discovered.append(DiscoveredEntity(
                entity_id=state.entity_id,
                capability=self.capability,
                name=str(
                    state.attributes.get("friendly_name")
                    or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
                ),
                device_class=self._metadata_value(
                    state.attributes.get("device_class")
                ),
                state_class=self._metadata_value(
                    state.attributes.get("state_class")
                ),
                unit=str(state.attributes.get("unit_of_measurement") or "") or None,
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
        raw_state = str(state.state or "").strip()
        normalized_value = raw_state.casefold()
        trigger_state = str(config.get("trigger_state") or "on").strip().casefold()
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
            },
        }
        if normalized_value != trigger_state:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, None, True,
                "state_does_not_match",
            )
        active_message = str(
            config.get("active_message") or f"{name}: {raw_state}"
        ).strip()
        resolved_message = str(
            config.get("resolved_message") or f"{name} Cleared"
        ).strip()
        icon = str(
            config.get("icon")
            or state.attributes.get("icon")
            or self.icon
        ).strip()
        now = datetime.now(timezone.utc)
        ticker_minutes = max(1, int(config.get("ticker_event_minutes", 10)))
        item = {
            "id": f"capability:state_trigger:{entity_id}:active",
            "entity_id": entity_id,
            "event_type": "state_trigger",
            "provider": self.provider,
            "category": self.provider,
            "message": active_message,
            "detail": f"{name} is {raw_state}",
            "resolved_message": resolved_message,
            "resolved_detail": f"{name} no longer matches {trigger_state}",
            "resolved_icon": "mdi:check-circle-outline",
            "resolved_priority": "normal",
            "icon": icon or self.icon,
            "priority": str(config.get("priority") or "attention"),
            "active": True,
            "state": normalized_value,
            "created_at": normalized["created_at"],
            "source": "capability:state_trigger",
            "metadata": normalized["metadata"],
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=ticker_minutes)).isoformat(),
            "persistent": True,
            "hero_eligible": False,
            "prefer_active_message": bool(config.get("active_message")),
            "prefer_resolved_message": bool(config.get("resolved_message")),
        }
        return ProviderEvaluation(
            entity_id, self.capability, raw_state, normalized, item, True,
            "state_matches",
        )

    def resolution_fields(self, state, config, old):
        fields = super().resolution_fields(state, config, old)
        name = str(
            config.get("display_name")
            or old.get("display_name")
            or old.get("message")
            or old.get("entity_id")
            or "Entity"
        )
        current = str(getattr(state, "state", "unknown"))
        fields["detail"] = f"{name} is now {current}"
        return fields
