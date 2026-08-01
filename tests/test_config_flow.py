from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.home_status.const import DOMAIN, SUPPORTED_PROVIDERS


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
    assert result["data"]["source_entities"]["family_calendar"] == ["calendar.family"]
    assert result["data"]["source_entities"]["laundry_state"] == ["sensor.washer_machine_state"]


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
        "weather",
        "appearance",
        "navigation",
        "customize",
        "advanced",
    ]
