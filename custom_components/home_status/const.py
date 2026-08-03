import re

DOMAIN = "home_status"
INTEGRATION_VERSION = "0.2.6"
FRONTEND_URL_BASE = "/home_status"
FRONTEND_MODULE_URL = (
    f"{FRONTEND_URL_BASE}/home-status-card.js?v={INTEGRATION_VERSION}"
)
PLATFORMS = ["sensor"]
CONF_ENTITY_IDS = "entity_ids"
CONF_ENTITIES = "entities"
CONF_OPTIONS = "options"
CONF_CONTACT_FOOTER_PILOT = "contact_footer_pilot_enabled"
CONF_CAPABILITY_SENSORS = "capability_sensors"
STORAGE_VERSION = 1
STORAGE_KEY = "home_status_history"
ALARM_ENTITY = "alarm_control_panel.alarmo"
LEAK_SOURCE_NAMES = {
    "binary_sensor.kitchen_sink_moisture": "Kitchen Sink",
    "binary_sensor.bathroom_sink_moisture": "Bathroom Sink",
    "binary_sensor.laundry_room_moisture": "Laundry Room",
}
APPLIANCE_CYCLES = {
    "sensor.washer_machine_state": {
        "name": "Washer",
        "remaining": "sensor.washer_time_remaining",
        "icon": "mdi:washing-machine",
    },
    "sensor.dryer_machine_state": {
        "name": "Dryer",
        "remaining": "sensor.dryer_time_remaining",
        "icon": "mdi:tumble-dryer",
    },
    "sensor.dishwasher_current_status": {
        "name": "Dishwasher",
        "remaining": "sensor.dishwasher_remaining_time",
        "icon": "mdi:dishwasher",
    },
}
APPLIANCE_MAINTENANCE = {
    "binary_sensor.dishwasher_rinse_refill_needed": {
        "message": "Add Dishwasher Rinse Aid",
        "detail": "Dishwasher rinse aid needs to be refilled",
        "resolved_message": "Dishwasher Rinse Aid Refilled",
        "icon": "mdi:cup-water",
    },
    "binary_sensor.dishwasher_machine_clean_reminder": {
        "message": "Clean Dishwasher",
        "detail": "The dishwasher cleaning cycle is due",
        "resolved_message": "Dishwasher Cleaning Complete",
        "icon": "mdi:dishwasher-alert",
    },
}
SYSTEM_UPDATES = {
    "update.home_assistant_core_update": "Home Assistant Core",
    "update.home_assistant_operating_system_update": "Home Assistant OS",
    "update.home_assistant_supervisor_update": "Home Assistant Supervisor",
}
EASYSTART_DIAGNOSTIC_DETAILS = {
    "sensor.micro_air_live_current": "Live Current",
    "sensor.micro_air_line_frequency": "Line Frequency",
    "sensor.micro_air_last_start_peak": "Last Start Peak",
    "sensor.micro_air_scpt_delay": "Short-Cycle Delay",
}
EASYSTART_FAULT_COUNTER = "sensor.micro_air_total_faults"

PROVIDER_WEATHER = "weather"
PROVIDER_SCHEDULE = "schedule"
PROVIDER_MAINTENANCE = "maintenance"
PROVIDER_LAUNDRY = "laundry"
PROVIDER_SECURITY = "security"
PROVIDER_CLIMATE = "climate"
PROVIDER_CAMERAS = "cameras"
PROVIDER_FAMILY = "family"
PROVIDER_LIGHTING = "lighting"
PROVIDER_NEWS = "news"
PROVIDER_CONTRACT_VERSION = 7

SUPPORTED_PROVIDERS = (
    PROVIDER_SECURITY,
    PROVIDER_WEATHER,
    PROVIDER_SCHEDULE,
    PROVIDER_MAINTENANCE,
    PROVIDER_LAUNDRY,
    PROVIDER_CLIMATE,
    PROVIDER_CAMERAS,
    PROVIDER_FAMILY,
    PROVIDER_LIGHTING,
    PROVIDER_NEWS,
)
NAVIGATION_TARGETS = (*SUPPORTED_PROVIDERS, "sprinklers", "waste")

PROVIDER_ALIASES = {
    "calendar": PROVIDER_SCHEDULE,
    "sprinklers": PROVIDER_SCHEDULE,
    "fault": PROVIDER_MAINTENANCE,
    "faults": PROVIDER_MAINTENANCE,
    "camera": PROVIDER_CAMERAS,
    "lights": PROVIDER_LIGHTING,
}

