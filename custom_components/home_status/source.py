"""Non-device information sources for Home Status.

Sources represent information that does not belong to a physical Home Device:
weather, calendars, people/location, zones, utility accounts, and later feed/news
adapters.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class HomeSource:
    """One user-selectable non-device Home Status source."""

    id: str
    name: str
    kind: str
    entity_id: str
    domain: str
    area_id: str | None = None
    area_name: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "entity_id": self.entity_id,
            "domain": self.domain,
            "area_id": self.area_id,
            "area_name": self.area_name,
            "metadata": dict(self.metadata or {}),
        }
