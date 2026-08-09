"""Device-first data model for Home Status discovery.

A Thing is either a Home Assistant device or a useful standalone entity.
The user selects Things. Home Status decides which entities are useful and
how to interpret them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class ThingEntity:
    """One useful Home Assistant entity that belongs to a Thing."""

    entity_id: str
    domain: str
    name: str
    device_class: str | None = None
    entity_category: str | None = None
    unit: str | None = None
    icon: str | None = None


@dataclass(slots=True)
class Thing:
    """A user-facing Home Status object discovered from Home Assistant."""

    id: str
    name: str
    kind: str
    area_id: str | None = None
    area_name: str | None = None
    device_id: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    entities: list[ThingEntity] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def entity_ids(self) -> tuple[str, ...]:
        return tuple(entity.entity_id for entity in self.entities)

    def as_dict(self) -> dict[str, Any]:
        """Return a compact serializable discovery record."""
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "area_id": self.area_id,
            "area_name": self.area_name,
            "device_id": self.device_id,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "entities": [
                {
                    "entity_id": entity.entity_id,
                    "domain": entity.domain,
                    "name": entity.name,
                    "device_class": entity.device_class,
                    "entity_category": entity.entity_category,
                    "unit": entity.unit,
                    "icon": entity.icon,
                }
                for entity in self.entities
            ],
        }
