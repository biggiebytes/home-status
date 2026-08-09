from __future__ import annotations


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
        return {
            "health": data.get("health", "normal"),
            "priority": data.get("priority", "normal"),
            "weather_visual_effect": data.get("weather_visual_effect"),
            "visual": self._compact_visual(data.get("visual")),
            "active_count": int(data.get("active_count", 0) or 0),
            "display": self._compact_display(data.get("display")),
            "presentation": self._compact_presentation(data.get("presentation")),
            # The coordinator has already applied the user's source, filter,
            # and item-limit choices. Do not impose a second hidden cap while
            # publishing those collections to the card.
            "active": self._compact_items(data.get("active"), None),
            "recent": self._compact_items(data.get("recent"), None),
            # New presentation contract.
            "left": self._compact_items(data.get("left", data.get("hero")), None),
            "right": self._compact_items(data.get("right", data.get("sidebar")), None),
            "bottom": self._compact_items(data.get("bottom", data.get("footer")), None),
            # Temporary aliases keep the existing frontend working during migration.
            "hero": self._compact_items(data.get("left", data.get("hero")), None),
            "sidebar": self._compact_items(data.get("right", data.get("sidebar")), None),
            "footer": self._compact_items(data.get("bottom", data.get("footer")), None),
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
            for key in ("type", "transport", "url", "entity_id", "article_url", "title", "source", "priority", "live", "started_at", "expires_at", "resumable", "mute")
            if key in value
        }

    @staticmethod
    def _compact_items(value, limit):
        if not isinstance(value, list):
            return []
        fields = (
            "id", "title", "message", "summary", "detail", "category",
            "icon", "priority", "active", "source", "created_at", "updated_at",
            "occurred_at", "resolved_at", "expires_at", "scheduled_at", "all_day",
            "timestamp", "entity_id", "media_url", "media_type", "navigation",
            "subtitle", "body", "visual_effect", "action", "source_id", "source_name", "source_kind", "home_device_id", "home_device_name", "entity_name", "event_type", "behavior", "state", "raw_state", "display_state", "capability", "stage", "raw_stage", "display_stage", "semantic", "presentation",
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
                    current = current[:240]
                compact[key] = current
            items.append(compact)
        return items
