"""Generic RSS/Atom parsing for Home Status news sources."""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
import ipaddress
from typing import Any
from urllib.parse import urlparse
from defusedxml import ElementTree as ET


def valid_url(value: Any) -> bool:
    """Return True for credential-free HTTP(S) URLs with safe literal hosts."""
    parsed = urlparse(str(value or "").strip())
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
    ):
        return False

    hostname = (parsed.hostname or "").rstrip(".").casefold()
    if not hostname or hostname == "localhost" or hostname.endswith(".localhost"):
        return False
    try:
        return ipaddress.ip_address(hostname.split("%", 1)[0]).is_global
    except ValueError:
        # Hostnames are resolved and rechecked immediately before each fetch.
        return True


def article_id(feed_id: str, guid: str, link: str, title: str, published: str) -> str:
    value = guid.strip() or link.strip() or f"{title.strip()}|{published.strip()}"
    return f"news:{feed_id}:{sha256(value.encode()).hexdigest()[:24]}"


def _image_url(value: object) -> str:
    """Return a direct image URL without mistaking media video for a thumbnail."""
    url = str(value or "").strip()
    if not valid_url(url):
        return ""
    return url if urlparse(url).path.casefold().endswith((".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")) else ""


def _video_url(value: object) -> str:
    """Return a directly playable video URL, never an article page."""
    url = str(value or "").strip()
    if not valid_url(url):
        return ""
    return url if urlparse(url).path.casefold().endswith((".mp4", ".webm", ".m3u8")) else ""


def parse_feed(raw: bytes, feed_id: str) -> list[dict[str, str]]:
    root = ET.fromstring(raw)
    entries = root.findall(".//item")
    atom = False
    if not entries:
        entries = root.findall("{*}entry")
        atom = True
    result = []
    for entry in entries:
        text = lambda *names: next((str(node.text or "").strip() for name in names if (node := entry.find(name)) is not None and str(node.text or "").strip()), "")
        title = text("title", "{*}title")
        link = text("link", "{*}link")
        if atom:
            link = next((str(node.get("href") or "").strip() for node in entry.findall("{*}link") if node.get("rel", "alternate") == "alternate" and node.get("href")), link)
        summary = text("description", "{*}summary", "{*}content")
        published = text("pubDate", "{*}published", "{*}updated")
        guid = text("guid", "{*}id")
        image = next((str(node.get("url") or node.get("href") or "").strip() for node in entry.iter() if node.tag.rsplit("}", 1)[-1] in {"thumbnail", "content", "enclosure"} and str(node.get("type") or "").casefold().startswith("image/")), "")
        if not image:
            image = next((candidate for node in entry.iter() if node.tag.rsplit("}", 1)[-1] in {"thumbnail", "content"} and (candidate := _image_url(node.get("url") or node.get("href")))), "")
        video = next((
            str(node.get("url") or node.get("href") or "").strip()
            for node in entry.iter()
            if node.tag.rsplit("}", 1)[-1] in {"content", "enclosure"}
            and str(node.get("type") or "").casefold().startswith("video/")
            and _video_url(node.get("url") or node.get("href"))
        ), "")
        if title and valid_url(link):
            article = {
                "id": article_id(feed_id, guid, link, title, published),
                "title": title,
                "summary": summary,
                "url": link,
                "published": published,
                "image": image if valid_url(image) else "",
            }
            if video:
                article["video"] = video
            result.append(article)
    return result


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
