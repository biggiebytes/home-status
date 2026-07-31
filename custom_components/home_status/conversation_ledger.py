"""Persisted conversation history for Home Status shadow evaluation."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from typing import Any, Iterable


LEDGER_SCHEMA_VERSION = 1
LEDGER_STORAGE_VERSION = 1
LEDGER_STORAGE_KEY = "home_status_conversation_ledger"
LEDGER_REVISION = 1
SYMBOLIC_LANES = frozenset({"low", "medium", "high", "hidden"})
STATUS_PRESENTED = "presented"
STATUS_RETIRED = "retired"


def _timestamp(value: datetime | str) -> str:
    """Return one stable UTC ISO timestamp."""
    if isinstance(value, datetime):
        stamp = value
    else:
        stamp = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp.astimezone(timezone.utc).isoformat()


def _decision_id(decision: Any) -> str:
    """Return the policy's stable identity without requiring UI concepts."""
    explicit = getattr(decision, "decision_id", None)
    if explicit:
        return str(explicit)
    return (
        f"completed_contact:{decision.event_id}:"
        f"r{int(decision.policy_revision)}"
    )


@dataclass(frozen=True)
class ConversationRecord:
    """One immutable record of what the shadow conversation communicated."""

    event_id: str
    decision_id: str
    presentation_id: str
    lane: str
    presentation_count: int
    first_presented_at: str
    last_presented_at: str
    conversation_status: str
    revision: int = LEDGER_REVISION
    schema_version: int = LEDGER_SCHEMA_VERSION

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "ConversationRecord":
        """Restore a validated persisted conversation record."""
        lane = str(value["lane"])
        if lane not in SYMBOLIC_LANES:
            raise ValueError("unsupported symbolic lane")
        status = str(value["conversation_status"])
        if status not in {STATUS_PRESENTED, STATUS_RETIRED}:
            raise ValueError("unsupported conversation status")
        return cls(
            event_id=str(value["event_id"]),
            decision_id=str(value["decision_id"]),
            presentation_id=str(value["presentation_id"]),
            lane=lane,
            presentation_count=max(0, int(value["presentation_count"])),
            first_presented_at=_timestamp(value["first_presented_at"]),
            last_presented_at=_timestamp(value["last_presented_at"]),
            conversation_status=status,
            revision=max(1, int(value.get("revision", LEDGER_REVISION))),
            schema_version=int(
                value.get("schema_version", LEDGER_SCHEMA_VERSION)
            ),
        )

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-safe persistence record."""
        return asdict(self)


class ConversationLedger:
    """Remember shadow delivery history without modifying events or policy."""

    def __init__(
        self, records: Iterable[ConversationRecord] | None = None
    ) -> None:
        self._records = {
            record.presentation_id: record for record in records or ()
        }
        self._by_event: dict[str, str] = {}
        for record in self._records.values():
            existing_id = self._by_event.get(record.event_id)
            existing = (
                self._records.get(existing_id) if existing_id else None
            )
            if (
                existing is None
                or record.first_presented_at < existing.first_presented_at
            ):
                self._by_event[record.event_id] = record.presentation_id

    @classmethod
    def from_dict(
        cls, payload: dict[str, Any] | None
    ) -> "ConversationLedger":
        """Restore conversation history while ignoring malformed records."""
        records = []
        for raw_record in (payload or {}).get("records", []):
            if not isinstance(raw_record, dict):
                continue
            try:
                records.append(ConversationRecord.from_dict(raw_record))
            except (KeyError, TypeError, ValueError):
                continue
        return cls(records)

    @property
    def records(self) -> tuple[ConversationRecord, ...]:
        """Return records in deterministic presentation order."""
        return tuple(
            sorted(
                self._records.values(),
                key=lambda record: (
                    record.first_presented_at,
                    record.presentation_id,
                ),
            )
        )

    def record(
        self, decision: Any, now: datetime | str
    ) -> tuple[ConversationRecord | None, bool]:
        """Record one eligible decision at most once for its event."""
        lane = str(getattr(decision, "placement", "hidden"))
        if lane not in SYMBOLIC_LANES:
            return None, False
        current = datetime.fromisoformat(_timestamp(now))
        eligible_from = datetime.fromisoformat(
            _timestamp(decision.eligible_from)
        )
        eligible_until = datetime.fromisoformat(
            _timestamp(decision.eligible_until)
        )
        if (
            lane == "hidden"
            or int(getattr(decision, "max_presentations", 0)) < 1
            or current < eligible_from
            or current >= eligible_until
        ):
            return None, False

        existing_id = self._by_event.get(str(decision.event_id))
        existing = self._records.get(existing_id) if existing_id else None
        if existing is not None:
            return existing, False

        decision_id = _decision_id(decision)
        presented_at = _timestamp(current)
        presentation_id = f"presentation:{decision_id}:1"
        record = ConversationRecord(
            event_id=str(decision.event_id),
            decision_id=decision_id,
            presentation_id=presentation_id,
            lane=lane,
            presentation_count=1,
            first_presented_at=presented_at,
            last_presented_at=presented_at,
            conversation_status=STATUS_PRESENTED,
        )
        self._records[presentation_id] = record
        self._by_event[record.event_id] = presentation_id
        return record, True

    def reconcile(
        self, decisions: Iterable[Any], now: datetime | str
    ) -> bool:
        """Record eligible decisions and retire conversations no longer active."""
        current = datetime.fromisoformat(_timestamp(now))
        current_decisions = {
            _decision_id(decision): decision for decision in decisions
        }
        changed = False
        for decision in current_decisions.values():
            _, record_changed = self.record(decision, current)
            changed = record_changed or changed

        for presentation_id, record in tuple(self._records.items()):
            decision = current_decisions.get(record.decision_id)
            expired = (
                decision is None
                or current
                >= datetime.fromisoformat(
                    _timestamp(decision.eligible_until)
                )
            )
            if expired and record.conversation_status != STATUS_RETIRED:
                self._records[presentation_id] = replace(
                    record,
                    conversation_status=STATUS_RETIRED,
                    revision=record.revision + 1,
                )
                changed = True
        return changed

    def as_dict(self) -> dict[str, Any]:
        """Return the complete conversation-ledger persistence payload."""
        return {
            "schema_version": LEDGER_SCHEMA_VERSION,
            "records": [record.as_dict() for record in self.records],
        }
