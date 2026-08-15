from __future__ import annotations


import json
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HomeStatusCoordinator
from .ha_native import compose_presentation_streams

TRANSPORT_VERSION = 1
TRANSPORT_CHANNELS = {
    "now": ("Home Status Now", "mdi:home-heart"),
    "recent": ("Home Status Recent", "mdi:history"),
    "household": ("Home Status Household", "mdi:home-account"),
    "weather": ("Home Status Weather", "mdi:weather-partly-cloudy"),
    "calendar": ("Home Status Calendar", "mdi:calendar"),
    "news": ("Home Status News", "mdi:newspaper"),
    "visual": ("Home Status Visual", "mdi:image-outline"),
}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities) -> None:
    coordinator = entry.runtime_data
    async_add_entities([
        HomeStatusSensor(coordinator),
        *[
            HomeStatusTransportSensor(coordinator, channel)
            for channel in TRANSPORT_CHANNELS
        ],
    ])


class HomeStatusSensor(CoordinatorEntity[HomeStatusCoordinator], SensorEntity):
    _attr_has_entity_name = False
    _attr_name = "Home Status"
    _attr_icon = "mdi:home-heart"

    def __init__(self, coordinator: HomeStatusCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_summary"

    @property
    def native_value(self):
        return self.coordinator.data.get("health", "normal") if self.coordinator.data else "normal"

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        # Keep the entity's Recorder payload focused on what the card renders.
        # The coordinator retains the complete working snapshot in memory, but
        # publishing every intermediate collection (and diagnostic duplicates)
        # can exceed Recorder's 16 KiB attribute limit.
        native = self._compact_native(data.get("native"))
        attributes = {
            "health": data.get("health", "normal"),
            "priority": data.get("priority", "normal"),
            "weather_visual_effect": data.get("weather_visual_effect"),
            "visual": self._compact_visual(data.get("visual")),
            "visual_queue": self._compact_visual_queue(data.get("visual_queue")),
            "visual_queue_active": bool(data.get("visual_queue_active")),
            "active_count": int(data.get("active_count", 0) or 0),
            "display": self._compact_display(data.get("display")),
            "presentation": self._compact_presentation(data.get("presentation")),
            "native": native,
            "transport": self._transport_manifest(data, data.get("native")),
        }
        # Recorder rejects attributes above 16 KiB. Keep a margin below that
        # limit so normal changes in labels or URLs cannot make this entity
        # noisy or create avoidable database work.
        return self._fit_attribute_budget(attributes)

    @staticmethod
    def _transport_manifest(data: dict[str, Any], native: Any) -> dict[str, Any]:
        """Describe fixed transport channels without adding card configuration."""
        return {
            "version": TRANSPORT_VERSION,
            "kind": "manifest",
            "revision": int(data.get("snapshot_revision", 0) or 0),
            "channels": {
                channel: {"entity_id": f"sensor.home_status_{channel}"}
                for channel in TRANSPORT_CHANNELS
            },
            "streams": native.get("streams", {}) if isinstance(native, dict) else {},
        }

    @staticmethod
    def _compact_display(value):
        if not isinstance(value, dict):
            return {}
        return {
            key: value[key]
            for key in ("rotation_seconds", "media_enabled")
            if key in value
        }

    @staticmethod
    def _compact_presentation(value):
        if not isinstance(value, dict):
            return {}
        allowed = {"layout", "emphasis", "appearance", "timestamps"}
        return {key: value[key] for key in allowed if key in value and isinstance(value[key], dict)}

    @staticmethod
    def _compact_visual(value):
        if not isinstance(value, dict):
            return None
        return {
            key: value[key]
            for key in ("type", "transport", "url", "entity_id", "article_url", "title", "source", "event_start", "event_end", "priority", "live", "started_at", "expires_at", "resumable", "mute")
            if key in value
        }

    @staticmethod
    def _compact_visual_queue(value):
        if not isinstance(value, list):
            return []
        return [
            compact
            for item in value
            if (compact := HomeStatusSensor._compact_visual(item)) is not None
        ]

    @staticmethod
    def _compact_native(value):
        if not isinstance(value, dict):
            return {
                "contract_version": 3,
                "current": [],
                "recent": [],
                "awareness": [],
                "streams": compose_presentation_streams([], [], []),
            }

        def compact(items, fields):
            if not isinstance(items, list):
                return []
            return [
                {key: item[key] for key in fields if key in item}
                for item in items
                if isinstance(item, dict)
            ]

        current = compact(
            value.get("current"),
            (
                "id", "entity_id", "entity_name", "title", "message", "summary",
                "icon", "category", "color_role", "priority", "active", "state",
                "created_at", "event_type", "timestamp_mode", "display_kind", "capability", "source",
                "ticker_eligible", "rotate_with_awareness", "utility_role", "stream_preference",
            ),
        )
        # The Recorder budget must not hide a live appliance or the two
        # requested Micro-Air Current items behind otherwise idle household
        # entities. Prioritize those complete current snapshots first, then
        # actionable items, before retaining neutral context as space permits.
        current.sort(
            key=lambda item: (
                item.get("capability") not in {
                    "appliance_cycle", "easystart_current"
                },
                {"critical": 0, "attention": 1, "activity": 2, "normal": 3}.get(
                    str(item.get("priority") or "normal"), 3
                ),
            )
        )
        current = current[:8]
        recent = compact(
            value.get("recent"),
            (
                "id", "entity_id", "entity_name", "title", "message", "summary",
                "icon", "category", "color_role", "priority", "active", "state",
                "created_at", "event_type", "timestamp_mode", "display_kind", "capability", "source", "group_labels", "utility_role", "stream_preference",
            ),
        )[:16]
        awareness = HomeStatusSensor._compact_items(value.get("awareness"), 8)
        return {
            "contract_version": 3,
            "current": current,
            "recent": recent,
            "awareness": awareness,
            "streams": compose_presentation_streams(current, recent, awareness),
        }

    @staticmethod
    def _compact_items(value, limit):
        if not isinstance(value, list):
            return []
        # These are the presentation fields the card consumes.  Excluding
        # upstream/raw duplicates prevents calendars, news, and media feeds
        # from repeatedly inflating the Recorder state payload.
        fields = (
            "id", "title", "message", "summary", "detail", "category",
            "icon", "priority", "active", "source", "source_kind", "event_type",
            "created_at", "updated_at",
            "occurred_at", "expires_at", "scheduled_at", "all_day", "timestamp",
            "entity_id", "image_url", "media_url", "media_type", "article_url",
            "navigation", "subtitle", "body", "visual_effect", "action", "state",
            "color_role", "timestamp_mode", "display_kind", "utility_role", "stream_preference", "visual_only", "visual", "zone_visual",
        )
        items = []
        selected = value if limit is None else value[:limit]
        # Keep the two durable awareness summaries that are generated outside
        # a normal selected source list: household presence and the newest
        # local-news item.  Household presence is appended after configured
        # devices and sources, so a simple first-N limit can otherwise show it
        # immediately during startup and then omit it from the sensor payload
        # once the full awareness collection is published.
        if limit is not None and len(value) > limit:
            household = next(
                (
                    item for item in value
                    if isinstance(item, dict)
                    and item.get("id") == "home_status:household_presence:awareness"
                ),
                None,
            )
            news = next(
                (
                    item for item in value
                    if isinstance(item, dict) and item.get("category") == "news"
                ),
                None,
            )
            protected = [item for item in (household, news) if item is not None][:limit]
            protected_ids = {id(item) for item in protected}
            ordinary = [item for item in value if id(item) not in protected_ids]
            selected = [*ordinary[: max(0, limit - len(protected))], *protected]
        for item in selected:
            if not isinstance(item, dict):
                continue
            compact = {}
            for key in fields:
                current = item.get(key)
                if current is None:
                    continue
                if isinstance(current, str):
                    current = current[:160]
                compact[key] = current
            items.append(compact)
        return items

    @staticmethod
    def _fit_attribute_budget(attributes):
        """Keep the published state safely below Recorder's 16 KiB limit."""
        def size(value):
            return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

        # Keep live appliance/current state intact. Older ticker and awareness
        # items are presentation history, so trim those first when a feed has
        # unusually verbose data.
        native = attributes.get("native")
        if not isinstance(native, dict):
            return attributes
        while size(attributes) > 12_000 and native.get("awareness"):
            awareness = native["awareness"]
            news_indexes = [
                index for index, item in enumerate(awareness)
                if isinstance(item, dict) and item.get("category") == "news"
            ]
            removable = next(
                (
                    index for index in range(len(awareness) - 1, -1, -1)
                    if index not in news_indexes
                ),
                None,
            )
            if removable is None:
                if len(news_indexes) <= 1:
                    break
                removable = news_indexes[-1]
            awareness.pop(removable)
        while size(attributes) > 12_000 and len(native.get("recent", [])) > 8:
            native["recent"].pop()
        native["streams"] = compose_presentation_streams(
            native.get("current", []),
            native.get("recent", []),
            native.get("awareness", []),
        )
        return attributes


class HomeStatusTransportSensor(CoordinatorEntity[HomeStatusCoordinator], SensorEntity):
    """One fixed, coordinator-backed payload boundary for the card."""

    _attr_has_entity_name = False

    def __init__(self, coordinator: HomeStatusCoordinator, channel: str) -> None:
        super().__init__(coordinator)
        self._channel = channel
        name, icon = TRANSPORT_CHANNELS[channel]
        self._attr_name = name
        self._attr_icon = icon
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{channel}"

    @property
    def native_value(self):
        data = self.coordinator.data or {}
        if self._channel == "visual":
            return "available" if data.get("visual") else "idle"
        return len(self._items(data))

    @property
    def extra_state_attributes(self):
        data = self.coordinator.data or {}
        payload: dict[str, Any] = {
            "version": TRANSPORT_VERSION,
            "kind": "channel",
            "channel": self._channel,
            "revision": int(data.get("snapshot_revision", 0) or 0),
        }
        if self._channel == "visual":
            payload["visual"] = HomeStatusSensor._compact_visual(data.get("visual"))
            payload["visual_queue"] = HomeStatusSensor._compact_visual_queue(
                data.get("visual_queue")
            )
            payload["visual_queue_active"] = bool(data.get("visual_queue_active"))
            payload["weather_visual_effect"] = data.get("weather_visual_effect") or ""
        else:
            payload["items"] = self._compact_items(self._items(data))
        return {"transport": self._fit_budget(payload)}

    def _items(self, data: dict[str, Any]) -> list[dict[str, Any]]:
        native = data.get("native") if isinstance(data.get("native"), dict) else {}
        if self._channel == "now":
            return native.get("current") if isinstance(native.get("current"), list) else []
        if self._channel == "recent":
            return native.get("recent") if isinstance(native.get("recent"), list) else []
        awareness = native.get("awareness") if isinstance(native.get("awareness"), list) else []
        if self._channel == "household":
            return [
                item for item in awareness
                if isinstance(item, dict)
                and str(item.get("category") or "").casefold()
                not in {"weather", "calendar", "news"}
            ]
        return [
            item for item in awareness
            if isinstance(item, dict)
            and str(item.get("category") or "").casefold() == self._channel
        ]

    @staticmethod
    def _compact_items(value: list[dict[str, Any]]) -> list[dict[str, Any]]:
        fields = (
            "id", "entity_id", "entity_name", "title", "message", "summary", "detail",
            "icon", "category", "color_role", "priority", "active", "state", "source",
            "source_kind", "event_type", "created_at", "updated_at", "occurred_at",
            "expires_at", "scheduled_at", "all_day", "timestamp", "timestamp_mode",
            "display_kind", "capability", "ticker_eligible", "rotate_with_awareness", "group_labels", "utility_role", "stream_preference",
            "image_url", "media_url", "media_type", "article_url", "navigation", "subtitle",
            "body", "visual_effect", "action", "visual_only", "visual", "zone_visual",
        )
        items = []
        for item in value:
            if not isinstance(item, dict):
                continue
            compact = {}
            for key in fields:
                current = item.get(key)
                if current is None:
                    continue
                compact[key] = current[:160] if isinstance(current, str) else current
            items.append(compact)
        return items

    @staticmethod
    def _fit_budget(payload: dict[str, Any]) -> dict[str, Any]:
        """Bound one channel only; it must never evict another channel."""
        def size(value: dict[str, Any]) -> int:
            return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))

        items = payload.get("items")
        while size(payload) > 12_000 and isinstance(items, list) and items:
            items.pop()
        # A single signed media URL can theoretically exceed the attribute
        # budget by itself. Dropping that one visual is safer than making the
        # entity invalid; it does not affect any information channel.
        if size(payload) > 12_000 and payload.get("visual") is not None:
            payload["visual"] = None
        queue = payload.get("visual_queue")
        while size(payload) > 12_000 and isinstance(queue, list) and queue:
            queue.pop()
        return payload
