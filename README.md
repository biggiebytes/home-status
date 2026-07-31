![Home Status](design-assets/home-status-branding/png/banners/home-status-banner-dark-1200x400.png)

<p align="center">
  <img src="design-assets/home-status-branding/png/icons/home-status-icon-dark-256.png"
       alt="Home Status Beacon icon"
       width="128">
</p>

<h1 align="center">Home Status</h1>

<p align="center">
  <strong>A modern notification and awareness platform for Home Assistant.</strong>
</p>

Home Status transforms Home Assistant into a clean, modern household awareness experience.

Instead of building dashboards from dozens of unrelated cards, sensors, and automations, Home Status brings the most important household information together into one unified Notification Center.

Weather, schedules, maintenance, appliances, security awareness, cameras, news, and everyday household activity are automatically presented through a single interface designed for phones, tablets, and desktop dashboards.

For many homes, Home Status can replace numerous individual dashboard cards with one coordinated experience that is easier to understand, easier to maintain, and more enjoyable to use.

Designed with sensible defaults and guided setup, Home Status is approachable for new Home Assistant users while still giving experienced users deep customization through visual configuration and optional YAML.

The integration determines **what** information is important.

The Notification Center determines **how** it is presented.

The Configuration App determines **how** homeowners personalize the experience.

---

# Screenshots

## Tablet Notification Center

![Home Status Tablet Notification Center](docs/screenshots/tablet-notification-center.png)

## Phone Experience

![Home Status Phone Layout](docs/screenshots/phone-layout.png)

## Media Hero

![Home Status Media Hero](docs/screenshots/media-hero.png)

## Live Security Awareness

![Home Status Live Security Awareness](docs/screenshots/live-security-awareness.png)

Additional screenshots of the navigation drawer, weather animations, onboarding, configuration, and timeline are included throughout the documentation.

---

# Why Home Status?

Home Status is designed to simplify Home Assistant dashboards.

Instead of maintaining separate cards for weather, calendars, maintenance, laundry, appliance status, security, notifications, cameras, and news, Home Status combines them into one coordinated experience.

Highlights include:

- Modern minimalist design
- Large, easy-to-read Notification Center
- Replaces many individual dashboard cards
- Guided onboarding
- Visual configuration editor
- Live security awareness
- Responsive phone, tablet, and desktop layouts
- Timeline and ticker
- Rich weather animations
- Navigation drawer with quick access to your existing dashboards

---

# Responsive by Design

Home Status is designed around how each device is actually used—not by simply shrinking the same dashboard.

## Phone

The phone experience focuses on **usability and control**.

Rather than showing every piece of household information, it prioritizes the actions people use most throughout the day.

Features include:

- Quick music controls
- Essential household awareness
- Large touch-friendly controls
- Fast navigation buttons
- Clean minimalist layout
- One-handed operation

**Less information. Just as powerful.**

---

## Tablet

The tablet becomes the home's primary Notification Center.

Designed to be read comfortably from across the room, it emphasizes awareness over control while maintaining a clean, modern interface.

Features include:

- Rich Notification Center
- Media Hero
- Live household awareness
- Weather animations
- Timeline
- Footer ticker
- Navigation drawer
- Large typography for at-a-glance readability

---

## Desktop

Desktop balances information density with readability while preserving the same Home Status experience.

---

# Navigation Drawer

The built-in slide-out drawer provides fast access to the Home Assistant dashboards you already use.

Examples include:

- Security
- Cameras
- Music
- Lighting
- Calendar
- Weather
- Energy
- Any custom dashboard or view

Home Status complements your existing dashboards rather than replacing them.

---

# Architecture

Home Status is built from three tightly integrated components.

## Home Status Integration

Responsible for collecting, normalizing, and publishing household information.

Responsibilities include:

- Provider discovery
- Timeline management
- Notification policy
- Configuration storage
- Publishing `sensor.home_status`

The integration determines **what** information is important.

---

## Notification Center

Responsible for presenting household awareness.

Features include:

- Unified household notifications
- Weather forecasts and alerts
- Live security awareness
- Calendar awareness
- Appliance updates
- Maintenance reminders
- News awareness
- Media Hero
- Timeline
- Footer ticker
- Responsive layouts

Immediate household conditions—including alarms, doors, windows, locks, and leaks—are read directly from Home Assistant for real-time awareness.

The Notification Center determines **how** information is presented.

---

## Configuration App

Responsible for setup and personalization.

Features include:

- Guided onboarding
- Visual card editor
- Provider selection
- Appearance settings
- Navigation settings
- Presentation presets
- Advanced configuration

The Configuration App determines **how** Home Status is personalized.

---

## Foreground Manager

Foreground Manager is maintained separately from this repository.

Its responsibility is limited to exceptional tablet interruptions such as alarm takeovers and doorbell events.

---

# Repository Layout

```text
custom_components/home_status/      Home Status integration
www/home-status-card/               Notification Center frontend
design-assets/home-status-branding/ Beacon branding assets
docs/                               Documentation and screenshots
```

---

# Installation

Home Status is currently installed manually while release packaging is finalized.

## Integration

1. Copy `custom_components/home_status` into:

```
/config/custom_components/
```

2. Restart Home Assistant.

3. Open:

**Settings → Devices & Services → Add Integration**

4. Search for **Home Status**.

5. Complete the guided setup wizard.

---

## Notification Center

1. Copy `www/home-status-card` into:

```
/config/www/home-status-card
```

2. Add the dashboard resource:

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

The visual editor configures most options without requiring YAML.

See `www/home-status-card/example.yaml` for a complete configuration example.

---

# Configuration

Configure Home Status through:

**Settings → Devices & Services → Home Status → Configure**

Available sections include:

- General
- Weather
- Information Sources
- Appearance
- Navigation
- Notification Settings
- Advanced

The visual card editor makes common customization available without editing YAML while preserving advanced options for experienced users.

---

# Branding

Beacon is the official Home Status identity.

The repository includes:

- Editable SVG source files
- Integration icons
- Documentation banners
- README artwork
- Light and dark variants
- Color palette
- Branding guidelines

---

# Privacy

Home Status runs entirely inside Home Assistant.

The public repository intentionally excludes:

- `.storage`
- Databases
- Dashboards
- Secrets
- Tokens
- Household-specific configuration

Optional RSS providers make outbound requests only when explicitly enabled.

---

# Roadmap

- One-click HACS installation
- Expanded presentation profiles
- Additional providers
- Timeline enhancements
- Richer media experiences
- Expanded notification routing

---

# Vision

Home Status is not intended to replace Home Assistant.

It is intended to replace the clutter that often develops around it.

Its goal is to become the notification and awareness layer that helps every member of the household understand what's happening at home through a clean, modern, family-friendly experience.

---

# License

Home Status and the Beacon branding are released under the MIT License.

Bundled third-party assets retain their original license notices.
