from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.home_status.const import DOMAIN, SUPPORTED_PROVIDERS
from pytest_homeassistant_custom_component.common import MockConfigEntry


async def test_recommended_onboarding(hass):
    hass.states.async_set("weather.home", "sunny")
    hass.states.async_set("calendar.family", "off")
    hass.states.async_set("sensor.washer_machine_state", "idle")
    hass.states.async_set("sensor.waste_collection_schedule_garbage", "2026-08-03")
    hass.states.async_set("alarm_control_panel.home", "disarmed")
    hass.states.async_set("update.home_assistant_core_update", "off")
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"setup_profile": "recommended"},
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "summary"
    assert "• Weather" in result["description_placeholders"]["detected"]
    assert "• Calendar" in result["description_placeholders"]["detected"]
    assert "• Laundry" in result["description_placeholders"]["detected"]
    assert "• Waste" in result["description_placeholders"]["detected"]
    assert "• Security" in result["description_placeholders"]["detected"]
    assert "• Sprinklers" in result["description_placeholders"]["not_detected"]

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Home Status"
    assert result["data"]["enabled_providers"] == list(SUPPORTED_PROVIDERS)
    assert result["data"]["setup_profile"] == "recommended"
    assert result["data"]["forecast_entity"] == "weather.home"
    assert "source_entities" not in result["data"]
    assert "history_entities" not in result["data"]


async def test_recommended_only_asks_when_multiple_weather_entities_exist(hass):
    hass.states.async_set("weather.home", "sunny")
    hass.states.async_set("weather.backup", "cloudy")

    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"setup_profile": "recommended"},
    )
    assert result["step_id"] == "weather"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"forecast_entity": "weather.home", "include_nws_alerts": True},
    )
    assert result["step_id"] == "summary"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["forecast_entity"] == "weather.home"


async def test_essentials_uses_discovery_but_enables_only_core_providers(hass):
    hass.states.async_set("weather.home", "sunny")
    hass.states.async_set("camera.front_door", "idle")
    hass.states.async_set("light.porch", "off")

    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"setup_profile": "essentials"},
    )
    assert result["step_id"] == "summary"
    assert "• Cameras" in result["description_placeholders"]["detected"]
    assert "• Lighting" in result["description_placeholders"]["detected"]

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["enabled_providers"] == [
        "security", "weather", "schedule", "maintenance", "laundry"
    ]


async def test_custom_onboarding_and_permanent_settings_menu(hass):
    hass.states.async_set(
        "binary_sensor.front_door",
        "off",
        {"device_class": "door", "friendly_name": "Front Door"},
    )
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"setup_profile": "custom"},
    )
    assert result["step_id"] == "sources"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            "enabled_providers": ["security", "weather"],
            "history_entities": ["binary_sensor.front_door"],
        },
    )
    assert result["step_id"] == "weather"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"forecast_entity": "weather.home", "include_nws_alerts": False},
    )
    assert result["step_id"] == "summary"

    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["enabled_providers"] == ["security", "weather"]
    assert result["data"]["history_entities"] == ["binary_sensor.front_door"]
    assert result["data"]["forecast_entity"] == "weather.home"

    entry = result["result"]
    options = await hass.config_entries.options.async_init(entry.entry_id)
    assert options["type"] is FlowResultType.MENU
    assert options["menu_options"] == [
        "general",
        "information_sources",
        "news_sources",
        "experimental_sensors",
        "weather",
        "appearance",
        "navigation",
        "customize",
        "advanced",
    ]


async def test_experimental_sensor_options_require_explicit_selection(hass):
    hass.states.async_set(
        "sensor.office_temperature",
        "72",
        {
            "device_class": "temperature",
            "state_class": "measurement",
            "unit_of_measurement": "°F",
            "friendly_name": "Office Temperature",
        },
    )
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"enabled_providers": list(SUPPORTED_PROVIDERS)},
        options={},
        unique_id="home_status",
    )
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "experimental_sensors"}
    )
    assert result["step_id"] == "experimental_sensors"
    assert "capability_sensors" not in entry.options

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {"capability_entity": "sensor.office_temperature"},
    )
    assert result["step_id"] == "experimental_sensor"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "low_threshold": 60,
            "high_threshold": 80,
            "priority": "attention",
            "publish_current": False,
            "remove_sensor": False,
        },
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "review"
    assert "capability_sensors" not in entry.options
    assert "Capability Sensors" in result["description_placeholders"]["changes"]

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {}
    )
    assert result["type"] is FlowResultType.MENU
    assert entry.options["capability_sensors"] == {
        "sensor.office_temperature": {
            "capability": "temperature",
            "low_threshold": 60.0,
            "high_threshold": 80.0,
            "priority": "attention",
            "publish_current": False,
        }
    }


