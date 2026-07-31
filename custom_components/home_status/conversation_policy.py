"""Private conversation-policy decisions for Home Status shadow evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable


POLICY_SCHEMA_VERSION = 1
POLICY_STORAGE_VERSION = 1
POLICY_STORAGE_KEY = "home_status_conversation_policy"
POLICY_REVISION = 1
COMPLETED_CONTACT_LIFETIME_SECONDS = 2 * 60 * 60
PLACEMENT_LOW = "low"


def _timestamp(value: datetime | str) -> str:
    """Return one stable UTC ISO timestamp."""
    if isinstance(value, datetime):
        stamp = value
    else:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


def _lifetime_text(seconds: int) -> str:
    """Describe a configured eligibility lifetime for diagnostics."""
    minutes = max(1, int(seconds) // 60)
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = minutes // 60
    if minutes % 60 == 0:
        return f"{hours} hour{'s' if hours != 1 else ''}"
    return f"{minutes} minutes"


@dataclass(frozen=True)
class ConversationDecision:
    """One immutable attention decision, separate from event truth."""

    event_id: str
    placement: str
    presentation_priority: str
    eligible_from: str
    eligible_until: str
    resurface_at: str | None
    max_presentations: int
    reason: str
    policy_revision: int = POLICY_REVISION
    schema_version: int = POLICY_SCHEMA_VERSION

    @property
    def decision_id(self) -> str:
        """Return a deterministic identity without adding presentation state."""
        return (
            f"completed_contact:{self.event_id}:"
            f"r{self.policy_revision}"
        )

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ConversationDecision":
        """Restore a validated persisted decision."""
        placement = str(value["placement"])
        if placement not in {"low", "medium", "high", "hidden"}:
            raise ValueError("unsupported symbolic placement")
        return cls(
            event_id=str(value["event_id"]),
            placement=placement,
            presentation_priority=str(value["presentation_priority"]),
            eligible_from=_timestamp(value["eligible_from"]),
            eligible_until=_timestamp(value["eligible_until"]),
            resurface_at=(
                _timestamp(value["resurface_at"])
                if value.get("resurface_at")
                else None
            ),
            max_presentations=max(0, int(value["max_presentations"])),
            reason=str(value["reason"]),
            policy_revision=max(
                1, int(value.get("policy_revision", POLICY_REVISION))
            ),
            schema_version=int(
                value.get("schema_version", POLICY_SCHEMA_VERSION)
            ),
        )

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-safe persistence record."""
        return asdict(self)


class ShadowConversationPolicy:
    """Make deterministic attention decisions without selecting a UI lane."""

    def __init__(
        self,
        decisions: Iterable[ConversationDecision] | None = None,
        *,
        completed_contact_lifetime_seconds: int = (
            COMPLETED_CONTACT_LIFETIME_SECONDS
        ),
    ) -> None:
        self.completed_contact_lifetime_seconds = max(
            60, int(completed_contact_lifetime_seconds)
        )
        self._decisions = {
            decision.event_id: decision for decision in decisions or ()
        }

    @classmethod
    def from_dict(
        cls,
        payload: dict[str, Any] | None,
        *,
        completed_contact_lifetime_seconds: int = (
            COMPLETED_CONTACT_LIFETIME_SECONDS
        ),
    ) -> "ShadowConversationPolicy":
        """Restore decisions while ignoring malformed records."""
        decisions = []
        for raw_decision in (payload or {}).get("decisions", []):
            if not isinstance(raw_decision, dict):
                continue
            try:
                decisions.append(ConversationDecision.from_dict(raw_decision))
            except (KeyError, TypeError, ValueError):
                continue
        return cls(
            decisions,
            completed_contact_lifetime_seconds=(
                completed_contact_lifetime_seconds
            ),
        )

    @property
    def decisions(self) -> tuple[ConversationDecision, ...]:
        """Return persisted decisions in deterministic order."""
        return tuple(
            sorted(
                self._decisions.values(),
                key=lambda decision: (
                    decision.eligible_from,
                    decision.event_id,
                ),
            )
        )

    def _completed_contact_decision(
        self, event: Any
    ) -> ConversationDecision | None:
        """Build the deterministic rule output for one supported event."""
        if (
            getattr(event, "event_type", None) != "contact_open"
            or getattr(event, "lifecycle", None) != "completed"
            or not getattr(event, "ended_at", None)
        ):
            return None
        eligible_from = _timestamp(event.ended_at)
        eligible_until = _timestamp(
            datetime.fromisoformat(eligible_from)
            + timedelta(seconds=self.completed_contact_lifetime_seconds)
        )
        lifetime = _lifetime_text(
            self.completed_contact_lifetime_seconds
        )
        return ConversationDecision(
            event_id=str(event.event_id),
            placement=PLACEMENT_LOW,
            presentation_priority="activity",
            eligible_from=eligible_from,
            eligible_until=eligible_until,
            resurface_at=None,
            max_presentations=1,
            reason=(
                "Low attention because completed contact events are eligible "
                f"once for {lifetime}."
            ),
        )

    def evaluate(
        self, event: Any, now: datetime | str
    ) -> tuple[ConversationDecision | None, bool]:
        """Return the current decision and whether persistence changed."""
        desired = self._completed_contact_decision(event)
        existing = self._decisions.get(str(getattr(event, "event_id", "")))
        if desired is None:
            if existing is not None:
                self._decisions.pop(existing.event_id, None)
                return None, True
            return None, False
        current = datetime.fromisoformat(_timestamp(now))
        eligible_from = datetime.fromisoformat(desired.eligible_from)
        eligible_until = datetime.fromisoformat(desired.eligible_until)
        if current < eligible_from or current >= eligible_until:
            if existing is not None:
                self._decisions.pop(existing.event_id, None)
                return None, True
            return None, False
        if existing == desired:
            return existing, False
        self._decisions[desired.event_id] = desired
        return desired, True

    def reconcile(
        self, events: Iterable[Any], now: datetime | str
    ) -> bool:
        """Reconcile persisted decisions with current timeline truth."""
        supported_ids = set()
        changed = False
        for event in events:
            desired = self._completed_contact_decision(event)
            if desired is not None:
                supported_ids.add(desired.event_id)
            _, event_changed = self.evaluate(event, now)
            changed = event_changed or changed
        stale_ids = set(self._decisions) - supported_ids
        for event_id in stale_ids:
            self._decisions.pop(event_id, None)
            changed = True
        return changed

    def as_dict(self) -> dict[str, Any]:
        """Return the complete shadow-policy persistence payload."""
        return {
            "schema_version": POLICY_SCHEMA_VERSION,
            "policy_revision": POLICY_REVISION,
            "decisions": [
                decision.as_dict() for decision in self.decisions
            ],
        }
