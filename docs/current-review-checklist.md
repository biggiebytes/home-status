# Current review checklist

This is the agreed follow-up list after the configurable-entity release.
These are product fixes and refinements, not automatic monitoring behavior.

## Implemented in the next test build

- **Remove picker:** show only entities that Home Status is currently
  monitoring, while keeping search by friendly name and entity ID.
- **Ticker timestamps:** event entries in the bottom ticker show a relative
  age such as `3 min ago`. Steady status entries stay uncluttered.
- **Resolved colors:** when an item returns to its normal state, its ticker
  icon uses the normal/resolved color (green). Active attention or critical
  conditions retain their alert colors.
- **Motion wording:** use the friendly configured location/name in the second
  line. For example: title `Motion Detected`; detail `Living Room`.
- **Human-friendly names:** all user-facing setup screens, ticker entries,
  and alerts use the entity's friendly name or the user's configured display
  name. Entity IDs are searchable for precision but are never used as a
  visible label.

## Implemented setup improvements

- **Recommended Setup filters:** let people choose categories before the
  recommendation review, for example doors and windows, motion, safety,
  camera/device health, appliances, connectivity, and environmental sensors.
- **Camera distinction:** camera health/availability and camera-motion alerts
  are separate opt-in categories. Selecting one never selects the other.
- **Recommendation scope:** exclude generic, low-value device availability
  entities by default. They remain available through explicit Custom Setup.

## Invariants to preserve

- Discovery and recommendations never begin monitoring by themselves.
- Every monitored entity has an explicit saved configuration.
- Entity behavior is derived from Home Assistant metadata and the saved
  configuration, never from hardcoded household entity names.
