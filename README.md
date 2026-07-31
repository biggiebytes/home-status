![Home Status](design-assets/home-status-branding/png/banners/home-status-banner-dark-1200x400.png)

<p align="center">
  <img src="design-assets/home-status-branding/png/icons/home-status-icon-dark-256.png"
       alt="Home Status Beacon icon"
       width="128">
</p>

<h1 align="center">Home Status</h1>

<p align="center">
  A notification and awareness platform for Home Assistant.
</p>

Home Status turns household entities and optional information providers into one
stable data contract for dashboards. The integration decides what information
is relevant; the bundled card decides how to present it for phones, tablets,
and desktop dashboards.

## Architecture

### Notification Center

Owns informational awareness such as weather, schedules, maintenance, laundry,
news, reminders, and backend-produced events.

### Direct card logic

Reads immediate household conditions such as alarms, doors, windows, locks, and
leaks directly from Home Assistant.

### Foreground Manager

Remains separate from this repository. It is responsible only for exceptional
tablet interruptions such as alarm and doorbell takeovers.

## Current capabilities

- One `sensor.home_status` data source
- Active, current, upcoming, and timeline streams
- Provider-aware priority and category handling
- Weather alerts and forecasts
- Calendars, waste collection, and watering schedules
- Laundry and appliance lifecycle events
- Maintenance and refrigerator awareness
- Camera availability and doorbell context
- Household presence summaries
- Optional news awareness
- Responsive Home Status card layouts
- Local weather animation assets with bundled licenses

## Repository layout

```text
custom_components/home_status/  Home Assistant integration
www/home-status-card/            Lovelace card and local assets
design-assets/home-status-branding/
                                Beacon identity source and exports
```

## Installation

This repository is being prepared for an initial public release. Until release
packaging is finalized, install it manually.

### Integration

1. Copy `custom_components/home_status` to
   `/config/custom_components/home_status`.
2. Restart Home Assistant.
3. Open **Settings → Devices & services → Add integration**.
4. Search for **Home Status** and complete setup.

### Home Status card

1. Copy `www/home-status-card` to `/config/www/home-status-card`.
2. Add the following dashboard resource:

   ```yaml
   url: /local/home-status-card/home-status-card.js
   type: module
   ```

3. Add the card:

   ```yaml
   type: custom:home-status-card
   entity: sensor.home_status
   layout: tablet-default
   ```

See [`www/home-status-card/example.yaml`](www/home-status-card/example.yaml)
for a fuller configuration example.

## Configuration

The integration is configured through **Settings → Devices & services → Home
Status → Configure**. Available sections cover general behavior, information
sources, weather, appearance, and navigation.

Entity IDs shown in examples are illustrative. Select entities that exist in
your own Home Assistant installation.

## Branding

Beacon is the official Home Status identity. Editable SVG sources, light and
dark variants, integration icons, README logos, documentation banners, colors,
and usage rules are in
[`design-assets/home-status-branding`](design-assets/home-status-branding/README.md).

## Privacy

Home Status runs inside Home Assistant. The repository does not include a Home
Assistant database, `.storage` data, dashboards, secrets, addresses, account
identifiers, access tokens, or household-specific configuration.

Optional RSS providers make outbound requests only when their provider is
enabled.

## Development status

Home Status is under active development. The backend contract and card are
functional, while the homeowner-oriented setup experience and release packaging
are still being refined.

## License

Home Status code and Beacon branding are available under the
[MIT License](LICENSE). Bundled third-party assets retain the license notices
stored beside them.
