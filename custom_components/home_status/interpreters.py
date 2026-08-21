"""Conservative internal state interpreters for device-first Home Status.

Home Status should only publish states it understands. Secondary entities,
settings, helper sensors, and transient unavailable states are silent unless
there is a specific interpretation for them.
"""

from __future__ import annotations

from datetime import datetime, timezone
from math import ceil, isfinite
import re
from typing import Any

from homeassistant.core import HomeAssistant, State
from homeassistant.util import dt as dt_util

from .home_device import HomeDevice, HomeDeviceEntity
from .normalization import normalize_semantic_state, resolve_display_label


_RUNNING = {"run", "running", "washing", "drying", "cleaning", "active", "working"}
_COMPLETE = {"complete", "completed", "finished", "done", "end"}

_APPLIANCE_ALIASES = {
    "cleaning": {"state": "running", "display": "Cleaning"},
    "sensing": {"state": "running", "display": "Sensing"},
    "soaking": {"state": "running", "display": "Soaking"},
    "spinning": {"state": "running", "display": "Spinning"},
    "draining": {"state": "running", "display": "Draining"},
}

# Entity-name hints that identify the primary operating state of an appliance.
_APPLIANCE_STATE_HINTS = (
    "machine state", "machine_state",
    "operation state", "operation_state",
    "operating state", "operating_state",
    "current status", "current_status",
    "cycle state", "cycle_state",
    "cycle status", "cycle_status",
    "job state", "job_state",
    "job status", "job_status",
    "washer state", "dryer state", "dishwasher state",
)

_APPLIANCE_END_HINTS = (
    "end of cycle", "end_of_cycle",
    "cycle complete", "cycle_complete",
    "cycle completed", "cycle_completed",
    "cycle finished", "cycle_finished",
)

# Phase/status telemetry is useful only as supporting text for an active appliance.
# Deliberately exclude generic "cycle" entities because those usually describe the
# selected program (Normal, Towels, Perm Press), not what the machine is doing now.
_APPLIANCE_PHASE_HINTS = (
    "sub cycle", "sub_cycle",
    "phase",
    "stage",
)

# Settings/supporting telemetry should never become generic notifications.
_SUPPORTING_NAME_HINTS = (
    "chime", "sound", "volume", "remaining time", "total time", "delayed start",
    "delay start", "current cycle", "program", "temperature setting", "setpoint",
    "signal", "rssi", "wifi", "battery", "firmware", "diagnostic",
)

# Micro-Air EasyStart exposes one semantic protection status alongside several
# diagnostic measurements and two controls.  Identify the capability from the
# entity signature, never from the user's device name.
_EASYSTART_ROLE_SUFFIXES = {
    "status": "status",
    "live current": "live_current",
    "line frequency": "line_frequency",
    "last start peak": "last_start_peak",
    "scpt delay": "scpt_delay",
    "total faults": "total_faults",
    "total starts": "total_starts",
    "mcu temperature": "mcu_temperature",
    "wifi signal": "wifi_signal",
    "uptime": "uptime",
    "read status": "read_status",
    "restart esp": "restart_esp",
}

_EASYSTART_NONPRESENTATION_ROLES = frozenset(
    role for role in _EASYSTART_ROLE_SUFFIXES.values() if role != "status"
)

