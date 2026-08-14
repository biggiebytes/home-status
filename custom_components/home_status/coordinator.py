"""Clean discovery-first Home Status coordinator.

No category-driven routing or legacy source registry.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_track_point_in_time,
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.components.recorder import get_instance

from .const import DOMAIN
from .engine import HomeStatusEngine
from .ha_native import (
    async_recent_transitions,
    compose_presentation_streams,
    current_states,
    present_awareness_items,
    present_current_items,
    present_recent_items,
    transition_entity_ids,
)
from .presentation import select_visual
from .presentation_config import presentation_preferences
from .news import now_iso, parse_feed, valid_url
from .providers.live_news import LiveNewsProvider

_LOGGER = logging.getLogger(__name__)

_STORE_VERSION = 1
_STORE_KEY = f"{DOMAIN}.history_v2"


class HomeStatusCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Coordinate selected Home Devices and publish one normalized Home Status snapshot."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN)
        self.entry = entry
        self.options = {**entry.data, **entry.options}
        self.engine = HomeStatusEngine(hass)
        self.store = Store(hass, _STORE_VERSION, _STORE_KEY)

        self.news_articles: list[dict[str, Any]] = []
        self.news_seen: dict[str, list[str]] = {}
        self.news_visuals: dict[str, dict[str, Any]] = {}
        self.news_initialized: dict[str, bool] = {}
        self.live_news = LiveNewsProvider()
        self.live_news_items: list[dict[str, Any]] = []
        self._current_visual_is_live_news = False

        self._unsub_state = None
        self._unsub_timer = None
        self._unsub_visual_expiry = None
        self._observed: tuple[str, ...] = ()
        self._visual_source_lifetimes: dict[str, dict[str, datetime]] = {}
        self._visual_source_preemptions: dict[str, datetime] = {}
        self._current_visual_source_activation: tuple[str, datetime] | None = None
        # This is a disposable Recorder read cache, not Home Status history.
        # It is never written to Store and is reconstructed from HA on setup.
        self._native_recent: list[dict[str, Any]] = []
        self._native_history_refresh_pending = False

    async def async_setup(self) -> None:
        stored = await self.store.async_load() or {}
        self.news_seen = stored.get("news_seen", {}) if isinstance(stored.get("news_seen", {}), dict) else {}
        self.news_visuals = stored.get("news_visuals", {}) if isinstance(stored.get("news_visuals", {}), dict) else {}
        self.news_initialized = stored.get("news_initialized", {}) if isinstance(stored.get("news_initialized", {}), dict) else {}
        self.live_news = LiveNewsProvider(stored.get("live_news"))
        await self._refresh_news(initial=True)
        self._refresh_live_news()
        self._reconfigure_subscription()
        self._publish()
        self._configure_timer()

    def async_unload(self) -> None:
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        if self._unsub_visual_expiry:
            self._unsub_visual_expiry()
            self._unsub_visual_expiry = None

    @callback
    def async_update_entities(self, _entity_ids: list[str] | None = None) -> None:
        """Compatibility entry point used by existing Home Status setup code."""
        self.options = {**self.entry.data, **self.entry.options}
        self._reconfigure_subscription()
        self._refresh_live_news()
        self._publish()

    def _configure_timer(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
        try:
            seconds = max(15, int(self.options.get("refresh_interval", 60)))
        except (TypeError, ValueError):
            seconds = 60
        self._unsub_timer = async_track_time_interval(
            self.hass, self._timer_tick, timedelta(seconds=seconds)
        )

    def _reconfigure_subscription(self) -> None:
        observed = tuple(sorted({
            *self.engine.observed_entity_ids(self.options),
            *self._visual_source_entity_ids(),
        }))
        if observed == self._observed and self._unsub_state:
            return
        if self._unsub_state:
            self._unsub_state()
            self._unsub_state = None
        self._observed = observed
        if observed:
            self._unsub_state = async_track_state_change_event(
                self.hass, list(observed), self._state_changed
            )

    async def _timer_tick(self, _now) -> None:
        self.options = {**self.entry.data, **self.entry.options}
        self._reconfigure_subscription()
        await self._refresh_news()
        if self.hass.is_running:
            await self._refresh_native_history()
        self._refresh_live_news()
        self._publish()

    def _store_data(self) -> dict[str, Any]:
        return {
            "news_seen": self.news_seen,
            "news_visuals": self.news_visuals,
            "news_initialized": self.news_initialized,
            "live_news": self.live_news.state,
        }

    def _save_state(self) -> None:
        self.hass.async_create_task(self.store.async_save(self._store_data()))

    def _refresh_live_news(self) -> None:
        sample_interval = self._int_option("live_news_sample_interval", 1800, minimum=30)
        display_duration = self._int_option("live_news_display_duration", 30, minimum=1)
        muted = bool(self.options.get("live_news_mute", True))
        sources = []
        for configured in self.options.get("live_news_sources", []):
            if not isinstance(configured, dict):
                continue
            source = dict(configured)
            # Sampling is provider-wide: one source is eligible per window,
            # then the provider advances its persisted round-robin cursor.
            source.update({"sample_interval": sample_interval, "display_duration": display_duration, "mute": muted})
            sources.append(source)
        self.live_news_items = self.live_news.refresh(
            sources, datetime.now(timezone.utc)
        )
        self._save_state()

    async def _refresh_news(self, initial: bool = False) -> None:
        articles: list[dict[str, Any]] = []
        # RSS remains a headline/thumbnail source. Remove any short-lived
        # video visual left by the retired RSS-enclosure experiment.
        self.news_visuals = {
            article_id: visual for article_id, visual in self.news_visuals.items()
            if not isinstance(visual, dict) or visual.get("type") != "video"
        }
        session = async_get_clientsession(self.hass)
        for feed in self.options.get("news_sources", []):
            if not isinstance(feed, dict) or feed.get("enabled", True) is not True or not valid_url(feed.get("url")):
                continue
            feed_id = str(feed.get("id") or "")
            if not feed_id:
                continue
            try:
                async with session.get(str(feed["url"]), timeout=15) as response:
                    response.raise_for_status()
                    parsed = parse_feed(await response.read(), feed_id)
            except Exception:  # A source failure must not disrupt Home Status.
                continue
            seen = set(self.news_seen.get(feed_id, []))
            bootstrap = self.news_initialized.get(feed_id) is not True
            if bootstrap:
                # Establish the duplicate baseline first. A new feed may show
                # its newest eligible image once, but none of these entries is
                # classified as a newly detected article.
                seen.update(article["id"] for article in parsed)
                self.news_initialized[feed_id] = True
                if feed.get("show_visual", True):
                    newest_with_media = next((article for article in parsed if article.get("image")), None)
                    if newest_with_media:
                        started = now_iso()
                        self.news_visuals[newest_with_media["id"]] = self._news_visual(newest_with_media, feed, started)
            for article in parsed:
                is_new = not bootstrap and article["id"] not in seen
                visual = self.news_visuals.get(article["id"])
                if visual and str(visual.get("expires_at") or "") <= now_iso():
                    self.news_visuals.pop(article["id"], None)
                    visual = None
                if is_new and feed.get("show_visual", True) and article.get("image"):
                    started = now_iso()
                    visual = self._news_visual(article, feed, started)
                    self.news_visuals[article["id"]] = visual
                media_url = str(article.get("video") or article.get("image") or "")
                media_type = "video" if article.get("video") else "image"
                articles.append({"id":article["id"], "source_id":f"news:{feed_id}", "source_name":str(feed.get("name") or "News"), "source_kind":"news", "event_type":"news_article", "title":article["title"], "message":article["title"], "summary":article.get("summary") or str(feed.get("name") or "News"), "detail":article.get("summary") or "", "category":"news", "priority":str(feed.get("priority") or "normal"), "icon":"mdi:newspaper", "active":False, "created_at":article.get("published") or now_iso(), "navigation":article["url"], "action":article["url"], "article_url":article["url"], **({"media_url":media_url, "media_type":media_type} if media_url else {}), **({"image_url":article["image"]} if article.get("image") else {}), **({"visual":visual} if visual else {})})
                seen.add(article["id"])
            self.news_seen[feed_id] = list(seen)[-200:]
        self.news_articles = articles
        self._save_state()

    @staticmethod
    def _news_visual(article: dict[str, str], feed: dict[str, Any], started: str) -> dict[str, Any]:
        return {"type":"image", "url":article["image"], "article_url":article["url"], "title":article["title"], "source":str(feed.get("name") or "News"), "priority":str(feed.get("priority") or "normal"), "live":False, "started_at":started, "expires_at":(datetime.now(timezone.utc) + timedelta(seconds=max(1, int(feed.get("visual_duration", 60))))).isoformat(), "resumable":True}

    @callback
    def _state_changed(self, event: Event) -> None:
        self._publish()
        # Home Assistant emits a burst of state changes while restoring at
        # startup. Recorder history is not needed to render current truth, and
        # querying it for each restored entity delays the rest of startup.
        if self.hass.is_running:
            self._schedule_native_history_refresh()

    def _schedule_native_history_refresh(self) -> None:
        """Coalesce live changes into one post-commit Recorder refresh."""
        if self._native_history_refresh_pending:
            return
        self._native_history_refresh_pending = True
        async_track_point_in_time(
            self.hass,
            self._run_scheduled_native_history_refresh,
            datetime.now(timezone.utc) + timedelta(seconds=2),
        )

    async def _run_scheduled_native_history_refresh(self, _now) -> None:
        self._native_history_refresh_pending = False
        await self._refresh_native_history_after_commit()

    async def _refresh_native_history_after_commit(self) -> None:
        """Refresh after Recorder accepts the live state_changed event."""
        recorder = get_instance(self.hass)
        commit_future = getattr(recorder, "async_get_commit_future", None)
        if callable(commit_future):
            try:
                if future := commit_future():
                    await future
            except Exception:
                pass
        await self._refresh_native_history()
        self._publish()

    async def _refresh_native_history(self) -> None:
        """Read recent HA transitions; never persist or synthesize them."""
        try:
            # Retain the established UI setting from Home Status's original
            # ticker: a one-day history must still mean a one-day Recorder
            # query after moving the card to the native contract.
            if self.options.get("native_history_minutes") is not None:
                minutes = int(self.options["native_history_minutes"])
            elif self.options.get("history_retention_days") is not None:
                minutes = int(float(self.options["history_retention_days"]) * 24 * 60)
            elif self.options.get("footer_activity_history_hours") is not None:
                minutes = int(float(self.options["footer_activity_history_hours"]) * 60)
            else:
                minutes = int(self.options.get("ticker_event_minutes", 10))
            minutes = max(1, minutes)
        except (TypeError, ValueError):
            minutes = 10
        transitions = await async_recent_transitions(
            self.hass,
            transition_entity_ids(self.hass, self.engine.recent_entity_ids(self.options)),
            datetime.now(timezone.utc) - timedelta(minutes=minutes),
            self._native_name_for_entity,
        )
        self._native_recent = self.engine.native_recent_facts(self.options, transitions)

    def _publish(self) -> None:
        # Current interpreter output remains available to Visual Center only.
        # It is not retained, resolved, published as entity history, or routed.
        active = self.engine.build_active_items(self.options)
        visual_source_items = self._configured_visual_items()
        awareness = [*self.engine.build_awareness_items(self.options), *self.news_articles]
        appliance_current = self.engine.native_current_facts(self.options)
        appliance_entity_ids = self.engine.appliance_owned_entity_ids(self.options)
        native_current_facts = [
            *current_states(
                self.hass,
                tuple(entity_id for entity_id in self._observed if entity_id not in appliance_entity_ids),
                self._native_name_for_entity,
            ),
            *appliance_current,
        ]
        native_current = present_current_items(native_current_facts, self.options)
        native_recent = present_recent_items(self._native_recent, self.options)
        awareness = present_awareness_items(awareness, self.options)
        streams = compose_presentation_streams(native_current, native_recent, awareness)
        # RSS media follows the article currently shown by the card.  It is not
        # independently selected here, so Visual Center has one normal-source
        # fallback when no displayed news item carries media.
        non_news_awareness = [
            item for item in awareness if item.get("source_kind") != "news"
        ]
        visual = self._select_current_visual(
            active, [], non_news_awareness, visual_source_items, self.live_news_items
        )
        priority = self._native_priority(native_current)
        weather_effect = self._weather_visual_effect(awareness)

        self.async_set_updated_data({
            "native": {
                "contract_version": 3,
                "current": native_current,
                "recent": native_recent,
                "awareness": awareness,
                "streams": streams,
            },
            "health": priority,
            "priority": priority,
            "active_count": len(native_current),
            "visual": visual,
            "weather_visual_effect": weather_effect,
            "display": {
                "rotation_seconds": self._int_option("rotation_seconds", 6, minimum=1),
                "media_enabled": bool(self.options.get("media_enabled", True)),
            },
            "presentation": presentation_preferences(self.options),
            "last_updated": self._now(),
        })
        self._schedule_visual_expiry()

    def _native_name_for_entity(self, entity_id: str) -> str | None:
        """Apply existing Home Status naming choices at the native boundary."""
        return self.engine.display_name_for_item(
            self.options, {"entity_id": entity_id}
        )

    def _select_current_visual(
        self,
        active: list[dict[str, Any]],
        recent: list[dict[str, Any]],
        awareness: list[dict[str, Any]],
        visual_source_items: list[dict[str, Any]],
        live_news_items: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any] | None:
        """Select a visual and retire a shown non-resumable source on takeover."""
        if not bool(self.options.get("visual_center_enabled", True)):
            self._current_visual_source_activation = None
            self._current_visual_is_live_news = False
            return None
        live_news_items = live_news_items or []
        visual = select_visual([*active, *visual_source_items, *live_news_items], recent, awareness)
        if visual is None:
            self._current_visual_source_activation = None
            self._current_visual_is_live_news = False
            return None

        is_live_news = any(item.get("visual") == visual for item in live_news_items)
        if getattr(self, "_current_visual_is_live_news", False) and not is_live_news:
            self.live_news.stop_active_after_preemption(datetime.now(timezone.utc))
            self.live_news_items = []
            self._save_state()
            visual = select_visual([*active, *visual_source_items], recent, awareness)
            is_live_news = False

        owner = self._visual_source_owner(visual_source_items, visual)
        previous = self._current_visual_source_activation
        if previous is not None and previous != owner:
            previous_source_id, previous_started_at = previous
            previous_item = next(
                (
                    item for item in visual_source_items
                    if item.get("visual_source_id") == previous_source_id
                    and self._visual_source_lifetimes.get(previous_source_id, {}).get("started_at") == previous_started_at
                ),
                None,
            )
            previous_visual = previous_item.get("visual") if previous_item else None
            if isinstance(previous_visual, dict) and previous_visual.get("resumable") is False:
                self._visual_source_preemptions[previous_source_id] = previous_started_at
                sources = self._configured_visual_items()
                visual = select_visual([*active, *sources], recent, awareness)
                owner = self._visual_source_owner(sources, visual)
        self._current_visual_source_activation = owner
        self._current_visual_is_live_news = is_live_news
        return visual

    def _visual_source_owner(
        self, items: list[dict[str, Any]], visual: dict[str, Any] | None
    ) -> tuple[str, datetime] | None:
        if visual is None:
            return None
        for item in items:
            source_id = item.get("visual_source_id")
            lifetime = self._visual_source_lifetimes.get(str(source_id))
            if item.get("visual") == visual and lifetime is not None:
                return str(source_id), lifetime["started_at"]
        return None

    def _schedule_visual_expiry(self) -> None:
        """Wake exactly when the next held visual reaches its expiration."""
        if self._unsub_visual_expiry:
            self._unsub_visual_expiry()
            self._unsub_visual_expiry = None
        expirations = [
            lifetime["expires_at"]
            for lifetime in self._visual_source_lifetimes.values()
            if "expires_at" in lifetime
        ]
        live_news_wakeup = self.live_news.next_wakeup()
        if live_news_wakeup is not None:
            expirations.append(live_news_wakeup)
        if expirations:
            self._unsub_visual_expiry = async_track_point_in_time(
                self.hass, self._visual_expired, min(expirations)
            )

    @callback
    def _visual_expired(self, _now: datetime) -> None:
        self._unsub_visual_expiry = None
        self._refresh_live_news()
        self._publish()

    def _visual_source_entity_ids(self) -> tuple[str, ...]:
        """Return the camera and trigger entities configured for Visual Center."""
        entity_ids: set[str] = set()
        for source in self.options.get("visual_sources", []):
            if not isinstance(source, dict) or source.get("type") != "camera":
                continue
            for key in ("camera_entity_id", "trigger_entity_id"):
                entity_id = source.get(key)
                if isinstance(entity_id, str) and "." in entity_id:
                    entity_ids.add(entity_id)
        return tuple(sorted(entity_ids))

    def _configured_visual_items(self) -> list[dict[str, Any]]:
        """Build provider-neutral visual-only items from explicit user sources."""
        items: list[dict[str, Any]] = []
        for source in self.options.get("visual_sources", []):
            if not isinstance(source, dict) or source.get("type") != "camera":
                continue
            if source.get("enabled", True) is not True:
                continue
            camera_entity_id = source.get("camera_entity_id")
            trigger_entity_id = source.get("trigger_entity_id")
            if (
                not isinstance(camera_entity_id, str)
                or not camera_entity_id.startswith("camera.")
                or not isinstance(trigger_entity_id, str)
                or "." not in trigger_entity_id
            ):
                continue
            source_id = str(source.get("id") or f"{camera_entity_id}:{trigger_entity_id}")
            trigger = self.hass.states.get(trigger_entity_id)
            trigger_state = str(source.get("trigger_state") or "on").strip()
            if not trigger:
                continue
            now = datetime.now(timezone.utc)
            trigger_active = str(trigger.state).strip().casefold() == trigger_state.casefold()
            started_at = trigger.last_changed.astimezone(timezone.utc)
            lifetime = self._visual_source_lifetimes.get(source_id)
            if trigger_active:
                if lifetime is None or lifetime.get("started_at") != started_at:
                    lifetime = {"started_at": started_at}
                    self._visual_source_lifetimes[source_id] = lifetime
                    self._visual_source_preemptions.pop(source_id, None)
            else:
                if lifetime is None:
                    continue
                if "expires_at" not in lifetime:
                    hold_seconds = self._visual_hold_seconds(source)
                    if hold_seconds <= 0:
                        self._visual_source_lifetimes.pop(source_id, None)
                        self._visual_source_preemptions.pop(source_id, None)
                        continue
                    lifetime["expires_at"] = now + timedelta(seconds=hold_seconds)
                if lifetime["expires_at"] <= now:
                    self._visual_source_lifetimes.pop(source_id, None)
                    self._visual_source_preemptions.pop(source_id, None)
                    continue
            if self._visual_source_preemptions.get(source_id) == lifetime["started_at"]:
                continue
            expires_at = lifetime.get("expires_at")
            items.append({
                "id": f"visual_source:{source_id}",
                "visual_source_id": source_id,
                "active": True,
                "priority": str(source.get("priority") or "attention"),
                "event_type": "visual_source",
                "category": "visual",
                "created_at": lifetime["started_at"].isoformat(),
                "visual": {
                    "type": "camera",
                    "entity_id": camera_entity_id,
                    "priority": str(source.get("priority") or "attention"),
                    "live": trigger_active,
                    "started_at": lifetime["started_at"].isoformat(),
                    "resumable": bool(source.get("resumable", True)),
                    **({"expires_at": expires_at.isoformat()} if expires_at else {}),
                },
            })
        return items

    @staticmethod
    def _visual_hold_seconds(source: dict[str, Any]) -> int:
        try:
            return max(0, min(3600, int(source.get("hold_seconds", 30))))
        except (TypeError, ValueError):
            return 30

    @staticmethod
    def _native_priority(current: list[dict[str, Any]]) -> str:
        priorities = {str(item.get("priority") or "none") for item in current}
        if "critical" in priorities:
            return "critical"
        if "attention" in priorities:
            return "attention"
        return "normal"

    @staticmethod
    def _weather_visual_effect(awareness: list[dict[str, Any]]) -> str | None:
        for item in awareness:
            entity_id = str(item.get("entity_id") or "")
            if not entity_id.startswith("weather."):
                continue
            state = str(item.get("state") or "").casefold()
            if any(word in state for word in ("rain", "pour", "drizzle")):
                return "rain"
            if any(word in state for word in ("cloud", "overcast")):
                return "clouds"
            if "fog" in state:
                return "fog"
            if any(word in state for word in ("lightning", "storm", "thunder")):
                return "storm"
            if "wind" in state:
                return "wind"
            if any(word in state for word in ("clear-night", "night")):
                return "night"
            return "clear"
        return None

    def _int_option(self, key: str, default: int, *, minimum: int = 0) -> int:
        try:
            return max(minimum, int(self.options.get(key, default)))
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()
