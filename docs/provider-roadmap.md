# Capability provider roadmap

Home Status is moving toward reusable, capability-based providers that consume
entities already created by Home Assistant integrations. Providers normalize
information into the existing Home Status item contract; they do not contain
card presentation logic and they do not replace device integrations.

Discovery only produces choices. A matching entity is never monitored or
published until the user selects it.

## Provider maturity

- **Disabled** — unavailable or not selected.
- **Experimental** — opt-in and still gathering community compatibility data.
- **Stable** — tested across common Home Assistant metadata variations.

## Stage 1 — environmental measurements

- Temperature
- Humidity

Both use standard sensor metadata, configurable per-entity thresholds, native
Home Assistant units, and optional current-value publication. They begin as
Experimental.

## Stage 2 — immediate safety and availability

The first Stage 2 providers are **Experimental** and use only explicitly
selected standard `binary_sensor` entities. They publish sustained alerts only
while the selected entity indicates an active condition; discovery never
enables monitoring by itself.

- Smoke (`device_class: smoke`)
- Carbon monoxide (`device_class: carbon_monoxide`)
- Internet/WAN connectivity (`device_class: connectivity`; alerts when off)
- Device problem signals (`device_class: problem`)

Generic unavailable-state monitoring remains a later addition: Home Status
will require an explicit, bounded opt-in model before treating an unavailable
entity as a household alert.

## Stage 3 — utilities, infrastructure, and equipment

- Indoor air quality
- Water flow and water usage
- UPS and backup power
- Power and energy
- HVAC status and faults
- Refrigerator/freezer temperature

Thresholds and alert behavior remain configurable. Home Status will not invent
universal safe limits.

## Stage 4 — household context and movement

- Sun position, sunrise, sunset, daylight remaining, and night state
- Traffic and commute time
- Presence and family location
- Packages and deliveries
- Camera detection events
- Locks and garage doors

### Source boundaries

**Sun** uses Home Assistant's standard `sun.sun` entity and its attributes. It
may create useful schedule or context items for sunrise, sunset, daylight
remaining, and night state, but should not continuously publish redundant sun
status.

**Traffic** consumes user-selected travel-time or commute sensors supplied by
existing Home Assistant integrations. Home Status will not implement routing,
mapping, or traffic collection. It will normalize current travel time, normal
travel time, delay, destination, route name, and last update when available.

**Presence** consumes user-selected `person`, `device_tracker`, or presence
binary sensors. Precise coordinates must never appear in Home Status items or
diagnostics.

**Packages** consumes existing mail and delivery integrations and normalizes
carrier, status, expected date, delivery state, and package count when
available.

**Camera events** consume existing Home Assistant binary sensors or events for
person, vehicle, animal, doorbell, and motion detections. Object detection does
not belong inside Home Status.

**Locks and garage doors** may continue using the direct-state model for live
household conditions. Their normalized event contract must remain compatible
with the provider and timeline pipeline.

## Stage 5 — home systems and specialty equipment

- Device battery monitoring
- Solar production
- Home batteries
- Generators
- EV charging
- Water heaters
- Air purifiers
- Pool and spa equipment
- Mailbox events

These providers will consume user-selected entities from existing Home
Assistant integrations and remain brand-neutral wherever standard metadata is
sufficient.
