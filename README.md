![Home Status](design-assets/home-status-branding/png/banners/home-status-banner-dark-1200x400.png)

<p align="center">
  <img src="design-assets/home-status-branding/png/icons/home-status-icon-dark-256.png"
       alt="Home Status Beacon icon"
       width="128">
</p>

<h1 align="center">Home Status</h1>

<p align="center">
  <strong>A Notification Center for Home Assistant.</strong>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/biggiebytes">
    <img src="https://img.shields.io/badge/Support-Buy_Me_a_Coffee-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=000000"
         alt="Support Home Status on Buy Me a Coffee">
  </a>
</p>

Modern homes have hundreds—even thousands—of sensors. Most dashboards expect you to constantly scan dozens of cards to discover whether something has changed.

Home Status takes the opposite approach.

Instead of displaying everything all the time, it continuously monitors your home and surfaces only the information that matters, when it matters.

The goal isn't to display every sensor.

**The goal is to keep you informed.**

Home Status becomes the single place where your home quietly keeps you aware of what matters, while your existing dashboards remain dedicated to control and exploration.

![Home Status Tablet Notification Center](docs/screenshots/tablet-notification-center.png)

---

# Why Home Status?

## A different philosophy

Traditional Home Assistant dashboards ask:

> What is every device doing right now?

Home Status asks:

> Is there anything I should know?

Every connected system contributes information:

- 🚪 Doors and windows
- 🌦️ Weather
- 🚨 Alerts
- 🧺 Laundry
- 🌱 Sprinklers
- 🗑️ Waste collection
- ⚡ Energy
- 🌡️ Climate
- 📦 Deliveries
- 🚗 Traffic
- …and more

Instead of competing for screen space, they share a common Notification Center.

The highest-priority information appears first, while everything else quietly rotates in the background.

## Built for real homes

Home Status was designed for family wall tablets—not just power users.

It focuses on:

- Large, glanceable information
- Automatic prioritization
- Natural language instead of entity names
- Smooth, non-distracting updates
- Responsive layouts for phones, tablets, and desktops

Your home should keep you informed without demanding your attention.

## Not another dashboard

Home Status doesn't replace your dashboards. It complements them.

Use dedicated dashboards for:

- Cameras
- Security
- Energy
- Music
- Climate

Use Home Status to know **when** you need to open them.

## Design philosophy

Every part of your home has something useful to say.

Not every sensor needs to speak all the time.

Home Status gives every part of your home a voice—without letting any one thing dominate the conversation.

---

# Screenshots

## Phone Experience

![Home Status Phone Layout](docs/screenshots/phone-layout.png)

## Media Hero

![Home Status Media Hero](docs/screenshots/media-hero.png)

## Live Security Awareness

![Home Status Live Security Awareness](docs/screenshots/live-security-awareness.png)

Additional screenshots of the navigation drawer, weather animations, onboarding, configuration, and timeline are included throughout the documentation.

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
custom_components/home_status/      Integration and bundled card frontend
design-assets/home-status-branding/ Beacon branding assets
docs/                               Documentation and screenshots
```

---

# Installation

Home Status installs as one HACS integration. The backend, visual card editor,
weather assets, and Notification Center card are delivered together.

## HACS

1. In HACS, add `https://github.com/biggiebytes/home-status` as an Integration
   repository.
2. Download **Home Status**.
3. Restart Home Assistant.
4. Open **Settings → Devices & Services → Add Integration**.
5. Search for **Home Status** and complete the guided setup.

The card becomes available in the dashboard card picker when the integration
loads. No separate frontend installation is needed.

### Manual installation

Copy `custom_components/home_status` into `/config/custom_components/`, restart
Home Assistant, and add the integration. The bundled card is still registered
automatically.

---

## Notification Center

The Home Status card is bundled with the integration and registered with the
Home Assistant frontend automatically. No `/config/www` copy or manual
Dashboard Resource is required.

After Home Status is installed, restarted, and configured, add the card from
the dashboard card picker or use:

```yaml
type: custom:home-status-card
entity: sensor.home_status
layout: tablet-default
```

The visual editor configures most options without requiring YAML.

See `custom_components/home_status/frontend/example.yaml` for a complete
configuration example.

Users upgrading from an earlier manual card installation can remove the old
`/local/home-status-card/home-status-card.js` Dashboard Resource after this
version is installed and Home Assistant has restarted.

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

- HACS catalog publication
- Expanded presentation profiles
- Capability-based providers ([staged provider roadmap](docs/provider-roadmap.md))
- Timeline enhancements
- Richer media experiences
- Expanded notification routing

Community testers can share privacy-safe entity metadata using the
[provider testing guide](docs/provider-testing.md).

---

# Vision

Home Status is not intended to replace Home Assistant.

It is intended to replace the clutter that often develops around it.

Its goal is to become the notification and awareness layer that helps every member of the household understand what's happening at home through a clean, modern, family-friendly experience.

Your home already knows what's happening.

**Home Status makes sure you do, too.**

---

# ☕ Support Home Status

If Home Status has made your Home Assistant dashboard more useful, consider supporting development.

Every contribution helps fund new features, testing, documentation, and long-term maintenance.

**[Buy Me a Coffee](https://buymeacoffee.com/biggiebytes)**

---

# License

Home Status and the Beacon branding are released under the MIT License.

Bundled third-party assets retain their original license notices.