_GENERIC_DIAGNOSTIC_DEVICE_CLASSES = {
    "apparent_power", "battery", "current", "duration", "energy", "frequency",
    "power", "power_factor", "reactive_energy", "reactive_power",
    "signal_strength", "timestamp", "voltage",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _category_for(event_type: str, home_device: HomeDevice) -> str:
    """Return the presentation category for a device event."""
    appliance_label = _appliance_label(home_device).casefold()
    laundry = appliance_label in {"washer", "dryer"}
    return {
        "security": "security",
        "safety": "security",
        "contact": "security",
        "lock": "security",
        "presence": "security",
        "connectivity": "maintenance",
        "appliance_cycle": "laundry" if laundry else "appliance",
        "appliance_complete": "laundry" if laundry else "appliance",
    }.get(event_type, home_device.kind)


def _base(
    home_device: HomeDevice,
    entity: HomeDeviceEntity,
    state: State,
    *,
    event_type: str,
    message: str,
    detail: str,
    priority: str,
    active: bool,
    icon: str | None = None,
) -> dict[str, Any]:
    category = _category_for(event_type, home_device)
    return {
        "id": f"home_status:{home_device.id}:{entity.entity_id}:{event_type}",
        "home_device_id": home_device.id,
        "home_device_name": home_device.name,
        "entity_name": _name(home_device, entity),
        "entity_id": entity.entity_id,
        "event_type": event_type,
        "message": message,
        "summary": detail,
        "detail": detail,
        "category": category,
        "source": "home_device",
        "priority": priority,
        "icon": icon or entity.icon or state.attributes.get("icon") or "mdi:information-outline",
        "active": active,
        "state": state.state,
        "created_at": state.last_changed.isoformat() if state.last_changed else _now(),
    }


def _name(home_device: HomeDevice, entity: HomeDeviceEntity) -> str:
    if len(home_device.entities) == 1:
        return home_device.name
    return entity.name


def _presentation_name(home_device: HomeDevice, entity: HomeDeviceEntity) -> str:
    """Use a useful entity label without exposing a model number as its name."""
    name = _name(home_device, entity).strip()
    parts = name.split(maxsplit=1)
    if len(parts) == 2 and re.fullmatch(r"(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]+", parts[0]):
        name = parts[1]
    appliance = _appliance_label(home_device)
    if name.casefold() in {"door", "laundry door"} and appliance in {"Washer", "Dryer", "Dishwasher"}:
        return f"{appliance} Door"
    return name


def _with_normalization(
    item: dict[str, Any],
    *,
    entity: HomeDeviceEntity,
    state: State,
    capability: str,
    label: str,
) -> dict[str, Any]:
    """Attach the core boundary while preserving the established item contract."""
    normalized = normalize_semantic_state(
        state.state,
        device_class=entity.device_class,
        capability=capability,
    )
    normalized["presentation"].update({"label": label, "message": item["message"]})
    item.update({
        "entity_name": label,
        "state": normalized["semantic"]["state"],
        "capability": capability,
    })
    return item


def _is_supporting_entity(entity: HomeDeviceEntity) -> bool:
    name = entity.name.casefold()
    return any(hint in name for hint in _SUPPORTING_NAME_HINTS)


def _entity_key(entity: HomeDeviceEntity) -> str:
    return f"{entity.entity_id} {entity.name}".casefold()


def _semantic_words(value: str) -> str:
    return " ".join(part for part in re.split(r"[^a-z0-9]+", value.casefold()) if part)


def easystart_entity_role(entity: HomeDeviceEntity) -> str | None:
    """Return the YAML-defined EasyStart role for an entity, if recognizable."""
    name = _semantic_words(entity.name)
    object_id = _semantic_words(entity.entity_id.split(".", 1)[-1])
    # Match specific multi-word controls ("Read Status") before the generic
    # primary role ("Status").
    for suffix, role in sorted(
        _EASYSTART_ROLE_SUFFIXES.items(), key=lambda item: len(item[0]), reverse=True
    ):
        if name == suffix or name.endswith(f" {suffix}") or object_id == suffix or object_id.endswith(f" {suffix}"):
            return role
    return None


def is_easystart_home_device(home_device: HomeDevice) -> bool:
    """Recognize an EasyStart diagnostic monitor by its entity signature."""
    roles = {role for entity in home_device.entities if (role := easystart_entity_role(entity))}
    distinctive = {"last_start_peak", "scpt_delay", "total_faults", "total_starts"}
    return "status" in roles and "live_current" in roles and bool(roles & distinctive)


def easystart_owned_entity_ids(home_device: HomeDevice) -> set[str]:
    """Return entities whose presentation is owned by the EasyStart capability."""
    if not is_easystart_home_device(home_device):
        return set()
    return {
        entity.entity_id
        for entity in home_device.entities
        if easystart_entity_role(entity) is not None
    }


_EASYSTART_CURRENT_FIELDS = (
    ("line_frequency", "Line Frequency"),
    ("live_current", "Live Current"),
    ("scpt_delay", "SCPT Delay"),
    ("status", "Status"),
)

_EASYSTART_HISTORY_FIELDS = (
    ("last_start_peak", "Last Start Peak"),
    ("total_faults", "Total Faults"),
    ("total_starts", "Total Starts"),
)


def _format_easystart_value(role: str, raw: str) -> str:
    """Present EasyStart's numeric protocol values without float artifacts."""
    if role == "status":
        return raw
    try:
        numeric = float(raw)
    except (TypeError, ValueError):
        return raw
    if not isfinite(numeric):
        return raw
    if role in {"total_faults", "total_starts"}:
        return f"{numeric:,.0f}"
    if numeric.is_integer():
        return str(int(numeric))
    return f"{numeric:.1f}".rstrip("0").rstrip(".")


def easystart_current_facts(
    hass: HomeAssistant, home_device: HomeDevice
) -> list[dict[str, Any]]:
    """Return current and retained EasyStart values as two current items."""
    if not is_easystart_home_device(home_device):
        return []

    by_role = {
        role: entity
        for entity in home_device.entities
        if (role := easystart_entity_role(entity)) is not None
    }
    status_entity = by_role.get("status")
    status_state = hass.states.get(status_entity.entity_id) if status_entity else None
    facts: list[dict[str, Any]] = []

    for group, fields in (
        ("current", _EASYSTART_CURRENT_FIELDS),
        ("history", _EASYSTART_HISTORY_FIELDS),
    ):
        values: list[str] = []
        changed_at = []
        for role, label in fields:
            entity = by_role.get(role)
            state = hass.states.get(entity.entity_id) if entity else None
            if state is None:
                continue
            raw = str(state.state or "").strip()
            if raw.casefold() in {"", "unknown", "unavailable", "none"}:
                continue
            unit = str(
                state.attributes.get("unit_of_measurement") or entity.unit or ""
            ).strip()
            value = _format_easystart_value(role, raw)
            values.append(f"{label}: {value}{f' {unit}' if unit else ''}")
            if state.last_changed:
                changed_at.append(state.last_changed)

        # A powered-off EasyStart has no Bluetooth presence. Just as Location
        # omits a group with no usable state, omit that empty Micro-Air item.
        if not values:
            continue

        facts.append({
            "entity_id": status_entity.entity_id if status_entity else "",
            "entity_name": f"{home_device.name} {'Current' if group == 'current' else 'History'}",
            "domain": "sensor",
            "device_class": None,
            "state": str(status_state.state).strip() if status_state else "",
            "attention": "none",
            "changed_at": max(changed_at).isoformat() if changed_at else _now(),
            "capability": "easystart_current",
            "easystart_group": group,
            "detail": " | ".join(values),
        })

    return facts


def _generic_diagnostic_sensor(entity: HomeDeviceEntity, state: State) -> bool:
    """Keep raw measurements/counters out of the generic awareness fallback."""
    if entity.domain != "sensor":
        return False
    if str(entity.entity_category or "").casefold() == "diagnostic":
        return True
    device_class = str(
        state.attributes.get("device_class") or entity.device_class or ""
    ).casefold()
    # Temperature and humidity already have explicit awareness semantics. They
    # remain eligible unless the registry marks them diagnostic or an owning
    # capability (such as EasyStart) suppresses them before this fallback.
    if device_class in {"temperature", "humidity"}:
        return False
    if str(state.attributes.get("state_class") or "").casefold() in {
        "measurement", "measurement_angle", "total", "total_increasing",
    }:
        return True
    return device_class in _GENERIC_DIAGNOSTIC_DEVICE_CLASSES


def _is_appliance_state_entity(entity: HomeDeviceEntity) -> bool:
    key = _entity_key(entity)
    return any(hint in key for hint in _APPLIANCE_STATE_HINTS)


def _is_appliance_end_entity(entity: HomeDeviceEntity) -> bool:
    key = _entity_key(entity)
    return any(hint in key for hint in _APPLIANCE_END_HINTS)


def _appliance_label(home_device: HomeDevice) -> str:
    text = " ".join([
        home_device.name,
        *(entity.entity_id for entity in home_device.entities),
        *(entity.name for entity in home_device.entities),
    ]).casefold()
    if "dishwasher" in text:
        return "Dishwasher"
    if "dryer" in text or "tumble dryer" in text:
        return "Dryer"
    if "washer" in text or "washing machine" in text:
        return "Washer"
    return home_device.name


def _appliance_icon(label: str) -> str:
    lower = label.casefold()
    if "dishwasher" in lower:
        return "mdi:dishwasher"
    if "dryer" in lower:
        return "mdi:tumble-dryer"
    return "mdi:washing-machine"


def _remaining_minutes(hass: HomeAssistant, entity: HomeDeviceEntity) -> str | None:
    state = hass.states.get(entity.entity_id)
    if state is None:
        return None
    raw = str(state.state or "").strip()
    if raw.casefold() in {"", "unknown", "unavailable", "none", "---"}:
        return None

    device_class = str(state.attributes.get("device_class") or entity.device_class or "").casefold()
    if device_class == "timestamp":
        parsed = dt_util.parse_datetime(raw)
        if parsed is None:
            return None
        parsed = dt_util.as_utc(parsed)
        seconds = (parsed - dt_util.utcnow()).total_seconds()
        if seconds <= 0:
            return None
        return f"{max(1, ceil(seconds / 60))} min remaining"

    try:
        value = float(raw)
    except (TypeError, ValueError):
        return f"{raw} remaining"

    unit = str(state.attributes.get("unit_of_measurement") or entity.unit or "").casefold()
    if unit in {"h", "hr", "hrs", "hour", "hours"}:
        value *= 60
    elif unit in {"s", "sec", "secs", "second", "seconds"}:
        value /= 60
    if value <= 0:
        return None
    return f"{max(1, round(value))} min remaining"


def _remaining_entity(home_device: HomeDevice) -> HomeDeviceEntity | None:
    candidates: list[tuple[int, HomeDeviceEntity]] = []
    for entity in home_device.entities:
        key = _entity_key(entity)
        if "delay" in key or "delayed" in key or "total_time" in key or "total time" in key:
            continue
        if "time_remaining" in key or "time remaining" in key:
            candidates.append((0, entity))
        elif "remaining_time" in key or "remaining time" in key:
            candidates.append((1, entity))
    return min(candidates, key=lambda item: item[0])[1] if candidates else None


def _appliance_phase_entity(home_device: HomeDevice) -> HomeDeviceEntity | None:
    return next(
        (
            entity
            for entity in home_device.entities
            if any(hint in _entity_key(entity) for hint in _APPLIANCE_PHASE_HINTS)
        ),
        None,
    )


def _appliance_phase(
    hass: HomeAssistant,
    home_device: HomeDevice,
    state_entity: HomeDeviceEntity,
    state: State,
) -> dict[str, str] | None:
    phase_entity = _appliance_phase_entity(home_device)
    if phase_entity is not None:
        phase_state = hass.states.get(phase_entity.entity_id)
        if phase_state is not None:
            normalized = normalize_semantic_state(
                phase_state.state,
                device_class=phase_entity.device_class,
                capability="cycle_stage",
                aliases=_APPLIANCE_ALIASES,
            )
            if normalized["semantic"]["state"] not in {"unknown", "unavailable", "off", "idle"}:
                return normalized

    # Some integrations publish the live phase directly as the primary state
    # (for example dishwasher current_status = rinsing/drying). Use that when it
    # is more informative than a generic Run/Running signal.
    normalized = normalize_semantic_state(
        state.state,
        device_class=state_entity.device_class,
        capability="cycle_stage",
        aliases=_APPLIANCE_ALIASES,
    )
    if normalized["semantic"]["state"] not in {"running", "on"}:
        return normalized
    return None



def _is_irrigation_context(home_device: HomeDevice, entity: HomeDeviceEntity | None = None) -> bool:
    """Return True when a device/entity clearly represents irrigation.

    This is interpretation only; it never controls selection/discovery.
    """
    text = " ".join([
        home_device.name,
        str(home_device.metadata.get("parent_device_name") or ""),
        *(item.name for item in home_device.entities),
        *(item.entity_id for item in home_device.entities),
        entity.name if entity is not None else "",
        entity.entity_id if entity is not None else "",
    ]).casefold()
    return home_device.kind == "irrigation" or any(
        hint in text for hint in ("sprinkler", "irrigation", "watering", "rain delay", "rain_delay")
    )


def _friendly_datetime(value: Any) -> str | None:
    """Format an HA datetime value for glanceable presentation."""
    raw = str(value or "").strip()
    if not raw:
        return None
    parsed = dt_util.parse_datetime(raw)
    if parsed is None:
        return None
    local = dt_util.as_local(parsed)
    return local.strftime("%a, %b %-d · %-I:%M %p")


def _waste_collection_kind(home_device: HomeDevice, entity: HomeDeviceEntity) -> tuple[str, str] | None:
    """Return the supported curbside collection label and icon for a sensor."""
    text = " ".join([home_device.name, entity.entity_id, entity.name]).casefold()
    if "recycl" in text:
        return "Recycling", "mdi:recycle"
    if "garbage" in text or "trash" in text:
        return "Garbage", "mdi:trash-can-outline"
    return None


def _waste_collection_date(value: Any) -> str | None:
    """Turn common Waste Collection Schedule sensor states into glanceable dates."""
    raw = str(value or "").strip()
    if not raw:
        return None

    # Waste Collection Schedule commonly renders values such as
    # "On Thu, 13.08.2026". Pull the numeric date out first so locale weekday
    # abbreviations do not matter.
    parsed_date = None
    match = re.search(r"(?<!\d)(\d{1,2})[.](\d{1,2})[.](\d{4})(?!\d)", raw)
    if match:
        day, month, year = (int(part) for part in match.groups())
        try:
            parsed_date = datetime(year, month, day).date()
        except ValueError:
            parsed_date = None

    if parsed_date is None:
        iso_match = re.search(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)", raw)
        if iso_match:
            year, month, day = (int(part) for part in iso_match.groups())
            try:
                parsed_date = datetime(year, month, day).date()
            except ValueError:
                parsed_date = None

    if parsed_date is None:
        return None

    days = (parsed_date - dt_util.now().date()).days
    if days == 0:
        return "Today"
    if days == 1:
        return "Tomorrow"
    if 2 <= days <= 7:
        return f"{parsed_date.strftime('%a, %b')} {parsed_date.day}"
    return f"{parsed_date.strftime('%a, %b')} {parsed_date.day}"


def _waste_collection_scheduled_at(value: Any) -> str | None:
    """Return a stable date-only value for a waste collection sensor state."""
    raw = str(value or "").strip()
    match = re.search(r"(?<!\d)(\d{1,2})[.](\d{1,2})[.](\d{4})(?!\d)", raw)
    if match:
        day, month, year = (int(part) for part in match.groups())
    else:
        match = re.search(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)", raw)
        if not match:
            return None
        year, month, day = (int(part) for part in match.groups())
    try:
        return datetime(year, month, day).date().isoformat()
    except ValueError:
        return None

def _has_semantic_owner(home_device: HomeDevice, entity: HomeDeviceEntity) -> bool:
    """Return True when Home Status already understands this entity's semantics.

    A claimed entity may intentionally produce no item for a normal state. That
    silence is authoritative and must not fall through to the generic manual
    entity awareness path.
    """
    domain = entity.domain
    device_class = str(entity.device_class or "").casefold()

    if is_easystart_home_device(home_device) and easystart_entity_role(entity):
        return True

    if domain == "alarm_control_panel":
        return True
    if domain == "binary_sensor" and device_class in {
        "smoke", "carbon_monoxide", "gas", "moisture", "problem", "safety",
        "door", "window", "opening", "garage_door",
        "motion", "occupancy", "presence", "connectivity",
    }:
        return True
    if domain == "lock":
        return True
    if domain == "valve":
        return True
    if _is_irrigation_context(home_device, entity):
        return True
    if domain == "cover" and device_class in {"door", "garage", "gate", "window"}:
        return True
    if home_device.kind == "appliance":
        return True
    if domain == "climate":
        return True
    if domain == "sensor" and device_class in {"temperature", "humidity"}:
        return True
    return False


def awareness_only_entity(home_device: HomeDevice, entity: HomeDeviceEntity) -> bool:
    """Return whether an entity describes current/scheduled context, not activity."""
    if _waste_collection_kind(home_device, entity) is not None:
        return True
    if entity.domain in {"weather", "calendar", "person", "zone", "climate"}:
        return True
    if entity.domain == "sensor" and str(entity.device_class or "").casefold() in {"temperature", "humidity"}:
        return True
    if _is_irrigation_context(home_device, entity) and entity.domain == "sensor":
        text = entity.name.casefold().replace("_", " ")
        return "next watering" in text or "next water" in text
    return False

def interpret_entity(
    hass: HomeAssistant,
    home_device: HomeDevice,
    entity: HomeDeviceEntity,
) -> list[dict[str, Any]]:
    """Interpret one entity conservatively; unknown meaning stays silent."""
    state = hass.states.get(entity.entity_id)
    if state is None:
        return []

    raw = str(state.state or "").casefold()
    domain = entity.domain
    device_class = str(entity.device_class or "").casefold()
    name = _presentation_name(home_device, entity)

    # A child/supporting entity being unavailable does not mean the whole HomeDevice
    # is unavailable. Device availability will get a dedicated device-level
    # interpretation later. This prevents sirens, timers, remaining-time
    # sensors, etc. from flooding Home Status.
    if raw in {"unknown", "unavailable"}:
        return []

    if domain == "alarm_control_panel":
        labels = {
            "disarmed": ("Alarm off", "Home security is disarmed", "normal", False),
            "armed_home": ("Alarm armed home", "Home security is armed", "normal", False),
            "armed_away": ("Alarm armed away", "Home security is armed", "normal", False),
            "armed_night": ("Alarm armed night", "Home security is armed", "normal", False),
            "arming": ("Alarm arming", "Security countdown is active", "attention", True),
            "pending": ("Entry Delay", "Security entry delay is active", "critical", True),
            "triggered": ("Alarm triggered", "Alarm has been triggered", "critical", True),
        }
        if raw in labels:
            message, detail, priority, active = labels[raw]
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="security",
                    message=message,
                    detail=detail,
                    priority=priority,
                    active=active,
                    icon="mdi:shield-home",
                )
            ]
        return []

    if domain == "binary_sensor":
        if device_class in {"smoke", "carbon_monoxide", "gas", "moisture", "problem", "safety"}:
            if raw != "on":
                return []
            labels = {
                "smoke": ("Smoke Detected", "Smoke was detected", "mdi:smoke-detector-alert"),
                "carbon_monoxide": ("Carbon Monoxide Detected", "Carbon monoxide was detected", "mdi:molecule-co"),
                "gas": ("Gas Detected", "Gas was detected", "mdi:gas-cylinder"),
                "moisture": (f"{name} Leak", "Water detected", "mdi:water-alert"),
                "problem": (f"{name} Problem", f"{name} reports a problem", "mdi:alert-circle"),
                "safety": (f"{name} Alert", f"{name} reports an unsafe condition", "mdi:alert"),
            }
            message, detail, icon = labels[device_class]
            item = _base(
                home_device,
                entity,
                state,
                event_type="safety",
                message=message,
                detail=detail,
                priority="critical",
                active=True,
                icon=icon,
            )
            return [_with_normalization(
                item, entity=entity, state=state,
                capability="fault", label=name,
            )]

        if device_class in {"door", "window", "opening", "garage_door"}:
            if raw != "on":
                return []
            item = _base(
                home_device,
                entity,
                state,
                event_type="contact",
                message=f"{name} Open",
                detail=f"{name} is open",
                priority="attention",
                active=True,
                icon=entity.icon or "mdi:door-open",
            )
            return [_with_normalization(
                item, entity=entity, state=state,
                capability="contact", label=name,
            )]

        if device_class in {"motion", "occupancy", "presence"}:
            if raw != "on":
                return []
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="presence",
                    message=f"{name} Activity",
                    detail=f"Activity detected by {name}",
                    priority="activity",
                    active=True,
                    icon=entity.icon or "mdi:motion-sensor",
                )
            ]

        if device_class == "connectivity":
            # HA connectivity sensors conventionally mean ON = connected.
            if raw == "on":
                return []
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="connectivity",
                    message=f"{home_device.name} Offline",
                    detail=f"{home_device.name} appears offline",
                    priority="attention",
                    active=True,
                    icon="mdi:lan-disconnect",
                )
            ]

        # No generic binary_sensor fallback. A switch-like configuration flag
        # such as "Chime sound" being ON is not an event.
        return []

    if domain == "lock":
        if raw in {"unlocked", "open"}:
            item = _base(
                home_device,
                entity,
                state,
                event_type="lock",
                message=f"{name} Unlocked",
                detail=f"{name} is unlocked",
                priority="attention",
                active=True,
                icon="mdi:lock-open-variant",
            )
            return [_with_normalization(
                item, entity=entity, state=state,
                capability="lock", label=name,
            )]
        return []

    if domain == "cover" and device_class in {"door", "garage", "gate", "window"}:
        if raw in {"open", "opening"}:
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="contact",
                    message=f"{name} Open",
                    detail=f"{name} is open",
                    priority="attention",
                    active=True,
                    icon="mdi:garage-open",
                )
            ]
        return []

    if domain == "valve":
        # Closed valves are a normal state and stay silent. Open irrigation
        # zones are meaningful activity; other valves use a neutral Open label.
        if raw in {"open", "opening", "on"}:
            irrigation = _is_irrigation_context(home_device, entity)
            label = entity.name if len(home_device.entities) > 1 else home_device.name
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="irrigation" if irrigation else "valve",
                    message=f"{label} Watering" if irrigation else f"{label} Open",
                    detail=f"{home_device.name} is watering" if irrigation else f"{label} is open",
                    priority="activity" if irrigation else "attention",
                    active=True,
                    icon=entity.icon or ("mdi:sprinkler-variant" if irrigation else "mdi:valve-open"),
                )
            ]
        return []

    # Appliance HomeDevices often expose dozens of controls/timers. Only the primary
    # operating-state entity may create cycle notifications.
    if home_device.kind == "appliance":
        if _is_supporting_entity(entity) or not _is_appliance_state_entity(entity):
            return []
        if raw in _RUNNING:
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="appliance_cycle",
                    message=f"{home_device.name} Running",
                    detail=f"{home_device.name} is running",
                    priority="activity",
                    active=True,
                    icon="mdi:washing-machine",
                )
            ]
        if raw in _COMPLETE:
            return [
                _base(
                    home_device,
                    entity,
                    state,
                    event_type="appliance_complete",
                    message=f"{home_device.name} Complete",
                    detail=f"{home_device.name} is ready",
                    priority="activity",
                    active=True,
                    icon="mdi:check-circle-outline",
                )
            ]
        return []

    # Weather/calendar/current-value entities are awareness/status, not alerts.
    if domain in {"weather", "calendar", "person", "climate", "sensor", "siren", "switch", "valve", "camera"}:
        return []

    # Unknown entity meaning is intentionally silent.
    return []

