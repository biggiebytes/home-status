"""Interpret non-device Sources into normalized Home Status awareness items."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant

from .source import HomeSource


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _friendly_schedule(value: Any, all_day: bool) -> str:
    """Return a stable human-facing absolute schedule label."""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return text
    day = f"{parsed.strftime('%a, %b')} {parsed.day}"
    if all_day or (len(text) == 10 and text[4:5] == '-' and text[7:8] == '-'):
        return day
    time_label = parsed.strftime("%I:%M %p").lstrip("0")
    return f"{day} · {time_label}"


def _item(
    source: HomeSource,
    state,
    *,
    message: str,
    detail: str,
    icon: str,
    category: str,
) -> dict[str, Any]:
    return {
        "id": f"home_status:{source.id}:awareness",
        "source_id": source.id,
        "source_name": source.name,
        "entity_id": source.entity_id,
        "event_type": "awareness",
        "title": message,
        "message": message,
        "summary": detail,
        "detail": detail,
        "category": category,
        "source": "source",
        "source_kind": source.kind,
        "priority": "normal",
        "icon": icon,
        "active": False,
        "state": state.state,
        "created_at": state.last_changed.isoformat() if state.last_changed else _now(),
        "ticker_eligible": True,
    }


def _travel_minutes(value: Any, unit: Any) -> float | None:
    """Normalize a selected travel-time state to minutes."""
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    normalized_unit = str(unit or "min").casefold().strip()
    if normalized_unit in {"h", "hr", "hrs", "hour", "hours"}:
        return numeric * 60
    if normalized_unit in {"s", "sec", "secs", "second", "seconds"}:
        return numeric / 60
    return numeric


def _travel_label(minutes: float) -> str:
    rounded = max(0, round(minutes))
    return f"{rounded} min"


def _utility_label(name: str) -> str:
    """Keep a provider's utility item compact while retaining its meaning."""
    return name


def _utility_value(value: Any, attrs: dict[str, Any]) -> str:
    """Format a utility sensor state without changing its meaning."""
    device_class = str(attrs.get("device_class") or "").casefold()
    unit = str(attrs.get("unit_of_measurement") or "").strip()
    raw = str(value).strip()

    if device_class == "date":
        return _friendly_schedule(raw, True)

    try:
        numeric = float(raw)
    except (TypeError, ValueError):
        return f"{raw} {unit}".strip()

    if device_class == "monetary":
        return f"${numeric:,.2f}" if unit in {"USD", "$"} else f"{numeric:,.2f} {unit}".strip()
    return f"{numeric:,.2f} {unit}".strip()


def _safe_url(value: Any) -> str | None:
    """Accept only external web URLs from an explicitly selected source."""
    text = str(value or "").strip()
    return text if text.startswith(("https://", "http://")) else None


def _event_feed_items(source: HomeSource, state) -> list[dict[str, Any]]:
    """Interpret neutral event metadata into Home Status awareness items.

    The provider supplies factual event records, artwork and destination URLs.
    Home Status owns the awareness/visual contract. Source order and cardinality
    are preserved; this function does not rank, select, or reduce the feed.
    """
    raw_items = state.attributes.get("events")
    if not isinstance(raw_items, list):
        return []

    result: list[dict[str, Any]] = []
    # Preserve the full neutral event list. Visual Center chooses one event
    # from this source at a time; event records themselves are not expanded
    # into simultaneous visual candidates here.
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        event_id = str(raw.get("id") or "").strip()
        title = str(raw.get("title") or "").strip()
        if not event_id or not title:
            continue

        summary = str(
            raw.get("body")
            or raw.get("description")
            or raw.get("subtitle")
            or source.name
        ).strip()
        detail = str(raw.get("subtitle") or source.name).strip()
        image_url = _safe_url(raw.get("image_url") or raw.get("media_url"))
        action = _safe_url(raw.get("url") or raw.get("action"))

        item = _item(
            source,
            state,
            message=title,
            detail=detail,
            icon="mdi:calendar-star",
            category="calendar",
        )
        item.update(
            {
                "id": f"home_status:{source.id}:event:{event_id}",
                "event_type": "event",
                "summary": summary,
                "detail": detail,
                "source_kind": "events",
                "priority": "normal",
                "image_url": image_url,
                "media_url": image_url,
                "media_type": "image" if image_url else None,
                "action": action,
                "navigation": action,
                "event_start": str(raw.get("event_start") or "").strip(),
                "event_end": str(raw.get("event_end") or "").strip(),
                "all_day": bool(raw.get("all_day")),
                # Neutral rich-event sources supply Visual Center discovery
                # metadata only. They never consume the shared left/right
                # awareness lanes; records without artwork remain inert there.
                "visual_only": True,
                "display_kind": "visual_media" if image_url else "awareness",
            }
        )
        result.append(item)
    return result





