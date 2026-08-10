"""Home Status configuration.

The normal UI is organized around user tasks: see what Home Status watches,
add something, rename it, remove it, and tune history. Discovery is convenience,
never an eligibility gate.
"""

from __future__ import annotations

import logging
from uuid import uuid4

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.components.lovelace.const import LOVELACE_DATA
from homeassistant.data_entry_flow import section
from homeassistant.core import callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import selector

from .const import DOMAIN
from .discovery import discover_home_devices
from .source_discovery import discover_sources
from .presentation_config import DEFAULTS, DESTINATION_OPTIONS, PALETTE_OPTIONS
from .presentation import NAVIGATION_KEYS


_LOGGER = logging.getLogger(__name__)


def _home_device_choices(hass):
    choices = []
    for item in discover_home_devices(hass):
        label = item.name
        if item.area_name:
            label = f"{label} · {item.area_name}"
        choices.append({"value": item.id, "label": label})
    return choices


def _source_choices(hass):
    return [
        {"value": item.id, "label": f"{item.name} · {item.kind.title()}"}
        for item in discover_sources(hass)
    ]


def _person_choices(hass):
    return [
        {"value": state.entity_id, "label": str(state.attributes.get("friendly_name") or state.entity_id)}
        for state in sorted(hass.states.async_all("person"), key=lambda item: str(item.attributes.get("friendly_name") or item.entity_id).casefold())
        if str(state.state).casefold() not in {"unknown", "unavailable"}
    ]


def _selected(entry, key):
    value = entry.options.get(key, entry.data.get(key, []))
    return list(value) if isinstance(value, list) else []


def _entity_friendly_name(hass, entity_id: str) -> str:
    state = hass.states.get(entity_id)
    registry_entry = er.async_get(hass).async_get(entity_id)
    return str(
        (state.attributes.get("friendly_name") if state else None)
        or (registry_entry.name if registry_entry else None)
        or (registry_entry.original_name if registry_entry else None)
        or entity_id
    )


def _raw_entity_name(entity_id: str) -> str:
    return entity_id.split(".", 1)[-1]


class HomeStatusConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input=None):
        await self.async_set_unique_id("home_status")
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(
                title="Home Status",
                data={
                    "selected_entities": list(user_input.get("selected_entities", [])),
                    "selected_devices": list(user_input.get("selected_devices", [])),
                    "selected_sources": list(user_input.get("selected_sources", [])),
                },
            )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({
                vol.Optional("selected_entities", default=[]): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                ),
                vol.Optional("selected_devices", default=[]): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_home_device_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Optional("selected_sources", default=[]): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_source_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
            }),
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry):
        return HomeStatusOptionsFlow(config_entry)