def awareness_entity(
    hass: HomeAssistant,
    home_device: HomeDevice,
    entity: HomeDeviceEntity,
) -> list[dict[str, Any]]:
    """Return quiet current-awareness information for selected HomeDevices."""
    state = hass.states.get(entity.entity_id)
    if state is None or str(state.state).casefold() in {"unknown", "unavailable"}:
        return []

    # EasyStart has one semantic protection status. Its measurements, counters,
    # diagnostics, and controls are never independent presentation candidates.
    easystart_role = easystart_entity_role(entity)
    if easystart_role and (
        is_easystart_home_device(home_device)
        or easystart_role in _EASYSTART_NONPRESENTATION_ROLES
    ):
        return []

    # The unrestricted entity selector remains available, but numeric telemetry
    # must have a dedicated semantic owner before it can enter presentation.
    # Irrigation's explicit Next Watering timestamp is a semantic schedule item,
    # so it must be allowed through before the generic timestamp/telemetry guard.
    entity_text_for_semantics = entity.name.casefold().replace("_", " ")
    irrigation_next_watering = (
        _is_irrigation_context(home_device, entity)
        and entity.domain == "sensor"
        and ("next watering" in entity_text_for_semantics or "next water" in entity_text_for_semantics)
    )
    if _generic_diagnostic_sensor(entity, state) and not irrigation_next_watering:
        return []

    domain = entity.domain
    attrs = state.attributes
    name_overridden = bool(home_device.metadata.get('name_overridden'))
    if len(home_device.entities) == 1:
        name = home_device.name
    elif name_overridden:
        # A user rename is the presentation identity for the whole Home Device.
        # Preserve the measurement meaning for multi-entity devices instead of
        # falling back to Home Assistant's original entity label.
        device_class = str(entity.device_class or '').casefold()
        measurement = {
            'temperature': 'Temperature',
            'humidity': 'Humidity',
        }.get(device_class, entity.name)
        base = home_device.name.strip()
        name = base if measurement.casefold() in base.casefold() else f"{base} {measurement}"
    else:
        name = entity.name
    message = None
    detail = None
    scheduled_at = None
    icon = entity.icon or attrs.get("icon") or "mdi:information-outline"

    waste_kind = _waste_collection_kind(home_device, entity)
    if waste_kind is not None and domain == "sensor":
        collection, waste_icon = waste_kind
        message = collection
        detail = _waste_collection_date(state.state) or str(state.state).removeprefix("On ").strip()
        scheduled_at = _waste_collection_scheduled_at(state.state)
        icon = waste_icon

    # Normal alarm states (disarmed/armed) belong to the dedicated security UI,
    # not generic awareness. Attention/critical alarm states are produced by
    # interpret_entity() and can still surface through the normal lifecycle.
    # This also prevents explicitly selected alarm entities from duplicating
    # "Armed Home" in the bottom stream.
    if domain == "alarm_control_panel":
        return []

    # Irrigation is a multi-entity device: rain delay, next watering, and zone
    # valves have different semantics. Interpret them before generic fallback.
    if _is_irrigation_context(home_device, entity):
        entity_text = entity.name.casefold().replace("_", " ")
        raw = str(state.state or "").casefold()

        if domain == "switch" and "rain delay" in entity_text:
            if raw not in {"on", "true", "active"}:
                return []
            message = "Rain Delay Active"
            detail = "Scheduled watering is paused"
            icon = entity.icon or "mdi:weather-rainy"

        elif domain == "sensor" and ("next watering" in entity_text or "next water" in entity_text):
            friendly = _friendly_datetime(state.state)
            if not friendly:
                return []
            message = "Next Watering"
            detail = friendly
            scheduled_at = str(state.state)
            icon = entity.icon or "mdi:sprinkler-variant"

        elif domain == "valve":
            # Valve activity is handled by interpret_entity(); normal closed
            # zones intentionally stay silent here.
            return []

    if domain == "climate":
        current = attrs.get("current_temperature")
        target = attrs.get("temperature")
        mode = str(state.state).replace("_", " ").title()
        message = f"{name}: {mode}"
        pieces = []
        if current is not None:
            pieces.append(f"{current}°")
        if target is not None:
            pieces.append(f"Set {target}°")
        detail = " · ".join(pieces) or mode
        icon = entity.icon or "mdi:thermostat"


    elif domain == "sensor" and str(entity.device_class or "").casefold() in {
        "temperature",
        "humidity",
    }:
        device_class = str(entity.device_class or "").casefold()
        measurement = "Humidity" if device_class == "humidity" else "Temperature"
        raw_value = state.state
        unit = str(entity.unit or attrs.get("unit_of_measurement") or "")
        try:
            numeric = float(raw_value)
            value = str(int(round(numeric)))
        except (TypeError, ValueError):
            value = str(raw_value)
        # Sensor precision belongs in HA's raw state. Home Status presents
        # glanceable whole-number values and keeps the Home Device name as
        # context instead of repeating it in the measurement title.
        message = f"{value}{unit}"
        detail = home_device.name
        icon = entity.icon or (
            "mdi:water-percent"
            if device_class == "humidity"
            else "mdi:thermometer"
        )

    if not message and home_device.metadata.get("manual_entity"):
        # Selection is unrestricted, but interpretation remains authoritative.
        # If a semantic interpreter owns this entity, an empty result means the
        # current state is normal/quiet and MUST stay silent (for example a
        # closed door, dry leak sensor, idle appliance, or normal alarm state).
        if _has_semantic_owner(home_device, entity):
            return []

        # Only truly unknown entities use the generic fallback. This preserves
        # the user's ability to monitor unusual/custom entities without leaking
        # raw states from entity types Home Status already understands.
        unit = str(entity.unit or attrs.get("unit_of_measurement") or "")
        raw_value = str(state.state)
        if domain == "sensor" and unit:
            try:
                numeric = float(raw_value)
                value = str(int(round(numeric))) if numeric.is_integer() or abs(numeric) >= 10 else f"{numeric:g}"
            except (TypeError, ValueError):
                value = raw_value
            message = f"{value}{unit}"
        else:
            message = raw_value.replace("_", " ").title()
        detail = home_device.name

    if not message:
        return []

    return [{
        "id": f"home_status:{home_device.id}:{entity.entity_id}:awareness",
        "home_device_id": home_device.id,
        "home_device_name": home_device.name,
        "entity_id": entity.entity_id,
        "device_class": entity.device_class,
        "unit_of_measurement": entity.unit or attrs.get("unit_of_measurement"),
        "event_type": "awareness",
        "title": message,
        "message": message,
        "summary": detail or message,
        "detail": detail or message,
        "category": "waste" if _waste_collection_kind(home_device, entity) is not None else home_device.kind,
        "source": "home_device",
        "priority": "normal",
        "icon": icon,
        "active": False,
        "state": state.state,
        "created_at": state.last_changed.isoformat() if state.last_changed else _now(),
        **({
            "scheduled_at": scheduled_at,
            "all_day": bool(waste_kind is not None),
        } if scheduled_at else {}),
    }]

