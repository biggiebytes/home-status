# Changelog

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
