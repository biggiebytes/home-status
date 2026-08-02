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
    CONF_CAPABILITY_SENSORS,
    CONF_ENTITIES,
    CONF_ENTITY_IDS,
    DOMAIN,
    NAVIGATION_TARGETS,
    PROVIDER_CONTRACT_VERSION,
    SUPPORTED_PROVIDERS,
    normalize_provider_options,
    normalize_providers,
    plain_entity_name,
)
from .providers import CapabilityProviderRegistry

_LOGGER = logging.getLogger(__name__)

ESSENTIAL_PROVIDERS = {
    "security",
    "weather",
    "schedule",
    "maintenance",
    "laundry",
}
CAPABILITY_LABELS = {
    "weather": "Weather",
    "calendar": "Calendar",
    "laundry": "Laundry",
    "waste": "Waste",
    "security": "Security",
    "sprinklers": "Sprinklers",
    "maintenance": "Maintenance",
    "climate": "Climate",
    "cameras": "Cameras",
    "family": "Family",
    "lighting": "Lighting",
    "news": "News",
}
CAPABILITY_ORDER = tuple(CAPABILITY_LABELS)


class HomeStatusConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._setup_options: dict = {}
        self._detected_capabilities: set[str] = set()
        self._weather_entities: list[str] = []

    @staticmethod
    def _matches(text: str, *terms: str) -> bool:
        return any(term in text for term in terms)

    def _discover_environment(self) -> dict[str, list[str]]:
        """Discover supported household sources without requiring entity IDs."""
        groups: dict[str, set[str]] = {}
        detected: set[str] = set()
        weather_entities: list[str] = []

        def add(role: str, entity_id: str) -> None:
            groups.setdefault(role, set()).add(entity_id)

        for state in self.hass.states.async_all():
            entity_id = state.entity_id
            domain = entity_id.split(".", 1)[0]
            device_class = str(state.attributes.get("device_class") or "").lower()
            friendly_name = str(state.attributes.get("friendly_name") or "")
            text = f"{entity_id} {friendly_name}".replace("_", " ").replace("-", " ").lower()

            if domain == "weather":
                detected.add("weather")
                weather_entities.append(entity_id)

            if domain == "calendar":
                if self._matches(text, "waste", "trash", "garbage", "recycling", "yard waste"):
                    detected.add("waste")
                    add("waste_schedule", entity_id)
                elif self._matches(text, "sprinkler", "irrigation", "watering"):
                    detected.add("sprinklers")
                    add("sprinkler_schedule", entity_id)
                else:
                    detected.add("calendar")
                    add("family_calendar", entity_id)

            if (
                domain in {"alarm_control_panel", "lock"}
                or (domain == "binary_sensor" and device_class in {
                    "door", "window", "opening", "garage_door", "moisture",
                    "smoke", "gas", "carbon_monoxide",
                })
                or (domain == "cover" and device_class in {"door", "garage", "gate", "window"})
            ):
                detected.add("security")

            if domain == "camera":
                detected.add("cameras")
            if domain == "person":
                detected.add("family")
            if domain == "light":
                detected.add("lighting")
            if domain == "climate":
                detected.add("climate")

            is_sprinkler = self._matches(text, "sprinkler", "irrigation", "watering")
            if is_sprinkler:
                detected.add("sprinklers")
                if domain == "valve":
                    add("sprinkler_valves", entity_id)
                elif domain in {"sensor", "switch", "calendar"}:
                    add("sprinkler_schedule", entity_id)

            is_waste = self._matches(text, "waste", "trash", "garbage", "recycling", "yard waste")
            if is_waste and domain in {"sensor", "calendar"}:
                detected.add("waste")
                add("waste_schedule", entity_id)

            is_appliance = self._matches(text, "washer", "dryer", "dishwasher")
            if is_appliance and domain in {"sensor", "binary_sensor"}:
                detected.add("laundry")
                if self._matches(text, "remaining", "time remaining", "completion time"):
                    add("laundry_remaining", entity_id)
                elif self._matches(text, "rinse", "clean reminder", "maintenance", "refill"):
                    add("appliance_maintenance", entity_id)
                else:
                    add("laundry_state", entity_id)

            is_filter = self._matches(text, "filter", "blocked vent")
            is_maintenance = (
                domain == "update"
                or device_class == "problem"
                or is_filter
                or self._matches(text, "maintenance", "service due", "fault")
            )
            if is_maintenance:
                detected.add("maintenance")
                if domain == "update":
                    add("system_updates", entity_id)
                elif is_filter and self._matches(text, "usage", "percent", "percentage"):
                    add("filter_usage", entity_id)
                elif is_filter:
                    add("filter_status", entity_id)
                else:
                    add("maintenance_sensors", entity_id)

            if domain == "sensor" and device_class == "temperature" and self._matches(
                text, "thermostat", "climate", "indoor", "room temperature"
            ):
                detected.add("climate")
                add("climate_temperature", entity_id)

            if domain == "sensor" and (
                ("nws" in text and "alert" in text)
                or isinstance(state.attributes.get("alerts"), list)
            ):
                detected.add("weather")
                add("weather_alert", entity_id)

            if domain == "sensor" and self._matches(text, "news", "headline", "rss feed"):
                detected.add("news")
                add("news_sources", entity_id)

        self._detected_capabilities = detected
        self._weather_entities = sorted(dict.fromkeys(weather_entities))
        return {
            role: sorted(entity_ids)
            for role, entity_ids in groups.items()
            if entity_ids
        }

    def _apply_automatic_discovery(self) -> None:
        """Discover available capabilities without selecting entities."""
        self._discover_environment()

    async def _continue_automatic_setup(self):
        if len(self._weather_entities) == 1:
            self._setup_options["forecast_entity"] = self._weather_entities[0]
        if len(self._weather_entities) > 1:
            return await self.async_step_weather()
        return await self.async_step_summary()

    async def async_step_user(self, user_input=None):
        if user_input is not None:
            profile = user_input["setup_profile"]
            self._setup_options = {
                "setup_profile": profile,
                "provider_contract_version": PROVIDER_CONTRACT_VERSION,
                "enabled_providers": list(SUPPORTED_PROVIDERS),
                "media_enabled": True,
                "include_nws_alerts": True,
                "include_sprinkler_schedule": True,
                "include_waste_collection": True,
            }
            if profile == "essentials":
                self._setup_options["enabled_providers"] = [
                    provider
                    for provider in SUPPORTED_PROVIDERS
                    if provider in ESSENTIAL_PROVIDERS
                ]
            if profile == "custom":
                self._discover_environment()
                return await self.async_step_sources()
            self._apply_automatic_discovery()
            return await self._continue_automatic_setup()

        await self.async_set_unique_id("home_status")
        self._abort_if_unique_id_configured()
        schema = vol.Schema({
            vol.Required("setup_profile", default="recommended"): selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=["recommended", "essentials", "custom"],
                    mode=selector.SelectSelectorMode.LIST,
                )
            )
        })
        return self.async_show_form(step_id="user", data_schema=schema)

    async def async_step_sources(self, user_input=None):
        if user_input is not None:
            self._setup_options.update(user_input)
            self._setup_options["enabled_providers"] = normalize_providers(
                self._setup_options.get("enabled_providers")
            )
            if "weather" not in self._setup_options["enabled_providers"]:
                return await self.async_step_summary()
            return await self.async_step_weather()

        history_choices = HomeStatusOptionsFlow.direct_history_choices(self.hass)
        return self.async_show_form(
            step_id="sources",
            data_schema=vol.Schema({
                vol.Required(
                    "enabled_providers",
                    default=list(SUPPORTED_PROVIDERS),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=list(SUPPORTED_PROVIDERS),
                        multiple=True,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
                vol.Optional(
                    "history_entities",
                    default=[],
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=history_choices,
                        multiple=True,
                        mode=selector.SelectSelectorMode.LIST,
                    )
                ),
            }),
        )

    async def async_step_weather(self, user_input=None):
        if user_input is not None:
            self._setup_options.update(user_input)
            return await self.async_step_summary()

        forecast_field = vol.Optional("forecast_entity")
        if self._setup_options.get("setup_profile") != "custom" and len(self._weather_entities) > 1:
            forecast_field = vol.Required("forecast_entity")
        return self.async_show_form(
            step_id="weather",
            data_schema=vol.Schema({
                forecast_field: selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="weather")
                ),
                vol.Optional(
                    "include_nws_alerts",
                    default=self._setup_options.get("include_nws_alerts", True),
                ): selector.BooleanSelector(),
            }),
        )

    async def async_step_summary(self, user_input=None):
        if user_input is not None:
            return self.async_create_entry(
                title="Home Status",
                data=normalize_provider_options(self._setup_options),
            )

        if not self._detected_capabilities:
            self._discover_environment()
        detected = [
            CAPABILITY_LABELS[key]
            for key in CAPABILITY_ORDER
            if key in self._detected_capabilities
        ]
        not_detected = [
            CAPABILITY_LABELS[key]
            for key in CAPABILITY_ORDER
            if key not in self._detected_capabilities
        ]
        return self.async_show_form(
            step_id="summary",
            data_schema=vol.Schema({}),
            description_placeholders={
                "detected": "\n".join(f"• {label}" for label in detected) or "• Nothing yet",
                "not_detected": "\n".join(f"• {label}" for label in not_detected) or "• None",
            },
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return HomeStatusOptionsFlow()


class HomeStatusOptionsFlow(config_entries.OptionsFlow):
    PROVIDERS = list(SUPPORTED_PROVIDERS)
    NAVIGATION_TARGETS = list(NAVIGATION_TARGETS)
    MENU_OPTIONS = [
        "general",
        "information_sources",
        "experimental_sensors",
        "weather",
        "appearance",
        "navigation",
        "customize",
        "advanced",
    ]

    def __init__(self) -> None:
        self._pending_options: dict | None = None
        self._pending_summary = ""
        self._pending_warnings = ""

    @staticmethod
    def _entity_selection(value):
        """Return an entity ID only when a non-empty selection was supplied."""
        if not isinstance(value, str):
            return None
        value = value.strip()
        return value or None

    def _current(self):
        return normalize_provider_options({**self.config_entry.data, **self.config_entry.options})

    @staticmethod
    def direct_history_choices(hass):
        supported_binary_classes = {
            "door", "window", "opening", "garage_door", "lock",
            "moisture", "smoke", "gas", "carbon_monoxide",
        }
        supported_cover_classes = {"door", "garage", "gate", "window"}
        choices = []
        for state in hass.states.async_all():
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

    def _direct_history_choices(self):
        return self.direct_history_choices(self.hass)

    def _settings_menu(self):
        return self.async_show_menu(
            step_id="init",
            menu_options=self.MENU_OPTIONS,
        )

    def _detected_stable_providers(self) -> set[str]:
        """Return provider capabilities found without selecting any entity."""
        detected: set[str] = set()
        for state in self.hass.states.async_all():
            entity_id = state.entity_id
            domain = entity_id.split(".", 1)[0]
            device_class = str(state.attributes.get("device_class") or "").lower()
            text = f"{entity_id} {state.attributes.get('friendly_name') or ''}".replace(
                "_", " "
            ).lower()
            if domain == "weather":
                detected.add("weather")
            if domain == "calendar":
                detected.add("schedule")
            if domain in {"alarm_control_panel", "lock"} or (
                domain == "binary_sensor"
                and device_class in {
                    "door", "window", "opening", "garage_door", "moisture",
                    "smoke", "gas", "carbon_monoxide",
                }
            ) or (domain == "cover" and device_class in {"door", "garage", "gate", "window"}):
                detected.add("security")
            if domain == "camera":
                detected.add("cameras")
            if domain == "person":
                detected.add("family")
            if domain == "light":
                detected.add("lighting")
            if domain == "climate" or (domain == "sensor" and device_class in {"temperature", "humidity"}):
                detected.add("climate")
            if any(term in text for term in ("washer", "dryer", "dishwasher")):
                detected.add("laundry")
            if domain == "update" or device_class == "problem" or any(
                term in text for term in ("filter", "maintenance", "service due", "fault")
            ):
                detected.add("maintenance")
            if domain == "sensor" and any(term in text for term in ("news", "headline", "rss feed")):
                detected.add("news")
        return detected

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
        changed = sorted(user_input)
        self._pending_options = options
        self._pending_summary = "\n".join(
            f"â€¢ {key.replace('_', ' ').title()}"
            for key in changed
        ) or "â€¢ No setting changes"
        warnings = []
        effective = normalize_provider_options({
            **self.config_entry.data,
            **options,
        })
        enabled = normalize_providers(effective.get("enabled_providers"))
        if not enabled:
            warnings.append(
                "No informational providers are enabled. Direct household state can still work, but the Notification Center may be empty."
            )
        detected = self._detected_stable_providers()
        missing = [
            CAPABILITY_LABELS.get(provider, provider.title())
            for provider in enabled
            if provider not in detected
        ]
        if missing:
            warnings.append(
                "No compatible entities are currently detected for: " + ", ".join(missing) + ". These providers will remain enabled but may not publish items until configured."
            )
        self._pending_warnings = "\n".join(f"â€¢ {warning}" for warning in warnings) or "â€¢ No problems found"
        return await self.async_step_review()

    async def async_step_init(self, user_input=None):
        return self._settings_menu()

    async def async_step_review(self, user_input=None):
        if self._pending_options is None:
            return self._settings_menu()
        if user_input is not None:
            self.hass.config_entries.async_update_entry(
                self.config_entry,
                options=self._pending_options,
            )
            self._pending_options = None
            return self._settings_menu()
        return self.async_show_form(
            step_id="review",
            data_schema=vol.Schema({}),
            description_placeholders={
                "changes": self._pending_summary,
                "warnings": self._pending_warnings,
            },
        )

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
        detected = self._detected_stable_providers()
        provider_choices = [
            {
                "value": provider,
                "label": f"{CAPABILITY_LABELS.get(provider, provider.title())}{' â€” Detected' if provider in detected else ''}",
            }
            for provider in self.PROVIDERS
        ]
        return self.async_show_form(step_id="information_sources", data_schema=vol.Schema({
            vol.Optional("enabled_providers", default=current.get("enabled_providers", self.PROVIDERS)): selector.SelectSelector(
                selector.SelectSelectorConfig(options=provider_choices, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
            vol.Optional("history_entities", default=current.get("history_entities", [])): selector.SelectSelector(
                selector.SelectSelectorConfig(options=history_choices, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
        }), description_placeholders={
            "detected": ", ".join(
                CAPABILITY_LABELS.get(provider, provider.title())
                for provider in self.PROVIDERS
                if provider in detected
            ) or "None yet",
        })

    def _capability_candidates(self):
        registry = CapabilityProviderRegistry()
        candidates = {item.entity_id: item for item in registry.discover(self.hass)}
        current = registry.configs(self._current())
        choices = []
        for entity_id in sorted(set(candidates) | set(current)):
            item = candidates.get(entity_id)
            capability = (
                item.capability if item else current[entity_id]["capability"]
            )
            name = item.name if item else plain_entity_name(entity_id)
            area = f" · {item.area_name}" if item and item.area_name else ""
            choices.append({
                "value": entity_id,
                "label": f"{name} — {capability.title()}{area}",
            })
        return choices, candidates, current

    async def async_step_experimental_sensors(self, user_input=None):
        choices, _, current = self._capability_candidates()
        if user_input is not None:
            selected = self._entity_selection(
                user_input.get("capability_entity")
            )
            if selected:
                self._selected_capability_entity = selected
                return await self.async_step_experimental_sensor()
            return self._settings_menu()
        default = next(iter(current), choices[0]["value"] if choices else None)
        schema = {}
        field = vol.Optional("capability_entity")
        if default:
            field = vol.Optional("capability_entity", default=default)
        schema[field] = selector.SelectSelector(
            selector.SelectSelectorConfig(
                options=choices,
                mode=selector.SelectSelectorMode.DROPDOWN,
            )
        )
        return self.async_show_form(
            step_id="experimental_sensors",
            data_schema=vol.Schema(schema),
        )

    async def async_step_experimental_sensor(self, user_input=None):
        entity_id = getattr(self, "_selected_capability_entity", None)
        choices, candidates, current = self._capability_candidates()
        if not entity_id or entity_id not in {choice["value"] for choice in choices}:
            return await self.async_step_experimental_sensors()
        existing = current.get(entity_id, {})
        candidate = candidates.get(entity_id)
        capability = (
            candidate.capability if candidate else existing.get("capability")
        )
        errors = {}
        if user_input is not None:
            low = user_input.get("low_threshold")
            high = user_input.get("high_threshold")
            if low is not None and high is not None and float(low) >= float(high):
                errors["base"] = "low_threshold_must_be_less_than_high"
            else:
                configured = dict(current)
                if user_input.get("remove_sensor"):
                    configured.pop(entity_id, None)
                else:
                    sensor_config = {
                        "capability": capability,
                        "priority": user_input.get("priority", "attention"),
                        "publish_current": user_input.get(
                            "publish_current", False
                        ),
                    }
                    if low is not None:
                        sensor_config["low_threshold"] = low
                    if high is not None:
                        sensor_config["high_threshold"] = high
                    configured[entity_id] = sensor_config
                self._selected_capability_entity = None
                return await self._save_step({
                    CONF_CAPABILITY_SENSORS: configured
                })
        schema = {}
        low_field = vol.Optional("low_threshold")
        high_field = vol.Optional("high_threshold")
        if "low_threshold" in existing:
            low_field = vol.Optional(
                "low_threshold", default=existing["low_threshold"]
            )
        if "high_threshold" in existing:
            high_field = vol.Optional(
                "high_threshold", default=existing["high_threshold"]
            )
        number_selector = selector.NumberSelector(
            selector.NumberSelectorConfig(
                mode=selector.NumberSelectorMode.BOX
            )
        )
        schema[low_field] = number_selector
        schema[high_field] = number_selector
        schema[vol.Optional(
            "priority", default=existing.get("priority", "attention")
        )] = selector.SelectSelector(selector.SelectSelectorConfig(
            options=["normal", "activity", "attention", "critical"],
            mode=selector.SelectSelectorMode.DROPDOWN,
        ))
        schema[vol.Optional(
            "publish_current",
            default=existing.get("publish_current", False),
        )] = selector.BooleanSelector()
        schema[vol.Optional("remove_sensor", default=False)] = (
            selector.BooleanSelector()
        )
        return self.async_show_form(
            step_id="experimental_sensor",
            data_schema=vol.Schema(schema),
            errors=errors,
            description_placeholders={
                "entity": entity_id,
                "capability": str(capability).title(),
                "unit": candidate.unit if candidate and candidate.unit else "the entity's native unit",
            },
        )

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
            updated = dict(overrides)
            if selected:
                if user_input.get("reset_override"):
                    updated.pop(selected, None)
                else:
                    updated[selected] = {k: v for k in ("provider_override", "label_override", "icon_override", "priority_override", "publish_mode") if (v := user_input.get(k)) not in (None, "", "none")}
            return await self._save_step({"entity_overrides": updated})
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
