"""Ambient Direct HTTPS HLS samples for the Visual Center.

This provider intentionally publishes visual-only candidates.  It never creates
an activity, recent-history, or ticker item.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlparse


def valid_hls_url(value: object) -> bool:
    """Accept only direct, credential-free HTTPS HLS manifests."""
    if not isinstance(value, str):
        return False
    parsed = urlparse(value.strip())
    return (
        parsed.scheme == "https"
        and bool(parsed.netloc)
        and parsed.username is None
        and parsed.password is None
        and parsed.path.casefold().endswith(".m3u8")
    )


def _positive_seconds(value: object, default: int, maximum: int = 86400) -> int:
    try:
        return max(1, min(maximum, int(value)))
    except (TypeError, ValueError):
        return default


def _as_datetime(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


class LiveNewsProvider:
    """Round-robin a single ambient HLS source per scheduled sample window."""

    def __init__(self, state: dict[str, Any] | None = None) -> None:
        state = state if isinstance(state, dict) else {}
        self._state: dict[str, Any] = {
            "rotation_index": max(0, int(state.get("rotation_index", 0) or 0)),
            "next_sample_at": state.get("next_sample_at"),
            "active": state.get("active") if isinstance(state.get("active"), dict) else None,
            "sources_fingerprint": state.get("sources_fingerprint") if isinstance(state.get("sources_fingerprint"), str) else "",
        }

    @property
    def state(self) -> dict[str, Any]:
        return dict(self._state)

    def refresh(self, configured_sources: object, now: datetime) -> list[dict[str, Any]]:
        """Return the one current sample, starting one only when it is due."""
        now = now.astimezone(timezone.utc)
        sources = self._valid_sources(configured_sources)
        fingerprint = "|".join(
            f"{source['id']}:{source['url']}:{source['sample_interval']}:{source['display_duration']}:{source['priority']}:{source['mute']}"
            for source in sources
        )
        if fingerprint != self._state.get("sources_fingerprint", ""):
            # A configuration save reloads the integration but intentionally
            # preserves provider state.  Do not make a newly added or edited
            # source wait behind a schedule created for its previous config.
            self._state["sources_fingerprint"] = fingerprint
            self._state["active"] = None
            self._state["next_sample_at"] = None
        active = self._state.get("active")
        if isinstance(active, dict):
            expires_at = _as_datetime(active.get("expires_at"))
            known = {source["id"] for source in sources}
            if expires_at is not None and expires_at > now and active.get("source_id") in known:
                return [self._item(active)]
            self._state["active"] = None

        if not sources:
            self._state["next_sample_at"] = None
            return []
        next_sample = _as_datetime(self._state.get("next_sample_at"))
        if next_sample is not None and now < next_sample:
            return []

        index = self._state["rotation_index"] % len(sources)
        source = sources[index]
        started_at = now
        active = {
            "source_id": source["id"],
            "url": source["url"],
            "name": source["name"],
            "priority": source["priority"],
            "mute": source["mute"],
            "started_at": started_at.isoformat(),
            "expires_at": (started_at + timedelta(seconds=source["display_duration"])).isoformat(),
        }
        self._state["active"] = active
        self._state["rotation_index"] = (index + 1) % len(sources)
        self._state["next_sample_at"] = (started_at + timedelta(seconds=source["sample_interval"])).isoformat()
        return [self._item(active)]

    def stop_active_after_preemption(self, now: datetime) -> None:
        """End the current sample without scheduling a replacement immediately."""
        if self._state.get("active") is not None:
            self._state["active"] = None

    def next_wakeup(self) -> datetime | None:
        values = []
        active = self._state.get("active")
        if isinstance(active, dict):
            values.append(_as_datetime(active.get("expires_at")))
        values.append(_as_datetime(self._state.get("next_sample_at")))
        return min((value for value in values if value is not None), default=None)

    @staticmethod
    def _valid_sources(configured_sources: object) -> list[dict[str, Any]]:
        if not isinstance(configured_sources, list):
            return []
        sources = []
        for item in configured_sources:
            if not isinstance(item, dict) or item.get("enabled", True) is not True:
                continue
            source_id = str(item.get("id") or "").strip()
            url = str(item.get("url") or "").strip()
            if not source_id or str(item.get("transport") or "hls").casefold() != "hls" or not valid_hls_url(url):
                continue
            sources.append({
                "id": source_id,
                "name": str(item.get("name") or "Live News").strip() or "Live News",
                "url": url,
                "priority": str(item.get("priority") or "normal"),
                "sample_interval": _positive_seconds(item.get("sample_interval"), 1800),
                "display_duration": _positive_seconds(item.get("display_duration"), 30, 3600),
                "mute": bool(item.get("mute", True)),
            })
        return sources

    @staticmethod
    def _item(active: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": f"live_news:{active['source_id']}",
            "live_news_source_id": active["source_id"],
            "active": False,
            "priority": active["priority"],
            "event_type": "live_news_sample",
            "category": "live_news",
            "created_at": active["started_at"],
            "visual": {
                "type": "video",
                "transport": "hls",
                "url": active["url"],
                "title": active["name"],
                "source": "Live News",
                "priority": active["priority"],
                "live": True,
                "started_at": active["started_at"],
                "expires_at": active["expires_at"],
                "resumable": False,
                "mute": active["mute"],
            },
        }