def _sports_entity_stem(entity_id: str) -> str:
    """Return Sports Ticker's stable ESPN entity stem."""
    value = str(entity_id or "").casefold()
    if value.startswith("sensor.espn_"):
        value = value[len("sensor.espn_"):]
    for suffix in ("_next_game", "_scoreboard_raw"):
        if value.endswith(suffix):
            value = value[:-len(suffix)]
            break
    return value.strip("_")


def _sports_scoreboard_entity_id(source: HomeSource, attrs: dict[str, Any]) -> str | None:
    """Return the raw scoreboard companion for a compact next-game source."""
    entity_id = str(source.entity_id or "")
    if entity_id.casefold().endswith("_scoreboard_raw"):
        return entity_id
    if entity_id.casefold().endswith("_next_game"):
        return f"sensor.espn_{_sports_entity_stem(entity_id)}_scoreboard_raw"

    league = str(attrs.get("league") or "").casefold().strip().replace("-", "_").replace(" ", "_")
    return f"sensor.espn_{league}_scoreboard_raw" if league else None


def _sports_event_competitors(event: dict[str, Any]) -> list[dict[str, Any]]:
    competitions = event.get("competitions")
    if not isinstance(competitions, list) or not competitions or not isinstance(competitions[0], dict):
        return []
    competitors = competitions[0].get("competitors")
    return [item for item in competitors if isinstance(item, dict)] if isinstance(competitors, list) else []


def _sports_event_for_team(events: Any, favorite_team: str) -> dict[str, Any] | None:
    """Find a favorite team's event in an ESPN scoreboard."""
    if not isinstance(events, list) or not favorite_team:
        return None
    favorite = favorite_team.casefold()
    for event in events:
        if not isinstance(event, dict):
            continue
        for competitor in _sports_event_competitors(event):
            team = competitor.get("team") if isinstance(competitor.get("team"), dict) else {}
            values = {
                str(team.get("abbreviation") or "").casefold(),
                str(team.get("displayName") or "").casefold(),
                str(team.get("shortDisplayName") or "").casefold(),
                str(team.get("name") or "").casefold(),
            }
            if favorite in values:
                return event
    return None


def _sports_event_state(event: dict[str, Any]) -> tuple[str, bool, dict[str, Any]]:
    status = event.get("status") if isinstance(event.get("status"), dict) else {}
    status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
    state = str(status_type.get("state") or "pre").casefold()
    return state, bool(status_type.get("completed")), status


def _sports_best_event(events: Any, favorite_team: str = "") -> dict[str, Any] | None:
    """Choose the most relevant ESPN event, preferring favorite/live/upcoming."""
    if not isinstance(events, list):
        return None
    if favorite_team:
        favorite_event = _sports_event_for_team(events, favorite_team)
        if favorite_event is not None:
            return favorite_event

    valid = [event for event in events if isinstance(event, dict)]
    if not valid:
        return None
    rank = {"in": 0, "pre": 1, "post": 2}
    return sorted(valid, key=lambda event: rank.get(_sports_event_state(event)[0], 3))[0]


def _sports_competitors(event: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]] | None:
    valid = _sports_event_competitors(event)
    if len(valid) < 2:
        return None
    home = next((item for item in valid if str(item.get("homeAway") or "").casefold() == "home"), valid[0])
    away = next((item for item in valid if str(item.get("homeAway") or "").casefold() == "away"), valid[1])
    return away, home


def _sports_team_abbreviation(competitor: dict[str, Any]) -> str:
    team = competitor.get("team") if isinstance(competitor.get("team"), dict) else {}
    return str(
        team.get("abbreviation")
        or team.get("shortDisplayName")
        or team.get("displayName")
        or competitor.get("name")
        or ""
    ).strip()


