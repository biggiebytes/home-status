"""Internal event timeline primitives for Home Status shadow evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any


TIMELINE_SCHEMA_VERSION = 1
TIMELINE_STORAGE_VERSION = 1
TIMELINE_STORAGE_KEY = "home_status_timeline"
TIMELINE_RETENTION_DAYS = 7
TIMELINE_MAX_COMPLETED_EVENTS = 200


def _timestamp(value: datetime | str) -> str:
    """Return one stable UTC ISO timestamp."""
    if isinstance(value, datetime):
        stamp = value
    else:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


@dataclass(frozen=True)
class TimelineEvent:
    """One stable occurrence independent of presentation or rendered text."""

    event_id: str
    entity_id: str
    event_type: str
    lifecycle: str
    occurrence_at: str
    started_at: str
    updated_at: str
    ended_at: str | None = None
    duration_seconds: int | None = None
    reminder_at: str | None = None
    expires_at: str | None = None
    revision: int = 1
    schema_version: int = TIMELINE_SCHEMA_VERSION
    context: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "TimelineEvent":
        """Restore a validated event from persisted data."""
        return cls(
            event_id=str(value["event_id"]),
            entity_id=str(value["entity_id"]),
            event_type=str(value["event_type"]),
            lifecycle=str(value["lifecycle"]),
            occurrence_at=_timestamp(value["occurrence_at"]),
            started_at=_timestamp(value["started_at"]),
            updated_at=_timestamp(value["updated_at"]),
            ended_at=(
                _timestamp(value["ended_at"])
                if value.get("ended_at")
                else None
            ),
            duration_seconds=(
                int(value["duration_seconds"])
                if value.get("duration_seconds") is not None
                else None
            ),
            reminder_at=(
                _timestamp(value["reminder_at"])
                if value.get("reminder_at")
                else None
            ),
            expires_at=(
                _timestamp(value["expires_at"])
                if value.get("expires_at")
                else None
            ),
            revision=max(1, int(value.get("revision", 1))),
            schema_version=int(
                value.get("schema_version", TIMELINE_SCHEMA_VERSION)
            ),
            context=dict(value.get("context") or {}),
        )

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-safe persistence record."""
        return asdict(self)


@dataclass(frozen=True)
class ContactObservation:
    """Normalized open/closed observation from a contact entity."""

    entity_id: str
    is_open: bool
    observed_at: str
    label: str
    device_class: str


@dataclass(frozen=True)
class EventProjection:
    """Ephemeral wording derived from a stable event at a point in time."""

    event_id: str
    title: str
    summary: str
    projected_at: str

    def as_dict(self) -> dict[str, str]:
        """Return a JSON-safe diagnostic record."""
        return asdict(self)


def _duration_text(seconds: int) -> str:
    """Return a compact natural duration without changing stored event data."""
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "less than a minute"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = minutes // 60
    remaining_minutes = minutes % 60
    if remaining_minutes:
        return (
            f"{hours} hour{'s' if hours != 1 else ''} "
            f"{remaining_minutes} minute{'s' if remaining_minutes != 1 else ''}"
        )
    return f"{hours} hour{'s' if hours != 1 else ''}"


def _relative_text(value: datetime | str, now: datetime | str) -> str:
    """Return natural relative age computed only for the current projection."""
    stamp = datetime.fromisoformat(_timestamp(value))
    current = datetime.fromisoformat(_timestamp(now))
    seconds = max(0, int((current - stamp).total_seconds()))
    if seconds < 60:
        return "just now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''} ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    if hours < 48:
        return "yesterday"
    days = hours // 24
    return f"{days} days ago"


