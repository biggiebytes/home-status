from datetime import datetime, timezone
from types import SimpleNamespace

from custom_components.home_status.coordinator import HomeStatusCoordinator


STAMP = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)


class _States:
    def __init__(self, values):
        self.values = values

    def get(self, entity_id):
        return self.values.get(entity_id)


def _state(entity_id, state):
    return SimpleNamespace(entity_id=entity_id, state=state, last_changed=STAMP)


def _source(source_id, trigger, *, priority="attention", hold_seconds=30, resumable=True):
    return {
        "id": source_id,
        "type": "camera",
        "camera_entity_id": f"camera.{source_id}",
        "trigger_entity_id": trigger,
        "trigger_state": "on",
        "priority": priority,
        "hold_seconds": hold_seconds,
        "enabled": True,
        "resumable": resumable,
    }


def _coordinator(states, sources):
    subject = object.__new__(HomeStatusCoordinator)
    subject.hass = SimpleNamespace(states=_States(states))
    subject.options = {"visual_center_enabled": True, "visual_sources": sources}
    subject._visual_source_lifetimes = {}
    subject._visual_source_preemptions = {}
    subject._current_visual_source_activation = None
    return subject


def test_trigger_clear_starts_a_held_visual_with_an_expiration():
    states = {"binary_sensor.trigger": _state("binary_sensor.trigger", "on")}
    subject = _coordinator(states, [_source("one", "binary_sensor.trigger", hold_seconds=30)])

    live = subject._configured_visual_items()
    states["binary_sensor.trigger"] = _state("binary_sensor.trigger", "off")
    held = subject._configured_visual_items()

    assert live[0]["visual"]["live"] is True
    assert "expires_at" not in live[0]["visual"]
    assert held[0]["visual"]["live"] is False
    assert "expires_at" in held[0]["visual"]


def test_resumable_visual_returns_after_higher_priority_visual_ends():
    states = {"binary_sensor.a": _state("binary_sensor.a", "on")}
    source_a = _source("a", "binary_sensor.a", priority="normal", resumable=True)
    subject = _coordinator(states, [source_a])

    assert subject._select_current_visual([], [], [], subject._configured_visual_items())["entity_id"] == "camera.a"
    states["binary_sensor.b"] = _state("binary_sensor.b", "on")
    subject.options["visual_sources"].append(_source("b", "binary_sensor.b", priority="critical", hold_seconds=0))
    assert subject._select_current_visual([], [], [], subject._configured_visual_items())["entity_id"] == "camera.b"
    states["binary_sensor.b"] = _state("binary_sensor.b", "off")

    assert subject._select_current_visual([], [], [], subject._configured_visual_items())["entity_id"] == "camera.a"


def test_non_resumable_visual_does_not_return_after_preemption():
    states = {"binary_sensor.a": _state("binary_sensor.a", "on")}
    source_a = _source("a", "binary_sensor.a", priority="normal", resumable=False)
    subject = _coordinator(states, [source_a])

    assert subject._select_current_visual([], [], [], subject._configured_visual_items())["entity_id"] == "camera.a"
    states["binary_sensor.b"] = _state("binary_sensor.b", "on")
    subject.options["visual_sources"].append(_source("b", "binary_sensor.b", priority="critical", hold_seconds=0))
    assert subject._select_current_visual([], [], [], subject._configured_visual_items())["entity_id"] == "camera.b"
    states["binary_sensor.b"] = _state("binary_sensor.b", "off")

    assert subject._select_current_visual([], [], [], subject._configured_visual_items()) is None
