# Home Status presentation contract

`sensor.home_status` publishes `native.contract_version: 3`.

The integration owns household meaning. Each item in `native.current`,
`native.recent`, and `native.awareness` is ready to render and may contain:

- `id`, `entity_id`, and `entity_name` for identity and navigation.
- `title`/`message` and `summary` for final user-facing copy.
- `icon`, `category`, `priority`, and `active` for presentation state.
- `color_role` for semantic color selection.
- `display_kind` for layout-specific formatting.
- `timestamp_mode` (`none` or `relative`) for time presentation.
- `scheduled_at` and `all_day` for scheduled information.
- `visual` for provider-neutral Visual Center media.
- `zone_visual` for media that follows a displayed local-news item, matching
  the source card's news behavior without requiring the card to identify news.
- `utility_role` for explicit utility-panel selection.
- `ticker_eligible` for an active item that belongs in the footer.

`native.streams` is authoritative for content placement:

- `left`, `right`, and `bottom` contain ordered item IDs.
- `phone_primary_id` identifies the integration-selected phone status winner.
- `phone_fallback` contains the integration-authored normal-state presentation.

The integration ranks items, assigns shared slots, fills empty sides, distributes
awareness rotations, composes the footer, chooses the phone winner, and removes
superseded alarm transitions. The card resolves the supplied IDs; it does not
repeat these policies.

Recorder-backed transitions always use `timestamp_mode: relative`. Active
safety and alarm conditions also use relative time so their age is visible;
ordinary current values remain untimestamped unless their awareness contract
explicitly requests it.

The card owns layout, CSS, animation, responsive behavior, local time/date
formatting, media playback, navigation, responsive merging of a user-hidden
side, and mapping `color_role` to configured
colors or CSS classes. It must not infer household meaning from item text,
entity IDs, source names, or event names.
