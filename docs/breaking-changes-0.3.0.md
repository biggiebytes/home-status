# Home Status 0.3.0 breaking changes

## Explicit entity configuration

Home Status no longer starts monitoring entities from legacy automatic
entity-name mappings. The retired configuration fields are `source_entities`,
`entities`, `entity_ids`, and the old automatic history selection.

Monitoring now begins only after an entity is explicitly saved through
**Add & Configure Entities**. Existing capability selections are retained.

## Upgrade steps

1. Restart Home Assistant after installing 0.3.0.
2. Open **Settings → Devices & Services → Home Status → Configure**.
3. Open **Add & Configure Entities**.
4. Choose Quick Start, Recommended Setup, or Custom Setup.
5. Review the proposed entities and submit the selection you want monitored.

The Quick Start and Recommended Setup lists are recommendations only. They do
not monitor anything until submitted.
