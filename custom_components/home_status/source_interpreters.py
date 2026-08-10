"""Interpret non-device Sources into normalized Home Status awareness items."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant

from .source import HomeSource


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _friendly_schedule(value: Any, all_day: bool) -> str:
    """Return a stable human-facing absolute schedule label."""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    day = f"{parsed.strftime('%a, %b')} {parsed.day}"
    if all_day or (len(text) == 10 and text[4:5] == '-' and text[7:8] == '-'):
        return day
    time_label = parsed.strftime("%I:%M %p").lstrip("0")
    return f"{day} · {time_label}"


def _item(
    source: HomeSource,
    state,
    *,
    message: str,
    detail: str,
    icon: str,
    category: str,
) -> dict[str, Any]:
    return {
        "id": f"home_status:{source.id}:awareness",
        "source_id": source.id,
        "source_name": source.name,
        "entity_id": source.entity_id,
        "event_type": "awareness",
        "title": message,
        "message": message,
        "summary": detail,
        "detail": detail,
        "category": category,
        "source": "source",
        "source_kind": source.kind,
        "priority": "normal",
        "icon": icon,
        "active": False,
        "state": state.state,
        "created_at": state.last_changed.isoformat() if state.last_changed else _now(),
        "ticker_eligible": True,
    }


def household_presence_item(hass: HomeAssistant, person_ids: list[str]) -> dict[str, Any] | None:
    """Build one household-level presence summary from selected people."""
    people = []
    for entity_id in person_ids:
        state = hass.states.get(entity_id)
        if state is None or str(state.state).casefold() in {"unknown", "unavailable"}:
            continue
        name = str(state.attributes.get("friendly_name") or entity_id.split(".", 1)[-1].replace("_", " ").title())
        people.append((name, str(state.state).casefold(), state))
    if not people:
        return None

    home = [name for name, location, _state in people if location == "home"]
    away = [name for name, location, _state in people if location != "home"]
    if len(home) == len(people):
        title = "Everyone Home"
        detail = ", ".join(home)
        icon = "mdi:home-account"
    elif not home:
        title = "Everyone Away"
        detail = ", ".join(away)
        icon = "mdi:map-marker-account"
    else:
        title = f"{len(home)} of {len(people)} Home"
        detail = f"{', '.join(home)} home · {', '.join(away)} away"
        icon = "mdi:map-marker-account"

    changed = max(
        (state.last_changed for _name, _location, state in people if state.last_changed),
        default=None,
    )
    return {
        "id": "home_status:household_presence:awareness",
        "source_id": "household_presence",
        "source_name": "Household presence",
        "entity_id": None,
        "event_type": "awareness",
        "title": title,
        "message": title,
        "summary": detail,
        "detail": detail,
        "category": "location",
        "source": "household_presence",
        "source_kind": "location",
        "priority": "normal",
        "icon": icon,
        "active": False,
        "state": "home" if len(home) == len(people) else "away" if not home else "mixed",
        "created_at": changed.isoformat() if changed else _now(),
        "ticker_eligible": True,
        "person_ids": [state.entity_id for _name, _location, state in people],
    }


def interpret_source(hass: HomeAssistant, source: HomeSource) -> list[dict[str, Any]]:
    """Return the current useful awareness item for one selected Source."""
    state = hass.states.get(source.entity_id)
    if state is None or str(state.state).casefold() in {"unknown", "unavailable"}:
        return []

    attrs = state.attributes

    if source.domain == "weather":
        condition = str(state.state).replace("_", " ").title()
        temperature = attrs.get("temperature")
        unit = attrs.get("temperature_unit") or attrs.get("unit_of_measurement") or ""
        value = f"{round(float(temperature))}{unit}" if temperature is not None else condition
        return [_item(
            source,
            state,
            message=value,
            detail=condition,
            icon=str(attrs.get("icon") or "mdi:weather-partly-cloudy"),
            category="weather",
        )]

    if source.domain == "calendar":
        summary = attrs.get("message") or attrs.get("summary")
        if not summary:
            return []
        start = (
            attrs.get("start_time")
            or attrs.get("start")
            or attrs.get("start_date")
            or attrs.get("start_datetime")
        )
        item = _item(
            source,
            state,
            message=str(summary),
            detail=source.name,
            icon=str(attrs.get("icon") or "mdi:calendar"),
            category="calendar",
        )
        if start:
            item["scheduled_at"] = str(start)
            # Prefer Home Assistant's explicit all_day attribute. Fall back to
            # date-only detection for integrations that do not provide it.
            explicit_all_day = attrs.get("all_day")
            if explicit_all_day is None:
                item["all_day"] = len(str(start).strip()) == 10
            else:
                item["all_day"] = bool(explicit_all_day)
            # Keep the exact timestamp above as the contract. This friendly
            # summary is a compatibility fallback for older card resources.
            friendly = _friendly_schedule(start, item["all_day"])
            item["summary"] = f"{source.name} · {friendly}" if friendly else source.name
            item["detail"] = item["summary"]
        return [item]

    if source.domain == "person":
        location = str(state.state).replace("_", " ").title()
        return [_item(
            source,
            state,
            message=f"{source.name}: {location}",
            detail=location,
            icon=str(attrs.get("icon") or "mdi:account"),
            category="location",
        )]

    if source.domain == "zone":
        try:
            count = int(float(state.state))
        except (TypeError, ValueError):
            return []
        noun = "person" if count == 1 else "people"
        return [_item(
            source,
            state,
            message=f"{source.name}: {count} {noun}",
            detail=f"{count} {noun} in {source.name}",
            icon=str(attrs.get("icon") or "mdi:map-marker-account"),
            category="location",
        )]

    return []