def interpret_appliance_home_device(
    hass: HomeAssistant,
    home_device: HomeDevice,
) -> list[dict[str, Any]]:
    """Interpret washer, dryer, and dishwasher activity with one compact contract.

    Running is a live HA fact. Explicit end-of-cycle signals suppress that live
    fact; their Recorder activation is independently interpreted as Completed.
    No appliance lifecycle is retained or resolved by Home Status.
    """
    state_entity = next(
        (entity for entity in home_device.entities if _is_appliance_state_entity(entity)),
        None,
    )
    if state_entity is None:
        return []

    state = hass.states.get(state_entity.entity_id)
    if state is None:
        return []

    # An explicit end-of-cycle signal wins over a lagging machine-state sensor.
    # Returning no active item here lets the coordinator resolve the prior Running
    # item immediately into "<Appliance> Complete" with resolved_at = now.
    end_entity = next(
        (entity for entity in home_device.entities if _is_appliance_end_entity(entity)),
        None,
    )
    if end_entity is not None:
        end_state = hass.states.get(end_entity.entity_id)
        if end_state and str(end_state.state or "").strip().casefold() in {
            "on", "true", "1", "complete", "completed", "finished", "done", "end",
        }:
            return []

    normalized = normalize_semantic_state(
        state.state,
        device_class=state_entity.device_class,
        capability="appliance_cycle",
        aliases=_APPLIANCE_ALIASES,
    )
    if normalized["semantic"]["state"] in {"idle", "off", "complete", "unavailable", "unknown"}:
        return []
    if normalized["semantic"]["state"] not in {
        "on", "running", "starting", "washing", "rinsing", "drying",
        "paused", "heating", "cooling",
    }:
        return []

    label = _appliance_label(home_device)
    normalized["presentation"].update({
        "label": label,
        "message": f"{label} {resolve_display_label(normalized, state.state)}",
    })
    remaining_entity = _remaining_entity(home_device)
    remaining = _remaining_minutes(hass, remaining_entity) if remaining_entity else None
    phase = _appliance_phase(hass, home_device, state_entity, state)
    detail = remaining or (resolve_display_label(phase) if phase else None) or "In progress"

    item = _base(
        home_device,
        state_entity,
        state,
        event_type="appliance_cycle",
        message=f"{label} {resolve_display_label(normalized, state.state)}",
        detail=detail,
        priority="activity",
        active=True,
        icon=_appliance_icon(label),
    )
    item["id"] = f"home_status:{home_device.id}:appliance_cycle"
    item["appliance_name"] = label
    item.update({
        "state": normalized["semantic"]["state"],
        "display_state": normalized["presentation"]["state"],
        "capability": "appliance_cycle",
    })
    return [item]


