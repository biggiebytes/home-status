from __future__ import annotations


import json

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import HomeStatusCoordinator



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
            return {"current": [], "recent": [], "awareness": []}

        def compact(items, fields):
            if not isinstance(items, list):
                return []
            return [
                {key: item[key] for key in fields if key in item}
                for item in items
                if isinstance(item, dict)
            ]

        return {
            "current": compact(
                value.get("current"),
                (
                    "entity_id", "entity_name", "domain", "device_class",
                    "state", "changed_at", "attention", "capability", "detail",
                ),
            )[:8],
            "recent": compact(
                value.get("recent"),
                (
                    "entity_id", "entity_name", "domain", "device_class",
                    "from", "to", "changed_at", "capability",
                ),
            )[:16],
            "awareness": HomeStatusSensor._compact_items(value.get("awareness"), 8),
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
            "icon", "priority", "active", "source", "created_at", "updated_at",
            "occurred_at", "expires_at", "scheduled_at", "all_day", "timestamp",
            "entity_id", "image_url", "media_url", "media_type", "article_url",
            "navigation", "subtitle", "body", "visual_effect", "action", "state",
        )
        items = []
        selected = value if limit is None else value[:limit]
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
            native["awareness"].pop()
        while size(attributes) > 12_000 and len(native.get("recent", [])) > 8:
            native["recent"].pop()
        return attributes
