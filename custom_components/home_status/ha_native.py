"""Read Home Assistant state and Recorder history without owning either.

Home Status deliberately keeps no copy of entity lifecycle data.  The helpers
here turn Home Assistant's current state machine and Recorder rows into a small
wire contract for the card: current facts and recent state transitions.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import partial
from typing import Any, Callable

from homeassistant.components.recorder import get_instance, history
from homeassistant.core import HomeAssistant, State
from homeassistant.helpers import entity_registry as er


_MEASUREMENT_DEVICE_CLASSES = frozenset({
    "apparent_power", "aqi", "atmospheric_pressure", "battery", "carbon_dioxide",
    "carbon_monoxide", "current", "distance", "energy", "energy_distance",
    "energy_storage", "frequency", "gas", "humidity", "illuminance",
    "irradiance", "moisture", "monetary", "nitrogen_dioxide", "nitrogen_monoxide",
    "nitrous_oxide", "ozone", "ph", "pm1", "pm10", "pm25", "power",
    "power_factor", "precipitation", "precipitation_intensity", "pressure",
    "reactive_energy", "reactive_power", "signal_strength", "sound_pressure",
    "speed", "temperature", "timestamp", "volatile_organic_compounds",
    "voltage", "volume", "volume_flow_rate", "volume_storage", "water",
    "weight", "wind_speed",
})

_CATEGORY_ALIASES = {
    "calendar": "schedule",
    "sprinklers": "schedule",
    "fault": "maintenance",
}

_PRIORITY_RANK = {
    "critical": 0,
    "attention": 1,
    "activity": 2,
    "normal": 3,
}


def present_current_items(
    items: list[dict[str, Any]], options: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Publish complete, card-ready current items from HA facts."""
    return [
        _present_item(item, current=True, options=options)
        for item in items
        if isinstance(item, dict)
        and (
            item.get("attention") not in {None, "none"}
            or item.get("capability") in {"appliance_cycle", "easystart_current"}
            or _is_active_irrigation_valve_fact(item)
        )
    ]


def _is_active_irrigation_valve_fact(item: dict[str, Any]) -> bool:
    """Return True for an explicitly irrigation-like valve that is currently open."""
    entity_id = str(item.get("entity_id") or "").casefold()
    name = str(item.get("entity_name") or "").casefold()
    domain = str(item.get("domain") or entity_id.split(".", 1)[0]).casefold()
    state = str(item.get("state") or "").casefold()
    context = f"{entity_id} {name}"
    return (
        domain == "valve"
        and state in {"open", "opening", "on"}
        and (
            item.get("capability") == "irrigation_valve"
            or any(hint in context for hint in ("sprinkler", "irrigation", "watering"))
        )
    )