def appliance_recent_entity_ids(
    hass: HomeAssistant, home_device: HomeDevice
) -> tuple[str, ...]:
    """Return Recorder candidates represented by the appliance semantics.

    Appliance devices expose many controls and enum sensors. Running belongs to
    the current-state contract; Recorder recent activity is limited to explicit
    completion and genuine safety/fault signals. This only limits the Recorder
    query; it retains no Home Status history and manufactures no lifecycle.
    """
    # A machine door is not household door activity.  An appliance shares a
    # physical HA device with it, but appliance history is about the cycle and
    # genuine safety/fault conditions only.
    structural_classes = {
        "smoke", "carbon_monoxide", "gas", "moisture", "problem", "safety",
    }
    entity_ids = {
        entity.entity_id
        for entity in home_device.entities
        if entity.domain in {"lock", "alarm_control_panel"}
        or str(entity.device_class or "").casefold() in structural_classes
    }
    entity_ids.update(
        entity.entity_id
        for entity in home_device.entities
        if _is_appliance_end_entity(entity)
    )
    return tuple(sorted(entity_ids))


def has_appliance_recent_capability(home_device: HomeDevice) -> bool:
    """Whether existing appliance semantics own recent activity for a device."""
    return any(
        _is_appliance_state_entity(entity) or _is_appliance_end_entity(entity)
        for entity in home_device.entities
    )