def _sports_icon(league: str) -> str:
    league = str(league or "").casefold().replace("-", "_")
    if league in {"nfl", "college_football", "ncaaf"}:
        return "mdi:football"
    if league in {"mlb", "baseball"}:
        return "mdi:baseball"
    if league in {"nba", "wnba", "basketball"}:
        return "mdi:basketball"
    if league in {"nhl", "hockey"}:
        return "mdi:hockey-puck"
    if league in {"mls", "soccer"}:
        return "mdi:soccer"
    if league in {"nascar", "racing"}:
        return "mdi:flag-checkered"
    if league in {"pga", "pga_tour", "golf"}:
        return "mdi:golf"
    return "mdi:trophy-outline"


def _sports_live_detail(league: str, status: dict[str, Any]) -> str:
    """Format only the few ESPN sport-state differences Home Status must know."""
    status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
    detail = str(status_type.get("shortDetail") or status_type.get("detail") or "").strip()
    if detail:
        return detail

    period = status.get("period")
    clock = str(status.get("displayClock") or "").strip()
    normalized = str(league or "").casefold().replace("-", "_")

    if normalized in {"mlb", "baseball"}:
        period_label = f"Inning {period}" if period not in (None, "", 0, "0") else "Live"
    elif normalized in {"nhl", "hockey"}:
        period_label = f"P{period}" if period not in (None, "", 0, "0") else "Live"
    elif normalized in {"mls", "soccer"}:
        period_label = "Live"
    elif normalized in {"nba", "wnba", "basketball", "nfl", "college_football", "ncaaf"}:
        period_label = f"Q{period}" if period not in (None, "", 0, "0") else "Live"
    else:
        period_label = "Live"

    return " · ".join(part for part in (period_label, clock) if part)


def _sports_event_name(event: dict[str, Any], source: HomeSource) -> str:
    return str(
        event.get("shortName")
        or event.get("name")
        or event.get("short_name")
        or source.name
    ).strip()