DEFAULT_SOURCE_GROUPS = {
    "maintenance_sensors": [
        "binary_sensor.sprinklers_fault",
        "binary_sensor.dryer_blocked_vent_fault",
    ],
    "leak_sensors": list(LEAK_SOURCE_NAMES),
    "filter_status": ["binary_sensor.refrigerator_filter_status"],
    "filter_usage": ["sensor.refrigerator_water_filter_usage"],
    "refrigerator_doors": [
        "binary_sensor.refrigerator_fridge_door",
        "binary_sensor.refrigerator_freezer_door",
    ],
    "refrigerator_temperatures": [
        "sensor.refrigerator_fridge_temperature",
        "sensor.refrigerator_freezer_temperature",
    ],
    "weather_alert": ["sensor.nws_alerts_alerts"],
    "family_calendar": ["calendar.family", "calendar.school"],
    "sprinkler_schedule": ["sensor.sprinklers_next_watering", "switch.sprinklers_rain_delay"],
    "sprinkler_valves": [
        f"valve.sprinklers_zone{zone}" for zone in range(1, 7)
    ],
    "waste_schedule": [
        "sensor.waste_collection_schedule_garbage",
        "sensor.waste_collection_schedule_recycling",
        "sensor.waste_collection_schedule_yard_waste",
    ],
    "laundry_state": list(APPLIANCE_CYCLES),
    "laundry_remaining": [
        config["remaining"] for config in APPLIANCE_CYCLES.values()
    ],
    "appliance_maintenance": list(APPLIANCE_MAINTENANCE),
    "climate_temperature": ["sensor.thermostat_temperature"],
    "hvac_diagnostics": ["sensor.micro_air_status"],
    "hvac_diagnostic_details": list(EASYSTART_DIAGNOSTIC_DETAILS),
    "hvac_fault_counter": [EASYSTART_FAULT_COUNTER],
    "system_updates": list(SYSTEM_UPDATES),
    # Entity-backed adapters can still add news sources explicitly, but the
    # built-in RSS adapters do not require a synthetic sensor.news entity.
    "news_sources": [],
}

SOURCE_ROLE_PROVIDERS = {
    "maintenance_sensors": PROVIDER_MAINTENANCE,
    "leak_sensors": PROVIDER_SECURITY,
    "filter_status": PROVIDER_MAINTENANCE,
    "filter_usage": PROVIDER_MAINTENANCE,
    "refrigerator_doors": PROVIDER_MAINTENANCE,
    "refrigerator_temperatures": PROVIDER_MAINTENANCE,
    "weather_alert": PROVIDER_WEATHER,
    "family_calendar": PROVIDER_SCHEDULE,
    "sprinkler_schedule": PROVIDER_SCHEDULE,
    "sprinkler_valves": PROVIDER_SCHEDULE,
    "waste_schedule": PROVIDER_SCHEDULE,
    "laundry_state": PROVIDER_LAUNDRY,
    "laundry_remaining": PROVIDER_LAUNDRY,
    "appliance_maintenance": PROVIDER_MAINTENANCE,
    "climate_temperature": PROVIDER_CLIMATE,
    "hvac_diagnostics": PROVIDER_CLIMATE,
    "hvac_diagnostic_details": PROVIDER_CLIMATE,
    "hvac_fault_counter": PROVIDER_CLIMATE,
    "system_updates": PROVIDER_MAINTENANCE,
    "news_sources": PROVIDER_NEWS,
}

EXPLICIT_BINARY_NOTIFICATION_SOURCES = frozenset([
    *DEFAULT_SOURCE_GROUPS["maintenance_sensors"],
    *DEFAULT_SOURCE_GROUPS["leak_sensors"],
    *DEFAULT_SOURCE_GROUPS["filter_status"],
    *DEFAULT_SOURCE_GROUPS["refrigerator_doors"],
    *DEFAULT_SOURCE_GROUPS["appliance_maintenance"],
])
LIVE_ONLY_NOTIFICATION_SOURCES = frozenset(DEFAULT_SOURCE_GROUPS["maintenance_sensors"])

# Safety and infrastructure entities are normally owned by Home Assistant.
# Only the explicit notification fault allowlist above crosses this boundary.
LIVE_STATE_DOMAINS = {"alarm_control_panel", "binary_sensor", "cover", "lock", "camera"}
LIVE_STATE_ROLES = {"alarm_panel", "contact_sensors", "leak_sensors"}


def plain_entity_name(entity_id: str, value=None) -> str:
    """Return a consistent plain-English label without integration prefixes."""
    raw = str(value or entity_id.rsplit(".", 1)[-1] or "Home item")
    raw = raw.replace("_", " ").replace("-", " ")
    raw = re.sub(
        r"^(?:alarm|alarmo|security)\s+"
        r"(?:(?:door|window|contact|lock|leak|water|moisture|smoke|"
        r"carbon monoxide|co)\s+)?sensors?\s+",
        "",
        raw,
        flags=re.IGNORECASE,
    )
    raw = re.sub(r"\s+(?:binary\s+)?sensor$", "", raw, flags=re.IGNORECASE)
    raw = " ".join(raw.split()).strip() or "Home item"
    contact_context = (
        f"{entity_id.replace('_', ' ').replace('-', ' ')} {raw}"
    )
    if re.search(
        r"\b(?:doors?|windows?|locks?|contacts?|openings?|garage)\b",
        contact_context,
        flags=re.IGNORECASE,
    ):
        raw = re.sub(
            r"^(?:alarm|alarmo|security)\s+",
            "",
            raw,
            flags=re.IGNORECASE,
        )
    acronyms = {"co": "CO", "hvac": "HVAC", "nws": "NWS"}
    minor_words = {"and", "of", "the", "in", "at"}
    words = raw.split()
    return " ".join(
        acronyms.get(
            word.lower(),
            word.lower() if index and word.lower() in minor_words else word.capitalize(),
        )
        for index, word in enumerate(words)
    )


