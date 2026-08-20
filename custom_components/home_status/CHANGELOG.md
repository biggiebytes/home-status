# Changelog

## 1.0.0

- Finalized tablet-performance improvements, configurable single and slot lane
  modes, and natural-flow lane sizing.
- Added global and card-level Visual Center controls, light/dark/auto themes,
  and balanced side columns whenever Visual Center is unavailable.
- Generalized ESPN Sports Ticker support across the published league family.
- Preserved the audited live-approved behavior, including the bounded
  compatibility-sensor contract and split transport architecture.

## 0.9.18

- Preserved the live Visual Center sampling cadence and Recorder-only footer
  contract.
- Bounded the compatibility sensor's current and awareness collections while
  retaining priority, household-presence, and local-news items.
- Enforced the compatibility sensor's 12 KB attribute budget without changing
  split transport channels or the frontend architecture.

## 0.9.17

- Promoted the latest Home Status visual, lane, and media behavior for the
  public release line.

## 0.9.5

- Prevented live Home Assistant updates from rebuilding the card editor while
  a dropdown, picker, or text field is active. Updates now wait until the
  control loses focus, so native selection popups remain open.

## 0.9.4

- Added coordinator-backed Now, Recent, Household, Weather, Calendar, News,
  and Visual transport sensors while retaining `sensor.home_status` as the
  compatibility/control sensor.
- Added a revisioned transport manifest so the card assembles only a complete
  same-snapshot set of split sensor payloads and otherwise uses the legacy
  payload.
- Isolated payload budgets by channel so verbose calendar, news, Recorder,
  and media data cannot evict unrelated Home Status information.

## 0.9.3

- Added an integration-owned semantic capability for Micro-Air EasyStart diagnostic/protection monitors, recognized from the YAML-defined entity signature rather than the device name.
- Kept a healthy `Normal` status silent and converted every defined EasyStart fault/protection status into a meaningful AC attention item.
- Used `Live Current` only as supporting fault context without inventing an off/running threshold.
- Excluded Last Start Peak, Line Frequency, SCPT Delay, counters, MCU temperature, Wi-Fi signal, uptime, Read Status, and Restart ESP from all presentation streams.
- Tightened generic manual-sensor eligibility so unowned measurements, totals, and diagnostic entities cannot become awareness items.

## 0.9.2

- Keep the left, right, and footer presentation streams moving while the drawer is open.
- Encode grouped door/window labels safely in the footer so the detail panel lists the actual entity names.
- Keep grouped-detail expansion scoped to the footer: it pauses only the footer while its names are displayed.

## 0.9.1

- Paused the footer marquee together with left/right rotation while the dropdown drawer is open.
- Replaced grouped door/window title mutation with a visible footer detail panel that lists every grouped opening while leaving left/right rotation unaffected.
- Restored relative timestamps for every Recorder-backed transition, including leak and alarm events and washer/dryer/dishwasher completion.
- Added relative age context to active leak, smoke, gas, carbon-monoxide, safety, and alarm conditions.
- Preserved at least one news article when enforcing Home Assistant's state-attribute size budget.

## 0.9.0

- Completed integration-side content placement with the version 3 presentation contract.
- Python now ranks current and awareness items, assigns left/right rotations, composes the bottom stream, selects the phone winner, and retains only the newest alarm transition.
- Removed `_sharedInformationSlots()`, phone priority ranking, footer alarm selection, and presentability filtering from the card.
- The card now resolves integration-supplied stream IDs and retains only rendering, rotation, responsive visibility, interaction, and media playback behavior.

## 0.8.1

- Restored the source card's local-news behavior: media follows the displayed news item into the Visual Center instead of becoming an inline hero thumbnail.
- Restored integration-controlled relative timestamps for awareness items when the existing “Other current information” timestamp option is enabled.
- Removed the remaining legacy `detail` fallback from main-zone copy so scheduled dates are not duplicated.
- Preserved the news visual and timestamp decisions in the compact versioned contract.

## 0.8.0

- Completed the versioned integration-to-card presentation contract for current, recent, and awareness items.
- Moved final state labels, icons, categories, aliases, semantic color roles, display kinds, timestamp modes, utility roles, and contact grouping into the integration.
- Restored semantic colors for security, successful closures, appliances, climate, recycling, waste, calendars, weather, irrigation, and news without text inference in the card.
- Preserved active appliance cycles in the footer while keeping them out of the rotating information slots.
- Excluded scheduled waste, measurements, and other awareness-only entities from Recorder-backed recent activity.
- Removed card-authored fallback summaries and the remaining calendar text filter.
- Verified contract behavior for contacts, locks, alarms, safety sensors, appliance running/completion/fault, measurements, schedules, weather, and news.

## 0.7.1

- Corrected corrupted bullet, dash, degree, apostrophe, and navigation characters in the frontend resource.
- Stopped current awareness values such as temperature from displaying a misleading relative age.
- Published waste collection dates as all-day scheduled items so the card renders the collection date once without an update age.

## 0.7.0

- Moved Home Status category, icon, label, color-role, timestamp, display-kind, visual, and recent-contact grouping decisions into the integration output contract.
- Simplified the card to render normalized `current`, `recent`, and `awareness` items without native entity interpretation or text-based semantic repair.
- Bumped the frontend resource version so Home Assistant loads the revised card after upgrade.

## 0.6.9

- Fixed the Home Status card so active appliance cycles are displayed in the live ticker.
- Preserved the existing appliance semantic contract from the native interpreter, including operating state, remaining time, completion, and fault fields.
- Added a cache-version update for the frontend card resource.
- Clarified whole-device appliance setup guidance: select the appliance device, not a separate timer or cycle sensor.
- Normalized the HACS manifest field order.

## Verification

- Live UI verified: `Washer Running` appears with `4 min remaining`.
- Completion and fault presentation require a real appliance completion/fault event and remain the final user-run verification.