def appliance_current_fact(
    hass: HomeAssistant, home_device: HomeDevice
) -> dict[str, Any] | None:
    """Return the one current appliance fact owned by the semantic interpreter.

    This is a compact HA-native fact, not a retained active record.  It keeps
    the established appliance interpretation (including time remaining) while
    HA remains the source of the state and timestamp.
    """
    items = interpret_appliance_home_device(hass, home_device)
    if not items:
        return None
    item = items[0]
    return {
        "entity_id": item["entity_id"],
        "entity_name": item["appliance_name"],
        "domain": item["entity_id"].split(".", 1)[0],
        "device_class": None,
        "state": item["display_state"],
        "changed_at": item["created_at"],
        "attention": "none",
        "detail": item["detail"],
        "capability": "appliance_cycle",
    }


def appliance_transition_fact(
    hass: HomeAssistant,
    home_device: HomeDevice,
    transition: dict[str, Any],
) -> dict[str, Any] | None:
    """Interpret one Recorder transition without creating lifecycle state.

    Only an explicit end-of-cycle activation or a real fault/safety activation
    is a household event. Running belongs to ``native.current``. Some
    appliances pulse their end-of-cycle signal and immediately reset it to
    ``off``; that reset still represents the just-completed cycle when it
    directly follows an active completion state.
    """
    entity_id = str(transition.get("entity_id") or "")
    entity = next((item for item in home_device.entities if item.entity_id == entity_id), None)
    if entity is None:
        return None
    before = str(transition.get("from") or "").strip().casefold()
    after = str(transition.get("to") or "").strip().casefold()
    if {before, after} & {"", "unknown", "unavailable", "error", "none"}:
        return None

    label = _appliance_label(home_device)
    if _is_appliance_end_entity(entity):
        completion_states = {"on", "true", "1", "complete", "completed", "finished", "done", "end"}
        if after not in completion_states and before not in completion_states:
            return None
        display = "Completed"
    elif str(entity.device_class or "").casefold() in {
        "smoke", "carbon_monoxide", "gas", "moisture", "problem", "safety",
    }:
        if after not in {"on", "true", "1", "problem", "detected"}:
            return None
        display = "Fault" if str(entity.device_class or "").casefold() in {"problem", "safety"} else "Alert"
    else:
        return None

    return {
        "entity_id": entity_id,
        "entity_name": label,
        "domain": entity.domain,
        "device_class": entity.device_class,
        "from": str(transition.get("from") or ""),
        "to": display,
        "changed_at": transition["changed_at"],
        "capability": "appliance_cycle",
    }
