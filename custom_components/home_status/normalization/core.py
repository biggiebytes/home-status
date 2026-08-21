"""Provider-neutral semantic normalization with ordered context resolution."""

from __future__ import annotations

import re
from typing import Any, Mapping

from .humanize import humanize_raw_value


CANONICAL_STATES = frozenset({"idle", "off", "on", "running", "starting", "washing", "rinsing", "drying", "paused", "complete", "open", "closed", "opening", "closing", "locked", "unlocked", "locking", "unlocking", "jammed", "charging", "discharging", "heating", "cooling", "available", "unavailable", "warning", "error", "unknown", "detected", "clear"})

_DISPLAY = {state: state.replace("_", " ").title() for state in CANONICAL_STATES}
_DISPLAY.update({"co": "CO", "detected": "Detected", "clear": "Clear"})
_GENERIC_ALIASES: Mapping[str, str | Mapping[str, str]] = {
    "power off": "off", "standby": "idle", "ready": "idle", "power on": "on",
    "in progress": "running", "active": "running", "working": "running", "run": "running",
    "finished": "complete", "completed": "complete", "done": "complete", "end": "complete", "ended": "complete",
    "cleaning is complete": "complete", "night dry": "drying", "wash": "washing", "rinse": "rinsing", "dry": "drying", "pause": "paused",
    "water supply error": {"state": "error", "display": "Water Supply Error"},
}



def _key(value: Any) -> str:
    return re.sub(r"[-_]+", " ", str(value or "").strip()).casefold().strip()


def _contextual(
    raw: str, *, device_class: str | None, capability: str | None
) -> str | Mapping[str, str] | None:
    capability = (capability or "").casefold()
    device_class = (device_class or "").casefold()
    # Device-class/capability semantics always outrank generic aliases.  This
    # makes the boolean value "on" meaningful without pretending it means the
    # same thing for a leak detector, appliance, light, or clean indicator.
    binary_class = device_class or capability
    if raw in {"on", "true", "1"}:
        if capability in {"appliance_cycle", "cycle_state", "operation"}:
            return "running"
        if capability in {"completion", "cycle_complete"}:
            return "complete"
        if capability == "clean_indicator":
            return {"state": "complete", "display": "Clean"}
        if binary_class in {"door", "window", "opening"}:
            return {"state": "open", "display": "Open"}
        if binary_class in {"moisture", "smoke", "carbon_monoxide", "motion", "occupancy", "problem", "battery"}:
            labels = {"moisture": "Leak Detected", "smoke": "Smoke Detected", "carbon_monoxide": "CO Detected", "motion": "Motion Detected", "occupancy": "Occupied", "problem": "Problem", "battery": "Low Battery"}
            return {"state": "detected" if binary_class not in {"problem", "battery"} else "warning", "display": labels[binary_class]}
    if raw in {"off", "false", "0"}:
        if binary_class in {"door", "window", "opening"}:
            return {"state": "closed", "display": "Closed"}
        if binary_class in {"moisture", "smoke", "carbon_monoxide", "motion", "occupancy", "problem", "battery"}:
            return {"state": "clear", "display": "Clear" if binary_class not in {"problem", "battery"} else "Normal"}
    return None


def normalize_semantic_state(raw_value: Any, *, device_class: str | None = None, capability: str | None = None, overrides: Mapping[str, str | Mapping[str, str]] | None = None, aliases: Mapping[str, str | Mapping[str, str]] | None = None) -> dict[str, Any]:
    """Resolve raw data: explicit override, provider adapter, context, generic, fallback.

    ``overrides`` is intentionally a first-class input before provider aliases;
    configuration can supply it later without changing the semantic boundary.
    """
    raw_state = str(raw_value or "").strip()
    key = _key(raw_state)
    mapped: str | Mapping[str, str] | None = None
    if overrides:
        mapped = overrides.get(raw_state, overrides.get(key))
    if mapped is None and aliases:
        mapped = aliases.get(raw_state, aliases.get(key))
    if mapped is None:
        mapped = _contextual(key, device_class=device_class, capability=capability)
    if mapped is None:
        mapped = _GENERIC_ALIASES.get(key)
    if isinstance(mapped, Mapping):
        semantic = str(mapped.get("state") or "unknown").casefold()
        display = str(mapped.get("display") or _DISPLAY.get(semantic) or humanize_raw_value(raw_state))
    else:
        semantic = str(mapped or key).casefold()
        display = _DISPLAY.get(semantic, humanize_raw_value(raw_state))
    semantic = semantic if semantic in CANONICAL_STATES else "unknown"
    return {
        "semantic": {
            "capability": capability,
            "state": semantic,
            "active": semantic not in {
                "idle", "off", "complete", "closed", "locked", "available",
                "clear", "unavailable", "unknown",
            },
            "severity": (
                "error" if semantic == "error"
                else "warning" if semantic == "warning"
                else "normal"
            ),
        },
        "presentation": {"state": display},
    }


def resolve_display_label(normalized: Mapping[str, Any], fallback: Any = "") -> str:
    presentation = normalized.get("presentation")
    if isinstance(presentation, Mapping) and isinstance(presentation.get("state"), str):
        return presentation["state"]
    return humanize_raw_value(fallback)
