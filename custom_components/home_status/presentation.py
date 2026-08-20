"""Provider-neutral Visual Center selection for Home Status."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

_PRIORITY = {"critical": 0, "attention": 1, "activity": 2, "normal": 3}
_VISUAL_TYPES = {"image", "video", "camera", "map"}
def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        key = str(item.get("id") or f"{item.get('entity_id')}:{item.get('message')}")
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def select_visual(
    active: list[dict[str, Any]] | None = None,
    recent: list[dict[str, Any]] | None = None,
    awareness: list[dict[str, Any]] | None = None,
    *,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Choose the current generic Visual Center candidate.

    Items describe visual capability only. This selector deliberately knows
    nothing about providers, categories, or placement in the card.
    """
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    candidates: list[tuple[tuple[Any, ...], dict[str, Any]]] = []
    items = [
        item for item in [*(active or []), *(awareness or []), *(recent or [])]
        if isinstance(item, dict)
    ]
    for item in _dedupe(items):
        visual = _normalized_visual(item.get("visual"), now)
        if visual is None:
            continue
        started = _parse_visual_time(visual.get("started_at"))
        created = _parse_visual_time(item.get("created_at"))
        current = visual["live"] or item.get("active") is True
        candidates.append((
            (
                _PRIORITY[visual["priority"]],
                0 if current else 1,
                -(started.timestamp() if started else 0),
                -(created.timestamp() if created else 0),
            ),
            visual,
        ))
    return min(candidates, key=lambda candidate: candidate[0])[1] if candidates else None


def media_visual_queue(items: list[dict[str, Any]], *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Return a provider-neutral queue for image/video awareness media.

    Any semantic item that carries valid image/video media is eligible. The
    queue preserves source order and only validates/deduplicates the media.
    """
    now = now or datetime.now(timezone.utc)
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        visual = _normalized_visual(item.get("visual"), now)
        if visual is None and str(item.get("source_kind") or "").casefold() == "news":
            media_url = str(item.get("media_url") or item.get("image_url") or "").strip()
            if media_url:
                media_type = str(item.get("media_type") or "image").casefold()
                visual = {
                    "type": "video" if media_type.startswith("video") else "image",
                    "url": media_url,
                    "title": str(item.get("title") or item.get("message") or "").strip(),
                    "article_url": str(item.get("article_url") or item.get("navigation") or item.get("action") or "").strip(),
                    "source_id": str(item.get("source_id") or "").strip(),
                    "source_kind": "news",
                    "source_name": str(item.get("source_name") or "News").strip(),
                    "priority": str(item.get("priority") or "normal").strip().casefold(),
                    "mute": True,
                }
        if visual is None or visual.get("type") not in {"image", "video"}:
            continue
        key = str(visual.get("url") or "")
        if not key or key in seen:
            continue
        seen.add(key)
        # Preserve neutral provenance so the frontend can rotate fairly by
        # source without knowing anything about specific providers.
        if not visual.get("source_id") and item.get("source_id"):
            visual["source_id"] = str(item["source_id"])
        if not visual.get("source_kind") and item.get("source_kind"):
            visual["source_kind"] = str(item["source_kind"])
        result.append(visual)
    return result


def _normalized_visual(value: Any, now: datetime) -> dict[str, Any] | None:
    """Validate and normalize the provider-neutral visual contract."""
    if not isinstance(value, dict):
        return None
    visual_type = value.get("type")
    if not isinstance(visual_type, str) or visual_type not in _VISUAL_TYPES:
        return None
    url = value.get("url")
    entity_id = value.get("entity_id")
    if url is not None and (not isinstance(url, str) or not url.strip()):
        return None
    if entity_id is not None and (not isinstance(entity_id, str) or not entity_id.strip()):
        return None
    if not url and not entity_id:
        return None

    priority = value.get("priority", "normal")
    if not isinstance(priority, str) or priority not in _PRIORITY:
        return None
    live = value.get("live", False)
    resumable = value.get("resumable", True)
    if not isinstance(live, bool) or not isinstance(resumable, bool):
        return None

    started_at = value.get("started_at")
    expires_at = value.get("expires_at")
    started = _parse_visual_time(started_at)
    expires = _parse_visual_time(expires_at)
    if (started_at is not None and started is None) or (expires_at is not None and expires is None):
        return None
    if expires is not None and expires <= now:
        return None

    result: dict[str, Any] = {
        "type": visual_type,
        "priority": priority,
        "live": live,
        "resumable": resumable,
    }
    if url:
        result["url"] = url.strip()
    if entity_id:
        result["entity_id"] = entity_id.strip()
    if started_at is not None:
        result["started_at"] = started_at
    if expires_at is not None:
        result["expires_at"] = expires_at
    # These fields describe a visual without affecting generic selection.
    for key in ("transport", "article_url", "title", "source", "source_id", "source_kind", "event_start", "event_end"):
        extra = value.get(key)
        if isinstance(extra, str) and extra.strip():
            result[key] = extra.strip()
    display_duration = value.get("display_duration")
    if isinstance(display_duration, (int, float)) and display_duration > 0:
        result["display_duration"] = float(display_duration)
    if isinstance(value.get("mute"), bool):
        result["mute"] = value["mute"]
    return result


def _parse_visual_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
