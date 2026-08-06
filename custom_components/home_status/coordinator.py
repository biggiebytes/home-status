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
    STARTUP_AVAILABILITY_RECOVERY_SUPPRESSION_SECONDS,
    SUPPORTED_PROVIDERS,
    SYSTEM_UPDATES,
    normalize_provider,
    normalize_provider_options,
    normalize_providers,
    plain_entity_name,
)
from .providers import (
    CapabilityProviderRegistry,
    WeatherProviderMixin,
    SecurityProviderMixin,
    MaintenanceProviderMixin,
    LaundryProviderMixin,
    ClimateProviderMixin,
    ScheduleProviderMixin,
    CameraProviderMixin,
    FamilyProviderMixin,
)
from .source_registry import SourceRegistry
from .source_adapters import (
    CONF_NEWS_FEEDS,
    RSSSourceAdapter,
    RSSSourceDefinition,
    normalize_news_feeds,
)
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


class HomeStatusCoordinator(
    WeatherProviderMixin,
    SecurityProviderMixin,
    MaintenanceProviderMixin,
    LaundryProviderMixin,
    ClimateProviderMixin,
    ScheduleProviderMixin,
    CameraProviderMixin,
    FamilyProviderMixin,
    DataUpdateCoordinator[dict]
):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN)
        self.entry = entry
        self.options = normalize_provider_options({**entry.data, **entry.options})
        self.options["enabled_providers"] = normalize_providers(self.options.get("enabled_providers"))
        self.entity_ids = list(self.options.get(CONF_ENTITIES, self.options.get(CONF_ENTITY_IDS, [])))
        self.registry = SourceRegistry.from_config(self.options.get("source_entities", self.entity_ids))
        self.capability_registry = CapabilityProviderRegistry()
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
        self._calendar_items: list[dict] = []
        self._condition_since: dict[str, datetime] = {}
        self._source_items: list[dict] = []
        self._source_adapters: tuple[RSSSourceAdapter, ...] = ()
        self._suppress_availability_recoveries_until = (
            datetime.now(timezone.utc)
            + timedelta(
                seconds=STARTUP_AVAILABILITY_RECOVERY_SUPPRESSION_SECONDS
            )
        )
        self._configure_source_adapters()

    async def async_setup(self) -> None:
        updated_options = normalize_provider_options(dict(self.entry.options))
        if updated_options != dict(self.entry.options):
            self.hass.config_entries.async_update_entry(self.entry, options=updated_options)
        configured_sources = self.options.get("source_entities")
        merged_sources = list(self.registry.all())
        if not isinstance(configured_sources, dict) and configured_sources != merged_sources:
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
        await self._async_refresh_calendar_events()
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

    def _configure_source_adapters(self) -> bool:
        """Apply configured news feeds and report whether they changed."""
        definitions = tuple(
            RSSSourceDefinition(
                key=feed["key"],
                name=feed["name"],
                url=feed["url"],
                provider=PROVIDER_NEWS,
                icon=feed["icon"],
                refresh_minutes=feed["refresh_minutes"],
                max_items=feed["max_items"],
            )
            for feed in normalize_news_feeds(
                self.options.get(CONF_NEWS_FEEDS)
            )
            if feed["enabled"]
        )
        if definitions == tuple(
            adapter.definition for adapter in self._source_adapters
        ):
            return False
        for adapter in self._source_adapters:
            adapter.destroy()
        self._source_adapters = tuple(
            RSSSourceAdapter(definition) for definition in definitions
        )
        self._source_items = []
        return True

    @callback
    def async_update_entities(self, entity_ids: list[str]) -> None:
        self.options = normalize_provider_options({**self.entry.data, **self.entry.options})
        self.options["enabled_providers"] = normalize_providers(self.options.get("enabled_providers"))
        self.registry = SourceRegistry.from_config(self.options.get("source_entities", entity_ids))
        self._configure_source_adapters()
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
        return list(dict.fromkeys([ALARM_ENTITY, *self._resolved_source_ids()]))

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
            if state.entity_id == ALARM_ENTITY:
                discovered.append(state.entity_id)
            elif domain == "binary_sensor" and device_class in supported_binary_classes:
                discovered.append(state.entity_id)
            elif domain == "lock":
                discovered.append(state.entity_id)
            elif domain == "cover" and device_class in supported_cover_classes:
                discovered.append(state.entity_id)
        return tuple(dict.fromkeys(discovered))

    def _configured_direct_history_entities(self) -> tuple[str, ...]:
        # Entity monitoring is explicit. Doors, windows, motion sensors, and
        # availability checks are selected through capability discovery and
        # use the shared lifecycle below; they are never auto-added by the
        # retired direct-history path.
        return self._presence_entity_ids()

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


    def _resolved_source_ids(self) -> list[str]:
        return list(dict.fromkeys([
            *self.registry.all(),
            # Capability sensors are explicitly selected by the user and are
            # first-class event sources. Keeping them here ensures their
            # transitions are subscribed and their resolved events may remain
            # in the ticker and history.
            *self.capability_registry.selected_entity_ids(self.options),
            *self.capability_registry.related_entity_ids(self.options),
            *self._camera_health_entity_ids(),
            *self._presence_entity_ids(),
        ]))

    def _sources(self, role: str) -> tuple[str, ...]:
        return self.registry.get(role)


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
        await self._async_refresh_calendar_events()
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


    @callback
    def _state_changed(self, event: Event) -> None:
        # State events invalidate the live snapshot. _publish rebuilds the
        # complete snapshot from current HA states, preventing stale items.
        self._record_easystart_fault_count_change(event)
        self._publish()


    def _rebuild_live_items(self) -> None:
        """Rebuild active state exclusively from the current HA state snapshot."""
        previous = dict(self.active)
        rebuilt: dict[str, dict] = {}
        configured_capability_entities = set(
            self.capability_registry.selected_entity_ids(self.options)
        )
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
                and entity_id not in configured_capability_entities
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
                        item.update({key: old.get(key) for key in ("created_at", "ticker_eligible", "ticker_until", "last_ticker_at", "next_reminder_at", "main_until")})
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
                old.get("event_type") == "availability_unavailable"
                and datetime.now(timezone.utc)
                < self._suppress_availability_recoveries_until
            ):
                # Integrations commonly report unavailable while Home
                # Assistant is restoring. Do not turn that expected startup
                # transition into a misleading "Device Back Online" event.
                self.ticker.pop(item_id, None)
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
            if str(old.get("source") or "").startswith("capability:"):
                # Every configured capability event follows one lifecycle:
                # it remains live while active, then becomes a recent ticker
                # event for the retention duration saved with that sensor.
                try:
                    retention_minutes = max(
                        1, min(1440, int(old.get("retention_minutes", 10)))
                    )
                except (TypeError, ValueError):
                    retention_minutes = 10
                presentation = self.capability_registry.resolution_fields(
                    self.hass.states.get(str(old.get("entity_id") or "")),
                    self.options,
                    old,
                )
                resolved_item.update({
                    "message": (
                        presentation.get("message", old.get("message"))
                        if old.get("prefer_resolved_message")
                        else old.get("display_name") or presentation.get(
                            "message", old.get("message")
                        )
                    ),
                    "detail": presentation.get("detail", old.get("detail")),
                    "icon": presentation.get("icon", old.get("icon")),
                    "priority": presentation.get("priority", "activity"),
                    "state": "resolved",
                    "ticker_until": (
                        datetime.now(timezone.utc)
                        + timedelta(minutes=retention_minutes)
                    ).isoformat(),
                    "main_until": None,
                    "next_reminder_at": None,
                })
                self.ticker[item_id] = resolved_item
            elif old.get("entity_id", "").startswith("binary_sensor.") and old.get("behavior") == "contact":
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
        if new_state is None:
            return
        configured_capability_entities = set(
            self.capability_registry.selected_entity_ids(self.options)
        )
        if (
            new_state.state in ("unknown", "unavailable")
            and entity_id not in configured_capability_entities
        ):
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
        capability_items = self.capability_registry.active_items(
            state, self.options, self.hass
        )
        if entity_id in self.capability_registry.selected_entity_ids(
            self.options
        ):
            return capability_items
        if entity_id in self.capability_registry.related_entity_ids(
            self.options
        ):
            # Supporting entities enrich their configured parent event and do
            # not publish an independent generic item.
            return []
        alerts = state.attributes.get("Alerts") or state.attributes.get("alerts")
        if isinstance(alerts, list):
            return [self._build_weather_item(entity_id, state, alert) for alert in alerts if isinstance(alert, dict)]
        item = self._build_item(entity_id, state)
        return [item] if item else []


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
            if (
                str(item.get("source") or "").startswith("capability:")
                and item.get("footer_eligible")
            ):
                # A selected active condition remains available to the footer
                # after its short main-ticker window has ended.
                eligible = True
            reminder = item.get("next_reminder_at")
            if reminder:
                try:
                    if datetime.fromisoformat(reminder).astimezone(timezone.utc) <= now:
                        eligible = True
                        main_duration = max(
                            1, int(item.get("main_duration_seconds", 60))
                        )
                        item["main_until"] = (
                            now + timedelta(seconds=main_duration)
                        ).isoformat()
                        item["ticker_until"] = item["main_until"]
                        item["last_ticker_at"] = now.isoformat()
                        interval = item.get("alert_behavior")
                        reminder_minutes = {
                            "sustained": 30, "critical": 10,
                            "reminder": 60,
                        }.get(interval)
                        item["next_reminder_at"] = (
                            now + timedelta(minutes=reminder_minutes)
                        ).isoformat() if reminder_minutes else None
                except ValueError:
                    pass
            item["ticker_eligible"] = eligible
            if eligible and self._entity_publish_enabled(item.get("entity_id")):
                self.ticker[key] = item
            else:
                self.ticker.pop(key, None)
        for key, item in list(self.ticker.items()):
            if (
                item.get("active")
                and str(item.get("source") or "").startswith("capability:")
                and item.get("footer_eligible")
            ):
                continue
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
        now = datetime.now(timezone.utc)

        def main_visible(item):
            until = item.get("main_until")
            if not until:
                return False
            try:
                return datetime.fromisoformat(
                    str(until).replace("Z", "+00:00")
                ).astimezone(timezone.utc) > now
            except ValueError:
                return False

        hero = []
        for item in ticker:
            exclusion_reason = None
            capability_event = str(item.get("source") or "").startswith(
                "capability:"
            )
            if capability_event and not main_visible(item):
                exclusion_reason = "main_window_expired"
            elif not capability_event and item.get("hero_eligible") is False:
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
        footer.extend(
            item for item in ticker
            if str(item.get("source") or "").startswith("capability:")
            and item.get("footer_eligible")
            and not main_visible(item)
        )
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
                "main_until", "footer_eligible", "retention_minutes",
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
        current.extend(
            self.capability_registry.current_items(self.hass, self.options)
        )
        capability_entity_ids = set(
            self.capability_registry.selected_entity_ids(self.options)
        )
        capability_related_ids = set(
            self.capability_registry.related_entity_ids(self.options)
        )

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
            if entity_id in capability_entity_ids or entity_id in capability_related_ids:
                # A configured capability owns this entity's publication. In
                # particular, an on connectivity binary sensor is healthy and
                # must not become a generic current-state ticker item.
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

        # The calendar service gives us all selected future events. Entity
        # attributes remain a fallback for calendar integrations that do not
        # support that service.
        upcoming.extend(dict(item) for item in self._calendar_items)
        refreshed_calendar_ids = {
            item.get("entity_id") for item in self._calendar_items
        }
        for entity_id in self._sources("family_calendar"):
            if entity_id in refreshed_calendar_ids:
                continue
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
