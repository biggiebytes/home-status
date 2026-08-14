"""Discovery-first Home Status engine for Home Devices and Sources."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from .discovery import discover_home_devices, manual_home_device_for_entity
from .home_device import HomeDevice
from .interpreters import (
    awareness_only_entity,
    appliance_current_fact,
    appliance_recent_entity_ids,
    appliance_transition_fact,
    awareness_entity,
    has_appliance_recent_capability,
    interpret_appliance_home_device,
    interpret_entity,
)
from .source import HomeSource
from .source_discovery import discover_sources
from .source_interpreters import household_presence_item, interpret_source


class HomeStatusEngine:
    """Turn selected Home Devices and Sources into normalized Home Status items."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._home_devices: dict[str, HomeDevice] = {}
        self._sources: dict[str, HomeSource] = {}

    def discover_home_devices(self) -> list[HomeDevice]:
        items = discover_home_devices(self.hass)
        self._home_devices = {item.id: item for item in items}
        return items

    def discover_sources(self) -> list[HomeSource]:
        items = discover_sources(self.hass)
        self._sources = {item.id: item for item in items}
        return items

    def home_devices(self) -> dict[str, HomeDevice]:
        self.discover_home_devices()
        return self._home_devices

    def sources(self) -> dict[str, HomeSource]:
        self.discover_sources()
        return self._sources

    @staticmethod
    def _name_overrides(options: dict[str, Any]) -> dict[str, str]:
        value = options.get("name_overrides", {})
        if not isinstance(value, dict):
            return {}
        return {
            str(key): str(name).strip()
            for key, name in value.items()
            if str(name).strip()
        }


    @staticmethod
    def _selected_entity_ids(options: dict[str, Any]) -> list[str]:
        value = options.get("selected_entities", [])
        if not isinstance(value, list):
            return []
        return [str(entity_id) for entity_id in value if str(entity_id)]

    @staticmethod
    def _entity_display_name(options: dict[str, Any], entity_id: str, friendly_name: str) -> str:
        modes = options.get("entity_name_modes", {})
        overrides = options.get("entity_name_overrides", {})
        mode = str(modes.get(entity_id, "friendly")) if isinstance(modes, dict) else "friendly"
        custom = str(overrides.get(entity_id, "")).strip() if isinstance(overrides, dict) else ""
        if mode == "custom" and custom:
            return custom
        if mode == "raw":
            return entity_id.split(".", 1)[-1]
        return friendly_name

    def selected_entities(self, options: dict[str, Any]) -> list[HomeDevice]:
        """Return explicit entity selections as one-entity HomeDevices.

        This path is intentionally unrestricted. Discovery/classification does not
        decide whether an entity is selectable.
        """
        result: list[HomeDevice] = []
        for entity_id in self._selected_entity_ids(options):
            base = manual_home_device_for_entity(self.hass, entity_id)
            if base is None:
                continue
            name = self._entity_display_name(options, entity_id, base.name)
            original_name = base.name
            base.name = name
            base.metadata = {**(base.metadata or {}), "name_overridden": name != original_name, "manual_entity": True}
            result.append(base)
        return result

    def selected_home_devices(self, options: dict[str, Any]) -> list[HomeDevice]:
        selected = options.get("selected_devices", [])
        if not isinstance(selected, list):
            return []
        selected_ids = {str(value) for value in selected}
        overrides = self._name_overrides(options)
        return [
            replace(
                item,
                name=overrides.get(item.id, item.name),
                metadata={**(item.metadata or {}), 'name_overridden': item.id in overrides},
            )
            for item_id, item in self.home_devices().items()
            if item_id in selected_ids
        ]


    def _manual_appliance_context(self, selected: HomeDevice) -> HomeDevice:
        """Return physical-device context for a manually selected appliance state entity.

        Manual entity selection remains authoritative, but appliance presentation may
        borrow sibling telemetry (remaining time / end-of-cycle) from the same HA
        device so a one-entity selection can still render the full compact contract.
        """
        if not selected.metadata.get("manual_entity") or len(selected.entities) != 1:
            return selected

        primary = selected.entities[0]
        if selected.kind != "appliance":
            return selected

        registry = er.async_get(self.hass)
        entry = registry.async_get(primary.entity_id)
        device_id = getattr(entry, "device_id", None) if entry is not None else None
        if not device_id:
            return selected

        physical = next(
            (item for item in self.home_devices().values() if item.device_id == device_id),
            None,
        )
        if physical is None:
            return selected

        return replace(
            selected,
            # All manually selected appliance entities from one physical HA device
            # must normalize to one Home Status appliance identity. Otherwise a
            # selected machine-state, remaining-time, and end-of-cycle entity can
            # each create their own parallel appliance lifecycle and resolve into
            # duplicate Complete events.
            id=physical.id,
            device_id=physical.device_id,
            manufacturer=physical.manufacturer,
            model=physical.model,
            entities=physical.entities,
            metadata={
                **(selected.metadata or {}),
                "manual_primary_entity_id": primary.entity_id,
                "appliance_context_device_id": device_id,
            },
        )

    def selected_sources(self, options: dict[str, Any]) -> list[HomeSource]:
        selected = options.get("selected_sources", [])
        if not isinstance(selected, list):
            return []
        selected_ids = {str(value) for value in selected}
        overrides = self._name_overrides(options)
        return [
            replace(
                item,
                name=overrides.get(item.id, item.name),
                metadata={**(item.metadata or {}), 'name_overridden': item.id in overrides},
            )
            for item_id, item in self.sources().items()
            if item_id in selected_ids
        ]


    def display_name_for_item(self, options: dict[str, Any], item: dict[str, Any]) -> str | None:
        """Resolve the current user-facing name for a normalized item reference."""
        entity_id = str(item.get("entity_id") or "")
        if entity_id in self._selected_entity_ids(options):
            for selected in self.selected_entities(options):
                if selected.entities and selected.entities[0].entity_id == entity_id:
                    return selected.name
        home_device_id = str(item.get("home_device_id") or "")
        if home_device_id:
            for home_device in self.selected_home_devices(options):
                if home_device.id == home_device_id:
                    return home_device.name

        # Native facts carry an entity id, not the old interpreted item with a
        # Home Device id. Recover the same selected Home Device identity here so
        # current facts and Recorder transitions share one naming authority.
        for home_device in self.selected_home_devices(options):
            if any(entity.entity_id == entity_id for entity in home_device.entities):
                return home_device.name

        source_id = str(item.get("source_id") or "")
        if source_id:
            for source in self.selected_sources(options):
                if source.id == source_id:
                    return source.name

        return None

    def observed_entity_ids(self, options: dict[str, Any]) -> tuple[str, ...]:
        manual_selected = self.selected_entities(options)
        return tuple(dict.fromkeys([
            *(
                entity.entity_id
                for home_device in self.selected_home_devices(options)
                for entity in home_device.entities
            ),
            *(
                entity.entity_id
                for selected in manual_selected
                for entity in self._manual_appliance_context(selected).entities
            ),
            *(source.entity_id for source in self.selected_sources(options)),
            *(self._household_person_ids(options) if options.get("household_presence_enabled", False) else ()),
        ]))

    def recent_entity_ids(self, options: dict[str, Any]) -> tuple[str, ...]:
        """Return selected entities eligible for a Recorder recent read."""
        entity_ids: list[str] = []
        seen_appliance_ids: set[str] = set()
        selected = [*self.selected_home_devices(options), *self.selected_entities(options)]
        for home_device in selected:
            context = self._manual_appliance_context(home_device)
            if not has_appliance_recent_capability(context):
                entity_ids.extend(
                    entity.entity_id
                    for entity in home_device.entities
                    if not awareness_only_entity(home_device, entity)
                )
                continue
            if context.id in seen_appliance_ids:
                continue
            seen_appliance_ids.add(context.id)
            entity_ids.extend(appliance_recent_entity_ids(self.hass, context))
        return tuple(dict.fromkeys(entity_ids))

    def appliance_context_for_entity(
        self, options: dict[str, Any], entity_id: str
    ) -> HomeDevice | None:
        """Return the selected semantic appliance context owning an entity."""
        seen: set[str] = set()
        for selected in [*self.selected_home_devices(options), *self.selected_entities(options)]:
            context = self._manual_appliance_context(selected)
            if context.id in seen or not has_appliance_recent_capability(context):
                continue
            seen.add(context.id)
            if any(entity.entity_id == entity_id for entity in context.entities):
                return context
        return None

    def native_current_facts(self, options: dict[str, Any]) -> list[dict[str, Any]]:
        """Return semantic appliance current facts for the HA-native contract."""
        result: list[dict[str, Any]] = []
        seen: set[str] = set()
        for selected in [*self.selected_home_devices(options), *self.selected_entities(options)]:
            context = self._manual_appliance_context(selected)
            if context.id in seen or not has_appliance_recent_capability(context):
                continue
            seen.add(context.id)
            if fact := appliance_current_fact(self.hass, context):
                result.append(fact)
        return result

    def appliance_owned_entity_ids(self, options: dict[str, Any]) -> set[str]:
        """Return raw entities replaced by one semantic appliance fact."""
        entity_ids: set[str] = set()
        seen: set[str] = set()
        for selected in [*self.selected_home_devices(options), *self.selected_entities(options)]:
            context = self._manual_appliance_context(selected)
            if context.id in seen or not has_appliance_recent_capability(context):
                continue
            seen.add(context.id)
            entity_ids.update(context.entity_ids)
        return entity_ids

    def native_recent_facts(
        self, options: dict[str, Any], transitions: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Apply appliance meaning to Recorder rows, leaving other rows intact."""
        result: list[dict[str, Any]] = []
        for transition in transitions:
            context = self.appliance_context_for_entity(
                options, str(transition.get("entity_id") or "")
            )
            if context is None:
                result.append(transition)
                continue
            if fact := appliance_transition_fact(self.hass, context, transition):
                result.append(fact)
        return result

    def _household_person_ids(self, options: dict[str, Any]) -> list[str]:
        configured = options.get("household_presence_people", [])
        if isinstance(configured, list) and configured:
            return [str(entity_id) for entity_id in configured if str(entity_id).startswith("person.")]
        return [source.entity_id for source in self.sources().values() if source.domain == "person"]

    def build_active_items(self, options: dict[str, Any]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        explicit_ids = set(self._selected_entity_ids(options))
        for selected in self.selected_entities(options):
            appliance_context = self._manual_appliance_context(selected)
            appliance_items = interpret_appliance_home_device(self.hass, appliance_context)
            if appliance_items:
                items.extend(appliance_items)
                continue
            for entity in selected.entities:
                items.extend(interpret_entity(self.hass, selected, entity))
        for home_device in self.selected_home_devices(options):
            appliance_items = interpret_appliance_home_device(self.hass, home_device)
            if appliance_items and not any(str(item.get("entity_id")) in explicit_ids for item in appliance_items):
                items.extend(appliance_items)
                continue
            for entity in home_device.entities:
                if entity.entity_id in explicit_ids:
                    continue
                items.extend(interpret_entity(self.hass, home_device, entity))
        return self._dedupe(items)

    def build_awareness_items(self, options: dict[str, Any]) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        explicit_ids = set(self._selected_entity_ids(options))
        household_people = set(self._household_person_ids(options)) if options.get("household_presence_enabled", False) else set()
        for selected in self.selected_entities(options):
            for entity in selected.entities:
                items.extend(awareness_entity(self.hass, selected, entity))
        for home_device in self.selected_home_devices(options):
            for entity in home_device.entities:
                if entity.entity_id in explicit_ids:
                    continue
                items.extend(awareness_entity(self.hass, home_device, entity))
        for source in self.selected_sources(options):
            if source.domain == "person" and source.entity_id in household_people:
                continue
            items.extend(interpret_source(self.hass, source))
        if household_people:
            household = household_presence_item(self.hass, sorted(household_people))
            if household is not None:
                items.append(household)
        return self._dedupe(items)

    @staticmethod
    def _dedupe(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result = []
        seen = set()
        for item in items:
            key = str(item.get("id") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            result.append(item)
        return result
