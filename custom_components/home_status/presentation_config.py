"""Card-facing appearance and sizing defaults for Home Status."""

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

DEFAULTS: dict[str, Any] = {
    # Card dimensions and text/icon sizing. These are the current v0.3.24
    # values that were visually validated on the live tablet/desktop layout.
    "card_body_height": 380,
    "main_row_height": 150,
    "bottom_height": 102,
    "card_max_width": 0,
    "left_title_size": 48,
    "left_summary_size": 32,
    "left_icon_size": 60,
    "right_title_size": 48,
    "right_summary_size": 32,
    "right_icon_size": 60,
    "bottom_title_size": 26,
    "bottom_summary_size": 21,
    "bottom_icon_size": 38,
    "emphasize_measurements": True,
    "left_measurement_size": 72,
    "right_measurement_size": 72,
    "right_weather_size": 72,
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
    "timestamp_other": False,
    # Recorder-backed recent-history window.
    "ticker_event_minutes": 10,
    # Visual Center remains absent until a valid visual is available. This
    # option only controls whether the presentation layer may show a winner.
    "visual_center_enabled": True,
    # Actual on-screen Visual Center turn durations. The shared scheduler
    # remains source-fair; these user settings control how long each source
    # type keeps its turn before the next normal-priority source advances.
    "visual_event_duration": 6,
    "visual_news_duration": 12,
    "visual_stream_duration": 24,
}

def option(options: dict[str, Any], key: str) -> Any:
    """Return a presentation option with its factory default."""
    value = options.get(key, DEFAULTS.get(key))
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
            "other": bool(option(options, "timestamp_other")),
        },
    }
