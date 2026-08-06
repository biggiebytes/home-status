import re

DOMAIN = "home_status"
INTEGRATION_VERSION = "0.3.8"
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
# Home Assistant entities commonly report unavailable while integrations are
# restoring. Recovery from that startup transition is not a household event.
STARTUP_AVAILABILITY_RECOVERY_SUPPRESSION_SECONDS = 60
# Alarmo is the standard Home Assistant alarm integration. Home Status uses
# its panel when present and deliberately ignores other alarm-panel entities.
ALARM_ENTITY = "alarm_control_panel.alarmo"
LEAK_SOURCE_NAMES = {
    "binary_sensor.kitchen_sink_moisture": "Kitchen Sink",
    "binary_sensor.bathroom_sink_moisture": "Bathroom Sink",
    "binary_sensor.laundry_room_moisture": "Laundry Room",
}
# Appliance-cycle entities are selected through capability discovery.  Keep
# the retired mapping empty while legacy source-role readers are phased out.
APPLIANCE_CYCLES: dict[str, dict[str, str]] = {}
APPLIANCE_MAINTENANCE: dict[str, dict[str, str]] = {}
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
    "maintenance_sensors": [],
    "leak_sensors": [],
    "filter_status": [],
    "filter_usage": [],
    "refrigerator_doors": [],
    "refrigerator_temperatures": [],
    "weather_alert": [],
    "family_calendar": [],
    "sprinkler_schedule": [],
    "sprinkler_valves": [],
    "waste_schedule": [],
    "laundry_state": list(APPLIANCE_CYCLES),
    "laundry_remaining": [
        config["remaining"] for config in APPLIANCE_CYCLES.values()
    ],
    "appliance_maintenance": list(APPLIANCE_MAINTENANCE),
    "climate_temperature": [],
    "hvac_diagnostics": [],
    "hvac_diagnostic_details": [],
    "hvac_fault_counter": [],
    "system_updates": [],
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
    # The legacy setup wizard stored automatically guessed entity names in
    # these fields. All entity monitoring now starts only from an explicit
    # Add & Configure Entities selection.
    normalized.pop("source_entities", None)
    normalized.pop(CONF_ENTITIES, None)
    normalized.pop(CONF_ENTITY_IDS, None)
    # Exterior lights are intentional live controls, not unattended-state
    # alerts. Remove the retired elapsed-time warning option.
    normalized.pop("exterior_light_delay_minutes", None)
    # Entity events now use the explicit capability pipeline.  Retire the
    # legacy automatic contact-history selection instead of running both.
    normalized.pop("history_entities", None)
    normalized.pop(CONF_CONTACT_FOOTER_PILOT, None)
    raw_capability_sensors = normalized.get(CONF_CAPABILITY_SENSORS)
    capability_sensors = {}
    if isinstance(raw_capability_sensors, dict):
        for entity_id, raw_config in raw_capability_sensors.items():
            if not isinstance(entity_id, str) or not isinstance(raw_config, dict):
                continue
            capability = str(raw_config.get("capability") or "").casefold()
            if capability not in {
                "temperature", "humidity", "smoke", "carbon_monoxide",
                "connectivity", "device_problem", "availability",
                "appliance_cycle",
                "maintenance_alert",
                "state_trigger",
            }:
                continue
            if capability not in {"availability", "state_trigger"} and not entity_id.startswith(
                ("sensor.", "binary_sensor.")
            ):
                continue
            if capability == "appliance_cycle" and not entity_id.startswith(
                "sensor."
            ):
                continue
            config = {"capability": capability}
            if capability in {"temperature", "humidity"}:
                for key in ("low_threshold", "high_threshold"):
                    value = raw_config.get(key)
                    if value in (None, ""):
                        continue
                    try:
                        config[key] = float(value)
                    except (TypeError, ValueError):
                        continue
            default_priority = (
                "activity" if capability == "appliance_cycle" else "attention"
            )
            priority = str(raw_config.get("priority") or default_priority)
            config["priority"] = (
                priority
                if priority in {"normal", "activity", "attention", "critical"}
                else default_priority
            )
            alert_behavior = str(
                raw_config.get("alert_behavior") or "one_time"
            )
            config["alert_behavior"] = (
                alert_behavior
                if alert_behavior in {
                    "one_time", "sustained", "critical", "reminder",
                }
                else "one_time"
            )
            display_route = str(
                raw_config.get("display_route") or "main_then_footer"
            )
            config["display_route"] = (
                display_route
                if display_route in {
                    "main_then_footer", "main_only", "footer_only",
                }
                else "main_then_footer"
            )
            display_name = str(raw_config.get("display_name") or "").strip()
            if display_name:
                config["display_name"] = display_name[:60]
            default_trigger_delay = 30 if capability == "connectivity" else 0
            try:
                trigger_delay_seconds = int(
                    raw_config.get(
                        "trigger_delay_seconds", default_trigger_delay
                    )
                )
            except (TypeError, ValueError):
                trigger_delay_seconds = default_trigger_delay
            config["trigger_delay_seconds"] = max(
                0, min(3600, trigger_delay_seconds)
            )
            if capability in {"temperature", "humidity"}:
                config["publish_current"] = bool(
                    raw_config.get("publish_current", False)
                )
            if capability == "availability":
                config["alert_when_active"] = bool(
                    raw_config.get("alert_when_active", False)
                )
            if capability == "appliance_cycle":
                appliance_type = str(
                    raw_config.get("appliance_type") or "appliance"
                )
                config["appliance_type"] = (
                    appliance_type
                    if appliance_type in {
                        "washer", "dryer", "dishwasher", "appliance",
                    }
                    else "appliance"
                )
                for key, defaults in (
                    (
                        "complete_states",
                        ["complete", "completed", "finished", "done", "end"],
                    ),
                    ("idle_states", ["off", "idle", "ready", "power_off"]),
                ):
                    values = raw_config.get(key, defaults)
                    if isinstance(values, (list, tuple, set)):
                        normalized_states = list(dict.fromkeys(
                            str(value).strip().casefold()
                            for value in values if str(value).strip()
                        ))
                        config[key] = normalized_states or defaults
                remaining_entity = str(
                    raw_config.get("remaining_entity") or ""
                ).strip()
                if remaining_entity.startswith("sensor."):
                    config["remaining_entity"] = remaining_entity
            if capability in {"maintenance_alert", "state_trigger"}:
                for key in ("active_message", "resolved_message", "icon"):
                    value = str(raw_config.get(key) or "").strip()
                    if value:
                        config[key] = value[:80]
            if capability == "state_trigger":
                trigger_state = str(
                    raw_config.get("trigger_state") or "on"
                ).strip().casefold()
                config["trigger_state"] = trigger_state or "on"
            if raw_config.get("retention_minutes") not in (None, ""):
                try:
                    retention_minutes = int(raw_config["retention_minutes"])
                except (TypeError, ValueError):
                    retention_minutes = None
                if retention_minutes is not None:
                    config["retention_minutes"] = max(
                        1, min(1440, retention_minutes)
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
