# Home Status v1 presentation contract

Home Status v1 uses one manifest/control entity plus fixed split transport sensors.
## Manifest

`sensor.home_status` publishes:

- health / priority and active count;
- compact display and presentation settings;
- a revisioned transport manifest;
- authoritative stream assignments for `side`, `left`, `right`, `bottom`, and phone presentation.

## Transport channels

The card reads the fixed v1 channels:

- `sensor.home_status_now`
- `sensor.home_status_recent`
- `sensor.home_status_household`
- `sensor.home_status_weather`
- `sensor.home_status_calendar`
- `sensor.home_status_news`
- `sensor.home_status_visual`

Every channel carries the same snapshot revision. Because Home Assistant updates entities
individually, the card keeps its last complete snapshot until all required channels reach
the new revision. Mixed-revision data is never rendered.

## Item ownership

The integration owns household meaning and sends render-ready items. Items may include
identity/navigation, final display text, icon, category, priority, color role, display kind,
timestamp behavior, scheduling fields, and explicit Visual Center media metadata.

The integration also owns ranking, active-item placement, awareness ordering, footer
composition, phone status selection, and grouped household semantics.

The card owns layout, CSS, responsive behavior, row rotation, animation, media playback,
navigation, local date/time formatting, and mapping `color_role` to the configured theme.
It must not infer household meaning from item text, entity IDs, source names, or event names.

## Visual Center

Image and video media are presentation capabilities. Valid media from current, recent, or
awareness items can enter the Visual Center queue. The Visual channel carries the current
visual, queue, queue-active state, and weather visual effect.
