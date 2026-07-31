from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from hashlib import sha256
from html.parser import HTMLParser
import logging
import re
from typing import Any
from urllib.parse import urljoin, urlparse
import xml.etree.ElementTree as ET


_LOGGER = logging.getLogger(__name__)
_MAX_FEED_BYTES = 2 * 1024 * 1024
_IMAGE_EXTENSIONS = (".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp")


@dataclass(frozen=True)
class RSSSourceDefinition:
    """Configuration for one RSS/Atom source."""

    key: str
    name: str
    url: str
    provider: str
    icon: str
    refresh_minutes: int = 15
    max_items: int = 1


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.first_image: str | None = None

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(
        self, tag: str, attrs: list[tuple[str, str | None]]
    ) -> None:
        if tag.casefold() != "img" or self.first_image:
            return
        values = dict(attrs)
        self.first_image = values.get("src") or values.get("data-src")


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].casefold()


def _clean_text(value: str | None) -> tuple[str, str | None]:
    parser = _TextExtractor()
    try:
        parser.feed(str(value or ""))
        parser.close()
    except Exception:
        return " ".join(str(value or "").split()), None
    return " ".join(" ".join(parser.parts).split()), parser.first_image


def _child_text(element: ET.Element, *names: str) -> str:
    wanted = {name.casefold() for name in names}
    for child in element:
        if _local_name(child.tag) in wanted and child.text:
            return child.text.strip()
    return ""


def _entry_link(element: ET.Element, feed_url: str) -> str:
    for child in element:
        if _local_name(child.tag) != "link":
            continue
        href = child.attrib.get("href")
        rel = str(child.attrib.get("rel") or "alternate").casefold()
        value = href or child.text
        if value and rel in {"alternate", ""}:
            return urljoin(feed_url, value.strip())
    return ""


def _safe_web_url(value: str | None, base_url: str = "") -> str | None:
    if not value:
        return None
    resolved = urljoin(base_url, value.strip())
    return resolved if urlparse(resolved).scheme in {"http", "https"} else None


def _entry_media(
    element: ET.Element, feed_url: str, html_image: str | None
) -> str | None:
    for child in element.iter():
        name = _local_name(child.tag)
        if name not in {"content", "enclosure", "thumbnail"}:
            continue
        candidate = _safe_web_url(child.attrib.get("url"), feed_url)
        if not candidate:
            continue
        media_type = str(
            child.attrib.get("type") or child.attrib.get("medium") or ""
        ).casefold()
        path = urlparse(candidate).path.casefold()
        if (
            name == "thumbnail"
            or media_type == "image"
            or media_type.startswith("image/")
            or path.endswith(_IMAGE_EXTENSIONS)
        ):
            return candidate
    return _safe_web_url(html_image, feed_url)


def _entry_datetime(element: ET.Element) -> str:
    value = _child_text(
        element, "pubDate", "published", "updated", "date", "created"
    )
    if not value:
        return datetime.now(timezone.utc).isoformat()
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.now(timezone.utc).isoformat()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


def parse_rss_items(
    payload: bytes, definition: RSSSourceDefinition
) -> list[dict]:
    """Parse a bounded RSS/Atom payload into normalized Home Status items."""
    if len(payload) > _MAX_FEED_BYTES:
        raise ValueError(f"{definition.key} feed exceeds {_MAX_FEED_BYTES} bytes")
    root = ET.fromstring(payload)
    entries = [
        element
        for element in root.iter()
        if _local_name(element.tag) in {"item", "entry"}
    ]
    items: list[dict] = []
    expires_at = (
        datetime.now(timezone.utc) + timedelta(hours=24)
    ).isoformat()
    for entry in entries:
        raw_title = _child_text(entry, "title")
        title, _ = _clean_text(raw_title)
        if not title:
            continue
        link = _safe_web_url(_entry_link(entry, definition.url))
        description = _child_text(
            entry, "description", "summary", "encoded", "content"
        )
        body, html_image = _clean_text(description)
        if body.casefold() == title.casefold():
            body = ""
        body = body[:500].strip()
        media_url = _entry_media(entry, definition.url, html_image)
        stable_value = (
            _child_text(entry, "guid", "id")
            or link
            or f"{definition.key}|{title}"
        )
        digest = sha256(stable_value.encode("utf-8")).hexdigest()[:16]
        created_at = _entry_datetime(entry)
        item = {
            "id": f"source:{definition.key}:{digest}",
            "title": title[:240],
            "message": title[:240],
            "summary": body or definition.name,
            "body": body or definition.name,
            "subtitle": definition.name,
            "category": definition.provider,
            "provider": definition.provider,
            "icon": definition.icon,
            "priority": "normal",
            "active": False,
            "source": definition.key,
            "event_type": "source_update",
            "hero_eligible": True,
            "created_at": created_at,
            "expires_at": expires_at,
        }
        if link:
            item["action"] = link
            item["navigation"] = link
        if media_url:
            item["media_url"] = media_url
            item["media_type"] = "image"
        items.append(item)
        if len(items) >= max(1, definition.max_items):
            break
    return items


class RSSSourceAdapter:
    """Fetch one RSS/Atom feed while retaining the last good snapshot."""

    def __init__(self, definition: RSSSourceDefinition) -> None:
        self.definition = definition
        self.items: list[dict] = []
        self._etag: str | None = None
        self._last_modified: str | None = None
        self._next_refresh = datetime.min.replace(tzinfo=timezone.utc)
        self._last_error: str | None = None

    def is_due(self, now: datetime) -> bool:
        return now >= self._next_refresh

    async def async_refresh(self, session: Any, *, force: bool = False) -> bool:
        now = datetime.now(timezone.utc)
        if not force and not self.is_due(now):
            return False
        headers = {"Accept": "application/rss+xml, application/atom+xml, text/xml"}
        if self._etag:
            headers["If-None-Match"] = self._etag
        if self._last_modified:
            headers["If-Modified-Since"] = self._last_modified
        try:
            async with session.get(
                self.definition.url, headers=headers, timeout=15
            ) as response:
                if response.status == 304:
                    self._next_refresh = now + timedelta(
                        minutes=self.definition.refresh_minutes
                    )
                    self._last_error = None
                    return False
                response.raise_for_status()
                payload = await response.read()
                parsed = parse_rss_items(payload, self.definition)
                changed = parsed != self.items
                self.items = parsed
                self._etag = response.headers.get("ETag")
                self._last_modified = response.headers.get("Last-Modified")
                self._next_refresh = now + timedelta(
                    minutes=self.definition.refresh_minutes
                )
                self._last_error = None
                return changed
        except Exception as err:
            self._next_refresh = now + timedelta(minutes=5)
            error = f"{type(err).__name__}: {err}"
            if error != self._last_error:
                _LOGGER.warning(
                    "Home Status source %s could not refresh: %s",
                    self.definition.name,
                    err,
                )
                self._last_error = error
            return False

    def destroy(self) -> None:
        self.items = []
        self._etag = None
        self._last_modified = None
        self._last_error = None