def present_recent_items(
    items: list[dict[str, Any]], options: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Publish complete, card-ready Recorder transitions, grouped when useful."""
    presented = [
        _present_item(item, current=False, options=options)
        for item in items
        if isinstance(item, dict)
    ]
    return _group_contact_closures(presented)


def present_awareness_items(
    items: list[dict[str, Any]], options: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """Complete the provider-neutral awareness contract before publication."""
    result: list[dict[str, Any]] = []
    for index, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        item = dict(raw)
        raw_category = str(item.get("category") or "activity").casefold()
        category = _final_category(raw_category)
        entity_id = str(item.get("entity_id") or "")
        priority = str(item.get("priority") or "normal").casefold()
        device_class = str(item.get("device_class") or "").casefold()
        if device_class in {"temperature", "humidity"} and category in {
            "activity", "environment", "sensor",
        }:
            category = "climate"
        item["id"] = item.get("id") or f"native:awareness:{entity_id or category}:{index}"
        item["title"] = _final_title(item)
        item["message"] = item["title"]
        item["summary"] = str(item.get("summary") or item.get("detail") or "").strip()
        item["category"] = category
        source_kind = str(item.get("source_kind") or "").casefold()
        display_kind = str(item.get("display_kind") or "").casefold()
        if not display_kind:
            if source_kind == "news":
                display_kind = "local_news"
            elif item.get("scheduled_at"):
                display_kind = "scheduled"
            elif category == "weather" and priority in {"attention", "critical"}:
                display_kind = "weather_alert"
            elif category == "weather" and entity_id.startswith("weather."):
                display_kind = "current_weather"
            elif device_class == "temperature" or (
                category == "climate" and item["title"].endswith(("°F", "°C"))
            ):
                display_kind = "temperature"
            elif device_class in _MEASUREMENT_DEVICE_CLASSES:
                display_kind = "measurement"
            else:
                display_kind = "awareness"
        item["display_kind"] = display_kind
        item["color_role"] = str(
            item.get("color_role")
            or _awareness_color_role(item, raw_category, category, priority, display_kind)
        )
        has_timestamp = any(
            item.get(key)
            for key in ("occurred_at", "created_at", "updated_at", "timestamp")
        )
        item["timestamp_mode"] = str(
            item.get("timestamp_mode")
            or (
                "relative"
                if has_timestamp and _option_bool(options, "timestamp_other", False)
                else "none"
            )
        )
        if source_kind == "news":
            media_url = str(
                item.get("media_url")
                or item.get("image_url")
                or ""
            ).strip()
            if media_url:
                media_type = str(item.get("media_type") or "image").casefold()
                item["zone_visual"] = {
                    "type": "video" if media_type.startswith("video") else "image",
                    "url": media_url,
                    "article_url": str(
                        item.get("article_url")
                        or item.get("navigation")
                        or ""
                    ).strip(),
                    "mute": True,
                }
        if item.get("scheduled_at"):
            item["summary"] = ""
        item["utility_role"] = str(
            item.get("utility_role")
            or (
                "calendar"
                if raw_category == "calendar" or entity_id.startswith("calendar.")
                else "waste" if category == "waste" else ""
            )
        )
        item["event_type"] = item.get("event_type") or "native_awareness"
        item["active"] = False
        item["priority"] = priority
        result.append(item)
    return result


def compose_presentation_streams(
    current: list[dict[str, Any]],
    recent: list[dict[str, Any]],
    awareness: list[dict[str, Any]],
) -> dict[str, Any]:
    """Assign normalized items to card streams at the integration boundary."""
    active = _ranked_presentable(
        item for item in current
        if isinstance(item, dict) and item.get("active") is not False
    )
    rotating_current = [
        item for item in active if item.get("rotate_with_awareness") is True
    ]
    # Current household state belongs in the side lanes. The footer is a
    # historical surface and only receives Recorder-backed recent activity.
    shared_active = [
        item
        for item in active
        if item.get("rotate_with_awareness") is not True
    ]
    # EasyStart's two durable summaries are current measurements, but their
    # presentation follows the same left/right rotation as Location and other
    # useful context.  They do not pin both zones just because both are present.
    # Visual-only awareness remains available to Visual Center but must not be
    # squeezed into the shared left/right text lanes.
    text_awareness = [
        item for item in awareness
        if item.get("visual_only") is not True
    ]
    ranked_awareness = _ranked_presentable([*rotating_current, *text_awareness])
    # Awareness/utility information stays in the side lanes.  The footer has
    # one meaning only: recent Recorder-backed household events.

    # The six-slot lane engine consumes one ordered side-candidate stream.
    # Placement is a frontend layout concern; the integration only ranks
    # semantic candidates. Left/right streams remain part of the v1 contract
    # for the supported single-item lane mode.
    side_candidates: list[dict[str, Any]] = []
    seen_side_ids: set[str] = set()
    for item in [*shared_active, *ranked_awareness]:
        item_id = str(item.get("id") or "")
        if not item_id or item_id in seen_side_ids:
            continue
        seen_side_ids.add(item_id)
        side_candidates.append(item)

    if len(shared_active) >= 2:
        left = [shared_active[0]]
        right = [shared_active[1]]
    elif len(shared_active) == 1:
        left = [shared_active[0]]
        right = ranked_awareness
    else:
        left = ranked_awareness[::2]
        right = ranked_awareness[1::2]

    # Keep the live ticker intentionally short even when the user retains a
    # much deeper history.  Retained `recent` remains available to History;
    # only the newest 12 hours participate in the marquee.
    ticker_cutoff = (datetime.now(timezone.utc) - timedelta(hours=12)).timestamp()
    bottom_candidates = [
        item for item in recent
        if _presentable_item(item) and _item_timestamp(item) >= ticker_cutoff
    ]
    alarm_transitions = [
        item for item in bottom_candidates
        if str(item.get("event_type") or "").casefold() == "alarm_transition"
    ]
    newest_alarm = max(alarm_transitions, key=_item_timestamp, default=None)
    bottom = [
        item for item in bottom_candidates
        if str(item.get("event_type") or "").casefold() != "alarm_transition"
        or item is newest_alarm
    ]

    return {
        "side": [str(item["id"]) for item in side_candidates],
        "left": [str(item["id"]) for item in left],
        "right": [str(item["id"]) for item in right],
        "bottom": [str(item["id"]) for item in bottom],
        "phone_primary_id": str(shared_active[0]["id"]) if shared_active else "",
        "phone_fallback": {
            "id": "phone-home-normal",
            "title": "Home Normal",
            "message": "Home Normal",
            "summary": "No active alerts",
            "icon": "mdi:check-circle-outline",
            "priority": "normal",
            "color_role": "success",
            "active": False,
            "timestamp_mode": "none",
            "display_kind": "status",
        },
    }


def _ranked_presentable(items: Any) -> list[dict[str, Any]]:
    indexed = [
        (index, item)
        for index, item in enumerate(items)
        if _presentable_item(item)
    ]
    indexed.sort(
        key=lambda entry: (
            _PRIORITY_RANK.get(
                str(entry[1].get("priority") or "normal").casefold(), 3
            ),
            entry[0],
        )
    )
    return [item for _, item in indexed]


def _presentable_item(item: Any) -> bool:
    if not isinstance(item, dict) or not item.get("id"):
        return False
    item_id = str(item.get("id") or "").casefold()
    source_kind = str(item.get("source_kind") or "").casefold()
    if source_kind == "internal" or ":overflow:" in item_id or ":diagnostic_record:" in item_id:
        return False
    label = str(
        item.get("display_name")
        or item.get("title")
        or item.get("message")
        or item.get("entity_name")
        or ""
    ).strip()
    return bool(label) and label.casefold() != "undefined"


def _item_timestamp(item: dict[str, Any]) -> float:
    raw = next(
        (
            item.get(key)
            for key in ("occurred_at", "created_at", "updated_at", "timestamp")
            if item.get(key)
        ),
        None,
    )
    if isinstance(raw, datetime):
        value = raw
    else:
        try:
            value = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return 0.0
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.timestamp()


def _final_title(item: dict[str, Any]) -> str:
    value = str(
        item.get("display_name")
        or item.get("title")
        or item.get("message")
        or "Home notification"
    ).strip()
    return {
        "Dryer Finished": "Dryer Complete",
        "Washer Finished": "Washer Complete",
        "Dishwasher Finished": "Dishwasher Complete",
        "Everything Looks Good": "Home Normal",
    }.get(value, value)


def _final_category(value: Any) -> str:
    raw = str(value or "activity").casefold()
    return _CATEGORY_ALIASES.get(raw, raw)


def _awareness_color_role(
    item: dict[str, Any], raw_category: str, category: str,
    priority: str, display_kind: str,
) -> str:
    if priority == "critical":
        return "security"
    if priority == "attention":
        return "attention"
    if raw_category == "sprinklers":
        return "irrigation"
    if category == "waste" and (
        "recycle" in str(item.get("icon") or "").casefold()
        or "recycl" in str(item.get("title") or "").casefold()
    ):
        return "recycling"
    device_class = str(item.get("device_class") or "").casefold()
    if display_kind in {"temperature", "indoor_temperature"} or device_class == "humidity":
        return "climate"
    return {
        "weather": "weather", "waste": "waste", "irrigation": "irrigation",
        "schedule": "calendar", "news": "news", "climate": "climate",
        "traffic": "traffic",
        "energy": "energy", "laundry": "appliance", "appliance": "appliance",
        "media": "media", "maintenance": "attention",
    }.get(category, "")


def _present_item(
    item: dict[str, Any], *, current: bool, options: dict[str, Any] | None
) -> dict[str, Any]:
    """Apply Home Status semantics once, at the integration boundary."""
    entity_id = str(item.get("entity_id") or "")
    name = str(item.get("entity_name") or "Home item").strip() or "Home item"
    domain = str(item.get("domain") or entity_id.split(".", 1)[0]).casefold()
    device_class = str(item.get("device_class") or "").casefold()
    appliance = item.get("capability") == "appliance_cycle"
    irrigation_transition = (not current and item.get("capability") == "irrigation_valve")
    easystart = item.get("capability") == "easystart_fault"
    easystart_current = item.get("capability") == "easystart_current"
    state = str(item.get("state") if current else item.get("to") or "").strip()
    if appliance and state.casefold() in {"completed", "finished", "done"}:
        state = "Complete"
    attention = str(item.get("attention") or "none").casefold()
    irrigation_valve = current and _is_active_irrigation_valve_fact(item)
    category = (
        _appliance_category(name, entity_id)
        if appliance
        else "maintenance"
        if easystart
        else "climate"
        if easystart_current
        else "irrigation"
        if irrigation_valve or irrigation_transition
        else _native_category(domain, device_class)
    )
    priority = "activity" if irrigation_valve else "normal" if easystart_current else _item_priority(appliance, current, attention, state)
    display_kind = "easystart_current" if easystart_current else "easystart_fault" if easystart else "appliance_current" if appliance and current else "appliance_transition" if appliance else "contact_transition" if not current and device_class in {"door", "window", "opening", "garage_door"} else "current_state" if current else "state_transition"
    label = state or "Unknown"
    if easystart_current:
        title = name
    elif easystart:
        owner = name if "easystart" in name.casefold() else f"{name} EasyStart"
        title = f"{owner}: {label}"
    elif irrigation_valve:
        title = f"{name} Watering"
    elif irrigation_transition:
        title = f"{name} Watering Stopped"
    else:
        title = label if domain == "alarm_control_panel" else f"{name} {label}"
    item_id = (
        f"native:current:{entity_id}:{item.get('easystart_group')}"
        if current and easystart_current
        else f"native:current:{entity_id}"
        if current
        else f"native:recent:{entity_id}:{item.get('changed_at', '')}"
    )
    safety_alert = current and (
        easystart
        or
        domain == "alarm_control_panel"
        or device_class in {
            "moisture", "smoke", "gas", "carbon_monoxide", "safety",
        }
    ) and priority in {"critical", "attention"}
    contact_item = device_class in {"door", "window", "opening", "garage_door"}
    if contact_item:
        show_timestamp = _option_bool(options, "timestamp_contacts", True)
    else:
        show_timestamp = not current
    # Active safety/alarm conditions always need age context. Contact timestamp
    # visibility follows the user's v1 timestamp setting.
    timestamp_mode = "relative" if safety_alert or show_timestamp else "none"
    return {
        "id": item_id,
        "entity_id": entity_id,
        "entity_name": name,
        "title": title,
        "message": title,
        "summary": "Sprinkler zone is watering" if irrigation_valve else "Watering finished" if irrigation_transition else str(item.get("detail") or "") if easystart or easystart_current else _item_summary(item, appliance, current, state),
        "icon": "mdi:sprinkler-variant" if irrigation_valve or irrigation_transition else "mdi:air-conditioner" if easystart or easystart_current else _native_icon(domain, device_class, state, name) if not appliance else _appliance_icon(name, entity_id),
        "category": category,
        "color_role": _color_role(category, priority, state, current),
        "priority": priority,
        "active": current,
        "state": state,
        "created_at": item.get("changed_at"),
        "event_type": "native_irrigation_current" if irrigation_valve else "native_irrigation_transition" if irrigation_transition else "native_easystart_current" if easystart or easystart_current else "native_appliance_current" if appliance and current else "native_current" if current else "native_transition",
        "timestamp_mode": timestamp_mode,
        "display_kind": display_kind,
        "capability": item.get("capability"),
        "source": "home_assistant",
        "rotate_with_awareness": easystart_current,
        "utility_role": "security" if category == "security" else "",
        # Recent footer events should open the broadest useful native HA
        # history context. If Recorder's originating entity belongs to a real
        # HA device, open that device page (combined Activity). Standalone
        # entities fall back to HA More Info / Activity. Current/live items
        # keep their normal operational navigation.
        "history_target": "device" if (not current and item.get("device_id")) else "entity",
        "device_id": item.get("device_id"),
    }


def _option_bool(options: dict[str, Any] | None, key: str, default: bool) -> bool:
    if not isinstance(options, dict) or key not in options:
        return default
    return bool(options[key])


def _item_priority(appliance: bool, current: bool, attention: str, state: str) -> str:
    if current:
        return "activity" if appliance else attention
    if appliance and state.casefold() in {"fault", "alert", "error"}:
        return "attention"
    return "activity"


def _item_summary(
    item: dict[str, Any], appliance: bool, current: bool, state: str
) -> str:
    if appliance and current:
        return str(item.get("detail") or state)
    if appliance and state.casefold() == "complete":
        return "Cycle complete"
    if appliance and state.casefold() in {"fault", "alert", "error"}:
        return "Appliance requires attention"
    return ""


def _native_category(domain: str, device_class: str) -> str:
    if domain in {"alarm_control_panel", "lock"} or device_class in {
        "door", "window", "opening", "garage_door", "smoke", "gas",
        "carbon_monoxide", "moisture", "safety",
    }:
        return "security"
    if device_class in {"problem", "connectivity"}:
        return "maintenance"
    return "activity"


def _native_icon(domain: str, device_class: str, state: str, _name: str) -> str:
    active = state.casefold() in {
        "on", "open", "opened", "unlocked", "triggered", "detected",
        "unsafe", "problem", "disconnected", "motion detected", "occupied",
        "present", "vibration detected",
    }
    if device_class in {"door", "garage_door"}: return "mdi:door-open" if active else "mdi:door-closed"
    if device_class in {"window", "opening"}: return "mdi:window-open-variant" if active else "mdi:window-closed-variant"
    if device_class == "moisture": return "mdi:water-alert" if active else "mdi:water-check"
    if device_class == "smoke": return "mdi:smoke-detector-alert" if active else "mdi:smoke-detector"
    if device_class == "gas": return "mdi:gas-cylinder" if active else "mdi:check-circle-outline"
    if device_class == "carbon_monoxide": return "mdi:molecule-co" if active else "mdi:check-circle-outline"
    if device_class == "problem": return "mdi:alert-circle" if active else "mdi:check-circle-outline"
    if device_class == "safety": return "mdi:shield-alert" if active else "mdi:shield-check"
    if device_class in {"motion", "occupancy", "presence"}: return "mdi:motion-sensor" if active else "mdi:motion-sensor-off"
    if device_class == "connectivity": return "mdi:lan-disconnect" if active else "mdi:lan-connect"
    if domain == "lock": return "mdi:lock-open-variant" if active else "mdi:lock"
    if domain == "alarm_control_panel":
        normalized = state.casefold()
        if "triggered" in normalized or normalized == "pending":
            return "mdi:shield-alert"
        if "armed" in normalized:
            return "mdi:shield-lock"
        return "mdi:shield-check"
    return "mdi:information-outline"


def _appliance_icon(name: str, entity_id: str) -> str:
    value = f"{name} {entity_id}".casefold()
    if "dishwasher" in value: return "mdi:dishwasher"
    if "dryer" in value: return "mdi:tumble-dryer"
    return "mdi:washing-machine"


def _appliance_category(name: str, entity_id: str) -> str:
    value = f"{name} {entity_id}".casefold()
    return "appliance" if "dishwasher" in value else "laundry"


def _color_role(category: str, priority: str, state: str, current: bool) -> str:
    normalized = state.casefold()
    if priority == "critical":
        return "security"
    if category == "security":
        return "success" if normalized in {"closed", "locked", "clear", "safe", "connected", "alarm off", "disarmed", "off"} else "security"
    if category == "irrigation":
        return "irrigation" if current else "success"
    if category in {"laundry", "appliance"}:
        return "appliance" if current else "success" if normalized == "complete" else "attention" if normalized in {"fault", "alert", "error"} else "appliance"
    if priority == "attention":
        return "attention"
    if category == "maintenance":
        return "success" if normalized in {"normal", "connected", "clear", "off"} else "attention"
    return ""


def _group_contact_closures(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Condense near-simultaneous closure transitions before publishing them."""
    result: list[dict[str, Any]] = []
    used: set[int] = set()
    for index, item in enumerate(items):
        if index in used:
            continue
        is_closure = item.get("display_kind") == "contact_transition" and str(item.get("state") or "").casefold() == "closed"
        if not is_closure:
            result.append(item); continue
        stamp = _parse_timestamp(item.get("created_at"))
        group = [(index, item)]
        for next_index in range(index + 1, len(items)):
            candidate = items[next_index]
            candidate_stamp = _parse_timestamp(candidate.get("created_at"))
            if candidate.get("display_kind") == "contact_transition" and str(candidate.get("state") or "").casefold() == "closed" and stamp and candidate_stamp and abs((stamp - candidate_stamp).total_seconds()) <= 120:
                group.append((next_index, candidate))
        if len(group) == 1:
            result.append(item); continue
        used.update(entry[0] for entry in group[1:])
        labels = [str(entry[1].get("entity_name") or "").strip() for entry in group]
        result.append({**item, "id": f"native:recent:contact-group:{item.get('created_at')}", "title": f"{len(group)} Doors/Windows Closed", "message": f"{len(group)} Doors/Windows Closed", "summary": "", "icon": "mdi:door-closed", "display_kind": "contact_group", "group_labels": [label for label in labels if label]})
    return result


def _parse_timestamp(value: Any) -> datetime | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def current_states(
    hass: HomeAssistant,
    entity_ids: tuple[str, ...],
    name_for_entity: Callable[[str], str | None] | None = None,
) -> list[dict[str, Any]]:
    """Return the current HA facts for the configured entities.

    ``last_changed`` is intentionally sent unchanged.  Relative time belongs in
    the client so a display can age without a coordinator republish.
    """
    return [
        _state_fact(state, name_for_entity)
        for entity_id in entity_ids
        if (state := hass.states.get(entity_id)) is not None
    ]


def transition_entity_ids(
    hass: HomeAssistant, entity_ids: tuple[str, ...]
) -> tuple[str, ...]:
    """Return only entities whose transitions can be meaningful activity."""
    return tuple(
        entity_id
        for entity_id in entity_ids
        if (state := hass.states.get(entity_id)) is not None
        and _is_transition_entity(entity_id, state)
    )


async def async_recent_transitions(
    hass: HomeAssistant,
    entity_ids: tuple[str, ...],
    start_time: datetime,
    name_for_entity: Callable[[str], str | None] | None = None,
) -> list[dict[str, Any]]:
    """Read significant changes from HA Recorder for configured entities only.

    Recorder is optional.  An unavailable, disabled, or excluded Recorder
    simply produces no recent activity; Home Status must never replace it with
    private event persistence.
    """
    if not entity_ids:
        return []

    end_time = datetime.now(timezone.utc)
    query = partial(
        history.get_significant_states,
        hass,
        start_time,
        end_time,
        entity_ids=list(entity_ids),
        include_start_time_state=True,
        significant_changes_only=True,
        minimal_response=False,
        no_attributes=True,
    )
    try:
        states_by_entity = await get_instance(hass).async_add_executor_job(query)
    except Exception:  # Recorder is an optional source of recent activity.
        return []

    transitions: list[dict[str, Any]] = []
    entity_registry = er.async_get(hass)
    for entity_id, states in states_by_entity.items():
        previous: State | None = None
        current = hass.states.get(entity_id)
        registry_entry = entity_registry.async_get(entity_id)
        device_id = registry_entry.device_id if registry_entry is not None else None
        for state in states:
            if (
                previous is not None
                and state.state != previous.state
                and _is_meaningful_transition(entity_id, previous, state, current)
            ):
                fact = _transition_fact(
                    entity_id, previous, state, current, name_for_entity
                )
                if device_id:
                    fact["device_id"] = device_id
                transitions.append(fact)
            previous = state
    ordered = sorted(transitions, key=lambda item: item["changed_at"], reverse=True)
    # Recorder remains the authority for the facts. The ticker needs the newest
    # fact for each entity, not a replay of one entity's entire state sequence.
    latest: list[dict[str, Any]] = []
    seen_entity_ids: set[str] = set()
    for item in ordered:
        entity_id = item["entity_id"]
        if entity_id in seen_entity_ids:
            continue
        seen_entity_ids.add(entity_id)
        latest.append(item)
    return latest


def _is_meaningful_transition(
    entity_id: str,
    old_state: State,
    new_state: State,
    current: State | None,
) -> bool:
    """Keep state changes that can be presented as household activity.

    Availability is infrastructure state, not an event in the home. Numeric
    telemetry is useful as current truth but would drown a recent-activity feed.
    Stateful sensors (for example a washer status sensor) remain eligible.
    """
    if {old_state.state, new_state.state} & {"unknown", "unavailable"}:
        return False

    if current is None or not _is_transition_entity(entity_id, current):
        return False
    if entity_id.split(".", 1)[0] != "sensor":
        return True
    try:
        float(old_state.state)
        float(new_state.state)
    except (TypeError, ValueError):
        return True
    return False


def _is_transition_entity(entity_id: str, state: State) -> bool:
    domain = entity_id.split(".", 1)[0]
    if domain in {"binary_sensor", "lock", "alarm_control_panel", "valve"}:
        return True
    return domain == "sensor" and state.attributes.get("device_class") not in _MEASUREMENT_DEVICE_CLASSES


def _state_fact(
    state: State, name_for_entity: Callable[[str], str | None] | None
) -> dict[str, Any]:
    entity_id = state.entity_id
    return {
        "entity_id": entity_id,
        "entity_name": _entity_name(state, name_for_entity),
        "domain": entity_id.split(".", 1)[0],
        "device_class": state.attributes.get("device_class"),
        "state": _state_label(state.state, entity_id, state.attributes, transition=False),
        "changed_at": state.last_changed.isoformat(),
        "attention": _attention_for(state),
    }


def _transition_fact(
    entity_id: str,
    old_state: State,
    new_state: State,
    current: State | None,
    name_for_entity: Callable[[str], str | None] | None,
) -> dict[str, Any]:
    attributes = current.attributes if current is not None else new_state.attributes
    return {
        "entity_id": entity_id,
        "entity_name": _entity_name(new_state, name_for_entity),
        "domain": entity_id.split(".", 1)[0],
        "device_class": attributes.get("device_class"),
        "from": _state_label(old_state.state, entity_id, attributes, transition=True),
        "to": _state_label(new_state.state, entity_id, attributes, transition=True),
        "changed_at": new_state.last_changed.isoformat(),
    }


def _entity_name(
    state: State, name_for_entity: Callable[[str], str | None] | None
) -> str:
    """Resolve one user-facing name without retaining any entity lifecycle."""
    configured = name_for_entity(state.entity_id) if name_for_entity else None
    if configured and configured.strip():
        return configured.strip()
    friendly = str(state.attributes.get("friendly_name") or "").strip()
    if friendly and friendly != state.entity_id:
        return friendly
    return state.entity_id.split(".", 1)[-1].replace("_", " ").title()


def _state_label(
    value: str,
    entity_id: str,
    attributes: dict[str, Any],
    *,
    transition: bool,
) -> str:
    """Turn one HA value into a display label; no lifecycle state is retained."""
    raw = str(value or "").strip()
    canonical = raw.casefold()
    domain = entity_id.split(".", 1)[0]
    device_class = str(attributes.get("device_class") or "").casefold()

    if device_class in {"door", "window", "opening", "garage_door"}:
        if canonical == "on":
            return "Opened" if transition else "Open"
        if canonical == "off":
            return "Closed"
    binary_labels = {
        "moisture": ("Detected", "Clear"),
        "smoke": ("Detected", "Clear"),
        "gas": ("Detected", "Clear"),
        "carbon_monoxide": ("Detected", "Clear"),
        "problem": ("Problem", "Normal"),
        "safety": ("Unsafe", "Safe"),
        "motion": ("Motion detected", "Clear"),
        "occupancy": ("Occupied", "Clear"),
        "presence": ("Present", "Clear"),
        "vibration": ("Vibration detected", "Clear"),
        "connectivity": ("Connected", "Disconnected"),
    }
    if device_class in binary_labels and canonical in {"on", "off"}:
        on_label, off_label = binary_labels[device_class]
        return on_label if canonical == "on" else off_label
    if domain == "lock":
        return {"locked": "Locked", "unlocked": "Unlocked"}.get(canonical, _humanize(raw))
    if domain == "alarm_control_panel":
        return {
            "disarmed": "Alarm off", "armed_away": "Alarm armed away",
            "armed_home": "Alarm armed home", "armed_night": "Alarm armed night",
            "arming": "Alarm arming", "pending": "Pending", "triggered": "Alarm triggered",
        }.get(canonical, _humanize(raw))
    return _humanize(raw)


def _humanize(value: str) -> str:
    return " ".join(part.capitalize() for part in value.replace("-", "_").split("_") if part)


def _attention_for(state: State) -> str:
    """Classify only the current HA condition; never create or retain events."""
    domain = state.entity_id.split(".", 1)[0]
    device_class = str(state.attributes.get("device_class") or "").lower()
    value = state.state.lower()
    if domain == "alarm_control_panel" and value == "triggered":
        return "critical"
    if domain == "binary_sensor" and value == "on":
        if device_class in {"smoke", "gas", "carbon_monoxide", "moisture", "safety"}:
            return "critical"
        if device_class in {"door", "window", "opening", "garage_door", "problem"}:
            return "attention"
    if domain == "binary_sensor" and value == "off" and device_class == "connectivity":
        return "attention"
    if domain == "lock" and value == "unlocked":
        return "attention"
    return "none"
