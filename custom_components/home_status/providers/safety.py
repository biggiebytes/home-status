"""Experimental opt-in safety and availability capability providers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .base import CapabilityProvider, DiscoveredEntity, ProviderEvaluation


class BinaryAlertProvider(CapabilityProvider):
    """Normalize a selected binary sensor into one sustained alert item."""

    entity_domains = frozenset({"binary_sensor"})
    active_states = frozenset({"on"})
    message = "Home alert"
    detail_template = "{name} needs attention"
    resolved_message = "Alert Cleared"
    resolved_detail_template = "{name} returned to normal"
    resolved_icon = "mdi:check-circle-outline"

    def evaluate(
        self, state, config: dict[str, Any]
    ) -> ProviderEvaluation:
        entity_id = str(config.get("entity_id") or getattr(state, "entity_id", ""))
        if state is None:
            return ProviderEvaluation(entity_id, self.capability, None, None, None, False, "entity_not_found")
        raw_state = str(state.state).casefold()
        if raw_state in {"unknown", "unavailable", ""}:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, f"state_{raw_state or 'empty'}")
        if state.entity_id.split(".", 1)[0] not in self.entity_domains:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "unsupported_domain")
        device_class = self._metadata_value(state.attributes.get("device_class"))
        if device_class not in self.device_classes:
            return ProviderEvaluation(entity_id, self.capability, raw_state, None, None, False, "unsupported_device_class")
        normalized = {
            "entity_id": state.entity_id,
            "capability": self.capability,
            "provider": self.provider,
            "name": str(config.get("display_name") or state.attributes.get("friendly_name") or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()),
            "state": raw_state,
            "created_at": state.last_changed.isoformat(),
            "metadata": {"device_class": device_class},
        }
        item, reason = self.interpret(normalized, config)
        return ProviderEvaluation(entity_id, self.capability, raw_state, normalized, item, True, reason)

    def interpret(self, normalized: dict[str, Any], config: dict[str, Any]):
        if normalized["state"] not in self.active_states:
            return None, "inactive"
        now = datetime.now(timezone.utc)
        return {
            "id": f"capability:{self.capability}:{normalized['entity_id']}:active",
            "entity_id": normalized["entity_id"],
            "event_type": f"{self.capability}_alert",
            "provider": self.provider,
            "category": self.provider,
            "message": self.message,
            "detail": self.detail_template.format(name=normalized["name"]),
            "resolved_message": self.resolved_message,
            "resolved_detail": self.resolved_detail_template.format(
                name=normalized["name"]
            ),
            "resolved_icon": self.resolved_icon,
            "resolved_priority": "normal",
            "icon": self.icon,
            "priority": str(config.get("priority") or "critical"),
            "active": True,
            "state": "active",
            "created_at": normalized["created_at"],
            "source": f"capability:{self.capability}",
            "metadata": normalized["metadata"],
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
            "persistent": True,
            "hero_eligible": False,
        }, "active"

    def current_item(self, evaluation, config):
        """Binary safety signals only publish when their alert state is active."""
        return None


class SmokeProvider(BinaryAlertProvider):
    capability = "smoke"
    provider = "security"
    device_classes = frozenset({"smoke"})
    icon = "mdi:smoke-detector-alert"
    message = "Smoke Detected"
    detail_template = "Smoke detected by {name}"
    resolved_message = "Smoke Cleared"
    resolved_detail_template = "{name} no longer detects smoke"


class CarbonMonoxideProvider(BinaryAlertProvider):
    capability = "carbon_monoxide"
    provider = "security"
    device_classes = frozenset({"carbon_monoxide"})
    icon = "mdi:molecule-co"
    message = "Carbon Monoxide Detected"
    detail_template = "Carbon monoxide detected by {name}"
    resolved_message = "Carbon Monoxide Cleared"
    resolved_detail_template = "{name} no longer detects carbon monoxide"


class ConnectivityProvider(BinaryAlertProvider):
    capability = "connectivity"
    provider = "security"
    device_classes = frozenset({"connectivity"})
    active_states = frozenset({"off"})
    icon = "mdi:lan-disconnect"
    message = "Connection Lost"
    detail_template = "{name} is offline"
    resolved_message = "Connection Restored"
    resolved_detail_template = "{name} is back online"
    resolved_icon = "mdi:lan-connect"


class DeviceProblemProvider(BinaryAlertProvider):
    capability = "device_problem"
    provider = "security"
    device_classes = frozenset({"problem"})
    icon = "mdi:alert-octagon"
    message = "Device Needs Attention"
    detail_template = "{name} reports a problem"
    resolved_message = "Device Problem Cleared"
    resolved_detail_template = "{name} returned to normal"


class AvailabilityProvider(CapabilityProvider):
    """Monitor an explicitly selected entity only while it is unavailable."""

    capability = "availability"
    provider = "security"
    icon = "mdi:cloud-off-outline"
    entity_domains = frozenset({
        "binary_sensor", "camera", "climate", "cover", "fan", "light",
        "lock", "media_player", "remote", "sensor", "switch", "vacuum",
        "water_heater",
    })
    _SPECIALIZED_DEVICE_CLASSES = frozenset({
        "temperature", "humidity", "smoke", "carbon_monoxide",
        "connectivity", "problem", "enum",
    })

    def discover(self, hass) -> list[DiscoveredEntity]:
        """Offer ordinary device entities without duplicating typed providers."""
        candidates = []
        for state in hass.states.async_all():
            domain = state.entity_id.split(".", 1)[0]
            device_class = self._metadata_value(
                state.attributes.get("device_class")
            )
            if (
                domain not in self.entity_domains
                or device_class in self._SPECIALIZED_DEVICE_CLASSES
                or isinstance(state.attributes.get("options"), (list, tuple))
                or state.entity_id == "sensor.home_status"
            ):
                continue
            candidates.append(DiscoveredEntity(
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
                unit=str(state.attributes.get("unit_of_measurement") or "") or None,
            ))
        return sorted(candidates, key=lambda item: item.name.casefold())

    def evaluate(self, state, config: dict[str, Any]) -> ProviderEvaluation:
        entity_id = str(config.get("entity_id") or getattr(state, "entity_id", ""))
        if state is None:
            return ProviderEvaluation(
                entity_id, self.capability, None, None, None, False,
                "entity_not_found",
            )
        raw_state = str(state.state).casefold()
        if state.entity_id.split(".", 1)[0] not in self.entity_domains:
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, None, None, False,
                "unsupported_domain",
            )
        normalized = {
            "entity_id": state.entity_id,
            "name": str(
                config.get("display_name")
                or state.attributes.get("friendly_name")
                or state.entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
            ),
            "state": raw_state,
            "created_at": state.last_changed.isoformat(),
            "metadata": {
                "device_class": self._metadata_value(
                    state.attributes.get("device_class")
                ),
            },
        }
        default_retention_minutes = 120 if (
            normalized["metadata"]["device_class"]
            in {"door", "window", "opening", "garage_door"}
        ) else 10
        try:
            retention_minutes = max(
                1, min(
                    1440,
                    int(config.get("retention_minutes", default_retention_minutes)),
                )
            )
        except (TypeError, ValueError):
            retention_minutes = default_retention_minutes
        if (
            raw_state == "on"
            and config.get("alert_when_active")
            and normalized["metadata"]["device_class"] in {
                "door", "window", "opening", "garage_door", "motion",
            }
        ):
            device_class = normalized["metadata"]["device_class"]
            label = "Motion Detected" if device_class == "motion" else (
                "Window Open" if device_class == "window" else "Door Open"
            )
            detail = (
                normalized["name"]
                if device_class == "motion"
                else f"{normalized['name']} is open"
            )
            resolved_label = (
                "Motion Detected" if device_class == "motion" else
                "Window Closed" if device_class == "window" else
                "Door Closed"
            )
            resolved_detail = (
                normalized["name"]
                if device_class == "motion"
                else f"{normalized['name']} is closed"
            )
            now = datetime.now(timezone.utc)
            item = {
                "id": f"capability:availability:{entity_id}:active",
                "entity_id": entity_id,
                "event_type": "availability_active",
                "provider": self.provider,
                "category": self.provider,
                "message": label,
                "detail": detail,
                "resolved_message": resolved_label,
                "resolved_detail": resolved_detail,
                "resolved_icon": (
                    "mdi:motion-sensor"
                    if device_class == "motion" else "mdi:door-closed"
                ),
                "resolved_priority": (
                    "activity" if device_class == "motion" else "normal"
                ),
                "icon": "mdi:motion-sensor" if device_class == "motion" else "mdi:door-open",
                "priority": str(config.get("priority") or "attention"),
                "active": True,
                "state": "active",
                "created_at": normalized["created_at"],
                "source": "capability:availability",
                "metadata": normalized["metadata"],
                "retention_minutes": retention_minutes,
                "ticker_eligible": True,
                "ticker_until": (
                    now + timedelta(minutes=retention_minutes)
                ).isoformat(),
                "last_ticker_at": None,
                "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
                "persistent": True,
                "hero_eligible": False,
            }
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, item, True,
                "active",
            )
        if raw_state != "unavailable":
            return ProviderEvaluation(
                entity_id, self.capability, raw_state, normalized, None, True,
                "available" if raw_state != "unknown" else "state_unknown",
            )
        now = datetime.now(timezone.utc)
        item = {
            "id": f"capability:availability:{entity_id}:unavailable",
            "entity_id": entity_id,
            "event_type": "availability_unavailable",
            "provider": self.provider,
            "category": self.provider,
            "message": "Device Offline",
            "detail": f"{normalized['name']} is unavailable",
            "resolved_message": "Device Back Online",
            "resolved_detail": f"{normalized['name']} is available again",
            "resolved_icon": "mdi:cloud-check-outline",
            "resolved_priority": "normal",
            "icon": self.icon,
            "priority": str(config.get("priority") or "attention"),
            "active": True,
            "state": "unavailable",
            "created_at": normalized["created_at"],
            "source": "capability:availability",
            "metadata": normalized["metadata"],
            "retention_minutes": retention_minutes,
            "ticker_eligible": True,
            "ticker_until": (
                now + timedelta(minutes=retention_minutes)
            ).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
            "persistent": True,
            "hero_eligible": False,
        }
        return ProviderEvaluation(
            entity_id, self.capability, raw_state, normalized, item, True,
            "unavailable",
        )

    def interpret(self, normalized, config):
        """Availability evaluation constructs the alert directly."""
        raise NotImplementedError

    def current_item(self, evaluation, config):
        """Availability monitoring never publishes a normal current value."""
        return None
