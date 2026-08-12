# Home Status

Home Status is a Home Assistant custom integration and bundled Lovelace card
for a concise household-status view. It uses the devices selected during setup
and publishes the result through `sensor.home_status`.

## Installation

Install this repository through HACS as an **Integration**, restart Home
Assistant, then add **Home Status** in **Settings → Devices & services**. The
bundled card registers automatically; no separate dashboard resource is needed.

For manual installation, copy `custom_components/home_status` to
`/config/custom_components/`, restart Home Assistant, and add the integration.

## Appliance behavior

Select the whole appliance device during Home Status setup. For selected
washers, dryers, and dishwashers, Home Status recognizes the appliance's
operating-state entity and shows:

- running state and time remaining when the appliance provides it;
- a retained completion event when the cycle ends; and
- recognized faults.

Supporting controls and telemetry are intentionally ignored so they do not
become misleading ticker events.

## Data and privacy

Home Status only publishes the bounded presentation data required by the card.
The published sensor payload stays below Home Assistant Recorder's attribute
limit, preventing unnecessary database churn. Household configuration, entity
history, databases, and credentials are not part of this repository.

## Development checks

Run the Python release checks with:

```sh
python -m pytest -q
```

The card editor browser check requires the `playwright` development dependency
and a local browser installation:

```sh
npm install
npm run test:card
```

## Version

Current integration version: **0.6.9**.

## License

MIT.
