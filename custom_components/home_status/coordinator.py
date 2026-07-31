from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import logging
import re

from homeassistant.components.weather import WeatherEntityFeature
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, State, callback
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    ALARM_ENTITY,
    APPLIANCE_CYCLES,
    APPLIANCE_MAINTENANCE,
    CONF_CONTACT_FOOTER_PILOT,
    CONF_ENTITIES,
    CONF_ENTITY_IDS,
    DOMAIN,
    EASYSTART_DIAGNOSTIC_DETAILS,
    EASYSTART_FAULT_COUNTER,
    EXPLICIT_BINARY_NOTIFICATION_SOURCES,
    LEAK_SOURCE_NAMES,
    LIVE_ONLY_NOTIFICATION_SOURCES,
    NAVIGATION_TARGETS,
    PROVIDER_CAMERAS,
    PROVIDER_CLIMATE,
    PROVIDER_FAMILY,
    PROVIDER_NEWS,
    PROVIDER_LAUNDRY,
    PROVIDER_MAINTENANCE,
    PROVIDER_SCHEDULE,
    PROVIDER_SECURITY,
    PROVIDER_WEATHER,
    STORAGE_KEY,
    STORAGE_VERSION,
    SUPPORTED_PROVIDERS,
    SYSTEM_UPDATES,
    normalize_provider,
    normalize_provider_options,
    normalize_providers,
    plain_entity_name,
)
from .source_registry import SourceRegistry
from .source_adapters import RSSSourceAdapter, RSSSourceDefinition
from .conversation_ledger import (
    LEDGER_STORAGE_KEY,
    LEDGER_STORAGE_VERSION,
    ConversationLedger,
)
from .conversation_policy import (
    POLICY_STORAGE_KEY,
    POLICY_STORAGE_VERSION,
    ShadowConversationPolicy,
)
from .presentation_adapter import ContactFooterPresentationAdapter
from .timeline import (
    ContactEventProjector,
    ContactTimelineAdapter,
    TIMELINE_STORAGE_KEY,
    TIMELINE_STORAGE_VERSION,
    TimelineEvent,
    TimelineEngine,
)

_LOGGER = logging.getLogger(__name__)
ALARM_STATES = {"disarmed", "armed_home", "armed_away", "armed_night", "arming", "pending", "triggered"}


