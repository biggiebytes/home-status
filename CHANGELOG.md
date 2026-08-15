# Changelog

## v0.9.9

- Added an independent Portrait phone ticker speed setting. Existing card configurations retain their current portrait speed until changed.

## v0.9.8

- Let Micro-Air's two current summaries take part in the usual left/right contextual rotation instead of pinning the two slots.

## v0.9.7

- Format Micro-Air readings for clear card display without changing their underlying values.

## v0.9.6

- Kept the card editor stable while a dropdown, picker, or text field is
  active, so a live Home Assistant refresh no longer closes the control.
- Added Micro-Air EasyStart Current and History items. The card presents the
  configured diagnostic values as two responsive Current items instead of
  reducing the device to fault-only output.

## v0.9.2

### Integration-owned presentation

- Completed the versioned integration-to-card presentation contract. Python now
  normalizes semantic labels, icons, colors, timestamp modes, grouped contact
  closures, awareness items, Visual Center selection, and left/right/footer
  stream placement.
- Reduced the card to rendering, rotation, responsive visibility, interaction,
  and media playback instead of duplicating Home Assistant entity semantics.

### Restored behavior and regression fixes

- Restored local-news visuals and preserved at least one news article while
  enforcing Home Assistant's state-attribute size limit.
- Restored timestamps for Recorder-backed transitions, including alarms, leak
  detection, and washer, dryer, and dishwasher completion.
- Restored semantic icon colors for contacts, security, appliances, climate,
  schedules, weather, irrigation, recycling, waste, and news.
- Kept all presentation streams moving while the drawer is open. Expanding a
  grouped door/window entry pauses only the footer and displays the actual
  grouped entity names.

## v0.5.0

### Visual Center and live information

- Added the provider-neutral Visual Center with image, camera, MP4/WebM video,
  and Direct HTTPS HLS rendering. It appears only while a valid visual is
  available and cleanly returns the card to its normal two-column layout.
- Added configurable camera visual sources with trigger-state activation,
  hold-after-trigger duration, priority, and resumable takeover behavior.
- Added generic RSS/Atom news sources and an optional Visual Center bootstrap
  for the newest image-backed article without replaying old feed entries.
- Added rotating Live News HLS sources with one provider-wide sampling cadence,
  persisted rotation, preemption by higher-priority visuals, and clean teardown.

### Household and interaction

- Added Household presence under Information sources. Selected people can now
  be presented as one clear Everyone Home, Everyone Away, or mixed household
  status instead of separate person entries.
- Restored integration-level Tap destinations under Presentation & behavior.
  Ordinary items can open chosen Home Assistant dashboard pages while linked
  news headlines continue to open their original articles.

### Reliable activity history

- Added normalized alarm arm, disarm, and triggered history entries with the
  same timestamp treatment used by resolved door activity.
- Kept every alarm transition in Recent/history while limiting the ticker to
  its newest retained alarm transition, preventing repeated arm/disarm cycles
  from crowding or repeatedly restarting the marquee.
- Introduced a shared semantic normalization boundary for appliances, contacts,
  and safety/fault states so raw values such as `on` are interpreted using their
  actual Home Assistant context.
- Improved whole-device appliance handling, including stable identity,
  remaining-time updates, and clear laundry door labels without exposed model
  numbers.

## v0.4.0

### Highlights

- Refreshed the Home Status card for larger, tablet-friendly layouts with
  clearer weather, current-value, ticker, and semantic icon presentation.
- Replaced the former flat settings menu with a native Home Assistant
  multi-page configuration flow for monitoring, information sources,
  presentation and behavior, and advanced settings.
- Added configurable presentation controls for sizing, appearance, names,
  routing and filters, timing, and history.

### Information and activity

- Improved alert fallback content so the left area remains useful when no
  alert is active.
- Refined timestamp behavior: closed openings retain verified timestamps,
  while state-like items no longer show misleading relative times.
- Added dedicated waste data with natural collection dates and clearer waste
  icons and colors.
- Improved appliance activity handling for washer, dryer, and dishwasher,
  including device-associated companion sensors, remaining-time and phase
  details, completion timing, and duplicate-completion suppression.

### Reliability

- Corrected rain animation and Lottie asset loading for the bundled frontend.
- Kept the standalone and bundled card implementation aligned for HACS
  distribution.
