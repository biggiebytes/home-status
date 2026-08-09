"""Presentation-safe fallback text for unknown integration values."""

from __future__ import annotations

import re
from typing import Any


def humanize_raw_value(value: Any) -> str:
    """Make unknown enum values readable without changing their raw meaning."""
    raw = str(value or "").strip()
    if not raw:
        return "Unknown"
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", raw)
    spaced = re.sub(r"[_-]+", " ", spaced)
    spaced = re.sub(r"([A-Za-z])(\d)", r"\1 \2", spaced)
    spaced = re.sub(r"(\d)([A-Za-z])", r"\1 \2", spaced)
    spaced = re.sub(r"\brinselevel\b", "rinse level", spaced, flags=re.IGNORECASE)
    return " ".join(word.upper() if word.casefold() in {"ha", "hvac", "wifi", "ai", "co"} else word.capitalize() for word in spaced.split()) or "Unknown"