class HomeStatusCoordinator(DataUpdateCoordinator[dict]):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN)
        self.entry = entry
        self.options = normalize_provider_options({**entry.data, **entry.options})
        self.options["enabled_providers"] = normalize_providers(self.options.get("enabled_providers"))
        self.entity_ids = list(self.options.get(CONF_ENTITIES, self.options.get(CONF_ENTITY_IDS, [])))
        self.registry = SourceRegistry.from_config(self.options.get("source_entities", self.entity_ids))
        self.store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.timeline_store = Store(
            hass, TIMELINE_STORAGE_VERSION, TIMELINE_STORAGE_KEY
        )
        self.policy_store = Store(
            hass, POLICY_STORAGE_VERSION, POLICY_STORAGE_KEY
        )
        self.ledger_store = Store(
            hass, LEDGER_STORAGE_VERSION, LEDGER_STORAGE_KEY
        )
        self._timeline = TimelineEngine()
        self._conversation_policy = ShadowConversationPolicy()
        self._conversation_ledger = ConversationLedger()
        self._timeline_shadow_comparisons: dict[str, dict] = {}
        self.history: list[dict] = []
        self.active: dict[str, dict] = {}
        self.ticker: dict[str, dict] = {}
        self._unsub = None
        self._direct_history_unsub = None
        self._direct_history_entities: tuple[str, ...] = ()
        self._ticker_timer = None
        self._forecast = []
        self._forecast_warning = None
        self._condition_since: dict[str, datetime] = {}
        self._source_adapters = (
            RSSSourceAdapter(RSSSourceDefinition(
                key="nasa",
                name="NASA",
                url="https://www.nasa.gov/feed/",
                provider=PROVIDER_NEWS,
                icon="mdi:rocket-launch-outline",
            )),
        )
        self._source_items: list[dict] = []

    async def async_setup(self) -> None:
        updated_options = normalize_provider_options(dict(self.entry.options))
        if updated_options != dict(self.entry.options):
            self.hass.config_entries.async_update_entry(self.entry, options=updated_options)
        merged_sources = list(self.registry.all())
        if self.options.get("source_entities") != merged_sources:
            updated_options = dict(self.entry.options)
            updated_options["source_entities"] = merged_sources
            self.hass.config_entries.async_update_entry(self.entry, options=updated_options)
            self.options["source_entities"] = merged_sources
        stored = await self.store.async_load() or {}
        self.history = self._retained_history(stored.get("events", []))
        timeline_stored = await self.timeline_store.async_load() or {}
        self._timeline = TimelineEngine.from_dict(timeline_stored)
        timeline_changed = self._timeline.prune(datetime.now(timezone.utc))
        self._configure_direct_history_subscription()
        if self._seed_shadow_timeline() or timeline_changed:
            await self.timeline_store.async_save(self._timeline.as_dict())
        policy_stored = await self.policy_store.async_load() or {}
        self._conversation_policy = ShadowConversationPolicy.from_dict(
            policy_stored
        )
        if self._reconcile_shadow_policy():
            await self.policy_store.async_save(
                self._conversation_policy.as_dict()
            )
        ledger_stored = await self.ledger_store.async_load() or {}
        self._conversation_ledger = ConversationLedger.from_dict(
            ledger_stored
        )
        if self._reconcile_shadow_ledger():
            await self.ledger_store.async_save(
                self._conversation_ledger.as_dict()
            )
        invalidated = {
            item.get("entity_id") for item in self.history
            if item.get("entity_id") and not self._history_entity_enabled(item.get("entity_id"))
        }
        if invalidated:
            self._purge_entity_records(invalidated)
        await self._async_refresh_forecast()
        await self._async_refresh_source_adapters(force=True)
        self._publish()
        self._unsub = async_track_state_change_event(
            self.hass, self._observed_entity_ids(), self._state_changed
        )
        self._configure_timer()

    def async_unload(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None
        if self._direct_history_unsub:
            self._direct_history_unsub()
            self._direct_history_unsub = None
        if self._ticker_timer:
            self._ticker_timer()
            self._ticker_timer = None
        for adapter in self._source_adapters:
            adapter.destroy()
        self._source_items = []

    def _configure_timer(self) -> None:
        if self._ticker_timer:
            self._ticker_timer()
        seconds = max(15, int(self.options.get("refresh_interval", 60)))
        self._ticker_timer = async_track_time_interval(self.hass, self._ticker_tick, timedelta(seconds=seconds))

    @callback
    def async_update_entities(self, entity_ids: list[str]) -> None:
        self.options = normalize_provider_options({**self.entry.data, **self.entry.options})
        self.options["enabled_providers"] = normalize_providers(self.options.get("enabled_providers"))
        self.registry = SourceRegistry.from_config(self.options.get("source_entities", entity_ids))
        self._configure_timer()
        new_ids = list(dict.fromkeys(entity_ids))
        removed = set(self.entity_ids) - set(new_ids)
        disabled = {
            entity_id for entity_id in new_ids
            if self.options.get("entity_overrides", {}).get(entity_id, {}).get("publish_mode") == "disabled"
        }
        invalidated = removed | disabled
        if invalidated:
            self._purge_entity_records(invalidated)
            self.history = self.history[:200]
            self.hass.async_create_task(self.store.async_save({"events": self.history}))
        self.entity_ids = new_ids
        if self._unsub:
            self._unsub()
        self._unsub = async_track_state_change_event(self.hass, self._observed_entity_ids(), self._state_changed)
        self._configure_direct_history_subscription()
        timeline_changed = self._seed_shadow_timeline()
        if timeline_changed:
            self._save_shadow_timeline()
        if self._reconcile_shadow_policy():
            self._save_shadow_policy()
        if self._reconcile_shadow_ledger():
            self._save_shadow_ledger()
        if PROVIDER_NEWS in self.options["enabled_providers"]:
            self.hass.async_create_task(
                self._async_refresh_sources_and_publish(force=True)
            )
        else:
            self._source_items = []
        self._publish()

    def _entity_publish_enabled(self, entity_id: str | None) -> bool:
        if not entity_id or entity_id not in self._resolved_source_ids():
            return False
        return self.options.get("entity_overrides", {}).get(entity_id, {}).get("publish_mode") != "disabled"

    def _observed_entity_ids(self) -> list[str]:
        # Home Assistant accepts subscriptions for entity IDs that do not yet
        # exist, allowing late-loaded integrations to update this coordinator
        # immediately when their entities first appear.
        return self._resolved_source_ids()

    def _discover_direct_history_entities(self) -> tuple[str, ...]:
        discovered = []
        supported_binary_classes = {
            "door", "window", "opening", "garage_door", "lock",
            "moisture", "smoke", "gas", "carbon_monoxide",
        }
        supported_cover_classes = {"door", "garage", "gate", "window"}
        for state in self.hass.states.async_all():
            domain = state.entity_id.split(".", 1)[0]
            device_class = str(state.attributes.get("device_class") or "").lower()
            if domain == "alarm_control_panel":
                discovered.append(state.entity_id)
            elif domain == "binary_sensor" and device_class in supported_binary_classes:
                discovered.append(state.entity_id)
            elif domain == "lock":
                discovered.append(state.entity_id)
            elif domain == "cover" and device_class in supported_cover_classes:
                discovered.append(state.entity_id)
        return tuple(dict.fromkeys(discovered))

    def _configured_direct_history_entities(self) -> tuple[str, ...]:
        configured = self.options.get("history_entities")
        if isinstance(configured, list):
            entity_ids = [
                str(entity_id) for entity_id in configured if entity_id
            ]
        else:
            entity_ids = list(self._discover_direct_history_entities())
        entity_ids.extend(self._presence_entity_ids())
        backend_history_sources = {
            *self._sources("leak_sensors"),
            *self._sources("refrigerator_doors"),
        }
        return tuple(dict.fromkeys(
            entity_id for entity_id in entity_ids
            if entity_id not in backend_history_sources
        ))

    def _configure_direct_history_subscription(self) -> None:
        entity_ids = self._configured_direct_history_entities()
        if entity_ids == self._direct_history_entities:
            return
        if self._direct_history_unsub:
            self._direct_history_unsub()
            self._direct_history_unsub = None
        self._direct_history_entities = entity_ids
        if entity_ids:
            self._direct_history_unsub = async_track_state_change_event(
                self.hass, list(entity_ids), self._direct_history_state_changed
            )

    def _observe_shadow_contact(
        self, state: State | None
    ) -> tuple[TimelineEvent | None, bool]:
        """Record one contact observation without changing published data."""
        if state is None or state.entity_id not in self._direct_history_entities:
            return None, False
        observation = ContactTimelineAdapter.observe(
            state.entity_id,
            state.state,
            state.attributes,
            state.last_changed,
        )
        if observation is None:
            return None, False
        return self._timeline.apply_contact(observation)

    def _seed_shadow_timeline(self) -> bool:
        """Reconcile persisted contact lifecycles with current HA states."""
        changed = False
        for entity_id in self._direct_history_entities:
            _, observation_changed = self._observe_shadow_contact(
                self.hass.states.get(entity_id)
            )
            changed = (
                observation_changed
                or changed
            )
        return self._timeline.prune(datetime.now(timezone.utc)) or changed

    def _compare_shadow_contact(
        self, timeline_event: TimelineEvent | None, legacy_item: dict | None
    ) -> None:
        """Retain a bounded private comparison without publishing it."""
        if timeline_event is None:
            return
        projection = ContactEventProjector.project(
            timeline_event, datetime.now(timezone.utc)
        )
        if projection is None:
            return
        self._timeline_shadow_comparisons[timeline_event.event_id] = {
            "projection": projection.as_dict(),
            "legacy": dict(legacy_item) if legacy_item is not None else None,
        }
        while len(self._timeline_shadow_comparisons) > 50:
            oldest = next(iter(self._timeline_shadow_comparisons))
            self._timeline_shadow_comparisons.pop(oldest, None)

    def _save_shadow_timeline(self) -> None:
        """Persist shadow events without joining the visible update path."""
        self.hass.async_create_task(
            self.timeline_store.async_save(self._timeline.as_dict())
        )

    def _reconcile_shadow_policy(self, now: datetime | None = None) -> bool:
        """Evaluate private decisions from timeline truth only."""
        return self._conversation_policy.reconcile(
            self._timeline.events, now or datetime.now(timezone.utc)
        )

    def _save_shadow_policy(self) -> None:
        """Persist private decisions without joining the visible update path."""
        self.hass.async_create_task(
            self.policy_store.async_save(
                self._conversation_policy.as_dict()
            )
        )

    def _reconcile_shadow_ledger(self, now: datetime | None = None) -> bool:
        """Record private communication history from policy decisions only."""
        return self._conversation_ledger.reconcile(
            self._conversation_policy.decisions,
            now or datetime.now(timezone.utc),
        )

    def _save_shadow_ledger(self) -> None:
        """Persist private conversation history outside visible output."""
        self.hass.async_create_task(
            self.ledger_store.async_save(
                self._conversation_ledger.as_dict()
            )
        )

    def _history_entity_enabled(self, entity_id: str | None) -> bool:
        if not entity_id:
            return False
        if entity_id in self._direct_history_entities:
            return True
        return self._entity_publish_enabled(entity_id)

    @callback
    def _direct_history_state_changed(self, event: Event) -> None:
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        timeline_event, timeline_changed = self._observe_shadow_contact(new_state)
        if timeline_changed:
            self._timeline.prune(datetime.now(timezone.utc))
            self._save_shadow_timeline()
            if self._reconcile_shadow_policy():
                self._save_shadow_policy()
            if self._reconcile_shadow_ledger():
                self._save_shadow_ledger()
        item = self._build_direct_history_event(old_state, new_state)
        self._compare_shadow_contact(timeline_event, item)
        if item is None:
            return
        self.history = self._retained_history([item, *self.history])
        self.hass.async_create_task(self.store.async_save({"events": self.history}))
        self._publish()

    def _build_direct_history_event(self, old_state: State | None, new_state: State | None) -> dict | None:
        if old_state is None or new_state is None:
            return None
        old_value = str(old_state.state).lower()
        value = str(new_state.state).lower()
        if old_value == value or value in {"unknown", "unavailable"}:
            return None
        entity_id = new_state.entity_id
        if entity_id not in self._direct_history_entities:
            return None
        domain = entity_id.split(".", 1)[0]
        device_class = str(new_state.attributes.get("device_class") or "").lower()
        name = self._plain_entity_name(
            entity_id, new_state.attributes.get("friendly_name")
        )
        title = summary = icon = ""
        priority = "activity"

        if domain == "alarm_control_panel" and value in ALARM_STATES:
            labels = {
                "disarmed": ("Alarm Disarmed", "Security system is off", "mdi:shield-off", "activity"),
                "armed_home": ("Alarm Armed Home", "Home mode is active", "mdi:shield-home", "attention"),
                "armed_away": ("Alarm Armed Away", "Away mode is active", "mdi:shield-lock", "attention"),
                "armed_night": ("Alarm Armed Night", "Night mode is active", "mdi:shield-moon", "attention"),
                "arming": ("Alarm Arming", "Exit delay is active", "mdi:shield-sync", "attention"),
                "pending": ("Alarm Entry Delay", "Disarm before the delay expires", "mdi:shield-alert", "critical"),
                "triggered": ("Security Alarm Triggered", "Immediate attention required", "mdi:shield-alert", "critical"),
            }
            title, summary, icon, priority = labels[value]
        elif domain == "binary_sensor":
            if device_class in {"door", "window", "opening", "garage_door", "lock"}:
                opened = value in {"on", "open", "opening", "unlocked"}
                title = f"{name} {'Opened' if opened else 'Closed'}"
                summary = f"{name} is {'open' if opened else 'closed'}"
                icon = "mdi:door-open" if opened else "mdi:door-closed"
                priority = "attention" if opened else "activity"
            elif device_class in {"moisture", "smoke", "gas", "carbon_monoxide"}:
                detected = value in {"on", "wet", "moisture", "detected"}
                title = f"{name} {'Detected' if detected else 'Cleared'}"
                summary = "Immediate attention required" if detected else f"{name} is clear"
                icon = "mdi:water-alert" if device_class == "moisture" else "mdi:smoke-detector-alert"
                priority = "critical" if detected else "activity"
        elif domain == "lock" and value in {"locked", "unlocked", "locking", "unlocking"}:
            unlocked = value in {"unlocked", "unlocking"}
            title = f"{name} {'Unlocked' if unlocked else 'Locked'}"
            summary = f"{name} is {value.replace('_', ' ')}"
            icon = "mdi:lock-open-alert" if unlocked else "mdi:lock"
            priority = "attention" if unlocked else "activity"
        elif domain == "cover" and value in {"open", "closed", "opening", "closing"}:
            opened = value in {"open", "opening"}
            title = f"{name} {'Opened' if opened else 'Closed'}"
            summary = f"{name} is {value}"
            icon = "mdi:garage-open" if opened else "mdi:garage"
            priority = "attention" if opened else "activity"
        elif domain == "person":
            old_location = self._presence_location_label(old_value)
            location = self._presence_location_label(value)
            if value == "home":
                title = f"{name} Arrived Home"
                summary = f"{name} is home"
                icon = "mdi:home-account"
            elif old_value == "home":
                title = f"{name} Left Home"
                summary = (
                    f"{name} is away"
                    if value == "not_home"
                    else f"{name} is at {location}"
                )
                icon = "mdi:account-arrow-right"
            elif value == "not_home":
                title = (
                    f"{name} Left {old_location}"
                    if old_value not in {"not_home", "unknown", "unavailable"}
                    else f"{name} Is Away"
                )
                summary = f"{name} is away"
                icon = "mdi:account-arrow-right"
            else:
                title = f"{name} Arrived at {location}"
                summary = f"{name} is at {location}"
                icon = "mdi:map-marker-account"

        if not title:
            return None
        stamp = self._now()
        provider = (
            PROVIDER_FAMILY if domain == "person" else PROVIDER_SECURITY
        )
        return {
            "id": f"direct_history:{entity_id}:{value}:{stamp}",
            "event_type": "direct_state_transition",
            "entity_id": entity_id,
            "provider": provider,
            "category": provider,
            "message": title,
            "detail": summary,
            "icon": icon,
            "priority": priority,
            "active": False,
            "state": value,
            "created_at": stamp,
            "resolved_at": stamp,
            "source": "direct_history",
            "ticker_eligible": False,
        }

    def _resolved_source_ids(self) -> list[str]:
        return list(dict.fromkeys([
            *self.registry.all(),
            *self._camera_health_entity_ids(),
            *self._presence_entity_ids(),
        ]))

    def _sources(self, role: str) -> tuple[str, ...]:
        return self.registry.get(role)

    def _camera_health_groups(self) -> dict[str, tuple[str, ...]]:
        """Group enabled camera streams by their physical HA device."""
        groups: dict[str, list[str]] = {}
        registry = er.async_get(self.hass)
        for entry in registry.entities.values():
            if (
                entry.domain != "camera"
                or entry.disabled_by is not None
                or entry.device_id is None
            ):
                continue
            groups.setdefault(entry.device_id, []).append(entry.entity_id)
        return {
            device_id: tuple(sorted(entity_ids))
            for device_id, entity_ids in groups.items()
        }

    def _camera_health_entity_ids(self) -> tuple[str, ...]:
        return tuple(
            entity_id
            for entity_ids in self._camera_health_groups().values()
            for entity_id in entity_ids
        )

    def _presence_entity_ids(self) -> tuple[str, ...]:
        """Return enabled household person entities when Family is selected."""
        enabled = set(normalize_providers(
            self.options.get("enabled_providers")
        ))
        if PROVIDER_FAMILY not in enabled:
            return ()
        discovered = [
            state.entity_id for state in self.hass.states.async_all("person")
        ]
        registry = er.async_get(self.hass)
        registered = [
            entry.entity_id for entry in registry.entities.values()
            if entry.domain == "person" and entry.disabled_by is None
        ]
        return tuple(dict.fromkeys([*discovered, *registered]))

    def _purge_entity_records(self, entity_ids: set[str]) -> None:
        def keep(item: dict) -> bool:
            return item.get("entity_id") not in entity_ids

        self.active = {key: item for key, item in self.active.items() if keep(item)}
        self.ticker = {key: item for key, item in self.ticker.items() if keep(item)}
        self.history = [item for item in self.history if keep(item)]

    async def _ticker_tick(self, _now) -> None:
        self._configure_direct_history_subscription()
        if self._reconcile_shadow_policy(_now):
            self._save_shadow_policy()
        if self._reconcile_shadow_ledger(_now):
            self._save_shadow_ledger()
        await self._async_refresh_forecast()
        await self._async_refresh_source_adapters()
        self._publish()

    async def _async_refresh_sources_and_publish(
        self, *, force: bool = False
    ) -> None:
        await self._async_refresh_source_adapters(force=force)
        self._publish()

    async def _async_refresh_source_adapters(
        self, *, force: bool = False
    ) -> None:
        """Refresh enabled external sources and retain one item per adapter."""
        enabled = set(normalize_providers(
            self.options.get("enabled_providers")
        ))
        if PROVIDER_NEWS not in enabled:
            self._source_items = []
            return
        session = async_get_clientsession(self.hass)
        await asyncio.gather(*(
            adapter.async_refresh(session, force=force)
            for adapter in self._source_adapters
        ))
        self._source_items = [
            dict(item)
            for adapter in self._source_adapters
            for item in adapter.items
        ]

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
        candidates = [configured, "weather.kjax"]
        for entity_id in candidates:
            if entity_id and entity_id.startswith("weather.") and (
                self.hass.states.get(entity_id) is not None
                or er.async_get(self.hass).async_get(entity_id) is not None
            ):
                return entity_id
        discovered = [state.entity_id for state in self.hass.states.async_all("weather")]
        if len(discovered) == 1:
            return discovered[0]
        registry = er.async_get(self.hass)
        registered = [
            entity.entity_id for entity in registry.entities.values()
            if entity.domain == "weather" and entity.disabled_by is None
        ]
        return registered[0] if len(registered) == 1 else None

    @callback
    def _state_changed(self, event: Event) -> None:
        # State events invalidate the live snapshot. _publish rebuilds the
        # complete snapshot from current HA states, preventing stale items.
        self._record_easystart_fault_count_change(event)
        self._publish()

    def _record_easystart_fault_count_change(self, event: Event) -> None:
        """Store a recent event only when EasyStart's lifetime count rises."""
        old_state = event.data.get("old_state")
        new_state = event.data.get("new_state")
        if (
            old_state is None
            or new_state is None
            or new_state.entity_id not in self._sources("hvac_fault_counter")
        ):
            return
        try:
            old_value = int(float(old_state.state))
            new_value = int(float(new_state.state))
        except (TypeError, ValueError):
            # Initial availability and unknown states establish a baseline
            # without creating a false historical fault.
            return
        if new_value <= old_value:
            return
        increase = new_value - old_value
        stamp = self._now()
        message = (
            "EasyStart Fault Recorded"
            if increase == 1
            else f"{increase} EasyStart Faults Recorded"
        )
        event_item = {
            "id": f"easystart_fault_count:{new_value}:{stamp}",
            "event_type": "hvac_fault_counter",
            "entity_id": EASYSTART_FAULT_COUNTER,
            "provider": PROVIDER_CLIMATE,
            "category": PROVIDER_CLIMATE,
            "message": message,
            "detail": (
                f"Lifetime fault count increased from "
                f"{old_value} to {new_value}"
            ),
            "icon": "mdi:counter",
            "priority": "normal",
            "active": False,
            "created_at": stamp,
            "resolved_at": stamp,
            "source": "hvac_fault_counter",
            "ticker_eligible": False,
        }
        self.history = self._retained_history([event_item, *self.history])
        self.hass.async_create_task(
            self.store.async_save({"events": self.history})
        )

    def _rebuild_live_items(self) -> None:
        """Rebuild active state exclusively from the current HA state snapshot."""
        previous = dict(self.active)
        rebuilt: dict[str, dict] = {}
        for entity_id in self._observed_entity_ids():
            state = self.hass.states.get(entity_id)
            refrigerator_safety_sources = {
                *self._sources("refrigerator_doors"),
                *self._sources("refrigerator_temperatures"),
            }
            preserved_unavailable_sources = {
                *refrigerator_safety_sources,
                *self._sources("laundry_state"),
                *self._sources("appliance_maintenance"),
                *self._sources("sprinkler_valves"),
            }
            if not state:
                if entity_id in preserved_unavailable_sources:
                    for old in previous.values():
                        if old.get("entity_id") == entity_id:
                            rebuilt[old["id"]] = old
                continue
            if (
                state.state in ("unknown", "unavailable")
                and entity_id not in self._sources("hvac_diagnostics")
            ):
                if (
                    entity_id in self._sources("filter_status")
                    or entity_id in self._sources("filter_usage")
                    or entity_id in preserved_unavailable_sources
                ):
                    for old in previous.values():
                        if old.get("entity_id") == entity_id:
                            rebuilt[old["id"]] = old
                continue
            for item in self._build_items(entity_id, state):
                if item.get("active"):
                    old = previous.get(item["id"])
                    easystart_status_changed = (
                        old
                        and item.get("event_type") in {
                            "hvac_diagnostic", "hvac_short_cycle",
                        }
                        and old.get("state") != item.get("state")
                    )
                    if old and not easystart_status_changed:
                        item.update({key: old.get(key) for key in ("created_at", "ticker_eligible", "ticker_until", "last_ticker_at", "next_reminder_at")})
                    rebuilt[item["id"]] = item

        camera_item = self._build_camera_health_item()
        if camera_item is not None:
            old = previous.get(camera_item["id"])
            if old and old.get("offline_names") == camera_item.get(
                "offline_names"
            ):
                camera_item.update({
                    key: old.get(key)
                    for key in (
                        "created_at", "ticker_eligible", "ticker_until",
                        "last_ticker_at", "next_reminder_at",
                    )
                })
            elif old:
                camera_item["created_at"] = old.get(
                    "created_at", camera_item["created_at"]
                )
            rebuilt[camera_item["id"]] = camera_item

        update_item = self._build_system_update_item()
        old_update = previous.get(f"{DOMAIN}:system_updates")
        if update_item is not None:
            if old_update and old_update.get(
                "active_entities"
            ) == update_item.get("active_entities"):
                update_item.update({
                    key: old_update.get(key)
                    for key in (
                        "created_at", "ticker_eligible", "ticker_until",
                        "last_ticker_at", "next_reminder_at",
                    )
                })
            elif old_update:
                update_item["created_at"] = old_update.get(
                    "created_at", update_item["created_at"]
                )
            rebuilt[update_item["id"]] = update_item
        elif old_update and any(
            (
                (state := self.hass.states.get(entity_id)) is None
                or str(state.state).casefold() in {"unknown", "unavailable"}
            )
            for entity_id in old_update.get("active_entities", [])
        ):
            rebuilt[old_update["id"]] = old_update

        resolved = []
        for item_id, old in previous.items():
            if item_id in rebuilt:
                continue
            if (
                old.get("entity_id") in LIVE_ONLY_NOTIFICATION_SOURCES
                or old.get("entity_id") == "switch.sprinklers_rain_delay"
                or old.get("event_type") == "hvac_short_cycle"
            ):
                # Maintenance faults and rain delay are live-only statuses.
                # Clearing them must not create stale history/footer noise.
                self.ticker.pop(item_id, None)
                continue
            resolved_item = dict(old)
            resolved_item.update({"active": False, "resolved_at": self._now(), "ticker_eligible": True})
            if old.get("entity_id", "").startswith("binary_sensor.") and old.get("behavior") == "contact":
                state = self.hass.states.get(old["entity_id"])
                name = self._plain_entity_name(
                    old["entity_id"],
                    state.attributes.get("friendly_name") if state else None,
                )
                resolved_item.update({
                    "message": f"{name} Closed",
                    "detail": f"{name} is closed",
                    "priority": "normal",
                })
            elif old.get("event_type") == "water_leak":
                location = str(old.get("message") or "Water").removesuffix(
                    " Leak"
                )
                resolved_item.update({
                    "message": f"{location} Leak Cleared",
                    "detail": f"{location} is dry",
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "hvac_diagnostic":
                resolved_item.update({
                    "message": "HVAC Diagnostics Normal",
                    "detail": "Micro-Air returned to normal",
                    "priority": "normal",
                    "ticker_eligible": False,
                    "ticker_until": None,
                })
                # Keep recovery in recent history without publishing a
                # normal Micro-Air ticker or footer alert.
                self.ticker.pop(item_id, None)
            elif old.get("event_type") == "filter_maintenance":
                resolved_item.update({
                    "message": "Water Filter Replaced",
                    "detail": "Refrigerator water filter usage returned to normal",
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "refrigerator_door_alert":
                location = "Freezer" if "freezer" in old.get(
                    "entity_id", ""
                ) else "Refrigerator"
                opened_at = old.get("created_at")
                try:
                    opened = datetime.fromisoformat(
                        str(opened_at).replace("Z", "+00:00")
                    ).astimezone(timezone.utc)
                    elapsed_minutes = max(
                        1,
                        round(
                            (
                                datetime.now(timezone.utc) - opened
                            ).total_seconds() / 60
                        ),
                    )
                    duration = f"Open for {elapsed_minutes} minutes"
                except (TypeError, ValueError):
                    duration = "Door is closed"
                resolved_item.update({
                    "message": f"{location} Door Closed",
                    "detail": duration,
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "refrigerator_temperature_alert":
                location = "Freezer" if "freezer" in old.get(
                    "entity_id", ""
                ) else "Refrigerator"
                resolved_item.update({
                    "message": f"{location} Temperature Normal",
                    "detail": f"{location} returned to its normal range",
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "appliance_cycle":
                entity_id = old.get("entity_id", "")
                config = APPLIANCE_CYCLES.get(entity_id, {})
                name = config.get("name", "Appliance")
                state = self.hass.states.get(entity_id)
                value = str(getattr(state, "state", "")).casefold()
                completed = value in {
                    "complete", "completed", "finished", "done", "end",
                }
                resolved_item.update({
                    "message": (
                        f"{name} Cycle Complete"
                        if completed
                        else f"{name} Cycle Ended"
                    ),
                    "detail": (
                        f"{name} is ready"
                        if completed
                        else f"{name} is no longer running"
                    ),
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "appliance_maintenance":
                entity_id = old.get("entity_id", "")
                config = APPLIANCE_MAINTENANCE.get(entity_id, {})
                resolved_item.update({
                    "message": config.get(
                        "resolved_message", "Appliance Maintenance Complete"
                    ),
                    "detail": "Maintenance reminder cleared",
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "sprinkler_watering":
                started_at = old.get("created_at")
                try:
                    started = datetime.fromisoformat(
                        str(started_at).replace("Z", "+00:00")
                    ).astimezone(timezone.utc)
                    elapsed = max(
                        1,
                        round(
                            (
                                datetime.now(timezone.utc) - started
                            ).total_seconds() / 60
                        ),
                    )
                    duration = f"Ran for {elapsed} minutes"
                except (TypeError, ValueError):
                    duration = "Watering cycle ended"
                zones = str(old.get("detail") or "").split(" · ")[0]
                resolved_item.update({
                    "message": "Watering Complete",
                    "detail": " · ".join(
                        value for value in (zones, duration) if value
                    ),
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "camera_offline":
                names = old.get("offline_names") or []
                if len(names) == 1:
                    message = f"{names[0]} Camera Back Online"
                    detail = f"{names[0]} is available again"
                else:
                    message = "Cameras Back Online"
                    detail = "All affected cameras are available again"
                resolved_item.update({
                    "message": message,
                    "detail": detail,
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("event_type") == "system_updates":
                resolved_item.update({
                    "message": "Home Assistant Updates Complete",
                    "detail": "Core system updates are installed",
                    "priority": "normal",
                    "ticker_until": (
                        datetime.now(timezone.utc) + timedelta(minutes=10)
                    ).isoformat(),
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("behavior") == "fault" and old.get("category") == "maintenance":
                state = self.hass.states.get(old.get("entity_id"))
                name = self._plain_entity_name(
                    old.get("entity_id", ""),
                    state.attributes.get("friendly_name") if state else None,
                )
                resolved_item.update({
                    "message": "Water Leak Cleared",
                    "detail": self._moisture_location(str(name)),
                })
            resolved.append(resolved_item)
        if resolved:
            _LOGGER.debug("Home Status resolved items removed during refresh: %s", resolved)
            self.history = self._retained_history([*resolved, *self.history])
            self.hass.async_create_task(self.store.async_save({"events": self.history}))
        self.active = rebuilt
        _LOGGER.debug("Home Status live normalized active items: %s", [self._compact_item(item) for item in rebuilt.values()])
        _LOGGER.debug("Home Status open contact diagnostics: %s", [
            {
                "entity_id": item.get("entity_id"),
                "provider": item.get("provider"),
                "category": item.get("category"),
                "priority": item.get("priority"),
                "active": item.get("active"),
                "hero_eligible": item.get("hero_eligible"),
                "persistent": item.get("persistent"),
                "ticker_eligible": item.get("ticker_eligible"),
            }
            for item in rebuilt.values()
            if item.get("entity_id") in self._sources("contact_sensors") and item.get("active")
        ])

    def _observe_state(self, entity_id: str, old_state: State | None, new_state: State | None, startup: bool = False) -> None:
        if new_state is None or new_state.state in ("unknown", "unavailable"):
            return
        items = self._build_items(entity_id, new_state)
        if not items:
            items = []
        current_ids = {item["id"] for item in items if item["active"]}
        previous = {key: value for key, value in self.active.items() if value.get("entity_id") == entity_id}
        for key, old in previous.items():
            if key not in current_ids and not startup:
                resolved = dict(old)
                resolved.update({
                    "active": False,
                    "resolved_at": self._now(),
                    "ticker_eligible": True,
                    "ticker_until": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
                })
                self.history.insert(0, resolved)
                self.active.pop(key, None)
                if self._entity_publish_enabled(entity_id):
                    self.ticker[key] = resolved
                _LOGGER.debug("Home Status resolved item removed from active: %s", resolved)
        for item in items:
            if not item["active"]:
                continue
            old = self.active.get(item["id"])
            if old and self._meaningfully_changed(old, item):
                item.update({"created_at": old.get("created_at", item["created_at"]), "ticker_eligible": True})
            elif old:
                item.update({key: old.get(key) for key in ("created_at", "ticker_eligible", "ticker_until", "last_ticker_at", "next_reminder_at")})
            self.active[item["id"]] = item
            if item.get("ticker_eligible"):
                self.ticker[item["id"]] = item
        if not startup:
            self.history = self._retained_history(self.history)
            self.hass.async_create_task(self.store.async_save({"events": self.history}))

    def _build_items(self, entity_id: str, state: State) -> list[dict]:
        alerts = state.attributes.get("Alerts") or state.attributes.get("alerts")
        if isinstance(alerts, list):
            return [self._build_weather_item(entity_id, state, alert) for alert in alerts if isinstance(alert, dict)]
        item = self._build_item(entity_id, state)
        return [item] if item else []

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

    @staticmethod
    def _meaningfully_changed(old: dict, new: dict) -> bool:
        return any(old.get(key) != new.get(key) for key in ("message", "priority", "detail", "expires_at", "source_severity"))

    def _build_item(self, entity_id: str, state: State) -> dict | None:
        if entity_id in self._sources("hvac_diagnostics"):
            return self._build_hvac_diagnostic_item(entity_id, state)
        if (
            entity_id in self._sources("hvac_diagnostic_details")
            or entity_id in self._sources("hvac_fault_counter")
        ):
            # These entities enrich the EasyStart alert but never publish as
            # independent notifications.
            return None
        if (
            entity_id in self._sources("filter_status")
            or entity_id in self._sources("filter_usage")
        ):
            return self._build_filter_maintenance_item(entity_id, state)
        if entity_id in self._sources("refrigerator_doors"):
            return self._build_refrigerator_door_item(entity_id, state)
        if entity_id in self._sources("refrigerator_temperatures"):
            return self._build_refrigerator_temperature_item(entity_id, state)
        if entity_id in self._sources("laundry_state"):
            return self._build_appliance_cycle_item(entity_id, state)
        if entity_id in self._sources("laundry_remaining"):
            return None
        if entity_id in self._sources("appliance_maintenance"):
            return self._build_appliance_maintenance_item(entity_id, state)
        if entity_id in self._sources("sprinkler_valves"):
            return self._build_sprinkler_watering_item(entity_id)
        if entity_id in self._sources("system_updates"):
            return None
        domain = entity_id.split(".", 1)[0]
        device_class = state.attributes.get("device_class")
        if entity_id in EXPLICIT_BINARY_NOTIFICATION_SOURCES:
            device_class = "problem"
        if entity_id in self._sources("contact_sensors"):
            device_class = device_class or "door"
        active = self._is_active(domain, device_class, state.state)
        if active is None:
            return None
        name = self._plain_entity_name(
            entity_id, state.attributes.get("friendly_name")
        )
        override = self.options.get("entity_overrides", {}).get(entity_id, {})
        publish_mode = override.get("publish_mode")
        if publish_mode in {"status", "disabled"}:
            return None
        behavior = self._behavior(domain, device_class)
        computed_priority = "critical" if device_class in {"moisture", "smoke", "problem", "gas", "carbon_monoxide"} else "attention" if active else "normal"
        if entity_id == "switch.sprinklers_rain_delay":
            computed_priority = "normal"
        is_contact = entity_id in self._sources("contact_sensors")
        priority = "attention" if is_contact and active else (override.get("priority_override") or computed_priority)
        provider_override = normalize_provider(override.get("provider_override")) if override.get("provider_override") else None
        provider = "security" if is_contact else provider_override or {
            "alarm": "security",
            "contact": "security",
            "detection": "security",
            "fault": PROVIDER_MAINTENANCE,
        }.get(behavior, behavior)
        if entity_id == "switch.sprinklers_rain_delay":
            provider = PROVIDER_SCHEDULE
        _LOGGER.debug(
            "Home Status item: id=%s provider=%s computed=%s override=%s final=%s publish_mode=%s",
            f"{DOMAIN}:{entity_id}", provider, computed_priority,
            override.get("priority_override"), priority, publish_mode or "both",
        )
        name = override.get("label_override") or name
        is_leak = entity_id in self._sources("leak_sensors") or device_class == "moisture"
        if is_leak:
            name = override.get("label_override") or LEAK_SOURCE_NAMES.get(
                entity_id, name
            )
            provider = PROVIDER_SECURITY
            location = self._moisture_location(name)
            message = f"{location} Leak" if active else "Water Leak Cleared"
            detail = "Water detected" if active else location
        else:
            message = f"{name} Active" if active else f"{name} Clear"
            detail = f"{name} is active" if active else f"{name} is clear"
        if domain == "alarm_control_panel":
            alarm_state = str(state.state).lower()
            alarm_labels = {
                "disarmed": ("Alarm Off", "Your home is not protected."),
                "armed_home": ("Alarm On", "Your home is protected."),
                "armed_away": ("Alarm On", "Your home is protected."),
                "armed_night": ("Alarm On", "Your home is protected."),
                "arming": ("Alarm Starting", "Leave before the countdown ends."),
                "pending": ("Entry Delay", "Disarm the alarm before time expires."),
                "triggered": ("🚨 Security Alert!", "Alarm has been triggered."),
            }
            message, detail = alarm_labels.get(alarm_state, ("Alarm Status", "Alarm status unavailable."))
        icon = state.attributes.get("icon")
        if not icon and domain in {"light", "switch"}:
            icon = "mdi:light-switch"
        return {
            "id": f"{DOMAIN}:{entity_id}",
            "entity_id": entity_id,
            "event_type": "water_leak" if is_leak else "entity_state",
            "behavior": behavior,
            "message": message,
            "detail": detail,
            "category": "contact" if is_contact else provider,
            "provider": provider,
            "priority": priority,
            "icon": override.get("icon_override") or icon or ("mdi:alert-circle" if active else "mdi:check-circle"),
            "created_at": state.last_changed.isoformat(),
            "media_url": f"/api/camera_proxy/camera.front_door?t={state.last_changed.timestamp()}" if entity_id == "binary_sensor.front_door_visitor" and active else None,
            "media_type": "image" if entity_id == "binary_sensor.front_door_visitor" and active else None,
            "active": active,
            "ticker_eligible": active and entity_id != "switch.sprinklers_rain_delay",
            "ticker_until": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (
                datetime.now(timezone.utc) + timedelta(minutes=45)
            ).isoformat() if is_leak and active else None,
            "persistent": False if is_contact else entity_id != "switch.sprinklers_rain_delay",
            "hero_eligible": bool(is_contact and active) or bool(priority in {"critical", "attention"} and active and not entity_id == ALARM_ENTITY),
            "state": state.state,
        }

    def _build_hvac_diagnostic_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish Micro-Air only when its diagnostic state needs attention."""
        value = str(state.state or "").strip()
        normalized = value.casefold()
        if normalized in {"normal", "ok", "healthy", "clear"}:
            return None
        unavailable = normalized in {"unknown", "unavailable", ""}
        status_contract = {
            "unexpected curr flt": (
                "EasyStart Unexpected Current",
                "Unexpected compressor current was detected",
                "attention",
                "mdi:current-ac",
            ),
            "short cycle delay": (
                "EasyStart Short-Cycle Delay",
                "Compressor restart is being delayed for protection",
                "activity",
                "mdi:timer-sand",
            ),
            "pwr intrrptn fault": (
                "EasyStart Power Interruption",
                "Compressor power was interrupted",
                "attention",
                "mdi:transmission-tower-off",
            ),
            "stall fault": (
                "EasyStart Compressor Stall",
                "The compressor did not reach normal running speed",
                "critical",
                "mdi:engine-off-outline",
            ),
            "stuck sr fault": (
                "EasyStart Start Relay Fault",
                "The compressor start relay may be stuck",
                "critical",
                "mdi:electric-switch-closed",
            ),
            "open ovrld fault": (
                "EasyStart Open Overload",
                "The compressor overload protection opened",
                "critical",
                "mdi:alert-octagon",
            ),
            "overcurrent fault": (
                "EasyStart Overcurrent",
                "Compressor current exceeded its protection limit",
                "critical",
                "mdi:current-ac",
            ),
            "bad wiring fault": (
                "EasyStart Wiring Fault",
                "EasyStart detected an invalid wiring condition",
                "critical",
                "mdi:cable-data",
            ),
            "wrong voltage flt": (
                "EasyStart Voltage Fault",
                "EasyStart detected an invalid line voltage",
                "critical",
                "mdi:flash-alert",
            ),
        }
        if unavailable:
            message = "EasyStart Diagnostics Unavailable"
            description = "Micro-Air status is unavailable"
            priority = "attention"
            icon = "mdi:hvac-off"
        else:
            message, description, priority, icon = status_contract.get(
                normalized,
                (
                    "EasyStart Diagnostic Alert",
                    value,
                    "attention",
                    "mdi:hvac",
                ),
            )
        diagnostics = self._easystart_diagnostics()
        detail = " • ".join([
            description,
            *(
                f"{diagnostic['label']} {diagnostic['value']}"
                for diagnostic in diagnostics
            ),
        ])
        now = datetime.now(timezone.utc)
        short_cycle = normalized == "short cycle delay"
        return {
            "id": f"{DOMAIN}:hvac_diagnostic",
            "entity_id": entity_id,
            "event_type": (
                "hvac_short_cycle" if short_cycle else "hvac_diagnostic"
            ),
            "behavior": "fault",
            "message": message,
            "detail": detail,
            "diagnostics": diagnostics,
            "category": PROVIDER_CLIMATE,
            "provider": PROVIDER_CLIMATE,
            "priority": priority,
            "icon": icon,
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (
                None
                if short_cycle
                else (now + timedelta(minutes=45)).isoformat()
            ),
            "persistent": not short_cycle,
            "hero_eligible": priority in {"critical", "attention"},
            "state": state.state,
        }

    def _easystart_diagnostics(self) -> list[dict]:
        """Return available EasyStart readings as supporting alert fields."""
        diagnostics = []
        enabled_entities = set(self._sources("hvac_diagnostic_details"))
        for entity_id, label in EASYSTART_DIAGNOSTIC_DETAILS.items():
            if entity_id not in enabled_entities:
                continue
            state = self.hass.states.get(entity_id)
            raw_value = str(getattr(state, "state", "") or "").strip()
            if raw_value.casefold() in {"", "unknown", "unavailable"}:
                continue
            try:
                numeric = float(raw_value)
                display_value = (
                    str(int(numeric))
                    if numeric.is_integer()
                    else f"{numeric:.1f}".rstrip("0").rstrip(".")
                )
            except ValueError:
                display_value = raw_value
            unit = str(
                getattr(state, "attributes", {}).get(
                    "unit_of_measurement", ""
                )
            ).strip()
            diagnostics.append({
                "entity_id": entity_id,
                "label": label,
                "value": " ".join(
                    part for part in (display_value, unit) if part
                ),
            })
        return diagnostics

    def _build_filter_maintenance_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish one refrigerator water-filter reminder without duplicates."""
        status_entity = next(iter(self._sources("filter_status")), None)
        status_state = (
            self.hass.states.get(status_entity) if status_entity else None
        )
        status_active = (
            status_state is not None
            and str(status_state.state).casefold() == "on"
        )
        is_status = entity_id == status_entity
        if is_status:
            if not status_active:
                return None
            summary = "The refrigerator reports that its water filter needs attention"
        else:
            if status_active:
                return None
            try:
                usage = float(state.state)
            except (TypeError, ValueError):
                return None
            if usage < 90:
                return None
            unit = str(state.attributes.get("unit_of_measurement") or "%").strip()
            summary = f"Water filter usage is {state.state}{unit}"
        now = datetime.now(timezone.utc)
        return {
            "id": f"{DOMAIN}:refrigerator_water_filter",
            "entity_id": entity_id,
            "event_type": "filter_maintenance",
            "behavior": "maintenance",
            "message": "Replace Refrigerator Water Filter",
            "detail": summary,
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": "mdi:water-sync",
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }

    def _build_appliance_cycle_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Build one combined state and remaining-time item per appliance."""
        config = APPLIANCE_CYCLES.get(entity_id)
        if not config:
            return None
        value = str(state.state or "").strip()
        normalized = value.casefold()
        if normalized in {
            "", "unknown", "unavailable", "off", "idle", "ready",
            "complete", "completed", "finished", "done", "end", "power_off",
        }:
            return None
        name = config["name"]
        remaining_state = self.hass.states.get(config["remaining"])
        minutes = self._remaining_minutes(remaining_state)
        phase = value.replace("_", " ").replace("-", " ").title()
        details = [phase]
        if minutes is not None and minutes > 0:
            details.append(f"About {max(1, round(minutes))} minutes remaining")
        return {
            "id": f"{DOMAIN}:appliance_cycle:{entity_id}",
            "entity_id": entity_id,
            "event_type": "appliance_cycle",
            "behavior": "activity",
            "message": f"{name} Running",
            "detail": " · ".join(details),
            "category": PROVIDER_LAUNDRY,
            "provider": PROVIDER_LAUNDRY,
            "priority": "activity",
            "icon": config["icon"],
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }

    def _build_appliance_maintenance_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish dishwasher maintenance only while action is required."""
        config = APPLIANCE_MAINTENANCE.get(entity_id)
        if not config or str(state.state).casefold() != "on":
            return None
        return {
            "id": f"{DOMAIN}:appliance_maintenance:{entity_id}",
            "entity_id": entity_id,
            "event_type": "appliance_maintenance",
            "behavior": "maintenance",
            "message": config["message"],
            "detail": config["detail"],
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": config["icon"],
            "created_at": state.last_changed.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": state.state,
        }

    def _build_sprinkler_watering_item(
        self, entity_id: str
    ) -> dict | None:
        """Build one grouped item for all currently watering sprinkler zones."""
        sources = self._sources("sprinkler_valves")
        owner = next(
            (
                source for source in sources
                if (
                    (state := self.hass.states.get(source)) is not None
                    and str(state.state).casefold()
                    not in {"unknown", "unavailable"}
                )
            ),
            None,
        )
        if entity_id != owner:
            return None
        active = []
        for source in sources:
            state = self.hass.states.get(source)
            if not state or str(state.state).casefold() not in {
                "open", "opening", "on",
            }:
                continue
            active.append((source, state))
        if not active:
            return None
        zone_names = [self._sprinkler_zone_name(source) for source, _ in active]
        message = (
            f"Watering {zone_names[0]}"
            if len(zone_names) == 1
            else f"Watering {len(zone_names)} Zones"
        )
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, state in active
        )
        return {
            "id": f"{DOMAIN}:sprinkler_watering",
            "entity_id": owner,
            "event_type": "sprinkler_watering",
            "behavior": "activity",
            "message": message,
            "detail": ", ".join(zone_names),
            "category": PROVIDER_SCHEDULE,
            "provider": PROVIDER_SCHEDULE,
            "priority": "activity",
            "icon": "mdi:sprinkler-variant",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": "open",
        }

    @staticmethod
    def _sprinkler_zone_name(entity_id: str) -> str:
        match = re.search(r"zone[_\s-]*(\d+)", entity_id, re.IGNORECASE)
        return f"Zone {match.group(1)}" if match else plain_entity_name(entity_id)

    def _build_camera_health_item(self) -> dict | None:
        """Build one alert for physical cameras whose streams are all offline."""
        offline: list[tuple[str, str, State]] = []
        for entity_ids in self._camera_health_groups().values():
            states = [
                state for entity_id in entity_ids
                if (state := self.hass.states.get(entity_id)) is not None
            ]
            if not states or not all(
                str(state.state).casefold() == "unavailable"
                for state in states
            ):
                continue
            owner = min(entity_ids, key=self._camera_entity_rank)
            owner_state = self.hass.states.get(owner) or states[0]
            offline.append((
                owner,
                self._camera_name(owner, owner_state),
                min(states, key=lambda state: state.last_changed),
            ))
        if not offline:
            return None

        offline.sort(key=lambda item: item[1].casefold())
        names = [name for _, name, _ in offline]
        message = (
            f"{names[0]} Camera Offline"
            if len(names) == 1
            else f"{len(names)} Cameras Offline"
        )
        now = datetime.now(timezone.utc)
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, _, state in offline
        )
        return {
            "id": f"{DOMAIN}:camera_health",
            "entity_id": offline[0][0],
            "event_type": "camera_offline",
            "behavior": "fault",
            "message": message,
            "detail": ", ".join(names),
            "offline_names": names,
            "category": PROVIDER_CAMERAS,
            "provider": PROVIDER_CAMERAS,
            "priority": "critical",
            "icon": "mdi:cctv-off",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
            "persistent": True,
            "hero_eligible": True,
            "state": "unavailable",
        }

    @staticmethod
    def _camera_entity_rank(entity_id: str) -> tuple[int, int, str]:
        duplicate_suffix = bool(re.search(
            r"_(?:fluent|clear|snapshot|sub(?:stream)?|main(?:stream)?)$",
            entity_id,
            re.IGNORECASE,
        ))
        return (1 if duplicate_suffix else 0, len(entity_id), entity_id)

    @staticmethod
    def _camera_name(entity_id: str, state: State) -> str:
        name = plain_entity_name(
            entity_id, state.attributes.get("friendly_name")
        )
        name = re.sub(
            r"\s+(?:fluent|clear|snapshot|substream|mainstream)$",
            "",
            name,
            flags=re.IGNORECASE,
        )
        return re.sub(r"\s+camera$", "", name, flags=re.IGNORECASE).strip()

    def _build_system_update_item(self) -> dict | None:
        """Build one maintenance item for core Home Assistant updates."""
        updates: list[tuple[str, str, str, State]] = []
        for entity_id in self._sources("system_updates"):
            state = self.hass.states.get(entity_id)
            if not state or str(state.state).casefold() != "on":
                continue
            name = SYSTEM_UPDATES.get(
                entity_id, self._plain_entity_name(
                    entity_id, state.attributes.get("friendly_name")
                )
            )
            latest = str(
                state.attributes.get("latest_version")
                or state.attributes.get("latest")
                or ""
            ).strip()
            updates.append((entity_id, name, latest, state))
        if not updates:
            return None

        updates.sort(key=lambda item: item[1].casefold())
        if len(updates) == 1:
            message = f"{updates[0][1]} Update Available"
        else:
            message = f"{len(updates)} Home Assistant Updates Available"
        detail = ", ".join(
            f"{name} {latest}".strip()
            for _, name, latest, _ in updates
        )
        created_at = min(
            state.last_changed.astimezone(timezone.utc)
            for _, _, _, state in updates
        )
        return {
            "id": f"{DOMAIN}:system_updates",
            "entity_id": updates[0][0],
            "event_type": "system_updates",
            "behavior": "maintenance",
            "message": message,
            "detail": detail,
            "active_entities": [
                entity_id for entity_id, _, _, _ in updates
            ],
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": "activity",
            "icon": "mdi:update",
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": False,
            "ticker_until": None,
            "last_ticker_at": None,
            "next_reminder_at": None,
            "persistent": True,
            "hero_eligible": False,
            "state": "on",
        }

    def _build_presence_status_item(self) -> dict | None:
        """Build one quiet household location summary."""
        people = []
        for entity_id in self._presence_entity_ids():
            state = self.hass.states.get(entity_id)
            if not state or str(state.state).casefold() in {
                "unknown", "unavailable", "",
            }:
                continue
            people.append((
                entity_id,
                self._plain_entity_name(
                    entity_id, state.attributes.get("friendly_name")
                ),
                self._presence_location_label(state.state),
                state,
            ))
        if not people:
            return None

        people.sort(key=lambda item: item[1].casefold())
        home = [name for _, name, location, _ in people if location == "Home"]
        away = [
            (name, location)
            for _, name, location, _ in people
            if location != "Home"
        ]
        if len(home) == len(people):
            title = "Everyone Home"
            summary = self._join_names(home)
            priority = "normal"
            icon = "mdi:home-account"
        elif not home:
            title = "Everyone Away"
            summary = " • ".join(
                f"{name}: {location}" for name, location in away
            )
            priority = "activity"
            icon = "mdi:home-export-outline"
        else:
            title = f"{len(home)} of {len(people)} Home"
            away_summary = ", ".join(
                f"{name}: {location}" for name, location in away
            )
            summary = (
                f"Home: {self._join_names(home)}"
                f" • {away_summary}"
            )
            priority = "activity"
            icon = "mdi:account-group"
        changed = max(
            state.last_changed for _, _, _, state in people
        ).isoformat()
        return self._stream_item(
            f"current:{PROVIDER_FAMILY}",
            title,
            summary,
            PROVIDER_FAMILY,
            icon,
            priority,
            changed,
            entity_id=people[0][0],
            source="family_presence",
        )

    @staticmethod
    def _presence_location_label(value: str) -> str:
        normalized = str(value or "").strip().replace("_", " ")
        if normalized.casefold() == "not home":
            return "Away"
        if normalized.casefold() == "home":
            return "Home"
        return normalized.title() or "Away"

    @staticmethod
    def _join_names(names: list[str]) -> str:
        if len(names) < 2:
            return names[0] if names else ""
        if len(names) == 2:
            return f"{names[0]} and {names[1]}"
        return f"{', '.join(names[:-1])}, and {names[-1]}"

    @staticmethod
    def _remaining_minutes(state: State | None) -> float | None:
        """Return a remaining-time sensor value as minutes."""
        if not state or str(state.state).casefold() in {
            "", "unknown", "unavailable", "none",
        }:
            return None
        value = str(state.state).strip()
        try:
            amount = float(value)
            unit = str(
                state.attributes.get("unit_of_measurement") or "min"
            ).casefold()
            if unit in {"s", "sec", "second", "seconds"}:
                return amount / 60
            if unit in {"h", "hr", "hour", "hours"}:
                return amount * 60
            return amount
        except (TypeError, ValueError):
            pass
        parts = value.split(":")
        if len(parts) in {2, 3}:
            try:
                numbers = [float(part) for part in parts]
            except ValueError:
                return None
            if len(numbers) == 2:
                hours, minutes = numbers
                return hours * 60 + minutes
            hours, minutes, seconds = numbers
            return hours * 60 + minutes + seconds / 60
        return None

    def _build_refrigerator_door_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish a refrigerator door only after it has remained open."""
        if str(state.state).casefold() not in {"on", "open", "opening"}:
            return None
        delay = max(
            1, int(self.options.get("refrigerator_door_delay_minutes", 3))
        )
        changed = state.last_changed.astimezone(timezone.utc)
        if datetime.now(timezone.utc) - changed < timedelta(minutes=delay):
            return None
        location = "Freezer" if "freezer" in entity_id else "Refrigerator"
        return self._refrigerator_safety_item(
            entity_id=entity_id,
            state=state,
            event_type="refrigerator_door_alert",
            message=f"{location} Door Left Open",
            detail=f"Open for more than {delay} minutes",
            icon="mdi:fridge-alert-outline",
            created_at=changed,
            priority="attention",
        )

    def _build_refrigerator_temperature_item(
        self, entity_id: str, state: State
    ) -> dict | None:
        """Publish only sustained unsafe refrigerator temperatures."""
        try:
            temperature = float(state.state)
        except (TypeError, ValueError):
            return None
        freezer = "freezer" in entity_id
        threshold_f = float(self.options.get(
            "refrigerator_freezer_high_temperature" if freezer
            else "refrigerator_fridge_high_temperature",
            10 if freezer else 42,
        ))
        unit = str(state.attributes.get("unit_of_measurement") or "°F")
        threshold = (
            (threshold_f - 32) * 5 / 9
            if "c" in unit.casefold()
            else threshold_f
        )
        tracker = getattr(self, "_condition_since", None)
        if tracker is None:
            tracker = self._condition_since = {}
        if temperature <= threshold:
            tracker.pop(entity_id, None)
            return None
        now = datetime.now(timezone.utc)
        started = tracker.setdefault(entity_id, now)
        delay = max(
            1,
            int(
                self.options.get(
                    "refrigerator_temperature_delay_minutes", 10
                )
            ),
        )
        if now - started < timedelta(minutes=delay):
            return None
        location = "Freezer" if freezer else "Refrigerator"
        return self._refrigerator_safety_item(
            entity_id=entity_id,
            state=state,
            event_type="refrigerator_temperature_alert",
            message=f"{location} Temperature High",
            detail=f"{state.state}{unit} · Safe limit {threshold_f:g}°F",
            icon="mdi:thermometer-alert",
            created_at=started,
            priority="critical",
        )

    def _refrigerator_safety_item(
        self,
        *,
        entity_id: str,
        state: State,
        event_type: str,
        message: str,
        detail: str,
        icon: str,
        created_at: datetime,
        priority: str,
    ) -> dict:
        now = datetime.now(timezone.utc)
        return {
            "id": f"{DOMAIN}:{entity_id}",
            "entity_id": entity_id,
            "event_type": event_type,
            "behavior": "fault",
            "message": message,
            "detail": detail,
            "category": PROVIDER_MAINTENANCE,
            "provider": PROVIDER_MAINTENANCE,
            "priority": priority,
            "icon": icon,
            "created_at": created_at.isoformat(),
            "active": True,
            "ticker_eligible": True,
            "ticker_until": (now + timedelta(minutes=10)).isoformat(),
            "last_ticker_at": None,
            "next_reminder_at": (now + timedelta(minutes=45)).isoformat(),
            "persistent": True,
            "hero_eligible": True,
            "state": state.state,
        }

    @staticmethod
    def _behavior(domain: str, device_class: str | None) -> str:
        if domain == "binary_sensor":
            if device_class in {"door", "window", "opening", "garage_door", "lock"}:
                return "contact"
            if device_class in {"motion", "occupancy", "presence", "moving"}:
                return "detection"
            if device_class in {"moisture", "problem", "smoke", "gas", "carbon_monoxide"}:
                return "fault"
        if domain == "alarm_control_panel":
            return "alarm"
        if domain in {"input_boolean", "input_select", "input_datetime", "select"}:
            return "input"
        if domain in {"light", "switch"}:
            return "state"
        return "event"

    @staticmethod
    def _plain_entity_name(entity_id: str, value=None) -> str:
        """Return a consistent plain-English label without integration prefixes."""
        return plain_entity_name(entity_id, value)

    @staticmethod
    def _moisture_location(name: str) -> str:
        location = str(name or "").strip()
        for suffix in (" moisture sensor", " moisture", " leak sensor", " leak"):
            if location.lower().endswith(suffix):
                return location[:-len(suffix)].rstrip()
        return location

    @staticmethod
    def _is_active(domain: str, device_class: str | None, value: str) -> bool | None:
        if domain == "binary_sensor":
            return value == "on"
        if domain == "alarm_control_panel":
            return value in ALARM_STATES - {"disarmed"}
        if domain == "input_boolean":
            return value == "on"
        if domain in {"light", "switch"}:
            return value == "on"
        if domain in {"input_select", "select"}:
            return None
        return None

    def _publish(self) -> None:
        self._rebuild_live_items()
        raw_alarm_state = getattr(self.hass.states.get(ALARM_ENTITY), "state", None)
        alarm_state = raw_alarm_state if raw_alarm_state in ALARM_STATES else None
        resolved_sources = self._resolved_source_ids()
        missing_sources = [entity_id for entity_id in resolved_sources if self.hass.states.get(entity_id) is None]
        resolved_contacts = list(self._sources("contact_sensors"))
        open_contacts = []
        for entity_id in resolved_contacts:
            state = self.hass.states.get(entity_id)
            if state is not None and state.state == "on":
                open_contacts.append(entity_id)
        _LOGGER.debug("Home Status raw alarm state: %s", raw_alarm_state)
        _LOGGER.debug("Home Status raw contact states: %s", {
            entity_id: getattr(self.hass.states.get(entity_id), "state", None)
            for entity_id in self._resolved_source_ids() if entity_id.startswith("binary_sensor.")
        })
        _LOGGER.debug("Home Status configured hero providers: %s", self.options.get("hero_providers", "backend-only"))
        now = datetime.now(timezone.utc)
        invalidated = {
            item.get("entity_id") for item in [*self.active.values(), *self.ticker.values(), *self.history]
            if item.get("entity_id") and not self._history_entity_enabled(item.get("entity_id"))
        }
        if invalidated:
            self._purge_entity_records(invalidated)
        expired_any = False
        for key, item in list(self.active.items()):
            expires = item.get("expires_at")
            if item.get("event_type") == "weather_alert" and expires:
                try:
                    expired = now >= datetime.fromisoformat(str(expires).replace("Z", "+00:00")).astimezone(timezone.utc)
                except ValueError:
                    expired = False
                if expired:
                    resolved = dict(item)
                    resolved.update({"active": False, "ticker_eligible": False, "resolved_at": now.isoformat()})
                    self.history.insert(0, resolved)
                    self.active.pop(key, None)
                    self.ticker.pop(key, None)
                    expired_any = True
        retained = self._retained_history(self.history)
        if len(retained) != len(self.history):
            self.history = retained
            self.hass.async_create_task(self.store.async_save({"events": self.history}))
        else:
            self.history = retained
        if expired_any:
            self.hass.async_create_task(self.store.async_save({"events": self.history}))
        for key, item in list(self.active.items()):
            until = item.get("ticker_until")
            eligible = item.get("ticker_eligible", True)
            if until:
                try:
                    eligible = eligible and datetime.fromisoformat(until).astimezone(timezone.utc) > now
                except ValueError:
                    pass
            reminder = item.get("next_reminder_at")
            if reminder:
                try:
                    if datetime.fromisoformat(reminder).astimezone(timezone.utc) <= now:
                        eligible = True
                        item["ticker_until"] = (now + timedelta(minutes=10)).isoformat()
                        item["last_ticker_at"] = now.isoformat()
                        item["next_reminder_at"] = (now + timedelta(minutes=45)).isoformat()
                except ValueError:
                    pass
            item["ticker_eligible"] = eligible
            if eligible and self._entity_publish_enabled(item.get("entity_id")):
                self.ticker[key] = item
            else:
                self.ticker.pop(key, None)
        for key, item in list(self.ticker.items()):
            until = item.get("ticker_until")
            if not item.get("ticker_eligible", True) or not until:
                self.ticker.pop(key, None)
                continue
            try:
                if datetime.fromisoformat(str(until).replace("Z", "+00:00")).astimezone(timezone.utc) <= now:
                    self.ticker.pop(key, None)
            except ValueError:
                self.ticker.pop(key, None)
        enabled = set(normalize_providers(self.options.get("enabled_providers")))
        dedup = self.options.get("deduplicate_by_entity", True)
        active = self._filter_collection(
            [self._compact_item(item) for item in self.active.values()],
            enabled,
            dedup,
        )
        order = {"critical": 0, "attention": 1, "activity": 2, "normal": 3}
        ticker = self._filter_collection(
            [self._compact_item(item) for item in sorted(
                self.ticker.values(),
                key=lambda item: (
                    order.get(item.get("priority"), 3),
                    item.get("created_at") or item.get("resolved_at") or "",
                ),
            )],
            enabled,
            dedup,
        )
        current, upcoming, insights = self._build_streams(active)
        status = self._build_status_items() if self.options.get("publish_status", True) else []
        raw_counts = (len(current), len(upcoming), len(insights), len(status))
        current = self._filter_collection(current, enabled, dedup)
        order = {"critical": 0, "attention": 1, "activity": 2, "normal": 3}
        _LOGGER.debug("Home Status live normalized active items: %s", active)
        _LOGGER.debug("Home Status current candidates before sorting: %s", current)
        current.sort(key=lambda item: (
            order.get(item.get("priority"), 3),
            item.get("timestamp") or "",
        ))
        _LOGGER.debug("Home Status sorted current candidates: %s", current)
        selected_current = current[0] if current else None
        _LOGGER.debug("Home Status selected current item: %s", selected_current)
        priority_items = [*active, *current]
        priority = "critical" if any(item.get("priority") == "critical" for item in priority_items) else "attention" if any(item.get("priority") == "attention" for item in priority_items) else "activity" if any(item.get("priority") == "activity" for item in priority_items) else "normal"
        _LOGGER.debug("Home Status final overall priority: %s", priority)
        upcoming = self._filter_collection(upcoming, enabled, dedup)[:int(self.options.get("max_upcoming_items", 10))]
        insights = self._filter_collection(insights, enabled, dedup)
        status = self._filter_collection(status, enabled, dedup)
        hero, sidebar, footer = self._route_streams(ticker, current, upcoming, insights, status)
        pilot_footer = ContactFooterPresentationAdapter.build_items(
            self._timeline.events,
            self._conversation_policy.decisions,
            self._conversation_ledger.records,
            datetime.now(timezone.utc),
            enabled=bool(
                self.options.get(CONF_CONTACT_FOOTER_PILOT, False)
            ),
        )
        footer = ContactFooterPresentationAdapter.merge_footer(
            footer, pilot_footer
        )
        recent = self._filter_collection(
            [self._compact_item(item) for item in self.history],
            enabled,
            dedup,
        )[:int(self.options.get("max_recent_items", 10))]
        _LOGGER.debug("Home Status final hero items: %s", [
            {**item, "origin": "live_state"} for item in hero
        ])
        if self.options.get("debug_logging", False):
            _LOGGER.debug("Home Status collections: raw current=%d upcoming=%d insights=%d status=%d; final current=%d upcoming=%d insights=%d status=%d", *raw_counts, len(current), len(upcoming), len(insights), len(status))
        try:
            hero_rotation_seconds = max(
                1, min(120, int(self.options.get("hero_rotation_seconds", 4)))
            )
        except (TypeError, ValueError):
            hero_rotation_seconds = 4
        self.async_set_updated_data({
            "health": priority,
            "weather_visual_effect": self._current_weather_visual_effect(),
            "active_count": len(active),
            "diagnostic_count": 0,
            "last_updated": self._now(),
            "active": active,
            "ticker": ticker,
            "priority": priority,
            "alarm_state": alarm_state,
            "source_entities": resolved_sources,
            "missing_source_entities": missing_sources,
            "resolved_contact_sources": resolved_contacts,
            "open_contact_sources": open_contacts,
            "recent": recent,
            "history_entities": list(self._direct_history_entities),
            "current": current,
            "upcoming": upcoming,
            "insights": insights[:int(self.options.get("max_insight_items", 10))] if self.options.get("enable_insights", True) else [],
            "status": status,
            "hero": hero,
            "sidebar": sidebar,
            "footer": footer,
            "display": {
                "hero_rotation_seconds": hero_rotation_seconds,
                "media_enabled": self.options.get("media_enabled", True),
            },
            "provider_contract": list(SUPPORTED_PROVIDERS),
        })

    def _retained_history(self, events: list[dict]) -> list[dict]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=max(1, int(self.options.get("history_retention_days", 7))))
        retained = []
        for event in events or []:
            if event.get("event_type") == "exterior_lighting":
                continue
            stamp = event.get("resolved_at") or event.get("created_at")
            try:
                if stamp and datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone(timezone.utc) < cutoff:
                    continue
            except ValueError:
                pass
            retained.append(event)
        return retained[:200]

    @staticmethod
    def _filter_collection(items: list[dict], enabled: set[str], dedup: bool = True) -> list[dict]:
        seen = set()
        result = []
        for item in items:
            provider = normalize_provider(item.get("provider") or item.get("category") or item.get("source"))
            if provider is None or provider not in enabled:
                continue
            key = item.get("id") or f"{item.get('entity_id')}|{item.get('title')}|{item.get('timestamp')}"
            if dedup and key in seen:
                continue
            if dedup:
                seen.add(key)
            result.append(item)
        return result

    @staticmethod
    def _deduplicate_stream(items: list[dict]) -> list[dict]:
        seen = set()
        result = []
        for item in items:
            key = item.get("id") or (item.get("provider"), item.get("title"), item.get("summary"))
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
        return result

    def _route_streams(self, ticker, current, upcoming, insights, status):
        hero = []
        for item in ticker:
            exclusion_reason = None
            if item.get("hero_eligible") is False:
                exclusion_reason = "hero_eligible_false"
            elif item.get("priority") not in {"critical", "attention"}:
                exclusion_reason = "priority_not_attention_worthy"
            if exclusion_reason:
                if item.get("entity_id") in self._sources("contact_sensors"):
                    _LOGGER.debug("Home Status contact excluded from hero: entity_id=%s reason=%s item=%s", item.get("entity_id"), exclusion_reason, item)
                continue
            entity_id = item.get("entity_id", "")
            if entity_id == "switch.sprinklers_rain_delay":
                continue
            state = str(item.get("state", "")).lower()
            if entity_id == ALARM_ENTITY and state not in {"pending", "triggered"}:
                continue
            hero.append(item)
        # Awareness sources use the existing right-side rotation. They remain
        # normal items and immediately yield to attention-worthy live events.
        if not hero:
            hero.extend(
                item for item in current
                if item.get("event_type") == "source_update"
            )
        hero_ids = {
            value
            for item in hero
            for value in (item.get("id"), item.get("entity_id"))
            if value
        }
        sidebar = [
            item for item in [*current, *status, *upcoming]
            if item.get("id") not in hero_ids
            and item.get("entity_id") not in hero_ids
            and item.get("category") != "contact"
            and item.get("source") != "filter_maintenance"
            and item.get("source") != "water_leak"
            and item.get("source") != "hvac_short_cycle"
            and item.get("source") not in {
                "refrigerator_door_alert",
                "refrigerator_temperature_alert",
                "appliance_maintenance",
                "appliance_near_complete",
            }
        ]
        alarm_status = next(
            (item for item in status if item.get("entity_id") == ALARM_ENTITY),
            next((item for item in current if item.get("entity_id") == ALARM_ENTITY), None),
        )
        footer = []
        for item in [*current, *upcoming, *insights, *status]:
            if item.get("id") in hero_ids or item.get("entity_id") in hero_ids:
                continue
            provider = normalize_provider(
                item.get("provider") or item.get("category") or item.get("source")
            )
            if provider == PROVIDER_CLIMATE and item.get("priority") == "normal":
                # Routine climate conditions belong in the sidebar.
                continue
            if (
                provider == PROVIDER_WEATHER
                and item.get("priority") == "normal"
                and not str(item.get("id") or "").startswith(
                    "current:weather:"
                )
            ):
                # Current weather is useful compact footer context, while
                # forecast details remain sidebar-only.
                continue
            if item.get("category") == "contact":
                continue
            if item.get("source") == "water_leak":
                continue
            if item.get("source") in {
                "refrigerator_door_alert",
                "refrigerator_temperature_alert",
                "appliance_cycle",
                "sprinkler_watering",
                "camera_offline",
                "family_presence",
                "system_updates",
                "hvac_diagnostic_recovery",
            }:
                continue
            if (
                item.get("source") == "recent"
                and item.get("category") in {"contact", "security"}
                and item.get("priority") == "normal"
            ):
                continue
            if item.get("entity_id") == ALARM_ENTITY:
                # Alarm state is a live status, never a historical ticker event.
                continue
            footer.append(item)
        alarm_entity_state = self.hass.states.get(ALARM_ENTITY)
        alarm_value = str(
            getattr(alarm_entity_state, "state", "")
        ).casefold()
        if (
            alarm_status is not None
            and alarm_status.get("id") not in hero_ids
            and alarm_value != "disarmed"
        ):
            footer.append(alarm_status)
        hero = self._deduplicate_stream(hero)
        sidebar = self._deduplicate_stream(sidebar)
        footer = self._deduplicate_stream(footer)
        _LOGGER.debug("Home Status contact hero output: %s", [item for item in hero if item.get("entity_id") in self._sources("contact_sensors")])
        return hero, sidebar, footer

    def _stream_item(self, item_id: str, title: str, summary: str, category: str,
                     icon: str, priority: str = "normal", timestamp: str | None = None,
                     expires_at: str | None = None, entity_id: str | None = None,
                     source: str = "home_status", rich: dict | None = None) -> dict:
        item = {
            "id": item_id, "title": title, "summary": summary,
            "category": category, "provider": category, "icon": icon, "priority": priority,
            "timestamp": timestamp, "expires_at": expires_at,
            "entity_id": entity_id, "navigation": self._navigation_for(category, entity_id), "source": source,
        }
        if rich:
            # Providers may publish rich content without changing the stream contract.
            for key in ("title", "subtitle", "body", "media_url", "media_type", "visual_effect", "source", "action", "expires_at"):
                if rich.get(key) not in (None, ""):
                    item[key] = rich[key]
            item["summary"] = item.get("body") or item.get("summary")
            action = rich.get("action")
            if isinstance(action, str) and (action.startswith("/") or action.startswith("http://") or action.startswith("https://")):
                item["navigation"] = action
        return item

    def _navigation_for(self, provider: str, entity_id: str | None) -> str | None:
        """Return a configured path only when navigation is enabled and usable."""
        if not self.options.get("navigation_enabled", True):
            return None
        navigation_key = provider
        if (
            entity_id in self._sources("sprinkler_schedule")
            or entity_id in self._sources("sprinkler_valves")
        ):
            navigation_key = "sprinklers"
        elif entity_id in self._sources("waste_schedule"):
            navigation_key = "waste"
        if navigation_key not in NAVIGATION_TARGETS:
            navigation_key = provider
        target = self.options.get(f"navigation_{navigation_key}")
        if target is None and navigation_key != provider:
            target = self.options.get(f"navigation_{provider}")
        if target is None:
            target = "none"
        if target == "none" or target == "entity":
            return None
        if target == "custom":
            target = self.options.get(
                f"navigation_custom_{navigation_key}", ""
            )
        return target if isinstance(target, str) and target.startswith("/") else None

    @staticmethod
    def _compact_item(item: dict) -> dict:
        compact = {
            key: item.get(key)
            for key in (
                "id", "title", "message", "summary", "detail", "headline",
                "category", "provider", "icon", "priority", "active", "state",
                "source", "event_type", "hero_eligible", "persistent",
                "ticker_eligible", "created_at",
                "resolved_at", "expires_at", "entity_id", "ticker_eligible",
                "media_url", "media_type", "navigation",
                "subtitle", "body", "visual_effect", "source", "action",
            )
            if item.get(key) is not None and key not in {"detail", "headline"}
        }
        if "summary" not in compact:
            summary = item.get("headline") or item.get("detail")
            if summary:
                compact["summary"] = summary
        for key in ("title", "message", "summary", "detail", "headline"):
            if isinstance(compact.get(key), str):
                compact[key] = compact[key].replace("Alarmo", "Home Security")
        entity_id = str(compact.get("entity_id") or "").lower()
        if ("moisture" in entity_id or "leak" in entity_id) and compact.get("active") is True:
            raw_name = str(compact.get("message") or compact.get("title") or entity_id)
            location = HomeStatusCoordinator._moisture_location(raw_name)
            compact["message"] = f"{location} Leak"
            compact["summary"] = "Water detected"
            compact["icon"] = "mdi:water-alert"
        return compact

    def _build_streams(self, active: list[dict]) -> tuple[list[dict], list[dict], list[dict]]:
        current: list[dict] = []
        upcoming: list[dict] = []
        insights: list[dict] = []
        represented = {item.get("entity_id") for item in active}

        for item in active:
            if item.get("entity_id") == "switch.sprinklers_rain_delay":
                # Rain delay has a dedicated status item below. Publishing the
                # generic active copy as well creates two footer entries.
                continue
            current.append(self._stream_item(
                item.get("id", "active"), item.get("message", "Home alert"),
                item.get("headline") or item.get("summary")
                or item.get("detail", ""), item.get("category", "home"),
                item.get("icon", "mdi:alert"), item.get("priority", "normal"),
                item.get("created_at"), item.get("expires_at"), item.get("entity_id"),
                item.get("event_type", "home_status"),
            ))

        # Adapter output is already normalized. Keeping it in the same current
        # stream lets the card decide presentation without source-specific UI.
        current.extend(dict(item) for item in self._source_items)

        for entity_id in self._resolved_source_ids():
            if entity_id not in self._resolved_source_ids():
                continue
            if (
                entity_id in self._sources("refrigerator_doors")
                or entity_id in self._sources("refrigerator_temperatures")
                or entity_id in self._sources("laundry_state")
                or entity_id in self._sources("laundry_remaining")
                or entity_id in self._sources("appliance_maintenance")
                or entity_id in self._sources("sprinkler_valves")
                or entity_id in self._sources("system_updates")
            ):
                # These sources have dedicated sustained-condition producers.
                # The generic state path would bypass their safety delays.
                continue
            state = self.hass.states.get(entity_id)
            if not state or state.state in ("unknown", "unavailable") or entity_id in represented:
                continue
            if entity_id in self._sources("news_sources"):
                attributes = state.attributes
                headline = str(attributes.get("headline") or attributes.get("title") or state.state).strip()
                detail = str(attributes.get("summary") or attributes.get("description") or attributes.get("source") or "News update").strip()
                if headline and headline.lower() not in {"unknown", "unavailable"}:
                    current.append(self._stream_item(
                        f"news:{entity_id}:{headline}", headline, detail,
                        PROVIDER_NEWS, "mdi:newspaper-variant-outline", "normal",
                        state.last_changed.isoformat(), entity_id=entity_id, source=PROVIDER_NEWS,
                        rich={
                            "title": headline,
                            "subtitle": attributes.get("subtitle") or attributes.get("source") or "News",
                            "body": detail,
                            "media_url": attributes.get("media_url") or attributes.get("image_url") or attributes.get("thumbnail"),
                            "media_type": attributes.get("media_type") or ("image" if attributes.get("image_url") or attributes.get("thumbnail") else None),
                            "action": attributes.get("action") or attributes.get("url") or attributes.get("link"),
                            "expires_at": attributes.get("expires_at"),
                        },
                    ))
                    current[-1]["event_type"] = "source_update"
                    current[-1]["hero_eligible"] = True
                continue
            is_active = self._is_entity_current(entity_id, state.state)
            if is_active:
                title, summary = self._clean_entity_label(entity_id, state)
                current.append(self._stream_item(
                    f"current:{entity_id}", title, summary,
                    "security" if "door" in entity_id or "alarm" in entity_id else "home",
                    "mdi:alert", "critical" if "fault" in entity_id or "moisture" in entity_id else "attention",
                    state.last_changed.isoformat(), entity_id=entity_id, source="entity",
                ))

        for entity_id in self._sources("climate_temperature"):
            state = self.hass.states.get(entity_id)
            if not state or state.state in ("unknown", "unavailable"):
                continue
            try:
                float(state.state)
            except (TypeError, ValueError):
                continue
            unit = str(state.attributes.get("unit_of_measurement") or "").strip()
            current.append(self._stream_item(
                f"current:climate:{entity_id}",
                "Indoor Temperature",
                f"{state.state}{unit}",
                PROVIDER_CLIMATE,
                "mdi:home-thermometer-outline",
                "normal",
                state.last_changed.isoformat(),
                entity_id=entity_id,
                source=PROVIDER_CLIMATE,
            ))

        presence = self._build_presence_status_item()
        if presence is not None:
            current.append(presence)

        nws_entity = self._sources("weather_alert")[0] if self._sources("weather_alert") else None
        nws = self.hass.states.get(nws_entity) if nws_entity else None
        if self.options.get("include_nws_alerts", True) and nws and nws.state not in ("unknown", "unavailable") and nws_entity not in represented:
            for alert in nws.attributes.get("Alerts", []) or []:
                if not isinstance(alert, dict):
                    continue
                title = str(alert.get("Event") or "Weather Alert")
                stable = alert.get("ID") or alert.get("id") or f"{title}|{alert.get('Expires', '')}"
                upcoming.append(self._stream_item(
                    f"upcoming:weather:{stable}", title,
                    self._clean_weather_headline(
                        alert.get("Headline")
                        or alert.get("Description")
                        or "",
                        title,
                    ),
                    "weather", "mdi:weather-alert", "attention", alert.get("Effective"),
                    alert.get("Expires"), nws_entity, "weather",
                ))

        forecast_entity = self._resolve_forecast_entity()
        weather = self.hass.states.get(forecast_entity) if forecast_entity else None
        if weather and weather.state not in ("unknown", "unavailable"):
            attrs = weather.attributes
            condition = str(weather.state or "").replace("-", " ").title()
            temperature = attrs.get("temperature")
            details = []
            if temperature is not None:
                details.append(f"{temperature}°")
            if condition:
                details.append(condition)
            visuals = self._weather_visuals(condition)
            current.append(self._stream_item(
                f"current:weather:{forecast_entity}", "Weather",
                " • ".join(details) or "Weather available",
                "weather", "mdi:weather-partly-cloudy", "normal",
                weather.last_changed.isoformat(), entity_id=forecast_entity, source="weather", rich=visuals,
            ))
        for index, day in enumerate(self._forecast[:1]):
            if not isinstance(day, dict):
                continue
            period = day.get("datetime") or day.get("date")
            label = "Today's Forecast" if index == 0 else "Forecast"
            condition = str(day.get("condition") or "").replace("-", " ").title()
            high = day.get("temperature")
            visuals = self._weather_visuals(condition)
            low = day.get("templow")
            temperature = f"{high}°" if high is not None else ""
            if low is not None:
                temperature += f" / {low}°"
            summary = " • ".join(value for value in (temperature, condition) if value) or "Forecast available"
            upcoming.append(self._stream_item(
                    f"upcoming:forecast:{period or index}", label, summary,
                "weather", "mdi:weather-partly-cloudy", "normal", period,
                entity_id=forecast_entity, source="weather", rich=visuals,
            ))

        for entity_id in self._sources("family_calendar"):
            state = self.hass.states.get(entity_id)
            if not state or state.state in ("unknown", "unavailable", "none"):
                continue
            attributes = state.attributes
            event_title = str(attributes.get("message") or "").strip()
            event_start = attributes.get("start_time")
            if not event_title or not event_start:
                continue
            event_summary = self._format_calendar_event(state)
            event_id = f"upcoming:{entity_id}:{event_start}"
            upcoming.append(self._stream_item(
                event_id,
                event_title,
                event_summary,
                self.registry.provider_for("family_calendar") or PROVIDER_SCHEDULE,
                "mdi:calendar-clock",
                "normal",
                str(event_start),
                entity_id=entity_id,
                source="family_calendar",
            ))
            upcoming[-1]["event_type"] = "calendar_event"

        schedule_sources = []
        if self.options.get("include_sprinkler_schedule", True):
            sprinkler_provider = (
                self.registry.provider_for("sprinkler_schedule")
                or PROVIDER_SCHEDULE
            )
            schedule_sources.extend(
                (
                    entity_id,
                    "Next watering",
                    "mdi:sprinkler",
                    sprinkler_provider,
                    None,
                )
                for entity_id in self._sources("sprinkler_schedule")
                if "watering" in entity_id
            )
        if self.options.get("include_waste_collection", True):
            waste_labels = {
                "sensor.waste_collection_schedule_garbage": (
                    "Garbage pickup",
                    "mdi:trash-can",
                ),
                "sensor.waste_collection_schedule_recycling": (
                    "Recycling pickup",
                    "mdi:recycle",
                ),
                "sensor.waste_collection_schedule_yard_waste": (
                    "Yard waste pickup",
                    "mdi:leaf",
                ),
            }
            waste_provider = (
                self.registry.provider_for("waste_schedule")
                or PROVIDER_SCHEDULE
            )
            for entity_id in self._sources("waste_schedule"):
                state = self.hass.states.get(entity_id)
                if not state:
                    continue
                collection_date = self._waste_collection_date(state)
                due_soon = self._waste_collection_is_due(state)
                if not due_soon and collection_date is None:
                    continue
                title, icon = waste_labels.get(
                    entity_id, ("Waste pickup", "mdi:trash-can")
                )
                summary = (
                    None
                    if due_soon
                    else collection_date.strftime(
                        "%A, %B %d"
                    ).replace(" 0", " ")
                )
                schedule_sources.append(
                    (
                        entity_id,
                        title,
                        icon,
                        waste_provider,
                        summary,
                    )
                )
        for entity_id, title, icon, provider, summary_override in schedule_sources:
            state = self.hass.states.get(entity_id)
            if state and state.state not in ("unknown", "unavailable", "none"):
                summary = (
                    summary_override
                    or self._format_schedule_value(state.state)
                )
                upcoming.append(self._stream_item(
                    f"upcoming:{entity_id}", title, summary, provider, icon,
                    "normal", state.last_changed.isoformat(), entity_id=entity_id, source=entity_id,
                ))

        for state_entity, config in APPLIANCE_CYCLES.items():
            machine_state = self.hass.states.get(state_entity)
            if not machine_state or self._build_appliance_cycle_item(
                state_entity, machine_state
            ) is None:
                continue
            remaining_entity = config["remaining"]
            remaining_state = self.hass.states.get(remaining_entity)
            minutes = self._remaining_minutes(remaining_state)
            if minutes is not None and 0 < minutes <= 15:
                rounded = max(1, round(minutes))
                upcoming.append(self._stream_item(
                    f"upcoming:appliance:{state_entity}",
                    f"{config['name']} nearly finished",
                    f"About {rounded} minutes remaining",
                    PROVIDER_LAUNDRY, "mdi:timer-sand", "activity",
                    remaining_state.last_changed.isoformat(),
                    entity_id=state_entity,
                    source="appliance_near_complete",
                ))

        seen_insights: set[str] = set()
        for item in self.history:
            if item.get("entity_id") == "switch.sprinklers_rain_delay":
                # Legacy rain-delay events may still exist in stored history.
                # The dedicated live status is the only marquee representation.
                continue
            if item.get("active") is False:
                if item.get("source") == "direct_history":
                    stamp = item.get("resolved_at") or item.get("created_at")
                    try:
                        event_time = datetime.fromisoformat(
                            str(stamp).replace("Z", "+00:00")
                        ).astimezone(timezone.utc)
                    except (TypeError, ValueError):
                        continue
                    if datetime.now(timezone.utc) - event_time > timedelta(hours=1):
                        continue
                source_id = item.get("entity_id") or item.get("id", "event")
                collapse_item = (
                    item.get("source") == "direct_history"
                    or self.options.get("collapse_repeated_events", True)
                )
                if collapse_item and source_id in seen_insights:
                    continue
                if collapse_item:
                    seen_insights.add(source_id)
                history_title = item.get("message", "Recent event")
                if item.get("source") == "direct_history":
                    history_title = self._plain_entity_name(
                        item.get("entity_id", ""), history_title
                    )
                history_source = (
                    "direct_history"
                    if item.get("source") == "direct_history"
                    else "water_leak_cleared"
                    if item.get("event_type") == "water_leak"
                    else "refrigerator_safety_cleared"
                    if str(item.get("event_type") or "").startswith(
                        "refrigerator_"
                    )
                    else "appliance_lifecycle_cleared"
                    if item.get("event_type") in {
                        "appliance_cycle", "appliance_maintenance",
                    }
                    else "sprinkler_watering_complete"
                    if item.get("event_type") == "sprinkler_watering"
                    else "camera_health_restored"
                    if item.get("event_type") == "camera_offline"
                    else "system_updates_complete"
                    if item.get("event_type") == "system_updates"
                    else "hvac_diagnostic_recovery"
                    if item.get("event_type") == "hvac_diagnostic"
                    else "recent"
                )
                insights.append(self._stream_item(
                    f"insight:{item.get('id', 'event')}:{item.get('resolved_at', '')}",
                    history_title, item.get("detail", "Recently resolved"),
                    item.get("category", "home"), item.get("icon", "mdi:history"),
                    "normal", item.get("resolved_at"), entity_id=item.get("entity_id"),
                    source=history_source,
                ))
        return current, upcoming, insights[:int(self.options.get("max_insight_items", 10))]

    def _build_status_items(self) -> list[dict]:
        status: list[dict] = []
        contact_sources = self._sources("contact_sensors")
        status_entities = (ALARM_ENTITY, *self._sources("alarm_panel"), *self._sources("contact_sensors"), *tuple(
            entity_id for entity_id in self._sources("sprinkler_schedule")
            if entity_id.startswith("switch.")
        ))
        entities = tuple(dict.fromkeys(status_entities))
        open_contacts = set()
        for entity_id in contact_sources:
            state = self.hass.states.get(entity_id)
            if state and state.state == "on":
                open_contacts.add(entity_id)
        for entity_id in entities:
            state = self.hass.states.get(entity_id)
            if not state or state.state in ("unknown", "unavailable"):
                continue
            name = self._plain_entity_name(
                entity_id, state.attributes.get("friendly_name")
            )
            override = self.options.get("entity_overrides", {}).get(entity_id, {})
            if override.get("publish_mode") in {"events", "disabled"}:
                continue
            value = str(state.state).lower()
            if entity_id == ALARM_ENTITY and value not in ALARM_STATES:
                continue
            if entity_id == "alarm_control_panel.alarmo":
                alarm_labels = {
                    "disarmed": ("Alarm Off", "Your home is not protected."),
                    "armed_home": ("Alarm On", "Your home is protected."),
                    "armed_away": ("Alarm On", "Your home is protected."),
                    "armed_night": ("Alarm On", "Your home is protected."),
                    "arming": ("Alarm Starting", "Leave before the countdown ends."),
                    "pending": ("Entry Delay", "Disarm the alarm before time expires."),
                    "triggered": ("🚨 Security Alert!", "Alarm has been triggered."),
                }
                title, summary = alarm_labels.get(value, ("Alarm Status", "Alarm status unavailable."))
                icon = "mdi:shield-check" if value == "disarmed" else "mdi:shield-alert"
                category = "security"
            elif (entity_id in contact_sources
                  and entity_id.split(".", 1)[0] == "binary_sensor"
                  and self._behavior("binary_sensor", state.attributes.get("device_class")) == "contact"):
                clean_name = name
                is_open = value in {"on", "open", "opening"}
                if not is_open:
                    continue
                title = f"{clean_name} {'Open' if is_open else 'Closed'}"
                summary = f"{clean_name} is {'open' if is_open else 'closed'}"
                icon = "mdi:door-open" if is_open else "mdi:door-closed"
                category = "security"
            elif entity_id == "switch.sprinklers_rain_delay":
                if value != "on":
                    # An inactive rain delay is the absence of a condition,
                    # not useful persistent ticker content.
                    continue
                title, summary, icon, category = "Rain Delay", "On" if value == "on" else "Off", "mdi:sprinkler", PROVIDER_SCHEDULE
            else:
                # Only Alarmo and the sprinkler switch produce status items.
                # Sensor-based schedules are emitted by _build_streams only.
                continue
            if not self.options.get("include_healthy_status", True) and entity_id != ALARM_ENTITY and value not in {"on", "open", "opening", "triggered", "pending", "arming", "disarming"}:
                continue
            title = override.get("label_override") or title
            icon = override.get("icon_override") or icon
            category = override.get("provider_override") or category
            computed_priority = "normal" if entity_id == "switch.sprinklers_rain_delay" else "critical" if value == "triggered" else "attention" if value in {"armed_home", "armed_away", "armed_night", "arming", "pending", "on", "open", "opening"} else "normal"
            status_priority = override.get("priority_override") or computed_priority
            _LOGGER.debug(
                "Home Status item: id=%s provider=%s computed=%s override=%s final=%s publish_mode=%s",
                f"status:{entity_id}", category, computed_priority,
                override.get("priority_override"), status_priority,
                override.get("publish_mode") or "status",
            )
            status.append(self._stream_item(
                f"status:{entity_id}", title, summary, category, icon, status_priority,
                state.last_changed.isoformat(), entity_id=entity_id, source="status",
            ))
        return status

    @staticmethod
    def _clean_entity_label(entity_id: str, state: State) -> tuple[str, str]:
        name = HomeStatusCoordinator._plain_entity_name(
            entity_id, state.attributes.get("friendly_name")
        )
        if entity_id == "switch.sprinklers_rain_delay":
            return "Rain Delay Active", "Sprinkler watering is delayed"
        if entity_id == "alarm_control_panel.alarmo":
            value = str(state.state).replace("_", " ")
            labels = {
                "disarmed": ("Alarm Off", "Your home is not protected."),
                "armed home": ("Alarm On", "Your home is protected."),
                "armed away": ("Alarm On", "Your home is protected."),
                "armed night": ("Alarm On", "Your home is protected."),
                "arming": ("Alarm Starting", "Leave before the countdown ends."),
                "pending": ("Entry Delay", "Disarm the alarm before time expires."),
                "triggered": ("🚨 Security Alert!", "Alarm has been triggered."),
            }
            return labels.get(value, ("Alarm Status", "Alarm status unavailable."))
        if "door" in entity_id:
            return f"{name} Open", f"{name} is open"
        return str(name), f"{name} is {str(state.state).replace('_', ' ')}"

    @staticmethod
    def _format_calendar_event(state: State) -> str:
        """Format the current or next calendar event for the schedule stream."""
        attributes = state.attributes
        start_value = attributes.get("start_time")
        end_value = attributes.get("end_time")
        all_day = bool(attributes.get("all_day"))
        location = str(attributes.get("location") or "").strip()
        now = dt_util.now()

        def parse_local(value):
            parsed = dt_util.parse_datetime(str(value)) if value else None
            if parsed is None and value:
                try:
                    parsed = datetime.fromisoformat(
                        str(value).replace("Z", "+00:00")
                    )
                except (TypeError, ValueError):
                    return None
            if parsed is None:
                return None
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt_util.DEFAULT_TIME_ZONE)
            return dt_util.as_local(parsed)

        start = parse_local(start_value)
        end = parse_local(end_value)

        if start is None:
            when = "Scheduled"
        elif all_day:
            if start.date() == now.date():
                when = "Today • All day"
            elif start.date() == (now + timedelta(days=1)).date():
                when = "Tomorrow • All day"
            else:
                when = f"{start.strftime('%A, %B %d').replace(' 0', ' ')} • All day"
        elif state.state == "on":
            when = (
                f"Now • Until {end.strftime('%I:%M %p').lstrip('0')}"
                if end is not None
                else "Happening now"
            )
        else:
            clock = start.strftime("%I:%M %p").lstrip("0")
            if start.date() == now.date():
                when = f"Today at {clock}"
            elif start.date() == (now + timedelta(days=1)).date():
                when = f"Tomorrow at {clock}"
            else:
                date_label = start.strftime("%A, %B %d").replace(" 0", " ")
                when = f"{date_label} at {clock}"

        return " • ".join(part for part in (when, location) if part)

    @staticmethod
    def _format_schedule_value(value: str) -> str:
        try:
            date = datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone()
            return date.strftime("%A at %I:%M %p").replace(" at 0", " at ")
        except (TypeError, ValueError):
            return str(value)

    @staticmethod
    def _waste_collection_is_due(state: State) -> bool:
        """Return true only for a collection due today or tomorrow."""
        collection_date = HomeStatusCoordinator._waste_collection_date(state)
        if collection_date is None:
            return False
        today = datetime.now().astimezone().date()
        return 0 <= (collection_date - today).days <= 1

    @staticmethod
    def _waste_collection_date(state: State):
        """Return a valid next collection date from state or attributes."""
        value = str(state.state or "").strip()
        lowered = value.lower()
        if lowered in {"unknown", "unavailable", "none", ""}:
            return None
        today = datetime.now().astimezone().date()
        if re.search(r"\btoday\b", lowered):
            return today
        if re.search(r"\btomorrow\b", lowered):
            return today + timedelta(days=1)
        days_match = re.search(
            r"\b(?:in\s+)?(-?\d+)\s+days?\b", lowered
        )
        if days_match:
            days = int(days_match.group(1))
            return today + timedelta(days=days) if days >= 0 else None

        for key in ("days_until", "days_to", "days"):
            raw_days = state.attributes.get(key)
            try:
                days = int(raw_days)
                return today + timedelta(days=days) if days >= 0 else None
            except (TypeError, ValueError):
                continue

        candidates = [
            value,
            *(
                state.attributes.get(key)
                for key in (
                    "date",
                    "next_date",
                    "next_collection",
                    "collection_date",
                )
            ),
        ]
        for candidate in candidates:
            if candidate in (None, ""):
                continue
            candidate_value = re.sub(
                r"^\s*on\s+",
                "",
                str(candidate),
                flags=re.IGNORECASE,
            )
            try:
                collection = datetime.fromisoformat(
                    candidate_value.replace("Z", "+00:00")
                )
                if collection.tzinfo is not None:
                    collection_date = collection.astimezone().date()
                else:
                    collection_date = collection.date()
            except (TypeError, ValueError):
                try:
                    collection_date = datetime.strptime(
                        candidate_value,
                        "%Y-%m-%d",
                    ).date()
                except (TypeError, ValueError):
                    try:
                        collection_date = datetime.strptime(
                            candidate_value,
                            "%a, %d.%m.%Y",
                        ).date()
                    except (TypeError, ValueError):
                        continue
            return collection_date if collection_date >= today else None
        return None

    @staticmethod
    def _is_entity_current(entity_id: str, value: str) -> bool:
        value = str(value).lower()
        if entity_id.startswith("alarm_control_panel."):
            return value in {"triggered", "pending", "arming", "disarming"}
        if "laundry_machine_state" in entity_id or entity_id == "sensor.dishwasher_current_status":
            return value not in {"off", "idle", "complete", "completed", "power_off"}
        return value in {"on", "open", "opening", "wet", "moisture", "detected", "triggered"}

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
