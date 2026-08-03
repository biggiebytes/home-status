from custom_components.home_status.source_adapters import (
    DEFAULT_NEWS_ICON,
    RSSSourceDefinition,
    is_valid_feed_url,
    normalize_news_feeds,
    parse_rss_items,
)


def test_legacy_default_keeps_nasa_enabled():
    feeds = normalize_news_feeds()
    assert feeds == [{
        "key": "nasa",
        "name": "NASA",
        "url": "https://www.nasa.gov/feed/",
        "icon": "mdi:rocket-launch-outline",
        "enabled": True,
        "refresh_minutes": 15,
        "max_items": 1,
    }]


def test_news_feeds_are_bounded_deduplicated_and_can_be_empty():
    feeds = normalize_news_feeds([
        {
            "name": "Favorite",
            "url": "https://example.com/feed.xml",
            "refresh_minutes": 1,
            "max_items": 99,
        },
        {
            "name": "Duplicate",
            "url": "HTTPS://EXAMPLE.COM/feed.xml",
        },
        {"url": "file:///config/secrets.yaml"},
    ])
    assert len(feeds) == 1
    assert feeds[0]["name"] == "Favorite"
    assert feeds[0]["icon"] == DEFAULT_NEWS_ICON
    assert feeds[0]["refresh_minutes"] == 5
    assert feeds[0]["max_items"] == 5
    assert normalize_news_feeds([]) == []


def test_feed_urls_require_http_without_embedded_credentials():
    assert is_valid_feed_url("https://example.com/rss")
    assert is_valid_feed_url("http://homeassistant.local:8123/local/feed.xml")
    assert not is_valid_feed_url("file:///config/secrets.yaml")
    assert not is_valid_feed_url("https://user:secret@example.com/rss")


def test_custom_feed_identity_is_used_in_normalized_items():
    definition = RSSSourceDefinition(
        key="favorite-local",
        name="Favorite Local News",
        url="https://example.com/rss.xml",
        provider="news",
        icon="mdi:newspaper",
        max_items=2,
    )
    items = parse_rss_items(
        b"""<?xml version="1.0"?>
        <rss><channel><item><title>Community update</title>
        <link>https://example.com/story</link>
        <description>What happened nearby.</description>
        </item></channel></rss>""",
        definition,
    )
    assert len(items) == 1
    assert items[0]["source"] == "favorite-local"
    assert items[0]["subtitle"] == "Favorite Local News"
    assert items[0]["icon"] == "mdi:newspaper"
    assert items[0]["action"] == "https://example.com/story"
