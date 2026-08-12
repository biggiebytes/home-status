from datetime import datetime, timedelta, timezone

from custom_components.home_status.presentation import select_visual


NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)


def _item(name, *, priority="normal", active=False, live=False, expires_at=None, **extra):
    visual = {
        "type": "camera",
        "entity_id": f"camera.{name}",
        "priority": priority,
        "live": live,
        "started_at": NOW.isoformat(),
        "resumable": True,
    }
    if expires_at is not None:
        visual["expires_at"] = expires_at.isoformat()
    return {"id": name, "active": active, "visual": visual, **extra}


def test_no_visual_candidates_returns_none():
    assert select_visual([{"id": "plain", "priority": "critical"}], now=NOW) is None


def test_expired_visual_is_ignored():
    expired = _item("expired", expires_at=NOW - timedelta(seconds=1))
    current = _item("current", priority="activity")

    assert select_visual([expired, current], now=NOW)["entity_id"] == "camera.current"


def test_higher_priority_visual_wins():
    normal = _item("normal_live", priority="normal", live=True)
    attention = _item("alert", priority="attention")

    assert select_visual([normal, attention], now=NOW)["entity_id"] == "camera.alert"


def test_critical_visual_preempts_normal_visual():
    normal = _item("normal_live", priority="normal", live=True, category="one")
    critical = _item("critical_active", priority="critical", active=True, category="two")

    assert select_visual([normal, critical], now=NOW)["entity_id"] == "camera.critical_active"


def test_lower_priority_visual_becomes_winner_again_after_preemption_ends():
    normal = _item("normal_live", priority="normal", live=True)
    critical = _item("critical_active", priority="critical", active=True)

    assert select_visual([normal, critical], now=NOW)["entity_id"] == "camera.critical_active"
    assert select_visual([normal], now=NOW)["entity_id"] == "camera.normal_live"


def test_provider_and_category_names_do_not_affect_selection():
    current = _item("current", priority="normal", live=True, provider="alpha", category="one")
    older = _item("older", priority="normal", provider="beta", category="two")

    assert select_visual([older, current], now=NOW)["entity_id"] == "camera.current"


def test_selector_preserves_renderer_metadata_without_selecting_on_it():
    item = {
        "id": "hls",
        "visual": {
            "type": "video", "url": "https://example.test/live.m3u8",
            "transport": "hls", "title": "Channel", "source": "Live News",
            "mute": True, "priority": "normal", "live": True,
            "started_at": NOW.isoformat(), "resumable": False,
        },
    }
    visual = select_visual([item], now=NOW)
    assert visual["transport"] == "hls"
    assert visual["title"] == "Channel"
    assert visual["mute"] is True


