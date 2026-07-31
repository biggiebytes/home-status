"""Thin adapters from private conversation records to backend presentation."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable


def _timestamp(value: datetime | str) -> str:
    """Return one stable UTC ISO timestamp."""
    if isinstance(value, datetime):
        stamp = value
    else:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


def _duration_text(seconds: int) -> str:
    """Return fixed lifecycle duration text."""
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "less than a minute"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = minutes // 60
    remainder = minutes % 60
    if remainder:
        return (
            f"{hours} hour{'s' if hours != 1 else ''} "
            f"{remainder} minute{'s' if remainder != 1 else ''}"
        )
    return f"{hours} hour{'s' if hours != 1 else ''}"


class ContactFooterPresentationAdapter:
    """Translate eligible low-contact conversations into footer items."""

    @classmethod
    def build_items(
        cls,
        events: Iterable[Any],
        decisions: Iterable[Any],
        records: Iterable[Any],
        now: datetime | str,
        *,
        enabled: bool,
    ) -> tuple[dict[str, Any], ...]:
        """Return stable footer items without modifying source objects."""
        if not enabled:
            return ()
        current = datetime.fromisoformat(_timestamp(now))
        events_by_id = {
            str(event.event_id): event for event in events
        }
        decisions_by_id = {
            str(decision.decision_id): decision for decision in decisions
        }
        items = []
        for record in records:
            if (
                getattr(record, "lane", None) != "low"
                or getattr(record, "conversation_status", None)
                != "presented"
            ):
                continue
            decision = decisions_by_id.get(str(record.decision_id))
            event = events_by_id.get(str(record.event_id))
            if decision is None or event is None:
                continue
            if (
                getattr(decision, "placement", None) != "low"
                or getattr(event, "event_type", None) != "contact_open"
                or getattr(event, "lifecycle", None) != "completed"
                or not getattr(event, "ended_at", None)
            ):
                continue
            eligible_from = datetime.fromisoformat(
                _timestamp(decision.eligible_from)
            )
            eligible_until = datetime.fromisoformat(
                _timestamp(decision.eligible_until)
            )
            if current < eligible_from or current >= eligible_until:
                continue
            label = str(
                getattr(event, "context", {}).get("label") or "Contact"
            ).strip()
            duration = getattr(event, "duration_seconds", None)
            if duration is None:
                started = datetime.fromisoformat(_timestamp(event.started_at))
                ended = datetime.fromisoformat(_timestamp(event.ended_at))
                duration = max(0, int((ended - started).total_seconds()))
            summary = f"was open for {_duration_text(duration)}"
            device_class = str(
                getattr(event, "context", {}).get("device_class") or ""
            )
            icon = (
                "mdi:window-closed"
                if device_class == "window"
                else "mdi:garage"
                if device_class == "garage_door"
                else "mdi:door-closed"
            )
            items.append(
                {
                    "id": str(record.presentation_id),
                    "provider": "activity",
                    "category": "contact",
                    "placement": "footer",
                    "title": label,
                    "message": summary,
                    # The existing card reads summary for the second line and
                    # resolved_at for locally refreshed relative age.
                    "summary": summary,
                    "started_at": _timestamp(event.started_at),
                    "ended_at": _timestamp(event.ended_at),
                    "created_at": _timestamp(event.started_at),
                    "resolved_at": _timestamp(event.ended_at),
                    "expires_at": _timestamp(decision.eligible_until),
                    "entity_id": str(event.entity_id),
                    "event_type": "contact_lifecycle_completed",
                    "source": "conversation_pilot_cleared",
                    "priority": "activity",
                    "icon": icon,
                    "active": False,
                }
            )
        return tuple(
            sorted(
                items,
                key=lambda item: (item["ended_at"], item["id"]),
                reverse=True,
            )
        )

    @staticmethod
    def _is_equivalent_legacy(item: dict, pilot: dict) -> bool:
        """Match only the legacy closure represented by one pilot item."""
        if item.get("source") != "direct_history":
            return False
        if item.get("entity_id") != pilot.get("entity_id"):
            return False
        text = f"{item.get('title', '')} {item.get('message', '')}"
        if "closed" not in text.casefold():
            return False
        legacy_stamp = item.get("resolved_at") or item.get("created_at")
        if not legacy_stamp:
            return False
        try:
            delta = abs(
                (
                    datetime.fromisoformat(_timestamp(legacy_stamp))
                    - datetime.fromisoformat(_timestamp(pilot["ended_at"]))
                ).total_seconds()
            )
        except (TypeError, ValueError):
            return False
        return delta <= 10

    @classmethod
    def merge_footer(
        cls, existing: Iterable[dict], pilot_items: Iterable[dict]
    ) -> list[dict]:
        """Replace equivalent legacy closures while preserving footer order."""
        pilots = list(pilot_items)
        if not pilots:
            return list(existing)
        used: set[str] = set()
        merged = []
        for item in existing:
            replacement = next(
                (
                    pilot
                    for pilot in pilots
                    if pilot["id"] not in used
                    and cls._is_equivalent_legacy(item, pilot)
                ),
                None,
            )
            if replacement is not None:
                merged.append(replacement)
                used.add(replacement["id"])
            else:
                merged.append(item)
        merged.extend(pilot for pilot in pilots if pilot["id"] not in used)
        seen = set()
        result = []
        for item in merged:
            item_id = item.get("id")
            if item_id is not None and item_id in seen:
                continue
            if item_id is not None:
                seen.add(item_id)
            result.append(item)
        return result
