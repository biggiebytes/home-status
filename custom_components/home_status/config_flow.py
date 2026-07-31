from __future__ import annotations

import voluptuous as vol
import logging
from homeassistant import config_entries
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.const import CONF_ENTITY_ID
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    CONF_CONTACT_FOOTER_PILOT,
    CONF_ENTITIES,
    CONF_ENTITY_IDS,
    DOMAIN,
    NAVIGATION_TARGETS,
    SUPPORTED_PROVIDERS,
    normalize_provider_options,
    normalize_providers,
    plain_entity_name,
)

_LOGGER = logging.getLogger(__name__)


class HomeStatusConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        if user_input is not None:
            await self.async_set_unique_id("home_status")
            self._abort_if_unique_id_configured()
            return self.async_create_entry(
                title="Home Status",
                data={},
            )

        # Entity selection belongs to the optional Customize flow, not setup.
        schema = vol.Schema({})
        return self.async_show_form(step_id="user", data_schema=schema)

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return HomeStatusOptionsFlow()


class HomeStatusOptionsFlow(config_entries.OptionsFlow):
    PROVIDERS = list(SUPPORTED_PROVIDERS)
    NAVIGATION_TARGETS = list(NAVIGATION_TARGETS)

    @staticmethod
    def _entity_selection(value):
        """Return an entity ID only when a non-empty selection was supplied."""
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    def _current(self):
        return normalize_provider_options({**self.config_entry.data, **self.config_entry.options})

    def _direct_history_choices(self):
        supported_binary_classes = {
            "door", "window", "opening", "garage_door", "lock",
            "moisture", "smoke", "gas", "carbon_monoxide",
        }
        supported_cover_classes = {"door", "garage", "gate", "window"}
        choices = []
        for state in self.hass.states.async_all():
            domain = state.entity_id.split(".", 1)[0]
            device_class = str(state.attributes.get("device_class") or "").lower()
            supported = (
                domain == "alarm_control_panel"
                or domain == "lock"
                or (domain == "binary_sensor" and device_class in supported_binary_classes)
                or (domain == "cover" and device_class in supported_cover_classes)
            )
            if not supported:
                continue
            choices.append({
                "value": state.entity_id,
                "label": plain_entity_name(
                    state.entity_id, state.attributes.get("friendly_name")
                ),
            })
        return sorted(choices, key=lambda choice: choice["label"].casefold())

    async def _discovered_views(self):
        """Load friendly dashboard/view choices from Lovelace configs."""
        lovelace = self.hass.data.get(LOVELACE_DATA)
        dashboards = getattr(lovelace, "dashboards", {}) if lovelace else {}
        discovered = {}
        items = dashboards.items() if isinstance(dashboards, dict) else ()
        for dashboard_key, dashboard in items:
            try:
                dashboard_meta = getattr(dashboard, "config", None) or {}
                dashboard_title = dashboard_meta.get("title") or (
                    "Overview" if dashboard_key is None
                    else str(dashboard_key).replace("-", " ").title()
                )
                dashboard_url = getattr(dashboard, "url_path", None) or dashboard_key or "lovelace"
                config = await dashboard.async_load(False)
                views = config.get("views", []) if isinstance(config, dict) else []
                for index, view in enumerate(views):
                    if not isinstance(view, dict):
                        continue
                    view_title = view.get("title") or f"View {index + 1}"
                    view_path = view.get("path")
                    route = str(view_path) if view_path not in (None, "") else str(index)
                    value = f"/{str(dashboard_url).strip('/')}/{route.strip('/')}"
                    discovered[value] = {
                        "value": value,
                        "label": f"{dashboard_title} → {view_title}",
                    }
            except Exception as err:
                if self._current().get("debug_logging", False):
                    _LOGGER.debug("Unable to read Lovelace dashboard %s: %s", dashboard_key, err)
        return sorted(discovered.values(), key=lambda choice: choice["label"].casefold())

    async def _save_step(self, user_input):
        options = normalize_provider_options(dict(self.config_entry.options))
        options.update(user_input)
        if "enabled_providers" in options:
            options["enabled_providers"] = normalize_providers(options["enabled_providers"])
        options = normalize_provider_options(options)
        discovered = await self._discovered_views()
        valid_targets = {choice["value"] for choice in discovered} | {"none", "entity", "custom"}
        for key, value in list(options.items()):
            if key.startswith("navigation_") and key != "navigation_enabled" and not key.startswith("navigation_custom_") and value not in valid_targets:
                provider = key.removeprefix("navigation_")
                options[key] = self._recommended_target(provider, discovered) or "none"
        self.hass.config_entries.async_update_entry(self.config_entry, options=options)
        return self.async_show_menu(step_id="init", menu_options=["general", "information_sources", "weather", "appearance", "navigation"])

    async def async_step_init(self, user_input=None):
        return self.async_show_menu(step_id="init", menu_options=["general", "information_sources", "weather", "appearance", "navigation"])

    @staticmethod
    def _recommended_target(provider, choices):
        terms = {
            "security": ("security", "alarm", "doors", "locks"),
            "weather": ("weather", "forecast", "radar"),
            "laundry": ("laundry", "washer", "dryer"),
            "schedule": ("calendar", "schedule", "sprinkler", "irrigation", "watering", "waste"),
            "maintenance": ("maintenance", "service", "repairs"),
            "climate": ("climate", "thermostat", "temperature", "hvac"),
            "cameras": ("camera", "cameras", "security camera"),
            "family": ("location", "map", "family", "people", "person"),
            "lighting": ("lighting", "lights", "exterior"),
            "sprinklers": ("sprinkler", "irrigation", "watering"),
            "waste": ("waste", "trash", "garbage", "recycling", "collection"),
        }
        needles = terms.get(provider, (provider,))
        exact = []
        partial = []
        for choice in choices:
            label = choice["label"].lower()
            words = set(label.replace("→", " ").split())
            if any(needle in words for needle in needles):
                exact.append(choice["value"])
            elif any(needle in label for needle in needles):
                partial.append(choice["value"])
        return (exact or partial or [None])[0]

    def _provider_choices(self, provider, discovered):
        recommended = self._recommended_target(provider, discovered)
        pages = [dict(choice) for choice in discovered]
        if recommended:
            pages.sort(key=lambda choice: (
                choice["value"] != recommended,
                choice["label"].casefold(),
            ))
            pages[0]["label"] = f"{pages[0]['label']} — Recommended"
        return [
            *pages,
            {"value": "entity", "label": "Open Device Details"},
            {"value": "none", "label": "Don't Open Anything"},
            {"value": "custom", "label": "Custom Page (Advanced)"},
        ], recommended

    async def async_step_navigation(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        discovered = await self._discovered_views()
        schema = {
            vol.Optional("navigation_enabled", default=current.get("navigation_enabled", True)): selector.BooleanSelector(),
        }
        for target in self.NAVIGATION_TARGETS:
            choices, recommended = self._provider_choices(target, discovered)
            saved = current.get(f"navigation_{target}")
            default = saved if saved in {choice["value"] for choice in choices} else recommended or "none"
            schema[vol.Optional(f"navigation_{target}", default=default)] = selector.SelectSelector(
                selector.SelectSelectorConfig(options=choices, mode=selector.SelectSelectorMode.DROPDOWN)
            )
        return self.async_show_form(step_id="navigation", data_schema=vol.Schema(schema))

    async def async_step_general(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="general", data_schema=vol.Schema({
            vol.Optional("refresh_interval", default=current.get("refresh_interval", 60)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=15, max=3600, step=15, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("history_retention_days", default=current.get("history_retention_days", 7)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=365, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_recent_items", default=current.get("max_recent_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=50, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_upcoming_items", default=current.get("max_upcoming_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=50, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_insight_items", default=current.get("max_insight_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=50, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
        }))

    async def async_step_information_sources(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        history_choices = self._direct_history_choices()
        discovered_history = [choice["value"] for choice in history_choices]
        return self.async_show_form(step_id="information_sources", data_schema=vol.Schema({
            vol.Optional("enabled_providers", default=current.get("enabled_providers", self.PROVIDERS)): selector.SelectSelector(
                selector.SelectSelectorConfig(options=self.PROVIDERS, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
            vol.Optional("history_entities", default=current.get("history_entities", discovered_history)): selector.SelectSelector(
                selector.SelectSelectorConfig(options=history_choices, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
        }))

    async def async_step_appearance(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="appearance", data_schema=vol.Schema({
            vol.Optional("hero_rotation_seconds", default=current.get("hero_rotation_seconds", 4)): selector.NumberSelector(selector.NumberSelectorConfig(min=1, max=120, step=1, mode=selector.NumberSelectorMode.BOX)),
            vol.Optional("media_enabled", default=current.get("media_enabled", True)): selector.BooleanSelector(),
            vol.Optional("collapse_repeated_events", default=current.get("collapse_repeated_events", True)): selector.BooleanSelector(),
            vol.Optional("deduplicate_by_entity", default=current.get("deduplicate_by_entity", True)): selector.BooleanSelector(),
            vol.Optional("enable_insights", default=current.get("enable_insights", True)): selector.BooleanSelector(),
        }))

    async def async_step_weather(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="weather", data_schema=vol.Schema({
            vol.Optional("include_nws_alerts", default=current.get("include_nws_alerts", True)): selector.BooleanSelector(),
            vol.Optional("include_sprinkler_schedule", default=current.get("include_sprinkler_schedule", True)): selector.BooleanSelector(),
            vol.Optional("include_waste_collection", default=current.get("include_waste_collection", True)): selector.BooleanSelector(),
            vol.Optional("forecast_entity", default=current.get("forecast_entity", "")): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="weather")
            ),
            vol.Optional("weather_preview_condition", default=current.get("weather_preview_condition", "")): selector.SelectSelector(
                selector.SelectSelectorConfig(options=["", "rain", "clouds", "storm", "clear", "wind", "fog", "night"], mode=selector.SelectSelectorMode.DROPDOWN)
            ),
        }))

    async def async_step_advanced(self, user_input=None):
        if user_input is not None:
            invalid = any(
                value and not str(value).startswith("/")
                for key, value in user_input.items()
                if key.startswith("navigation_custom_")
            )
            if invalid:
                return self.async_show_form(
                    step_id="advanced",
                    data_schema=self._advanced_schema(user_input),
                    errors={"base": "custom_page_must_start_with_slash"},
                )
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="advanced", data_schema=self._advanced_schema(current))

    def _advanced_schema(self, current):
        schema = {
            vol.Optional("debug_logging", default=current.get("debug_logging", False)): selector.BooleanSelector(),
            vol.Optional(
                CONF_CONTACT_FOOTER_PILOT,
                default=current.get(CONF_CONTACT_FOOTER_PILOT, False),
            ): selector.BooleanSelector(),
            vol.Optional(
                "refrigerator_door_delay_minutes",
                default=current.get("refrigerator_door_delay_minutes", 3),
            ): selector.NumberSelector(selector.NumberSelectorConfig(
                min=1, max=15, step=1,
                mode=selector.NumberSelectorMode.BOX,
            )),
            vol.Optional(
                "refrigerator_temperature_delay_minutes",
                default=current.get("refrigerator_temperature_delay_minutes", 10),
            ): selector.NumberSelector(selector.NumberSelectorConfig(
                min=1, max=60, step=1,
                mode=selector.NumberSelectorMode.BOX,
            )),
            vol.Optional(
                "refrigerator_fridge_high_temperature",
                default=current.get("refrigerator_fridge_high_temperature", 42),
            ): selector.NumberSelector(selector.NumberSelectorConfig(
                min=35, max=60, step=1,
                mode=selector.NumberSelectorMode.BOX,
                unit_of_measurement="°F",
            )),
            vol.Optional(
                "refrigerator_freezer_high_temperature",
                default=current.get("refrigerator_freezer_high_temperature", 10),
            ): selector.NumberSelector(selector.NumberSelectorConfig(
                min=0, max=40, step=1,
                mode=selector.NumberSelectorMode.BOX,
                unit_of_measurement="°F",
            )),
        }
        for provider in self.NAVIGATION_TARGETS:
            schema[vol.Optional(
                f"navigation_custom_{provider}",
                default=current.get(f"navigation_custom_{provider}", ""),
            )] = selector.TextSelector()
        return vol.Schema(schema)

    async def async_step_customize(self, user_input=None):
        current = self._current()
        raw_overrides = current.get("entity_overrides")
        overrides = raw_overrides if isinstance(raw_overrides, dict) else {}
        selected = self._entity_selection(user_input.get("override_entity")) if user_input else None
        existing = overrides.get(selected, {}) if selected else {}
        existing = existing if isinstance(existing, dict) else {}
        if user_input is not None:
            options = dict(self.config_entry.options)
            options.update({k: v for k, v in user_input.items() if k not in {"override_entity", "reset_override"}})
            updated = dict(overrides)
            if selected:
                if user_input.get("reset_override"):
                    updated.pop(selected, None)
                else:
                    updated[selected] = {k: v for k in ("provider_override", "label_override", "icon_override", "priority_override", "publish_mode") if (v := user_input.get(k)) not in (None, "", "none")}
            options["entity_overrides"] = updated
            self.hass.config_entries.async_update_entry(self.config_entry, options=options)
            return self.async_show_menu(step_id="init", menu_options=["general", "information_sources", "weather", "appearance", "navigation"])
        return self.async_show_form(step_id="customize", data_schema=vol.Schema({
            vol.Optional("override_entity"): selector.EntitySelector(),
            vol.Optional("provider_override", default=existing.get("provider_override", "none")): selector.SelectSelector(
                selector.SelectSelectorConfig(options=["none", *self.PROVIDERS], mode=selector.SelectSelectorMode.DROPDOWN)
            ),
            vol.Optional("label_override", default=existing.get("label_override", "")): selector.TextSelector(),
            vol.Optional("icon_override", default=existing.get("icon_override", "")): selector.TextSelector(),
            vol.Optional("priority_override", default=existing.get("priority_override", "none")): selector.SelectSelector(selector.SelectSelectorConfig(options=["none", "critical", "attention", "activity", "normal"], mode=selector.SelectSelectorMode.DROPDOWN)),
            vol.Optional("publish_mode", default=existing.get("publish_mode", "both")): selector.SelectSelector(selector.SelectSelectorConfig(options=["events", "status", "both", "disabled"], mode=selector.SelectSelectorMode.DROPDOWN)),
            vol.Optional("reset_override", default=False): selector.BooleanSelector(),
        }))

    def _option(self, key, default):
        return self.config_entry.options.get(key, default)
