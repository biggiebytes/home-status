from __future__ import annotations


import json
from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.const import MATCH_ALL
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import HomeStatusCoordinator

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
    # Home Status attributes are transient UI transport. Recorder history comes
    # from the underlying Home Assistant entities, not this composed snapshot.
    _unrecorded_attributes = frozenset({MATCH_ALL})
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
        # v1 publishes one manifest/control entity plus fixed split transport
        # channels. Do not duplicate the channel payloads on this entity.
        return {
            "health": data.get("health", "normal"),
            "priority": data.get("priority", "normal"),
            "active_count": int(data.get("active_count", 0) or 0),
            "display": self._compact_display(data.get("display")),
            "presentation": self._compact_presentation(data.get("presentation")),
            "transport": self._transport_manifest(data, data.get("native")),
        }

    @staticmethod
    def _transport_manifest(data: dict[str, Any], native: Any) -> dict[str, Any]:
        """Describe the fixed v1 transport channels."""
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
            for key in ("rotation_seconds", "visual_event_duration", "visual_news_duration", "visual_stream_duration", "media_enabled", "visual_center_enabled")
            if key in value
        }

    @staticmethod
    def _compact_presentation(value):
        if not isinstance(value, dict):
            return {}
        allowed = {"layout", "emphasis", "appearance"}
        return {key: value[key] for key in allowed if key in value and isinstance(value[key], dict)}

    @staticmethod
    def _compact_visual(value):
        if not isinstance(value, dict):
            return None
        return {
            key: value[key]
            for key in ("type", "transport", "url", "entity_id", "article_url", "title", "source", "source_id", "source_kind", "event_start", "event_end", "display_duration", "priority", "live", "started_at", "expires_at", "resumable", "mute")
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


class HomeStatusTransportSensor(CoordinatorEntity[HomeStatusCoordinator], SensorEntity):
    """One fixed, coordinator-backed payload boundary for the card."""

    # Split-channel payloads are live transport for the card, not history.
    # Excluding them from Recorder avoids the 16 KiB attribute limit without
    # deleting or capping anything the UI needs at runtime.
    _unrecorded_attributes = frozenset({MATCH_ALL})

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
                and str(item.get("source_kind") or "").casefold() != "events"
                and str(item.get("category") or "").casefold()
                not in {"weather", "calendar", "news"}
            ]
        if self._channel == "calendar":
            return [
                item for item in awareness
                if isinstance(item, dict)
                and (
                    str(item.get("source_kind") or "").casefold() == "events"
                    or str(item.get("category") or "").casefold() == "calendar"
                )
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
            "expires_at", "scheduled_at", "event_start", "event_end", "all_day", "timestamp", "timestamp_mode",
            "display_kind", "rotate_with_awareness", "group_labels", "utility_role",
            "image_url", "media_url", "media_type", "article_url", "navigation", "subtitle",
            "body", "visual_effect", "action", "visual", "zone_visual",
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
