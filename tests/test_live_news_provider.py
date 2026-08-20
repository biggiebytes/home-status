from datetime import datetime, timedelta, timezone

from custom_components.home_status.providers.live_news import LiveNewsProvider


NOW = datetime(2026, 8, 9, 12, 0, tzinfo=timezone.utc)


def _source(source_id="one", **values):
    return {
        "id": source_id,
        "name": source_id.title(),
        "url": f"https://example.test/{source_id}.m3u8",
        "transport": "hls",
        "enabled": True,
        "priority": "normal",
        "sample_interval": 1800,
        "display_duration": 30,
        **values,
    }


def test_creates_one_temporary_hls_visual():
    provider = LiveNewsProvider()
    item = provider.refresh([_source()], NOW)[0]
    visual = item["visual"]

    assert visual["type"] == "video"
    assert visual["transport"] == "hls"
    assert visual["live"] is True
    assert visual["expires_at"] == (NOW + timedelta(minutes=30)).isoformat()


def test_expiry_and_preemption_do_not_immediately_resume():
    provider = LiveNewsProvider()
    provider.refresh([_source()], NOW)
    provider.stop_active_after_preemption(NOW + timedelta(seconds=5))

    assert provider.refresh([_source()], NOW + timedelta(seconds=6)) == []
    assert provider.refresh([_source()], NOW + timedelta(minutes=30))[0]["visual"]["url"].endswith("one.m3u8")


def test_sources_rotate_and_state_survives_restart():
    provider = LiveNewsProvider()
    first = provider.refresh([_source("one"), _source("two")], NOW)[0]
    restored = LiveNewsProvider(provider.state)

    assert restored.refresh([_source("one"), _source("two")], NOW + timedelta(seconds=10))[0] == first
    second = restored.refresh([_source("one"), _source("two")], NOW + timedelta(minutes=30))[0]
    assert second["live_news_source_id"] == "two"


def test_invalid_or_disabled_sources_do_not_create_samples():
    provider = LiveNewsProvider()
    assert provider.refresh([_source(url="http://example.test/not-secure.m3u8"), _source("off", enabled=False)], NOW) == []


def test_changed_source_configuration_starts_a_fresh_sample():
    provider = LiveNewsProvider({"next_sample_at": (NOW + timedelta(minutes=20)).isoformat()})

    item = provider.refresh([_source()], NOW)[0]

    assert item["live_news_source_id"] == "one"
