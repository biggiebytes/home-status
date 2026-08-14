from __future__ import annotations


import json

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HomeStatusCoordinator
from .ha_native import compose_presentation_streams



async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry, async_add_entities) -> None:
    async_add_entities([HomeStatusSensor(entry.runtime_data)])


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
        attributes = {
            "health": data.get("health", "normal"),
            "priority": data.get("priority", "normal"),
            "weather_visual_effect": data.get("weather_visual_effect"),
            "visual": self._compact_visual(data.get("visual")),
            "active_count": int(data.get("active_count", 0) or 0),
            "display": self._compact_display(data.get("display")),
            "presentation": self._compact_presentation(data.get("presentation")),
            "native": self._compact_native(data.get("native")),
        }
        # Recorder rejects attributes above 16 KiB. Keep a margin below that
        # limit so normal changes in labels or URLs cannot make this entity
        # noisy or create avoidable database work.
        return self._fit_attribute_budget(attributes)

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
            for key in ("type", "transport", "url", "entity_id", "article_url", "title", "source", "priority", "live", "started_at", "expires_at", "resumable", "mute")
            if key in value
        }

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
                "ticker_eligible", "utility_role",
            ),
        )
        # The Recorder budget must not hide a live washer, dryer, or
        # dishwasher behind otherwise idle household entities. Prioritize
        # appliance cycles, then actionable items, before retaining neutral
        # context as space permits.
        current.sort(
            key=lambda item: (
                item.get("capability") != "appliance_cycle",
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
                "created_at", "event_type", "timestamp_mode", "display_kind", "capability", "source", "group_labels", "utility_role",
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
            "color_role", "timestamp_mode", "display_kind", "utility_role", "visual", "zone_visual",
        )
        items = []
        selected = value if limit is None else value[:limit]
        # Awareness is assembled from household context first and RSS articles
        # second. A simple first-N limit would therefore hide every local-news
        # item once a home has eight other awareness sources. Reserve one news
        # slot when present without increasing the Recorder payload budget.
        if limit is not None and len(value) > limit:
            news = [
                item for item in value
                if isinstance(item, dict) and item.get("category") == "news"
            ]
            if news:
                non_news = [
                    item for item in value
                    if not isinstance(item, dict) or item.get("category") != "news"
                ]
                selected = [*non_news[: limit - 1], news[0]]
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
