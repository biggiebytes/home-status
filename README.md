# Home Status

Home Status is a Home Assistant integration for a calm, glanceable household
view: what needs attention now, what changed recently, and what is useful to
know next.

![Home Status with Visual Center](docs/screenshots/v1-dark-visual-center.png)

## Version 1

Version 1 is the supported architecture. It publishes coordinated, revisioned
NOW, RECENT, AWARENESS, and VISUAL data for the included dashboard card. It
uses Home Assistant Recorder history for recent activity and does not carry
pre-v1 compatibility or legacy runtime paths.

Home Status can surface selected entities and devices, household presence,
weather, calendars, traffic, utilities, news feeds, cameras, and direct HTTPS
HLS sources. The optional Visual Center presents relevant images, camera media,
and supported video without taking space when no visual is active.

| Natural-flow lanes | Ticker-only layout |
| --- | --- |
| ![Light natural-flow lanes](docs/screenshots/v1-light-natural-flow-lanes.png) | ![Ticker-only layout](docs/screenshots/v1-ticker-only.png) |

## Install

1. In HACS, add `https://github.com/biggiebytes/home-status` as an
   **Integration** repository.
2. Download **Home Status** and restart Home Assistant.
3. Go to **Settings → Devices & services → Add integration**, search for
   **Home Status**, and complete the setup.
4. Add the Home Status card from the dashboard card picker.

For manual installation, copy `custom_components/home_status` to
`/config/custom_components/`, restart Home Assistant, and add the integration.
The frontend card is included; no separate Lovelace resource is needed.

```yaml
type: custom:home-status-card
entity: sensor.home_status
profile: auto
```

## Configuration

Use the integration's **Configure** flow to select monitored entities, whole
devices, information sources, presentation behavior, and optional visual
sources. Per-card options control the dashboard placement, including lane
style, display profile, theme, ticker, drawer, media, and sizing.

Home Status runs inside Home Assistant. RSS/Atom feeds and HLS streams make
outbound requests only when you configure and enable them.

## Support

Support development at [Buy Me a Coffee](https://buymeacoffee.com/biggiebytes).

## License

Home Status is released under the [MIT License](LICENSE). Bundled third-party
assets retain their license notices.
