from custom_components.home_status.news import parse_feed


def test_media_content_image_becomes_an_image_visual_candidate_field():
    feed = b'''<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
      <title>Article</title><link>https://example.test/article</link>
      <media:content url="https://cdn.example.test/image.jpg" type="image/jpeg" />
    </item></channel></rss>'''
    article = parse_feed(feed, "feed")[0]
    assert article["image"] == "https://cdn.example.test/image.jpg"
    assert "video" not in article


def test_video_media_is_not_mistaken_for_an_rss_thumbnail():
    feed = b'''<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
      <title>Video</title><link>https://example.test/article</link>
      <media:content url="https://cdn.example.test/video.mp4" type="video/mp4" />
    </item></channel></rss>'''
    assert parse_feed(feed, "feed")[0]["image"] == ""
