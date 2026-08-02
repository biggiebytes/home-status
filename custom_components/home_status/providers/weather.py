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


class WeatherProviderMixin:
    async def _async_refresh_forecast(self) -> None:
        entity_id = self._resolve_forecast_entity()
        if not entity_id:
            self._forecast = []
            if self._forecast_warning != "none":
                _LOGGER.debug("Home Status forecast unavailable: no usable weather entity is configured or uniquely discoverable")
                self._forecast_warning = "none"
            return
        weather_state = self.hass.states.get(entity_id)
        if weather_state is None or weather_state.state in {"unknown", "unavailable"}:
            self._forecast = []
            self._forecast_warning = f"unavailable:{entity_id}"
            _LOGGER.debug("Home Status forecast entity is unavailable: %s", entity_id)
            return
        try:
            supported_features = WeatherEntityFeature(
                int(weather_state.attributes.get("supported_features", 0))
            )
        except (TypeError, ValueError):
            supported_features = WeatherEntityFeature(0)
        forecast_types = []
        for feature_name, forecast_type in (
            ("FORECAST_DAILY", "daily"),
            ("FORECAST_HOURLY", "hourly"),
            ("FORECAST_TWICE_DAILY", "twice_daily"),
        ):
            feature = getattr(WeatherEntityFeature, feature_name, None)
            if feature is not None and supported_features & feature:
                forecast_types.append(forecast_type)
        if not forecast_types:
            self._forecast = []
            self._forecast_warning = f"unsupported:{entity_id}"
            _LOGGER.debug("Home Status weather entity does not advertise forecasts: %s", entity_id)
            return
        forecast_service = self.hass.services.async_services().get("weather", {}).get("get_forecasts")
        if forecast_service is None or not getattr(forecast_service, "supports_response", False):
            self._forecast = []
            self._forecast_warning = f"unsupported:{entity_id}"
            _LOGGER.debug("Home Status forecast service is unavailable for %s", entity_id)
            return
        response = None
        last_error = None
        for forecast_type in forecast_types:
            try:
                response = await self.hass.services.async_call(
                    "weather", "get_forecasts",
                    {"entity_id": entity_id, "type": forecast_type},
                    blocking=True, return_response=True,
                )
                break
            except Exception as err:
                last_error = err
        if response is None:
            self._forecast = []
            warning = f"error:{entity_id}"
            if self._forecast_warning != warning:
                _LOGGER.debug("Home Status forecast unavailable for %s: %s", entity_id, last_error)
                self._forecast_warning = warning
            return
        payload = response.get(entity_id, {}) if isinstance(response, dict) else {}
        forecast = payload.get("forecast", []) if isinstance(payload, dict) else []
        self._forecast = forecast if isinstance(forecast, list) else []
        self._forecast_warning = None


    def _resolve_forecast_entity(self) -> str | None:
        configured = self.options.get("forecast_entity")
        if configured and configured.startswith("weather.") and (
            self.hass.states.get(configured) is not None
            or er.async_get(self.hass).async_get(configured) is not None
        ):
            return configured
        discovered = [state.entity_id for state in self.hass.states.async_all("weather")]
        if len(discovered) == 1:
            return discovered[0]
        registry = er.async_get(self.hass)
        registered = [
            entity.entity_id for entity in registry.entities.values()
            if entity.domain == "weather" and entity.disabled_by is None
        ]
        return registered[0] if len(registered) == 1 else None


    def _weather_visuals(self, condition: str) -> dict:
        """Return optional presentation metadata without changing the provider contract."""
        override = str(self.options.get("weather_preview_condition") or "").strip().lower()
        normalized = override or str(condition or "").strip().lower().replace("_", "-")
        effects = {
            "sunny": "clear",
            "clear": "clear",
            "clear-night": "night",
            "night": "night",
            "cloudy": "clouds",
            "partlycloudy": "clouds",
            "partly-cloudy": "clouds",
            "clouds": "clouds",
            "rainy": "rain",
            "pouring": "rain",
            "rain": "rain",
            "lightning": "storm",
            "lightning-rainy": "storm",
            "thunderstorm": "storm",
            "storm": "storm",
            "fog": "fog",
            "windy": "wind",
            "windy-variant": "wind",
            "wind": "wind",
            "snowy": "clouds",
            "snowy-rainy": "rain",
            "hail": "storm",
            "exceptional": "storm",
        }
        effect = effects.get(normalized, "clear")
        return {"media_url": None, "media_type": None, "visual_effect": effect}


    def _current_weather_visual_effect(self) -> str | None:
        """Resolve one presentation-only effect from the existing weather entity."""
        entity_id = self._resolve_forecast_entity()
        state = self.hass.states.get(entity_id) if entity_id else None
        condition = state.state if state and state.state not in {"unknown", "unavailable"} else ""
        return self._weather_visuals(str(condition)).get("visual_effect")


    def _build_weather_item(self, entity_id: str, state: State, alert: dict) -> dict:
        event = str(alert.get("Event") or alert.get("event") or "Weather Alert")
        expires = alert.get("Expires") or alert.get("expires")
        headline = self._clean_weather_headline(
            alert.get("Headline") or alert.get("headline") or "",
            event,
        )
        stable = alert.get("ID") or alert.get("id") or f"{event}|{alert.get('Effective') or alert.get('effective')}|{expires}"
        provider = self.registry.provider_for("weather_alert") or PROVIDER_WEATHER
        severity = str(alert.get("Severity") or alert.get("severity") or "").lower()
        priority = "critical" if severity in {"extreme", "severe"} else "attention"
        now_dt = datetime.now(timezone.utc)
        active = True
        if expires:
            try:
                active = now_dt < datetime.fromisoformat(str(expires).replace("Z", "+00:00")).astimezone(timezone.utc)
            except ValueError:
                _LOGGER.warning("Invalid weather alert expiration for %s: %s", entity_id, expires)
        now = now_dt.isoformat()
        return {
            "id": f"{entity_id}:{stable}", "entity_id": entity_id, "event_type": "weather_alert",
            "category": provider, "provider": provider, "message": event,
            "headline": headline,
            "detail": alert.get("Description") or headline,
            "instruction": alert.get("Instruction") or "", "source_severity": severity,
            "priority": priority, "created_at": now, "expires_at": expires,
            "active": active, "persistent": True, "ticker_eligible": active,
            "ticker_until": (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(),
            "last_ticker_at": None, "next_reminder_at": (datetime.now(timezone.utc) + timedelta(minutes=45)).isoformat(),
        }


    @staticmethod
    def _clean_weather_headline(value: str, event: str | None = None) -> str:
        text = " ".join(str(value or "").replace("…", "...").split())
        text = re.sub(
            r"^\*?\s*WHAT(?:\s*\.{3})?\s*",
            "",
            text,
            flags=re.IGNORECASE,
        ).lstrip("* ").strip()
        parts = [
            part.strip(" .*-")
            for part in re.split(r"\.{3,}", text)
            if part.strip(" .*-")
        ]
        if event:
            event_text = " ".join(str(event).split()).strip()
            meaningful = [
                part for part in parts
                if part.casefold() != event_text.casefold()
            ]
            text = (meaningful or parts or [""])[0]
            escaped = re.escape(event_text)
            text = re.sub(
                rf"^{escaped}\s*[:\-–—]*\s*",
                "",
                text,
                flags=re.IGNORECASE,
            )
            text = re.sub(
                rf"\s*[:\-–—]*\s*{escaped}$",
                "",
                text,
                flags=re.IGNORECASE,
            )
        else:
            text = (parts or [text])[0]
        text = " ".join(text.split()).strip(" .")
        if text.isupper():
            text = text.capitalize()
            text = re.sub(
                r"\b(am|pm|edt|est|cdt|cst|mdt|mst|pdt|pst|nws)\b",
                lambda match: match.group(1).upper(),
                text,
                flags=re.IGNORECASE,
            )
        return (
            text.rstrip(".") + "."
            if text and not text.endswith((".", "!", "?"))
            else text
        )

