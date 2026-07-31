from custom_components.home_status.coordinator import HomeStatusCoordinator


async def test_regional_weather_entity_is_not_a_fallback(hass):
    hass.states.async_set("weather.kjax", "sunny")
    hass.states.async_set("weather.home", "cloudy")
    coordinator = object.__new__(HomeStatusCoordinator)
    coordinator.hass = hass
    coordinator.options = {}

    assert coordinator._resolve_forecast_entity() is None


async def test_explicit_weather_entity_wins(hass):
    hass.states.async_set("weather.kjax", "sunny")
    hass.states.async_set("weather.home", "cloudy")
    coordinator = object.__new__(HomeStatusCoordinator)
    coordinator.hass = hass
    coordinator.options = {"forecast_entity": "weather.home"}

    assert coordinator._resolve_forecast_entity() == "weather.home"
