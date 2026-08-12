"""Release-contract tests for the current device-first architecture."""

from custom_components.home_status.normalization import normalize_semantic_state


def test_appliance_run_is_running_and_human_readable():
    normalized = normalize_semantic_state(
        "Run", capability="appliance_cycle", device_role="washer"
    )

    assert normalized["state"] == "running"
    assert normalized["display_state"] == "Running"
    assert normalized["semantic"]["active"] is True


def test_appliance_completion_is_not_active():
    normalized = normalize_semantic_state(
        "completed", capability="appliance_cycle", device_role="dryer"
    )

    assert normalized["state"] == "complete"
    assert normalized["display_state"] == "Complete"
    assert normalized["semantic"]["active"] is False


def test_contact_states_keep_open_and_closed_semantics():
    opened = normalize_semantic_state("on", device_class="door")
    closed = normalize_semantic_state("off", device_class="door")

    assert (opened["state"], opened["display_state"]) == ("open", "Open")
    assert (closed["state"], closed["display_state"]) == ("closed", "Closed")
