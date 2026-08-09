"""Generic RSS/Atom parsing for Home Status news sources."""

from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any
from urllib.parse import urlparse
from xml.etree import ElementTree as ET


def valid_url(value: Any) -> bool:
    parsed = urlparse(str(value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and not parsed.username and not parsed.password


def article_id(feed_id: str, guid: str, link: str, title: str, published: str) -> str:
    value = guid.strip() or link.strip() or f"{title.strip()}|{published.strip()}"
    return f"news:{feed_id}:{sha256(value.encode()).hexdigest()[:24]}"


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
        image = next((str(node.get("url") or node.get("href") or "").strip() for node in entry.iter() if node.tag.rsplit("}", 1)[-1] in {"thumbnail", "content", "enclosure"} and str(node.get("type") or "").startswith("image")), "")
        if not image:
            image = next((str(node.get("url") or node.get("href") or "").strip() for node in entry.iter() if node.tag.rsplit("}", 1)[-1] in {"thumbnail", "content"} and (node.get("url") or node.get("href"))), "")
        if title and valid_url(link):
            result.append({"id": article_id(feed_id, guid, link, title, published), "title": title, "summary": summary, "url": link, "published": published, "image": image if valid_url(image) else ""})
    return result


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
