"""User-configurable presentation placement for Home Status.

Names are intentionally physical and memorable: left, right, bottom.
"""

from __future__ import annotations

from typing import Any

from .presentation_config import ROUTING_DEFAULTS, option


_PRIORITY = {"critical": 0, "attention": 1, "activity": 2, "normal": 3}


def _sort(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        items,
        key=lambda item: (
            _PRIORITY.get(str(item.get("priority") or "normal"), 3),
            str(item.get("created_at") or item.get("resolved_at") or ""),
        ),
    )


def _routing_key(item: dict[str, Any]) -> str:
    event_type = str(item.get("event_type") or "").casefold()
    category = str(item.get("category") or "").casefold()
    source_kind = str(item.get("source_kind") or "").casefold()
    text = " ".join(
        str(item.get(key) or "")
        for key in ("title", "message", "summary", "entity_name", "entity_id", "icon")
    ).casefold()
    active = item.get("active") is True

    if event_type == "contact":
        opening = "window" if "window" in text else "door"
        state = "open" if active else "closed"
        return f"{opening}s_{state}"
    if event_type in {"appliance_cycle", "appliance_complete"} or category in {"laundry", "appliance"}:
        if active and event_type != "appliance_complete":
            return "appliances_running"
        return "appliances_complete"
    if category == "security":
        return "security"
    if category == "weather":
        return "weather"
    if category in {"climate", "hvac"} or "humidity" in text or "temperature" in text:
        return "climate"
    if category == "waste" or any(word in text for word in ("garbage", "trash", "recycl")):
        return "waste"
    if category in {"calendar", "schedule"} or source_kind == "calendar":
        return "calendar"
    if category == "news" or source_kind in {"news", "rss", "atom"}:
        return "news"
    if category in {"irrigation", "sprinkler"} or any(word in text for word in ("sprinkler", "watering", "rain delay")):
        return "irrigation"
    if category == "location":
        return "location"
    return "other"


def _destinations(item: dict[str, Any], options: dict[str, Any]) -> list[str]:
    key = _routing_key(item)
    value = options.get(f"route_{key}")
    if isinstance(value, list):
        return [str(destination) for destination in value if str(destination) in {"left", "right", "bottom"}]
    return list(ROUTING_DEFAULTS.get(key, ROUTING_DEFAULTS["other"]))


def place_items(
    active: list[dict[str, Any]],
    recent: list[dict[str, Any]] | None = None,
    awareness: list[dict[str, Any]] | None = None,
    options: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """Return left, right, bottom using explicit user-configurable placement."""
    recent = recent or []
    awareness = awareness or []
    options = options or {}
    ordered = _sort(active)
    candidates = _dedupe([*ordered, *recent, *awareness])

    left: list[dict[str, Any]] = []
    right: list[dict[str, Any]] = []
    bottom: list[dict[str, Any]] = []

    for item in candidates:
        destinations = _destinations(item, options)
        if "left" in destinations:
            left.append(item)
        if "right" in destinations:
            right.append(item)
        if "bottom" in destinations:
            bottom.append(item)

    # Critical/attention items retain the current takeover behavior on the left.
    # This does not override a user's destination choice: it only applies to
    # urgent items that are themselves routed to the left area.
    urgent_left = [
        item for item in left
        if item.get("active") is True
        and str(item.get("priority") or "normal") in {"critical", "attention"}
    ]
    if urgent_left:
        left = urgent_left

    # Preserve the current v0.3.24 behavior when requested: if nothing has been
    # routed left, promote one useful item from the right instead of showing an
    # empty half-card. This is a named setting, not an implicit "smart" mode.
    if not left and bool(option(options, "fill_empty_left")) and right:
        promoted = right.pop(0)
        left.append(promoted)

    return _dedupe(left), _dedupe(right), _dedupe(bottom)


def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = str(item.get("id") or f"{item.get('entity_id')}:{item.get('message')}")
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result
