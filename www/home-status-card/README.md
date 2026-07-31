# Home Status Card

Home Assistant Lovelace card with a browser-local expandable notification drawer. It reads the existing Home Status sensors and does not require Browser Mod, an `input_boolean`, or backend changes.

Copy the entire `home-status-card` directory to `/config/www/home-status-card`. Weather renderers load their player and animations from the bundled `vendor` and `assets` directories; they do not use a CDN.

Resource:

```yaml
url: /local/home-status-card/home-status-card.js?v=7
type: module
```

Rain uses its approved local Lottie renderer. Sunny uses an original local WebM animation with an MP4 fallback. Clouds, fog, wind, storm, and night continue using the existing CSS renderer until their ambient assets are individually approved.

Third-party notices are stored beside the relevant local assets:

- `vendor/lottie-web.LICENSE.md`
- `assets/weather/rain-background.LICENSE.md`
