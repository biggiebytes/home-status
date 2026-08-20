"""Broad Home Assistant device/entity discovery for Home Status.

Discovery is convenience, never a gate. Device discovery groups HA device-registry
entries for users who prefer selecting a whole physical device. The config flow also
exposes an unrestricted Home Assistant entity selector so any entity can be monitored.
"""

from __future__ import annotations

from collections import defaultdict

from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er

from .home_device import HomeDevice, HomeDeviceEntity


_SOURCE_DOMAINS = {"weather", "calendar", "person", "zone"}


def _display_name(entity_entry, state) -> str:
    return str(
        entity_entry.name
        or entity_entry.original_name
        or (state.attributes.get("friendly_name") if state else None)
        or entity_entry.entity_id
    )


def _home_device_kind(entities: list[HomeDeviceEntity]) -> str:
    """Return an interpreter hint only; this must never gate discovery."""
    classes = {str(entity.device_class or "").casefold() for entity in entities}
    domains = {entity.domain for entity in entities}

    if classes & {"smoke", "carbon_monoxide", "gas", "moisture", "safety"}:
        return "safety"
    if "alarm_control_panel" in domains:
        return "security"
    if classes & {"door", "window", "opening", "garage_door"} or "lock" in domains:
        return "entry"
    if "climate" in domains:
        return "climate"
    if "camera" in domains:
        return "camera"
    if classes & {"motion", "occupancy", "presence"}:
        return "presence"
    if classes & {
        "temperature", "humidity", "pressure", "carbon_dioxide", "carbon_monoxide",
        "pm1", "pm25", "pm10", "volatile_organic_compounds",
        "volatile_organic_compounds_parts", "aqi", "nitrogen_dioxide", "ozone",
        "sulphur_dioxide", "illuminance",
    }:
        return "environment"
    if classes & {"power", "energy", "voltage", "current", "battery"}:
        return "energy"
    if "valve" in domains:
        return "valve"

    # These are interpreter hints, not discovery gates. They help the existing
    # appliance/irrigation interpreters choose behavior while every device remains
    # selectable regardless of whether the hint is correct.
    names = " ".join(entity.name.casefold() for entity in entities)
    if any(word in names for word in (
        "washer", "dryer", "dishwasher", "laundry", "cycle", "remaining",
        "refrigerator", "freezer", "oven", "range",
    )):
        return "appliance"
    if any(word in names for word in ("sprinkler", "irrigation", "watering", "rain delay")):
        return "irrigation"
    return "generic"


def _entity_record(entry, state) -> HomeDeviceEntity:
    domain = entry.entity_id.split(".", 1)[0]
    device_class = (
        str(state.attributes.get("device_class"))
        if state and state.attributes.get("device_class") is not None
        else str(getattr(entry, "original_device_class", "") or "") or None
    )
    return HomeDeviceEntity(
        entity_id=entry.entity_id,
        domain=domain,
        name=_display_name(entry, state),
        device_class=device_class,
        entity_category=(str(entry.entity_category) if entry.entity_category is not None else None),
        unit=(str(state.attributes.get("unit_of_measurement")) if state and state.attributes.get("unit_of_measurement") else None),
        icon=(str(state.attributes.get("icon")) if state and state.attributes.get("icon") else None),
    )


def discover_home_devices(hass: HomeAssistant) -> list[HomeDevice]:
    """Discover every HA device that has at least one enabled, non-hidden entity.

    No kind/category whitelist is applied. `kind` is only an interpreter hint.
    Non-device entities are available through the unrestricted entity selector.
    """
    devices = dr.async_get(hass)
    entities = er.async_get(hass)
    areas = ar.async_get(hass)

    by_device: dict[str, list[HomeDeviceEntity]] = defaultdict(list)

    for entry in entities.entities.values():
        if entry.disabled_by is not None or getattr(entry, "hidden_by", None) is not None:
            continue
        domain = entry.entity_id.split(".", 1)[0]
        if domain in _SOURCE_DOMAINS or not entry.device_id:
            continue
        by_device[entry.device_id].append(_entity_record(entry, hass.states.get(entry.entity_id)))

    home_devices: list[HomeDevice] = []
    for device_id, device_entities in by_device.items():
        if not device_entities:
            continue
        device = devices.async_get(device_id)
        if device is None:
            continue
        area = areas.async_get_area(device.area_id) if device.area_id else None
        name = str(device.name_by_user or device.name or device.model or "Home Assistant Device")
        home_devices.append(
            HomeDevice(
                id=f"device:{device_id}",
                name=name,
                kind=_home_device_kind(device_entities),
                area_id=device.area_id,
                area_name=area.name if area else None,
                device_id=device_id,
                manufacturer=device.manufacturer,
                model=device.model,
                entities=sorted(device_entities, key=lambda value: value.name.casefold()),
            )
        )

    return sorted(
        home_devices,
        key=lambda home_device: ((home_device.area_name or "").casefold(), home_device.name.casefold()),
    )


def manual_home_device_for_entity(
    hass: HomeAssistant,
    entity_id: str,
    *,
    display_name: str | None = None,
) -> HomeDevice | None:
    """Wrap any HA entity as a one-entity HomeDevice for explicit monitoring."""
    registry = er.async_get(hass)
    devices = dr.async_get(hass)
    areas = ar.async_get(hass)
    entry = registry.async_get(entity_id)
    state = hass.states.get(entity_id)

    # EntitySelector can include runtime entities that are not in the registry.
    if entry is None and state is None:
        return None

    parent_device_name = ""
    if entry is not None:
        item = _entity_record(entry, state)
        area_id = getattr(entry, "area_id", None)
        if entry.device_id and (device := devices.async_get(entry.device_id)) is not None:
            parent_device_name = str(device.name_by_user or device.name or "").strip()
    else:
        domain = entity_id.split(".", 1)[0]
        attrs = state.attributes if state else {}
        item = HomeDeviceEntity(
            entity_id=entity_id,
            domain=domain,
            name=str(attrs.get("friendly_name") or entity_id),
            device_class=str(attrs.get("device_class") or "") or None,
            entity_category=None,
            unit=str(attrs.get("unit_of_measurement") or "") or None,
            icon=str(attrs.get("icon") or "") or None,
        )
        area_id = None

    area = areas.async_get_area(area_id) if area_id else None
    return HomeDevice(
        id=f"entity:{entity_id}",
        name=display_name or item.name,
        kind=_home_device_kind([item]),
        area_id=area_id,
        area_name=area.name if area else None,
        entities=[item],
        metadata={"manual_entity": True, "parent_device_name": parent_device_name},
    )


def selected_entity_ids(home_devices: list[HomeDevice], selected_home_device_ids: set[str]) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            entity_id
            for home_device in home_devices
            if home_device.id in selected_home_device_ids
            for entity_id in home_device.entity_ids
        )
    )