class ContactEventProjector:
    """Create family-facing contact wording without mutating its event."""

    @classmethod
    def project(
        cls, event: TimelineEvent, now: datetime | str
    ) -> EventProjection | None:
        """Project a supported contact lifecycle at the requested time."""
        if event.event_type != "contact_open":
            return None
        label = str(event.context.get("label") or "Contact").strip()
        projected_at = _timestamp(now)
        if event.lifecycle == "active":
            current = datetime.fromisoformat(projected_at)
            started = datetime.fromisoformat(event.started_at)
            duration = max(0, int((current - started).total_seconds()))
            return EventProjection(
                event_id=event.event_id,
                title=f"{label} Open",
                summary=f"Open for {_duration_text(duration)}",
                projected_at=projected_at,
            )
        if event.lifecycle == "completed" and event.ended_at is not None:
            duration = event.duration_seconds
            if duration is None:
                started = datetime.fromisoformat(event.started_at)
                ended = datetime.fromisoformat(event.ended_at)
                duration = max(0, int((ended - started).total_seconds()))
            return EventProjection(
                event_id=event.event_id,
                title=f"{label} Closed",
                summary=(
                    f"{label} was open for {_duration_text(duration)}"
                    f" • closed {_relative_text(event.ended_at, projected_at)}"
                ),
                projected_at=projected_at,
            )
        return None


class ContactTimelineAdapter:
    """Translate door/window entity states into timeline observations."""

    DEVICE_CLASSES = frozenset(
        {"door", "window", "opening", "garage_door"}
    )
    OPEN_STATES = frozenset({"on", "open", "opening"})
    CLOSED_STATES = frozenset({"off", "closed", "closing"})

    @classmethod
    def observe(
        cls,
        entity_id: str,
        state: str,
        attributes: dict[str, Any] | None,
        observed_at: datetime | str,
    ) -> ContactObservation | None:
        """Return a contact observation or None for unrelated/unknown states."""
        if not str(entity_id).startswith("binary_sensor."):
            return None
        attrs = attributes or {}
        device_class = str(attrs.get("device_class") or "").casefold()
        if device_class not in cls.DEVICE_CLASSES:
            return None
        normalized = str(state or "").casefold()
        if normalized in cls.OPEN_STATES:
            is_open = True
        elif normalized in cls.CLOSED_STATES:
            is_open = False
        else:
            return None
        label = str(
            attrs.get("friendly_name")
            or entity_id.rsplit(".", 1)[-1].replace("_", " ").title()
        ).strip()
        return ContactObservation(
            entity_id=str(entity_id),
            is_open=is_open,
            observed_at=_timestamp(observed_at),
            label=label,
            device_class=device_class,
        )


