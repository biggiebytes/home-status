"""Failure-isolated registry for capability providers."""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.core import HomeAssistant, State

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation
from .environment import HumidityProvider, TemperatureProvider

_LOGGER = logging.getLogger(__name__)


class CapabilityProviderRegistry:
    """Evaluate only user-selected capability entities."""

    def __init__(
        self, providers: tuple[CapabilityProvider, ...] | None = None
    ) -> None:
        providers = providers or (TemperatureProvider(), HumidityProvider())
        self.providers = {provider.capability: provider for provider in providers}
        self._warned: set[tuple[str, str]] = set()
        self._errors: dict[str, str] = {}

    def discover(self, hass: HomeAssistant) -> list[DiscoveredEntity]:
        discovered: list[DiscoveredEntity] = []
        for provider in self.providers.values():
            try:
                discovered.extend(provider.discover(hass))
            except Exception as err:  # One provider cannot break discovery.
                self._record_error(provider.capability, "discovery", err)
        return sorted(
            discovered, key=lambda item: (item.capability, item.name.casefold())
        )

    @staticmethod
    def configs(options: dict[str, Any]) -> dict[str, dict[str, Any]]:
        configured = options.get("capability_sensors")
        if not isinstance(configured, dict):
            return {}
        return {
            str(entity_id): dict(config)
            for entity_id, config in configured.items()
            if isinstance(config, dict)
            and config.get("capability") in {"temperature", "humidity"}
        }

    def selected_entity_ids(self, options: dict[str, Any]) -> tuple[str, ...]:
        return tuple(self.configs(options))

    @staticmethod
    def _enabled(options: dict[str, Any]) -> bool:
        enabled = options.get("enabled_providers")
        return not isinstance(enabled, list) or "climate" in enabled

    def evaluate(
        self,
        state: State | None,
        options: dict[str, Any],
        *,
        entity_id: str | None = None,
    ) -> ProviderEvaluation | None:
        entity_id = entity_id or getattr(state, "entity_id", None)
        if not entity_id or not self._enabled(options):
            return None
        config = self.configs(options).get(entity_id)
        if not config:
            return None
        capability = str(config.get("capability") or "")
        provider = self.providers.get(capability)
        if provider is None:
            return ProviderEvaluation(
                entity_id, capability, state.state, None, None, False,
                "unsupported_capability",
            )
        try:
            evaluation = provider.evaluate(
                state, {**config, "entity_id": entity_id}
            )
        except Exception as err:  # One entity cannot break publication.
            self._record_error(capability, entity_id, err)
            return ProviderEvaluation(
                entity_id, capability, state.state, None, None, False,
                "provider_error", str(err),
            )
        if not evaluation.included and evaluation.reason not in {
            "state_unknown", "state_unavailable",
        }:
            self._warn_once(capability, entity_id, evaluation.reason)
        return evaluation

    def active_items(
        self, state: State | None, options: dict[str, Any]
    ) -> list[dict[str, Any]]:
        evaluation = self.evaluate(state, options)
        return [evaluation.item] if evaluation and evaluation.item else []

    def current_items(
        self, hass: HomeAssistant, options: dict[str, Any]
    ) -> list[dict[str, Any]]:
        if not self._enabled(options):
            return []
        items: list[dict[str, Any]] = []
        for entity_id, config in self.configs(options).items():
            evaluation = self.evaluate(
                hass.states.get(entity_id), options, entity_id=entity_id
            )
            provider = self.providers.get(str(config.get("capability") or ""))
            if evaluation and provider and evaluation.item is None:
                item = provider.current_item(evaluation, config)
                if item:
                    items.append(item)
        return items

    def diagnostics(
        self, hass: HomeAssistant, options: dict[str, Any]
    ) -> dict[str, Any]:
        entities = []
        for entity_id, config in self.configs(options).items():
            state = hass.states.get(entity_id)
            evaluation = self.evaluate(
                state, options, entity_id=entity_id
            )
            provider = self.providers.get(str(config.get("capability") or ""))
            entities.append({
                "entity_id": entity_id,
                "capability": config.get("capability"),
                "provider_status": provider.status.value if provider else "disabled",
                "device_class": state.attributes.get("device_class") if state else None,
                "state_class": state.attributes.get("state_class") if state else None,
                "unit": state.attributes.get("unit_of_measurement") if state else None,
                "raw_state": state.state if state else None,
                "normalized_state": evaluation.normalized_state if evaluation else None,
                "produces_event": bool(evaluation and evaluation.item),
                "included": bool(evaluation and evaluation.included),
                "reason": evaluation.reason if evaluation else "provider_disabled",
                "thresholds": {
                    "low": config.get("low_threshold"),
                    "high": config.get("high_threshold"),
                },
                "publish_current": bool(config.get("publish_current")),
                "error": evaluation.error if evaluation else None,
            })
        return {
            "providers": {
                capability: {
                    "status": provider.status.value,
                    "configured": any(
                        config.get("capability") == capability
                        for config in self.configs(options).values()
                    ),
                    "error": self._errors.get(capability),
                }
                for capability, provider in self.providers.items()
            },
            "selected_entities": entities,
        }

    def _warn_once(
        self, capability: str, entity_id: str, reason: str
    ) -> None:
        key = (entity_id, reason)
        if key in self._warned:
            return
        self._warned.add(key)
        _LOGGER.warning(
            "Home Status %s provider skipped %s: %s",
            capability, entity_id, reason,
        )

    def _record_error(
        self, capability: str, context: str, err: Exception
    ) -> None:
        self._errors[capability] = f"{context}: {err}"
        self._warn_once(capability, context, str(err))
