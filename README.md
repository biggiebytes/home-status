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

Home Status transforms Home Assistant into a unified household notification
center. It combines important information—weather, schedules, maintenance,
appliances, security awareness, and more—into a single, consistent experience
across phones, tablets, and desktop dashboards.

The integration decides what information is relevant. The bundled card decides
how to present it.

## Screenshots

### Tablet Notification Center

![Home Status Tablet Notification Center](docs/screenshots/tablet-notification-center.png)

### Phone Layout

![Home Status Phone Layout](docs/screenshots/phone-layout.png)

### Media Hero

![Home Status Media Hero](docs/screenshots/media-hero.png)

### Live Security Awareness

![Home Status Live Security Awareness](docs/screenshots/live-security-awareness.png)

Additional views of the navigation drawer, weather animations, and ticker are
being prepared for the public release.

## Features

- **Unified Notification Center** for household information in one place
- **Live security awareness** for alarms, doors, windows, locks, and leaks
- **Weather forecasts and NWS alerts** with local animation assets
- **Calendars and schedules** for upcoming household events
- **Laundry and appliance notifications** for useful lifecycle updates
- **Maintenance reminders** for recurring household needs
- **News awareness** through optional RSS providers
- **Camera context** for availability and doorbell events
- **Responsive layouts** for phones, tablets, and desktop dashboards
- **Timeline and ticker streams** for current and recent activity

## Architecture

Home Status turns household entities and optional information providers into one
stable data contract for dashboards.

### Notification Center

Owns informational awareness such as weather, schedules, maintenance, laundry,
news, reminders, and backend-produced events.

### Direct card logic

Reads immediate household conditions such as alarms, doors, windows, locks, and
leaks directly from Home Assistant.

### Foreground Manager

Remains separate from this repository. It is responsible only for exceptional
tablet interruptions such as alarm and doorbell takeovers.

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

## Roadmap

- Guided onboarding wizard
- Expanded per-device presentation profiles
- HACS-compatible release packaging
- Additional information providers
- Timeline improvements
- Expanded notification routing

Home Status is under active development. The backend contract and card are
functional, while the homeowner-oriented setup experience and release packaging
continue to evolve.

## License

Home Status code and Beacon branding are available under the
[MIT License](LICENSE). Bundled third-party assets retain the license notices
stored beside them.

## Vision

Home Status isn't intended to replace Home Assistant dashboards. Its goal is to
become the notification and awareness layer that helps every member of the
household understand what's happening at home at a glance.