class TimelineEngine:
    """Maintain stable lifecycle events without producing presentation output."""

    def __init__(self, events: list[TimelineEvent] | None = None) -> None:
        self._events: dict[str, TimelineEvent] = {}
        self._active_by_entity: dict[str, str] = {}
        self._latest_by_entity: dict[str, TimelineEvent] = {}
        for event in events or []:
            self._events[event.event_id] = event
            latest = self._latest_by_entity.get(event.entity_id)
            if latest is None or event.updated_at > latest.updated_at:
                self._latest_by_entity[event.entity_id] = event
            if event.lifecycle == "active":
                active_id = self._active_by_entity.get(event.entity_id)
                active = self._events.get(active_id) if active_id else None
                if active is None or event.started_at > active.started_at:
                    self._active_by_entity[event.entity_id] = event.event_id

    @classmethod
    def from_dict(cls, payload: dict[str, Any] | None) -> "TimelineEngine":
        """Restore timeline state while ignoring malformed records."""
        events = []
        for raw_event in (payload or {}).get("events", []):
            if not isinstance(raw_event, dict):
                continue
            try:
                events.append(TimelineEvent.from_dict(raw_event))
            except (KeyError, TypeError, ValueError):
                continue
        return cls(events)

    @property
    def events(self) -> tuple[TimelineEvent, ...]:
        """Return events in occurrence order for diagnostics and tests."""
        return tuple(
            sorted(
                self._events.values(),
                key=lambda event: (event.occurrence_at, event.event_id),
            )
        )

    def active_event(self, entity_id: str) -> TimelineEvent | None:
        """Return the active event for one entity."""
        event_id = self._active_by_entity.get(entity_id)
        return self._events.get(event_id) if event_id else None

    def apply_contact(
        self, observation: ContactObservation
    ) -> tuple[TimelineEvent | None, bool]:
        """Start or complete one contact event.

        Returns the affected event and whether persistence is required.
        """
        active = self.active_event(observation.entity_id)
        observed_at = _timestamp(observation.observed_at)
        if observation.is_open:
            if active is not None:
                return active, False
            latest = self._latest_by_entity.get(observation.entity_id)
            if latest is not None and observed_at <= latest.updated_at:
                return latest, False
            started_at = observed_at
            event_id = (
                f"contact_open:{observation.entity_id}:{started_at}"
            )
            event = TimelineEvent(
                event_id=event_id,
                entity_id=observation.entity_id,
                event_type="contact_open",
                lifecycle="active",
                occurrence_at=started_at,
                started_at=started_at,
                updated_at=started_at,
                context={
                    "label": observation.label,
                    "device_class": observation.device_class,
                },
            )
            self._events[event_id] = event
            self._active_by_entity[observation.entity_id] = event_id
            self._latest_by_entity[observation.entity_id] = event
            return event, True

        if active is None:
            return None, False
        ended_at = observed_at
        started = datetime.fromisoformat(active.started_at)
        ended = datetime.fromisoformat(ended_at)
        if ended < started:
            return active, False
        duration = round((ended - started).total_seconds())
        completed = replace(
            active,
            lifecycle="completed",
            updated_at=ended_at,
            ended_at=ended_at,
            duration_seconds=duration,
            revision=active.revision + 1,
        )
        self._events[completed.event_id] = completed
        self._active_by_entity.pop(observation.entity_id, None)
        self._latest_by_entity[observation.entity_id] = completed
        return completed, True

    def prune(
        self,
        now: datetime | str,
        *,
        retention_days: int = TIMELINE_RETENTION_DAYS,
        max_completed: int = TIMELINE_MAX_COMPLETED_EVENTS,
    ) -> bool:
        """Bound completed history while retaining every active lifecycle."""
        current = datetime.fromisoformat(_timestamp(now))
        cutoff = current - timedelta(days=max(1, int(retention_days)))
        completed = sorted(
            (
                event
                for event in self._events.values()
                if event.lifecycle == "completed"
            ),
            key=lambda event: (event.updated_at, event.event_id),
            reverse=True,
        )
        retained_ids = {
            event.event_id
            for event in completed[:max(0, int(max_completed))]
            if datetime.fromisoformat(event.updated_at) >= cutoff
        }
        remove_ids = {
            event.event_id
            for event in completed
            if event.event_id not in retained_ids
        }
        if not remove_ids:
            return False
        for event_id in remove_ids:
            self._events.pop(event_id, None)
        self._rebuild_indexes()
        return True

    def _rebuild_indexes(self) -> None:
        """Rebuild entity indexes after retention removes old records."""
        self._active_by_entity = {}
        self._latest_by_entity = {}
        for event in self._events.values():
            latest = self._latest_by_entity.get(event.entity_id)
            if latest is None or event.updated_at > latest.updated_at:
                self._latest_by_entity[event.entity_id] = event
            if event.lifecycle == "active":
                active_id = self._active_by_entity.get(event.entity_id)
                active = self._events.get(active_id) if active_id else None
                if active is None or event.started_at > active.started_at:
                    self._active_by_entity[event.entity_id] = event.event_id

    def as_dict(self) -> dict[str, Any]:
        """Return the complete shadow timeline persistence payload."""
        return {
            "schema_version": TIMELINE_SCHEMA_VERSION,
            "events": [event.as_dict() for event in self.events],
        }