def _sports_item(hass: HomeAssistant, source: HomeSource, state) -> list[dict[str, Any]]:
    """Normalize any supported ESPN Sports Ticker source into Home Status."""
    attrs = state.attributes
    league = str(attrs.get("league") or _sports_entity_stem(source.entity_id)).casefold()
    favorite = str(attrs.get("favorite_team") or "").strip()
    scoreboard_id = _sports_scoreboard_entity_id(source, attrs)
    scoreboard = hass.states.get(scoreboard_id) if scoreboard_id else None
    scoreboard_attrs = scoreboard.attributes if scoreboard is not None else attrs
    events = scoreboard_attrs.get("events")
    event = _sports_best_event(events, favorite)

    # A compact Next Game source remains the preferred upcoming-game authority.
    # Raw scoreboard data becomes authoritative once it can describe live/final
    # state, and is also the fallback for leagues without Next Game entities.
    if event is not None:
        status_state, completed, status = _sports_event_state(event)
        pair = _sports_competitors(event)
        icon = _sports_icon(league)

        if pair is not None:
            away, home = pair
            away_abbr = _sports_team_abbreviation(away)
            home_abbr = _sports_team_abbreviation(home)
            away_score = str(away.get("score") or "0")
            home_score = str(home.get("score") or "0")
            score_message = f"{away_abbr} {away_score} · {home_abbr} {home_score}".strip()

            if status_state == "in":
                item = _item(
                    source, state,
                    message=score_message,
                    detail=_sports_live_detail(league, status),
                    icon=icon,
                    category="sports",
                )
                item.update({
                    "id": f"home_status:{source.id}:sports:{event.get('id') or favorite or league}",
                    "event_type": "sports_live",
                    "priority": "high",
                    "active": True,
                    "state": "live",
                    "sports_state": "live",
                    "league": league,
                    "favorite_team": favorite,
                    "scoreboard_entity_id": scoreboard_id,
                })
                return [item]

            if completed or status_state == "post":
                item = _item(
                    source, state,
                    message=score_message,
                    detail="Final",
                    icon=icon,
                    category="sports",
                )
                item.update({
                    "id": f"home_status:{source.id}:sports:{event.get('id') or favorite or league}",
                    "event_type": "sports_final",
                    "priority": "normal",
                    "state": "final",
                    "sports_state": "final",
                    "league": league,
                    "favorite_team": favorite,
                    "scoreboard_entity_id": scoreboard_id,
                })
                return [item]

            # Raw scoreboard fallback for upcoming team sports.
            if not source.entity_id.casefold().endswith("_next_game"):
                status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
                detail = str(status_type.get("shortDetail") or status_type.get("detail") or "").strip()
                item = _item(
                    source, state,
                    message=_sports_event_name(event, source),
                    detail=detail,
                    icon=icon,
                    category="sports",
                )
                item.update({
                    "id": f"home_status:{source.id}:sports:{event.get('id') or favorite or league}",
                    "event_type": "sports_upcoming",
                    "state": "upcoming",
                    "sports_state": "upcoming",
                    "league": league,
                    "favorite_team": favorite,
                    "scoreboard_entity_id": scoreboard_id,
                    "scheduled_at": str(event.get("date") or ""),
                })
                return [item]

        # Event sports (PGA/NASCAR) and any ESPN source without two teams.
        status_type = status.get("type") if isinstance(status.get("type"), dict) else {}
        event_name = _sports_event_name(event, source)
        detail = str(status_type.get("shortDetail") or status_type.get("detail") or "").strip()
        sports_state = "final" if completed or status_state == "post" else "live" if status_state == "in" else "upcoming"
        item = _item(
            source, state,
            message=event_name,
            detail=("Final" if sports_state == "final" else detail or ("Live" if sports_state == "live" else "")),
            icon=icon,
            category="sports",
        )
        item.update({
            "id": f"home_status:{source.id}:sports:{event.get('id') or league}",
            "event_type": f"sports_{sports_state}",
            "priority": "high" if sports_state == "live" else "normal",
            "active": sports_state == "live",
            "state": sports_state,
            "sports_state": sports_state,
            "league": league,
            "favorite_team": favorite,
            "scoreboard_entity_id": scoreboard_id,
            "scheduled_at": str(event.get("date") or ""),
        })
        return [item]

    # Compact next-game fallback.
    if attrs.get("has_upcoming_game") is False:
        return []
    matchup = str(attrs.get("matchup") or attrs.get("short_name") or attrs.get("event_name") or "").strip()
    if not matchup:
        return []
    detail = str(attrs.get("status_detail") or "").strip()
    venue = str(attrs.get("venue") or "").strip()
    if venue and venue not in detail:
        detail = f"{detail} · {venue}" if detail else venue
    item = _item(
        source, state,
        message=matchup,
        detail=detail or str(attrs.get("favorite_team_name") or source.name),
        icon=_sports_icon(league),
        category="sports",
    )
    item.update({
        "id": f"home_status:{source.id}:sports:{attrs.get('event_id') or favorite or league}",
        "event_type": "sports_upcoming",
        "state": "upcoming",
        "sports_state": "upcoming",
        "league": league,
        "favorite_team": favorite,
        "scoreboard_entity_id": scoreboard_id,
        "scheduled_at": str(attrs.get("date") or ""),
    })
    return [item]


def household_presence_item(hass: HomeAssistant, person_ids: list[str]) -> dict[str, Any] | None:
    """Build one household-level presence summary from selected people."""
    people = []
    for entity_id in person_ids:
        state = hass.states.get(entity_id)
        if state is None or str(state.state).casefold() in {"unknown", "unavailable"}:
            continue
        name = str(state.attributes.get("friendly_name") or entity_id.split(".", 1)[-1].replace("_", " ").title())
        people.append((name, str(state.state).casefold(), state))
    if not people:
        return None

    home = [name for name, location, _state in people if location == "home"]
    away = [name for name, location, _state in people if location != "home"]
    if len(home) == len(people):
        title = "Everyone Home"
        detail = ", ".join(home)
        icon = "mdi:home-account"
    elif not home:
        title = "Everyone Away"
        detail = ", ".join(away)
        icon = "mdi:map-marker-account"
    else:
        title = f"{len(home)} of {len(people)} Home"
        detail = f"{', '.join(home)} home · {', '.join(away)} away"
        icon = "mdi:map-marker-account"

    changed = max(
        (state.last_changed for _name, _location, state in people if state.last_changed),
        default=None,
    )
    return {
        "id": "home_status:household_presence:awareness",
        "source_id": "household_presence",
        "source_name": "Household presence",
        "entity_id": None,
        "event_type": "awareness",
        "title": title,
        "message": title,
        "summary": detail,
        "detail": detail,
        "category": "location",
        "source": "household_presence",
        "source_kind": "location",
        "priority": "normal",
        "icon": icon,
        "active": False,
        "state": "home" if len(home) == len(people) else "away" if not home else "mixed",
        "created_at": changed.isoformat() if changed else _now(),
        "ticker_eligible": True,
        "person_ids": [state.entity_id for _name, _location, state in people],
    }


