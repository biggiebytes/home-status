"""Read Home Assistant state and Recorder history without owning either.

Home Status deliberately keeps no copy of entity lifecycle data.  The helpers
here turn Home Assistant's current state machine and Recorder rows into a small
wire contract for the card: current facts and recent state transitions.
"""

from __future__ import annotations

from datetime import datetime, timezone
from functools import partial
from typing import Any, Callable

from homeassistant.components.recorder import get_instance, history
from homeassistant.core import HomeAssistant, State


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
    for entity_id, states in states_by_entity.items():
        previous: State | None = None
        current = hass.states.get(entity_id)
        for state in states:
            if (
                previous is not None
                and state.state != previous.state
                and _is_meaningful_transition(entity_id, previous, state, current)
            ):
                transitions.append(
                    _transition_fact(entity_id, previous, state, current, name_for_entity)
                )
            previous = state
    return sorted(transitions, key=lambda item: item["changed_at"], reverse=True)


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
    if domain in {"binary_sensor", "lock", "alarm_control_panel"}:
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
    if domain == "lock":
        return {"locked": "Locked", "unlocked": "Unlocked"}.get(canonical, _humanize(raw))
    if domain == "alarm_control_panel":
        return {
            "disarmed": "Disarmed", "armed_away": "Armed Away",
            "armed_home": "Armed Home", "armed_night": "Armed Night",
            "arming": "Arming", "pending": "Pending", "triggered": "Triggered",
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
        if device_class in {"smoke", "gas", "carbon_monoxide", "moisture"}:
            return "critical"
        if device_class in {"door", "window", "opening", "garage_door", "problem", "safety"}:
            return "attention"
    if domain == "lock" and value == "unlocked":
        return "attention"
    return "none"