def normalize_provider(value) -> str | None:
    """Return one canonical provider name or None when unsupported."""
    provider = PROVIDER_ALIASES.get(str(value).lower(), str(value).lower())
    return provider if provider in SUPPORTED_PROVIDERS else None


def normalize_providers(values) -> list[str]:
    """Return supported provider names, migrating known legacy aliases."""
    if values is None:
        return list(SUPPORTED_PROVIDERS)
    if not isinstance(values, (list, tuple, set)):
        return list(SUPPORTED_PROVIDERS)
    normalized = {provider for value in values if (provider := normalize_provider(value))}
    return [provider for provider in SUPPORTED_PROVIDERS if provider in normalized]


def normalize_provider_options(options: dict) -> dict:
    """Migrate provider-bearing option values to the canonical contract."""
    normalized = dict(options)
    # Exterior lights are intentional live controls, not unattended-state
    # alerts. Remove the retired elapsed-time warning option.
    normalized.pop("exterior_light_delay_minutes", None)
    normalized.setdefault(CONF_CONTACT_FOOTER_PILOT, False)
    raw_capability_sensors = normalized.get(CONF_CAPABILITY_SENSORS)
    capability_sensors = {}
    if isinstance(raw_capability_sensors, dict):
        for entity_id, raw_config in raw_capability_sensors.items():
            if (
                not isinstance(entity_id, str)
                or not entity_id.startswith("sensor.")
                or not isinstance(raw_config, dict)
            ):
                continue
            capability = str(raw_config.get("capability") or "").casefold()
            if capability not in {"temperature", "humidity"}:
                continue
            config = {"capability": capability}
            for key in ("low_threshold", "high_threshold"):
                value = raw_config.get(key)
                if value in (None, ""):
                    continue
                try:
                    config[key] = float(value)
                except (TypeError, ValueError):
                    continue
            priority = str(raw_config.get("priority") or "attention")
            config["priority"] = (
                priority
                if priority in {"normal", "activity", "attention", "critical"}
                else "attention"
            )
            config["publish_current"] = bool(
                raw_config.get("publish_current", False)
            )
            capability_sensors[entity_id] = config
    normalized[CONF_CAPABILITY_SENSORS] = capability_sensors
    try:
        contract_version = int(normalized.get("provider_contract_version", 0))
    except (TypeError, ValueError):
        contract_version = 0
    if "enabled_providers" in normalized:
        enabled = normalize_providers(normalized["enabled_providers"])
        migrated = set(enabled)
        if contract_version < 2:
            migrated.add(PROVIDER_SECURITY)
        if contract_version < 3:
            migrated.add(PROVIDER_CLIMATE)
        if contract_version < 4:
            migrated.add(PROVIDER_CAMERAS)
        if contract_version < 5:
            migrated.add(PROVIDER_FAMILY)
        if contract_version < 6:
            migrated.add(PROVIDER_LIGHTING)
        if contract_version < 7:
            migrated.add(PROVIDER_NEWS)
        enabled = [
            provider for provider in SUPPORTED_PROVIDERS if provider in migrated
        ]
        normalized["enabled_providers"] = enabled
    normalized["provider_contract_version"] = PROVIDER_CONTRACT_VERSION

    overrides = normalized.get("entity_overrides")
    if isinstance(overrides, dict):
        normalized_overrides = {}
        for entity_id, raw_override in overrides.items():
            if not isinstance(raw_override, dict):
                continue
            override = dict(raw_override)
            if "provider_override" in override:
                provider = normalize_provider(override["provider_override"])
                if provider:
                    override["provider_override"] = provider
                else:
                    override.pop("provider_override", None)
            normalized_overrides[entity_id] = override
        normalized["entity_overrides"] = normalized_overrides

    for legacy in ("calendar",):
        for prefix in ("navigation_", "navigation_custom_"):
            old_key = f"{prefix}{legacy}"
            new_key = f"{prefix}{PROVIDER_SCHEDULE}"
            if old_key in normalized and new_key not in normalized:
                normalized[new_key] = normalized[old_key]
            normalized.pop(old_key, None)

    for key in list(normalized):
        if key in {"navigation_enabled"}:
            continue
        if key.startswith("navigation_custom_"):
            provider = key.removeprefix("navigation_custom_")
        elif key.startswith("navigation_"):
            provider = key.removeprefix("navigation_")
        else:
            continue
        if provider not in NAVIGATION_TARGETS:
            normalized.pop(key, None)
    return normalized
