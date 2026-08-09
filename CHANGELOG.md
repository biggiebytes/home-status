# Changelog

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
