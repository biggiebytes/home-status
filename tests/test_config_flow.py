from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType

from custom_components.home_status.const import DOMAIN, SUPPORTED_PROVIDERS


async def test_recommended_onboarding(hass):
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
    assert result["step_id"] == "weather"

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"include_nws_alerts": True},
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Home Status"
    assert result["data"]["enabled_providers"] == list(SUPPORTED_PROVIDERS)
    assert result["data"]["setup_profile"] == "recommended"
    assert "forecast_entity" not in result["data"]


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
