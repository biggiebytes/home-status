"""Shared contracts for capability-based entity providers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
import math
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er


class ProviderStatus(str, Enum):
    """Supported capability-provider maturity levels."""

    DISABLED = "disabled"
    EXPERIMENTAL = "experimental"
    STABLE = "stable"


@dataclass(frozen=True)
class DiscoveredEntity:
    """One selectable Home Assistant entity and its standard metadata."""

    entity_id: str
    capability: str
    name: str
    device_class: str | None
    state_class: str | None
    unit: str | None
    device_name: str | None = None
    area_name: str | None = None


@dataclass(frozen=True)
class ProviderEvaluation:
    """Normalized and interpreted result for one selected entity."""

    entity_id: str
    capability: str
    raw_state: str | None
    normalized_state: dict[str, Any] | None
    item: dict[str, Any] | None
    included: bool
    reason: str
    error: str | None = None


class CapabilityProvider(ABC):
    """Shared discovery -> normalize -> interpret provider contract."""

    capability: str
    provider = "climate"
    status = ProviderStatus.EXPERIMENTAL
    device_classes: frozenset[str] = frozenset()
    entity_domains: frozenset[str] = frozenset({"sensor"})
    icon = "mdi:gauge"

    @staticmethod
    def _metadata_value(value: Any) -> str | None:
        if value in (None, ""):
            return None
        return str(getattr(value, "value", value)).casefold()

    def discover(self, hass: HomeAssistant) -> list[DiscoveredEntity]:
        """Discover candidates without selecting or publishing them."""
        entity_registry = er.async_get(hass)
        device_registry = dr.async_get(hass)
        area_registry = ar.async_get(hass)
        discovered: list[DiscoveredEntity] = []
        for state in hass.states.async_all():
            if state.entity_id.split(".", 1)[0] not in self.entity_domains:
                continue
            registry_entry = entity_registry.async_get(state.entity_id)
            device_class = self._metadata_value(
                state.attributes.get("device_class")
                or getattr(registry_entry, "original_device_class", None)
            )
            if device_class not in self.device_classes:
                continue
            device = (
                device_registry.async_get(registry_entry.device_id)
                if registry_entry and registry_entry.device_id
                else None
            )
            area_id = (
                registry_entry.area_id if registry_entry and registry_entry.area_id
                else device.area_id if device else None
            )
            area = area_registry.async_get_area(area_id) if area_id else None
            discovered.append(DiscoveredEntity(
                entity_id=state.entity_id,
                capability=self.capability,
                name=str(
                    state.attributes.get("friendly_name")
                    or (registry_entry.name if registry_entry else "")
                    or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
                ),
                device_class=device_class,
                state_class=self._metadata_value(state.attributes.get("state_class")),
                unit=str(state.attributes.get("unit_of_measurement") or "") or None,
                device_name=str(device.name_by_user or device.name) if device else None,
                area_name=area.name if area else None,
            ))
        return sorted(discovered, key=lambda item: item.name.casefold())

    def evaluate(self, state: State | None, config: dict[str, Any]) -> ProviderEvaluation:
        """Validate, normalize, and interpret one selected entity."""
        entity_id = str(config.get("entity_id") or getattr(state, "entity_id", ""))
        if state is None:
            return ProviderEvaluation(entity_id, self.capability, None, None, None, False, "entity_not_found")
        raw_state = str(state.state)
        if raw_state in {"unknown", "unavailable", ""}:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, f"state_{raw_state or 'empty'}")
        if state.entity_id.split(".", 1)[0] not in self.entity_domains:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "unsupported_domain")
        device_class = self._metadata_value(state.attributes.get("device_class"))
        if device_class and device_class not in self.device_classes:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "unsupported_device_class")
        unit = str(state.attributes.get("unit_of_measurement") or "").strip()
        if not unit:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "missing_unit")
        try:
            value = float(raw_state)
        except (TypeError, ValueError):
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "malformed_number")
        if not math.isfinite(value):
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "malformed_number")
        normalized = self.normalize(state, value, unit)
        normalized["name"] = str(
            config.get("display_name") or normalized["name"]
        )
        item, reason = self.interpret(normalized, config)
        return ProviderEvaluation(entity_id, self.capability, raw_state, normalized, item, True, reason)

    def normalize(self, state: State, value: float, unit: str) -> dict[str, Any]:
        """Normalize a numeric sensor while preserving its native HA unit."""
        return {
            "entity_id": state.entity_id,
            "capability": self.capability,
            "provider": self.provider,
            "name": str(state.attributes.get("friendly_name") or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()),
            "value": value,
            "unit": unit,
            "state": "normal",
            "created_at": state.last_changed.isoformat(),
            "metadata": {
                "device_class": self._metadata_value(state.attributes.get("device_class")),
                "state_class": self._metadata_value(state.attributes.get("state_class")),
            },
        }

    @abstractmethod
    def interpret(
        self, normalized: dict[str, Any], config: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, str]:
        """Interpret normalized state into the existing item contract."""

    def current_item(
        self, evaluation: ProviderEvaluation, config: dict[str, Any]
    ) -> dict[str, Any] | None:
        """Return an explicitly enabled, quiet current-value item."""
        if not config.get("publish_current") or not evaluation.normalized_state:
            return None
        normalized = evaluation.normalized_state
        return {
            "id": f"current:capability:{self.capability}:{evaluation.entity_id}",
            "entity_id": evaluation.entity_id,
            "event_type": f"{self.capability}_current",
            "provider": self.provider,
            "category": self.provider,
            "title": normalized["name"],
            "message": normalized["name"],
            "summary": f"{normalized['value']:g}{normalized['unit']}",
            "detail": f"Current {self.capability}: {normalized['value']:g}{normalized['unit']}",
            "icon": self.icon,
            "priority": "normal",
            "active": False,
            "created_at": normalized["created_at"],
            "source": f"capability:{self.capability}",
        }

    def enrich_item(
        self, hass: HomeAssistant, item: dict[str, Any], config: dict[str, Any]
    ) -> dict[str, Any]:
        """Add optional context from related configured entities."""
        return item

    def resolution_fields(
        self, state: State | None, config: dict[str, Any], old: dict[str, Any]
    ) -> dict[str, Any]:
        """Return presentation fields when an active event resolves."""
        return {
            "message": old.get("resolved_message", old.get("message")),
            "detail": old.get("resolved_detail", old.get("detail")),
            "icon": old.get("resolved_icon", old.get("icon")),
            "priority": old.get("resolved_priority", "activity"),
        }
