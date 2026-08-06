"""Failure-isolated registry for capability providers."""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import HomeAssistant, State

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation
from .appliance_cycle import ApplianceCycleProvider
from .environment import HumidityProvider, TemperatureProvider
from .maintenance_alert import MaintenanceAlertProvider
from .state_trigger import StateTriggerProvider
from .safety import (
    AvailabilityProvider, CarbonMonoxideProvider, ConnectivityProvider,
    DeviceProblemProvider, SmokeProvider,
)

_LOGGER = logging.getLogger(__name__)

ALERT_BEHAVIORS = {
    "one_time": (60, None),
    "sustained": (60, 30),
    "critical": (300, 10),
    "reminder": (60, 60),
}


class CapabilityProviderRegistry:
    """Evaluate only user-selected capability entities."""

    def __init__(
        self, providers: tuple[CapabilityProvider, ...] | None = None
    ) -> None:
        providers = providers or (
            TemperatureProvider(), HumidityProvider(), SmokeProvider(),
            CarbonMonoxideProvider(), ConnectivityProvider(), DeviceProblemProvider(),
            AvailabilityProvider(), ApplianceCycleProvider(),
            MaintenanceAlertProvider(),
            StateTriggerProvider(),
        )
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

    def configs(self, options: dict[str, Any]) -> dict[str, dict[str, Any]]:
        configured = options.get("capability_sensors")
        if not isinstance(configured, dict):
            return {}
        return {
            str(entity_id): dict(config)
            for entity_id, config in configured.items()
            if isinstance(config, dict)
            and config.get("capability") in self.providers
        }

    def selected_entity_ids(self, options: dict[str, Any]) -> tuple[str, ...]:
        return tuple(self.configs(options))

    def related_entity_ids(self, options: dict[str, Any]) -> tuple[str, ...]:
        """Return optional supporting entities selected with a capability."""
        related = []
        for config in self.configs(options).values():
            remaining_entity = str(
                config.get("remaining_entity") or ""
            ).strip()
            if remaining_entity:
                related.append(remaining_entity)
        return tuple(dict.fromkeys(related))

    def _enabled(self, options: dict[str, Any], capability: str) -> bool:
        if capability == "state_trigger":
            return True
        enabled = options.get("enabled_providers")
        provider = self.providers.get(capability)
        return not isinstance(enabled, list) or bool(
            provider and provider.provider in enabled
        )

    def evaluate(
        self,
        state: State | None,
        options: dict[str, Any],
        *,
        entity_id: str | None = None,
    ) -> ProviderEvaluation | None:
        entity_id = entity_id or getattr(state, "entity_id", None)
        if not entity_id:
            return None
        config = self.configs(options).get(entity_id)
        if not config:
            return None
        capability = str(config.get("capability") or "")
        if not self._enabled(options, capability):
            return None
        provider = self.providers.get(capability)
        if provider is None:
            return ProviderEvaluation(
                entity_id, capability, state.state, None, None, False,
                "unsupported_capability",
            )
        try:
            timing = {
                "ticker_event_minutes": options.get("ticker_event_minutes", 10),
                "ticker_reminder_minutes": options.get("ticker_reminder_minutes", 45),
            }
            evaluation = provider.evaluate(
                state, {**timing, **config, "entity_id": entity_id}
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
        self,
        state: State | None,
        options: dict[str, Any],
        hass: HomeAssistant | None = None,
    ) -> list[dict[str, Any]]:
        evaluation = self.evaluate(state, options)
        if not evaluation or not evaluation.item:
            return []
        config = {
            "ticker_event_minutes": options.get("ticker_event_minutes", 10),
            "ticker_reminder_minutes": options.get("ticker_reminder_minutes", 45),
            **self.configs(options).get(evaluation.entity_id, {}),
        }
        capability = str(config.get("capability") or "")
        default_delay = 30 if capability == "connectivity" else 0
        try:
            trigger_delay_seconds = max(
                0, min(
                    3600,
                    int(config.get("trigger_delay_seconds", default_delay)),
                ),
            )
        except (TypeError, ValueError):
            trigger_delay_seconds = default_delay
        if state is not None and trigger_delay_seconds:
            active_seconds = (
                datetime.now(timezone.utc)
                - state.last_changed.astimezone(timezone.utc)
            ).total_seconds()
            if active_seconds < trigger_delay_seconds:
                return []
        evaluation.item["trigger_delay_seconds"] = trigger_delay_seconds
        provider = self.providers.get(capability)
        item = dict(evaluation.item)
        if hass is not None and provider is not None:
            item = provider.enrich_item(hass, item, config)
        return [self._apply_lifecycle(item, config)]

    def resolution_fields(
        self,
        state: State | None,
        options: dict[str, Any],
        old: dict[str, Any],
    ) -> dict[str, Any]:
        """Delegate resolved presentation to the selected capability."""
        entity_id = str(old.get("entity_id") or "")
        config = self.configs(options).get(entity_id, {})
        provider = self.providers.get(str(config.get("capability") or ""))
        if provider is None:
            return {
                "message": old.get("resolved_message", old.get("message")),
                "detail": old.get("resolved_detail", old.get("detail")),
                "icon": old.get("resolved_icon", old.get("icon")),
                "priority": old.get("resolved_priority", "activity"),
            }
        return provider.resolution_fields(state, config, old)

    @staticmethod
    def _apply_lifecycle(item: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        """Apply the one shared ticker lifecycle to selected entities."""
        device_class = str(item.get("metadata", {}).get("device_class") or "")
        default_minutes = 120 if device_class in {
            "door", "window", "opening", "garage_door",
        } else 10
        try:
            retention_minutes = int(
                config.get("retention_minutes", default_minutes)
            )
        except (TypeError, ValueError):
            retention_minutes = default_minutes
        retention_minutes = max(1, retention_minutes)
        try:
            ticker_minutes = max(1, int(config.get("ticker_event_minutes", 10)))
        except (TypeError, ValueError):
            ticker_minutes = 10
        try:
            reminder_minutes = max(0, int(config.get("ticker_reminder_minutes", 45)))
        except (TypeError, ValueError):
            reminder_minutes = 45
        behavior = str(config.get("alert_behavior") or "one_time")
        display_route = str(
            config.get("display_route") or "main_then_footer"
        )
        if display_route not in {
            "main_then_footer", "main_only", "footer_only",
        }:
            display_route = "main_then_footer"
        main_duration_seconds, _repeat_interval_minutes = ALERT_BEHAVIORS.get(
            behavior, ALERT_BEHAVIORS["one_time"]
        )
        now = datetime.now(timezone.utc)
        main_enabled = display_route != "footer_only"
        footer_enabled = display_route != "main_only"
        result = dict(item)
        display_name = str(config.get("display_name") or "").strip()
        if display_name:
            result["capability_message"] = result.get("message")
            if not config.get("active_message"):
                result["message"] = display_name[:60]
            result["display_name"] = display_name[:60]
        result["prefer_resolved_message"] = bool(
            config.get("resolved_message")
        )
        result.update({
            "retention_minutes": retention_minutes,
            "alert_behavior": behavior,
            "display_route": display_route,
            "main_duration_seconds": main_duration_seconds,
            "main_until": (
                now + timedelta(seconds=main_duration_seconds)
            ).isoformat() if main_enabled else None,
            "footer_eligible": footer_enabled,
            "ticker_eligible": True,
            "ticker_until": (
                now + timedelta(minutes=ticker_minutes)
            ).isoformat(),
            "next_reminder_at": (
                now + timedelta(minutes=reminder_minutes)
            ).isoformat() if reminder_minutes and behavior != "one_time" else None,
        })
        return result

    def current_items(
        self, hass: HomeAssistant, options: dict[str, Any]
    ) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for entity_id, config in self.configs(options).items():
            evaluation = self.evaluate(
                hass.states.get(entity_id), options, entity_id=entity_id
            )
            provider = self.providers.get(str(config.get("capability") or ""))
            if evaluation and provider and evaluation.item is None:
                item = provider.current_item(evaluation, config)
                if item:
                    display_name = str(
                        config.get("display_name") or ""
                    ).strip()
                    if display_name:
                        item["title"] = display_name[:60]
                        item["message"] = display_name[:60]
                        item["display_name"] = display_name[:60]
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
                "trigger_delay_seconds": config.get(
                    "trigger_delay_seconds",
                    30 if config.get("capability") == "connectivity" else 0,
                ),
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