async def test_stable_provider_changes_are_discovered_reviewed_and_reversible(hass):
    hass.states.async_set("weather.home", "sunny")
    hass.states.async_set(
        "binary_sensor.front_door",
        "off",
        {"device_class": "door", "friendly_name": "Front Door"},
    )
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"enabled_providers": list(SUPPORTED_PROVIDERS)},
        options={},
        unique_id="home_status",
    )
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "information_sources"}
    )
    assert result["step_id"] == "information_sources"
    assert result["description_placeholders"]["detected"] == "Security, Weather, News"
    schema = result["data_schema"].schema
    history_field = next(key for key in schema if key.schema == "history_entities")
    assert history_field.default() == []

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "enabled_providers": ["security", "weather"],
            "history_entities": ["binary_sensor.front_door"],
        },
    )
    assert result["step_id"] == "review"
    assert entry.options == {}
    assert "Enabled Providers" in result["description_placeholders"]["changes"]
    assert "No problems found" in result["description_placeholders"]["warnings"]

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {}
    )
    assert result["type"] is FlowResultType.MENU
    assert entry.options["enabled_providers"] == ["security", "weather"]
    assert entry.options["history_entities"] == ["binary_sensor.front_door"]


async def test_options_warn_without_blocking_when_all_providers_are_disabled(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"enabled_providers": list(SUPPORTED_PROVIDERS)},
        options={},
        unique_id="home_status",
    )
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "information_sources"}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"enabled_providers": [], "history_entities": []}
    )
    assert result["step_id"] == "review"
    assert "Notification Center may be empty" in result["description_placeholders"]["warnings"]
    assert entry.options == {}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {}
    )
    assert result["type"] is FlowResultType.MENU
    assert entry.options["enabled_providers"] == []


async def test_news_sources_can_be_added_and_reviewed(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"enabled_providers": list(SUPPORTED_PROVIDERS)},
        options={},
        unique_id="home_status",
    )
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "news_sources"}
    )
    assert result["step_id"] == "news_sources"
    assert result["description_placeholders"]["summary"] == (
        "1 active of 1 configured"
    )

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"news_source": "__add__"}
    )
    assert result["step_id"] == "news_source"
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "enabled": True,
            "name": "Favorite Local News",
            "url": "https://example.com/local-news.xml",
            "icon": "mdi:newspaper",
            "refresh_minutes": 30,
            "max_items": 3,
            "remove_source": False,
        },
    )
    assert result["step_id"] == "review"
    assert entry.options == {}

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {}
    )
    assert result["type"] is FlowResultType.MENU
    assert [feed["name"] for feed in entry.options["news_feeds"]] == [
        "NASA", "Favorite Local News"
    ]
    assert entry.options["news_feeds"][1]["max_items"] == 3

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "news_sources"}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"news_source": "nasa"}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "enabled": True,
            "name": "NASA",
            "url": "https://www.nasa.gov/feed/",
            "icon": "mdi:rocket-launch-outline",
            "refresh_minutes": 15,
            "max_items": 1,
            "remove_source": True,
        },
    )
    assert result["step_id"] == "review"
    await hass.config_entries.options.async_configure(result["flow_id"], {})
    assert [feed["name"] for feed in entry.options["news_feeds"]] == [
        "Favorite Local News"
    ]


async def test_news_source_rejects_invalid_or_duplicate_urls(hass):
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={"enabled_providers": list(SUPPORTED_PROVIDERS)},
        options={},
        unique_id="home_status",
    )
    entry.add_to_hass(hass)

    result = await hass.config_entries.options.async_init(entry.entry_id)
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"next_step_id": "news_sources"}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"news_source": "__add__"}
    )
    invalid = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "enabled": True,
            "name": "Bad Feed",
            "url": "javascript:alert(1)",
            "icon": "mdi:newspaper",
            "refresh_minutes": 15,
            "max_items": 1,
            "remove_source": False,
        },
    )
    assert invalid["step_id"] == "news_source"
    assert invalid["errors"] == {"url": "invalid_news_feed_url"}

    duplicate = await hass.config_entries.options.async_configure(
        invalid["flow_id"],
        {
            "enabled": True,
            "name": "NASA Again",
            "url": "https://www.nasa.gov/feed/",
            "icon": "mdi:rocket",
            "refresh_minutes": 15,
            "max_items": 1,
            "remove_source": False,
        },
    )
    assert duplicate["errors"] == {"url": "duplicate_news_feed_url"}
