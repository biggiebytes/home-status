# Changelog

## 1.0.2

- Preserves the finalized tablet Visual Mode and its three-slot rotation behavior.
- Adds the tested responsive phone presentation layout and phone-only typography polish.
- Retains Weather ↔ Outside Home rotation, radar navigation, Visual Center, Security cleanup, and the RECENT ticker.

## 1.0.1

- Adds a user-selectable Performance mode with Standard and Low impact profiles.
- Keeps caching, state-change coalescing, duplicate snapshot suppression, bounded transport, lazy media, and discovery caching enabled in both modes.
- Standard favors fast initial population and one-minute RSS/Recorder reconciliation cadences.
- Low impact defers and staggers startup work, polls RSS every 15 minutes, and reconciles Recorder history every 10 minutes while preserving event-driven live updates.
- Exposes the active performance profile on the Home Status summary entity for diagnostics.

## 1.0.0

- Established Home Status as the stable v1 notification and awareness platform for Home Assistant.
- Finalized NOW, RECENT, AWARENESS, and VISUAL presentation.
- Uses Recorder-backed recent activity instead of a private event-history store.
- Uses fixed revisioned split transport sensors for Now, Recent, Household, Weather, Calendar, News, and Visual data.
- Keeps `sensor.home_status` as the v1 manifest/control entity without duplicating channel payloads.
- Supports configurable single-item and natural-flow multi-item lanes, independent physical row controllers, ticker-only layouts, and phone presentation.
- Includes Visual Center rotation for images, event artwork, local news media, cameras, and HLS streams.
- Includes integration-owned semantic interpretation, household grouping, weather, traffic, calendars, events, news, sports, utilities, and presence awareness.
- Includes Dark, Light, and Auto appearance modes plus user-configurable presentation sizing, timing, and semantic colors.
- Includes tablet-focused runtime work: split payloads, bounded media transport, revision-safe rendering, media cleanup/suspension, and reduced unnecessary frontend work.
- Includes v1 security hardening for remote feed/media retrieval.
- Ships one canonical v1 runtime, configuration flow, presentation contract, and split transport architecture.
