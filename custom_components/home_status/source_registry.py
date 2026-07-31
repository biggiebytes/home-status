from __future__ import annotations

from dataclasses import dataclass

from .const import (
    DEFAULT_SOURCE_GROUPS,
    EXPLICIT_BINARY_NOTIFICATION_SOURCES,
    LIVE_STATE_DOMAINS,
    LIVE_STATE_ROLES,
    SOURCE_ROLE_PROVIDERS,
)


@dataclass(frozen=True)
class SourceRegistry:
    """Resolved role-based Home Assistant sources for one config entry."""

    groups: dict[str, tuple[str, ...]]

    @classmethod
    def from_config(cls, configured: list[str] | dict[str, list[str]] | None = None) -> "SourceRegistry":
        configured_list = configured if isinstance(configured, list) else []
        groups = {
            role: tuple(dict.fromkeys(sources))
            for role, sources in DEFAULT_SOURCE_GROUPS.items()
        }
        if isinstance(configured, dict):
            for role, sources in configured.items():
                if isinstance(sources, list):
                    groups[role] = tuple(dict.fromkeys([*groups.get(role, ()), *sources]))
        elif configured_list:
            groups["configured"] = tuple(dict.fromkeys(configured_list))
        groups = {
            role: tuple(entity_id for entity_id in sources if cls._is_notification_source(role, entity_id))
            for role, sources in groups.items()
        }
        return cls(groups)

    @staticmethod
    def _is_notification_source(role: str, entity_id: str) -> bool:
        if entity_id in EXPLICIT_BINARY_NOTIFICATION_SOURCES:
            return True
        if role in LIVE_STATE_ROLES:
            return False
        return entity_id.split(".", 1)[0] not in LIVE_STATE_DOMAINS

    def get(self, role: str) -> tuple[str, ...]:
        return self.groups.get(role, ())

    def get_sources(self, role: str) -> tuple[str, ...]:
        return self.get(role)

    @staticmethod
    def provider_for(role: str) -> str | None:
        return SOURCE_ROLE_PROVIDERS.get(role)

    def all(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(source for sources in self.groups.values() for source in sources))
