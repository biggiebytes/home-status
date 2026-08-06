"""Configurable maintenance-alert capability provider."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import State
from homeassistant.helpers import entity_registry as er

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation


class MaintenanceAlertProvider(CapabilityProvider):
    """Interpret an explicitly selected diagnostic binary sensor."""

    capability = "maintenance_alert"
    provider = "maintenance"
    entity_domains = frozenset({"binary_sensor"})
    device_classes = frozenset({"problem"})
    icon = "mdi:wrench-clock"

    def interpret(self, normalized, config):
        """The provider performs state validation in its custom evaluator."""
        raise NotImplementedError

    def discover(self, hass) -> list[DiscoveredEntity]:
        entity_registry = er.async_get(hass)
        discovered = []
        for state in hass.states.async_all():
            if state.entity_id.split(".", 1)[0] != "binary_sensor":
                continue
            registry_entry = entity_registry.async_get(state.entity_id)
            entity_category = str(
                getattr(
                    getattr(registry_entry, "entity_category", None),
                    "value",
                    getattr(registry_entry, "entity_category", ""),
                )
                or ""
            ).casefold()
            device_class = self._metadata_value(
                state.attributes.get("device_class")
            )
            if device_class != "problem" and entity_category != "diagnostic":
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
        if state.entity_id.split(".", 1)[0] != "binary_sensor":
            return ProviderEvaluation(
                entity_id, self.capability, str(state.state), None, None,
                False, "unsupported_domain",
            )
        raw_state = str(state.state or "").strip().casefold()
        if raw_state in {"", "unknown", "unavailable"}:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, None, None, False,
                f"state_{raw_state or 'empty'}",
            )
        name = str(
            config.get("display_name")
            or state.attributes.get("friendly_name")
            or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
        ).strip()
        normalized = {
            "entity_id": state.entity_id,
            "name": name,
            "state": raw_state,
            "created_at": state.last_changed.isoformat(),
            "metadata": {
                "device_class": self._metadata_value(
                    state.attributes.get("device_class")
                ),
            },
        }
        if raw_state != "on":
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, None, True,
                "inactive",
            )
        active_message = str(
            config.get("active_message") or f"{name} Needs Attention"
        ).strip()
        resolved_message = str(
            config.get("resolved_message") or f"{name} Maintenance Complete"
        ).strip()
        icon = str(config.get("icon") or self.icon).strip()
        now = datetime.now(timezone.utc)
        ticker_minutes = max(1, int(config.get("ticker_event_minutes", 10)))
        reminder_minutes = max(0, int(config.get("ticker_reminder_minutes", 45)))
        item = {
            "id": f"capability:maintenance_alert:{entity_id}:active",
            "entity_id": entity_id,
            "event_type": "maintenance_alert",
            "provider": self.provider,
            "category": self.provider,
            "message": active_message,
            "detail": f"{name} requires maintenance",
            "resolved_message": resolved_message,
            "resolved_detail": f"{name} returned to normal",
            "resolved_icon": "mdi:check-circle-outline",
            "resolved_priority": "normal",
            "icon": icon or self.icon,
            "priority": str(config.get("priority") or "attention"),
            "active": True,
            "state": "active",
            "created_at": normalized["created_at"],
            "source": "capability:maintenance_alert",
            "metadata": normalized["metadata"],
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=ticker_minutes)).isoformat(),
            "next_reminder_at": (now + timedelta(minutes=reminder_minutes)).isoformat() if reminder_minutes else None,
            "persistent": True,
            "hero_eligible": False,
        }
        return ProviderEvaluation(
            entity_id, self.capability, raw_state, normalized, item, True,
            "active",
        )
