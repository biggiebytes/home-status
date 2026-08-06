from __future__ import annotations

import voluptuous as vol
import logging
from homeassistant import config_entries
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.const import CONF_ENTITY_ID
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import selector

from .const import (
    ALARM_ENTITY,
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
from .source_adapters import (
    CONF_NEWS_FEEDS,
    DEFAULT_NEWS_ICON,
    is_valid_feed_url,
    news_feed_key,
    normalize_news_feeds,
)

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
    "calendar": "Calendars & Schedules",
    "schedule": "Calendars & Schedules",
    "laundry": "Laundry",
    "waste": "Trash & Recycling",
    "security": "Security & Safety",
    "sprinklers": "Sprinklers",
    "maintenance": "Maintenance",
    "climate": "Climate & Comfort",
    "cameras": "Camera Activity",
    "family": "Family Presence",
    "lighting": "Lighting",
    "news": "News",
}
CAPABILITY_ORDER = tuple(
    capability for capability in CAPABILITY_LABELS
    if capability != "schedule"
)


class HomeStatusConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._setup_options: dict = {}
        self._detected_capabilities: set[str] = set()
        self._weather_entities: list[str] = []
        self._onboarding_categories: set[str] = set()

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
                (domain == "alarm_control_panel" and entity_id == ALARM_ENTITY)
                or domain == "lock"
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
                # Appliance entities are candidates only. Monitoring begins
                # after the user explicitly selects and configures them in
                # the shared capability flow.

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
            # A capable setup should never quietly leave a new installation
            # with zero monitored entities.  Build safe recommendations from
            # Home Assistant metadata, then let the owner review them first.
            self._onboarding_categories = (
                {"entry", "safety"}
                if profile == "essentials"
                else {"entry", "safety", "connectivity", "appliances"}
            )
            return await self.async_step_onboarding_preview()

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
            }),
        )

    def _onboarding_candidates(self):
        """Return conservative, metadata-derived initial recommendations."""
        candidates = {}
        for item in CapabilityProviderRegistry().discover(self.hass):
            candidates.setdefault(item.entity_id, item)

        selected = []
        for entity_id, item in candidates.items():
            domain = entity_id.split(".", 1)[0]
            device_class = item.device_class
            capability = item.capability
            discovery_text = f"{entity_id} {item.name}".replace("_", " ").lower()
            category = None
            if capability == "availability" and device_class in {
                "door", "window", "opening", "garage_door",
            }:
                category = "entry"
            elif capability in {
                "smoke", "carbon_monoxide", "device_problem",
            }:
                category = "safety"
            elif capability == "availability" and device_class == "moisture":
                category = "safety"
            elif capability == "connectivity":
                category = "connectivity"
            elif capability in {"appliance_cycle", "maintenance_alert"}:
                category = "appliances"
            if entity_id.startswith("binary_sensor.any_"):
                # Roll-up helpers repeat the individual doors and windows;
                # keep them available for manual add but never preselect them.
                continue
            if capability == "connectivity" and self._matches(
                discovery_text, "cloud connection", "android auto", "remote ui"
            ):
                # Per-device cloud links create a very noisy default.  A
                # panel, hub, proxy, or similar infrastructure connection is
                # still offered when it is genuinely useful to monitor.
                continue
            if capability == "appliance_cycle" and not self._matches(
                discovery_text,
                "washer", "dryer", "machine state", "current status",
                "cycle state", "time remaining", "remaining time",
            ):
                # Many integrations expose unrelated enum sensors as a
                # generic cycle.  Only preselect recognisable appliance work.
                continue
            # Cameras, motion, normal temperature readings, and generic
            # state sensors remain opt-in: they are much more likely to be
            # duplicates or personal preferences than entry and safety data.
            if category not in self._onboarding_categories:
                continue
            if capability not in {"availability", "connectivity", "smoke", "carbon_monoxide", "device_problem", "appliance_cycle", "maintenance_alert"}:
                continue
            if capability not in {"availability", "state_trigger"} and not domain in {"sensor", "binary_sensor"}:
                continue
            selected.append({
                "value": entity_id,
                "label": f"{item.name} — {capability.replace('_', ' ').title()}",
                "item": item,
            })
        return sorted(selected, key=lambda choice: choice["label"].casefold())

    async def async_step_onboarding_preview(self, user_input=None):
        """Review the monitored entities before creating the entry."""
        choices = self._onboarding_candidates()
        by_id = {choice["value"]: choice["item"] for choice in choices}
        if user_input is not None:
            configured = {}
            selected = user_input.get(
                "starter_entities",
                getattr(self, "_onboarding_preview_defaults", []),
            )
            if isinstance(selected, str):
                selected = [selected]
            for entity_id in selected:
                item = by_id.get(entity_id)
                if item:
                    configured[entity_id] = HomeStatusOptionsFlow._starter_config(item)
            self._setup_options[CONF_CAPABILITY_SENSORS] = configured
            return await self._continue_automatic_setup()
        self._onboarding_preview_defaults = [choice["value"] for choice in choices]
        return self.async_show_form(
            step_id="onboarding_preview",
            data_schema=vol.Schema({
                vol.Optional(
                    "starter_entities",
                    default=self._onboarding_preview_defaults,
                ): selector.SelectSelector(selector.SelectSelectorConfig(
                    options=[
                        {"value": choice["value"], "label": choice["label"]}
                        for choice in choices
                    ],
                    multiple=True,
                    mode=selector.SelectSelectorMode.LIST,
                ))
            }),
            description_placeholders={
                "count": str(len(choices)),
            },
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
        "setup_summary",
        "smart_setup",
        "general",
        "information_sources",
        "news_sources",
        "experimental_sensors",
        "weather",
        "ticker_filters",
        "ticker_timing",
        "appearance",
        "navigation",
        "customize",
        "advanced",
    ]

    def __init__(self) -> None:
        self._pending_options: dict | None = None
        self._pending_summary = ""
        self._pending_warnings = ""
        self._selected_news_source: str | None = None

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
                (domain == "alarm_control_panel" and state.entity_id == ALARM_ENTITY)
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

    async def async_step_setup_summary(self, user_input=None):
        """Show the effective configuration without changing it."""
        if user_input is not None:
            return self._settings_menu()
        current = self._current()
        alarm_state = self.hass.states.get(ALARM_ENTITY)
        alarm = (
            f"Ready ({alarm_state.state.replace('_', ' ')})"
            if alarm_state and alarm_state.state not in {"unknown", "unavailable"}
            else "Not found or unavailable"
        )
        providers = current.get("enabled_providers", self.PROVIDERS)
        provider_summary = ", ".join(
            str(provider).replace("_", " ").title() for provider in providers
        ) or "None"
        configured_sensors = current.get(CONF_CAPABILITY_SENSORS, {})
        sensor_summary = (
            f"{len(configured_sensors)} configured"
            if isinstance(configured_sensors, dict) else "None configured"
        )
        forecast = current.get("forecast_entity") or "Automatic / not selected"
        return self.async_show_form(
            step_id="setup_summary",
            data_schema=vol.Schema({}),
            description_placeholders={
                "alarm": alarm,
                "providers": provider_summary,
                "sensors": sensor_summary,
                "forecast": forecast,
            },
        )

    async def async_step_smart_setup(self, user_input=None):
        """Offer a reviewed whole-home setup from the main settings menu."""
        if user_input is not None:
            self._starter_profile = user_input.get("starter_profile", "recommended")
            self._starter_categories = list(
                user_input.get("recommended_categories") or []
            )
            return await self.async_step_starter_preview()
        return self.async_show_form(
            step_id="smart_setup",
            data_schema=vol.Schema({
                vol.Required("starter_profile", default="recommended"):
                    selector.SelectSelector(selector.SelectSelectorConfig(
                        options=[
                            {"value": "quick", "label": "Essentials"},
                            {"value": "recommended", "label": "Whole home"},
                        ],
                        mode=selector.SelectSelectorMode.LIST,
                    )),
                vol.Optional(
                    "recommended_categories",
                    default=["entry", "safety", "connectivity", "appliances"],
                ): selector.SelectSelector(selector.SelectSelectorConfig(
                    options=[
                        {"value": "entry", "label": "Doors & windows"},
                        {"value": "safety", "label": "Safety & faults"},
                        {"value": "connectivity", "label": "Connectivity"},
                        {"value": "appliances", "label": "Appliances & maintenance"},
                    ],
                    multiple=True,
                    mode=selector.SelectSelectorMode.LIST,
                )),
            }),
        )

    def _detected_stable_providers(self, options: dict | None = None) -> set[str]:
        """Return provider capabilities found without selecting any entity."""
        detected: set[str] = set()
        effective = self._current() if options is None else options
        if any(
            feed["enabled"]
            for feed in normalize_news_feeds(effective.get(CONF_NEWS_FEEDS))
        ):
            detected.add("news")
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
            if (domain == "alarm_control_panel" and entity_id == ALARM_ENTITY) or domain == "lock" or (
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
            f"• {key.replace('_', ' ').title()}"
            for key in changed
        ) or "• No setting changes"
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
        detected = self._detected_stable_providers(effective)
        missing = [
            CAPABILITY_LABELS.get(provider, provider.title())
            for provider in enabled
            if provider not in detected
        ]
        if missing:
            warnings.append(
                "No compatible entities are currently detected for: " + ", ".join(missing) + ". These providers will remain enabled but may not publish items until configured."
            )
        self._pending_warnings = "\n".join(f"• {warning}" for warning in warnings) or "• No problems found"
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
                selector.NumberSelectorConfig(min=1, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("history_max_events", default=current.get("history_max_events", 0)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_recent_items", default=current.get("max_recent_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_upcoming_items", default=current.get("max_upcoming_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("max_insight_items", default=current.get("max_insight_items", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
        }))

    async def async_step_information_sources(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        detected = self._detected_stable_providers()
        provider_choices = [
            {
                "value": provider,
                "label": f"{CAPABILITY_LABELS.get(provider, provider.title())}{' — Ready' if provider in detected else ''}",
            }
            for provider in self.PROVIDERS
        ]
        return self.async_show_form(step_id="information_sources", data_schema=vol.Schema({
            vol.Optional("enabled_providers", default=current.get("enabled_providers", self.PROVIDERS)): selector.SelectSelector(
                selector.SelectSelectorConfig(options=provider_choices, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
        }), description_placeholders={
            "detected": ", ".join(
                CAPABILITY_LABELS.get(provider, provider.title())
                for provider in self.PROVIDERS
                if provider in detected
            ) or "None yet",
        })

    async def async_step_news_sources(self, user_input=None):
        """Choose a favorite news feed to add or edit."""
        feeds = normalize_news_feeds(self._current().get(CONF_NEWS_FEEDS))
        if user_input is not None:
            selected = user_input.get("news_source")
            self._selected_news_source = (
                None if selected == "__add__" else str(selected or "")
            )
            return await self.async_step_news_source()
        choices = [
            {
                "value": feed["key"],
                "label": f"{feed['name']}{'' if feed['enabled'] else ' — Off'}",
            }
            for feed in feeds
        ]
        choices.append({"value": "__add__", "label": "Add a news source"})
        enabled_count = sum(1 for feed in feeds if feed["enabled"])
        return self.async_show_form(
            step_id="news_sources",
            data_schema=vol.Schema({
                vol.Required("news_source", default="__add__"):
                    selector.SelectSelector(selector.SelectSelectorConfig(
                        options=choices,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )),
            }),
            description_placeholders={
                "summary": (
                    f"{enabled_count} active of {len(feeds)} configured"
                    if feeds else "No sources configured"
                ),
            },
        )

    async def async_step_news_source(self, user_input=None):
        """Add, edit, disable, or remove one RSS/Atom news source."""
        feeds = normalize_news_feeds(self._current().get(CONF_NEWS_FEEDS))
        selected_key = self._selected_news_source
        existing = next(
            (feed for feed in feeds if feed["key"] == selected_key), None
        )
        errors = {}
        values = existing or {
            "enabled": True,
            "name": "",
            "url": "",
            "icon": DEFAULT_NEWS_ICON,
            "refresh_minutes": 15,
            "max_items": 1,
        }
        if user_input is not None:
            values = user_input
            if user_input.get("remove_source") and existing:
                updated = [
                    feed for feed in feeds if feed["key"] != selected_key
                ]
                return await self._save_step({CONF_NEWS_FEEDS: updated})
            url = str(user_input.get("url") or "").strip()
            if not is_valid_feed_url(url):
                errors["url"] = "invalid_news_feed_url"
            elif any(
                feed["url"].casefold() == url.casefold()
                and feed["key"] != selected_key
                for feed in feeds
            ):
                errors["url"] = "duplicate_news_feed_url"
            else:
                candidate = {
                    "key": existing["key"] if existing else news_feed_key(url),
                    "name": str(user_input.get("name") or "").strip(),
                    "url": url,
                    "icon": str(
                        user_input.get("icon") or DEFAULT_NEWS_ICON
                    ).strip(),
                    "enabled": bool(user_input.get("enabled", True)),
                    "refresh_minutes": user_input.get("refresh_minutes", 15),
                    "max_items": user_input.get("max_items", 1),
                }
                updated = [
                    feed for feed in feeds if feed["key"] != selected_key
                ]
                updated.append(candidate)
                return await self._save_step({
                    CONF_NEWS_FEEDS: normalize_news_feeds(updated),
                })
        schema = vol.Schema({
            vol.Optional("enabled", default=values.get("enabled", True)):
                selector.BooleanSelector(),
            vol.Optional("name", default=values.get("name", "")):
                selector.TextSelector(),
            vol.Required("url", default=values.get("url", "")):
                selector.TextSelector(),
            vol.Optional("icon", default=values.get("icon", DEFAULT_NEWS_ICON)):
                selector.TextSelector(),
            vol.Optional(
                "refresh_minutes", default=values.get("refresh_minutes", 15)
            ): selector.NumberSelector(selector.NumberSelectorConfig(
                min=5, max=120, step=5,
                mode=selector.NumberSelectorMode.BOX,
            )),
            vol.Optional("max_items", default=values.get("max_items", 1)):
                selector.NumberSelector(selector.NumberSelectorConfig(
                    min=1, max=5, step=1,
                    mode=selector.NumberSelectorMode.BOX,
                )),
            vol.Optional("remove_source", default=False):
                selector.BooleanSelector(),
        })
        return self.async_show_form(
            step_id="news_source",
            data_schema=schema,
            errors=errors,
            description_placeholders={
                "mode": "Edit this source" if existing else "Add a source",
            },
        )

    def _capability_candidates(self):
        registry = CapabilityProviderRegistry()
        candidates = {}
        for item in registry.discover(self.hass):
            if item.entity_id not in candidates:
                candidates[item.entity_id] = item
            elif (
                candidates[item.entity_id].capability == "state_trigger"
                and item.capability != "state_trigger"
            ):
                candidates[item.entity_id] = item
        current = registry.configs(self._current())
        choices = []
        for entity_id in sorted(set(candidates) | set(current)):
            item = candidates.get(entity_id)
            capability = (
                current[entity_id]["capability"]
                if entity_id in current
                else item.capability
            )
            name = item.name if item else plain_entity_name(entity_id)
            area = f" · {item.area_name}" if item and item.area_name else ""
            choices.append({
                "value": entity_id,
                "label": (
                    f"{name} — {capability.replace('_', ' ').title()}{area}"
                ),
            })
        return choices, candidates, current

    def _is_camera_motion(self, item) -> bool:
        """Identify motion sensors attached to a device that has a camera."""
        if item.device_class != "motion":
            return False
        registry = er.async_get(self.hass)
        entry = registry.async_get(item.entity_id)
        if not entry or not entry.device_id:
            return False
        return any(
            candidate.device_id == entry.device_id
            and candidate.entity_id.startswith("camera.")
            for candidate in registry.entities.values()
        )

    def _recommended_category(self, item):
        """Return the single, metadata-derived setup category for an item."""
        device_class = item.device_class
        domain = item.entity_id.split(".", 1)[0]
        if item.capability == "availability" and device_class in {
            "door", "window", "opening", "garage_door",
        }:
            return "entry"
        if item.capability == "availability" and device_class == "motion":
            return "camera_motion" if self._is_camera_motion(item) else "motion"
        if item.capability in {"smoke", "carbon_monoxide", "device_problem"}:
            return "safety"
        if item.capability == "availability" and domain == "camera":
            return "camera_health"
        if item.capability == "connectivity":
            return "connectivity"
        if item.capability in {"temperature", "humidity"}:
            return "environment"
        if item.capability in {"appliance_cycle", "maintenance_alert"}:
            return "appliances"
        return None

    def _starter_candidates(self, profile="recommended", categories=None):
        """Return metadata-based recommendations for explicit first setup."""
        choices, candidates, current = self._capability_candidates()
        recommended = []
        for choice in choices:
            entity_id = choice["value"]
            item = candidates.get(entity_id)
            if entity_id in current or not item:
                continue
            category = self._recommended_category(item)
            discovery_text = f"{entity_id} {item.name}".replace("_", " ").lower()
            if entity_id.startswith("binary_sensor.any_"):
                continue
            if item.capability == "connectivity" and HomeStatusConfigFlow._matches(
                discovery_text, "cloud connection", "android auto", "remote ui"
            ):
                continue
            if item.capability == "appliance_cycle" and not HomeStatusConfigFlow._matches(
                discovery_text,
                "washer", "dryer", "machine state", "current status",
                "cycle state", "time remaining", "remaining time",
            ):
                continue
            quick_security = category in {"entry", "safety"}
            selected_categories = set(
                {"entry", "safety", "connectivity", "appliances"}
                if categories is None else categories
            )
            include = quick_security if profile == "quick" else (
                category in selected_categories
            )
            if include:
                recommended.append(choice)
        return recommended, candidates, current

    @staticmethod
    def _starter_config(item):
        """Build visible starter defaults; nothing is enabled until saved."""
        capability = item.capability
        config = {
            "capability": capability,
            "priority": (
                "critical" if capability in {"smoke", "carbon_monoxide"}
                else "activity" if capability == "appliance_cycle"
                else "attention"
            ),
            "alert_behavior": (
                "critical" if capability in {"smoke", "carbon_monoxide"}
                else "sustained" if capability in {
                    "connectivity", "device_problem", "temperature",
                    "humidity",
                }
                else "one_time"
            ),
            "display_route": "main_then_footer",
            "trigger_delay_seconds": 30 if capability == "connectivity" else 0,
            "retention_minutes": 120 if item.device_class in {
                "door", "window", "opening", "garage_door",
            } else 10,
        }
        if capability == "availability":
            config["alert_when_active"] = item.device_class in {
                "door", "window", "opening", "garage_door", "motion",
            }
        if capability == "appliance_cycle":
            config.update({
                "appliance_type": "appliance",
                "complete_states": [
                    "complete", "completed", "finished", "done", "end",
                ],
                "idle_states": ["off", "idle", "ready", "power_off"],
            })
        return config

    async def async_step_experimental_sensors(self, user_input=None):
        choices, _, current = self._capability_candidates()
        configured_choices = [
            choice for choice in choices if choice["value"] in current
        ]
        if user_input is not None:
            remove_entity = self._entity_selection(
                user_input.get("remove_entity")
            )
            if remove_entity in current:
                self._selected_remove_entity = remove_entity
                return await self.async_step_remove_entity()
            selected = self._entity_selection(
                user_input.get("capability_entity")
            )
            if selected:
                self._selected_capability_entity = selected
                self._selected_capability_mode = user_input.get(
                    "capability_mode", "recommended"
                )
                return await self.async_step_experimental_sensor()
            profile = user_input.get("starter_profile", "recommended")
            if profile in {"quick", "recommended"}:
                self._starter_profile = profile
                self._starter_categories = list(
                    user_input.get("recommended_categories") or []
                )
                return await self.async_step_starter_preview()
            return self._settings_menu()
        schema = {}
        if configured_choices:
            schema[vol.Optional("remove_entity")] = selector.EntitySelector(
                selector.EntitySelectorConfig(
                    include_entities=list(current),
                )
            )
        schema[vol.Optional("starter_profile", default="recommended")] = (
                selector.SelectSelector(selector.SelectSelectorConfig(
                    options=[
                        {"value": "quick", "label": "Quick Start"},
                        {"value": "recommended", "label": "Recommended Setup"},
                        {"value": "custom", "label": "Custom Setup"},
                    ],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                ))
        )
        schema[vol.Optional(
            "recommended_categories",
            default=["entry", "safety", "connectivity", "appliances"],
        )] = selector.SelectSelector(selector.SelectSelectorConfig(
            options=[
                {"value": "entry", "label": "Doors & windows"},
                {"value": "motion", "label": "Motion"},
                {"value": "camera_motion", "label": "Camera motion"},
                {"value": "safety", "label": "Safety"},
                {"value": "camera_health", "label": "Camera health"},
                {"value": "connectivity", "label": "Connectivity"},
                {"value": "environment", "label": "Temperature & humidity"},
                {"value": "appliances", "label": "Appliances & maintenance"},
            ],
            multiple=True,
            mode=selector.SelectSelectorMode.DROPDOWN,
        ))
        schema[vol.Optional("capability_mode", default="recommended")] = (
                selector.SelectSelector(selector.SelectSelectorConfig(
                    options=[
                        {
                            "value": "recommended",
                            "label": "Recommended configuration",
                        },
                        {
                            "value": "state_trigger",
                            "label": "Simple exact-state trigger",
                        },
                    ],
                    mode=selector.SelectSelectorMode.DROPDOWN,
                ))
        )
        # The native entity picker is searchable and scales to large homes.
        # Selected entities are still validated against Home Status discovery
        # before their configuration screen is shown.
        schema[vol.Optional("capability_entity")] = selector.EntitySelector()
        return self.async_show_form(
            step_id="experimental_sensors",
            data_schema=vol.Schema(schema),
        )

    async def async_step_remove_entity(self, user_input=None):
        entity_id = getattr(self, "_selected_remove_entity", None)
        current = CapabilityProviderRegistry().configs(self._current())
        if not entity_id or entity_id not in current:
            return await self.async_step_experimental_sensors()
        if user_input is not None:
            self._selected_remove_entity = None
            if not user_input.get("confirm_remove"):
                return await self.async_step_experimental_sensors()
            configured = dict(current)
            configured.pop(entity_id, None)
            return await self._save_step({
                CONF_CAPABILITY_SENSORS: configured,
            })
        return self.async_show_form(
            step_id="remove_entity",
            data_schema=vol.Schema({
                vol.Required("confirm_remove", default=False): (
                    selector.BooleanSelector()
                )
            }),
            description_placeholders={"entity": plain_entity_name(entity_id)},
        )

    async def async_step_starter_preview(self, user_input=None):
        profile = getattr(self, "_starter_profile", "recommended")
        choices, candidates, current = self._starter_candidates(
            profile, getattr(self, "_starter_categories", None)
        )
        if user_input is not None:
            submitted = user_input.get(
                "starter_entities",
                getattr(self, "_starter_preview_defaults", []),
            )
            if isinstance(submitted, str):
                submitted = [submitted]
            selected = [
                self._entity_selection(entity_id)
                for entity_id in submitted
            ]
            selected = [
                entity_id for entity_id in selected
                if entity_id in candidates and entity_id not in current
            ]
            if selected:
                configured = dict(current)
                for entity_id in selected:
                    configured[entity_id] = self._starter_config(
                        candidates[entity_id]
                    )
                self._starter_profile = None
                self._starter_categories = None
                return await self._save_step({
                    CONF_CAPABILITY_SENSORS: configured,
                })
            self._starter_profile = None
            self._starter_categories = None
            return await self.async_step_experimental_sensors()
        self._starter_preview_defaults = [choice["value"] for choice in choices]
        return self.async_show_form(
            step_id="starter_preview",
            data_schema=vol.Schema({
                vol.Optional(
                    "starter_entities",
                    default=self._starter_preview_defaults,
                ): selector.SelectSelector(selector.SelectSelectorConfig(
                    options=choices,
                    multiple=True,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                ))
            }),
            description_placeholders={
                "profile": "Quick Start" if profile == "quick"
                else "Recommended Setup",
            },
        )

    async def async_step_experimental_sensor(self, user_input=None):
        entity_id = getattr(self, "_selected_capability_entity", None)
        choices, candidates, current = self._capability_candidates()
        if not entity_id or entity_id not in {choice["value"] for choice in choices}:
            return await self.async_step_experimental_sensors()
        existing = current.get(entity_id, {})
        candidate = candidates.get(entity_id)
        capability = (
            existing.get("capability")
            if existing
            else "state_trigger" if getattr(
                self, "_selected_capability_mode", "recommended"
            ) == "state_trigger" else candidate.capability
        )
        errors = {}
        active_state_supported = bool(
            candidate
            and capability == "availability"
            and candidate.device_class in {
                "door", "window", "opening", "garage_door", "motion",
            }
        )
        retention_default = 120 if (
            candidate
            and candidate.device_class in {
                "door", "window", "opening", "garage_door",
            }
        ) else 10
        behavior_default = (
            "critical" if capability in {"smoke", "carbon_monoxide"}
            else "sustained" if capability in {
                "connectivity", "device_problem", "temperature", "humidity",
                "maintenance_alert",
            }
            else "one_time"
        )
        trigger_delay_default = 30 if capability == "connectivity" else 0
        priority_default = (
            "activity" if capability == "appliance_cycle" else "attention"
        )
        if user_input is not None:
            if user_input.get("remove_sensor"):
                configured = dict(current)
                configured.pop(entity_id, None)
                self._selected_capability_entity = None
                self._selected_capability_mode = None
                return await self._save_step({
                    CONF_CAPABILITY_SENSORS: configured,
                })
            low = user_input.get("low_threshold")
            high = user_input.get("high_threshold")
            numeric = capability in {"temperature", "humidity"}
            appliance = capability == "appliance_cycle"
            maintenance_alert = capability == "maintenance_alert"
            state_trigger = capability == "state_trigger"
            if numeric and low is not None and high is not None and float(low) >= float(high):
                errors["base"] = "low_threshold_must_be_less_than_high"
            else:
                configured = dict(current)
                sensor_config = {
                    "capability": capability,
                    "priority": user_input.get(
                        "priority", priority_default
                    ),
                    "publish_current": user_input.get(
                        "publish_current", False
                    ),
                }
                if numeric and low is not None:
                    sensor_config["low_threshold"] = low
                if numeric and high is not None:
                    sensor_config["high_threshold"] = high
                if not numeric:
                    sensor_config.pop("publish_current", None)
                if active_state_supported:
                    sensor_config["alert_when_active"] = user_input.get(
                        "alert_when_active", False
                    )
                if appliance:
                    sensor_config["appliance_type"] = user_input.get(
                        "appliance_type", "appliance"
                    )
                    sensor_config["complete_states"] = list(
                        user_input.get("complete_states") or []
                    )
                    sensor_config["idle_states"] = list(
                        user_input.get("idle_states") or []
                    )
                    remaining_entity = self._entity_selection(
                        user_input.get("remaining_entity")
                    )
                    if remaining_entity:
                        sensor_config["remaining_entity"] = remaining_entity
                if maintenance_alert or state_trigger:
                    for key in ("active_message", "resolved_message", "icon"):
                        value = str(user_input.get(key) or "").strip()
                        if value:
                            sensor_config[key] = value[:80]
                if state_trigger:
                    sensor_config["trigger_state"] = str(
                        user_input.get("trigger_state") or "on"
                    ).strip().casefold()
                sensor_config["retention_minutes"] = int(
                    user_input.get("retention_minutes", retention_default)
                )
                sensor_config["alert_behavior"] = user_input.get(
                    "alert_behavior", behavior_default
                )
                sensor_config["display_route"] = user_input.get(
                    "display_route", "main_then_footer"
                )
                sensor_config["trigger_delay_seconds"] = int(
                    user_input.get(
                        "trigger_delay_seconds", trigger_delay_default
                    )
                )
                display_name = str(user_input.get("display_name") or "").strip()
                if display_name:
                    sensor_config["display_name"] = display_name[:60]
                configured[entity_id] = sensor_config
                self._selected_capability_entity = None
                self._selected_capability_mode = None
                return await self._save_step({
                    CONF_CAPABILITY_SENSORS: configured
                })
        schema = {}
        numeric = capability in {"temperature", "humidity"}
        appliance = capability == "appliance_cycle"
        maintenance_alert = capability == "maintenance_alert"
        state_trigger = capability == "state_trigger"
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
        if numeric:
            schema[low_field] = number_selector
            schema[high_field] = number_selector
        schema[vol.Optional(
            "priority", default=existing.get("priority", priority_default)
        )] = selector.SelectSelector(selector.SelectSelectorConfig(
            options=["normal", "activity", "attention", "critical"],
            mode=selector.SelectSelectorMode.DROPDOWN,
        ))
        schema[vol.Optional(
            "display_name", default=existing.get("display_name", "")
        )] = selector.TextSelector()
        if appliance:
            state = self.hass.states.get(entity_id)
            state_choices = list(dict.fromkeys([
                *[str(value).casefold() for value in (
                    state.attributes.get("options", []) if state else []
                )],
                str(getattr(state, "state", "")).casefold(),
                "run", "running", "washing", "drying",
                "complete", "completed", "finished", "done", "end",
                "off", "idle", "ready", "power_off",
            ]))
            state_choices = [value for value in state_choices if value]
            schema[vol.Optional(
                "appliance_type",
                default=existing.get("appliance_type", "appliance"),
            )] = selector.SelectSelector(selector.SelectSelectorConfig(
                options=[
                    {"value": "washer", "label": "Washer"},
                    {"value": "dryer", "label": "Dryer"},
                    {"value": "dishwasher", "label": "Dishwasher"},
                    {"value": "appliance", "label": "Other appliance"},
                ],
                mode=selector.SelectSelectorMode.DROPDOWN,
            ))
            schema[vol.Optional(
                "complete_states",
                default=existing.get("complete_states", [
                    "complete", "completed", "finished", "done", "end",
                ]),
            )] = selector.SelectSelector(selector.SelectSelectorConfig(
                options=state_choices,
                multiple=True,
                mode=selector.SelectSelectorMode.DROPDOWN,
            ))
            schema[vol.Optional(
                "idle_states",
                default=existing.get("idle_states", [
                    "off", "idle", "ready", "power_off",
                ]),
            )] = selector.SelectSelector(selector.SelectSelectorConfig(
                options=state_choices,
                multiple=True,
                mode=selector.SelectSelectorMode.DROPDOWN,
            ))
            remaining_field = vol.Optional("remaining_entity")
            if existing.get("remaining_entity"):
                remaining_field = vol.Optional(
                    "remaining_entity",
                    default=existing["remaining_entity"],
                )
            schema[remaining_field] = selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            )
        if state_trigger:
            state = self.hass.states.get(entity_id)
            current_state = str(getattr(state, "state", "")).strip()
            trigger_default = (
                "on" if current_state.casefold() in {"on", "off"}
                else current_state
            )
            schema[vol.Required(
                "trigger_state",
                default=existing.get("trigger_state", trigger_default or "on"),
            )] = selector.TextSelector()
        if maintenance_alert or state_trigger:
            schema[vol.Optional(
                "active_message",
                default=existing.get("active_message", ""),
            )] = selector.TextSelector()
            schema[vol.Optional(
                "resolved_message",
                default=existing.get("resolved_message", ""),
            )] = selector.TextSelector()
            schema[vol.Optional(
                "icon",
                default=existing.get(
                    "icon", "mdi:wrench-clock" if maintenance_alert else ""
                ),
            )] = selector.TextSelector()
        schema[vol.Optional(
            "alert_behavior",
            default=existing.get("alert_behavior", behavior_default),
        )] = selector.SelectSelector(selector.SelectSelectorConfig(
            options=[
                {"value": "one_time", "label": "One-time activity"},
                {"value": "sustained", "label": "Sustained attention"},
                {"value": "critical", "label": "Critical safety"},
                {"value": "reminder", "label": "Recurring reminder"},
            ],
            mode=selector.SelectSelectorMode.DROPDOWN,
        ))
        schema[vol.Optional(
            "display_route",
            default=existing.get("display_route", "main_then_footer"),
        )] = selector.SelectSelector(selector.SelectSelectorConfig(
            options=[
                {
                    "value": "main_then_footer",
                    "label": "Main briefly, then bottom ticker",
                },
                {"value": "main_only", "label": "Main only"},
                {"value": "footer_only", "label": "Bottom ticker only"},
            ],
            mode=selector.SelectSelectorMode.DROPDOWN,
        ))
        schema[vol.Optional(
            "trigger_delay_seconds",
            default=existing.get(
                "trigger_delay_seconds", trigger_delay_default
            ),
        )] = selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=0, max=3600, step=1,
                mode=selector.NumberSelectorMode.BOX,
            )
        )
        if numeric:
            schema[vol.Optional(
                "publish_current",
                default=existing.get("publish_current", False),
            )] = selector.BooleanSelector()
        if active_state_supported:
            schema[vol.Optional(
                "alert_when_active",
                default=existing.get("alert_when_active", False),
            )] = selector.BooleanSelector()
        schema[vol.Optional(
            "retention_minutes",
            default=existing.get(
                "retention_minutes", retention_default
            ),
        )] = selector.NumberSelector(
            selector.NumberSelectorConfig(
                min=1, step=1,
                mode=selector.NumberSelectorMode.BOX,
            )
        )
        schema[vol.Optional("remove_sensor", default=False)] = (
            selector.BooleanSelector()
        )
        return self.async_show_form(
            step_id="experimental_sensor",
            data_schema=vol.Schema(schema),
            errors=errors,
            description_placeholders={
                "entity": (
                    existing.get("display_name")
                    or (candidate.name if candidate else plain_entity_name(entity_id))
                ),
                "capability": str(capability).title(),
                "unit": candidate.unit if candidate and candidate.unit else "the entity's native unit",
            },
        )

    async def async_step_appearance(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="appearance", data_schema=vol.Schema({
            vol.Optional("hero_rotation_seconds", default=current.get("hero_rotation_seconds", 4)): selector.NumberSelector(selector.NumberSelectorConfig(min=1, step=1, mode=selector.NumberSelectorMode.BOX)),
            vol.Optional("media_enabled", default=current.get("media_enabled", True)): selector.BooleanSelector(),
            vol.Optional("enable_insights", default=current.get("enable_insights", True)): selector.BooleanSelector(),
        }))

    async def async_step_ticker_filters(self, user_input=None):
        """Let owners choose which otherwise-noisy items reach the ticker."""
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="ticker_filters", data_schema=vol.Schema({
            vol.Optional("deduplicate_by_entity", default=current.get("deduplicate_by_entity", True)): selector.BooleanSelector(),
            vol.Optional("collapse_repeated_events", default=current.get("collapse_repeated_events", True)): selector.BooleanSelector(),
            vol.Optional("footer_include_activity_history", default=current.get("footer_include_activity_history", True)): selector.BooleanSelector(),
            vol.Optional("footer_activity_history_hours", default=current.get("footer_activity_history_hours", 1)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, max=720, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("footer_include_persistent_conditions", default=current.get("footer_include_persistent_conditions", True)): selector.BooleanSelector(),
            vol.Optional("footer_hide_normal_security", default=current.get("footer_hide_normal_security", False)): selector.BooleanSelector(),
            vol.Optional("footer_hide_closed_contacts", default=current.get("footer_hide_closed_contacts", False)): selector.BooleanSelector(),
            vol.Optional("footer_hide_disarmed_alarm", default=current.get("footer_hide_disarmed_alarm", False)): selector.BooleanSelector(),
            vol.Optional("footer_hide_routine_climate", default=current.get("footer_hide_routine_climate", False)): selector.BooleanSelector(),
            vol.Optional("footer_hide_routine_weather", default=current.get("footer_hide_routine_weather", False)): selector.BooleanSelector(),
            vol.Optional("footer_group_contact_closures", default=current.get("footer_group_contact_closures", False)): selector.BooleanSelector(),
        }))

    async def async_step_ticker_timing(self, user_input=None):
        """Choose ticker sources and reminder cadence without changing providers."""
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="ticker_timing", data_schema=vol.Schema({
            vol.Optional("ticker_providers", default=current.get("ticker_providers", self.PROVIDERS)): selector.SelectSelector(
                selector.SelectSelectorConfig(options=self.PROVIDERS, multiple=True, mode=selector.SelectSelectorMode.LIST)
            ),
            vol.Optional("ticker_reminder_minutes", default=current.get("ticker_reminder_minutes", 45)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("ticker_event_minutes", default=current.get("ticker_event_minutes", 10)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
        }))

    async def async_step_weather(self, user_input=None):
        if user_input is not None:
            return await self._save_step(user_input)
        current = self._current()
        return self.async_show_form(step_id="weather", data_schema=vol.Schema({
            vol.Optional("include_nws_alerts", default=current.get("include_nws_alerts", True)): selector.BooleanSelector(),
            vol.Optional("include_sprinkler_schedule", default=current.get("include_sprinkler_schedule", True)): selector.BooleanSelector(),
            vol.Optional("include_waste_collection", default=current.get("include_waste_collection", True)): selector.BooleanSelector(),
            vol.Optional("calendar_entities", default=current.get("calendar_entities", [
                state.entity_id for state in self.hass.states.async_all("calendar")
            ])): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="calendar", multiple=True)
            ),
            vol.Optional("calendar_lookahead_days", default=current.get("calendar_lookahead_days", 14)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=1, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("waste_collection_window_days", default=current.get("waste_collection_window_days", 7)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
            vol.Optional("forecast_days", default=current.get("forecast_days", 1)): selector.NumberSelector(
                selector.NumberSelectorConfig(min=0, step=1, mode=selector.NumberSelectorMode.BOX)
            ),
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