class HomeStatusOptionsFlow(config_entries.OptionsFlow):
    def __init__(self, entry) -> None:
        self.entry = entry
        self._rename_target: str | None = None
        self._manage_target: str | None = None
        self._visual_source_id: str | None = None
        self._news_source_id: str | None = None

    def _options(self) -> dict:
        return dict(self.entry.options)

    async def _save_options_and_return(self, options: dict, parent: str):
        """Persist options without ending the native options flow."""
        self.hass.config_entries.async_update_entry(self.entry, options=options)
        if parent == "init":
            return await self.async_step_init()
        if parent == "monitoring":
            return await self.async_step_monitoring()
        if parent == "presentation":
            return await self.async_step_presentation()
        if parent == "sources":
            return await self.async_step_sources()
        if parent == "advanced":
            return await self.async_step_advanced()
        if parent == "names":
            return await self.async_step_names()
        return await self.async_step_init()

    def _monitored_choices(self):
        """Return every currently monitored item with a human-readable label."""
        choices = []
        for entity_id in _selected(self.entry, "selected_entities"):
            choices.append({
                "value": f"monitor_entity:{entity_id}",
                "label": f"{_entity_friendly_name(self.hass, entity_id)} · Entity",
            })

        selected_devices = set(_selected(self.entry, "selected_devices"))
        found_devices = {item.id: item for item in discover_home_devices(self.hass)}
        for device_id in selected_devices:
            item = found_devices.get(device_id)
            label = item.name if item else device_id.removeprefix("device:")
            if item and item.area_name:
                label = f"{label} · {item.area_name}"
            choices.append({"value": f"monitor_device:{device_id}", "label": f"{label} · Device"})

        selected_sources = set(_selected(self.entry, "selected_sources"))
        found_sources = {item.id: item for item in discover_sources(self.hass)}
        for source_id in selected_sources:
            item = found_sources.get(source_id)
            label = item.name if item else source_id.removeprefix("source:")
            kind = item.kind.title() if item else "Source"
            choices.append({"value": f"monitor_source:{source_id}", "label": f"{label} · {kind}"})
        return sorted(choices, key=lambda choice: choice["label"].casefold())

    def _target_label(self, target: str) -> str:
        for choice in self._monitored_choices():
            if choice["value"] == target:
                return choice["label"].rsplit(" · ", 1)[0]
        return target

    def _managed_target(self) -> tuple[str, str] | None:
        target = self._manage_target or ""
        for prefix, kind in (
            ("monitor_entity:", "entity"),
            ("monitor_device:", "device"),
            ("monitor_source:", "source"),
        ):
            if target.startswith(prefix):
                return kind, target.removeprefix(prefix)
        return None

    async def async_step_init(self, user_input=None):
        """Open the compact native Home Status reconfiguration navigator."""
        return self.async_show_menu(
            step_id="init",
            menu_options=["monitoring", "sources", "presentation", "advanced"],
        )

    async def async_step_back_to_init(self, user_input=None):
        """Return to the top-level Home Status reconfiguration menu."""
        return await self.async_step_init()

    async def async_step_back_to_monitoring(self, user_input=None):
        """Return to Monitoring."""
        return await self.async_step_monitoring()

    async def async_step_back_to_presentation(self, user_input=None):
        """Return to Presentation & behavior."""
        return await self.async_step_presentation()

    async def async_step_back_to_advanced(self, user_input=None):
        """Return to Advanced settings."""
        return await self.async_step_advanced()

    async def async_step_monitoring(self, user_input=None):
        """Open dedicated monitoring management pages."""
        return self.async_show_menu(
            step_id="monitoring",
            menu_options=["monitoring_entities", "monitoring_devices", "back_to_init"],
        )

    async def async_step_monitoring_entities(self, user_input=None):
        """Manage individually selected Home Assistant entities."""
        current = _selected(self.entry, "selected_entities")
        if user_input is not None:
            selected_entities = list(user_input.get("selected_entities", []))
            options = self._options()
            options["selected_entities"] = selected_entities

            # Drop stale entity label overrides when an entity is no longer monitored.
            entity_modes = dict(options.get("entity_name_modes", {}))
            entity_names = dict(options.get("entity_name_overrides", {}))
            for entity_id in list(entity_modes):
                if entity_id not in selected_entities:
                    entity_modes.pop(entity_id, None)
            for entity_id in list(entity_names):
                if entity_id not in selected_entities:
                    entity_names.pop(entity_id, None)
            options["entity_name_modes"] = entity_modes
            options["entity_name_overrides"] = entity_names
            return await self._save_options_and_return(options, "monitoring")

        return self.async_show_form(
            step_id="monitoring_entities",
            data_schema=vol.Schema({
                vol.Optional("selected_entities", default=current): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                )
            }),
        )

    async def async_step_monitoring_devices(self, user_input=None):
        """Manage selected whole-device groups."""
        current = _selected(self.entry, "selected_devices")
        if user_input is not None:
            selected_devices = list(user_input.get("selected_devices", []))
            options = self._options()
            options["selected_devices"] = selected_devices

            # Drop stale device label overrides when a device is no longer monitored.
            overrides = dict(options.get("name_overrides", {}))
            selected_sources = set(_selected(self.entry, "selected_sources"))
            monitored_non_entities = set(selected_devices) | selected_sources
            for target in list(overrides):
                if target not in monitored_non_entities:
                    overrides.pop(target, None)
            options["name_overrides"] = overrides
            return await self._save_options_and_return(options, "monitoring")

        return self.async_show_form(
            step_id="monitoring_devices",
            data_schema=vol.Schema({
                vol.Optional("selected_devices", default=current): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_home_device_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_manage(self, user_input=None):
        choices = self._monitored_choices()
        if not choices:
            return self.async_show_form(step_id="manage_empty", data_schema=vol.Schema({}))
        if user_input is not None:
            self._manage_target = str(user_input["item"])
            return await self.async_step_manage_item()
        return self.async_show_form(
            step_id="manage",
            data_schema=vol.Schema({
                vol.Required("item"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=choices,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_manage_empty(self, user_input=None):
        if user_input is not None:
            return await self.async_step_add()
        return self.async_show_form(step_id="manage_empty", data_schema=vol.Schema({}))

    async def async_step_manage_item(self, user_input=None):
        if not self._manage_target:
            return await self.async_step_manage()
        return self.async_show_menu(
            step_id="manage_item",
            description_placeholders={"item_name": self._target_label(self._manage_target)},
            menu_options=["manage_rename", "manage_remove"],
        )

    async def async_step_manage_rename(self, user_input=None):
        if not self._manage_target:
            return await self.async_step_manage()
        managed = self._managed_target()
        if not managed:
            return await self.async_step_manage()
        kind, target = managed
        self._rename_target = f"entity:{target}" if kind == "entity" else target
        return await self.async_step_name_edit(user_input)

    async def async_step_manage_remove(self, user_input=None):
        if not self._manage_target:
            return await self.async_step_manage()
        target = self._manage_target
        label = self._target_label(target)
        managed = self._managed_target()
        if not managed:
            return await self.async_step_manage()
        kind, raw_target = managed
        if user_input is not None:
            if not user_input.get("confirm"):
                return self.async_show_form(
                    step_id="manage_remove",
                    description_placeholders={"item_name": label},
                    data_schema=vol.Schema({vol.Required("confirm", default=False): bool}),
                    errors={"base": "confirm_remove"},
                )
            options = self._options()
            if kind == "entity":
                entity_id = raw_target
                options["selected_entities"] = [
                    value for value in _selected(self.entry, "selected_entities") if value != entity_id
                ]
                modes = dict(options.get("entity_name_modes", {}))
                names = dict(options.get("entity_name_overrides", {}))
                modes.pop(entity_id, None)
                names.pop(entity_id, None)
                options["entity_name_modes"] = modes
                options["entity_name_overrides"] = names
            elif kind == "device":
                options["selected_devices"] = [
                    value for value in _selected(self.entry, "selected_devices") if value != raw_target
                ]
                overrides = dict(options.get("name_overrides", {}))
                overrides.pop(raw_target, None)
                options["name_overrides"] = overrides
            elif kind == "source":
                options["selected_sources"] = [
                    value for value in _selected(self.entry, "selected_sources") if value != raw_target
                ]
                overrides = dict(options.get("name_overrides", {}))
                overrides.pop(raw_target, None)
                options["name_overrides"] = overrides
            return self.async_create_entry(title="", data=options)

        return self.async_show_form(
            step_id="manage_remove",
            description_placeholders={"item_name": label},
            data_schema=vol.Schema({vol.Required("confirm", default=False): bool}),
        )

    async def async_step_add(self, user_input=None):
        return self.async_show_menu(
            step_id="add",
            menu_options=["add_entities", "add_devices", "add_sources"],
        )

    async def async_step_add_entities(self, user_input=None):
        if user_input is not None:
            existing = _selected(self.entry, "selected_entities")
            additions = list(user_input.get("entities", []))
            options = self._options()
            options["selected_entities"] = list(dict.fromkeys([*existing, *additions]))
            return self.async_create_entry(title="", data=options)
        return self.async_show_form(
            step_id="add_entities",
            data_schema=vol.Schema({
                vol.Required("entities"): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                )
            }),
        )

    async def async_step_add_devices(self, user_input=None):
        if user_input is not None:
            existing = _selected(self.entry, "selected_devices")
            additions = list(user_input.get("devices", []))
            options = self._options()
            options["selected_devices"] = list(dict.fromkeys([*existing, *additions]))
            return self.async_create_entry(title="", data=options)
        return self.async_show_form(
            step_id="add_devices",
            data_schema=vol.Schema({
                vol.Required("devices"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_home_device_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_add_sources(self, user_input=None):
        if user_input is not None:
            existing = _selected(self.entry, "selected_sources")
            additions = list(user_input.get("sources", []))
            options = self._options()
            options["selected_sources"] = list(dict.fromkeys([*existing, *additions]))
            return self.async_create_entry(title="", data=options)
        return self.async_show_form(
            step_id="add_sources",
            data_schema=vol.Schema({
                vol.Required("sources"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_source_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_sources(self, user_input=None):
        """Open information and visual source settings."""
        return self.async_show_menu(
            step_id="sources",
            menu_options=["information_sources", "household_presence", "news_sources", "live_news_sources", "visual_sources", "back_to_init"],
        )

    async def async_step_information_sources(self, user_input=None):
        """Manage discovered non-device information sources."""
        current = _selected(self.entry, "selected_sources")
        if user_input is not None:
            options = self._options()
            options["selected_sources"] = list(user_input.get("selected_sources", []))
            return await self._save_options_and_return(options, "sources")
        return self.async_show_form(
            step_id="information_sources",
            data_schema=vol.Schema({
                vol.Optional("selected_sources", default=current): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_source_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_household_presence(self, user_input=None):
        """Configure one grouped presence item instead of per-person items."""
        options = self._options()
        choices = _person_choices(self.hass)
        current_people = options.get("household_presence_people", [])
        if not isinstance(current_people, list):
            current_people = []
        if user_input is not None:
            options["household_presence_enabled"] = bool(user_input.get("enabled", False))
            options["household_presence_people"] = list(user_input.get("people", []))
            return await self._save_options_and_return(options, "sources")
        return self.async_show_form(
            step_id="household_presence",
            data_schema=vol.Schema({
                vol.Optional("enabled", default=options.get("household_presence_enabled", False)): selector.BooleanSelector(),
                vol.Optional("people", default=current_people): selector.SelectSelector(
                    selector.SelectSelectorConfig(options=choices, multiple=True, mode=selector.SelectSelectorMode.DROPDOWN)
                ),
            }),
        )

    def _visual_source_choices(self):
        choices = [{"value": "__add__", "label": "Add camera visual source"}]
        for source in self.entry.options.get("visual_sources", []):
            if not isinstance(source, dict) or source.get("type") != "camera":
                continue
            source_id = source.get("id")
            camera = source.get("camera_entity_id")
            trigger = source.get("trigger_entity_id")
            if not all(isinstance(value, str) and value for value in (source_id, camera, trigger)):
                continue
            choices.append({
                "value": source_id,
                "label": f"{_entity_friendly_name(self.hass, camera)} when {_entity_friendly_name(self.hass, trigger)} is {source.get('trigger_state', 'on')}",
            })
        return choices

    def _visual_source(self, source_id: str | None) -> dict:
        if not source_id:
            return {}
        for source in self.entry.options.get("visual_sources", []):
            if isinstance(source, dict) and source.get("id") == source_id:
                return dict(source)
        return {}

    async def async_step_visual_sources(self, user_input=None):
        """Select a configured visual source to add or edit."""
        if user_input is not None:
            selected = str(user_input["visual_source"])
            self._visual_source_id = None if selected == "__add__" else selected
            return await self.async_step_visual_camera()
        return self.async_show_form(
            step_id="visual_sources",
            data_schema=vol.Schema({
                vol.Required("visual_source"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=self._visual_source_choices(),
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_news_sources(self, user_input=None):
        """Choose a generic RSS/Atom source to add or edit."""
        if user_input is not None:
            chosen = str(user_input["news_source"])
            self._news_source_id = None if chosen == "__add__" else chosen
            return await self.async_step_news_source_edit()
        choices = [{"value": "__add__", "label": "Add RSS/Atom feed"}]
        for feed in self.entry.options.get("news_sources", []):
            if isinstance(feed, dict) and feed.get("id"):
                choices.append({"value": str(feed["id"]), "label": str(feed.get("name") or feed.get("url") or "News")})
        return self.async_show_form(step_id="news_sources", data_schema=vol.Schema({vol.Required("news_source"): selector.SelectSelector(selector.SelectSelectorConfig(options=choices, mode=selector.SelectSelectorMode.DROPDOWN))}))

    async def async_step_news_source_edit(self, user_input=None):
        """Persist one generic RSS/Atom source."""
        current = next((dict(item) for item in self.entry.options.get("news_sources", []) if isinstance(item, dict) and item.get("id") == self._news_source_id), {})
        if user_input is not None:
            from .news import valid_url
            url = str(user_input.get("url", "")).strip()
            if not user_input.get("remove_source", False) and not valid_url(url):
                return self.async_show_form(step_id="news_source_edit", data_schema=self._news_schema(current), errors={"url":"invalid_feed_url"})
            options = self._options()
            feeds = [item for item in options.get("news_sources", []) if isinstance(item, dict) and item.get("id") != self._news_source_id]
            if not user_input.get("remove_source", False):
                feeds.append({"id": self._news_source_id or uuid4().hex, "name":str(user_input["name"]).strip() or "News", "url":url, "enabled":bool(user_input.get("enabled", True)), "priority":str(user_input.get("priority", "normal")), "show_visual":bool(user_input.get("show_visual", True)), "visual_duration":max(1, min(3600, int(user_input.get("visual_duration", 60))) )})
            options["news_sources"] = feeds
            return await self._save_options_and_return(options, "sources")
        return self.async_show_form(step_id="news_source_edit", data_schema=self._news_schema(current))

    def _news_schema(self, current):
        return vol.Schema({vol.Required("name", default=current.get("name", "")): selector.TextSelector(selector.TextSelectorConfig()), vol.Required("url", default=current.get("url", "")): selector.TextSelector(selector.TextSelectorConfig()), vol.Optional("enabled", default=current.get("enabled", True)): selector.BooleanSelector(), vol.Optional("priority", default=current.get("priority", "normal")): selector.SelectSelector(selector.SelectSelectorConfig(options=[{"value":p,"label":p.title()} for p in ("normal","activity","attention","critical")], mode=selector.SelectSelectorMode.DROPDOWN)), vol.Optional("show_visual", default=current.get("show_visual", True)): selector.BooleanSelector(), vol.Optional("visual_duration", default=current.get("visual_duration", 60)): self._number(1,3600,1), vol.Optional("remove_source", default=False): selector.BooleanSelector()})

    async def async_step_live_news_sources(self, user_input=None):
        """Choose a Direct HTTPS HLS source to add or edit."""
        if user_input is not None:
            chosen = str(user_input["live_news_source"])
            if chosen == "__settings__":
                return await self.async_step_live_news_settings()
            self._live_news_source_id = None if chosen == "__add__" else chosen
            return await self.async_step_live_news_source_edit()
        choices = [
            {"value": "__settings__", "label": "Live News sampling settings"},
            {"value": "__add__", "label": "Add live HLS source"},
        ]
        for source in self.entry.options.get("live_news_sources", []):
            if isinstance(source, dict) and source.get("id"):
                choices.append({"value": str(source["id"]), "label": str(source.get("name") or source.get("url") or "Live News")})
        return self.async_show_form(step_id="live_news_sources", data_schema=vol.Schema({vol.Required("live_news_source"): selector.SelectSelector(selector.SelectSelectorConfig(options=choices, mode=selector.SelectSelectorMode.DROPDOWN))}))

    async def async_step_live_news_source_edit(self, user_input=None):
        """Persist one generic Direct HTTPS HLS source."""
        from .providers.live_news import valid_hls_url
        current = next((dict(item) for item in self.entry.options.get("live_news_sources", []) if isinstance(item, dict) and item.get("id") == self._live_news_source_id), {})
        if user_input is not None:
            url = str(user_input.get("url", "")).strip()
            if not user_input.get("remove_source", False) and not valid_hls_url(url):
                return self.async_show_form(step_id="live_news_source_edit", data_schema=self._live_news_schema(current), errors={"url": "invalid_hls_url"})
            options = self._options()
            sources = [item for item in options.get("live_news_sources", []) if isinstance(item, dict) and item.get("id") != self._live_news_source_id]
            if not user_input.get("remove_source", False):
                sources.append({
                    "id": self._live_news_source_id or uuid4().hex,
                    "name": str(user_input["name"]).strip() or "Live News",
                    "url": url,
                    "transport": "hls",
                    "enabled": bool(user_input.get("enabled", True)),
                    "priority": str(user_input.get("priority", "normal")),
                })
            options["live_news_sources"] = sources
            return await self._save_options_and_return(options, "sources")
        return self.async_show_form(step_id="live_news_source_edit", data_schema=self._live_news_schema(current))

    def _live_news_schema(self, current):
        priorities = [{"value": priority, "label": priority.title()} for priority in ("normal", "activity", "attention", "critical")]
        return vol.Schema({
            vol.Required("name", default=current.get("name", "")): selector.TextSelector(selector.TextSelectorConfig()),
            vol.Required("url", default=current.get("url", "")): selector.TextSelector(selector.TextSelectorConfig()),
            vol.Optional("enabled", default=current.get("enabled", True)): selector.BooleanSelector(),
            vol.Optional("priority", default=current.get("priority", "normal")): selector.SelectSelector(selector.SelectSelectorConfig(options=priorities, mode=selector.SelectSelectorMode.DROPDOWN)),
            vol.Optional("remove_source", default=False): selector.BooleanSelector(),
        })

    async def async_step_live_news_settings(self, user_input=None):
        """Configure the shared Live News sampling cadence."""
        if user_input is not None:
            options = self._options()
            options["live_news_sample_interval"] = max(30, min(86400, int(user_input.get("sample_interval", 1800))))
            options["live_news_display_duration"] = max(1, min(3600, int(user_input.get("display_duration", 30))))
            options["live_news_mute"] = bool(user_input.get("mute", True))
            return await self._save_options_and_return(options, "sources")
        return self.async_show_form(
            step_id="live_news_settings",
            data_schema=vol.Schema({
                vol.Optional("sample_interval", default=self.entry.options.get("live_news_sample_interval", 1800)): self._number(30, 86400, 30),
                vol.Optional("display_duration", default=self.entry.options.get("live_news_display_duration", 30)): self._number(1, 3600, 1),
                vol.Optional("mute", default=self.entry.options.get("live_news_mute", True)): selector.BooleanSelector(),
            }),
        )

    async def async_step_visual_camera(self, user_input=None):
        """Configure a generic Home Assistant camera visual and its trigger."""
        current = self._visual_source(self._visual_source_id)
        if user_input is not None:
            options = self._options()
            configured = [
                source for source in options.get("visual_sources", [])
                if isinstance(source, dict) and source.get("id") != self._visual_source_id
            ]
            if not user_input.get("remove_source", False):
                configured.append({
                    "id": self._visual_source_id or uuid4().hex,
                    "type": "camera",
                    "camera_entity_id": str(user_input["camera_entity_id"]),
                    "trigger_entity_id": str(user_input["trigger_entity_id"]),
                    "trigger_state": str(user_input.get("trigger_state", "on")).strip() or "on",
                    "priority": str(user_input.get("priority", "attention")),
                    "hold_seconds": max(0, min(3600, int(user_input.get("hold_seconds", 30)))),
                    "enabled": bool(user_input.get("enabled", True)),
                    "resumable": bool(user_input.get("resumable", True)),
                })
            options["visual_sources"] = configured
            return await self._save_options_and_return(options, "sources")

        return self.async_show_form(
            step_id="visual_camera",
            data_schema=vol.Schema({
                vol.Required("camera_entity_id", default=current.get("camera_entity_id", "")): selector.EntitySelector(
                    selector.EntitySelectorConfig(domain="camera")
                ),
                vol.Required("trigger_entity_id", default=current.get("trigger_entity_id", "")): selector.EntitySelector(),
                vol.Optional("trigger_state", default=current.get("trigger_state", "on")): selector.TextSelector(
                    selector.TextSelectorConfig()
                ),
                vol.Optional("priority", default=current.get("priority", "attention")): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=[
                            {"value": "normal", "label": "Normal"},
                            {"value": "activity", "label": "Activity"},
                            {"value": "attention", "label": "Attention"},
                            {"value": "critical", "label": "Critical"},
                        ],
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Optional("hold_seconds", default=current.get("hold_seconds", 30)): self._number(0, 3600, 5),
                vol.Optional("enabled", default=current.get("enabled", True)): selector.BooleanSelector(),
                vol.Optional("resumable", default=current.get("resumable", True)): selector.BooleanSelector(),
                vol.Optional("remove_source", default=False): selector.BooleanSelector(),
            }),
        )

    async def async_step_advanced(self, user_input=None):
        return self.async_show_menu(
            step_id="advanced",
            menu_options=["devices", "entities_advanced", "back_to_init"],
        )

    async def async_step_devices(self, user_input=None):
        current = _selected(self.entry, "selected_devices")
        if user_input is not None:
            options = self._options()
            options["selected_devices"] = list(user_input.get("selected_devices", []))
            return await self._save_options_and_return(options, "advanced")
        return self.async_show_form(
            step_id="devices",
            data_schema=vol.Schema({
                vol.Optional("selected_devices", default=current): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=_home_device_choices(self.hass),
                        multiple=True,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_entities_advanced(self, user_input=None):
        current = _selected(self.entry, "selected_entities")
        if user_input is not None:
            options = self._options()
            options["selected_entities"] = list(user_input.get("selected_entities", []))
            return await self._save_options_and_return(options, "advanced")
        return self.async_show_form(
            step_id="entities_advanced",
            data_schema=vol.Schema({
                vol.Optional("selected_entities", default=current): selector.EntitySelector(
                    selector.EntitySelectorConfig(multiple=True)
                )
            }),
        )

    def _rename_choices(self):
        choices = [
            {
                "value": f"entity:{entity_id}",
                "label": f"{_entity_friendly_name(self.hass, entity_id)} · Entity",
            }
            for entity_id in _selected(self.entry, "selected_entities")
        ]
        selected_devices = set(_selected(self.entry, "selected_devices"))
        for item in discover_home_devices(self.hass):
            if item.id in selected_devices:
                choices.append({"value": item.id, "label": f"{item.name} · Device"})
        selected_sources = set(_selected(self.entry, "selected_sources"))
        for item in discover_sources(self.hass):
            if item.id in selected_sources:
                choices.append({"value": item.id, "label": f"{item.name} · {item.kind.title()}"})
        return sorted(choices, key=lambda choice: choice["label"].casefold())

    async def async_step_names(self, user_input=None):
        choices = self._rename_choices()
        if not choices:
            return self.async_abort(reason="no_selected_items")
        if user_input is not None:
            self._rename_target = str(user_input["item"])
            return await self.async_step_name_edit()
        return self.async_show_form(
            step_id="names",
            data_schema=vol.Schema({
                vol.Required("item"): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=choices,
                        mode=selector.SelectSelectorMode.DROPDOWN,
                    )
                )
            }),
        )

    async def async_step_name_edit(self, user_input=None):
        if not self._rename_target:
            return await self.async_step_names()

        target = self._rename_target
        options = self._options()
        if target.startswith("entity:"):
            entity_id = target.removeprefix("entity:")
            modes = dict(options.get("entity_name_modes", {}))
            custom_names = dict(options.get("entity_name_overrides", {}))
            current_mode = str(modes.get(entity_id, "friendly"))
            if current_mode not in {"friendly", "custom"}:
                current_mode = "friendly"
            current_custom = str(custom_names.get(entity_id, ""))
            if user_input is not None:
                mode = str(user_input.get("name_mode", "friendly"))
                custom = str(user_input.get("custom_name", "")).strip()
                modes[entity_id] = mode
                if custom:
                    custom_names[entity_id] = custom
                else:
                    custom_names.pop(entity_id, None)
                options["entity_name_modes"] = modes
                options["entity_name_overrides"] = custom_names
                return await self._save_options_and_return(options, "presentation")

            return self.async_show_form(
                step_id="name_edit",
                data_schema=vol.Schema({
                    vol.Required("name_mode", default=current_mode): selector.SelectSelector(
                        selector.SelectSelectorConfig(
                            options=[
                                {"value": "friendly", "label": "Home Assistant name"},
                                {"value": "custom", "label": "Custom name"},
                            ],
                            mode=selector.SelectSelectorMode.DROPDOWN,
                        )
                    ),
                    vol.Optional("custom_name", default=current_custom): selector.TextSelector(
                        selector.TextSelectorConfig()
                    ),
                }),
            )

        overrides = dict(options.get("name_overrides", {}))
        current = str(overrides.get(target, ""))
        if user_input is not None:
            value = str(user_input.get("custom_name", "")).strip()
            if value:
                overrides[target] = value
            else:
                overrides.pop(target, None)
            options["name_overrides"] = overrides
            return await self._save_options_and_return(options, "presentation")
        return self.async_show_form(
            step_id="name_edit",
            data_schema=vol.Schema({
                vol.Optional("custom_name", default=current): selector.TextSelector(
                    selector.TextSelectorConfig()
                )
            }),
        )

    async def async_step_presentation(self, user_input=None):
        """Open the user-facing presentation and behavior settings."""
        return self.async_show_menu(
            step_id="presentation",
            menu_options=["layout_sizing", "routing_filters", "navigation", "appearance", "visual_center", "names", "timing", "back_to_init"],
        )

    def _option_value(self, key):
        value = self.entry.options.get(key, DEFAULTS.get(key))
        if key.startswith("route_"):
            return list(value) if isinstance(value, list) else list(DEFAULTS.get(key, []))
        return value

    async def _dashboard_page_choices(self) -> list[dict[str, str]]:
        """Return the user's existing dashboard views as friendly destinations."""
        lovelace = self.hass.data.get(LOVELACE_DATA)
        dashboards = getattr(lovelace, "dashboards", {}) if lovelace else {}
        pages: dict[str, dict[str, str]] = {}
        for dashboard_key, dashboard in (dashboards.items() if isinstance(dashboards, dict) else ()):
            try:
                metadata = getattr(dashboard, "config", None) or {}
                dashboard_title = metadata.get("title") or (
                    "Overview" if dashboard_key is None else str(dashboard_key).replace("-", " ").title()
                )
                dashboard_path = getattr(dashboard, "url_path", None) or dashboard_key or "lovelace"
                config = await dashboard.async_load(False)
                for index, view in enumerate(config.get("views", []) if isinstance(config, dict) else []):
                    if not isinstance(view, dict):
                        continue
                    view_title = view.get("title") or f"View {index + 1}"
                    route = view.get("path") if view.get("path") not in (None, "") else str(index)
                    path = f"/{str(dashboard_path).strip('/')}/{str(route).strip('/')}"
                    pages[path] = {"value": path, "label": f"{dashboard_title} → {view_title}"}
            except Exception as err:  # A private dashboard must not block configuration.
                _LOGGER.debug("Unable to read Home Assistant dashboard %s: %s", dashboard_key, err)
        return sorted(pages.values(), key=lambda page: page["label"].casefold())

    async def async_step_navigation(self, user_input=None):
        """Configure optional page destinations for normal Home Status items."""
        current = self._options()
        pages = await self._dashboard_page_choices()
        choices = [
            *pages,
            {"value": "entity", "label": "Open device details"},
            {"value": "none", "label": "Do not open anything"},
            {"value": "custom", "label": "Use custom page path below"},
        ]
        valid = {choice["value"] for choice in choices}

        if user_input is not None:
            options = self._options()
            for value in user_input.values():
                if isinstance(value, dict):
                    options.update(value)
            errors: dict[str, str] = {}
            for key in NAVIGATION_KEYS:
                target_key = f"navigation_{key}"
                target = options.get(target_key, "none")
                if target not in valid:
                    options[target_key] = "none"
                    target = "none"
                if target == "custom":
                    custom = str(options.get(f"navigation_custom_{key}", "")).strip()
                    if not custom.startswith("/"):
                        errors[target_key] = "custom_page_must_start_with_slash"
                    else:
                        options[f"navigation_custom_{key}"] = custom
            if not errors:
                options["navigation_enabled"] = bool(options.get("navigation_enabled", True))
                return await self._save_options_and_return(options, "presentation")
        else:
            errors = {}

        def destination(key: str):
            saved = current.get(f"navigation_{key}", "none")
            control = selector.SelectSelector(
                selector.SelectSelectorConfig(options=choices, mode=selector.SelectSelectorMode.DROPDOWN)
            )
            return control, saved if saved in valid else "none"

        def fields(keys, *, custom: bool = False):
            schema = {}
            for key in keys:
                option_key = f"navigation_custom_{key}" if custom else f"navigation_{key}"
                if custom:
                    schema[vol.Optional(option_key, default=current.get(option_key, ""))] = selector.TextSelector()
                else:
                    control, default = destination(key)
                    schema[vol.Optional(option_key, default=default)] = control
            return vol.Schema(schema)

        return self.async_show_form(
            step_id="navigation",
            data_schema=vol.Schema({
                vol.Required("enable_navigation"): section(vol.Schema({
                    vol.Optional("navigation_enabled", default=current.get("navigation_enabled", True)): selector.BooleanSelector(),
                }), {"collapsed": False}),
                vol.Required("contacts"): section(fields(("doors_open", "doors_closed", "windows_open", "windows_closed")), {"collapsed": True}),
                vol.Required("activity"): section(fields(("appliances_running", "appliances_complete", "security")), {"collapsed": True}),
                vol.Required("information"): section(fields(("weather", "climate", "waste", "calendar", "news", "irrigation", "location", "other")), {"collapsed": True}),
                vol.Required("custom_paths"): section(fields(NAVIGATION_KEYS, custom=True), {"collapsed": True}),
            }),
            errors=errors,
        )

    @staticmethod
    def _number(minimum, maximum, step=1):
        return selector.NumberSelector(
            selector.NumberSelectorConfig(min=minimum, max=maximum, step=step, mode="box")
        )

    async def async_step_layout_sizing(self, user_input=None):
        """Configure card dimensions, text, icons, and value emphasis."""
        if user_input is not None:
            options = self._options()
            for value in user_input.values():
                if isinstance(value, dict):
                    options.update(value)
            return await self._save_options_and_return(options, "presentation")

        return self.async_show_form(
            step_id="layout_sizing",
            data_schema=vol.Schema({
                vol.Required("card_dimensions"): section(
                    vol.Schema({
                        vol.Optional("card_body_height", default=self._option_value("card_body_height")): self._number(220, 700),
                        vol.Optional("main_row_height", default=self._option_value("main_row_height")): self._number(70, 280),
                        vol.Optional("bottom_height", default=self._option_value("bottom_height")): self._number(54, 180),
                        vol.Optional("card_max_width", default=self._option_value("card_max_width")): self._number(0, 3000, 10),
                    }),
                    {"collapsed": False},
                ),
                vol.Required("left_area"): section(
                    vol.Schema({
                        vol.Optional("left_title_size", default=self._option_value("left_title_size")): self._number(14, 72),
                        vol.Optional("left_summary_size", default=self._option_value("left_summary_size")): self._number(10, 48),
                        vol.Optional("left_icon_size", default=self._option_value("left_icon_size")): self._number(16, 80),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("right_area"): section(
                    vol.Schema({
                        vol.Optional("right_title_size", default=self._option_value("right_title_size")): self._number(14, 72),
                        vol.Optional("right_summary_size", default=self._option_value("right_summary_size")): self._number(10, 48),
                        vol.Optional("right_icon_size", default=self._option_value("right_icon_size")): self._number(16, 80),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("bottom_area"): section(
                    vol.Schema({
                        vol.Optional("bottom_title_size", default=self._option_value("bottom_title_size")): self._number(12, 56),
                        vol.Optional("bottom_summary_size", default=self._option_value("bottom_summary_size")): self._number(10, 42),
                        vol.Optional("bottom_icon_size", default=self._option_value("bottom_icon_size")): self._number(16, 72),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("value_emphasis"): section(
                    vol.Schema({
                        vol.Optional("emphasize_measurements", default=self._option_value("emphasize_measurements")): selector.BooleanSelector(),
                        vol.Optional("left_measurement_size", default=self._option_value("left_measurement_size")): self._number(18, 100),
                        vol.Optional("right_measurement_size", default=self._option_value("right_measurement_size")): self._number(18, 100),
                        vol.Optional("right_weather_size", default=self._option_value("right_weather_size")): self._number(18, 90),
                        vol.Optional("bottom_measurement_size", default=self._option_value("bottom_measurement_size")): self._number(14, 72),
                    }),
                    {"collapsed": True},
                ),
            }),
        )

    async def async_step_routing_filters(self, user_input=None):
        """Configure which Home Status area receives each information type."""
        if user_input is not None:
            options = self._options()
            for value in user_input.values():
                if isinstance(value, dict):
                    options.update(value)
            return await self._save_options_and_return(options, "presentation")

        def destinations(key):
            return selector.SelectSelector(
                selector.SelectSelectorConfig(
                    options=DESTINATION_OPTIONS,
                    multiple=True,
                    mode=selector.SelectSelectorMode.DROPDOWN,
                )
            )

        return self.async_show_form(
            step_id="routing_filters",
            data_schema=vol.Schema({
                vol.Required("contacts"): section(
                    vol.Schema({
                        vol.Optional("route_doors_open", default=self._option_value("route_doors_open")): destinations("route_doors_open"),
                        vol.Optional("route_doors_closed", default=self._option_value("route_doors_closed")): destinations("route_doors_closed"),
                        vol.Optional("route_windows_open", default=self._option_value("route_windows_open")): destinations("route_windows_open"),
                        vol.Optional("route_windows_closed", default=self._option_value("route_windows_closed")): destinations("route_windows_closed"),
                    }),
                    {"collapsed": False},
                ),
                vol.Required("appliances_and_security"): section(
                    vol.Schema({
                        vol.Optional("route_appliances_running", default=self._option_value("route_appliances_running")): destinations("route_appliances_running"),
                        vol.Optional("route_appliances_complete", default=self._option_value("route_appliances_complete")): destinations("route_appliances_complete"),
                        vol.Optional("route_security", default=self._option_value("route_security")): destinations("route_security"),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("information"): section(
                    vol.Schema({
                        vol.Optional("route_weather", default=self._option_value("route_weather")): destinations("route_weather"),
                        vol.Optional("route_climate", default=self._option_value("route_climate")): destinations("route_climate"),
                        vol.Optional("route_waste", default=self._option_value("route_waste")): destinations("route_waste"),
                        vol.Optional("route_calendar", default=self._option_value("route_calendar")): destinations("route_calendar"),
                        vol.Optional("route_news", default=self._option_value("route_news")): destinations("route_news"),
                        vol.Optional("route_irrigation", default=self._option_value("route_irrigation")): destinations("route_irrigation"),
                        vol.Optional("route_location", default=self._option_value("route_location")): destinations("route_location"),
                        vol.Optional("route_other", default=self._option_value("route_other")): destinations("route_other"),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("empty_area_behavior"): section(
                    vol.Schema({
                        vol.Optional("fill_empty_left", default=self._option_value("fill_empty_left")): selector.BooleanSelector(),
                    }),
                    {"collapsed": True},
                ),
            }),
        )

    async def async_step_appearance(self, user_input=None):
        """Configure semantic icon colors without exposing CSS or raw data."""
        if user_input is not None:
            options = self._options()
            for value in user_input.values():
                if isinstance(value, dict):
                    options.update(value)
            return await self._save_options_and_return(options, "presentation")

        def color(key):
            return selector.SelectSelector(
                selector.SelectSelectorConfig(options=PALETTE_OPTIONS, mode=selector.SelectSelectorMode.DROPDOWN)
            )

        return self.async_show_form(
            step_id="appearance",
            data_schema=vol.Schema({
                vol.Required("color_behavior"): section(
                    vol.Schema({
                        vol.Optional("semantic_colors", default=self._option_value("semantic_colors")): selector.BooleanSelector(),
                    }),
                    {"collapsed": False},
                ),
                vol.Required("category_colors"): section(
                    vol.Schema({
                        vol.Optional("color_security", default=self._option_value("color_security")): color("color_security"),
                        vol.Optional("color_appliance", default=self._option_value("color_appliance")): color("color_appliance"),
                        vol.Optional("color_weather", default=self._option_value("color_weather")): color("color_weather"),
                        vol.Optional("color_climate", default=self._option_value("color_climate")): color("color_climate"),
                        vol.Optional("color_waste", default=self._option_value("color_waste")): color("color_waste"),
                        vol.Optional("color_recycling", default=self._option_value("color_recycling")): color("color_recycling"),
                        vol.Optional("color_calendar", default=self._option_value("color_calendar")): color("color_calendar"),
                        vol.Optional("color_irrigation", default=self._option_value("color_irrigation")): color("color_irrigation"),
                        vol.Optional("color_news", default=self._option_value("color_news")): color("color_news"),
                    }),
                    {"collapsed": True},
                ),
                vol.Required("event_colors"): section(
                    vol.Schema({
                        vol.Optional("color_attention", default=self._option_value("color_attention")): color("color_attention"),
                        vol.Optional("color_success", default=self._option_value("color_success")): color("color_success"),
                    }),
                    {"collapsed": True},
                ),
            }),
        )

    async def async_step_visual_center(self, user_input=None):
        """Configure when the provider-neutral Visual Center may be shown."""
        if user_input is not None:
            options = self._options()
            options["visual_center_enabled"] = bool(user_input.get("visual_center_enabled", True))
            return await self._save_options_and_return(options, "presentation")
        return self.async_show_form(
            step_id="visual_center",
            data_schema=vol.Schema({
                vol.Optional(
                    "visual_center_enabled",
                    default=self._option_value("visual_center_enabled"),
                ): selector.BooleanSelector(),
            }),
        )

    async def async_step_timing(self, user_input=None):
        """Configure relative timestamps plus recent/history retention."""
        if user_input is not None:
            options = self._options()
            for value in user_input.values():
                if isinstance(value, dict):
                    options.update(value)
            return await self._save_options_and_return(options, "presentation")
        return self.async_show_form(
            step_id="timing",
            data_schema=vol.Schema({
                vol.Required("timestamps"): section(
                    vol.Schema({
                        vol.Optional("timestamp_contacts", default=self._option_value("timestamp_contacts")): selector.BooleanSelector(),
                        vol.Optional("timestamp_appliance_complete", default=self._option_value("timestamp_appliance_complete")): selector.BooleanSelector(),
                        vol.Optional("timestamp_other", default=self._option_value("timestamp_other")): selector.BooleanSelector(),
                    }),
                    {"collapsed": False},
                ),
                vol.Required("retention"): section(
                    vol.Schema({
                        vol.Optional("ticker_event_minutes", default=self._option_value("ticker_event_minutes")): self._number(1, 120),
                        vol.Optional("history_retention_days", default=self._option_value("history_retention_days")): self._number(1, 30),
                    }),
                    {"collapsed": False},
                ),
            }),
        )
