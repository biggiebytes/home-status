"""Experimental Temperature and Humidity capability providers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from .base import CapabilityProvider


class NumericThresholdProvider(CapabilityProvider):
    """Interpret low/high thresholds in the entity's native unit."""

    @staticmethod
    def _display_number(value: float) -> str:
        """Format household readings without sensor-level noise."""
        return f"{value:.1f}".rstrip("0").rstrip(".")

    @staticmethod
    def _threshold(config: dict[str, Any], key: str) -> float | None:
        value = config.get(key)
        if value in (None, ""):
            return None
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def interpret(
        self, normalized: dict[str, Any], config: dict[str, Any]
    ) -> tuple[dict[str, Any] | None, str]:
        value = normalized["value"]
        low = self._threshold(config, "low_threshold")
        high = self._threshold(config, "high_threshold")
        direction = None
        threshold = None
        if low is not None and value < low:
            direction, threshold = "low", low
        elif high is not None and value > high:
            direction, threshold = "high", high
        if direction is None:
            reason = (
                "within_configured_thresholds"
                if low is not None or high is not None
                else "no_threshold_configured"
            )
            return None, reason
        entity_id = normalized["entity_id"]
        unit = normalized["unit"]
        reading = self._display_number(value)
        limit = self._display_number(threshold)
        relation = "Above" if direction == "high" else "Below"
        now = datetime.now(timezone.utc)
        return {
            "id": f"capability:{self.capability}:{entity_id}:{direction}",
            "entity_id": entity_id,
            "event_type": f"{self.capability}_threshold",
            "provider": self.provider,
            "category": self.provider,
            "message": f"{direction.title()} {self.capability.title()}",
            "detail": f"{reading}{unit} — {relation} {limit}{unit}",
            "icon": self.icon,
            "priority": str(config.get("priority") or "attention"),
            "active": True,
            "state": direction,
            "value": value,
            "unit": unit,
            "created_at": normalized["created_at"],
            "source": f"capability:{self.capability}",
            "metadata": normalized["metadata"],
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
            "persistent": True,
            "hero_eligible": False,
        }, f"{direction}_threshold_crossed"


class TemperatureProvider(NumericThresholdProvider):
    capability = "temperature"
    device_classes = frozenset({"temperature"})
    icon = "mdi:thermometer-alert"


class HumidityProvider(NumericThresholdProvider):
    capability = "humidity"
    device_classes = frozenset({"humidity"})
    icon = "mdi:water-percent-alert"
