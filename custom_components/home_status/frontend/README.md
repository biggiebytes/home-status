# Home Status Card

Home Assistant Lovelace card with a browser-local expandable notification
drawer. It reads `sensor.home_status` and does not require Browser Mod or
additional helper entities.

The card, visual editor, weather player, and animations are bundled inside the
Home Status integration. Home Assistant serves and registers the JavaScript
module automatically when the integration loads. No `/config/www` copy,
Dashboard Resource, or CDN is required.

Rain uses its approved local Lottie renderer. Sunny uses an original local WebM animation with an MP4 fallback. Clouds, fog, wind, storm, and night continue using the existing CSS renderer until their ambient assets are individually approved.

Third-party notices are stored beside the relevant local assets:

- `vendor/lottie-web.LICENSE.md`
- `assets/weather/rain-background.LICENSE.md`
- `assets/weather/meteocons.LICENSE`
