import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.components import frontend as ha_frontend
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.home_status import FRONTEND_PATH, async_setup
from custom_components.home_status.const import (
    DOMAIN,
    FRONTEND_MODULE_URL,
    FRONTEND_URL_BASE,
    INTEGRATION_VERSION,
)


async def test_clean_install_loads_card_without_manual_resource(hass, hass_client):
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Home Status",
        data={"setup_profile": "recommended", "enabled_providers": []},
        options={},
    )
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id) is True
    await hass.async_block_till_done()

    assert FRONTEND_MODULE_URL in hass.data[ha_frontend.DATA_EXTRA_MODULE_URL].urls
    client = await hass_client()
    response = await client.get(FRONTEND_MODULE_URL)
    assert response.status == 200
    card_source = await response.text()
    assert "customElements.define('home-status-card'" in card_source
    assert hass.states.get("sensor.home_status") is not None


async def test_frontend_is_served_and_registered_automatically():
    hass = MagicMock()
    hass.http.async_register_static_paths = AsyncMock()

    with patch(
        "custom_components.home_status.ha_frontend.add_extra_js_url"
    ) as add_extra_js_url:
        assert await async_setup(hass, {}) is True

    paths = hass.http.async_register_static_paths.await_args.args[0]
    assert len(paths) == 1
    assert paths[0].url_path == FRONTEND_URL_BASE
    assert Path(paths[0].path) == FRONTEND_PATH
    assert paths[0].cache_headers is False
    add_extra_js_url.assert_called_once_with(hass, FRONTEND_MODULE_URL)


def test_hacs_install_contains_the_complete_card_runtime():
    expected = {
        "home-status-card.js",
        "vendor/lottie_light_canvas.min.js",
        "vendor/lottie-web.LICENSE.md",
        "assets/weather/rain-background.json",
        "assets/weather/rain-background.LICENSE.md",
        "assets/weather/sunny-ambient.webm",
        "assets/weather/sunny-ambient.mp4",
        "assets/weather/meteocons.LICENSE",
    }
    present = {
        path.relative_to(FRONTEND_PATH).as_posix()
        for path in FRONTEND_PATH.rglob("*")
        if path.is_file()
    }
    assert expected <= present

    card_source = (FRONTEND_PATH / "home-status-card.js").read_text(encoding="utf-8")
    assert "/local/home-status-card" not in card_source
    assert "if (!customElements.get('home-status-card'))" in card_source
    assert "customElements.define('home-status-card'" in card_source
    assert "customElements.define('home-status-card-editor'" in card_source
    assert "window.customCards.some(card => card.type === 'home-status-card')" in card_source


def test_frontend_version_and_manifest_dependencies_are_aligned():
    repository_root = FRONTEND_PATH.parents[2]
    manifest = json.loads(
        (FRONTEND_PATH.parent / "manifest.json").read_text(encoding="utf-8")
    )
    package = json.loads((repository_root / "package.json").read_text(encoding="utf-8"))

    assert manifest["version"] == INTEGRATION_VERSION == package["version"]
    assert {"frontend", "http", "lovelace"} <= set(manifest["dependencies"])
    assert not (repository_root / "www" / "home-status-card").exists()