def interpret_source(hass: HomeAssistant, source: HomeSource) -> list[dict[str, Any]]:
    """Return the current useful awareness item for one selected Source."""
    state = hass.states.get(source.entity_id)
    if state is None or str(state.state).casefold() in {"unknown", "unavailable"}:
        return []

    attrs = state.attributes

    if source.kind == "events":
        return _event_feed_items(source, state)

    if source.kind == "sports":
        return _sports_item(hass, source, state)

    if source.kind == "traffic":
        minutes = _travel_minutes(
            state.state,
            attrs.get("unit_of_measurement"),
        )
        if minutes is None:
            return []
        # The source name is user-facing configuration (for example,
        # "Downtown"). Do not expose Waze's origin/destination attributes:
        # those can contain precise coordinates or private addresses.
        return [_item(
            source,
            state,
            message=f"{source.name}: {_travel_label(minutes)}",
            detail="Travel time",
            icon=str(attrs.get("icon") or "mdi:car-clock"),
            category="traffic",
        )]

    if source.kind == "utility":
        device_class = str(attrs.get("device_class") or "").casefold()
        fallback_icon = {
            "monetary": "mdi:cash",
            "date": "mdi:calendar-clock",
            "energy": "mdi:lightning-bolt",
            "volume": "mdi:water",
        }.get(device_class, "mdi:meter-electric")
        item = _item(
            source,
            state,
            message=f"{_utility_label(source.name)}: {_utility_value(state.state, attrs)}",
            detail="Utility account",
            icon=str(attrs.get("icon") or fallback_icon),
            category="utility",
        )
        item["device_class"] = device_class
        item["unit_of_measurement"] = str(attrs.get("unit_of_measurement") or "")
        item["stream_preference"] = "footer"
        return [item]

    if source.domain == "weather":
        condition = str(state.state).replace("_", " ").title()
        temperature = attrs.get("temperature")
        unit = attrs.get("temperature_unit") or attrs.get("unit_of_measurement") or ""
        value = f"{round(float(temperature))}{unit}" if temperature is not None else condition
        return [_item(
            source,
            state,
            message=value,
            detail=condition,
            icon=str(attrs.get("icon") or "mdi:weather-partly-cloudy"),
            category="weather",
        )]

    if source.domain == "calendar":
        summary = attrs.get("message") or attrs.get("summary")
        if not summary:
            return []
        start = (
            attrs.get("start_time")
            or attrs.get("start")
            or attrs.get("start_date")
            or attrs.get("start_datetime")
        )
        item = _item(
            source,
            state,
            message=str(summary),
            detail=source.name,
            icon=str(attrs.get("icon") or "mdi:calendar"),
            category="calendar",
        )
        if start:
            item["scheduled_at"] = str(start)
            # Prefer Home Assistant's explicit all_day attribute. Fall back to
            # date-only detection for integrations that do not provide it.
            explicit_all_day = attrs.get("all_day")
            if explicit_all_day is None:
                item["all_day"] = len(str(start).strip()) == 10
            else:
                item["all_day"] = bool(explicit_all_day)
            # Keep the exact timestamp above as the contract. This friendly
            # summary is a compatibility fallback for older card resources.
            friendly = _friendly_schedule(start, item["all_day"])
            item["summary"] = f"{source.name} · {friendly}" if friendly else source.name
            item["detail"] = item["summary"]
        return [item]

    if source.domain == "person":
        location = str(state.state).replace("_", " ").title()
        return [_item(
            source,
            state,
            message=f"{source.name}: {location}",
            detail=location,
            icon=str(attrs.get("icon") or "mdi:account"),
            category="location",
        )]

    if source.domain == "zone":
        try:
            count = int(float(state.state))
        except (TypeError, ValueError):
            return []
        noun = "person" if count == 1 else "people"
        return [_item(
            source,
            state,
            message=f"{source.name}: {count} {noun}",
            detail=f"{count} {noun} in {source.name}",
            icon=str(attrs.get("icon") or "mdi:map-marker-account"),
            category="location",
        )]

    return []
