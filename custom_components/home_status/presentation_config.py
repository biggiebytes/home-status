"""User-configurable presentation defaults for Home Status.

These options are deliberately presentation-oriented. The runtime still produces
normalized Home Status items; this module only describes how those items should
be routed and rendered.
"""

from __future__ import annotations

from typing import Any


PALETTE = {
    "red": "#ef5350",
    "orange": "#ff9800",
    "amber": "#ffc107",
    "yellow": "#fdd835",
    "lime": "#cddc39",
    "green": "#66bb6a",
    "teal": "#26a69a",
    "cyan": "#26c6da",
    "sky": "#4fc3f7",
    "blue": "#42a5f5",
    "purple": "#ab47bc",
    "pink": "#ec407a",
    "white": "#d9dee2",
}

PALETTE_OPTIONS = [
    {"value": key, "label": label}
    for key, label in (
        ("red", "Red"),
        ("orange", "Orange"),
        ("amber", "Amber"),
        ("yellow", "Yellow"),
        ("lime", "Lime"),
        ("green", "Green"),
        ("teal", "Teal"),
        ("cyan", "Cyan"),
        ("sky", "Sky blue"),
        ("blue", "Blue"),
        ("purple", "Purple"),
        ("pink", "Pink"),
        ("white", "Neutral"),
    )
]

DESTINATION_OPTIONS = [
    {"value": "left", "label": "Left"},
    {"value": "right", "label": "Right"},
    {"value": "bottom", "label": "Bottom"},
]

# These defaults match the current v0.3.24 live presentation rather than
# pretending there is an automatic routing engine. Users can override each one.
ROUTING_DEFAULTS: dict[str, list[str]] = {
    "doors_open": ["left", "bottom"],
    "doors_closed": ["bottom"],
    "windows_open": ["left", "bottom"],
    "windows_closed": ["bottom"],
    "appliances_running": ["left", "bottom"],
    "appliances_complete": ["bottom"],
    "security": ["left", "bottom"],
    "weather": ["right", "bottom"],
    "climate": ["right", "bottom"],
    "waste": ["right", "bottom"],
    "calendar": ["right", "bottom"],
    "news": ["left", "bottom"],
    "irrigation": ["right", "bottom"],
    "location": ["right", "bottom"],
    "other": ["right", "bottom"],
}

DEFAULTS: dict[str, Any] = {
    # Card dimensions and text/icon sizing. These are the current v0.3.24
    # values that were visually validated on the live tablet/desktop layout.
    "card_body_height": 380,
    "main_row_height": 150,
    "bottom_height": 102,
    "card_max_width": 0,
    "left_title_size": 23,
    "left_summary_size": 15,
    "left_icon_size": 40,
    "right_title_size": 23,
    "right_summary_size": 15,
    "right_icon_size": 40,
    "bottom_title_size": 26,
    "bottom_summary_size": 21,
    "bottom_icon_size": 38,
    "emphasize_measurements": True,
    "left_measurement_size": 64,
    "right_measurement_size": 48,
    "right_weather_size": 44,
    "bottom_measurement_size": 38,
    # Color behavior.
    "semantic_colors": True,
    "color_security": "red",
    "color_appliance": "lime",
    "color_weather": "sky",
    "color_climate": "blue",
    "color_waste": "green",
    "color_recycling": "teal",
    "color_calendar": "purple",
    "color_irrigation": "teal",
    "color_news": "blue",
    "color_attention": "orange",
    "color_success": "green",
    # Timestamp behavior.
    "timestamp_contacts": True,
    "timestamp_appliance_complete": True,
    "timestamp_other": False,
    # Existing history/timing values.
    "ticker_event_minutes": 10,
    "history_retention_days": 7,
    # Explicit behavior: when left has nothing routed to it, preserve the
    # current v0.3.24 fallback that promotes one useful awareness item.
    "fill_empty_left": True,
    # Visual Center remains absent until a valid visual is available. This
    # option only controls whether the presentation layer may show a winner.
    "visual_center_enabled": True,
}

for _route_key, _destinations in ROUTING_DEFAULTS.items():
    DEFAULTS[f"route_{_route_key}"] = list(_destinations)


def option(options: dict[str, Any], key: str) -> Any:
    """Return a presentation option with its factory default."""
    value = options.get(key, DEFAULTS.get(key))
    if key.startswith("route_"):
        if not isinstance(value, list):
            return list(DEFAULTS.get(key, []))
        return [str(item) for item in value if str(item) in {"left", "right", "bottom"}]
    return value


def _int(options: dict[str, Any], key: str, minimum: int, maximum: int) -> int:
    try:
        value = int(option(options, key))
    except (TypeError, ValueError):
        value = int(DEFAULTS[key])
    return max(minimum, min(maximum, value))


def _color(options: dict[str, Any], key: str) -> str:
    name = str(option(options, key) or DEFAULTS[key])
    return PALETTE.get(name, PALETTE[str(DEFAULTS[key])])


def presentation_preferences(options: dict[str, Any]) -> dict[str, Any]:
    """Return the compact, card-facing presentation contract."""
    return {
        "layout": {
            "card_body_height": _int(options, "card_body_height", 220, 700),
            "main_row_height": _int(options, "main_row_height", 70, 280),
            "bottom_height": _int(options, "bottom_height", 54, 180),
            "card_max_width": _int(options, "card_max_width", 0, 3000),
            "left_title_size": _int(options, "left_title_size", 14, 72),
            "left_summary_size": _int(options, "left_summary_size", 10, 48),
            "left_icon_size": _int(options, "left_icon_size", 16, 80),
            "right_title_size": _int(options, "right_title_size", 14, 72),
            "right_summary_size": _int(options, "right_summary_size", 10, 48),
            "right_icon_size": _int(options, "right_icon_size", 16, 80),
            "bottom_title_size": _int(options, "bottom_title_size", 12, 56),
            "bottom_summary_size": _int(options, "bottom_summary_size", 10, 42),
            "bottom_icon_size": _int(options, "bottom_icon_size", 16, 72),
        },
        "emphasis": {
            "enabled": bool(option(options, "emphasize_measurements")),
            "left_measurement_size": _int(options, "left_measurement_size", 18, 100),
            "right_measurement_size": _int(options, "right_measurement_size", 18, 100),
            "right_weather_size": _int(options, "right_weather_size", 18, 90),
            "bottom_measurement_size": _int(options, "bottom_measurement_size", 14, 72),
        },
        "appearance": {
            "semantic_colors": bool(option(options, "semantic_colors")),
            "colors": {
                "security": _color(options, "color_security"),
                "appliance": _color(options, "color_appliance"),
                "weather": _color(options, "color_weather"),
                "climate": _color(options, "color_climate"),
                "waste": _color(options, "color_waste"),
                "recycling": _color(options, "color_recycling"),
                "calendar": _color(options, "color_calendar"),
                "irrigation": _color(options, "color_irrigation"),
                "news": _color(options, "color_news"),
                "attention": _color(options, "color_attention"),
                "success": _color(options, "color_success"),
            },
        },
        "timestamps": {
            "contacts": bool(option(options, "timestamp_contacts")),
            "appliance_complete": bool(option(options, "timestamp_appliance_complete")),
            "other": bool(option(options, "timestamp_other")),
        },
    }
