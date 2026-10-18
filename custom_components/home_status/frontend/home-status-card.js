const FRONTEND_ASSET_BASE = new URL('.', import.meta.url).href.replace(/\/$/, '');
const LOTTIE_PLAYER_URL = `${FRONTEND_ASSET_BASE}/vendor/lottie_light_canvas.min.js`;
const HLS_JS_URL = `${FRONTEND_ASSET_BASE}/vendor/hls.min.js`;

const LOTTIE_WEATHER_ASSETS = Object.freeze({
  rain: Object.freeze({
    url: `${FRONTEND_ASSET_BASE}/assets/weather/rain-background.json`,
    className: 'lottie-rain-layer',
    preserveAspectRatio: 'none'
  })
});

const VIDEO_WEATHER_ASSETS = Object.freeze({
  clear: Object.freeze({
    sources: Object.freeze([
      Object.freeze({
        src: `${FRONTEND_ASSET_BASE}/assets/weather/sunny-ambient.webm`,
        type: 'video/webm'
      }),
      Object.freeze({
        src: `${FRONTEND_ASSET_BASE}/assets/weather/sunny-ambient.mp4`,
        type: 'video/mp4'
      })
    ])
  })
});

let lottiePlayerPromise = null;
let hlsJsPromise = null;

function loadHlsJs() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsJsPromise) return hlsJsPromise;

  hlsJsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = HLS_JS_URL;
    script.async = true;

    script.onload = () =>
      window.Hls
        ? resolve(window.Hls)
        : reject(new Error('hls.js did not load'));

    script.onerror = () =>
      reject(new Error('hls.js could not load'));

    document.head.append(script);
  });

  return hlsJsPromise;
}

function loadLottiePlayer() {
  if (window.lottie?.loadAnimation) {
    return Promise.resolve(window.lottie);
  }

  if (lottiePlayerPromise) return lottiePlayerPromise;

  lottiePlayerPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(
      'script[data-home-status-lottie]'
    );

    const script = existing || document.createElement('script');

    const loaded = () => {
      if (window.lottie?.loadAnimation) {
        resolve(window.lottie);
      } else {
        reject(
          new Error(
            'Local Lottie player loaded without an animation API'
          )
        );
      }
    };

    const failed = () => {
      script.remove();
      lottiePlayerPromise = null;
      reject(
        new Error('Unable to load the local Lottie player')
      );
    };

    script.addEventListener('load', loaded, { once: true });
    script.addEventListener('error', failed, { once: true });

    if (!existing) {
      script.src = LOTTIE_PLAYER_URL;
      script.async = true;
      script.dataset.homeStatusLottie = 'true';
      document.head.append(script);
    }
  });

  return lottiePlayerPromise;
}

class CssWeatherRenderer {
  constructor() {
    this._container = null;
    this._layer = null;
    this._effect = 'none';
    this._visible = true;
  }

  mount(container) {
    if (!container) return;

    if (
      this._container === container &&
      this._layer?.isConnected
    ) {
      return;
    }

    this._layer?.remove();
    this._container = container;

    this._layer = document.createElement('span');
    this._layer.className =
      'weather-renderer-layer weather-effect-none';
    this._layer.setAttribute('aria-hidden', 'true');

    container.prepend(this._layer);

    this.setEffect(this._effect);
    this.setVisible(this._visible);
  }

  setEffect(effect) {
    const nextEffect =
      String(effect || 'none').trim().toLowerCase() || 'none';

    if (this._layer) {
      const nextClass = `weather-effect-${nextEffect}`;

      if (!this._layer.classList.contains(nextClass)) {
        this._layer.classList.remove(
          `weather-effect-${this._effect}`
        );
        this._layer.classList.add(nextClass);
      }
    }

    this._effect = nextEffect;
  }

  setVisible(visible) {
    this._visible = visible !== false;

    this._layer?.classList.toggle(
      'ambient-paused',
      !this._visible
    );
  }

  destroy() {
    this._layer?.remove();
    this._layer = null;
    this._container = null;
    this._effect = 'none';
    this._visible = true;
  }
}

class LottieWeatherRenderer {
  constructor(effect, asset) {
    this._effect = effect;
    this._asset = asset;
    this._container = null;
    this._layer = null;
    this._animation = null;
    this._fallback = null;
    this._visible = true;
    this._loadGeneration = 0;
  }

  mount(container) {
    if (!container) return;

    if (
      this._container === container &&
      (this._layer?.isConnected || this._fallback)
    ) {
      return;
    }

    this._clearRenderedState();

    this._container = container;
    this._layer = document.createElement('span');

    this._layer.className =
      `weather-renderer-layer lottie-weather-layer ` +
      `${this._asset.className} lottie-weather-${this._effect}`;

    this._layer.setAttribute('aria-hidden', 'true');

    container.prepend(this._layer);

    this.setVisible(this._visible);
    this._load();
  }

  setEffect() {}

  setVisible(visible) {
    this._visible = visible !== false;

    this._layer?.classList.toggle(
      'ambient-paused',
      !this._visible
    );

    this._fallback?.setVisible(this._visible);

    if (!this._animation) return;

    if (this._visible) {
      this._animation.play();
    } else {
      this._animation.pause();
    }
  }

  destroy() {
    this._loadGeneration += 1;
    this._clearRenderedState();
    this._container = null;
    this._visible = true;
  }

  async _load() {
    const generation = ++this._loadGeneration;

    try {
      const lottie = await loadLottiePlayer();

      if (
        generation !== this._loadGeneration ||
        !this._layer?.isConnected
      ) {
        return;
      }

      const animation = lottie.loadAnimation({
        container: this._layer,
        renderer: 'canvas',
        loop: true,
        autoplay: this._visible,
        path: this._asset.url,
        rendererSettings: {
          clearCanvas: true,
          dpr: 1,
          preserveAspectRatio:
            this._asset.preserveAspectRatio ||
            'xMidYMid meet',
          progressiveLoad: true,
          runExpressions: false
        }
      });

      this._animation = animation;
      animation.setSubframe(false);

      animation.addEventListener('data_failed', () => {
        if (generation === this._loadGeneration) {
          this._showCssFallback();
        }
      });

      if (!this._visible) {
        animation.pause();
      }
    } catch (error) {
      if (generation === this._loadGeneration) {
        this._showCssFallback(error);
      }
    }
  }

  _showCssFallback(error) {
    if (!this._container || this._fallback) return;

    if (error) {
      console.warn(
        `[HomeStatusCard] Local ${this._effect} asset unavailable; using CSS fallback.`,
        error
      );
    }

    this._animation?.destroy();
    this._animation = null;

    this._layer?.remove();
    this._layer = null;

    this._fallback = new CssWeatherRenderer();
    this._fallback.mount(this._container);
    this._fallback.setEffect(this._effect);
    this._fallback.setVisible(this._visible);
  }

  _clearRenderedState() {
    this._animation?.destroy();
    this._animation = null;

    this._fallback?.destroy();
    this._fallback = null;

    this._layer?.remove();
    this._layer = null;
  }
}

class VideoWeatherRenderer {
  constructor(effect, asset) {
    this._effect = effect;
    this._asset = asset;
    this._container = null;
    this._video = null;
    this._fallback = null;
    this._visible = true;
    this._handleError = () => this._showCssFallback();
  }

  mount(container) {
    if (!container) return;

    if (
      this._container === container &&
      (this._video?.isConnected || this._fallback)
    ) {
      return;
    }

    this._clearRenderedState();
    this._container = container;

    const video = document.createElement('video');

    video.className =
      `weather-renderer-layer video-weather-layer ` +
      `video-weather-${this._effect}`;

    video.setAttribute('aria-hidden', 'true');

    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.disablePictureInPicture = true;

    for (const sourceDefinition of this._asset.sources) {
      const source = document.createElement('source');
      source.src = sourceDefinition.src;
      source.type = sourceDefinition.type;
      video.append(source);
    }

    video.addEventListener('error', this._handleError);

    this._video = video;

    container.prepend(video);

    this.setVisible(this._visible);
  }

  setEffect() {}

  setVisible(visible) {
    this._visible = visible !== false;

    this._video?.classList.toggle(
      'ambient-paused',
      !this._visible
    );

    this._fallback?.setVisible(this._visible);

    if (!this._video) return;

    if (this._visible) {
      const playAttempt = this._video.play();
      playAttempt?.catch?.(() => {});
    } else {
      this._video.pause();
    }
  }

  destroy() {
    this._clearRenderedState();
    this._container = null;
    this._visible = true;
  }

  _showCssFallback() {
    if (!this._container || this._fallback) return;

    const container = this._container;

    this._releaseVideo();

    this._fallback = new CssWeatherRenderer();
    this._fallback.mount(container);
    this._fallback.setEffect(this._effect);
    this._fallback.setVisible(this._visible);
  }

  _releaseVideo() {
    if (!this._video) return;

    this._video.removeEventListener(
      'error',
      this._handleError
    );

    this._video.pause();

    this._video
      .querySelectorAll('source')
      .forEach(source => source.remove());

    this._video.removeAttribute('src');
    this._video.load();
    this._video.remove();

    this._video = null;
  }

  _clearRenderedState() {
    this._releaseVideo();

    this._fallback?.destroy();
    this._fallback = null;
  }
}

class WeatherRenderer {
  constructor(rendererFactories = {}) {
    this._rendererFactories = {
      css: () => new CssWeatherRenderer(),

      ...Object.fromEntries(
        Object.entries(LOTTIE_WEATHER_ASSETS).map(
          ([effect, asset]) => [
            `lottie-${effect}`,
            () => new LottieWeatherRenderer(effect, asset)
          ]
        )
      ),

      ...Object.fromEntries(
        Object.entries(VIDEO_WEATHER_ASSETS).map(
          ([effect, asset]) => [
            `video-${effect}`,
            () => new VideoWeatherRenderer(effect, asset)
          ]
        )
      ),

      ...rendererFactories
    };

    this._container = null;
    this._renderer = null;
    this._rendererType = null;
    this._effect = 'none';
    this._visible = true;
  }

  mount(container) {
    if (!container) return;

    this._container = container;

    this._ensureRenderer(
      this._rendererType || 'css'
    );

    this._renderer.mount(container);
  }

  setEffect(effect, options = {}) {
    this._effect =
      String(effect || 'none').trim().toLowerCase() || 'none';

    const rendererType =
      options.renderer ||
      (
        VIDEO_WEATHER_ASSETS[this._effect]
          ? `video-${this._effect}`
          : LOTTIE_WEATHER_ASSETS[this._effect]
            ? `lottie-${this._effect}`
            : 'css'
      );

    this._ensureRenderer(rendererType);

    if (this._container) {
      this._renderer.mount(this._container);
    }

    this._renderer.setEffect(
      this._effect,
      options
    );

    this._renderer.setVisible(
      this._visible
    );
  }

  setVisible(visible) {
    this._visible = visible !== false;

    this._renderer?.setVisible(
      this._visible
    );
  }

  destroy() {
    this._renderer?.destroy();

    this._renderer = null;
    this._rendererType = null;
    this._container = null;
    this._effect = 'none';
    this._visible = true;
  }

  _ensureRenderer(rendererType) {
    if (
      this._renderer &&
      this._rendererType === rendererType
    ) {
      return;
    }

    this._renderer?.destroy();

    const createRenderer =
      this._rendererFactories[rendererType];

    if (!createRenderer) {
      throw new Error(
        `Unknown weather renderer: ${rendererType}`
      );
    }

    this._renderer = createRenderer();
    this._rendererType = rendererType;
  }
}

const HOME_STATUS_CARD_PROFILES = {
  auto: {
    profile: 'auto',
    layout: 'responsive',
    utility_header: { enabled: true },
    left: { rotate: true, interval: 7 },
    right: { rotate: true },
    bottom: { rotate: false, speed: 35 },
    home_status_visibility: {
      left: true,
      right: true,
      bottom: true,
      phone_ticker: true
    },
    sizing: {
      max_width: 0,
      min_height: 0
    }
  },

  phone: {
    profile: 'phone',
    layout: 'compact',
    utility_header: { enabled: false },
    left: { rotate: false },
    right: { rotate: false },
    bottom: { rotate: false, speed: 26 },
    home_status_visibility: {
      left: false,
      right: false,
      bottom: false,
      phone_ticker: true
    },
    sizing: {
      max_width: 0,
      min_height: 0
    }
  },

  tablet: {
    profile: 'tablet',
    layout: 'tablet-default',
    utility_header: { enabled: true },
    left: { rotate: true, interval: 7 },
    right: { rotate: true },
    bottom: { rotate: false, speed: 35 },
    home_status_visibility: {
      left: true,
      right: true,
      bottom: true,
      phone_ticker: true
    },
    sizing: {
      max_width: 0,
      min_height: 0
    }
  },

  desktop: {
    profile: 'desktop',
    layout: 'desktop-wide',
    utility_header: { enabled: true },
    left: { rotate: true, interval: 7 },
    right: { rotate: true },
    bottom: { rotate: false, speed: 40 },
    home_status_visibility: {
      left: true,
      right: true,
      bottom: true,
      phone_ticker: true
    },
    sizing: {
      max_width: 1800,
      min_height: 0
    }
  }
};

const HOME_STATUS_KNOWN_TOP_LEVEL_KEYS = new Set([
  'type',
  'entity',
  'profile',
  'layout',
  'grid_options',
  'card_size',
  'show_active_count',
  'pause_on_hover',
  'utility_header',
  'left',
  'right',
  'bottom',
  'phone_ticker',
  'context_actions',
  'display',
  'home_status_visibility',
  'sizing',
  'animation',
  'weather_effect',
  'time_entity',
  'recent_drawer_limit',
  'rotation_seconds',
  'lane_mode',
  'theme_mode'
]);

function homeStatusClone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }

  return JSON.parse(
    JSON.stringify(value)
  );
}

function homeStatusObject(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    ? value
    : {};
}

function homeStatusMerge(base, overlay) {
  const output =
    homeStatusClone(
      homeStatusObject(base)
    );

  Object.entries(
    homeStatusObject(overlay)
  ).forEach(([key, value]) => {
    output[key] =
      homeStatusObject(value) === value
        ? homeStatusMerge(
            output[key],
            value
          )
        : homeStatusClone(value);
  });

  return output;
}

function homeStatusGetPath(
  config,
  path,
  fallback = undefined
) {
  const value =
    String(path)
      .split('.')
      .reduce(
        (current, key) =>
          homeStatusObject(current)[key],
        config
      );

  return value === undefined
    ? fallback
    : value;
}

function homeStatusSetPath(
  config,
  path,
  value,
  removeEmpty = false
) {
  const output =
    homeStatusClone(
      homeStatusObject(config)
    );

  const keys =
    String(path).split('.');

  let target = output;

  keys
    .slice(0, -1)
    .forEach(key => {
      target[key] =
        homeStatusObject(target[key]) === target[key]
          ? homeStatusClone(target[key])
          : {};

      target = target[key];
    });

  const finalKey =
    keys[keys.length - 1];

  if (
    removeEmpty &&
    (
      value === '' ||
      value === undefined ||
      value === null
    )
  ) {
    delete target[finalKey];
  } else {
    target[finalKey] = value;
  }

  return output;
}

function homeStatusApplyProfile(
  config,
  profile
) {
  const preset =
    HOME_STATUS_CARD_PROFILES[profile] ||
    HOME_STATUS_CARD_PROFILES.auto;

  return homeStatusMerge(
    config,
    preset
  );
}


class HomeStatusLaneSlotController {
  constructor(card, zone, slotIndex) {
    this.card = card;
    this.zone = zone;
    this.slotIndex = slotIndex;
    this.items = [];
    this.cursor = 0;
    this.currentId = null;
    this.intervalSeconds = 7;
    this.rotate = true;
    this.emptyLabel = 'No current information';
    this.signature = '';
    this.nextAdvanceAt = null;
  }

  stop() {
    this.nextAdvanceAt = null;

    const renderTimerKey = `${this.zone}:${this.slotIndex}`;
    if (this.card._zoneRenderTimers?.[renderTimerKey]) {
      clearTimeout(this.card._zoneRenderTimers[renderTimerKey]);
      delete this.card._zoneRenderTimers[renderTimerKey];
    }
  }

  configure({ items, intervalSeconds, rotate, emptyLabel, signature, laneEmpty = false }) {
    const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const nextIds = nextItems.map(item => this.card._laneItemId(item));
    const previousId = this.currentId;

    this.stop();
    this.items = nextItems;
    this.intervalSeconds = intervalSeconds;
    this.rotate = rotate !== false;
    this.emptyLabel = emptyLabel || 'No current information';
    this.signature = signature || '';

    if (!nextItems.length) {
      this.cursor = 0;
      this.currentId = null;
      this.card._renderLaneSlot(this.zone, this.slotIndex, null, this.emptyLabel, laneEmpty);
      return;
    }

    const preservedIndex = previousId ? nextIds.indexOf(previousId) : -1;
    if (preservedIndex >= 0) {
      this.cursor = preservedIndex;
    } else {
      this.cursor = Math.min(this.cursor, nextItems.length - 1);
    }

    this.currentId = this.card._laneItemId(nextItems[this.cursor]);
    this.card._renderLaneSlot(this.zone, this.slotIndex, nextItems[this.cursor], this.emptyLabel, false);

    if (!this.rotate || nextItems.length <= 1) return;

    const intervalMs = Math.max(4, Number(this.intervalSeconds) || 7) * 1000;
    this.nextAdvanceAt = this.card._alignedLaneCycleAt(intervalMs);
  }

  advance() {
    if (this.card._rotationPaused || this.items.length <= 1) return;

    const nextCursor = (this.cursor + 1) % this.items.length;
    const nextItem = this.items[nextCursor];

    this.card._transitionLaneSlot(
      this.zone,
      this.slotIndex,
      nextItem,
      this.emptyLabel,
      () => {
        this.cursor = nextCursor;
        this.currentId = this.card._laneItemId(nextItem);
      }
    );
  }
}


class HomeStatusVisualPresentationController {
  constructor(card) {
    this.card = card;
    this.items = [];
    this.cursor = 0;
    this.currentId = null;
    this.intervalSeconds = 7;
    this.rotate = true;
    this.signature = '';
    this.nextAdvanceAt = null;
  }

  stop() {
    this.nextAdvanceAt = null;
  }

  configure({ items, intervalSeconds, rotate, signature }) {
    const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const previousId = this.currentId;
    this.stop();
    this.items = nextItems;
    this.intervalSeconds = intervalSeconds;
    this.rotate = rotate !== false;
    this.signature = signature || '';

    if (!nextItems.length) {
      this.cursor = 0;
      this.currentId = null;
      return;
    }

    const nextIds = nextItems.map(page => page.id);
    const preservedIndex = previousId ? nextIds.indexOf(previousId) : -1;
    this.cursor = preservedIndex >= 0 ? preservedIndex : Math.min(this.cursor, nextItems.length - 1);
    this.currentId = nextItems[this.cursor].id;
    this.card._visualPresentationPage = this.cursor;

    if (!this.rotate || nextItems.length <= 1) return;
    const intervalMs = Math.max(4, Number(this.intervalSeconds) || 7) * 1000;
    this.nextAdvanceAt = this.card._alignedLaneCycleAt(intervalMs);
  }

  advance() {
    if (this.card._rotationPaused || this.items.length <= 1) return;
    const nextCursor = (this.cursor + 1) % this.items.length;
    this.cursor = nextCursor;
    this.currentId = this.items[nextCursor].id;
    this.card._visualPresentationPage = nextCursor;
    this.card._renderVisualPresentationPage();
  }
}

class HomeStatusVisualWeatherController {
  constructor(card) {
    this.card = card;
    this.items = [];
    this.cursor = 0;
    this.currentId = null;
    this.intervalSeconds = 9;
    this.rotate = true;
    this.signature = '';
    this.nextAdvanceAt = null;
  }

  stop() {
    this.nextAdvanceAt = null;
  }

  configure({ items, intervalSeconds, rotate, signature }) {
    const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const previousId = this.currentId;
    this.stop();
    this.items = nextItems;
    this.intervalSeconds = intervalSeconds;
    this.rotate = rotate !== false;
    this.signature = signature || '';

    if (!nextItems.length) {
      this.cursor = 0;
      this.currentId = null;
      return;
    }

    const ids = nextItems.map(item => item.id);
    const preserved = previousId ? ids.indexOf(previousId) : -1;
    this.cursor = preserved >= 0 ? preserved : Math.min(this.cursor, nextItems.length - 1);
    this.currentId = nextItems[this.cursor].id;
    this.card._renderVisualWeatherFace(nextItems[this.cursor]);

    if (!this.rotate || nextItems.length <= 1) return;
    const intervalMs = Math.max(4, Number(this.intervalSeconds) || 9) * 1000;
    this.nextAdvanceAt = this.card._alignedLaneCycleAt(intervalMs);
  }

  advance() {
    if (this.card._rotationPaused || this.items.length <= 1) return;
    this.cursor = (this.cursor + 1) % this.items.length;
    this.currentId = this.items[this.cursor].id;
    this.card._renderVisualWeatherFace(this.items[this.cursor]);
  }
}

class HomeStatusHeaderClimateController {
  constructor(card) {
    this.card = card;
    this.items = [];
    this.cursor = 0;
    this.currentId = null;
    this.intervalSeconds = 7;
    this.rotate = true;
    this.signature = '';
    this.nextAdvanceAt = null;
  }

  stop() {
    this.nextAdvanceAt = null;

    if (this.card._headerClimateRenderTimer) {
      clearTimeout(this.card._headerClimateRenderTimer);
      this.card._headerClimateRenderTimer = null;
    }
  }

  configure({ items, intervalSeconds, rotate, signature }) {
    const nextItems = Array.isArray(items) ? items.filter(Boolean) : [];
    const nextIds = nextItems.map(item => this.card._laneItemId(item));
    const previousId = this.currentId;

    this.stop();
    this.items = nextItems;
    this.intervalSeconds = intervalSeconds;
    this.rotate = rotate !== false;
    this.signature = signature || '';

    if (!nextItems.length) {
      this.cursor = 0;
      this.currentId = null;
      this.card._renderHeaderClimate(null);
      return;
    }

    const preservedIndex = previousId ? nextIds.indexOf(previousId) : -1;
    if (preservedIndex >= 0) {
      this.cursor = preservedIndex;
    } else {
      this.cursor = Math.min(this.cursor, nextItems.length - 1);
    }

    const item = nextItems[this.cursor];
    this.currentId = this.card._laneItemId(item);
    this.card._renderHeaderClimate(item);

    if (!this.rotate || nextItems.length <= 1) return;

    const intervalMs = Math.max(4, Number(this.intervalSeconds) || 7) * 1000;
    this.nextAdvanceAt = this.card._alignedLaneCycleAt(intervalMs);
  }

  advance() {
    if (this.card._rotationPaused || this.items.length <= 1) return;

    const nextCursor = (this.cursor + 1) % this.items.length;
    const nextItem = this.items[nextCursor];

    this.card._transitionHeaderClimate(nextItem, () => {
      this.cursor = nextCursor;
      this.currentId = this.card._laneItemId(nextItem);
    });
  }
}

class HomeStatusCard extends HTMLElement {
  constructor() {
    super();

    if (!this.shadowRoot) {
      this.attachShadow({
        mode: 'open'
      });
    }

    this._config = null;
    this._hass = null;

    this._drawerOpen = false;
    this._lastTime = null;

    this._zoneRenderTimers = {};

    // Each physical lane row is now a first-class controller. The lane itself
    // no longer owns one shared cursor/timer or moves as a single carousel.
    this._laneSlotControllers = {
      left: Array.from({ length: 3 }, (_, index) =>
        new HomeStatusLaneSlotController(this, 'left', index)),
      right: Array.from({ length: 3 }, (_, index) =>
        new HomeStatusLaneSlotController(this, 'right', index))
    };

    // Active Item Control (AIC) assigns active items to real physical slots.
    // The map is intentionally persistent across updates so surviving active
    // claims stay in place when another claim resolves or a new one arrives.
    // Dashboard v2 reuses the proven v1 aligned slot scheduler instead of
    // maintaining a second presentation timer.
    this._visualPresentationController = new HomeStatusVisualPresentationController(this);
    this._visualWeatherController = new HomeStatusVisualWeatherController(this);

    this._activeSlotClaims = new Map();

    // The six physical slots keep independent state, but share one scheduler.
    // Slots with the same interval therefore advance on the same visual beat.
    this._laneCycleTimer = null;
    this._laneCycleEpoch = performance.now();

    // Single-item lanes are a supported v1 presentation mode. They
    // have their own lightweight cursors/timers and do not instantiate the
    // three-slot allocator when selected.
    this._singleLaneTimers = { left: null, right: null };
    this._singleLaneIndexes = { left: 0, right: 0 };
    this._singleLaneIds = { left: null, right: null };

    // Home Assistant replaces `hass` for every state event. Track only the
    // entities that can affect this card so unrelated entity churn can be
    // ignored on tablets.
    this._hassInputSignatureValue = '';
    this._lastVisualEntityId = '';
    this._lastTransportData = null;

    // The weather header is also a controller surface. It owns current weather
    // plus temperature/humidity measurements so those facts can rotate here
    // instead of consuming side-lane capacity.
    this._headerClimateController = new HomeStatusHeaderClimateController(this);
    this._headerClimateRenderTimer = null;

    this._displayedZoneItems = {
      left: null,
      right: null
    };

    this._baseVisual = null;
    this._baseVisualQueue = [];
    this._baseVisualQueueKeys = [];
    this._baseVisualSourceGroups = new Map();
    this._baseVisualSourceCursors = new Map();
    this._eventVisualCursors = new Map();
    this._eventVisualPools = new Map();
    this._baseVisualQueueActive = false;
    this._baseVisualQueueIndex = 0;
    this._baseVisualQueueSignature = '';
    this._baseVisualQueueInterval = 0;
    this._baseVisualQueueTimer = null;

    this._zoneSignatures = {
      left: '',
      right: ''
    };

    this._footerSignature = '';
    this._footerSignatureParts = [];

    this._footerResizeObserver = null;
    this._visibilityObserver = null;
    this._documentVisibilityHandler = null;
    this._intersectionVisible = true;

    this._ambientVisible = true;

    this._weatherRenderer =
      new WeatherRenderer();

    this._mediaEnabled = true;

    this._drawerSignature = '';
    this._drawerCloseTimer = null;

    this._rotationPaused = false;

    this._expandedEventIds =
      new Set();

    this._domReady = false;
    this._clockTimer = null;

    // Visual Mode v2: three fixed presentation slots. Only the content rotates.
    this._visualPresentationPage = 0;
    this._visualPresentationTimer = null;
    this._visualPresentationSignature = '';
    this._visualPresentationIntervalMs = 0;
    this._onViewportChange = () => this._syncResponsiveVisualProfile();
  }

  connectedCallback() {
    window.addEventListener('resize', this._onViewportChange, { passive: true });
    this._syncResponsiveVisualProfile();
  }

  setConfig(config) {
    if (
      !config ||
      typeof config !== 'object'
    ) {
      throw new Error(
        'Invalid Home Status card configuration'
      );
    }

    const utilityHeader =
      config.utility_header &&
      typeof config.utility_header === 'object'
        ? config.utility_header
        : {};

    const leftConfig =
      homeStatusObject(config.left);

    const rightConfig =
      homeStatusObject(config.right);

    const bottomConfig =
      homeStatusObject(config.bottom);

    const requestedBottomSpeed =
      Number(bottomConfig.speed);

    const phoneTickerConfig =
      homeStatusObject(
        config.phone_ticker
      );

    const requestedPhoneTickerSpeed =
      Number(phoneTickerConfig.speed);

    const namespacedVisibility =
      homeStatusObject(
        config.home_status_visibility
      );

    const visibility = namespacedVisibility;

    const sizing =
      homeStatusObject(
        config.sizing
      );

    const animation =
      homeStatusObject(
        config.animation
      );

    const profile =
      ['auto', 'phone', 'tablet', 'desktop']
        .includes(config.profile)
          ? config.profile
          : 'auto';

    const laneMode =
      ['single', 'slots'].includes(config.lane_mode)
        ? config.lane_mode
        : 'slots';

    const presentationMode =
      ['classic', 'visual'].includes(config.presentation_mode)
        ? config.presentation_mode
        : 'classic';

    // Dark is the v1 default. Users can choose Auto to follow Home Assistant.
    const themeMode =
      ['auto', 'light', 'dark'].includes(config.theme_mode)
        ? config.theme_mode
        : 'dark';

    this._rawConfig =
      homeStatusClone(config);

    this._config = {
      ...homeStatusClone(config),

      entity:
        config.entity ||
        'sensor.home_status',

      context_actions:
        config.context_actions || {},

      layout:
        config.layout ||
        'tablet-default',

      profile,

      lane_mode:
        laneMode,

      presentation_mode:
        presentationMode,

      theme_mode:
        themeMode,

      left:
        leftConfig,

      right:
        rightConfig,

      bottom:
        bottomConfig,

      bottom_speed:
        Number.isFinite(
          requestedBottomSpeed
        )
          ? Math.max(
              1,
              requestedBottomSpeed
            )
          : 35,

      phone_ticker: {
        speed:
          Number.isFinite(
            requestedPhoneTickerSpeed
          )
            ? Math.max(
                1,
                requestedPhoneTickerSpeed
              )
            : 35
      },

      display:
        config.display || {},

      utility_header: {
        enabled:
          utilityHeader.enabled !== false,

        security_entity:
          utilityHeader.security_entity || '',

        security_path:
          utilityHeader.security_path || '',

        music_entity:
          utilityHeader.music_entity || '',

        music_path:
          utilityHeader.music_path || ''
      },

      home_status_visibility: {
        left:
          visibility.left !== false,

        right:
          visibility.right !== false,

        bottom:
          visibility.bottom !== false,

        phone_ticker:
          visibility.phone_ticker !== false,

        drawer:
          visibility.drawer !== false
      },

      sizing: {
        max_width:
          Number.isFinite(
            Number(sizing.max_width)
          )
            ? Math.max(
                0,
                Number(sizing.max_width)
              )
            : 0,

        min_height:
          Number.isFinite(
            Number(sizing.min_height)
          )
            ? Math.max(
                0,
                Number(sizing.min_height)
              )
            : 0
      },

      animation: {
        level:
          ['full', 'reduced', 'none']
            .includes(animation.level)
              ? animation.level
              : 'full'
      },

      weather_effect:
        String(
          config.weather_effect || 'auto'
        ).toLowerCase(),

      pause_on_hover:
        config.pause_on_hover !== false,

      time_entity:
        config.time_entity || '',

      recent_drawer_limit:
        Number.isFinite(
          Number(config.recent_drawer_limit)
        )
          ? Number(config.recent_drawer_limit)
          : 10,

      rotation_seconds:
        Number.isFinite(
          Number(config.rotation_seconds)
        )
          ? Number(config.rotation_seconds)
          : 4
    };

    this._requestedProfile = profile;
    this._syncResponsiveVisualProfile();

    this.setAttribute(
      'data-layout',
      this._config.layout
    );

    this.setAttribute(
      'data-presentation-mode',
      this._config.presentation_mode
    );

    this.setAttribute(
      'data-animation',
      this._config.animation.level
    );

    this._applyThemeMode();

    this.style.maxWidth =
      this._config.sizing.max_width
        ? `${this._config.sizing.max_width}px`
        : profile === 'phone'
          ? '600px'
          : '';

    this.style.minHeight =
      this._config.sizing.min_height
        ? `${this._config.sizing.min_height}px`
        : '';

    this.style.setProperty(
      '--home-status-phone-ticker-seconds',
      `${Math.max(
        1,
        this._config.phone_ticker.speed
      )}s`
    );

    this._stopZoneRotations();

    this._zoneSignatures = {
      left: '',
      right: ''
    };

    this._footerSignature = '';
    this._footerSignatureParts = [];
    this._drawerSignature = '';
    this._hassInputSignatureValue = '';

    this._updateCard();
  }

  _applyThemeMode(hass = this._hass) {
    const requested = this._config?.theme_mode || 'dark';
    let resolved = requested;

    if (requested === 'auto') {
      const haDark = hass?.themes?.darkMode;
      // HA exposes darkMode on the theme manager. Fall back to the browser
      // preference only until hass is available during initial card setup.
      resolved = typeof haDark === 'boolean'
        ? (haDark ? 'dark' : 'light')
        : (window.matchMedia?.('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light');
    }

    if (!['light', 'dark'].includes(resolved)) resolved = 'dark';
    if (this.dataset.themeMode !== resolved) {
      this.dataset.themeMode = resolved;
    }
    if (this.dataset.themePreference !== requested) {
      this.dataset.themePreference = requested;
    }
  }

  _hassInputSignature(hass) {
    const parts = [];
    const seen = new Set();

    const addEntity = entityId => {
      const id = String(entityId || '').trim();
      if (!id || seen.has(id)) return;
      seen.add(id);
      const state = hass?.states?.[id];
      parts.push(`${id}:${state?.last_updated || ''}:${state?.state || ''}`);
    };

    const sourceId = this._config?.entity || 'sensor.home_status';
    addEntity(sourceId);

    const source = hass?.states?.[sourceId];
    const manifest = source?.attributes?.transport;
    if (manifest?.kind === 'manifest' && manifest.channels) {
      Object.values(manifest.channels).forEach(channel =>
        addEntity(channel?.entity_id)
      );
    }

    addEntity(this._config?.time_entity);
    addEntity(this._config?.utility_header?.security_entity);
    addEntity(this._config?.utility_header?.music_entity);
    addEntity(this._lastVisualEntityId);

    return parts.join('|');
  }

  _syncResponsiveVisualProfile() {
    const requested = this._requestedProfile || this._config?.profile || 'auto';
    const phoneViewport = typeof window !== 'undefined' && window.matchMedia(
      '(max-width: 600px), (max-width: 1000px) and (max-height: 600px)'
    ).matches;
    const effective = this._config?.presentation_mode === 'visual' && phoneViewport
      ? 'phone'
      : requested;

    this.setAttribute('data-profile', effective);
  }

  set hass(hass) {
    this._hass = hass;
    this._applyThemeMode(hass);

    const nextInputSignature = this._hassInputSignature(hass);
    if (
      this._hassInputSignatureValue &&
      nextInputSignature === this._hassInputSignatureValue
    ) {
      return;
    }
    this._hassInputSignatureValue = nextInputSignature;

    const time =
      hass?.states?.[
        this._config?.time_entity
      ]?.state;

    if (time !== this._lastTime) {
      this._lastTime = time;
    }

    try {
      this._updateCard();
    } catch (error) {
      console.error(
        '[HomeStatusCard] update failed',
        error
      );

      throw error;
    }
  }

  get hass() {
    return this._hass;
  }

  disconnectedCallback() {
    window.removeEventListener('resize', this._onViewportChange);
    this._stopZoneRotations();
    this._stopVisualQueueRotation();

    if (this._clockTimer) {
      clearTimeout(
        this._clockTimer
      );

      this._clockTimer = null;
    }

    if (this._footerResizeObserver) {
      this._footerResizeObserver.disconnect();
      this._footerResizeObserver = null;
    }

    this._visibilityObserver?.disconnect();
    this._visibilityObserver = null;

    if (this._documentVisibilityHandler) {
      document.removeEventListener(
        'visibilitychange',
        this._documentVisibilityHandler
      );
      this._documentVisibilityHandler = null;
    }

    this._destroyVisualHls(
      this.shadowRoot?.querySelector(
        '[data-visual-center]'
      )
    );

    this._weatherRenderer.destroy();

    if (this._drawerCloseTimer) {
      clearTimeout(
        this._drawerCloseTimer
      );

      this._drawerCloseTimer = null;
    }

    Object.values(
      this._zoneRenderTimers
    ).forEach(timer =>
      clearTimeout(timer)
    );

    this._zoneRenderTimers = {};

  }

  _state(entity) {
    return this._hass?.states?.[entity];
  }

  _updateCard() {
    if (
      !this._config ||
      !this._hass
    ) {
      return;
    }

    if (
      this.shadowRoot.querySelector(
        '.ticker'
      )
    ) {
      this._update();
    } else {
      this.render();
    }
  }

  _date(value) {
    if (!value) return null;

    const text =
      String(value).trim();

    let match =
      text.match(
        /^(\d{4})-(\d{2})-(\d{2})$/
      );

    if (match) {
      const [
        ,
        year,
        month,
        day
      ] = match;

      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day)
      );
    }

    match =
      text.match(
        /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
      );

    if (match) {
      const [
        ,
        year,
        month,
        day,
        hour,
        minute,
        second = '0'
      ] = match;

      return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second)
      );
    }

    const date =
      new Date(text);

    return Number.isFinite(
      date.getTime()
    )
      ? date
      : null;
  }

  _friendlyScheduled(
    value,
    allDay = false
  ) {
    const date =
      this._date(value);

    if (!date) return '';

    const now = new Date();

    const today =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );

    const eventDay =
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      );

    const delta =
      Math.round(
        (eventDay - today) /
        86400000
      );

    const dayLabel =
      delta === 0
        ? 'Today'
        : delta === 1
          ? 'Tomorrow'
          : date.toLocaleDateString(
              [],
              {
                weekday: 'short',
                month: 'short',
                day: 'numeric'
              }
            );

    if (
      allDay ||
      /^\d{4}-\d{2}-\d{2}$/
        .test(
          String(value).trim()
        )
    ) {
      return dayLabel;
    }

    return (
      `${dayLabel} • ` +
      date.toLocaleTimeString(
        [],
        {
          hour: 'numeric',
          minute: '2-digit'
        }
      )
    );
  }

  _time(value) {
    const date =
      this._date(value);

    if (!date) return '';

    return date.toLocaleTimeString(
      [],
      {
        hour: 'numeric',
        minute: '2-digit'
      }
    );
  }

  _relative(value) {
    const date =
      this._date(value);

    if (!date) return '';

    const now =
      new Date();

    const minutes =
      Math.max(
        0,
        Math.floor(
          (now - date) / 60000
        )
      );

    if (minutes < 1) {
      return 'Just now';
    }

    if (minutes < 60) {
      return `${minutes} min ago`;
    }

    const hours =
      Math.floor(
        minutes / 60
      );

    const rest =
      minutes % 60;

    if (hours < 24) {
      return (
        `${hours} hr` +
        `${hours === 1 ? '' : 's'}` +
        `${rest ? ` ${rest} min` : ''} ago`
      );
    }

    const today =
      new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );

    const day =
      new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate()
      );

    const delta =
      Math.round(
        (today - day) /
        86400000
      );

    if (delta === 1) {
      return (
        `Yesterday ${this._time(date)}`
      );
    }

    if (
      delta >= 0 &&
      delta < 7
    ) {
      return (
        `${date.toLocaleDateString(
          [],
          { weekday: 'short' }
        )} ${this._time(date)}`
      );
    }

    return (
      `${date.toLocaleDateString(
        [],
        {
          month: 'short',
          day: 'numeric'
        }
      )} • ${this._time(date)}`
    );
  }

  _splitTransportData(
    attrs,
    source,
    display,
    presentation
  ) {
    const manifest =
      attrs.transport &&
      typeof attrs.transport === 'object' &&
      attrs.transport.kind === 'manifest'
        ? attrs.transport
        : null;

    if (!manifest || !manifest.channels || typeof manifest.channels !== 'object') {
      return null;
    }

    const revision = Number(manifest.revision);
    const required = ['now', 'recent', 'household', 'weather', 'calendar', 'news', 'visual'];
    if (!Number.isFinite(revision) || !required.every(channel => manifest.channels[channel]?.entity_id)) {
      return null;
    }

    const channels = Object.fromEntries(
      required.map(channel => {
        const entity = this._state(manifest.channels[channel].entity_id);
        const payload = entity?.attributes?.transport;
        return [channel, payload];
      })
    );

    // Home Assistant updates each entity separately. Refuse a mixed snapshot;
    // the caller keeps the last complete v1 snapshot until every channel catches up.
    if (!required.every(channel => {
      const payload = channels[channel];
      return payload &&
        payload.kind === 'channel' &&
        payload.channel === channel &&
        Number(payload.revision) === revision;
    })) {
      return null;
    }

    const active = Array.isArray(channels.now.items) ? channels.now.items : [];
    const recent = Array.isArray(channels.recent.items) ? channels.recent.items : [];
    const awareness = [
      ...((Array.isArray(channels.household.items) ? channels.household.items : [])),
      ...((Array.isArray(channels.weather.items) ? channels.weather.items : [])),
      ...((Array.isArray(channels.calendar.items) ? channels.calendar.items : [])),
      ...((Array.isArray(channels.news.items) ? channels.news.items : []))
    ];
    const streams = manifest.streams && typeof manifest.streams === 'object'
      ? manifest.streams
      : {};
    const itemById = new Map(
      [...active, ...recent, ...awareness]
        .filter(item => item && item.id)
        .map(item => [String(item.id), item])
    );
    const resolveStream = ids => (
      Array.isArray(ids)
        ? ids.map(id => itemById.get(String(id))).filter(Boolean)
        : []
    );
    const phonePrimary =
      itemById.get(String(streams.phone_primary_id || '')) ||
      (streams.phone_fallback && typeof streams.phone_fallback === 'object'
        ? streams.phone_fallback
        : null);

    return {
      side: resolveStream(streams.side),
      left: resolveStream(streams.left),
      right: resolveStream(streams.right),
      bottom: resolveStream(streams.bottom),
      phone_primary: phonePrimary,
      active,
      recent,
      awareness,
      household: Array.isArray(channels.household.items) ? channels.household.items : [],
      weather: Array.isArray(channels.weather.items) ? channels.weather.items : [],
      calendar: Array.isArray(channels.calendar.items) ? channels.calendar.items : [],
      news: Array.isArray(channels.news.items) ? channels.news.items : [],
      priority: attrs.priority || attrs.health || 'normal',
      count: Number(attrs.active_count) || active.length,
      display,
      presentation,
      visual: channels.visual.visual && typeof channels.visual.visual === 'object'
        ? channels.visual.visual
        : null,
      visual_queue: Array.isArray(channels.visual.visual_queue)
        ? channels.visual.visual_queue
        : [],
      visual_queue_active: channels.visual.visual_queue_active === true,
      weather_visual_effect: channels.visual.weather_visual_effect || '',
      unavailable: !source || ['unknown', 'unavailable'].includes(source.state)
    };
  }

  _data() {
    const source = this._state(this._config.entity);
    const attrs = source?.attributes || {};
    const display =
      attrs.display && typeof attrs.display === 'object'
        ? attrs.display
        : {};
    const presentation =
      attrs.presentation && typeof attrs.presentation === 'object'
        ? attrs.presentation
        : {};
    const unavailable =
      !source || ['unknown', 'unavailable'].includes(source.state);

    const split = this._splitTransportData(
      attrs,
      source,
      display,
      presentation
    );

    if (split) {
      this._lastTransportData = split;
      return split;
    }

    // Channel entities update independently. Keep rendering the last complete
    // snapshot until every required channel reaches the same revision.
    if (this._lastTransportData) {
      return {
        ...this._lastTransportData,
        priority: attrs.priority || attrs.health || this._lastTransportData.priority || 'normal',
        count: Number(attrs.active_count) || this._lastTransportData.count || 0,
        display,
        presentation,
        unavailable
      };
    }

    return {
      side: [],
      left: [],
      right: [],
      bottom: [],
      active: [],
      recent: [],
      awareness: [],
      household: [],
      weather: [],
      calendar: [],
      news: [],
      phone_primary: null,
      priority: attrs.priority || attrs.health || 'normal',
      count: Number(attrs.active_count) || 0,
      display,
      presentation,
      visual: null,
      visual_queue: [],
      visual_queue_active: false,
      weather_visual_effect: '',
      unavailable
    };
  }

  _getRuntimeData() {
    return this._data();
  }

  _visualFromData(value) {
    if (
      !value ||
      typeof value !== 'object'
    ) {
      return null;
    }

    const type =
      String(
        value.type || ''
      ).toLowerCase();

    if (
      ![
        'image',
        'video',
        'camera',
        'map'
      ].includes(type)
    ) {
      return null;
    }

    const rawUrl =
      typeof value.url === 'string'
        ? value.url.trim()
        : '';

    const url =
      type === 'image' || type === 'video'
        ? this._safeMediaUrl(rawUrl)
        : rawUrl;

    const entityId =
      typeof value.entity_id === 'string'
        ? value.entity_id.trim()
        : '';

    if (
      !url &&
      !entityId
    ) {
      return null;
    }

    if (value.expires_at) {
      const expires =
        new Date(
          value.expires_at
        );

      if (
        !Number.isFinite(
          expires.getTime()
        ) ||
        expires.getTime() <= Date.now()
      ) {
        return null;
      }
    }

    if (
      (
        type === 'image' ||
        type === 'video'
      ) &&
      !url
    ) {
      return null;
    }

    if (
      type === 'camera' &&
      !entityId
    ) {
      return null;
    }

    return {
      type,

      transport:
        typeof value.transport === 'string'
          ? value.transport
              .trim()
              .toLowerCase()
          : '',

      url,

      article_url:
        this._safeExternalUrl(value.article_url),

      title:
        typeof value.title === 'string'
          ? value.title.trim()
          : '',

      event_start:
        typeof value.event_start === 'string'
          ? value.event_start.trim()
          : '',

      event_end:
        typeof value.event_end === 'string'
          ? value.event_end.trim()
          : '',

      entity_id:
        entityId,

      source_id:
        typeof value.source_id === 'string'
          ? value.source_id.trim()
          : '',

      source_kind:
        typeof value.source_kind === 'string'
          ? value.source_kind.trim().toLowerCase()
          : '',

      display_duration:
        Number.isFinite(Number(value.display_duration)) && Number(value.display_duration) > 0
          ? Number(value.display_duration)
          : 0,

      priority:
        String(
          value.priority ||
          'normal'
        ),

      live:
        value.live === true,

      started_at:
        typeof value.started_at === 'string'
          ? value.started_at
          : '',

      expires_at:
        typeof value.expires_at === 'string'
          ? value.expires_at
          : '',

      resumable:
        value.resumable !== false,

      mute:
        value.mute !== false
    };
  }

  _visualSignature(visual) {
    return visual
      ? [
          visual.type,
          visual.transport,
          visual.url,
          visual.entity_id,
          visual.article_url,
          visual.title,
          visual.event_start,
          visual.event_end,
          visual.source_id,
          visual.source_kind,
          visual.display_duration,
          visual.priority,
          visual.live,
          visual.started_at,
          visual.expires_at,
          visual.resumable,
          visual.mute
        ].join('|')
      : '';
  }

  _visualMediaSignature(visual) {
    // Media identity is deliberately narrower than the presentation
    // signature. Metadata such as title, lifetime, priority, or overlay dates
    // may change while the underlying image/video/camera is still identical.
    // In particular, those metadata updates must never restart an HLS stream.
    return visual
      ? [
          visual.type,
          visual.transport,
          visual.url,
          visual.entity_id
        ].join('|')
      : '';
  }

  _stopVisualQueueRotation() {
    if (this._baseVisualQueueTimer) {
      clearTimeout(this._baseVisualQueueTimer);
      this._baseVisualQueueTimer = null;
    }
  }

  _visualTimingSettings(data) {
    const fallback = Math.max(
      1,
      Number(data?.display?.rotation_seconds) || this._config.rotation_seconds || 6
    );
    return {
      event: Math.max(1, Number(data?.display?.visual_event_duration) || 6),
      news: Math.max(1, Number(data?.display?.visual_news_duration) || 12),
      stream: Math.max(1, Number(data?.display?.visual_stream_duration) || 24),
      fallback
    };
  }

  _visualTurnDuration(visual) {
    const timing = this._baseVisualTiming || { event: 6, news: 12, stream: 24, fallback: 6 };
    const sourceKind = String(visual?.source_kind || '').toLowerCase();

    if (sourceKind === 'events') return timing.event;
    if (sourceKind === 'news') return timing.news;
    if (sourceKind === 'live_news' || visual?.live === true || visual?.transport === 'hls') {
      return timing.stream;
    }

    const candidateDuration = Number(visual?.display_duration);
    return Number.isFinite(candidateDuration) && candidateDuration > 0
      ? candidateDuration
      : timing.fallback;
  }

  _scheduleVisualQueueTurn() {
    this._stopVisualQueueRotation();
    if (
      !this._ambientVisible ||
      !this._baseVisualQueueActive ||
      this._baseVisualQueue.length <= 1
    ) return;

    const currentVisual = this._queuedBaseVisual();
    const duration = this._visualTurnDuration(currentVisual);
    this._baseVisualQueueTimer = setTimeout(() => {
      this._baseVisualQueueTimer = null;

      if (this._rotationPaused) {
        this._baseVisualQueueTimer = setTimeout(() => {
          this._baseVisualQueueTimer = null;
          this._scheduleVisualQueueTurn();
        }, 1000);
        return;
      }

      const currentKey = this._baseVisualQueueKeys[this._baseVisualQueueIndex] || '';
      const currentGroup = currentKey
        ? (this._baseVisualSourceGroups.get(currentKey) || [])
        : [];
      const eventPool = currentKey
        ? (this._eventVisualPools.get(currentKey) || [])
        : [];

      if (currentKey && eventPool.length > 1) {
        const eventCursor = Number(this._eventVisualCursors.get(currentKey)) || 0;
        const nextEventCursor = (eventCursor + 1) % eventPool.length;
        this._eventVisualCursors.set(currentKey, nextEventCursor);
        const replacement = eventPool[nextEventCursor];
        const sourceIndex = this._baseVisualQueueKeys.indexOf(currentKey);
        if (replacement && sourceIndex >= 0) {
          this._baseVisualQueue[sourceIndex] = replacement;
        }
      }

      if (currentKey && currentGroup.length > 1) {
        const cursor = Number(this._baseVisualSourceCursors.get(currentKey)) || 0;
        this._baseVisualSourceCursors.set(
          currentKey,
          (cursor + 1) % currentGroup.length
        );
        const fair = this._sourceFairVisualQueue(
          this._baseVisualSourceGroups,
          this._baseVisualQueueKeys
        );
        this._baseVisualQueue = fair.queue;
        this._baseVisualQueueKeys = fair.keys;
      }

      this._baseVisualQueueIndex =
        (this._baseVisualQueueIndex + 1) % this._baseVisualQueue.length;
      this._syncDisplayedVisual();
      this._scheduleVisualQueueTurn();
    }, duration * 1000);
  }

  _queuedBaseVisual() {
    return this._baseVisualQueueActive
      ? this._baseVisualQueue[this._baseVisualQueueIndex] || null
      : null;
  }

  _visualSourceKey(visual) {
    return (
      visual?.source_id ||
      visual?.source_kind ||
      `${visual?.type || 'visual'}:${visual?.url || visual?.entity_id || ''}`
    );
  }

  _groupVisualQueue(values) {
    // Source fairness is separate from item rotation. Each provider receives
    // one Visual Center turn, while its own cursor advances between turns.
    const groups = new Map();
    const order = [];

    for (const visual of values) {
      const key = this._visualSourceKey(visual);
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key).push(visual);
    }

    return { groups, order };
  }

  _sourceFairVisualQueue(groups, order) {
    const queue = [];
    const keys = [];

    for (const key of order) {
      const group = groups.get(key) || [];
      if (!group.length) continue;

      const previousCursor = Number(this._baseVisualSourceCursors.get(key)) || 0;
      const cursor = ((previousCursor % group.length) + group.length) % group.length;
      this._baseVisualSourceCursors.set(key, cursor);
      queue.push(group[cursor]);
      keys.push(key);
    }

    return { queue, keys };
  }

  _eventVisualRepresentatives(data) {
    const pools = new Map();
    const awareness = Array.isArray(data?.awareness) ? data.awareness : [];

    for (const item of awareness) {
      if (!item || String(item.source_kind || '').toLowerCase() !== 'events') continue;
      const url = String(item.media_url || item.image_url || '').trim();
      if (!url) continue;
      const key = String(item.source_id || item.source || 'events');
      if (!pools.has(key)) pools.set(key, []);
      pools.get(key).push({
        type: 'image',
        url,
        article_url: item.navigation || item.action || '',
        title: item.title || item.message || '',
        source: item.source_name || item.source || 'Events',
        source_id: key,
        source_kind: 'events',
        event_start: item.event_start || '',
        event_end: item.event_end || '',
        priority: item.priority || 'normal',
        live: false,
        resumable: true,
        mute: true
      });
    }

    this._eventVisualPools = pools;
    for (const key of [...this._eventVisualCursors.keys()]) {
      if (!pools.has(key)) this._eventVisualCursors.delete(key);
    }

    const representatives = [];
    for (const [key, group] of pools.entries()) {
      if (!group.length) continue;
      const cursor = ((Number(this._eventVisualCursors.get(key)) || 0) % group.length + group.length) % group.length;
      this._eventVisualCursors.set(key, cursor);
      representatives.push(group[cursor]);
    }
    return representatives;
  }

  _syncVisualQueue(data) {
    let queue = data.visual_queue_active
      ? (Array.isArray(data.visual_queue)
          ? data.visual_queue
              .map(value => this._visualFromData(value))
              .filter(Boolean)
          : [])
      : [];

    // The backend publishes ordinary image/video media as a rotating queue,
    // while dedicated Visual Center sources (including HLS/live streams) are
    // published as the selected base visual. When both are normal-priority
    // presentation, they must share one rotation instead of the queue
    // permanently hiding the base source. A genuinely higher-priority base
    // visual is left outside the queue so existing pre-emption still wins.
    const baseVisual = this._visualFromData(data.visual);
    const priorityRank = visual => {
      const ranks = { critical: 0, attention: 1, activity: 2, normal: 3 };
      return ranks[String(visual?.priority || 'normal').toLowerCase()] ?? 3;
    };
    const bestQueueRank = queue.length
      ? Math.min(...queue.map(priorityRank))
      : null;
    const baseShouldShare = baseVisual && queue.length > 0 &&
      (bestQueueRank === null || priorityRank(baseVisual) >= bestQueueRank);

    if (baseShouldShare) {
      const baseSignature = this._visualSignature(baseVisual);
      if (!queue.some(value => this._visualSignature(value) === baseSignature)) {
        queue.push(baseVisual);
      }
    }

    // Neutral rich-event sources keep their full event list in awareness, but
    // only one event artwork representative is admitted to Visual Center per
    // source turn. This prevents a large event feed from becoming dozens of
    // simultaneous scheduler candidates.
    for (const eventVisual of this._eventVisualRepresentatives(data)) {
      const signature = this._visualSignature(eventVisual);
      if (!queue.some(value => this._visualSignature(value) === signature)) {
        queue.push(eventVisual);
      }
    }

    const grouped = this._groupVisualQueue(queue);
    this._baseVisualSourceGroups = grouped.groups;

    // Drop cursors for providers that are no longer present.
    for (const key of [...this._baseVisualSourceCursors.keys()]) {
      if (!grouped.groups.has(key)) this._baseVisualSourceCursors.delete(key);
    }

    const fair = this._sourceFairVisualQueue(grouped.groups, grouped.order);
    queue = fair.queue;
    const queueKeys = fair.keys;

    // Signature includes every candidate, not just the current representative,
    // so a new RSS article updates that provider's internal rotation without
    // creating extra source turns.
    const signature = grouped.order
      .map(key => `${key}::${(grouped.groups.get(key) || [])
        .map(value => this._visualSignature(value))
        .join('~')}`)
      .join('||');
    const timing = this._visualTimingSettings(data);
    const timingSignature = [timing.event, timing.news, timing.stream, timing.fallback].join('|');

    if (
      signature === this._baseVisualQueueSignature &&
      timingSignature === this._baseVisualQueueTimingSignature
    ) {
      this._baseVisualQueueActive = queue.length > 0;
      return;
    }

    const previousVisual = this._queuedBaseVisual();
    const previousSignature = this._visualSignature(previousVisual);
    const previousSourceKey = this._baseVisualQueueKeys[this._baseVisualQueueIndex] || '';
    const timingChanged = timingSignature !== this._baseVisualQueueTimingSignature;

    this._baseVisualQueue = queue;
    this._baseVisualQueueKeys = queueKeys;
    this._baseVisualQueueActive = queue.length > 0;
    this._baseVisualQueueSignature = signature;
    this._baseVisualQueueTimingSignature = timingSignature;
    this._baseVisualTiming = timing;

    const preservedSourceIndex = previousSourceKey
      ? queueKeys.indexOf(previousSourceKey)
      : -1;
    const preservedVisualIndex = previousSignature
      ? queue.findIndex(value => this._visualSignature(value) === previousSignature)
      : -1;
    this._baseVisualQueueIndex = preservedSourceIndex >= 0
      ? preservedSourceIndex
      : preservedVisualIndex >= 0
        ? preservedVisualIndex
        : Math.min(this._baseVisualQueueIndex, Math.max(0, queue.length - 1));

    if (queue.length <= 1) {
      this._stopVisualQueueRotation();
      return;
    }

    // A normal Home Assistant refresh does not restart the current turn.
    // User timing changes apply immediately; each subsequent source turn then
    // schedules itself using the duration configured for that source type.
    if (timingChanged || !this._baseVisualQueueTimer) {
      this._scheduleVisualQueueTurn();
    }

  }

  _syncVisualCenter(value) {
    const zones = this.shadowRoot.querySelector('.ticker-zones');
    const visualModeCenter = this.shadowRoot.querySelector('.visual-mode-center[data-visual-center]');

    if (!zones && !visualModeCenter) return;

    const visual = this._visualFromData(value);
    let center = visualModeCenter || zones?.querySelector('[data-visual-center]');

    zones?.classList.toggle('has-visual', Boolean(visual));

    if (!visual) {
      this._destroyVisualHls(center);
      if (visualModeCenter) {
        visualModeCenter.dataset.visualSignature = '';
        visualModeCenter.dataset.visualMediaSignature = '';
        visualModeCenter.innerHTML = '<span class="visual-center-fallback visual-mode-fallback"><ha-icon icon="mdi:image-outline"></ha-icon><span>Waiting for visual content</span></span>';
      } else {
        center?.remove();
      }
      return;
    }

    if (!center) {
      center =
        document.createElement(
          'span'
        );

      center.className =
        'visual-center';

      center.dataset.visualCenter =
        'true';

      zones.insertBefore(
        center,
        zones.querySelector(
          '[data-zone="right"]'
        )
      );
    }

    this._lastVisualEntityId =
      String(visual?.entity_id || visual?.entity || '');

    const signature =
      this._visualSignature(
        visual
      );

    if (
      center.dataset.visualSignature ===
      signature
    ) {
      return;
    }

    const mediaSignature =
      this._visualMediaSignature(visual);
    const sameMedia =
      center.dataset.visualMediaSignature === mediaSignature;

    center.dataset.visualSignature =
      signature;
    center.dataset.visualMediaSignature =
      mediaSignature;

    center.dataset.visualType =
      visual.type;

    center.setAttribute(
      'aria-label',
      `Home Status visual: ${visual.type}`
    );

    center.onclick =
      visual.article_url
        ? event => {
            event.stopPropagation();

            window.open(
              visual.article_url,
              '_blank',
              'noopener,noreferrer'
            );
          }
        : null;

    // Presentation metadata can change without changing the underlying
    // media. Keep the existing media node/HLS instance alive and only refresh
    // the lightweight presentation state in that case.
    if (sameMedia) {
      this._syncVisualPresentation(
        center,
        visual
      );
      return;
    }

    this._renderVisualCenter(
      center,
      visual
    );
  }

  _syncDisplayedVisual() {
    // Off-screen media is deliberately suspended. Queue/source state can keep
    // updating in memory; the currently selected visual is rebuilt on resume.
    if (!this._ambientVisible) return;

    // Visual Center already has its own presentation control. It also needs a
    // visible main area to occupy; a ticker-only card must not grow a body just
    // because a visual source happens to be available.
    const hasMainArea =
      this._config.presentation_mode === 'visual' ||
      this._config.home_status_visibility.left ||
      this._config.home_status_visibility.right;

    const queuedVisual = this._queuedBaseVisual();
    const baseVisual = this._baseVisual;
    const priorityRank = visual => {
      const ranks = { critical: 0, attention: 1, activity: 2, normal: 3 };
      return ranks[String(visual?.priority || 'normal').toLowerCase()] ?? 3;
    };
    const baseBeatsQueue =
      queuedVisual && baseVisual && priorityRank(baseVisual) < priorityRank(queuedVisual);

    this._syncVisualCenter(
      this._mediaEnabled && hasMainArea
        ? (
          (baseBeatsQueue ? baseVisual : queuedVisual) ||
          baseVisual
        )
        : null
    );
  }

  _parseVisualEventDate(value) {
    if (!value) return null;

    // Date-only values are calendar dates, not UTC instants. Construct them
    // locally so "2026-08-17" cannot become Aug 16 on an EDT tablet.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = dateOnly
      ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
      : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  _formatVisualEventDate(startValue, endValue = '') {
    const start = this._parseVisualEventDate(startValue);
    if (!start) return '';
    const end = this._parseVisualEventDate(endValue);
    const format = value => new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric'
    }).format(value).toUpperCase();

    if (!end || start.toDateString() === end.toDateString()) {
      return format(start);
    }

    const sameMonth = start.getFullYear() === end.getFullYear() &&
      start.getMonth() === end.getMonth();
    if (sameMonth) {
      const month = new Intl.DateTimeFormat(undefined, { month: 'short' })
        .format(start)
        .toUpperCase();
      return `${month} ${start.getDate()}–${end.getDate()}`;
    }
    return `${format(start)}–${format(end)}`;
  }

  _syncVisualOverlay(center, visual) {
    const existing = center.querySelector(
      ':scope > .visual-center-overlay'
    );

    const isNews = visual.source_kind === 'news';
    const isEvent = Boolean(visual.title && visual.event_start);

    if (!visual.title || (!isNews && !isEvent)) {
      existing?.remove();
      center.classList.remove('has-visual-overlay');
      return;
    }

    const overlay = existing || document.createElement('span');
    overlay.className = 'visual-center-overlay';
    overlay.setAttribute('aria-hidden', 'true');

    if (isNews) {
      const sourceLabel = visual.source || 'News';
      overlay.innerHTML = `
        <span class="visual-center-news-badge">
          <ha-icon icon="mdi:newspaper"></ha-icon>
          <span>${this._escape(sourceLabel)}</span>
        </span>
        <span class="visual-center-event-title">
          ${this._escape(visual.title)}
        </span>
      `;
    } else {
      const dateLabel = this._formatVisualEventDate(
        visual.event_start,
        visual.event_end
      );

      if (!dateLabel) {
        existing?.remove();
        center.classList.remove('has-visual-overlay');
        return;
      }

      overlay.innerHTML = `
        <span class="visual-center-event-badge">
          <ha-icon icon="mdi:calendar-star"></ha-icon>
          <span>${this._escape(dateLabel)}</span>
        </span>
        <span class="visual-center-event-title">
          ${this._escape(visual.title)}
        </span>
      `;
    }

    if (!existing) center.append(overlay);
    center.classList.add('has-visual-overlay');
  }

  _syncVisualPresentation(center, visual) {
    this._syncVisualOverlay(center, visual);

    const media = center.querySelector(
      ':scope > .visual-center-media, :scope > .visual-center-camera'
    );

    if (media?.tagName === 'VIDEO') {
      media.muted = visual.mute;
      media.defaultMuted = visual.mute;
    } else if (media?.tagName === 'HA-CAMERA-STREAM') {
      media.stateObj = this._hass?.states?.[visual.entity_id];
    }
  }

  _renderVisualCenter(
    center,
    visual
  ) {
    const existing =
      center.querySelector(
        ':scope > .visual-center-media, :scope > .visual-center-camera, :scope > .visual-center-fallback'
      );

    if (
      visual.type === 'image'
    ) {
      this._destroyVisualHls(
        center
      );

      let image =
        existing?.tagName === 'IMG'
          ? existing
          : null;

      if (!image) {
        image = document.createElement('img');
        image.className = 'visual-center-media';
        image.alt = '';
        image.loading = 'eager';
        image.decoding = 'async';
        center.replaceChildren(image);
      }

      image.src = visual.url;
      this._syncVisualOverlay(center, visual);
      return;
    }

    this._syncVisualOverlay(center, visual);

    if (
      visual.type === 'video'
    ) {
      let video =
        existing?.tagName === 'VIDEO'
          ? existing
          : null;

      if (!video) {
        video =
          document.createElement(
            'video'
          );

        video.className =
          'visual-center-media';

        video.muted =
          visual.mute;

        video.defaultMuted =
          visual.mute;

        video.autoplay = true;
        video.playsInline = true;
        video.preload = 'metadata';

        center.replaceChildren(
          video
        );
      }

      this._renderVisualVideo(
        center,
        video,
        visual
      );

      return;
    }

    this._destroyVisualHls(
      center
    );

    if (
      visual.type === 'camera'
    ) {
      let camera =
        existing?.tagName ===
        'HA-CAMERA-STREAM'
          ? existing
          : null;

      if (!camera) {
        camera =
          document.createElement(
            'ha-camera-stream'
          );

        camera.className =
          'visual-center-camera';

        center.replaceChildren(
          camera
        );
      }

      camera.stateObj =
        this._hass?.states?.[
          visual.entity_id
        ];

      camera.fitMode =
        'cover';

      camera.muted = true;
      camera.controls = false;

      camera.setAttribute(
        'camera-entity',
        visual.entity_id
      );

      camera.setAttribute(
        'entity',
        visual.entity_id
      );

      return;
    }

    center.replaceChildren(
      Object.assign(
        document.createElement(
          'span'
        ),
        {
          className:
            'visual-center-fallback',

          textContent:
            'Visual content is not supported yet'
        }
      )
    );
  }

  _destroyVisualHls(center) {
    if (!center) return;

    // Invalidate any pending async HLS setup before destroying the active
    // instance. A stale loadHlsJs() promise must not attach after the visual
    // has already changed.
    center._homeStatusHlsGeneration =
      (center._homeStatusHlsGeneration || 0) + 1;

    const hls =
      center._homeStatusHls;

    if (hls) {
      hls.destroy();

      delete center
        ._homeStatusHls;
    }

    delete center
      ._homeStatusHlsUrl;
  }

  _showVisualError(
    center,
    message
  ) {
    this._destroyVisualHls(
      center
    );

    center.replaceChildren(
      Object.assign(
        document.createElement(
          'span'
        ),
        {
          className:
            'visual-center-fallback',

          textContent:
            message
        }
      )
    );
  }

  _renderVisualVideo(
    center,
    video,
    visual
  ) {
    const sameActiveHls =
      visual.transport === 'hls' &&
      center._homeStatusHls &&
      center._homeStatusHlsUrl === visual.url;

    video.muted =
      visual.mute;

    video.defaultMuted =
      visual.mute;

    if (sameActiveHls) {
      return;
    }

    this._destroyVisualHls(
      center
    );

    const hlsGeneration =
      center._homeStatusHlsGeneration || 0;

    const fail =
      () =>
        this._showVisualError(
          center,
          'Live stream unavailable'
        );

    video.onerror = fail;

    if (
      visual.transport !== 'hls'
    ) {
      if (
        video.getAttribute('src') !==
        visual.url
      ) {
        video.src =
          visual.url;
      }

      video.play()
        ?.catch?.(
          () => {}
        );

      return;
    }

    const nativeHls =
      video.canPlayType(
        'application/vnd.apple.mpegurl'
      ) ||
      video.canPlayType(
        'application/x-mpegURL'
      );

    if (nativeHls) {
      video.src =
        visual.url;

      video.play()
        ?.catch?.(
          () => {}
        );

      return;
    }

    loadHlsJs()
      .then(Hls => {
        if (
          !center.isConnected ||
          center.firstElementChild !==
          video ||
          center._homeStatusHlsGeneration !== hlsGeneration
        ) {
          return;
        }

        if (
          !Hls.isSupported()
        ) {
          fail();
          return;
        }

        const hls =
          new Hls({
            enableWorker: true,
            // Home Status shows a live awareness stream, not DVR playback.
            // Bound forward/back buffer growth so long-running wall tablets
            // do not retain the much larger HLS.js defaults indefinitely.
            maxBufferLength: 12,
            maxMaxBufferLength: 20,
            backBufferLength: 0,
            maxBufferSize: 20 * 1000 * 1000
          });

        center._homeStatusHls =
          hls;
        center._homeStatusHlsUrl =
          visual.url;

        hls.on(
          Hls.Events.ERROR,
          (_event, data) => {
            if (data.fatal) {
              this._showVisualError(
                center,
                'Live stream unavailable'
              );
            }
          }
        );

        hls.loadSource(
          visual.url
        );

        hls.attachMedia(
          video
        );

        hls.on(
          Hls.Events.MANIFEST_PARSED,
          () =>
            video.play()
              ?.catch?.(
                () => {}
              )
        );
      })
      .catch(fail);
  }

  _applyPresentationPreferences(
    data
  ) {
    const preferences =
      data?.presentation &&
      typeof data.presentation === 'object'
        ? data.presentation
        : {};

    this._presentationPreferences =
      preferences;

    const layout =
      preferences.layout &&
      typeof preferences.layout === 'object'
        ? preferences.layout
        : {};

    const emphasis =
      preferences.emphasis &&
      typeof preferences.emphasis === 'object'
        ? preferences.emphasis
        : {};

    const number =
      (value, fallback) =>
        Number.isFinite(
          Number(value)
        )
          ? Number(value)
          : fallback;

    const px =
      (name, value, fallback) =>
        this.style.setProperty(
          name,
          `${number(
            value,
            fallback
          )}px`
        );

    const leftTitle =
      number(
        layout.left_title_size,
        48
      );

    const rightTitle =
      number(
        layout.right_title_size,
        48
      );

    const bottomTitle =
      number(
        layout.bottom_title_size,
        26
      );

    const leftIcon =
      number(
        layout.left_icon_size,
        60
      );

    const rightIcon =
      number(
        layout.right_icon_size,
        60
      );

    const bottomIcon =
      number(
        layout.bottom_icon_size,
        38
      );

    const emphasized =
      emphasis.enabled !== false;

    const leftValue =
      emphasized
        ? number(
            emphasis.left_measurement_size,
            72
          )
        : leftTitle;

    const rightValue =
      emphasized
        ? number(
            emphasis.right_measurement_size,
            72
          )
        : rightTitle;

    const rightWeather =
      emphasized
        ? number(
            emphasis.right_weather_size,
            72
          )
        : rightTitle;

    const bottomValue =
      emphasized
        ? number(
            emphasis.bottom_measurement_size,
            38
          )
        : bottomTitle;

    px(
      '--hs-card-body-height',
      layout.card_body_height,
      380
    );

    px(
      '--hs-card-live-height',
      number(
        layout.card_body_height,
        380
      ) + 44,
      424
    );

    px(
      '--hs-main-row-height',
      layout.main_row_height,
      150
    );

    px(
      '--hs-bottom-height',
      layout.bottom_height,
      102
    );

    px(
      '--hs-left-title-size',
      leftTitle,
      23
    );

    px(
      '--hs-left-summary-size',
      number(layout.left_summary_size, 32),
      32
    );

    px(
      '--hs-left-icon-size',
      leftIcon,
      40
    );

    px(
      '--hs-right-title-size',
      rightTitle,
      23
    );

    px(
      '--hs-right-summary-size',
      number(layout.right_summary_size, 32),
      32
    );

    px(
      '--hs-right-icon-size',
      rightIcon,
      40
    );

    px(
      '--hs-bottom-title-size',
      bottomTitle,
      26
    );

    px(
      '--hs-bottom-summary-size',
      layout.bottom_summary_size,
      21
    );

    px(
      '--hs-bottom-icon-size',
      bottomIcon,
      38
    );

    px(
      '--hs-left-value-size',
      leftValue,
      64
    );

    px(
      '--hs-right-value-size',
      rightValue,
      48
    );

    px(
      '--hs-right-weather-size',
      rightWeather,
      44
    );

    px(
      '--hs-bottom-value-size',
      bottomValue,
      38
    );

    px(
      '--hs-left-value-icon-size',
      Math.max(
        leftIcon,
        Math.round(
          leftValue * 0.875
        )
      ),
      56
    );

    px(
      '--hs-right-value-icon-size',
      Math.max(
        rightIcon,
        Math.round(
          rightValue * 0.92
        )
      ),
      44
    );

    if (
      !this._config?.sizing
        ?.max_width
    ) {
      const maxWidth =
        number(
          layout.card_max_width,
          0
        );

      this.style.maxWidth =
        maxWidth
          ? `${maxWidth}px`
          : this._config?.profile ===
              'phone'
            ? '600px'
            : '';
    }
  }

  _iconStyle(item) {
    const appearance =
      this._presentationPreferences
        ?.appearance;

    if (
      !appearance ||
      appearance.semantic_colors ===
        false
    ) {
      return '';
    }

    const key =
      String(
        item?.color_role || ''
      );

    const color =
      key
        ? appearance.colors?.[key]
        : '';

    return color
      ? ` style="color:${this._escape(color)}"`
      : '';
  }

  _label(item) {
    return String(
      item?.display_name ||
      item?.title ||
      item?.message ||
      'Home notification'
    ).trim();
  }

  _footerFilters(data) {
    const filters =
      data?.display
        ?.footer_filters;

    return (
      filters &&
      typeof filters === 'object'
    )
      ? filters
      : {};
  }

  _safeExternalUrl(value) {
    if (typeof value !== 'string') return '';
    const candidate = value.trim();
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate, window.location.href);
      return ['http:', 'https:'].includes(parsed.protocol)
        ? parsed.href
        : '';
    } catch (_error) {
      return '';
    }
  }

  _safeMediaUrl(value) {
    if (typeof value !== 'string') return '';
    const candidate = value.trim();
    if (!candidate) return '';
    try {
      const parsed = new URL(candidate, window.location.href);
      return ['http:', 'https:'].includes(parsed.protocol)
        ? parsed.href
        : '';
    } catch (_error) {
      return '';
    }
  }

  _escape(value) {
    const node =
      document.createElement(
        'span'
      );

    node.textContent =
      String(value ?? '');

    return node.innerHTML;
  }

  _icon(priority) {
    return (
      {
        critical:
          'mdi:alert-circle',

        attention:
          'mdi:alert',

        activity:
          'mdi:information',

        normal:
          'mdi:check-circle'
      }[priority] ||
      'mdi:home-heart'
    );
  }

  _color(category) {
    return (
      {
        security:
          '#ef5350',

        weather:
          '#42a5f5',

        hvac:
          '#ff9800',

        appliance:
          '#66bb6a',

        laundry:
          '#66bb6a',

        media:
          '#ab47bc',

        irrigation:
          '#26c6da'
      }[
        String(
          category || ''
        ).toLowerCase()
      ] ||
      '#90a4ae'
    );
  }

  _iconSemanticClass(item) {
    if (
      this._presentationPreferences
        ?.appearance
        ?.semantic_colors === false
    ) {
      return 'semantic-white';
    }

    const classes = {
      critical:
        'semantic-red',

      security:
        'semantic-red',

      attention:
        'semantic-orange',

      success:
        'semantic-green',

      moisture:
        'semantic-cyan',

      weather:
        'semantic-sky',

      recycling:
        'semantic-teal',

      waste:
        'semantic-green',

      irrigation:
        'semantic-teal',

      schedule:
        'semantic-purple',

      calendar:
        'semantic-purple',

      traffic:
        'semantic-amber',

      energy:
        'semantic-yellow',

      climate:
        'semantic-blue',

      appliance:
        'semantic-lime',

      laundry_running:
        'semantic-lime',

      news:
        'semantic-blue',

      media:
        'semantic-purple'
    };

    return (
      classes[
        String(
          item?.color_role || ''
        )
      ] ||
      'semantic-white'
    );
  }

  _timestamp(item, active) {
    return this._date(
      item?.occurred_at ||
      item?.created_at ||
      item?.updated_at ||
      item?.timestamp
    );
  }

  _timestampValue(item) {
    return (
      item?.occurred_at ||
      item?.created_at ||
      item?.updated_at ||
      item?.timestamp ||
      ''
    );
  }

  _showsRelativeAge(item) {
    return (
      item?.timestamp_mode ===
      'relative'
    );
  }

  _streamAsTicker(
    item,
    fallback = 'No new information'
  ) {
    if (!item) {
      return {
        id:
          `empty:${fallback}`,

        message:
          fallback,

        secondary:
          '',

        detail:
          '',

        priority:
          'normal',

        category:
          'Home Status'
      };
    }

    const title =
      item.title ||
      item.message ||
      'Home Status';

    let summary =
      String(
        item.body ||
        item.summary ||
        item.secondary ||
        ''
      ).trim();

    if (item.expires_at) {
      summary =
        [
          summary,
          `Until ${this._formatDateTime(item.expires_at)}`
        ].filter(Boolean).join(' • ');
    }

    return {
      id:
        item.id,

      message:
        title,

      subtitle:
        item.subtitle || '',

      body:
        item.body ||
        summary,

      secondary:
        summary,

      detail:
        item.detail || '',

      priority:
        item.priority ||
        'normal',

      category:
        item.category ||
        'Home Status',

      color_role:
        item.color_role || '',

      display_kind:
        item.display_kind || '',

      timestamp_mode:
        item.timestamp_mode || '',


      utility_role:
        item.utility_role || '',

      visual:
        item.visual || null,

      zone_visual:
        item.zone_visual || null,

      source:
        item.source,

      source_kind:
        item.source_kind,

      _category:
        item._category,

      entity_id:
        item.entity_id,

      group_labels:
        item.group_labels,

      event_type:
        item.event_type,

      active:
        item.active,

      state:
        item.state,

      created_at:
        item.created_at,

      updated_at:
        item.updated_at,

      occurred_at:
        item.occurred_at,

      resolved_at:
        item.resolved_at,

      scheduled_at:
        item.scheduled_at,

      all_day:
        item.all_day === true,

      expires_at:
        item.expires_at,

      timestamp:
        item.timestamp,

      source_id:
        item.source_id,

      source_name:
        item.source_name,

      home_device_id:
        item.home_device_id,

      device_id:
        item.device_id,

      history_target:
        item.history_target,

      home_device_name:
        item.home_device_name,

      entity_name:
        item.entity_name,

      navigation:
        item.action ||
        item.navigation,

      icon:
        item.icon,

      media_url:
        item.media_url ||
        item.media?.url ||
        item.image_url ||
        '',

      media_type:
        item.media_type ||
        item.media?.type ||
        (
          item.image_url
            ? 'image'
            : ''
        ),

      visual_effect:
        item.visual_effect ||
        ''
    };
  }

  _heroMedia(item) {
    if (!this._mediaEnabled) {
      return null;
    }

    const url =
      String(
        item?.media_url ||
        item?.media?.url ||
        item?.image_url ||
        ''
      ).trim();

    const type =
      String(
        item?.media_type ||
        item?.media?.type ||
        (
          url
            ? 'image'
            : ''
        )
      ).toLowerCase();

    return url
      ? {
          url,
          type:
            type || 'image'
        }
      : null;
  }

  _formatDateTime(value) {
    const date =
      this._date(value);

    return date
      ? date.toLocaleString(
          [],
          {
            weekday:
              'short',

            hour:
              'numeric',

            minute:
              '2-digit'
          }
        )
      : String(
          value || ''
        );
  }

  _headerClimateOwnsItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (this._config?.utility_header?.enabled === false) return false;

    const category = String(item.category || '').toLowerCase();
    const displayKind = String(item.display_kind || '').toLowerCase();
    const deviceClass = String(item.device_class || '').toLowerCase();

    if (displayKind === 'current_weather') return true;

    return (
      category === 'climate' &&
      (
        displayKind === 'temperature' ||
        displayKind === 'indoor_temperature' ||
        displayKind === 'measurement' ||
        deviceClass === 'temperature' ||
        deviceClass === 'humidity'
      )
    );
  }

  _sideLaneEligible(item) {
    if (!item || typeof item !== 'object') return false;

    const sourceKind = String(item.source_kind || '').toLowerCase();
    const category = String(item.category || '').toLowerCase();
    const displayKind = String(item.display_kind || '').toLowerCase();

    // News belongs to its existing awareness/media paths. Climate facts owned
    // by the utility header are also removed here so one presentation surface
    // has authority for them instead of duplicating the same fact in a lane.
    return !(
      sourceKind === 'news' ||
      sourceKind === 'live_news' ||
      category === 'news' ||
      category === 'live_news' ||
      displayKind === 'local_news' ||
      displayKind === 'live_news' ||
      this._headerClimateOwnsItem(item)
    );
  }

  _activeClaimItems(data) {
    const active = Array.isArray(data?.active) ? data.active : [];
    const seen = new Set();

    return active.filter(item => {
      if (!item || item.active === false) return false;
      if (item.rotate_with_awareness === true) return false;
      if (!this._sideLaneEligible(item)) return false;

      const id = this._laneItemId(item);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  _visiblePhysicalSlots() {
    const showLeft = this._config.home_status_visibility.left;
    const showRight = this._config.home_status_visibility.right;

    if (showLeft && showRight) {
      return [
        ['left', 0], ['right', 0],
        ['left', 1], ['right', 1],
        ['left', 2], ['right', 2]
      ];
    }

    if (showLeft) return [['left', 0], ['left', 1], ['left', 2]];
    if (showRight) return [['right', 0], ['right', 1], ['right', 2]];
    return [];
  }

  _physicalSlotKey(zone, slotIndex) {
    return `${zone}:${slotIndex}`;
  }

  _laneSlotPools(data) {
    const physicalSlots = this._visiblePhysicalSlots();
    const pools = {
      left: [[], [], []],
      right: [[], [], []]
    };

    if (!physicalSlots.length) {
      this._activeSlotClaims.clear();
      return pools;
    }

    // AIC consumes the backend-ranked active list. Only the highest-ranked
    // claims that can physically fit are selected. Existing selected claims
    // keep their exact slots; resolved or displaced claims simply release the
    // slot instead of causing the other active items to compact and jump.
    const activeClaims = this._activeClaimItems(data);
    const selectedClaims = activeClaims.slice(0, physicalSlots.length);
    const selectedById = new Map(
      selectedClaims.map(item => [this._laneItemId(item), item])
    );
    const nextClaims = new Map();
    const assignedIds = new Set();

    physicalSlots.forEach(([zone, slotIndex]) => {
      const key = this._physicalSlotKey(zone, slotIndex);
      const previousId = this._activeSlotClaims.get(key);
      if (!previousId || !selectedById.has(previousId) || assignedIds.has(previousId)) return;

      nextClaims.set(key, previousId);
      assignedIds.add(previousId);
    });

    selectedClaims.forEach(item => {
      const id = this._laneItemId(item);
      if (!id || assignedIds.has(id)) return;

      const freeSlot = physicalSlots.find(([zone, slotIndex]) => {
        const key = this._physicalSlotKey(zone, slotIndex);
        return !nextClaims.has(key);
      });
      if (!freeSlot) return;

      const [zone, slotIndex] = freeSlot;
      nextClaims.set(this._physicalSlotKey(zone, slotIndex), id);
      assignedIds.add(id);
    });

    this._activeSlotClaims = nextClaims;

    physicalSlots.forEach(([zone, slotIndex]) => {
      const id = nextClaims.get(this._physicalSlotKey(zone, slotIndex));
      const item = id ? selectedById.get(id) : null;
      if (item) pools[zone][slotIndex] = [item];
    });

    // Normal information fills only unclaimed physical slots. The candidate
    // stream remains backend-ranked, but physical placement is entirely owned
    // by this allocator. Round-robin overflow therefore belongs to the exact
    // free slot it maps to and rotates independently there.
    const claimedActiveIds = new Set(
      activeClaims.map(item => this._laneItemId(item)).filter(Boolean)
    );
    let normalCandidates = Array.isArray(data?.side)
      ? data.side.filter(item => this._sideLaneEligible(item))
      : [];

    const seen = new Set();
    normalCandidates = normalCandidates.filter(item => {
      const id = this._laneItemId(item);
      if (!id || claimedActiveIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    const freeSlots = physicalSlots.filter(([zone, slotIndex]) =>
      !nextClaims.has(this._physicalSlotKey(zone, slotIndex))
    );

    if (freeSlots.length) {
      // Keep coordinated lane movement while each physical row remains its own
      // controller. Normal candidates are assigned across
      // the free physical slots in display order, but each contiguous run of
      // unclaimed rows becomes one coordinated sequence. Every slot in that run
      // receives the same sequence at a different starting offset, so a shared
      // cycle produces A/B/C -> B/C/D -> C/D/E while each physical row remains
      // an independent controller. AIC claims naturally split a lane into
      // smaller independently coordinated segments.
      const freeByZone = { left: [], right: [] };
      freeSlots.forEach(([zone, slotIndex]) => freeByZone[zone].push(slotIndex));

      const segments = [];
      const slotToSegment = new Map();

      ['left', 'right'].forEach(zone => {
        const indexes = [...freeByZone[zone]].sort((a, b) => a - b);
        let current = [];

        indexes.forEach(slotIndex => {
          if (!current.length || slotIndex === current[current.length - 1] + 1) {
            current.push(slotIndex);
          } else {
            segments.push({ zone, slots: current });
            current = [slotIndex];
          }
        });

        if (current.length) segments.push({ zone, slots: current });
      });

      segments.forEach((segment, segmentIndex) => {
        segment.id = `${segment.zone}:${segmentIndex}`;
        segment.items = [];
        segment.slots.forEach(slotIndex => {
          slotToSegment.set(this._physicalSlotKey(segment.zone, slotIndex), segment);
        });
      });

      const assignedBySlot = new Map();
      normalCandidates.forEach((item, index) => {
        const [zone, slotIndex] = freeSlots[index % freeSlots.length];
        const key = this._physicalSlotKey(zone, slotIndex);
        const assigned = assignedBySlot.get(key) || [];
        assigned.push(item);
        assignedBySlot.set(key, assigned);

        const segment = slotToSegment.get(key);
        if (segment) segment.items.push(item);
      });

      segments.forEach(segment => {
        const occupiedSlots = segment.slots.filter(slotIndex => {
          const key = this._physicalSlotKey(segment.zone, slotIndex);
          return (assignedBySlot.get(key) || []).length > 0;
        });

        if (!occupiedSlots.length) return;

        // With no overflow there is nothing to advance into view. Keep each
        // occupied row static instead of pointlessly cycling the same visible
        // set through different positions.
        if (segment.items.length <= occupiedSlots.length) {
          occupiedSlots.forEach(slotIndex => {
            const key = this._physicalSlotKey(segment.zone, slotIndex);
            const item = (assignedBySlot.get(key) || [])[0];
            if (item) pools[segment.zone][slotIndex] = [item];
          });
          return;
        }

        occupiedSlots.forEach((slotIndex, offset) => {
          const sequence = segment.items;
          pools[segment.zone][slotIndex] = [
            ...sequence.slice(offset),
            ...sequence.slice(0, offset)
          ];
        });
      });
    }

    return pools;
  }

  _buildFooterStream(data) {
    if (
      !this._config
        .home_status_visibility
        .bottom
    ) {
      return [];
    }

    return (
      Array.isArray(data.bottom)
        ? data.bottom
        : []
    ).map(
      item => ({
        ...this._streamAsTicker(
          item,
          'Status update'
        ),

        _category:
          this._categoryFor(
            item
          )
      })
    );
  }

  _phoneStatusItem(data) {
    return data?.phone_primary || {
      id: 'phone-status-unavailable',
      message: 'Home Status unavailable',
      summary: '',
      icon: 'mdi:alert-circle-outline',
      priority: 'attention',
      color_role: 'attention',
      active: false
    };
  }

  _phoneStatusMarkup(data) {
    const item =
      this._phoneStatusItem(
        data
      );

    const title =
      this._label(item);

    const summary =
      item.summary ||
      item.secondary ||
      'Tap for details';

    const navigation =
      String(
        item.navigation ||
        item.action ||
        ''
      );

    const entity =
      String(
        item.entity_id ||
        item.entity ||
        ''
      );

    const footerStream =
      this._buildFooterStream(
        data
      );

    const phoneTickerItems =
      footerStream.length
        ? footerStream
        : [
            {
              id:
                'phone-no-updates',

              message:
                'No recent updates',

              summary:
                'Home is quiet',

              icon:
                'mdi:home-heart'
            }
          ];

    const tickerText =
      phoneTickerItems
        .map(
          footerItem =>
            this._label(
              footerItem
            )
        )
        .filter(Boolean)
        .join(' • ');

    const renderPhoneTickerSequence =
      () =>
        phoneTickerItems
          .map(
            footerItem => {
              const display =
                this._formatFooterItem(
                  footerItem
                );

              const relative =
                display.relativeStamp
                  ? this._relative(
                      display.relativeStamp
                    )
                  : '';

              const secondary =
                display.summary ||
                relative
                  ? `<small>${display.summary ? this._escape(display.summary) : ''}${display.summary && relative ? ' • ' : ''}${relative ? this._escape(relative) : ''}</small>`
                  : '';

              return `<span class="phone-status-ticker-item" data-stream-id="${this._escape(footerItem.id || '')}" data-stream-navigation="${this._escape(footerItem.navigation || '')}" data-stream-entity="${this._escape(footerItem.entity_id || '')}" data-stream-device="${this._escape(footerItem.device_id || '')}" data-stream-history-target="${this._escape(footerItem.history_target || 'entity')}"><ha-icon class="${this._iconSemanticClass(footerItem)}" icon="${this._escape(display.icon)}"${this._iconStyle(footerItem)}></ha-icon><span class="phone-status-ticker-copy"><strong>${this._escape(display.title)}</strong>${secondary}</span></span>`;
            }
          )
          .join('');

    const phoneTickerSequence =
      renderPhoneTickerSequence();

    const actionable =
      navigation ||
      entity;

    return `<section class="phone-status-shell" aria-label="Current home status">
      <button class="phone-status-current priority-${this._escape(item.priority || 'normal')}${actionable ? ' is-actionable' : ''}" type="button" data-stream-navigation="${this._escape(navigation)}" data-stream-entity="${this._escape(entity)}"${actionable ? '' : ' disabled'}>
        <span class="phone-status-icon"><ha-icon class="${this._iconSemanticClass(item)}" icon="${this._escape(item.icon || 'mdi:home-heart')}"${this._iconStyle(item)}></ha-icon></span>
        <span class="phone-status-copy"><small>Home Status</small><strong>${this._escape(title)}</strong><span>${this._escape(summary)}</span></span>
        ${actionable ? '<ha-icon class="phone-status-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}
      </button>
      ${this._config.home_status_visibility.phone_ticker ? `<div class="phone-status-ticker" aria-label="${this._escape(tickerText)}">
        <div class="phone-status-ticker-track"><div class="phone-status-ticker-sequence">${phoneTickerSequence}</div><div class="phone-status-ticker-sequence" aria-hidden="true">${phoneTickerSequence}</div></div>
      </div>` : ''}
    </section>`;
  }

  _renderPhoneStatus(data) {
    const host =
      this.shadowRoot?.querySelector(
        '[data-phone-status-host]'
      );

    if (!host) return;

    const markup =
      this._phoneStatusMarkup(
        data
      );

    if (
      host.dataset.signature ===
      markup
    ) {
      return;
    }

    host.dataset.signature =
      markup;

    host.innerHTML =
      markup;

    this._bindStreamItems();
  }

  _formatFooterItem(item) {
    const category =
      item._category ||
      this._categoryFor(
        item
      );

    const displayKind =
      String(
        item?.display_kind ||
        ''
      ).toLowerCase();

    let title =
      this._glanceableMeasurementTitle(
        this._label(item)
      );

    let summary =
      String(
        item.summary ||
        item.secondary ||
        ''
      ).trim();

    let icon =
      item.icon ||
      'mdi:information-outline';

    const currentWeather =
      displayKind ===
      'current_weather';

    const indoorTemperature =
      displayKind ===
        'indoor_temperature';

    const weatherAlert =
      displayKind ===
      'weather_alert';

    if (currentWeather) {
      title =
        this._glanceableTemperature(
          title ||
          item.summary ||
          ''
        );

      summary =
        this._friendlyWeatherCondition(
          item.state ||
          item.summary ||
          ''
        );
    } else if (
      indoorTemperature
    ) {
      title =
        this._glanceableTemperature(
          title ||
          summary
        );
    }

    const scheduled =
      item.scheduled_at
        ? this._friendlyScheduled(
            item.scheduled_at,
            item.all_day === true
          )
        : '';

    if (scheduled) {
      summary =
        [
          item.source_name ||
            summary,
          scheduled
        ]
          .filter(Boolean)
          .join(' · ');
    }

    const relativeStamp =
      !currentWeather &&
      !indoorTemperature &&
      this._showsRelativeAge(
        item
      )
        ? this._timestampValue(
            item
          )
        : '';

    if (weatherAlert) {
      summary =
        item.expires_at
          ? `Until ${this._formatDateTime(item.expires_at)}`
          : summary;
    }

    if (
      relativeStamp &&
      String(summary)
        .trim()
        .toLowerCase() ===
      String(title)
        .trim()
        .toLowerCase()
    ) {
      summary = '';
    }

    return {
      title:
        String(title)
          .replace(
            /\s+/g,
            ' '
          )
          .trim()
          .slice(0, 60),

      summary:
        String(summary)
          .replace(
            /\s+/g,
            ' '
          )
          .trim()
          .slice(0, 48),

      icon,

      relativeStamp,

      currentWeather,

      indoorTemperature
    };
  }

  _refreshFooterRelativeTimes() {
    this.shadowRoot
      .querySelectorAll(
        '[data-footer-time]'
      )
      .forEach(
        element => {
          element.textContent =
            this._relative(
              element.dataset.footerTime
            );
        }
      );
  }

  _renderFooterStream(items) {
    const target =
      this.shadowRoot.querySelector(
        '.bottom-stream'
      );

    if (!target) return;

    const signatureParts =
      items.map(
        (
          item,
          index
        ) => {
          const display =
            this._formatFooterItem(
              item
            );

          return {
            index,

            item:
              item.id ||
              item.entity_id ||
              item.message ||
              `index:${index}`,

            title:
              display.title,

            summary:
              display.summary,

            icon:
              display.icon,

            value:
              `${index}|${display.title}|${display.summary}|${display.icon}|${display.relativeStamp}`
          };
        }
      );

    const signature =
      signatureParts
        .map(
          part =>
            part.value
        )
        .join('||');

    if (
      signature ===
      this._footerSignature &&
      target.querySelector('.footer-marquee')
    ) {
      this._refreshFooterRelativeTimes();
      return;
    }

    const previousPhase =
      this._footerMarqueePhase(
        target
      );

    this._footerSignature =
      signature;

    this._footerSignatureParts =
      signatureParts;

    if (
      this._footerResizeObserver
    ) {
      this._footerResizeObserver.disconnect();
      this._footerResizeObserver = null;
    }

    const renderSequence =
      () =>
        items
          .map(
            (
              item,
              index
            ) => {
              const display =
                this._formatFooterItem(
                  item
                );

              const relative =
                display.relativeStamp
                  ? this._relative(
                      display.relativeStamp
                    )
                  : '';

              const secondary =
                display.summary ||
                relative
                  ? `<small>${display.summary ? this._escape(display.summary) : ''}${display.summary && relative ? ' • ' : ''}${relative ? `<span data-footer-time="${this._escape(display.relativeStamp)}">${this._escape(relative)}</span>` : ''}</small>`
                  : '';

              const groupLabels =
                Array.isArray(
                  item.group_labels
                ) &&
                item.group_labels.length >
                  1
                  ? ` data-footer-group-labels="${encodeURIComponent(JSON.stringify(item.group_labels))}" data-footer-group-title="${encodeURIComponent(display.title)}"`
                  : '';

              return `<span class="footer-marquee-item${display.currentWeather ? ' is-current-weather' : ''}${display.indoorTemperature ? ' is-indoor-temperature' : ''}"><span data-stream-id="${this._escape(item.id || '')}" data-stream-navigation="${this._escape(item.navigation || '')}" data-stream-entity="${this._escape(item.entity_id || '')}" data-stream-device="${this._escape(item.device_id || '')}" data-stream-history-target="${this._escape(item.history_target || 'entity')}"${groupLabels}><ha-icon class="${this._iconSemanticClass(item)}" icon="${this._escape(display.icon)}"${this._iconStyle(item)}></ha-icon><span class="footer-marquee-copy"><strong>${this._escape(display.title)}</strong>${secondary}</span></span></span>`;
            }
          )
          .join('');

    const sequence =
      items.length
        ? renderSequence()
        : '';

    const singleItem =
      items.length === 1;

    target.innerHTML =
      sequence
        ? singleItem
          ? `<div class="footer-marquee single-item"><div class="footer-marquee-track"><div class="footer-sequence">${sequence}</div></div></div>`
          : `<div class="footer-marquee"><div class="footer-marquee-track"><div class="footer-sequence">${sequence}</div><div class="footer-sequence" aria-hidden="true">${sequence}</div></div></div>`
        : '';

    const trackElement =
      target.querySelector(
        '.footer-marquee-track'
      );

    const firstSequence =
      target.querySelector(
        '.footer-sequence'
      );

    if (
      !singleItem &&
      trackElement &&
      firstSequence
    ) {
      const metrics =
        this._updateFooterMarqueeMetrics(
          target
        );

      if (
        previousPhase !== null &&
        metrics
      ) {
        trackElement.style.animationDelay =
          `-${previousPhase * metrics.duration}s`;
      }

      if (
        typeof ResizeObserver !==
        'undefined'
      ) {
        this._footerResizeObserver =
          new ResizeObserver(
            () => {
              this._updateFooterMarqueeMetrics(
                target
              );
            }
          );

        this._footerResizeObserver.observe(
          firstSequence
        );
      }
    }

    this._refreshFooterRelativeTimes();
    this._bindStreamItems();
  }

  _footerMarqueePhase(target) {
    const track =
      target?.querySelector(
        '.footer-marquee-track'
      );

    const sequence =
      target?.querySelector(
        '.footer-sequence'
      );

    if (
      !track ||
      !sequence
    ) {
      return null;
    }

    const distance =
      sequence
        .getBoundingClientRect()
        .width;

    const transform =
      getComputedStyle(
        track
      ).transform;

    const match =
      /^matrix\([^,]+,[^,]+,[^,]+,[^,]+,([^,]+),/
        .exec(transform);

    const offset =
      match
        ? Number(match[1])
        : NaN;

    if (
      !Number.isFinite(
        distance
      ) ||
      distance <= 0 ||
      !Number.isFinite(
        offset
      )
    ) {
      return null;
    }

    return (
      (
        (
          -offset %
          distance
        ) +
        distance
      ) %
      distance
    ) /
    distance;
  }

  _updateFooterMarqueeMetrics(
    target
  ) {
    const track =
      target?.querySelector(
        '.footer-marquee-track'
      );

    const firstSequence =
      target?.querySelector(
        '.footer-sequence'
      );

    if (
      !track ||
      !firstSequence
    ) {
      return;
    }

    const distance =
      firstSequence
        .getBoundingClientRect()
        .width;

    if (
      !Number.isFinite(
        distance
      ) ||
      distance <= 0
    ) {
      return;
    }

    const duration =
      Math.max(
        8,
        distance /
        this._config.bottom_speed
      );

    track.style.setProperty(
      '--marquee-distance',
      `${distance}px`
    );

    track.style.setProperty(
      '--marquee-duration',
      `${duration}s`
    );

    return {
      distance,
      duration
    };
  }

  _categoryFor(item) {
    return String(
      item?.category ||
      'activity'
    ).toLowerCase();
  }

  _zoneMarkup(
    item,
    emptyLabel
  ) {
    if (!item) {
      return `<span class="zone-item zone-empty">${this._escape(emptyLabel)}</span>`;
    }

    let title =
      this._glanceableMeasurementTitle(
        this._label(item)
      );

    let summary =
      String(
        item.summary ||
        item.secondary ||
        ''
      ).trim();

    const category =
      this._categoryFor(
        item
      );

    const displayKind =
      String(
        item?.display_kind ||
        ''
      ).toLowerCase();

    const currentWeather =
      displayKind ===
      'current_weather';

    const indoorTemperature =
      displayKind ===
        'indoor_temperature';

    if (currentWeather) {
      title =
        this._glanceableTemperature(
          title
        );

      summary =
        this._friendlyWeatherCondition(
          summary ||
          item.state ||
          ''
        );
    } else if (
      indoorTemperature
    ) {
      title =
        this._glanceableTemperature(
          title ||
          summary
        );
    }

    const scheduled =
      item.scheduled_at
        ? this._friendlyScheduled(
            item.scheduled_at,
            item.all_day === true
          )
        : '';

    if (scheduled) {
      summary =
        [
          item.source_name ||
            summary,
          scheduled
        ]
          .filter(Boolean)
          .join(' · ');
    }

    const relative =
      !currentWeather &&
      !indoorTemperature &&
      this._showsRelativeAge(
        item
      )
        ? this._relative(
            this._timestampValue(
              item
            )
          )
        : '';

    if (
      relative &&
      String(summary)
        .trim()
        .toLowerCase() ===
      String(title)
        .trim()
        .toLowerCase()
    ) {
      summary = '';
    }

    if (relative) {
      summary =
        [
          summary,
          relative
        ]
          .filter(Boolean)
          .join(' — ');
    }

    const brief =
      `${title} ${summary}`
        .trim()
        .length <= 42;

    const measurementValue =
      /^-?\d+(?:\.\d+)?(?:%|°[CF])$/i
        .test(
          String(title).trim()
        );

    const media =
      (item?.zone_visual || item?.visual)
        ? null
        : this._heroMedia(
            item
          );

    const mediaMarkup =
      media
        ? `<span class="hero-media-wrap"><img class="hero-media" src="${this._escape(media.url)}" alt="" loading="lazy" decoding="async" data-hero-media="true">${media.type.startsWith('video') ? '<span class="hero-media-play"><ha-icon icon="mdi:play"></ha-icon></span>' : ''}<span class="hero-media-overlay"></span></span>`
        : '';

    const content =
      `<span class="hero-content"><span class="zone-title"><ha-icon class="${this._iconSemanticClass(item)}" icon="${this._escape(item.icon || 'mdi:information-outline')}"${this._iconStyle(item)}></ha-icon><span>${this._escape(title)}</span></span><span class="zone-summary">${this._escape(summary)}</span></span>`;

    return `<span class="zone-item hero-zone-item${media ? ' has-hero-media' : ''}${brief ? ' is-brief' : ''}${currentWeather ? ' is-current-weather' : ''}${indoorTemperature ? ' is-indoor-temperature' : ''}${measurementValue ? ' is-measurement' : ''}${scheduled ? ' is-scheduled' : ''} priority-${this._escape(item.priority || 'normal')}" data-stream-id="${this._escape(item.id || '')}" data-stream-navigation="${this._escape(item.navigation || '')}" data-stream-entity="${this._escape(item.entity_id || '')}">${mediaMarkup}${content}</span>`;
  }

  _glanceableMeasurementTitle(
    value
  ) {
    const text =
      String(value || '').trim();

    return text.replace(
      /^(Humidity|Temperature):\s*(-?\d+(?:\.\d+)?)(%|°?[CF])$/i,
      (
        _match,
        _label,
        number,
        unit
      ) => {
        const rounded =
          Math.round(
            Number(number)
          );

        return `${rounded}${unit}`;
      }
    );
  }

  _glanceableTemperature(
    value
  ) {
    const text =
      String(value || '').trim();

    const match =
      text.match(
        /^(-?\d+(?:\.\d+)?)\s*°?\s*[CF]?$/i
      );

    return match
      ? `${Math.round(Number(match[1]))}°`
      : text;
  }

  _friendlyWeatherCondition(
    value
  ) {
    const condition =
      String(value || '')
        .trim()
        .toLowerCase();

    const labels = {
      'clear-night':
        'Clear night',

      cloudy:
        'Cloudy',

      fog:
        'Foggy',

      hail:
        'Hail',

      lightning:
        'Lightning',

      'lightning-rainy':
        'Thunderstorms',

      partlycloudy:
        'Partly cloudy',

      pouring:
        'Heavy rain',

      rainy:
        'Rainy',

      snowy:
        'Snowy',

      'snowy-rainy':
        'Wintry mix',

      sunny:
        'Sunny',

      windy:
        'Windy',

      'windy-variant':
        'Windy',

      exceptional:
        'Exceptional weather'
    };

    return (
      labels[condition] ||
      condition
        .replace(
          /[-_]+/g,
          ' '
        )
        .replace(
          /^./,
          character =>
            character.toUpperCase()
        )
    );
  }

  _laneItemId(item) {
    return item?.id || item?.entity_id || item?.message || null;
  }

  _laneItemMarkup(item) {
    if (!item) return '';

    let title = this._glanceableMeasurementTitle(this._label(item));
    let summary = String(item.summary || item.secondary || '').trim();
    const displayKind = String(item?.display_kind || '').toLowerCase();
    const currentWeather = displayKind === 'current_weather';
    const indoorTemperature = displayKind === 'indoor_temperature';

    if (currentWeather) {
      title = this._glanceableTemperature(title);
      summary = this._friendlyWeatherCondition(summary || item.state || '');
    } else if (indoorTemperature) {
      title = this._glanceableTemperature(title || summary);
    }

    const scheduled = item.scheduled_at
      ? this._friendlyScheduled(item.scheduled_at, item.all_day === true)
      : '';

    if (scheduled) {
      summary = [item.source_name || summary, scheduled].filter(Boolean).join(' · ');
    }

    const relative = !currentWeather && !indoorTemperature && this._showsRelativeAge(item)
      ? this._relative(this._timestampValue(item))
      : '';

    if (relative && String(summary).trim().toLowerCase() === String(title).trim().toLowerCase()) {
      summary = '';
    }

    if (relative) {
      summary = [summary, relative].filter(Boolean).join(' — ');
    }

    const priority = String(item.priority || 'normal').toLowerCase();
    const measurementValue = /^-?\d+(?:\.\d+)?(?:%|°[CF]?)$/i.test(String(title).trim());
    const nav = this._escape(item.navigation || '');
    const entity = this._escape(item.entity_id || '');
    const id = this._escape(item.id || '');

    return `<span class="zone-item lane-item${currentWeather ? ' is-current-weather' : ''}${indoorTemperature ? ' is-indoor-temperature' : ''}${measurementValue ? ' is-measurement' : ''}${scheduled ? ' is-scheduled' : ''} priority-${this._escape(priority)}" data-stream-id="${id}" data-stream-navigation="${nav}" data-stream-entity="${entity}">
      <span class="lane-icon"><ha-icon class="${this._iconSemanticClass(item)}" icon="${this._escape(item.icon || 'mdi:information-outline')}"${this._iconStyle(item)}></ha-icon></span>
      <span class="lane-copy">
        <span class="lane-title">${this._escape(title)}</span>
        ${summary ? `<span class="lane-summary">${this._escape(summary)}</span>` : ''}
      </span>
    </span>`;
  }

  _ensureLaneSlots(zone) {
    const target = this.shadowRoot.querySelector(`[data-zone="${zone}"]`);
    if (!target) return null;

    let lane = target.querySelector('.zone-lane[data-slot-engine="true"]');
    if (lane && lane.querySelectorAll(':scope > .lane-slot').length === 3) return lane;

    target.innerHTML = `<span class="zone-lane-viewport"><span class="zone-lane" data-slot-engine="true">${
      Array.from({ length: 3 }, (_, index) =>
        `<span class="lane-slot" data-lane-slot="${index}"><span class="lane-slot-track"></span></span>`
      ).join('')
    }</span></span>`;

    return target.querySelector('.zone-lane[data-slot-engine="true"]');
  }

  _renderLaneSlot(zone, slotIndex, item, emptyLabel, laneEmpty = false) {
    const lane = this._ensureLaneSlots(zone);
    const slot = lane?.querySelector(`[data-lane-slot="${slotIndex}"]`);
    if (!slot) return;

    const content = item
      ? this._laneItemMarkup(item)
      : laneEmpty && slotIndex === 0
        ? `<span class="zone-empty">${this._escape(emptyLabel)}</span>`
        : '';

    slot.innerHTML = `<span class="lane-slot-track">${content}</span>`;
    slot.classList.toggle('is-empty', !item);
    this._bindStreamItems();
  }

  _transitionLaneSlot(zone, slotIndex, nextItem, emptyLabel, onComplete) {
    const lane = this._ensureLaneSlots(zone);
    const slot = lane?.querySelector(`[data-lane-slot="${slotIndex}"]`);
    if (!slot || !nextItem) return;

    const currentMarkup = slot.querySelector('.lane-item')?.outerHTML || '';
    const nextMarkup = this._laneItemMarkup(nextItem);

    if (!currentMarkup) {
      this._renderLaneSlot(zone, slotIndex, nextItem, emptyLabel, false);
      onComplete?.();
      return;
    }

    slot.innerHTML = `<span class="lane-slot-track has-next-row">${currentMarkup}${nextMarkup}</span>`;
    this._bindStreamItems();

    const track = slot.querySelector('.lane-slot-track.has-next-row');
    if (!track) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => track.classList.add('is-advancing'));
    });

    const timerKey = `${zone}:${slotIndex}`;
    if (this._zoneRenderTimers[timerKey]) clearTimeout(this._zoneRenderTimers[timerKey]);

    this._zoneRenderTimers[timerKey] = window.setTimeout(() => {
      delete this._zoneRenderTimers[timerKey];
      onComplete?.();
      this._renderLaneSlot(zone, slotIndex, nextItem, emptyLabel, false);
    }, 430);
  }

  _zoneItemSignature(item) {
    return [
      item?.id || '',
      item?.entity_id || '',
      item?.title ||
        item?.message ||
        '',
      item?.summary ||
        item?.secondary ||
        item?.detail ||
        '',
      item?.home_device_name ||
        '',
      item?.entity_name ||
        '',
      item?.source_name ||
        '',
      item?.scheduled_at ||
        '',
      item?.all_day === true
        ? 'all-day'
        : '',
      item?.resolved_at ||
        item?.occurred_at ||
        item?.created_at ||
        item?.updated_at ||
        item?.timestamp ||
        '',
      item?.priority || '',
      item?.icon || '',
      item?.media_url ||
        item?.media?.url ||
        item?.image_url ||
        '',
      item?.category || '',
      item?.state || '',
      item?.color_role || '',
      item?.display_kind || '',
      item?.timestamp_mode || '',
      this._visualSignature(
        this._visualFromData(
          item?.zone_visual
        )
      ),
      this._visualSignature(
        this._visualFromData(
          item?.visual
        )
      )
    ].join('|');
  }

  _alignedLaneCycleAt(intervalMs) {
    const now = performance.now();
    const interval = Math.max(4000, Number(intervalMs) || 7000);

    if (!Number.isFinite(this._laneCycleEpoch)) {
      this._laneCycleEpoch = now;
    }

    const elapsed = Math.max(0, now - this._laneCycleEpoch);
    const cycles = Math.floor(elapsed / interval) + 1;
    return this._laneCycleEpoch + (cycles * interval);
  }

  _scheduleLaneCycle() {
    if (this._laneCycleTimer) {
      clearTimeout(this._laneCycleTimer);
      this._laneCycleTimer = null;
    }

    const controllers = [
      ...Object.values(this._laneSlotControllers || {}).flat(),
      this._headerClimateController,
      this._visualWeatherController,
      this._visualPresentationController
    ].filter(controller =>
      controller?.rotate !== false &&
      controller?.items?.length > 1 &&
      Number.isFinite(controller?.nextAdvanceAt)
    );

    if (!controllers.length) return;

    const nextAt = Math.min(...controllers.map(controller => controller.nextAdvanceAt));
    const delay = Math.max(0, nextAt - performance.now());

    this._laneCycleTimer = window.setTimeout(() => {
      this._laneCycleTimer = null;
      this._runLaneCycle();
    }, delay);
  }

  _runLaneCycle() {
    const now = performance.now();
    const toleranceMs = 40;
    const controllers = [
      ...Object.values(this._laneSlotControllers || {}).flat(),
      this._headerClimateController,
      this._visualWeatherController,
      this._visualPresentationController
    ];

    controllers.forEach(controller => {
      if (
        controller?.rotate === false ||
        controller?.items?.length <= 1 ||
        !Number.isFinite(controller?.nextAdvanceAt) ||
        controller.nextAdvanceAt > now + toleranceMs
      ) {
        return;
      }

      const intervalMs = Math.max(
        4000,
        (Number(controller.intervalSeconds) || 7) * 1000
      );

      if (!this._rotationPaused) {
        controller.advance();
      }

      do {
        controller.nextAdvanceAt += intervalMs;
      } while (controller.nextAdvanceAt <= now + toleranceMs);
    });

    this._scheduleLaneCycle();
  }

  _startZoneRotations(data) {
    if (this._config?.lane_mode === 'single') {
      this._startSingleZoneRotations(data);
      return;
    }

    this._startSlotZoneRotations(data);
  }

  _startSlotZoneRotations(data) {
    // Single-mode timers must not survive a mode switch.
    Object.keys(this._singleLaneTimers).forEach(zone => {
      if (this._singleLaneTimers[zone]) {
        clearInterval(this._singleLaneTimers[zone]);
        this._singleLaneTimers[zone] = null;
      }
    });

    const slotPools = this._laneSlotPools(data);
    const slotCount = 3;

    ['left', 'right'].forEach(zone => {
      const pools = slotPools[zone] || [[], [], []];
      const items = pools.flat().filter(Boolean);
      const config = this._config[zone] || {};
      const backendInterval = Number(data.display?.[`${zone}_rotation_seconds`]);
      const configuredInterval = Number.isFinite(backendInterval) && backendInterval > 0
        ? backendInterval
        : Number(config.interval) || this._config.rotation_seconds;
      const interval = Math.max(4, configuredInterval);
      const emptyLabel = 'No current information';

      this._ensureLaneSlots(zone);

      this._zoneSignatures[zone] = `${items.map(item => this._zoneItemSignature(item)).join('||')}::slots:${slotCount}:${config.rotate !== false}|${interval}`;

      this._laneSlotControllers[zone].forEach((controller, slotIndex) => {
        const pool = pools[slotIndex];
        const slot = this.shadowRoot.querySelector(
          `[data-zone="${zone}"] [data-lane-slot="${slotIndex}"]`
        );
        const poolSignature = pool.map(item => this._zoneItemSignature(item)).join('||');
        const controllerSignature = `${poolSignature}::rotate:${config.rotate !== false}|interval:${interval}`;
        const domReady = pool.length
          ? Boolean(slot?.querySelector('.lane-item'))
          : items.length === 0 && slotIndex === 0
            ? Boolean(slot?.querySelector('.zone-empty'))
            : Boolean(slot?.querySelector('.lane-slot-track'));

        if (controller.signature === controllerSignature && domReady) return;

        controller.configure({
          items: pool,
          intervalSeconds: interval,
          rotate: config.rotate !== false,
          emptyLabel,
          laneEmpty: items.length === 0,
          signature: controllerSignature
        });
      });
    });

    this._scheduleLaneCycle();
  }

  _singleLaneItems(data, zone) {
    return Array.isArray(data?.[zone])
      ? data[zone].filter(item => this._sideLaneEligible(item))
      : [];
  }

  _renderSingleLane(zone, item, emptyLabel) {
    const target = this.shadowRoot.querySelector(`[data-zone="${zone}"]`);
    if (!target) return;

    const content = item
      ? this._laneItemMarkup(item)
      : `<span class="zone-empty">${this._escape(emptyLabel)}</span>`;

    target.innerHTML = `<span class="zone-single" data-single-lane="true">${content}</span>`;
    this._bindStreamItems();
  }

  _startSingleZoneRotations(data) {
    // The slot scheduler/controllers are completely idle in single-item mode.
    if (this._laneCycleTimer) {
      clearTimeout(this._laneCycleTimer);
      this._laneCycleTimer = null;
    }
    Object.values(this._laneSlotControllers || {}).flat().forEach(controller => controller?.stop?.());
    this._activeSlotClaims.clear();

    ['left', 'right'].forEach(zone => {
      const items = this._singleLaneItems(data, zone);
      const config = this._config[zone] || {};
      const backendInterval = Number(data.display?.[`${zone}_rotation_seconds`]);
      const configuredInterval = Number.isFinite(backendInterval) && backendInterval > 0
        ? backendInterval
        : Number(config.interval) || this._config.rotation_seconds;
      const interval = Math.max(4, configuredInterval);
      const signature = `${items.map(item => this._zoneItemSignature(item)).join('||')}::single:${config.rotate !== false}|${interval}`;

      const target = this.shadowRoot.querySelector(`[data-zone="${zone}"]`);
      const domReady = Boolean(target?.querySelector('[data-single-lane="true"]'));
      if (signature === this._zoneSignatures[zone] && domReady) return;

      if (this._singleLaneTimers[zone]) {
        clearInterval(this._singleLaneTimers[zone]);
        this._singleLaneTimers[zone] = null;
      }

      this._zoneSignatures[zone] = signature;
      const emptyLabel = 'No current information';

      if (!items.length) {
        this._singleLaneIndexes[zone] = 0;
        this._singleLaneIds[zone] = null;
        this._renderSingleLane(zone, null, emptyLabel);
        return;
      }

      const ids = items.map(item => this._laneItemId(item));
      const previousId = this._singleLaneIds[zone];
      let index = previousId && ids.includes(previousId)
        ? ids.indexOf(previousId)
        : Math.min(this._singleLaneIndexes[zone] || 0, items.length - 1);
      index = Math.max(0, index);
      this._singleLaneIndexes[zone] = index;
      this._singleLaneIds[zone] = ids[index];
      this._renderSingleLane(zone, items[index], emptyLabel);

      if (config.rotate === false || items.length <= 1) return;

      this._singleLaneTimers[zone] = window.setInterval(() => {
        if (this._rotationPaused) return;
        const nextIndex = (this._singleLaneIndexes[zone] + 1) % items.length;
        this._singleLaneIndexes[zone] = nextIndex;
        this._singleLaneIds[zone] = ids[nextIndex];
        this._renderSingleLane(zone, items[nextIndex], emptyLabel);
      }, interval * 1000);
    });
  }

  _utilitySecurityState() {
    const entity =
      this._config
        .utility_header
        .security_entity;

    const value =
      String(
        this._state(entity)
          ?.state ||
        'unavailable'
      ).toLowerCase();

    const states = {
      disarmed: [
        'Alarm off',
        'mdi:shield-off-outline',
        'neutral'
      ],

      armed_home: [
        'Alarm armed home',
        'mdi:shield-home',
        'success'
      ],

      armed_away: [
        'Alarm armed away',
        'mdi:shield-lock',
        'success'
      ],

      armed_night: [
        'Alarm armed night',
        'mdi:shield-moon',
        'success'
      ],

      arming: [
        'Alarm arming',
        'mdi:shield-sync',
        'attention'
      ],

      pending: [
        'Entry Delay',
        'mdi:shield-alert',
        'critical'
      ],

      triggered: [
        'Alarm triggered',
        'mdi:shield-alert',
        'critical'
      ]
    };

    const [
      state,
      icon,
      tone
    ] =
      states[value] || [
        'Unavailable',
        'mdi:shield-off-outline',
        'neutral'
      ];

    return {
      entity,
      state,
      icon,
      tone
    };
  }

  _utilityMusicState() {
    const entity =
      this._config
        .utility_header
        .music_entity;

    const player =
      this._state(entity);

    const value =
      String(
        player?.state ||
        'unavailable'
      ).toLowerCase();

    const attributes =
      player?.attributes ||
      {};

    const available =
      Boolean(
        player &&
        ![
          'unknown',
          'unavailable'
        ].includes(value)
      );

    const playing =
      value === 'playing';

    const paused =
      value === 'paused';

    const title =
      attributes.media_title ||
      (
        playing
          ? 'Playing'
          : paused
            ? 'Paused'
            : available
              ? 'Nothing Playing'
              : 'Music Unavailable'
      );

    const secondary =
      attributes.media_artist ||
      attributes.media_album_name ||
      attributes.source ||
      (
        available
          ? 'Speakers and playback'
          : 'Player is unavailable'
      );

    const volumeAvailable =
      Number.isFinite(
        Number(
          attributes.volume_level
        )
      );

    const volume =
      volumeAvailable
        ? Math.max(
            0,
            Math.min(
              1,
              Number(
                attributes.volume_level
              )
            )
          )
        : 0;

    const sources =
      Array.isArray(
        attributes.source_list
      )
        ? [
            ...new Set(
              attributes.source_list
                .map(
                  source =>
                    String(
                      source || ''
                    ).trim()
                )
                .filter(Boolean)
            )
          ]
        : [];

    const artwork =
      String(
        attributes.entity_picture ||
        attributes.media_image_url ||
        attributes.media_album_cover_url ||
        ''
      ).trim();

    return {
      entity,
      value,
      available,
      playing,
      title,
      secondary,
      volume,
      volumeAvailable,
      sources,
      source:
        attributes.source ||
        '',
      artwork,

      icon:
        playing
          ? 'mdi:music-circle'
          : paused
            ? 'mdi:pause-circle'
            : 'mdi:music-circle-outline'
    };
  }

  _headerClimateItems(data = this._getRuntimeData()) {
    const items = [
      ...(Array.isArray(data?.awareness) ? data.awareness : []),
      ...(Array.isArray(data?.side) ? data.side : []),
      ...(Array.isArray(data?.left) ? data.left : []),
      ...(Array.isArray(data?.right) ? data.right : [])
    ];

    const seen = new Set();
    return items.filter(item => {
      if (!this._headerClimateOwnsItem(item)) return false;
      const id = this._laneItemId(item);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  _headerClimateState(item) {
    if (!item) {
      return {
        available: false,
        temperature: '--',
        condition: 'Weather unavailable',
        humidity: ''
      };
    }

    const displayKind = String(item.display_kind || '').toLowerCase();
    const deviceClass = String(item.device_class || '').toLowerCase();
    const entity = this._state(item.entity_id);
    const attrs = entity?.attributes || {};

    if (displayKind === 'current_weather') {
      const rawTemperature = item.title || item.label || item.name || item.summary || '';
      const temperature = this._glanceableTemperature(rawTemperature) || '--';
      const condition = this._friendlyWeatherCondition(
        item.state || item.secondary || item.summary || entity?.state || ''
      ) || 'Current weather';
      const humidityValue = Number(attrs.humidity);
      const humidity = Number.isFinite(humidityValue)
        ? `${Math.round(humidityValue)}%`
        : '';

      return { available: true, temperature, condition, humidity };
    }

    const rawValue = item.title || item.label || item.name || item.message || item.state || '--';
    const condition = String(
      item.summary || item.secondary || item.detail || item.home_device_name || item.entity_name || 'Climate'
    ).trim() || 'Climate';
    const isHumidity = deviceClass === 'humidity' || /%/.test(String(rawValue));
    const temperature = isHumidity
      ? String(rawValue)
      : this._glanceableTemperature(rawValue) || String(rawValue);

    return {
      available: true,
      temperature,
      condition,
      humidity: isHumidity ? 'Humidity' : 'Temperature'
    };
  }

  _utilityWeatherState(data = null) {
    const controller = this._headerClimateController;
    const current = controller?.items?.[controller.cursor] || this._headerClimateItems(data || this._getRuntimeData())[0] || null;
    return this._headerClimateState(current);
  }

  _headerClimateFrameMarkup(item) {
    const weather = this._headerClimateState(item);
    return `<span class="utility-weather-frame"><span class="utility-weather-temp">${this._escape(weather.temperature)}</span><span class="utility-weather-copy"><strong>${this._escape(weather.condition)}</strong><small>${this._escape(weather.humidity)}</small></span></span>`;
  }

  _renderHeaderClimate(item) {
    const header = this.shadowRoot?.querySelector('.utility-header');
    const weather = header?.querySelector('.utility-weather');
    if (!weather) return;

    weather.innerHTML = `<span class="utility-weather-track">${this._headerClimateFrameMarkup(item)}</span>`;
  }

  _transitionHeaderClimate(nextItem, onComplete) {
    const header = this.shadowRoot?.querySelector('.utility-header');
    const weather = header?.querySelector('.utility-weather');
    if (!weather || !nextItem) return;

    const controller = this._headerClimateController;
    const currentItem = controller?.items?.[controller.cursor] || null;
    if (!currentItem) {
      this._renderHeaderClimate(nextItem);
      onComplete?.();
      return;
    }

    weather.innerHTML = `<span class="utility-weather-track has-next-climate">${this._headerClimateFrameMarkup(currentItem)}${this._headerClimateFrameMarkup(nextItem)}</span>`;
    const track = weather.querySelector('.utility-weather-track.has-next-climate');
    if (!track) return;

    requestAnimationFrame(() => requestAnimationFrame(() => {
      track.classList.add('is-advancing');
    }));

    if (this._headerClimateRenderTimer) clearTimeout(this._headerClimateRenderTimer);
    this._headerClimateRenderTimer = window.setTimeout(() => {
      this._headerClimateRenderTimer = null;
      this._renderHeaderClimate(nextItem);
      onComplete?.();
    }, 430);
  }

  _syncHeaderClimate(data) {
    if (this._config?.utility_header?.enabled === false) {
      this._headerClimateController.stop();
      return;
    }

    const items = this._headerClimateItems(data);
    const backendInterval = Number(data?.display?.header_weather_rotation_seconds);
    const interval = Math.max(
      4,
      Number.isFinite(backendInterval) && backendInterval > 0
        ? backendInterval
        : Number(this._config?.left?.interval) || this._config.rotation_seconds || 7
    );
    const signature = `${items.map(item => this._zoneItemSignature(item)).join('||')}::interval:${interval}`;

    if (this._headerClimateController.signature === signature) return;

    this._headerClimateController.configure({
      items,
      intervalSeconds: interval,
      rotate: true,
      signature
    });
  }

  _utilityHeaderMarkup(data = null) {
    if (
      !this._config
        .utility_header
        .enabled
    ) {
      return '';
    }

    const security =
      this._utilitySecurityState();

    const music =
      this._utilityMusicState();

    const weather =
      this._utilityWeatherState(data);

    const securityNavigation =
      this._config
        .context_actions
        .security?.type ===
      'navigate'
        ? this._config
            .context_actions
            .security.path
        : this._config
            .utility_header
            .security_path;

    const musicNavigation =
      this._config
        .context_actions
        .music?.type ===
      'navigate'
        ? this._config
            .context_actions
            .music.path
        : this._config
            .utility_header
            .music_path;

    const securityNavigationDisabled =
      securityNavigation
        ? ''
        : ' disabled';

    const musicNavigationDisabled =
      musicNavigation
        ? ''
        : ' disabled';

    const disabled =
      music.available
        ? ''
        : ' disabled';

    const volumeDisabled =
      music.available &&
      music.volumeAvailable
        ? ''
        : ' disabled';

    const sourceOptions =
      music.sources
        .map(
          source =>
            `<option value="${this._escape(source)}"${source === music.source ? ' selected' : ''}>${this._escape(source)}</option>`
        )
        .join('');

    return `<section class="utility-header" aria-label="Home controls">
      <div class="utility-clock" aria-label="Current time"><span class="utility-time"><strong data-clock-hour></strong><small data-clock-period></small></span><span class="utility-date" data-clock-date></span></div>
      <button class="utility-security tone-${this._escape(security.tone)}" type="button" data-utility-security aria-label="${this._escape(`Security: ${security.state}`)}"${securityNavigationDisabled}><ha-icon icon="${this._escape(security.icon)}"></ha-icon><span><strong>Security</strong><small>${this._escape(security.state)}</small></span></button>
      <section class="utility-weather" aria-label="Weather and climate"><span class="utility-weather-track"><span class="utility-weather-frame"><span class="utility-weather-temp">${this._escape(weather.temperature)}</span><span class="utility-weather-copy"><strong>${this._escape(weather.condition)}</strong><small>${this._escape(weather.humidity)}</small></span></span></span></section>
      <section class="utility-music${music.playing ? ' playing' : ''}" aria-label="Music player">
        <button class="utility-music-summary" type="button" data-utility-music-nav aria-label="${this._escape(`Music: ${music.title}`)}"${musicNavigationDisabled}><span class="utility-music-art${music.artwork ? ' has-art' : ''}"><img data-music-art src="${this._escape(music.artwork)}" alt=""${music.artwork ? '' : ' hidden'}><ha-icon data-music-icon icon="${this._escape(music.icon)}"></ha-icon></span><span><small>Music</small><strong data-music-title>${this._escape(music.title)}</strong><em data-music-secondary>${this._escape(music.secondary)}</em></span></button>
        <div class="utility-music-controls">
          <div class="music-control-row">
            <button type="button" data-music-command="media_previous_track" aria-label="Previous track"${disabled}><ha-icon icon="mdi:skip-previous"></ha-icon></button>
            <button class="music-play-toggle" type="button" data-music-command="${music.playing ? 'media_pause' : 'media_play'}" aria-label="${music.playing ? 'Pause' : 'Play'}"${disabled}><ha-icon icon="${music.playing ? 'mdi:pause' : 'mdi:play'}"></ha-icon></button>
            <button type="button" data-music-command="media_next_track" aria-label="Next track"${disabled}><ha-icon icon="mdi:skip-next"></ha-icon></button>
            <ha-icon class="music-volume-icon" icon="${music.volume === 0 ? 'mdi:volume-off' : music.volume < .5 ? 'mdi:volume-medium' : 'mdi:volume-high'}"></ha-icon>
            <input class="music-volume" type="range" min="0" max="1" step="0.01" value="${music.volume}" aria-label="Music volume" aria-valuetext="${Math.round(music.volume * 100)} percent"${volumeDisabled}>
          </div>
          <label class="music-source"><span>Source</span><select data-music-source aria-label="Music source"${music.available && music.sources.length ? '' : ' disabled'}><option value="">Choose speaker</option>${sourceOptions}</select></label>
        </div>
      </section>
    </section>`;
  }

  _refreshUtilityClock() {
    const header =
      this.shadowRoot?.querySelector(
        '.utility-header'
      );

    if (!header) return;

    const now =
      new Date();

    const parts =
      new Intl.DateTimeFormat(
        [],
        {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        }
      ).formatToParts(now);

    const part =
      type =>
        parts.find(
          value =>
            value.type ===
            type
        )?.value || '';

    const hour =
      part('hour');

    const minute =
      part('minute');

    const period =
      part('dayPeriod');

    const time =
      header.querySelector(
        '[data-clock-hour]'
      );

    const dayPeriod =
      header.querySelector(
        '[data-clock-period]'
      );

    const date =
      header.querySelector(
        '[data-clock-date]'
      );

    if (time) {
      time.textContent =
        `${hour}:${minute}`;
    }

    if (dayPeriod) {
      dayPeriod.textContent =
        period;
    }

    if (date) {
      date.textContent =
        new Intl.DateTimeFormat(
          [],
          {
            weekday:
              'short',

            month:
              'short',

            day:
              'numeric'
          }
        ).format(now);
    }
  }

  _startUtilityClock() {
    if (
      !this._config
        .utility_header
        .enabled
    ) {
      return;
    }

    this._refreshUtilityClock();

    if (this._clockTimer) {
      return;
    }

    // The header only displays minute precision. Wake once at the next minute
    // boundary instead of formatting/querying the DOM every second. This keeps
    // the wall-tablet idle path substantially quieter.
    const scheduleNextMinute = () => {
      const now = Date.now();
      const delay = 60000 - (now % 60000) + 50;
      this._clockTimer = window.setTimeout(() => {
        this._clockTimer = null;
        this._refreshUtilityClock();
        if (this.isConnected) scheduleNextMinute();
      }, delay);
    };

    scheduleNextMinute();
  }

  _updateUtilityHeader(data = null) {
    const header =
      this.shadowRoot?.querySelector(
        '.utility-header'
      );

    if (!header) return;

    const security =
      this._utilitySecurityState();

    const securityButton =
      header.querySelector(
        '[data-utility-security]'
      );

    if (securityButton) {
      securityButton.className =
        `utility-security tone-${security.tone}`;

      securityButton.setAttribute(
        'aria-label',
        `Security: ${security.state}`
      );

      securityButton
        .querySelector(
          'ha-icon'
        )
        ?.setAttribute(
          'icon',
          security.icon
        );

      const state =
        securityButton.querySelector(
          'small'
        );

      if (
        state &&
        state.textContent !==
        security.state
      ) {
        state.textContent =
          security.state;
      }
    }

    this._syncHeaderClimate(data || this._getRuntimeData());

    const music =
      this._utilityMusicState();

    const musicPanel =
      header.querySelector(
        '.utility-music'
      );

    musicPanel?.classList.toggle(
      'playing',
      music.playing
    );

    const summary =
      header.querySelector(
        '[data-utility-music-nav]'
      );

    summary?.setAttribute(
      'aria-label',
      `Music: ${music.title}`
    );

    summary
      ?.querySelector(
        '[data-music-icon]'
      )
      ?.setAttribute(
        'icon',
        music.icon
      );

    const artworkFrame =
      summary?.querySelector(
        '.utility-music-art'
      );

    const artwork =
      summary?.querySelector(
        '[data-music-art]'
      );

    if (
      artworkFrame &&
      artwork &&
      artwork.dataset.url !==
      music.artwork
    ) {
      artwork.dataset.url =
        music.artwork;

      artworkFrame.classList.toggle(
        'has-art',
        Boolean(
          music.artwork
        )
      );

      artwork.hidden =
        !music.artwork;

      if (music.artwork) {
        artwork.setAttribute(
          'src',
          music.artwork
        );
      } else {
        artwork.removeAttribute(
          'src'
        );
      }
    }

    const title =
      header.querySelector(
        '[data-music-title]'
      );

    const secondary =
      header.querySelector(
        '[data-music-secondary]'
      );

    if (
      title &&
      title.textContent !==
      music.title
    ) {
      title.textContent =
        music.title;
    }

    if (
      secondary &&
      secondary.textContent !==
      music.secondary
    ) {
      secondary.textContent =
        music.secondary;
    }

    const controls =
      [
        ...header.querySelectorAll(
          '[data-music-command]'
        )
      ];

    controls.forEach(
      control => {
        control.disabled =
          !music.available;
      }
    );

    const play =
      header.querySelector(
        '.music-play-toggle'
      );

    if (play) {
      play.dataset.musicCommand =
        music.playing
          ? 'media_pause'
          : 'media_play';

      play.setAttribute(
        'aria-label',
        music.playing
          ? 'Pause'
          : 'Play'
      );

      play
        .querySelector(
          'ha-icon'
        )
        ?.setAttribute(
          'icon',
          music.playing
            ? 'mdi:pause'
            : 'mdi:play'
        );
    }

    const volume =
      header.querySelector(
        '.music-volume'
      );

    if (volume) {
      volume.disabled =
        !music.available ||
        !music.volumeAvailable;

      if (
        this.shadowRoot
          .activeElement !==
        volume
      ) {
        volume.value =
          String(
            music.volume
          );
      }

      volume.setAttribute(
        'aria-valuetext',
        `${Math.round(music.volume * 100)} percent`
      );
    }

    header
      .querySelector(
        '.music-volume-icon'
      )
      ?.setAttribute(
        'icon',
        music.volume === 0
          ? 'mdi:volume-off'
          : music.volume < .5
            ? 'mdi:volume-medium'
            : 'mdi:volume-high'
      );

    const source =
      header.querySelector(
        '[data-music-source]'
      );

    if (source) {
      const sourceSignature =
        music.sources.join('|');

      if (
        source.dataset.sources !==
        sourceSignature
      ) {
        source.dataset.sources =
          sourceSignature;

        source.innerHTML =
          `<option value="">Choose speaker</option>${music.sources.map(item =>
            `<option value="${this._escape(item)}">${this._escape(item)}</option>`
          ).join('')}`;
      }

      source.disabled =
        !music.available ||
        !music.sources.length;

      if (
        this.shadowRoot
          .activeElement !==
        source
      ) {
        source.value =
          music.source;
      }
    }
  }

  _navigateUtility(path) {
    if (!path) return;

    if (
      /^https?:\/\//i.test(
        path
      )
    ) {
      window.open(
        path,
        '_blank',
        'noopener,noreferrer'
      );

      return;
    }

    window.history.pushState(
      {},
      '',
      path
    );

    this.dispatchEvent(
      new Event(
        'location-changed',
        {
          bubbles: true,
          composed: true
        }
      )
    );
  }

  _contextActions(
    data =
      this._getRuntimeData()
  ) {
    const builtInActions = [
      [
        'security',
        'mdi:shield-home',
        'Security'
      ],

      [
        'lighting',
        'mdi:home-lightbulb',
        'Lighting'
      ],

      [
        'cameras',
        'mdi:cctv',
        'Cameras'
      ],

      [
        'calendar',
        'mdi:calendar',
        'Calendar'
      ],

      [
        'music',
        'mdi:music',
        'Music'
      ],

      [
        'location',
        'mdi:map-marker',
        'Location'
      ],

      [
        'movies',
        'mdi:movie-open',
        'Movies'
      ],

      [
        'sprinklers',
        'mdi:sprinkler',
        'Sprinklers'
      ],

      [
        'energy',
        'mdi:lightning-bolt',
        'Energy'
      ]
    ]
      .map(
        (
          [
            id,
            icon,
            label
          ]
        ) => {
          const configured =
            homeStatusObject(
              this._config
                .context_actions[
                  id
                ]
            );

          const config =
            !configured.type &&
            configured.path
              ? {
                  ...configured,
                  type:
                    'navigate'
                }
              : configured;

          return {
            id,
            label,

            ...this._contextActionState(
              id,
              icon,
              data
            ),

            config
          };
        }
      );

    const configuredCustomActions =
      this._config
        ?.context_actions
        ?.custom;

    const customActions =
      (Array.isArray(configuredCustomActions)
        ? configuredCustomActions
        : [])
        .map(
          (rawConfigured, index) => {
            const configured =
              homeStatusObject(rawConfigured);
            const name =
              String(
                configured.name ||
                ''
              ).trim() ||
              'Custom destination';

            const path =
              String(
                configured.path ||
                ''
              ).trim();

            return {
              id:
                `custom-${index}`,

              label: name,

              ...this._contextActionState(
                'custom',
                String(
                  configured.icon ||
                  'mdi:open-in-new'
                ).trim() ||
                'mdi:open-in-new',
                data
              ),

              config: {
                ...configured,
                type: 'navigate',
                path
              },

              custom: true
            };
          }
        );

    return [
      ...builtInActions,
      ...customActions
    ]
      .filter(
        action =>
          action.custom
            ? action.config.path
            : action.config.type
      );
  }

  _contextActionState(
    id,
    defaultIcon,
    data
  ) {
    const neutral =
      (
        state,
        icon =
          defaultIcon
      ) => ({
        state,
        icon,
        tone:
          'neutral',

        active:
          false
      });

    if (id === 'security') {
      const entity =
        this._config
          .context_actions
          ?.security
          ?.entity ||
        this._config
          .utility_header
          .security_entity;

      const value =
        String(
          this._state(entity)
            ?.state ||
          'unavailable'
        ).toLowerCase();

      const states = {
        disarmed: [
          'Alarm off',
          'mdi:shield-off-outline',
          'neutral'
        ],

        armed_home: [
          'Alarm armed home',
          'mdi:shield-home',
          'success'
        ],

        armed_away: [
          'Alarm armed away',
          'mdi:shield-lock',
          'success'
        ],

        armed_night: [
          'Alarm armed night',
          'mdi:shield-moon',
          'success'
        ],

        arming: [
          'Alarm arming',
          'mdi:shield-sync',
          'attention'
        ],

        pending: [
          'Entry Delay',
          'mdi:shield-alert',
          'critical'
        ],

        triggered: [
          'Alarm triggered',
          'mdi:shield-alert',
          'critical'
        ]
      };

      const [
        state,
        icon,
        tone
      ] =
        states[value] || [
          'Unavailable',
          'mdi:shield-off-outline',
          'neutral'
        ];

      return {
        state,
        icon,
        tone,

        active:
          tone !==
          'neutral'
      };
    }

    if (
      id === 'lighting'
    ) {
      const configured =
        this._config
          .context_actions
          ?.lighting
          ?.entities;

      const entities =
        Array.isArray(
          configured
        )
          ? configured
          : [];

      if (
        !entities.length
      ) {
        return neutral(
          'Not configured'
        );
      }

      const count =
        entities.filter(
          entity =>
            this._state(entity)
              ?.state ===
            'on'
        ).length;

      return {
        state:
          count
            ? `${count} Light${count === 1 ? '' : 's'} On`
            : 'All Lights Off',

        icon:
          count
            ? 'mdi:lightbulb-group'
            : 'mdi:lightbulb-group-outline',

        tone:
          count
            ? 'attention'
            : 'neutral',

        active:
          count > 0
      };
    }

    if (
      id === 'cameras'
    ) {
      const item =
        (
          data?.active ||
          []
        ).find(
          candidate =>
            candidate?.category ===
              'cameras' ||
            candidate?.event_type ===
              'camera_offline'
        );

      return item
        ? {
            state:
              item.message ||
              item.title ||
              'Camera Offline',

            icon:
              'mdi:cctv-off',

            tone:
              'critical',

            active:
              true
          }
        : neutral(
            'All Online',
            'mdi:cctv'
          );
    }

    if (
      id === 'calendar'
    ) {
      const item =
        [
          ...(data?.left || []),
          ...(data?.right || []),
          ...(data?.bottom || [])
        ].find(
          candidate =>
            candidate?.utility_role ===
              'calendar'
        );

      const state =
        item?.title ||
        item?.message ||
        'Open Calendar';

      return item
        ? {
            state,

            icon:
              'mdi:calendar-clock',

            tone:
              'information',

            active:
              true
          }
        : neutral(
            state
          );
    }

    if (
      id === 'music'
    ) {
      const entity =
        this._config
          .context_actions
          ?.music
          ?.entity ||
        this._config
          .utility_header
          .music_entity;

      const player =
        this._state(entity);

      const value =
        String(
          player?.state ||
          'unavailable'
        ).toLowerCase();

      if (
        value ===
        'playing'
      ) {
        return {
          state:
            player
              ?.attributes
              ?.media_title ||
            'Playing',

          icon:
            'mdi:music-circle',

          tone:
            'success',

          active:
            true
        };
      }

      if (
        value ===
        'paused'
      ) {
        return {
          state:
            'Paused',

          icon:
            'mdi:pause-circle',

          tone:
            'information',

          active:
            true
        };
      }

      return neutral(
        value ===
        'unavailable'
          ? 'Unavailable'
          : 'Idle'
      );
    }

    if (
      id === 'location'
    ) {
      const people =
        Object.values(
          this._hass?.states ||
          {}
        ).filter(
          state =>
            state?.entity_id
              ?.startsWith(
                'person.'
              ) &&
            ![
              'unknown',
              'unavailable'
            ].includes(
              state.state
            )
        );

      if (
        !people.length
      ) {
        return neutral(
          'Unavailable'
        );
      }

      const home =
        people.filter(
          state =>
            state.state ===
            'home'
        ).length;

      return {
        state:
          home ===
          people.length
            ? 'Everyone Home'
            : home === 0
              ? 'Everyone Away'
              : `${home} of ${people.length} Home`,

        icon:
          home ===
          people.length
            ? 'mdi:home-account'
            : 'mdi:map-marker-account',

        tone:
          home ===
          people.length
            ? 'neutral'
            : 'information',

        active:
          home !==
          people.length
      };
    }

    if (
      id ===
      'sprinklers'
    ) {
      const configured =
        this._config
          .context_actions
          ?.sprinklers
          ?.entities;

      const entities =
        Array.isArray(
          configured
        )
          ? configured
          : [];

      if (
        !entities.length
      ) {
        return neutral(
          'Not configured'
        );
      }

      const watering =
        entities.filter(
          entity =>
            [
              'open',
              'opening',
              'on'
            ].includes(
              String(
                this._state(
                  entity
                )?.state ||
                ''
              ).toLowerCase()
            )
        );

      if (
        watering.length
      ) {
        return {
          state:
            watering.length ===
            1
              ? 'Watering'
              : `Watering ${watering.length} Zones`,

          icon:
            'mdi:sprinkler-variant',

          tone:
            'information',

          active:
            true
        };
      }

      const rainDelay =
        this._config
          .context_actions
          ?.sprinklers
          ?.rain_delay_entity;

      if (
        rainDelay &&
        this._state(
          rainDelay
        )?.state ===
          'on'
      ) {
        return {
          state:
            'Rain Delay',

          icon:
            'mdi:weather-rainy',

          tone:
            'attention',

          active:
            true
        };
      }

      return neutral(
        'Idle'
      );
    }

    if (
      id === 'energy'
    ) {
      return neutral(
        'Open Energy'
      );
    }

    if (
      id === 'movies'
    ) {
      return neutral(
        'Browse'
      );
    }

    return neutral(
      'Open'
    );
  }

  _event(item, active) {
    const category =
      item?.category ||
      'Unknown';

    const stamp =
      this._timestamp(
        item,
        active
      );

    const relativeStamp =
      item?.timestamp_mode === 'relative'
        ? stamp
        : null;

    const id =
      item?.id ||
      `${item?.event_type || 'event'}|${item?.message || ''}|${item?.created_at || ''}`;

    const expanded =
      this._expandedEventIds.has(
        id
      );

    const status =
      item?.active === true
        ? 'Active'
        : item?.active === false
          ? 'Resolved'
          : '';

    const detail =
      item?.detail ||
      item?.details ||
      item?.description ||
      '';

    const entityId =
      item?.entity_id ||
      item?.entity ||
      '';

    const fields =
      [
        [
          'Time',
          stamp
            ? `${active ? 'Detected' : 'Resolved'} ${this._time(stamp)}`
            : ''
        ],

        [
          'Relative',
          relativeStamp
            ? this._relative(relativeStamp)
            : ''
        ],

        [
          'Status',
          status
        ],

        [
          'Category',
          category
        ],

        [
          'Device',
          item?.device ||
          ''
        ],

        [
          'Area',
          item?.area ||
          ''
        ],

        [
          'Details',
          detail
        ]
      ].filter(
        (
          [, value]
        ) =>
          value !== ''
      );

    return `<article class="event ${expanded ? 'expanded' : ''}" data-id="${this._escape(id)}" style="--event-color:${this._color(category)}">
      <button class="event-head" type="button" aria-expanded="${expanded}"><span class="event-icon"><ha-icon icon="${this._escape(item?.icon || 'mdi:bell-outline')}"></ha-icon></span><span class="event-copy"><strong>${this._escape(this._label(item))}</strong><small>${this._escape(category)}${relativeStamp ? ` • ${this._escape(this._relative(relativeStamp))}` : ''}</small></span><ha-icon class="chevron" icon="mdi:chevron-right"></ha-icon></button>
      <div class="event-details">${fields.map(([label, value]) => `<div class="field"><small>${this._escape(label)}</small><span>${this._escape(value)}</span></div>`).join('')}${entityId ? `<button class="open-device" type="button" data-entity="${this._escape(entityId)}"><ha-icon icon="mdi:open-in-new"></ha-icon>Open Device</button>` : ''}</div>
    </article>`;
  }

  _styles() {
    return `<style>${CSS}
/* Footer readability overrides. Side-lane sizes are controlled only by Presentation settings. */
.footer-marquee-item ha-icon { width:38px !important; height:38px !important; --mdc-icon-size:38px; }
.footer-marquee-copy strong { font-size:21px !important; font-weight:780 !important; line-height:1.05; }
.footer-marquee-copy small { margin-top:6px !important; font-size:17px !important; font-weight:600; line-height:1.1; opacity:.88 !important; }
.footer-marquee-item.is-current-weather ha-icon,.footer-marquee-item.is-indoor-temperature ha-icon { width:42px !important; height:42px !important; --mdc-icon-size:42px; }
.footer-marquee-item.is-current-weather .footer-marquee-copy strong,.footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong { font-size:30px !important; font-weight:800 !important; }
.footer-marquee-item.is-current-weather .footer-marquee-copy small,.footer-marquee-item.is-indoor-temperature .footer-marquee-copy small { font-size:18px !important; }

/* Footer profile overrides; side-lane typography is controlled by Presentation settings. */
:host([data-profile="auto"]) .ticker-footer,
:host([data-profile="tablet"]) .ticker-footer,
:host([data-profile="desktop"]) .ticker-footer { min-height:102px !important; padding-top:12px !important; }
:host([data-profile="auto"]) .footer-marquee,
:host([data-profile="tablet"]) .footer-marquee,
:host([data-profile="desktop"]) .footer-marquee { height:102px !important; }
:host([data-profile="auto"]) .footer-marquee-item,
:host([data-profile="tablet"]) .footer-marquee-item,
:host([data-profile="desktop"]) .footer-marquee-item { padding:0 32px !important; }
:host([data-profile="auto"]) .footer-marquee-item > [data-stream-id],
:host([data-profile="tablet"]) .footer-marquee-item > [data-stream-id],
:host([data-profile="desktop"]) .footer-marquee-item > [data-stream-id] { gap:14px !important; }
:host([data-profile="auto"]) .footer-marquee-item ha-icon,
:host([data-profile="tablet"]) .footer-marquee-item ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item ha-icon { width:38px !important; height:38px !important; --mdc-icon-size:38px !important; }
:host([data-profile="auto"]) .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-copy strong { font-size:26px !important; font-weight:820 !important; line-height:1.02 !important; letter-spacing:.15px !important; }
:host([data-profile="auto"]) .footer-marquee-copy small,
:host([data-profile="tablet"]) .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-copy small { margin-top:7px !important; font-size:21px !important; font-weight:650 !important; line-height:1.05 !important; opacity:.9 !important; }
:host([data-profile="auto"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="auto"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong { font-size:38px !important; font-weight:850 !important; }
:host([data-profile="auto"]) .footer-marquee-item.is-current-weather .footer-marquee-copy small,
:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather .footer-marquee-copy small,
:host([data-profile="auto"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy small,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy small { font-size:22px !important; }
:host([data-profile="auto"]) .footer-marquee-item.is-current-weather ha-icon,
:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather ha-icon,
:host([data-profile="auto"]) .footer-marquee-item.is-indoor-temperature ha-icon,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature ha-icon { width:42px !important; height:42px !important; --mdc-icon-size:42px !important; }

/* User-configurable left/right presentation contract.
   These are the only tablet/desktop/auto size rules for side-lane typography. */
:host([data-profile="auto"]) .primary-zone .zone-title,
:host([data-profile="tablet"]) .primary-zone .zone-title,
:host([data-profile="desktop"]) .primary-zone .zone-title {
  font-size:var(--hs-left-title-size,48px) !important;
}
:host([data-profile="auto"]) .primary-zone .zone-summary,
:host([data-profile="tablet"]) .primary-zone .zone-summary,
:host([data-profile="desktop"]) .primary-zone .zone-summary {
  font-size:var(--hs-left-summary-size,32px) !important;
}
:host([data-profile="auto"]) .primary-zone .zone-title ha-icon,
:host([data-profile="tablet"]) .primary-zone .zone-title ha-icon,
:host([data-profile="desktop"]) .primary-zone .zone-title ha-icon {
  width:var(--hs-left-icon-size,60px) !important;
  height:var(--hs-left-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-left-icon-size,60px) !important;
}
:host([data-profile="auto"]) .secondary-zone .zone-title,
:host([data-profile="tablet"]) .secondary-zone .zone-title,
:host([data-profile="desktop"]) .secondary-zone .zone-title {
  font-size:var(--hs-right-title-size,48px) !important;
}
:host([data-profile="auto"]) .secondary-zone .zone-summary,
:host([data-profile="tablet"]) .secondary-zone .zone-summary,
:host([data-profile="desktop"]) .secondary-zone .zone-summary {
  font-size:var(--hs-right-summary-size,32px) !important;
}
:host([data-profile="auto"]) .secondary-zone .zone-title ha-icon,
:host([data-profile="tablet"]) .secondary-zone .zone-title ha-icon,
:host([data-profile="desktop"]) .secondary-zone .zone-title ha-icon {
  width:var(--hs-right-icon-size,60px) !important;
  height:var(--hs-right-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-right-icon-size,60px) !important;
}
:host([data-profile="auto"]) .primary-zone .zone-item.is-measurement .zone-title,
:host([data-profile="tablet"]) .primary-zone .zone-item.is-measurement .zone-title,
:host([data-profile="desktop"]) .primary-zone .zone-item.is-measurement .zone-title {
  font-size:var(--hs-left-value-size,72px) !important;
}
:host([data-profile="auto"]) .secondary-zone .zone-item.is-measurement .zone-title,
:host([data-profile="tablet"]) .secondary-zone .zone-item.is-measurement .zone-title,
:host([data-profile="desktop"]) .secondary-zone .zone-item.is-measurement .zone-title {
  font-size:var(--hs-right-value-size,72px) !important;
}
:host([data-profile="auto"]) .secondary-zone .zone-item.is-current-weather .zone-title,
:host([data-profile="tablet"]) .secondary-zone .zone-item.is-current-weather .zone-title,
:host([data-profile="desktop"]) .secondary-zone .zone-item.is-current-weather .zone-title {
  font-size:var(--hs-right-weather-size,72px) !important;
}

/* User-configurable presentation contract for footer/layout continues below. */
:host([data-profile="auto"]) .ticker-footer,
:host([data-profile="tablet"]) .ticker-footer,
:host([data-profile="desktop"]) .ticker-footer,
:host([data-profile="auto"]) .footer-marquee,
:host([data-profile="tablet"]) .footer-marquee,
:host([data-profile="desktop"]) .footer-marquee {
  min-height:var(--hs-bottom-height,102px) !important;
  height:var(--hs-bottom-height,102px) !important;
}
:host([data-profile="auto"]) .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-copy strong { font-size:var(--hs-bottom-title-size,26px) !important; }
:host([data-profile="auto"]) .footer-marquee-copy small,
:host([data-profile="tablet"]) .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-copy small { font-size:var(--hs-bottom-summary-size,21px) !important; }
:host([data-profile="auto"]) .footer-marquee-item ha-icon,
:host([data-profile="tablet"]) .footer-marquee-item ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item ha-icon {
  width:var(--hs-bottom-icon-size,38px) !important; height:var(--hs-bottom-icon-size,38px) !important; --mdc-icon-size:var(--hs-bottom-icon-size,38px) !important;
}
:host([data-profile="auto"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="auto"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong {
  font-size:var(--hs-bottom-value-size,38px) !important;
}

/* Disabled presentation areas are not rendered, so the card's physical layout
   follows the selected areas. Keep the existing footer stream intact when it
   is the only visible area. */
.ticker-zones[data-has-left]:not([data-has-right]) {
  grid-template-columns:minmax(0,1fr);
}
.ticker-zones[data-has-right]:not([data-has-left]) {
  grid-template-columns:minmax(0,1fr);
}
.ticker-zones.has-visual[data-has-left]:not([data-has-right]),
.ticker-zones.has-visual[data-has-right]:not([data-has-left]) {
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);
}
:host([data-profile="auto"]) .ticker.ticker-only,
:host([data-profile="tablet"]) .ticker.ticker-only,
:host([data-profile="desktop"]) .ticker.ticker-only {
  height:calc(var(--hs-bottom-height,102px) + 12px) !important;
  min-height:calc(var(--hs-bottom-height,102px) + 12px) !important;
  padding:0;
}
:host([data-ticker-only]) {
  min-height:0 !important;
}
:host([data-ticker-only]) .ticker {
  height:calc(var(--hs-bottom-height,102px) + 12px) !important;
  min-height:calc(var(--hs-bottom-height,102px) + 12px) !important;
  max-height:calc(var(--hs-bottom-height,102px) + 12px) !important;
}
.ticker.ticker-only .ticker-footer {
  flex:0 0 calc(var(--hs-bottom-height,102px) + 12px);
  height:calc(var(--hs-bottom-height,102px) + 12px) !important;
  min-height:var(--hs-bottom-height,102px) !important;
  padding-top:12px !important;
  box-sizing:border-box;
}
.ticker.ticker-empty {
  display:none !important;
}
</style>`;
  }

  _stopZoneRotations() {
    Object.keys(this._singleLaneTimers || {}).forEach(zone => {
      if (this._singleLaneTimers[zone]) {
        clearInterval(this._singleLaneTimers[zone]);
        this._singleLaneTimers[zone] = null;
      }
    });

    if (this._laneCycleTimer) {
      clearTimeout(this._laneCycleTimer);
      this._laneCycleTimer = null;
    }

    Object.values(this._laneSlotControllers || {}).flat().forEach(
      controller => controller?.stop?.()
    );
    this._headerClimateController?.stop?.();
    if (this._headerClimateController) this._headerClimateController.signature = '';

    Object.values(
      this._zoneRenderTimers
    ).forEach(
      timer =>
        clearTimeout(timer)
    );

    this._zoneRenderTimers =
      {};

  }

  _visualModeItems(data) {
    const all = [
      ...(Array.isArray(data?.active) ? data.active : []),
      ...(Array.isArray(data?.awareness) ? data.awareness : []),
      ...(Array.isArray(data?.recent) ? data.recent : [])
    ];
    const seen = new Set();
    return all.filter(item => {
      const id = this._laneItemId(item);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  _visualModeCurrentItems(data) {
    const all = [
      ...(Array.isArray(data?.active) ? data.active : []),
      ...(Array.isArray(data?.awareness) ? data.awareness : [])
    ];
    const seen = new Set();
    return all.filter(item => {
      const id = this._laneItemId(item);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  _visualModeCategoryItems(data, categories, currentOnly = false) {
    const wanted = new Set(categories.map(value => String(value).toLowerCase()));
    const source = currentOnly ? this._visualModeCurrentItems(data) : this._visualModeItems(data);
    return source.filter(item => {
      const category = String(item?.category || '').toLowerCase();
      const displayKind = String(item?.display_kind || '').toLowerCase();
      return wanted.has(category) || wanted.has(displayKind);
    });
  }

  _visualModeHay(item) {
    return `${item?.category || ''} ${item?.display_kind || ''} ${item?.device_class || ''} ${item?.title || ''} ${item?.message || ''} ${item?.summary || ''} ${item?.secondary || ''} ${item?.entity_name || ''}`.toLowerCase();
  }

  _visualModeNavigationPath(role) {
    const key = String(role || '').toLowerCase();
    const aliases = {
      household: ['location', 'household'],
      appliances: ['appliances', 'energy'],
      watering: ['sprinklers'],
      waste: ['waste', 'calendar'],
      weather: ['weather'],
      traffic: ['traffic'],
      calendar: ['calendar'],
      music: ['music'],
      security: ['security'],
      cameras: ['cameras'],
      sports: ['sports']
    };
    const keys = aliases[key] || [key];
    for (const candidate of keys) {
      const configured = homeStatusObject(this._config?.context_actions?.[candidate]);
      if (String(configured?.path || '').trim()) return String(configured.path).trim();
      const custom = (Array.isArray(this._config?.context_actions?.custom) ? this._config.context_actions.custom : [])
        .find(action => String(action?.name || '').trim().toLowerCase() === candidate);
      if (String(custom?.path || '').trim()) return String(custom.path).trim();
    }
    if (key === 'security') return String(this._config?.utility_header?.security_path || '').trim();
    if (key === 'music') return String(this._config?.utility_header?.music_path || '').trim();
    return '';
  }

  _visualModeSecurityState(data) {
    const alarmId = this._config?.utility_header?.security_entity;
    const alarm = alarmId ? this._state(alarmId) : null;
    const rawState = String(alarm?.state || '').toLowerCase();
    const alarmLabel = rawState
      ? rawState.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
      : 'Home';
    const activeSecurity = this._visualModeCategoryItems(
      data,
      ['security', 'door', 'window', 'lock', 'garage_door', 'moisture'],
      true
    ).filter(item => item?.active !== false && ['critical', 'attention'].includes(String(item?.priority || '').toLowerCase()));
    const secure = activeSecurity.length === 0;
    const triggered = /triggered/.test(rawState);
    const pending = /arming|pending|entry|exit/.test(rawState);
    const armedHome = /armed_home|armed_night|armed_custom_bypass/.test(rawState);
    const armedAway = /armed_away|armed_vacation/.test(rawState);
    const disarmed = rawState === 'disarmed';
    const beacon = triggered ? 'triggered' : (pending ? 'pending' : (armedHome ? 'armed-home' : (armedAway ? 'armed-away' : (disarmed ? 'disarmed' : 'neutral'))));
    const icon = triggered ? 'mdi:alarm-light' : (armedHome ? 'mdi:shield-home' : (armedAway ? 'mdi:shield-lock' : (pending ? 'mdi:shield-sync' : (secure ? 'mdi:shield-check' : 'mdi:shield-alert'))));
    const detail = triggered
      ? 'ALARM TRIGGERED'
      : (armedHome ? 'Alarm is armed while you are home'
      : (pending ? 'Alarm state is changing'
      : (armedAway ? 'Away protection is active'
      : (secure ? '' : `${activeSecurity.length} condition${activeSecurity.length === 1 ? '' : 's'} need attention`))));
    return { secure, count: activeSecurity.length, label: rawState ? alarmLabel : (secure ? 'All Clear' : `${activeSecurity.length} Active`), icon, beacon, detail, armedHome, triggered, pending };
  }

  _visualModeWeatherState(data) {
    const candidates = this._headerClimateItems(data);
    const score = item => {
      const displayKind = String(item?.display_kind || '').toLowerCase();
      const deviceClass = String(item?.device_class || '').toLowerCase();
      const category = String(item?.category || '').toLowerCase();
      if (displayKind === 'current_weather') return 100;
      if (deviceClass === 'temperature' || displayKind === 'temperature') return 70;
      if (category === 'weather') return 60;
      if (deviceClass === 'humidity' || /%/.test(String(item?.title || item?.message || ''))) return 10;
      return 30;
    };
    const item = [...candidates].sort((a, b) => score(b) - score(a))[0] ||
      this._visualModeCategoryItems(data, ['weather', 'climate', 'temperature'], true)[0] || null;
    const state = this._headerClimateState(item);
    const humidityItem = this._visualModeCurrentItems(data).find(candidate => {
      const deviceClass = String(candidate?.device_class || '').toLowerCase();
      const hay = this._visualModeHay(candidate);
      return deviceClass === 'humidity' || (/humidity/.test(hay) && /%/.test(hay));
    });
    const humidityText = humidityItem
      ? (humidityItem?.title || humidityItem?.message || humidityItem?.state || humidityItem?.summary || '')
      : (state.humidity || '');
    const humidityMatch = String(humidityText).match(/(\d{1,3})\s*%/);
    return {
      ...state,
      icon: item?.icon || 'mdi:weather-partly-cloudy',
      humidity: humidityMatch ? `${Math.min(100, Number(humidityMatch[1]))}%` : (state.humidity || ''),
      humidityValue: humidityMatch ? Math.min(100, Number(humidityMatch[1])) : null
    };
  }

  _visualWeatherEntity(data) {
    const item = this._headerClimateItems(data).find(candidate => String(candidate?.display_kind || '').toLowerCase() === 'current_weather') || this._visualModeCategoryItems(data, ['weather'], true).find(candidate => String(candidate?.entity_id || '').startsWith('weather.'));
    return item?.entity_id || '';
  }

  _ensureVisualWeatherForecast(data) {
    const entityId = this._visualWeatherEntity(data);
    if (!entityId || !this._hass?.connection?.subscribeMessage || (this._visualForecastEntity === entityId && this._visualForecastUnsub)) return;
    this._visualForecastEntity = entityId;
    try {
      this._visualForecastUnsub = this._hass.connection.subscribeMessage(event => {
        this._visualDailyForecast = (Array.isArray(event?.forecast) ? event.forecast : []).slice(0, 5);
        const host = this.shadowRoot?.querySelector('[data-visual-forecast]');
        if (host) host.innerHTML = this._visualForecastMarkup();
      }, { type: 'weather/subscribe_forecast', forecast_type: 'daily', entity_id: entityId });
    } catch (_) { this._visualDailyForecast = []; }
  }

  _visualForecastMarkup() {
    let days = Array.isArray(this._visualDailyForecast) ? this._visualDailyForecast.slice(0, 5) : [];
    if (!days.length && this._visualForecastEntity) {
      const weatherState = this._state(this._visualForecastEntity);
      const fallback = weatherState?.attributes?.forecast;
      if (Array.isArray(fallback)) days = fallback.slice(0, 5);
    }
    if (!days.length) return '<span class="visual-forecast-waiting">Forecast unavailable</span>';
    const icon = value => { value = String(value || '').toLowerCase(); if (/rain|pour/.test(value)) return 'mdi:weather-rainy'; if (/lightning|storm/.test(value)) return 'mdi:weather-lightning'; if (/partly/.test(value)) return 'mdi:weather-partly-cloudy'; if (/cloud/.test(value)) return 'mdi:weather-cloudy'; if (/snow/.test(value)) return 'mdi:weather-snowy'; if (/fog/.test(value)) return 'mdi:weather-fog'; return 'mdi:weather-sunny'; };
    return days.map((day, index) => {
      const date = day?.datetime ? new Date(day.datetime) : null;
      const label = index === 0 ? 'Today' : (date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date) : `Day ${index + 1}`);
      const high = Number.isFinite(Number(day?.temperature)) ? `${Math.round(Number(day.temperature))}°` : '--';
      const low = Number.isFinite(Number(day?.templow)) ? `${Math.round(Number(day.templow))}°` : '';
      return `<span class="visual-forecast-day"><small>${this._escape(label)}</small><ha-icon icon="${icon(day?.condition)}"></ha-icon><strong>${high}</strong>${low ? `<em>${low}</em>` : ''}</span>`;
    }).join('');
  }

  _visualOutsideWeatherState(data) {
    // Prefer Home Status items, but outdoor climate sensors may not be promoted
    // into the current lanes. Fall back to the live HA state registry so a
    // selected exterior humidity sensor can still populate Outside Home.
    const items = this._visualModeItems(data);
    const outsidePattern = /outside|outdoor|exterior|patio|porch|back yard|backyard|front yard|frontyard/i;
    const outside = items.filter(item => outsidePattern.test(this._visualModeHay(item)));
    const pickItem = kind => outside.find(item => {
      const hay = this._visualModeHay(item);
      const deviceClass = String(item?.device_class || '').toLowerCase();
      return kind === 'temperature'
        ? deviceClass === 'temperature' || /temperature|temp\b/.test(hay)
        : deviceClass === 'humidity' || /humidity/.test(hay);
    });
    const extractItem = (item, unit) => {
      if (!item) return null;
      const entity = item?.entity_id ? this._state(item.entity_id) : null;
      const raw = String(entity?.state ?? item?.state ?? item?.message ?? item?.title ?? item?.summary ?? '');
      const match = raw.match(/-?\d+(?:\.\d+)?/);
      if (!match) return null;
      const number = Number(match[0]);
      if (!Number.isFinite(number)) return null;
      return `${Math.round(number)}${unit}`;
    };
    const pickState = kind => {
      const states = Object.entries(this._hass?.states || {});
      const matches = states.filter(([entityId, state]) => {
        const attrs = state?.attributes || {};
        const deviceClass = String(attrs.device_class || '').toLowerCase();
        if (deviceClass !== kind) return false;
        const name = `${entityId} ${attrs.friendly_name || ''}`;
        return outsidePattern.test(name);
      });
      if (!matches.length) return null;
      // Prefer explicit outside/outdoor names over looser patio/yard matches.
      matches.sort((a, b) => {
        const score = ([entityId, state]) => /outside|outdoor|exterior/i.test(`${entityId} ${state?.attributes?.friendly_name || ''}`) ? 1 : 0;
        return score(b) - score(a);
      });
      const raw = String(matches[0][1]?.state ?? '');
      const number = Number(raw);
      return Number.isFinite(number) ? number : null;
    };

    const temperature = extractItem(pickItem('temperature'), '°') || (() => {
      const value = pickState('temperature');
      return value == null ? null : `${Math.round(value)}°`;
    })();
    const humidity = extractItem(pickItem('humidity'), '%') || (() => {
      const value = pickState('humidity');
      return value == null ? null : `${Math.max(0, Math.min(100, Math.round(value)))}%`;
    })();
    if (!temperature && !humidity) return null;
    return { temperature: temperature || '--', humidity: humidity || '--' };
  }

  _visualWeatherFaces(data) {
    const weather = this._visualModeWeatherState(data);
    const faces = [{ id: 'forecast', type: 'forecast', weather }];
    const outside = this._visualOutsideWeatherState(data);
    if (outside) faces.push({ id: 'outside', type: 'outside', outside });
    return faces;
  }

  _visualWeatherFaceMarkup(face, data = this._getRuntimeData()) {
    if (face?.type === 'outside') {
      const outside = face.outside || this._visualOutsideWeatherState(data) || {};
      return `<div class="visual-weather-outside"><div class="visual-weather-outside-title"><ha-icon icon="mdi:home-export-outline"></ha-icon><span><strong>Outside Home</strong><small>Outdoor conditions</small></span></div><div class="visual-weather-outside-metrics"><span><ha-icon icon="mdi:thermometer"></ha-icon><b>${this._escape(outside.temperature || '--')}</b><small>Temperature</small></span><span><ha-icon icon="mdi:water-percent"></ha-icon><b>${this._escape(outside.humidity || '--')}</b><small>Humidity</small></span></div></div>`;
    }
    const weather = face?.weather || this._visualModeWeatherState(data);
    return `<div class="visual-clean-weather-primary"><ha-icon class="visual-weather-icon" data-visual-weather-icon icon="${this._escape(weather.icon)}"></ha-icon><span class="visual-weather-temp" data-visual-weather-temp>${this._escape(weather.temperature || '--')}</span><span class="visual-clean-weather-copy"><strong data-visual-weather-condition>${this._escape(weather.condition || 'Weather')}</strong><small>Current conditions</small></span></div><div class="visual-clean-weather-metric"><ha-icon icon="mdi:water-percent"></ha-icon><span><b data-visual-weather-humidity>${this._escape(weather.humidity || '--')}</b><small>Humidity</small></span></div><div class="visual-clean-weather-forecast" data-visual-forecast>${this._visualForecastMarkup()}</div>`;
  }

  _renderVisualWeatherFace(face) {
    const host = this.shadowRoot?.querySelector('[data-visual-weather-face]');
    if (!host || !face) return;
    host.dataset.weatherFace = face.id;
    host.innerHTML = this._visualWeatherFaceMarkup(face);
  }

  _syncVisualWeatherRotation(data) {
    const faces = this._visualWeatherFaces(data);
    const backendInterval = Number(data?.display?.header_weather_rotation_seconds);
    const interval = Math.max(5, Number.isFinite(backendInterval) && backendInterval > 0 ? backendInterval : 9);
    const outside = faces.find(face => face.type === 'outside')?.outside;
    const signature = `${faces.map(face => face.id).join('|')}::${outside?.temperature || ''}:${outside?.humidity || ''}::${interval}`;
    const controller = this._visualWeatherController;
    if (controller.signature === signature) return;
    controller.configure({ items: faces, intervalSeconds: interval, rotate: true, signature });
    this._scheduleLaneCycle();
  }

  _visualModeApplianceItems(data) {
    // Dashboard v2 only promotes appliances that are useful now. Quiet/off
    // appliances do not reserve presentation space; completion belongs in RECENT.
    return this._visualModeCategoryItems(data, ['appliance', 'laundry'], true)
      .filter(item => item?.active !== false)
      .filter(item => !/\b(?:off|idle|standby|clear)\b/i.test(`${item?.state || ''} ${item?.message || ''} ${item?.title || ''}`))
      .slice(0, 4);
  }

  _visualModeModuleItemMarkup(item) {
    const primary = item?.message || item?.title || item?.entity_name || 'Status';
    const secondary = item?.secondary || item?.summary || item?.subtitle || item?.state || '';
    const icon = item?.icon || this._icon(item?.priority);
    const semantic = this._iconSemanticClass(item);
    const entity = item?.entity_id || '';
    const appliancePath = this._visualModeNavigationPath('appliances');
    const percentMatch = `${primary} ${secondary}`.match(/(?:^|\s)(\d{1,3})%/);
    const percent = percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : null;
    const progress = percent === null ? '' : `<span class="visual-mini-progress"><i style="width:${percent}%"></i></span>`;
    return `<button class="visual-mini-item" type="button"${appliancePath ? ` data-visual-path="${this._escape(appliancePath)}"` : (entity ? ` data-visual-entity="${this._escape(entity)}"` : ' disabled')}><span class="visual-mini-icon ${this._escape(semantic)}"><ha-icon icon="${this._escape(icon)}"></ha-icon></span><span class="visual-mini-copy"><strong>${this._escape(primary)}</strong>${secondary ? `<small>${this._escape(this._visualModeFriendlyWhen(secondary))}</small>` : ''}${progress}</span>${entity ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}</button>`;
  }

  _visualModeFriendlyWhen(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const compactDate = raw.match(/^([A-Za-z]{3}),?\s*(\d{1,2})[.](\d{1,2})$/);
    if (compactDate) {
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${compactDate[1]}, ${monthNames[Number(compactDate[3]) - 1] || compactDate[3]} ${Number(compactDate[2])}`;
    }
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime()) && /\d{4}-\d{2}-\d{2}/.test(raw)) {
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(date);
    }
    return raw.replace(/^(on\s+)?/i, '').replace(/\b20\d{2}\b/g, '').replace(/[,.]\s*$/, '').trim();
  }

  _visualModeValue(item) {
    return String(item?.state || item?.message || item?.title || item?.summary || '').trim();
  }

  _visualModeDetail(item) {
    return String(item?.secondary || item?.summary || item?.subtitle || '').trim();
  }

  _visualModeNamedTile(name, item, fallbackValue, icon, tone = '') {
    if (!item) return { name, value: fallbackValue, detail: '', icon, tone, entity: '', alert: false };
    let value = this._visualModeValue(item) || fallbackValue;
    let detail = this._visualModeDetail(item);
    if (name === 'Rain Delay') {
      const raw = `${item?.state || ''} ${item?.message || ''} ${item?.title || ''}`.toLowerCase();
      value = /on|active|enabled|delay/.test(raw) && !/off|disabled|inactive/.test(raw) ? 'ON' : (item?.state || 'Active');
    }
    if (/watering|garbage|recycling|waste|calendar/i.test(name)) {
      value = this._visualModeFriendlyWhen(value);
      detail = this._visualModeFriendlyWhen(detail);
      const usDate = text => String(text || '').replace(/\b(\d{1,2})[.](\d{1,2})\b/g, (_, day, month) => {
        const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return `${names[Number(month) - 1] || month} ${Number(day)}`;
      });
      value = usDate(value);
      detail = usDate(detail);
    }
    return {
      name,
      value: value || fallbackValue,
      detail,
      icon: item?.icon || icon,
      tone,
      entity: item?.entity_id || '',
      alert: ['critical', 'attention'].includes(String(item?.priority || '').toLowerCase())
    };
  }

  _visualModeDashboardModel(data) {
    const items = this._visualModeCurrentItems(data);
    const by = terms => items.filter(item => {
      const hay = this._visualModeHay(item);
      return terms.some(term => hay.includes(term));
    });
    const first = terms => by(terms)[0] || null;
    const contacts = by(['door', 'window', 'garage door']).filter(item => !/rain|watering/.test(this._visualModeHay(item)));
    const openContacts = contacts.filter(item => item?.active !== false && ['critical', 'attention'].includes(String(item?.priority || '').toLowerCase()));
    const locks = Object.values(this._hass?.states || {}).filter(state => String(state?.entity_id || '').startsWith('lock.')).map(state => ({ entity_id: state.entity_id, state: state.state }));
    const lockAlerts = locks.filter(item => String(item.state || '').toLowerCase() === 'unlocked');
    const moisture = by(['leak', 'moisture', 'water leak']);
    const moistureAlerts = moisture.filter(item => item?.active !== false && ['critical', 'attention'].includes(String(item?.priority || '').toLowerCase()));
    const cameraAction = homeStatusObject(this._config?.context_actions?.cameras);
    const cameraPath = String(cameraAction?.path || '').trim();
    const cameraHealth = (data?.active || []).find(item => item?.category === 'cameras' || item?.event_type === 'camera_offline');
    const presence = first(['everyone home', 'everyone away', 'household presence', 'household']);
    const envCandidates = by(['air quality', 'humidity', 'indoor temperature', 'environment']).filter(item => {
      const hay = this._visualModeHay(item);
      return !/outside|weather|forecast/.test(hay);
    });
    const environment = envCandidates[0] || null;
    const envText = environment ? `${environment?.title || ''} ${environment?.message || ''} ${environment?.state || ''}` : '';
    const envNumber = (envText.match(/(-?\d+(?:\.\d+)?)\s*(?:%|°|aqi)?/i) || [])[1];
    const envMetric = (terms, unitPattern) => {
      const candidate = envCandidates.find(item => terms.some(term => this._visualModeHay(item).includes(term)));
      if (!candidate) return null;
      const raw = `${candidate?.title || ''} ${candidate?.message || ''} ${candidate?.state || ''} ${candidate?.summary || ''}`;
      const match = raw.match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(${unitPattern})?`, 'i'));
      if (!match) return null;
      return { value: match[1], unit: match[2] || '', entity: candidate.entity_id || '' };
    };
    const indoorTemp = envMetric(['indoor temperature', 'inside temperature'], '[°º]?[fFcC]?');
    const indoorHumidity = envMetric(['humidity'], '%');
    const airQuality = envMetric(['air quality', 'aqi'], 'aqi');
    const rainDelay = first(['rain delay']);
    const nextWatering = first(['next watering']);
    const recycling = first(['recycling']);
    const garbage = first(['garbage']);
    const traffic = first(['traffic', 'commute']);
    const calendar = first(['calendar']);

    const securityTiles = [];
    if (contacts.length) {
      securityTiles.push({ name: 'Doors / Windows', value: openContacts.length ? `${openContacts.length} Open` : 'Closed', icon: openContacts.length ? 'mdi:door-open' : 'mdi:door-closed', entity: contacts[0]?.entity_id || '', alert: openContacts.length > 0 });
    }
    if (locks.length) {
      securityTiles.push({ name: 'Locks', value: lockAlerts.length ? `${lockAlerts.length} Unlocked` : 'Locked', icon: lockAlerts.length ? 'mdi:lock-open-alert' : 'mdi:lock', entity: locks[0]?.entity_id || '', alert: lockAlerts.length > 0 });
    }
    if (moisture.length) {
      securityTiles.push({ name: 'Leaks', value: moistureAlerts.length ? `${moistureAlerts.length} Alert` : 'Dry', icon: moistureAlerts.length ? 'mdi:water-alert' : 'mdi:water-check-outline', entity: moisture[0]?.entity_id || '', alert: moistureAlerts.length > 0 });
    }
    if (securityTiles.length < 3 && cameraPath) {
      securityTiles.push({ name: 'Cameras', value: cameraHealth ? 'Needs Attention' : 'View Cameras', icon: cameraHealth ? 'mdi:cctv-off' : 'mdi:cctv', entity: '', path: cameraPath, alert: Boolean(cameraHealth) });
    }
    const securityAlertCount = openContacts.length + lockAlerts.length + moistureAlerts.length;
    if (securityTiles.length < 3 || securityAlertCount) {
      securityTiles.push({ name: 'Alerts', value: securityAlertCount ? String(securityAlertCount) : 'None', icon: securityAlertCount ? 'mdi:alert-circle-outline' : 'mdi:check-circle-outline', entity: '', alert: securityAlertCount > 0 });
    }
    while (securityTiles.length < 3) {
      securityTiles.push({ name: 'Status', value: 'Clear', icon: 'mdi:shield-check-outline', entity: '', alert: false });
    }

    const glance = [];
    if (rainDelay) glance.push(this._visualModeNamedTile('Rain Delay', rainDelay, 'OFF', 'mdi:weather-rainy', 'water'));
    if (nextWatering) glance.push(this._visualModeNamedTile('Next Watering', nextWatering, 'Ready', 'mdi:sprinkler-variant', 'water'));
    if (recycling) glance.push(this._visualModeNamedTile('Recycling', recycling, 'Clear', 'mdi:recycle', 'waste'));
    if (garbage) glance.push(this._visualModeNamedTile('Garbage', garbage, 'Clear', 'mdi:trash-can-outline', 'waste'));
    if (traffic && glance.length < 4) glance.push(this._visualModeNamedTile('Traffic', traffic, 'Clear', 'mdi:car', 'traffic'));
    if (calendar && glance.length < 4) glance.push(this._visualModeNamedTile('Calendar', calendar, 'Today', 'mdi:calendar-month', 'calendar'));
    while (glance.length < 4) {
      const fallback = [
        { name: 'Household', value: presence ? (presence?.title || presence?.message || 'Home') : 'Home', detail: presence ? this._visualModeDetail(presence) : '', icon: 'mdi:home-account', tone: 'presence', entity: presence?.entity_id || '', alert: false },
        { name: 'Environment', value: environment ? (environment?.title || environment?.message || environment?.state || 'Good') : 'Good', detail: environment ? this._visualModeDetail(environment) : '', icon: environment?.icon || 'mdi:leaf', tone: 'environment', entity: environment?.entity_id || '', alert: false }
      ][glance.length % 2];
      if (!glance.some(tile => tile.name === fallback.name)) glance.push(fallback); else break;
    }

    return {
      securityTiles,
      presence: {
        name: 'Household',
        value: presence ? (presence?.title || presence?.message || presence?.state || 'Home') : 'Home',
        detail: presence ? this._visualModeFriendlyWhen(this._visualModeDetail(presence)) : 'Current presence',
        icon: presence?.icon || 'mdi:account-group',
        entity: presence?.entity_id || ''
      },
      environment: {
        name: 'Environment',
        value: environment ? (environment?.title || environment?.message || environment?.state || 'Good') : 'Good',
        detail: environment ? this._visualModeFriendlyWhen(this._visualModeDetail(environment)) : 'Comfort',
        icon: environment?.icon || 'mdi:leaf',
        entity: environment?.entity_id || '',
        number: envNumber ? Number(envNumber) : null,
        metrics: { indoorTemp, indoorHumidity, airQuality }
      },
      glance
    };
  }

  _visualModeSecurityTileMarkup(tile) {
    const tap = tile.path ? ` data-visual-path="${this._escape(tile.path)}"` : (tile.entity ? ` data-visual-entity="${this._escape(tile.entity)}"` : ' disabled');
    return `<button class="visual-security-tile ${tile.alert ? 'has-alert' : ''}" type="button"${tap}><span class="visual-security-tile-icon"><ha-icon icon="${this._escape(tile.icon)}"></ha-icon></span><strong>${this._escape(tile.name)}</strong><small>${this._escape(tile.value)}</small>${tile.path || tile.entity ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}</button>`;
  }

  _visualModeGlanceTileMarkup(tile) {
    const role = /watering|rain delay/i.test(tile.name) ? 'watering' : (/recycling|garbage/i.test(tile.name) ? 'waste' : (/traffic/i.test(tile.name) ? 'traffic' : (/calendar/i.test(tile.name) ? 'calendar' : '')));
    const path = role ? this._visualModeNavigationPath(role) : '';
    const tap = path ? ` data-visual-path="${this._escape(path)}"` : (tile.entity ? ` data-visual-entity="${this._escape(tile.entity)}"` : ' disabled');
    return `<button class="visual-glance-tile ${this._escape(tile.tone || '')} ${tile.alert ? 'has-alert' : ''}" type="button"${tap}><span class="visual-glance-tile-icon"><ha-icon icon="${this._escape(tile.icon)}"></ha-icon></span><span class="visual-glance-tile-copy"><small>${this._escape(tile.name)}</small><strong>${this._escape(tile.value)}</strong>${tile.detail ? `<em>${this._escape(tile.detail)}</em>` : ''}</span>${path || tile.entity ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}</button>`;
  }

  _visualModeSpotlightItems(data) {
    const current = this._visualModeCurrentItems(data);
    const score = item => {
      const priority = String(item?.priority || '').toLowerCase();
      const hay = this._visualModeHay(item);
      let value = priority === 'critical' ? 100 : (priority === 'attention' ? 70 : 20);
      if (/repair|authentication|expired|unavailable|offline|fault|error|leak|alarm|open/.test(hay)) value += 25;
      if (/garbage|recycling|next watering|household|weather/.test(hay)) value -= 20;
      return value;
    };
    return current.filter(item => item?.active !== false).sort((a, b) => score(b) - score(a)).filter(item => score(item) >= 70).slice(0, 3);
  }

  _visualModeSpotlightMarkup(data) {
    const items = this._visualModeSpotlightItems(data);
    if (!items.length) return '';
    const top = items[0];
    const critical = String(top?.priority || '').toLowerCase() === 'critical';
    const title = top?.title || top?.name || 'Needs attention';
    const detail = this._visualModeDetail(top) || top?.message || top?.state || '';
    const entity = top?.entity_id || '';
    return `<div class="visual-priority-spotlight ${critical ? 'is-critical' : 'is-attention'}"${entity ? ` data-visual-entity="${this._escape(entity)}"` : ''}>
      <span class="visual-priority-pulse"><ha-icon icon="${this._escape(top?.icon || (critical ? 'mdi:alert-octagon' : 'mdi:alert-circle'))}"></ha-icon></span>
      <span class="visual-priority-copy"><small>${critical ? 'NEEDS ATTENTION NOW' : 'HOME STATUS • ATTENTION'}</small><strong>${this._escape(title)}</strong>${detail ? `<em>${this._escape(detail)}</em>` : ''}</span>
      ${items.length > 1 ? `<b class="visual-priority-count">+${items.length - 1}</b>` : ''}
    </div>`;
  }

  _visualModeAdaptiveZone(data, appliances = this._visualModeApplianceItems(data)) {
    const attention = this._visualModeSpotlightItems(data).filter(item => !/(?:door|window|garage door)/i.test(this._visualModeHay(item)));
    if (attention.length) {
      return {
        mode: 'attention',
        title: attention.some(item => String(item?.priority || '').toLowerCase() === 'critical') ? 'NEEDS ATTENTION' : 'HOME STATUS',
        icon: attention.some(item => String(item?.priority || '').toLowerCase() === 'critical') ? 'mdi:alert-octagon' : 'mdi:alert-circle-outline',
        items: attention
      };
    }
    if (appliances.length) {
      return { mode: 'appliances', title: 'APPLIANCES', icon: 'mdi:washing-machine', items: appliances };
    }
    return { mode: 'quiet', title: 'ALL QUIET', icon: 'mdi:check-circle-outline', items: [] };
  }

  _visualModeAdaptiveZoneMarkup(data, appliances = this._visualModeApplianceItems(data)) {
    const zone = this._visualModeAdaptiveZone(data, appliances);
    const appliancePath = this._visualModeNavigationPath('appliances');
    let body = '';
    if (zone.mode === 'attention') {
      body = zone.items.map((item, index) => {
        const critical = String(item?.priority || '').toLowerCase() === 'critical';
        const entity = item?.entity_id || '';
        const title = item?.title || item?.name || item?.message || 'Needs attention';
        const detail = this._visualModeDetail(item) || item?.message || item?.state || '';
        return `<button class="visual-adaptive-alert ${critical ? 'is-critical' : 'is-attention'}" type="button"${entity ? ` data-visual-entity="${this._escape(entity)}"` : ' disabled'}>
          <span class="visual-adaptive-alert-icon"><ha-icon icon="${this._escape(item?.icon || (critical ? 'mdi:alert-octagon' : 'mdi:alert-circle'))}"></ha-icon></span>
          <span class="visual-adaptive-alert-copy"><small>${index === 0 ? (critical ? 'ACTION NEEDED' : 'NEEDS ATTENTION') : 'ALSO ACTIVE'}</small><strong>${this._escape(title)}</strong>${detail ? `<em>${this._escape(detail)}</em>` : ''}</span>
          ${entity ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}
        </button>`;
      }).join('');
    } else if (zone.mode === 'appliances') {
      body = zone.items.map(item => this._visualModeModuleItemMarkup(item)).join('');
    } else {
      body = `<div class="visual-adaptive-quiet"><span class="visual-quiet-orb"><ha-icon icon="mdi:check"></ha-icon></span><span><strong>Nothing needs attention</strong><small>Home Status is watching the house.</small></span></div>`;
    }
    return {
      ...zone,
      markup: `<div class="visual-panel-heading visual-adaptive-heading"><span><ha-icon icon="${this._escape(zone.icon)}"></ha-icon><b>${this._escape(zone.title)}</b></span>${zone.mode === 'appliances' && appliancePath ? '<ha-icon icon="mdi:chevron-right"></ha-icon>' : ''}</div><div class="visual-adaptive-body">${body}</div>`,
      path: zone.mode === 'appliances' ? appliancePath : ''
    };
  }

  _visualModeHouseholdMarkup(model) {
    const tile = model.presence;
    const path = this._visualModeNavigationPath('household');
    const names = String(tile.detail || '').split(/[,•]/).map(value => value.trim()).filter(value => value && !/current presence/i.test(value)).slice(0, 5);
    const people = names.length
      ? names.map(name => `<span class="visual-household-person"><span class="visual-household-person-orb"><ha-icon icon="mdi:account"></ha-icon></span><b>${this._escape(name)}</b></span>`).join('')
      : `<span class="visual-household-person"><span class="visual-household-person-orb"><ha-icon icon="mdi:home-account"></ha-icon></span><b>Home</b></span>`;
    return `<div class="visual-household-shell"${path ? ` data-visual-path="${this._escape(path)}"` : ''}>
      <div class="visual-household-heading"><span class="visual-household-orb"><ha-icon icon="${this._escape(tile.icon)}"></ha-icon></span><span><small>HOUSEHOLD</small><strong>${this._escape(tile.value)}</strong><em>${names.length ? names.join(', ') : 'Current presence'}</em></span>${path ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}</div>
      <div class="visual-household-people-grid">${people}</div>
    </div>`;
  }

  _visualModeEnvironmentMarkup(model) {
    const tile = model.environment;
    const tap = tile.entity ? ` data-visual-entity="${this._escape(tile.entity)}"` : ' disabled';
    const numeric = Number.isFinite(tile.number) ? Math.max(0, Math.min(100, tile.number)) : null;
    const ringStyle = numeric === null ? '' : ` style="--visual-ring:${numeric * 3.6}deg"`;
    const metrics = tile.metrics || {};
    const metricMarkup = [
      metrics.indoorTemp ? ['mdi:thermometer', metrics.indoorTemp, 'Temp'] : null,
      metrics.indoorHumidity ? ['mdi:water-percent', metrics.indoorHumidity, 'Humidity'] : null,
      metrics.airQuality ? ['mdi:leaf', metrics.airQuality, 'AQI'] : null
    ].filter(Boolean).map(([icon, metric, label]) => `<span class="visual-env-metric"${metric.entity ? ` data-visual-entity="${this._escape(metric.entity)}"` : ''}><ha-icon icon="${icon}"></ha-icon><b>${this._escape(metric.value)}${this._escape(metric.unit || '')}</b><small>${label}</small></span>`).join('');
    return `<button class="visual-environment-primary" type="button"${tap}><span class="visual-environment-ring"${ringStyle}><ha-icon icon="${this._escape(tile.icon)}"></ha-icon></span><span><small>ENVIRONMENT</small><strong>${this._escape(tile.value)}</strong><em>${this._escape(tile.detail)}</em></span>${tile.entity ? '<ha-icon class="visual-tap-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}</button>${metricMarkup ? `<div class="visual-env-metrics">${metricMarkup}</div>` : ''}`;
  }

  _visualModeMusicMarkup() {
    const music = this._utilityMusicState();
    const idle = music.available && !music.playing && music.value !== 'paused';
    const musicPath = this._visualModeNavigationPath('music');
    const entityTap = musicPath ? ` data-visual-path="${this._escape(musicPath)}"` : (music.entity ? ` data-visual-entity="${this._escape(music.entity)}"` : '');
    const playCommand = music.playing ? 'media_pause' : 'media_play';
    const playIcon = music.playing ? 'mdi:pause' : 'mdi:play';
    const sourceOptions = music.sources.map(source => `<button type="button" data-visual-music-source="${this._escape(source)}" class="${source === music.source ? 'is-selected' : ''}"><ha-icon icon="${source === music.source ? 'mdi:check' : 'mdi:speaker'}"></ha-icon><span>${this._escape(source)}</span></button>`).join('');
    const sourceSelector = music.sources.length ? `<div class="visual-music-source-wrap"><button class="visual-music-source-trigger" type="button" data-visual-source-toggle aria-expanded="false" aria-label="Choose music source"><ha-icon icon="mdi:speaker-multiple"></ha-icon><span>${this._escape(music.source || 'Choose source')}</span><ha-icon icon="mdi:chevron-down"></ha-icon></button><div class="visual-music-source-menu" data-visual-source-menu hidden>${sourceOptions}</div></div>` : '';

    if (idle) {
      return `<div class="visual-music-shell visual-music-idle"${entityTap}><span class="visual-music-idle-icon"><ha-icon icon="mdi:music-note"></ha-icon></span>${sourceSelector || '<span class="visual-music-idle-source">Music</span>'}<button class="visual-music-play visual-music-idle-play" type="button" data-music-command="media_play" aria-label="Play"><ha-icon icon="mdi:play"></ha-icon></button></div>`;
    }

    const artwork = music.artwork ? `<img class="visual-music-artwork" src="${this._escape(music.artwork)}" alt="" loading="lazy">` : `<span class="visual-music-artwork visual-music-artwork-fallback"><ha-icon icon="${this._escape(music.icon)}"></ha-icon></span>`;
    const volume = Math.round((music.volume || 0) * 100);
    return `<div class="visual-music-shell visual-music-active"${entityTap}>
      ${artwork}
      <div class="visual-music-copy"><strong>${this._escape(music.title)}</strong><em>${this._escape(music.secondary)}</em></div>
      <div class="visual-music-controls"><button type="button" data-music-command="media_previous_track" aria-label="Previous"><ha-icon icon="mdi:skip-previous"></ha-icon></button><button class="visual-music-play" type="button" data-music-command="${playCommand}" aria-label="${music.playing ? 'Pause' : 'Play'}"><ha-icon icon="${playIcon}"></ha-icon></button><button type="button" data-music-command="media_next_track" aria-label="Next"><ha-icon icon="mdi:skip-next"></ha-icon></button></div>
      ${sourceSelector}
      <div class="visual-music-volume"><ha-icon data-visual-music-volume-icon icon="${volume === 0 ? 'mdi:volume-off' : volume < 50 ? 'mdi:volume-medium' : 'mdi:volume-high'}"></ha-icon><input type="range" min="0" max="1" step="0.01" value="${music.volume || 0}" data-visual-music-volume aria-label="Music volume" aria-valuetext="${volume} percent"><b data-visual-music-volume-label>${volume}%</b></div>
    </div>`;
  }

  _visualModeFlowCard(title, icon, body, size = 'medium', path = '', extra = '') {
    return `<section class="visual-flow-card visual-panel size-${size} ${extra}"${path ? ` data-visual-path="${this._escape(path)}"` : ''}><div class="visual-panel-heading"><span><ha-icon icon="${this._escape(icon)}"></ha-icon><b>${this._escape(title)}</b></span>${path ? '<ha-icon icon="mdi:chevron-right"></ha-icon>' : ''}</div>${body}</section>`;
  }

  _visualModePresentationCandidates(data, appliances, model) {
    const current = this._visualModeCurrentItems(data);
    const hay = item => this._visualModeHay(item);
    const candidates = [];
    const add = (key, kind, markup, target = {}) => candidates.push({ key, kind, markup, ...target });

    // Active appliances are useful NOW. Quiet/all-clear appliances do not get a slot.
    for (const item of appliances.slice(0, 4)) {
      const title = item?.title || item?.message || 'Appliance';
      const detail = this._visualModeDetail(item) || item?.state || '';
      add(`appliance:${item?.entity_id || title}`, 'appliance', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="${this._escape(item?.icon || 'mdi:washing-machine')}"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(title)}</strong><b>${this._escape(detail)}</b></div></div>`, item?.entity_id ? { entity: item.entity_id } : { path: this._visualModeNavigationPath('appliances') });
    }

    // Household is a single summary, never a repeated person list.
    const household = model?.presence || {};
    const householdTitle = household.value || household.label || household.title || 'Home';
    const householdDetail = household.detail || household.summary || 'Current presence';
    add('household:summary', 'household', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="mdi:home-account"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(householdTitle)}</strong><b>${this._escape(householdDetail)}</b></div></div>`, { path: this._visualModeNavigationPath('household') });

    // Each route is its own glanceable presentation.
    const trafficItems = current.filter(item => /traffic|commute/.test(hay(item))).slice(0, 6);
    for (const item of trafficItems) {
      const raw = String(item?.title || item?.message || 'Traffic').trim();
      const match = raw.match(/^(.+?):\s*(\d+)\s*min/i);
      const place = match ? match[1] : raw;
      const value = match ? `${match[2]} MIN` : (this._visualModeDetail(item) || item?.state || '');
      add(`traffic:${item?.entity_id || raw}`, 'traffic', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="${this._escape(item?.icon || 'mdi:car-clock')}"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(place)}</strong><span class="visual-presentation-value">${this._escape(value)}</span><b>${this._escape(match ? (this._visualModeDetail(item) || 'Travel time') : 'Travel time')}</b></div></div>`, item?.entity_id ? { entity: item.entity_id } : { path: this._visualModeNavigationPath('traffic') });
    }

    // Calendar events rotate individually so titles can stay large and readable.
    const calendarItems = (Array.isArray(data?.calendar) ? data.calendar : [])
      .filter(item => !/garbage|recycling|waste/.test(hay(item)))
      // Visit Jacksonville is a Visual Center source. Keep those event cards out of
      // the three-slot Calendar rotation so the same event is never presented twice.
      .filter(item => {
        const source = `${item?.source || ''} ${item?.source_name || ''} ${item?.source_id || ''} ${item?.provider || ''} ${item?.provider_name || ''} ${item?.feed || ''} ${item?.feed_name || ''} ${item?.calendar || ''} ${item?.calendar_name || ''} ${item?.entity_id || ''}`.toLowerCase();
        return !/(?:visit[ _-]?jacksonville|visit[ _-]?jax|visitjax)/i.test(source);
      })
      .slice(0, 6);
    for (const item of calendarItems) {
      const title = item?.title || item?.message || 'Upcoming event';
      const when = this._visualModeFriendlyWhen(item?.scheduled_at || item?.event_start || this._visualModeDetail(item) || item?.state || '');
      add(`calendar:${item?.entity_id || title}`, 'calendar', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="${this._escape(item?.icon || 'mdi:calendar-star')}"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(title)}</strong><span class="visual-presentation-value visual-presentation-value-small">${this._escape(when)}</span></div></div>`, item?.entity_id ? { entity: item.entity_id } : { path: this._visualModeNavigationPath('calendar') });
    }

    // Sports keeps a scoreboard treatment inside the same fixed slot geometry.
    const sportsItems = current.filter(item => /football|nfl|college football|scoreboard|sports|game/.test(hay(item)) && !/video game|game room/.test(hay(item))).slice(0, 4);
    for (const item of sportsItems) {
      const message = String(item?.message || item?.title || 'Game').trim();
      let away = '', home = '', awayScore = '', homeScore = '';
      let match = message.match(/^(.+?)\s+(\d+)\s*[·•]\s*(.+?)\s+(\d+)$/);
      if (match) [, away, awayScore, home, homeScore] = match;
      else { match = message.match(/^(.+?)\s+@\s+(.+)$/); if (match) [, away, home] = match; }
      const state = String(item?.sports_state || item?.state || '').toLowerCase();
      const when = this._visualModeFriendlyWhen(item?.scheduled_at || item?.detail || item?.summary || '');
      const score = away && home ? `${awayScore || away} ${awayScore ? '–' : '@'} ${homeScore || home}` : message;
      const sub = state === 'final' ? 'Final' : state === 'live' ? 'Live' : (when || 'Upcoming');
      add(`sports:${item?.entity_id || message}`, 'sports', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="${this._escape(item?.icon || 'mdi:football')}"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(away && home && awayScore ? `${away} vs ${home}` : (away && home ? `${away} @ ${home}` : 'Sports'))}</strong><span class="visual-presentation-value">${this._escape(score)}</span><b>${this._escape(sub)}</b></div></div>`, item?.entity_id ? { entity: item.entity_id } : { path: this._visualModeNavigationPath('sports') });
    }

    // Watering / waste are compact facts, promoted one at a time to a large readable slot.
    for (const tile of (model?.glance || []).filter(tile => /rain delay|watering|recycling|garbage/i.test(tile?.name || '')).slice(0, 6)) {
      const title = tile?.name || 'Home';
      const value = tile?.value || tile?.state || tile?.detail || '';
      const detail = tile?.detail || tile?.secondary || '';
      const role = /rain delay|watering/i.test(title) ? 'watering' : 'waste';
      add(`glance:${title}`, 'glance', `<div class="visual-presentation-inner"><ha-icon class="visual-presentation-icon" icon="${this._escape(tile?.icon || 'mdi:home-outline')}"></ha-icon><div class="visual-presentation-copy"><strong>${this._escape(title)}</strong><span class="visual-presentation-value visual-presentation-value-small">${this._escape(value)}</span>${detail && detail !== value ? `<b>${this._escape(detail)}</b>` : ''}</div></div>`, tile?.entity ? { entity: tile.entity } : { path: this._visualModeNavigationPath(role) });
    }

    return candidates;
  }

  _visualModeDynamicFlow(data, appliances, model) {
    const candidates = this._visualModePresentationCandidates(data, appliances, model);
    if (!candidates.length) return '';
    const pageCount = Math.max(1, Math.ceil(candidates.length / 3));
    const page = ((this._visualPresentationPage || 0) % pageCount + pageCount) % pageCount;
    const selected = candidates.slice(page * 3, page * 3 + 3);
    if (selected.length < 3 && candidates.length > selected.length) {
      for (const candidate of candidates) {
        if (selected.length >= 3) break;
        if (!selected.some(item => item.key === candidate.key)) selected.push(candidate);
      }
    }
    return selected.map(item => {
      const target = item.entity ? ` data-visual-entity="${this._escape(item.entity)}"` : (item.path ? ` data-visual-path="${this._escape(item.path)}"` : '');
      const interactive = target ? ' is-tappable' : '';
      return `<section class="visual-presentation-slot type-${this._escape(item.kind)}${interactive}" data-presentation-key="${this._escape(item.key)}"${target}>${item.markup}</section>`;
    }).join('');
  }

  _ensureVisualPresentationRotation(data, appliances, model) {
    const candidates = this._visualModePresentationCandidates(data, appliances, model);
    const pages = [];
    for (let index = 0; index < candidates.length; index += 3) {
      const pageItems = candidates.slice(index, index + 3);
      if (pageItems.length < 3 && candidates.length > pageItems.length) {
        for (const candidate of candidates) {
          if (pageItems.length >= 3) break;
          if (!pageItems.some(item => item.key === candidate.key)) pageItems.push(candidate);
        }
      }
      pages.push({ id: pageItems.map(item => item.key).join('|'), items: pageItems });
    }

    const seconds = Math.max(4, Number(data?.display?.rotation_seconds) || Number(this._config?.rotation_seconds) || 7);
    const signature = pages.map(page => page.id).join('||');
    const controller = this._visualPresentationController;
    if (!controller) return;

    // This is the same v1 controller/scheduler contract used by the original
    // physical lane slots: preserve the current item, align to the shared
    // cycle epoch, and let _scheduleLaneCycle/_runLaneCycle own advancement.
    if (controller.signature !== signature || controller.intervalSeconds !== seconds) {
      controller.configure({ items: pages, intervalSeconds: seconds, rotate: true, signature });
      this._scheduleLaneCycle();
    }
  }

  _renderVisualPresentationPage() {
    const flow = this.shadowRoot?.querySelector('[data-visual-dynamic-flow]');
    if (!flow) return;
    const runtime = this._getRuntimeData();
    const appliances = this._visualModeApplianceItems(runtime);
    const model = this._visualModeDashboardModel(runtime);
    flow.innerHTML = this._visualModeDynamicFlow(runtime, appliances, model);
    this._bind();
  }

  _renderVisualDashboard(data) {
    this._ensureVisibilityObserver();
    this.dataset.laneMode = this._config?.lane_mode || 'slots';
    if (data.unavailable) {
      this.shadowRoot.innerHTML = `${this._styles()}<ha-card class="home-status-unavailable"><div><strong>Home Status is unavailable</strong><span>Choose a valid Home Status sensor in the card editor, or finish setting up the integration.</span><code>${this._escape(this._config.entity)}</code></div></ha-card>`;
      return;
    }

    const configuredMedia = this._config.display?.media_enabled;
    const globalVisualCenterEnabled = data.display?.visual_center_enabled !== false;
    this._mediaEnabled = globalVisualCenterEnabled && (configuredMedia === undefined ? data.display?.media_enabled !== false : configuredMedia !== false);

    const security = this._visualModeSecurityState(data);
    const securityEntity = this._config?.utility_header?.security_entity || this._visualModeCurrentItems(data).find(item => String(item?.entity_id || '').startsWith('alarm_control_panel.'))?.entity_id || '';
    const weather = this._visualModeWeatherState(data);
    const weatherEntity = this._visualModeCurrentItems(data).find(item => String(item?.entity_id || '').startsWith('weather.'))?.entity_id || '';
    const securityPath = this._visualModeNavigationPath('security');
    const camerasPath = this._visualModeNavigationPath('cameras');
    const lightingPath = this._visualModeNavigationPath('lighting');
    const weatherPath = this._visualModeNavigationPath('radar') || this._visualModeNavigationPath('weather');
    const appliances = this._visualModeApplianceItems(data);
    const model = this._visualModeDashboardModel(data);
    const recentItems = this._buildFooterStream(data);
    const musicMarkup = this._visualModeMusicMarkup();
    const flowMarkup = this._visualModeDynamicFlow(data, appliances, model);
    this._ensureVisualPresentationRotation(data, appliances, model);
    this._ensureVisualWeatherForecast(data);

    this._destroyVisualHls(this.shadowRoot.querySelector('[data-visual-center]'));
    this.shadowRoot.innerHTML = `${this._styles()}
      <ha-card class="visual-dashboard-card visual-clean-dashboard">
        <div class="visual-clean-shell">
          <div class="visual-clean-top">
            <section class="visual-clean-security ${security.secure ? 'is-clear' : 'has-alert'} beacon-${this._escape(security.beacon)}" data-visual-security${securityPath ? ` data-visual-path="${this._escape(securityPath)}"` : (securityEntity ? ` data-visual-entity="${this._escape(securityEntity)}"` : '')}>
              <div class="visual-security-hero"><div class="visual-security-ring"><span class="visual-security-beacon-core"><ha-icon data-visual-security-icon icon="${security.icon}"></ha-icon></span></div><div class="visual-security-state-copy"><strong data-visual-security-label>${this._escape(security.label)}</strong><small data-visual-security-detail>${this._escape(security.detail)}</small></div></div>
              <div class="visual-security-shortcuts">
                ${camerasPath ? `<button type="button" data-visual-path="${this._escape(camerasPath)}" aria-label="Open Cameras dashboard"><ha-icon icon="mdi:cctv"></ha-icon><span>Cameras</span></button>` : ''}
                ${lightingPath ? `<button type="button" data-visual-path="${this._escape(lightingPath)}" aria-label="Open Lighting dashboard"><ha-icon icon="mdi:lightbulb-outline"></ha-icon><span>Lighting</span></button>` : ''}
              </div>
              <div class="visual-security-tile-row" data-visual-security-stats>${model.securityTiles.filter(tile => !/doors?\s*\/?\s*windows?|alerts?|status|cameras?/i.test(String(tile?.name || ''))).map(tile => this._visualModeSecurityTileMarkup(tile)).join('')}</div>
            </section>

            <section class="visual-clean-center">
              <div class="visual-center visual-mode-center" data-visual-center></div>
            </section>

            <section class="visual-clean-music" data-visual-music>${musicMarkup}</section>
          </div>

          <section class="visual-clean-weather is-tappable" aria-label="Weather — tap for radar"${weatherPath ? ` data-visual-path="${this._escape(weatherPath)}"` : (weatherEntity ? ` data-visual-entity="${this._escape(weatherEntity)}"` : '')}>
            <div class="visual-weather-face" data-visual-weather-face data-weather-face="forecast">${this._visualWeatherFaceMarkup({ id: 'forecast', type: 'forecast', weather }, data)}</div>
          </section>

          <section class="visual-clean-content">
            <div class="visual-v20-flow" data-visual-dynamic-flow>${flowMarkup}</div>
          </section>
        </div>

        <button class="ticker visual-mode-ticker priority-${this._escape(data.priority)}${recentItems.length ? '' : ' ticker-empty'}" type="button" aria-expanded="${this._drawerOpen}"><span class="visual-rail-label"><ha-icon icon="mdi:home-assistant"></ha-icon><span><strong>RECENT</strong><small>Live updates • Last 6 hours</small></span></span><span class="ticker-footer"><span class="bottom-stream" data-zone="bottom"></span></span></button>
        <div class="drawer-host"></div>
      </ha-card>`;

    this._weatherRenderer.mount(this.shadowRoot.querySelector('.visual-dashboard-card'));
    this._weatherRenderer.setEffect(this._weatherVisualEffect(data));
    this._weatherRenderer.setVisible(this._ambientVisible);
    this._baseVisual = data.visual;
    this._syncVisualQueue(data);
    this._syncDisplayedVisual();
    this._renderFooterStream(recentItems);
    this._syncVisualWeatherRotation(data);
    this._updateDrawer(data);
    this._bind();
  }

  _updateVisualDashboard(data) {
    this._ensureVisualWeatherForecast(data);
    const card = this.shadowRoot.querySelector('.visual-dashboard-card');
    if (!card) { this._renderVisualDashboard(data); return; }
    const security = this._visualModeSecurityState(data);
    const weather = this._visualModeWeatherState(data);
    const model = this._visualModeDashboardModel(data);
    const adaptiveMode = this._visualModeAdaptiveZone(data).mode;
    const grid = card.querySelector('.visual-v5-grid');
    if (grid) {
      grid.classList.toggle('has-priority-zone', adaptiveMode === 'attention');
      grid.classList.toggle('has-no-appliances', adaptiveMode === 'quiet');
      grid.classList.toggle('has-light-appliances', adaptiveMode === 'appliances' && this._visualModeApplianceItems(data).length === 1);
      grid.classList.toggle('has-busy-appliances', adaptiveMode === 'appliances' && this._visualModeApplianceItems(data).length > 1);
    }
    const securityModule = card.querySelector('[data-visual-security]');
    securityModule?.classList.toggle('is-clear', security.secure); securityModule?.classList.toggle('has-alert', !security.secure);
    card.querySelector('[data-visual-security-icon]')?.setAttribute('icon', security.icon);
    const sl = card.querySelector('[data-visual-security-label]'); if (sl) sl.textContent = security.label;
    const sd = card.querySelector('[data-visual-security-detail]'); if (sd) sd.textContent = security.secure ? '' : `${security.count} condition${security.count === 1 ? '' : 's'} need attention`;
    const ss = card.querySelector('[data-visual-security-stats]'); if (ss) ss.innerHTML = model.securityTiles.filter(tile => !/doors?\s*\/?\s*windows?|alerts?|status|cameras?/i.test(String(tile?.name || ''))).map(tile => this._visualModeSecurityTileMarkup(tile)).join('');
    this._syncVisualWeatherRotation(data);
    const weatherFace = card.querySelector('[data-visual-weather-face]');
    if (weatherFace?.dataset.weatherFace === 'forecast') {
      card.querySelector('[data-visual-weather-icon]')?.setAttribute('icon', weather.icon);
      const wt = card.querySelector('[data-visual-weather-temp]'); if (wt) wt.textContent = weather.temperature || '--';
      const wc = card.querySelector('[data-visual-weather-condition]'); if (wc) wc.textContent = weather.condition || 'Weather';
      const wh = card.querySelector('[data-visual-weather-humidity]'); if (wh) wh.textContent = weather.humidity || '--';
    }
    const household = card.querySelector('[data-visual-household]'); if (household) household.innerHTML = this._visualModeHouseholdMarkup(model);
    const music = card.querySelector('[data-visual-music]'); if (music) music.innerHTML = this._visualModeMusicMarkup();
    const glance = card.querySelector('[data-visual-glance]'); if (glance) glance.innerHTML = model.glance.slice(0, 4).map(tile => this._visualModeGlanceTileMarkup(tile)).join('');
    const appliances = this._visualModeApplianceItems(data);
    this._ensureVisualPresentationRotation(data, appliances, model);
    const flow = card.querySelector('[data-visual-dynamic-flow]');
    if (flow) {
      const markup = this._visualModeDynamicFlow(data, appliances, model);
      const template = document.createElement('template');
      template.innerHTML = markup;
      const nextSlots = [...template.content.querySelectorAll('[data-presentation-key]')];
      const liveSlots = [...flow.querySelectorAll('[data-presentation-key]')];
      const nextKeys = nextSlots.map(slot => slot.dataset.presentationKey || '').join('|');
      const liveKeys = liveSlots.map(slot => slot.dataset.presentationKey || '').join('|');

      if (nextKeys !== liveKeys) {
        // A real membership/page change may replace the slots. Ordinary HA state
        // updates never replace the three live slot nodes, which prevents the
        // random blink that looked like an unscheduled rotation.
        flow.innerHTML = markup;
        this._bind();
      } else {
        // Refresh changing values in place. Preserve each slot element so text,
        // scores, times and states can update without flashing the presentation.
        liveSlots.forEach((live, index) => {
          const next = nextSlots[index];
          if (!next) return;
          const liveIcon = live.querySelector('.visual-presentation-icon');
          const nextIcon = next.querySelector('.visual-presentation-icon');
          if (liveIcon && nextIcon) {
            const icon = nextIcon.getAttribute('icon');
            if (icon && liveIcon.getAttribute('icon') !== icon) liveIcon.setAttribute('icon', icon);
          }
          const selectors = ['strong', '.visual-presentation-value', 'b'];
          selectors.forEach(selector => {
            const liveNodes = [...live.querySelectorAll(selector)];
            const nextNodes = [...next.querySelectorAll(selector)];
            liveNodes.forEach((node, nodeIndex) => {
              const nextNode = nextNodes[nodeIndex];
              if (nextNode && node.textContent !== nextNode.textContent) node.textContent = nextNode.textContent;
            });
          });
          for (const attr of ['data-visual-entity', 'data-visual-path']) {
            const value = next.getAttribute(attr);
            if (value === null) live.removeAttribute(attr);
            else if (live.getAttribute(attr) !== value) live.setAttribute(attr, value);
          }
          live.classList.toggle('is-tappable', next.classList.contains('is-tappable'));
        });
      }
    }
    const configuredMedia = this._config.display?.media_enabled, globalVisualCenterEnabled = data.display?.visual_center_enabled !== false; this._mediaEnabled = globalVisualCenterEnabled && (configuredMedia === undefined ? data.display?.media_enabled !== false : configuredMedia !== false);
    this._weatherRenderer.mount(card); this._weatherRenderer.setEffect(this._weatherVisualEffect(data)); this._weatherRenderer.setVisible(this._ambientVisible); this._baseVisual = data.visual; this._syncVisualQueue(data); this._syncDisplayedVisual(); this._renderFooterStream(this._buildFooterStream(data)); this._updateDrawer(data); this._bind();
  }

  _renderCategoryLayout(data) {
    this._ensureVisibilityObserver();
    this.dataset.laneMode = this._config?.lane_mode || 'slots';

    const configuredMedia =
      this._config.display
        ?.media_enabled;

    const globalVisualCenterEnabled =
      data.display?.visual_center_enabled !== false;

    this._mediaEnabled =
      globalVisualCenterEnabled &&
      (
        configuredMedia === undefined
          ? data.display?.media_enabled !== false
          : configuredMedia !== false
      );

    if (data.unavailable) {
      this.shadowRoot.innerHTML =
        `${this._styles()}<ha-card class="home-status-unavailable"><div><strong>Home Status is unavailable</strong><span>Choose a valid Home Status sensor in the card editor, or finish setting up the integration.</span><code>${this._escape(this._config.entity)}</code></div></ha-card>`;

      return;
    }

    const utilityMarkup =
      this._utilityHeaderMarkup(data);

    const showLeft =
      this._config.home_status_visibility.left;

    const showRight =
      this._config.home_status_visibility.right;

    const showBottom =
      this._config.home_status_visibility.bottom;

    const hasMainAreas =
      showLeft || showRight;

    const tickerMode =
      hasMainAreas
        ? ''
        : (showBottom ? ' ticker-only' : ' ticker-empty');

    this.toggleAttribute(
      'data-ticker-only',
      !hasMainAreas && showBottom
    );

    const zonesMarkup =
      hasMainAreas
        ? `<span class="ticker-zones"${showLeft ? ' data-has-left' : ''}${showRight ? ' data-has-right' : ''}>${showLeft ? '<span class="ticker-zone primary-zone" data-zone="left"></span>' : ''}${showRight ? '<span class="ticker-zone secondary-zone" data-zone="right"></span>' : ''}</span>`
        : '';

    const footerMarkup =
      showBottom
        ? '<span class="ticker-footer"><span class="bottom-stream" data-zone="bottom"></span></span>'
        : '';

    const visualEffect =
      this._weatherVisualEffect(
        data
      );

    this._destroyVisualHls(
      this.shadowRoot.querySelector(
        '[data-visual-center]'
      )
    );

    this.shadowRoot.innerHTML =
      `${this._styles()}${utilityMarkup}<div class="phone-status-host" data-phone-status-host></div><button class="ticker${tickerMode} priority-${this._escape(data.priority)}" type="button" aria-expanded="${this._drawerOpen}">${zonesMarkup}${footerMarkup}</button><div class="drawer-host"></div>`;

    this._renderPhoneStatus(
      data
    );

    this._weatherRenderer.mount(
      this.shadowRoot.querySelector(
        '.ticker'
      )
    );

    this._weatherRenderer.setEffect(
      visualEffect
    );

    this._weatherRenderer.setVisible(
      this._ambientVisible
    );

    this._baseVisual =
      data.visual;

    this._syncVisualQueue(data);

    this._startZoneRotations(
      data
    );

    this._syncDisplayedVisual();

    this._renderFooterStream(
      this._buildFooterStream(
        data
      )
    );

    this._updateDrawer(
      data
    );

    this._bind();
    this._startUtilityClock();
  }

  _setAmbientVisible(visible) {
    const nextVisible = Boolean(visible);
    const changed = nextVisible !== this._ambientVisible;
    this._ambientVisible = nextVisible;

    this._weatherRenderer.setVisible(
      this._ambientVisible
    );

    if (!changed) return;

    const center = this.shadowRoot?.querySelector(
      '[data-visual-center]'
    );

    if (!nextVisible) {
      // There is no value in rotating or decoding media that cannot be seen.
      // Release continuous video/camera resources; static images are cheap to
      // retain after decode and can stay in place.
      this._stopVisualQueueRotation();

      const media = center?.querySelector(
        ':scope > .visual-center-media, :scope > .visual-center-camera'
      );

      if (media?.tagName === 'VIDEO') {
        media.pause?.();
        media.onerror = null;
        this._destroyVisualHls(center);
        media.removeAttribute('src');
        media.load?.();
        center.dataset.visualSignature = '';
        center.dataset.visualMediaSignature = '';
      } else if (media?.tagName === 'HA-CAMERA-STREAM') {
        // Removing the camera stream element is the reliable way to stop its
        // underlying streaming/decoder work while this card is off-screen.
        media.remove();
        center.dataset.visualSignature = '';
        center.dataset.visualMediaSignature = '';
      }

      return;
    }

    // Recreate only the currently selected visual when we become visible.
    this._syncDisplayedVisual();
    if (
      this._baseVisualQueueActive &&
      this._baseVisualQueue.length > 1
    ) {
      this._scheduleVisualQueueTurn();
    }
  }

  _refreshAmbientVisibility() {
    this._setAmbientVisible(
      this._intersectionVisible &&
      !document.hidden
    );
  }

  _ensureVisibilityObserver() {
    if (!this._documentVisibilityHandler) {
      this._documentVisibilityHandler = () =>
        this._refreshAmbientVisibility();

      document.addEventListener(
        'visibilitychange',
        this._documentVisibilityHandler
      );
    }

    if (
      this._visibilityObserver ||
      typeof IntersectionObserver ===
        'undefined'
    ) {
      this._refreshAmbientVisibility();
      return;
    }

    this._visibilityObserver =
      new IntersectionObserver(
        entries => {
          this._intersectionVisible =
            entries.some(
              entry =>
                entry.isIntersecting &&
                entry.intersectionRatio >
                  0
            );

          this._refreshAmbientVisibility();
        },
        {
          threshold: 0
        }
      );

    this._visibilityObserver.observe(
      this
    );

    this._refreshAmbientVisibility();
  }

  _weatherVisualEffect(data) {
    if (
      this._config.animation
        .level ===
      'none'
    ) {
      return 'none';
    }

    if (
      this._config
        .weather_effect !==
      'auto'
    ) {
      return (
        this._config
          .weather_effect
      );
    }

    const items = [
      ...(data.left || []),
      ...(data.right || []),
      ...(data.bottom || [])
    ];

    const weather =
      items.find(
        item =>
          item?.category ===
            'weather' &&
          item?.visual_effect
      );

    return (
      data.weather_visual_effect ||
      weather?.visual_effect ||
      'none'
    );
  }

  _updateDrawer(
    data =
      this._getRuntimeData()
  ) {
    const host =
      this.shadowRoot.querySelector(
        '.drawer-host'
      );

    this.shadowRoot.querySelectorAll('[data-visual-entity]').forEach(target => {
      if (target.dataset.visualBound) return;
      target.dataset.visualBound = 'true';
      target.setAttribute('role', target.getAttribute('role') || 'button');
      if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON') target.tabIndex = 0;
      const open = event => {
        if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
        if (event.type === 'keydown') event.preventDefault();
        event.stopPropagation();
        const entityId = target.dataset.visualEntity;
        if (!entityId) return;
        this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId } }));
      };
      target.addEventListener('click', open);
      if (target.tagName !== 'BUTTON') target.addEventListener('keydown', open);
    });

    this.shadowRoot.querySelectorAll('[data-visual-path]').forEach(button => {
      if (button.dataset.visualPathBound) return; button.dataset.visualPathBound = 'true';
      button.addEventListener('click', event => { event.stopPropagation(); this._navigateUtility(button.dataset.visualPath); });
    });
    this.shadowRoot.querySelectorAll('[data-visual-source-toggle]').forEach(button => {
      if (button.dataset.visualSourceBound) return; button.dataset.visualSourceBound = 'true';
      button.addEventListener('click', event => { event.stopPropagation(); const menu = button.parentElement?.querySelector('[data-visual-source-menu]'); if (menu) { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); } });
    });
    this.shadowRoot.querySelectorAll('[data-visual-music-source]').forEach(button => {
      if (button.dataset.visualSourceBound) return; button.dataset.visualSourceBound = 'true';
      button.addEventListener('click', event => { event.stopPropagation(); const entityId = this._config?.utility_header?.music_entity; const source = button.dataset.visualMusicSource; if (entityId && source) this._hass?.callService('media_player', 'select_source', { entity_id: entityId, source }); const menu = button.closest('[data-visual-source-menu]'); if (menu) { menu.hidden = true; menu.parentElement?.querySelector('[data-visual-source-toggle]')?.setAttribute('aria-expanded', 'false'); } });
    });
    this.shadowRoot.querySelectorAll('[data-visual-music-volume]').forEach(volume => {
      if (volume.dataset.visualVolumeBound) return; volume.dataset.visualVolumeBound = 'true';
      const updateLabel = event => {
        event.stopPropagation();
        const value = Math.max(0, Math.min(1, Number(volume.value) || 0));
        const percent = Math.round(value * 100);
        volume.closest('.visual-music-volume')?.querySelector('[data-visual-music-volume-label]')?.replaceChildren(`${percent}%`);
        volume.closest('.visual-music-volume')?.querySelector('[data-visual-music-volume-icon]')?.setAttribute('icon', value === 0 ? 'mdi:volume-off' : value < .5 ? 'mdi:volume-medium' : 'mdi:volume-high');
        volume.setAttribute('aria-valuetext', `${percent} percent`);
      };
      volume.addEventListener('input', updateLabel);
      volume.addEventListener('change', event => {
        updateLabel(event);
        const entityId = this._config?.utility_header?.music_entity;
        if (entityId) this._hass?.callService('media_player', 'volume_set', { entity_id: entityId, volume_level: Math.max(0, Math.min(1, Number(volume.value) || 0)) });
      });
      ['click', 'pointerdown', 'pointerup'].forEach(type => volume.addEventListener(type, event => event.stopPropagation()));
    });

    const ticker =
      this.shadowRoot.querySelector(
        '.ticker'
      );

    if (
      !host ||
      !ticker
    ) {
      return;
    }

    ticker.setAttribute(
      'aria-expanded',
      String(
        this._drawerOpen
      )
    );

    if (!this._drawerOpen) {
      host.classList.remove(
        'drawer-active'
      );

      if (
        !host.querySelector(
          '.context-bar'
        ) &&
        !this.hasAttribute(
          'data-drawer-open'
        )
      ) {
        return;
      }

      let finished =
        false;

      const finishClose =
        () => {
          if (
            finished ||
            this._drawerOpen
          ) {
            return;
          }

          finished =
            true;

          if (
            this._drawerCloseTimer
          ) {
            clearTimeout(
              this._drawerCloseTimer
            );

            this._drawerCloseTimer =
              null;
          }

          if (
            this._drawerOpen
          ) {
            return;
          }

          host.innerHTML =
            '';

          this._drawerSignature =
            '';

          this.removeAttribute(
            'data-drawer-open'
          );

          this.style.removeProperty(
            '--home-status-drawer-inline-size'
          );

          host.style.removeProperty(
            '--home-status-drawer-rows'
          );

          host.style.removeProperty(
            '--home-status-drawer-height'
          );
        };

      host.addEventListener(
        'transitionend',
        finishClose,
        {
          once: true
        }
      );

      this._drawerCloseTimer =
        setTimeout(
          finishClose,
          620
        );

      return;
    }

    const actions =
      this._contextActions(
        data
      );

    // Keep five buttons per row, but grow the drawer when custom
    // destinations need more room instead of clipping them below it.
    const drawerRows =
      Math.max(
        2,
        Math.ceil(
          actions.length / 5
        )
      );

    const drawerHeight =
      drawerRows * 58 +
      (drawerRows - 1) * 10 +
      20;

    host.style.setProperty(
      '--home-status-drawer-rows',
      String(drawerRows)
    );

    host.style.setProperty(
      '--home-status-drawer-height',
      `${drawerHeight}px`
    );

    const signature =
      actions
        .map(
          action =>
            `${action.id}|${action.label}`
        )
        .join('||');

    if (
      signature ===
        this._drawerSignature &&
      host.querySelector(
        '.context-bar'
      )
    ) {
      this._updateContextActionStates(
        actions
      );

      if (
        !host.classList.contains(
          'drawer-active'
        )
      ) {
        const panel =
          host.querySelector(
            '.context-bar'
          );

        if (panel) {
          void panel.offsetHeight;
        }

        requestAnimationFrame(
          () => {
            if (
              this._drawerOpen
            ) {
              host.classList.add(
                'drawer-active'
              );
            }
          }
        );
      }

      return;
    }

    this._drawerSignature =
      signature;

    host.classList.remove(
      'drawer-active'
    );

    host.innerHTML =
      `<section class="context-bar" aria-label="Home controls">${actions.map(action => this._contextActionMarkup(action)).join('')}</section>`;

    const panel =
      host.querySelector(
        '.context-bar'
      );

    if (panel) {
      void panel.offsetHeight;
    }

    requestAnimationFrame(
      () => {
        if (
          this._drawerOpen
        ) {
          host.classList.add(
            'drawer-active'
          );
        }
      }
    );

    this._bindEventsOnly();
  }

  _contextActionMarkup(action) {
    return `<button class="context-action tone-${this._escape(action.tone)}${action.active ? ' active' : ''}" type="button" data-context-action="${this._escape(action.id)}" aria-label="${this._escape(`${action.label}: ${action.state}`)}"><ha-icon icon="${this._escape(action.icon)}"></ha-icon><span class="context-action-copy"><strong>${this._escape(action.label)}</strong><small>${this._escape(action.state)}</small></span></button>`;
  }

  _updateContextActionStates(
    actions
  ) {
    actions.forEach(
      action => {
        const button =
          [
            ...this.shadowRoot.querySelectorAll(
              '.context-action'
            )
          ].find(
            candidate =>
              candidate.dataset
                .contextAction ===
              action.id
          );

        if (!button) return;

        const className =
          `context-action tone-${action.tone}${action.active ? ' active' : ''}`;

        if (
          button.className !==
          className
        ) {
          button.className =
            className;
        }

        const icon =
          button.querySelector(
            'ha-icon'
          );

        if (
          icon?.getAttribute(
            'icon'
          ) !== action.icon
        ) {
          icon?.setAttribute(
            'icon',
            action.icon
          );
        }

        const label =
          button.querySelector(
            '.context-action-copy strong'
          );

        if (
          label &&
          label.textContent !==
          action.label
        ) {
          label.textContent =
            action.label;
        }

        const state =
          button.querySelector(
            '.context-action-copy small'
          );

        if (
          state &&
          state.textContent !==
          action.state
        ) {
          state.textContent =
            action.state;
        }

        button.setAttribute(
          'aria-label',
          `${action.label}: ${action.state}`
        );
      }
    );
  }

  _toggleDrawer() {
    const opening =
      !this._drawerOpen;

    if (opening) {
      if (
        this._drawerCloseTimer
      ) {
        clearTimeout(
          this._drawerCloseTimer
        );

        this._drawerCloseTimer =
          null;
      }

      const inlineSize =
        this.getBoundingClientRect()
          .width;

      if (
        inlineSize > 0
      ) {
        this.style.setProperty(
          '--home-status-drawer-inline-size',
          `${inlineSize}px`
        );

        this.setAttribute(
          'data-drawer-open',
          ''
        );
      }
    }

    this._drawerOpen =
      opening;

    // Opening or closing the drawer is navigation, not a reason to stop
    // any of the presentation streams. Clear a pointer/focus pause that may
    // have been set by the same interaction that toggled the drawer.
    this._rotationPaused =
      false;

    this._updateDrawer();
  }

  render() {
    if (
      !this._config ||
      !this._hass
    ) {
      return;
    }

    const data =
      this._getRuntimeData();

    this._applyPresentationPreferences(
      data
    );

    if (this._config.presentation_mode === 'visual') {
      this._renderVisualDashboard(data);
      return;
    }

    this._renderCategoryLayout(
      data
    );
  }

  _update() {
    this.dataset.laneMode = this._config?.lane_mode || 'slots';

    const data =
      this._getRuntimeData();

    this._applyPresentationPreferences(
      data
    );

    if (this._config.presentation_mode === 'visual') {
      this._updateVisualDashboard(data);
      return;
    }

    if (
      !this.shadowRoot.querySelector(
        '.ticker'
      )
    ) {
      return this.render();
    }

    this._renderPhoneStatus(
      data
    );

    const tickerButton =
      this.shadowRoot.querySelector(
        '.ticker'
      );

    const configuredMedia =
      this._config.display
        ?.media_enabled;

    const globalVisualCenterEnabled =
      data.display?.visual_center_enabled !== false;

    const mediaEnabled =
      globalVisualCenterEnabled &&
      (
        configuredMedia === undefined
          ? data.display?.media_enabled !== false
          : configuredMedia !== false
      );

    if (
      mediaEnabled !==
      this._mediaEnabled
    ) {
      this._zoneSignatures = {
        left: '',
        right: ''
      };
    }

    this._mediaEnabled =
      mediaEnabled;

    const visualEffect =
      this._weatherVisualEffect(
        data
      );

    tickerButton.className =
      `ticker priority-${this._escape(data.priority)}`;

    this._weatherRenderer.mount(
      tickerButton
    );

    this._weatherRenderer.setEffect(
      visualEffect
    );

    this._weatherRenderer.setVisible(
      this._ambientVisible
    );

    this._baseVisual =
      data.visual;

    this._syncVisualQueue(data);

    this._updateUtilityHeader(data);

    this._startZoneRotations(
      data
    );

    this._syncDisplayedVisual();

    this._renderFooterStream(
      this._buildFooterStream(
        data
      )
    );

    this._updateDrawer(
      data
    );
  }

  _bind() {
    this._bindEventsOnly();
  }

  _bindEventsOnly() {
    const security =
      this.shadowRoot.querySelector(
        '[data-utility-security]'
      );

    if (
      security &&
      !security.dataset.bound
    ) {
      security.dataset.bound =
        'true';

      security.addEventListener(
        'click',
        event => {
          event.stopPropagation();

          const configured =
            this._config
              .context_actions
              .security;

          this._navigateUtility(
            configured?.type ===
              'navigate' &&
            configured.path
              ? configured.path
              : this._config
                  .utility_header
                  .security_path
          );
        }
      );
    }

    const musicSummary =
      this.shadowRoot.querySelector(
        '[data-utility-music-nav]'
      );

    if (
      musicSummary &&
      !musicSummary.dataset.bound
    ) {
      musicSummary.dataset.bound =
        'true';

      musicSummary.addEventListener(
        'click',
        event => {
          event.stopPropagation();

          const configured =
            this._config
              .context_actions
              .music;

          this._navigateUtility(
            configured?.type ===
              'navigate' &&
            configured.path
              ? configured.path
              : this._config
                  .utility_header
                  .music_path
          );
        }
      );
    }

    const musicArtwork =
      musicSummary?.querySelector(
        '[data-music-art]'
      );

    if (
      musicArtwork &&
      !musicArtwork.dataset.bound
    ) {
      musicArtwork.dataset.bound =
        'true';

      musicArtwork.addEventListener(
        'error',
        () => {
          musicArtwork.hidden =
            true;

          musicArtwork
            .closest(
              '.utility-music-art'
            )
            ?.classList.remove(
              'has-art'
            );
        }
      );
    }

    this.shadowRoot
      .querySelectorAll(
        '[data-music-command]'
      )
      .forEach(
        button => {
          if (
            button.dataset.bound
          ) {
            return;
          }

          button.dataset.bound =
            'true';

          button.addEventListener(
            'click',
            event => {
              event.stopPropagation();

              const service =
                button.dataset
                  .musicCommand;

              const entityId =
                this._config
                  .utility_header
                  .music_entity;

              if (
                service &&
                entityId
              ) {
                this._hass?.callService(
                  'media_player',
                  service,
                  {
                    entity_id:
                      entityId
                  }
                );
              }
            }
          );
        }
      );

    const volume =
      this.shadowRoot.querySelector(
        '.music-volume'
      );

    if (
      volume &&
      !volume.dataset.bound
    ) {
      volume.dataset.bound =
        'true';

      volume.addEventListener(
        'input',
        event => {
          event.stopPropagation();

          const value =
            Number(
              volume.value
            );

          this.shadowRoot
            .querySelector(
              '.music-volume-icon'
            )
            ?.setAttribute(
              'icon',
              value === 0
                ? 'mdi:volume-off'
                : value < .5
                  ? 'mdi:volume-medium'
                  : 'mdi:volume-high'
            );

          volume.setAttribute(
            'aria-valuetext',
            `${Math.round(value * 100)} percent`
          );
        }
      );

      volume.addEventListener(
        'change',
        event => {
          event.stopPropagation();

          this._hass?.callService(
            'media_player',
            'volume_set',
            {
              entity_id:
                this._config
                  .utility_header
                  .music_entity,

              volume_level:
                Number(
                  volume.value
                )
            }
          );
        }
      );

      volume.addEventListener(
        'click',
        event =>
          event.stopPropagation()
      );
    }

    const source =
      this.shadowRoot.querySelector(
        '[data-music-source]'
      );

    if (
      source &&
      !source.dataset.bound
    ) {
      source.dataset.bound =
        'true';

      source.addEventListener(
        'click',
        event =>
          event.stopPropagation()
      );

      source.addEventListener(
        'change',
        event => {
          event.stopPropagation();

          if (
            !source.value
          ) {
            return;
          }

          this._hass?.callService(
            'media_player',
            'select_source',
            {
              entity_id:
                this._config
                  .utility_header
                  .music_entity,

              source:
                source.value
            }
          );
        }
      );
    }

    const ticker =
      this.shadowRoot.querySelector(
        '.ticker'
      );

    if (
      ticker &&
      !ticker.dataset.bound
    ) {
      ticker.dataset.bound =
        'true';

      ticker.addEventListener(
        'mouseenter',
        () => {
          if (
            this._config
              .pause_on_hover &&
            !this._drawerOpen
          ) {
            this._rotationPaused =
              true;
          }
        }
      );

      ticker.addEventListener(
        'mouseleave',
        () => {
          this._rotationPaused =
            false;
        }
      );

      ticker.addEventListener(
        'focusin',
        () => {
          this._rotationPaused =
            false;
        }
      );

      ticker.addEventListener(
        'focusout',
        () => {
          this._rotationPaused =
            false;
        }
      );

      ticker.addEventListener(
        'touchstart',
        () => {
          this._rotationPaused =
            true;
        },
        {
          passive: true
        }
      );

      ticker.addEventListener(
        'touchend',
        () => {
          this._rotationPaused =
            false;
        },
        {
          passive: true
        }
      );

      ticker.addEventListener(
        'click',
        () => {
          if (
            this._config
              .home_status_visibility
              .drawer
          ) {
            this._toggleDrawer();
          }
        }
      );

      ticker.addEventListener(
        'keydown',
        event => {
          if (
            this._config
              .home_status_visibility
              .drawer &&
            (
              event.key ===
                'Enter' ||
              event.key ===
                ' '
            )
          ) {
            event.preventDefault();
            this._toggleDrawer();
          }
        }
      );
    }

    this.shadowRoot
      .querySelectorAll(
        '.event-head'
      )
      .forEach(
        button =>
          button.addEventListener(
            'click',
            event => {
              event.stopPropagation();

              const article =
                button.closest(
                  '.event'
                );

              const id =
                article.dataset.id;

              const isExpanded =
                this._expandedEventIds.has(
                  id
                );

              isExpanded
                ? this._expandedEventIds.delete(
                    id
                  )
                : this._expandedEventIds.add(
                    id
                  );

              article.classList.toggle(
                'expanded',
                !isExpanded
              );

              button.setAttribute(
                'aria-expanded',
                String(
                  !isExpanded
                )
              );
            }
          )
      );

    this.shadowRoot
      .querySelectorAll(
        '.open-device'
      )
      .forEach(
        button =>
          button.addEventListener(
            'click',
            event => {
              event.stopPropagation();

              this.dispatchEvent(
                new CustomEvent(
                  'hass-more-info',
                  {
                    bubbles: true,
                    composed: true,

                    detail: {
                      entityId:
                        button.dataset.entity
                    }
                  }
                )
              );
            }
          )
      );

    this.shadowRoot
      .querySelectorAll(
        '.context-action'
      )
      .forEach(
        button =>
          button.addEventListener(
            'click',
            event => {
              event.stopPropagation();

              if (
                button.dataset.entity
              ) {
                this.dispatchEvent(
                  new CustomEvent(
                    'hass-more-info',
                    {
                      bubbles: true,
                      composed: true,

                      detail: {
                        entityId:
                          button.dataset.entity
                      }
                    }
                  )
                );
              } else {
                const action =
                  button.dataset
                    .contextAction;

                const configured =
                  this._config
                    .context_actions[
                      action
                    ] ||
                  this._contextActions(
                    null
                  ).find(
                    candidate =>
                      candidate.id ===
                      action
                  )?.config;

                const config =
                  configured &&
                  !configured.type &&
                  configured.path
                    ? {
                        ...configured,
                        type:
                          'navigate'
                      }
                    : configured;

                if (
                  !config?.type
                ) {
                  this.dispatchEvent(
                    new CustomEvent(
                      'home-status-action',
                      {
                        bubbles: true,
                        composed: true,

                        detail: {
                          action,
                          config:
                            config ||
                            {}
                        }
                      }
                    )
                  );

                  return;
                }

                if (
                  config.confirmation
                    ?.text &&
                  !window.confirm(
                    config.confirmation
                      .text
                  )
                ) {
                  return;
                }

                if (
                  config.type ===
                    'navigate' &&
                  config.path
                ) {
                  const path =
                    String(
                      config.path
                    );

                  if (
                    /^https?:\/\//i
                      .test(path)
                  ) {
                    window.open(
                      path,
                      '_blank',
                      'noopener,noreferrer'
                    );
                  } else {
                    window.history.pushState(
                      {},
                      '',
                      path
                    );

                    this.dispatchEvent(
                      new Event(
                        'location-changed',
                        {
                          bubbles:
                            true,

                          composed:
                            true
                        }
                      )
                    );
                  }
                } else if (
                  config.type ===
                    'service' &&
                  config.service
                ) {
                  const [
                    domain,
                    service
                  ] =
                    String(
                      config.service
                    ).split(
                      '.',
                      2
                    );

                  if (
                    domain &&
                    service
                  ) {
                    this._hass?.callService(
                      domain,
                      service,
                      config.target ||
                        {}
                    );
                  }
                } else {
                  this.dispatchEvent(
                    new CustomEvent(
                      'home-status-action',
                      {
                        bubbles: true,
                        composed: true,

                        detail: {
                          action,
                          config
                        }
                      }
                    )
                  );
                }
              }
            }
          )
      );

    this._bindStreamItems();
  }

  _bindStreamItems() {
    this.shadowRoot
      .querySelectorAll(
        '.zone-item, .phone-status-current, .phone-status-ticker-item, [data-footer-group-labels], [data-stream-navigation], [data-stream-entity]'
      )
      .forEach(
        item => {
          if (
            item.dataset.bound
          ) {
            return;
          }

          item.dataset.bound =
            'true';

          item.addEventListener(
            'click',
            event => {
              event.stopPropagation();

              if (
                item.dataset
                  .footerGroupLabels
              ) {
                const marquee =
                  item.closest(
                    '.footer-marquee'
                  );
                const streamId =
                  item.dataset
                    .streamId ||
                  '';

                if (!marquee) return;

                const closeDetails = () => {
                  marquee.classList.remove(
                    'group-details-open'
                  );
                  delete marquee.dataset.groupDetailId;
                  marquee.querySelector(
                    '[data-footer-group-detail]'
                  )?.remove();
                  marquee.querySelectorAll(
                    '[data-footer-group-labels]'
                  ).forEach(copy =>
                    copy.classList.remove(
                      'footer-group-expanded'
                    )
                  );
                };

                if (
                  marquee.dataset.groupDetailId ===
                  streamId
                ) {
                  closeDetails();
                  return;
                }

                let labels = [];
                try {
                  labels = JSON.parse(
                    decodeURIComponent(
                      item.dataset.footerGroupLabels
                    )
                  );
                } catch (_error) {
                  labels = [];
                }

                closeDetails();
                marquee.dataset.groupDetailId = streamId;
                marquee.classList.add(
                  'group-details-open'
                );
                marquee.querySelectorAll(
                  '[data-footer-group-labels]'
                ).forEach(copy => {
                  if (
                    String(copy.dataset.streamId || '') ===
                    streamId
                  ) {
                    copy.classList.add(
                      'footer-group-expanded'
                    );
                  }
                });

                const details = document.createElement(
                  'button'
                );
                details.type = 'button';
                details.className = 'footer-group-detail';
                details.dataset.footerGroupDetail = 'true';

                const heading = document.createElement(
                  'strong'
                );
                heading.textContent =
                  decodeURIComponent(
                    item.dataset.footerGroupTitle ||
                    ''
                  ) ||
                  'Grouped openings';

                const names = document.createElement(
                  'small'
                );
                names.textContent = labels.length
                  ? labels.join(' • ')
                  : 'No grouped names available';

                details.append(heading, names);
                details.addEventListener(
                  'click',
                  detailEvent => {
                    detailEvent.stopPropagation();
                    closeDetails();
                  }
                );
                marquee.append(details);

                return;
              }

              const historyTarget =
                item.dataset
                  .streamHistoryTarget;

              // Footer items represent past Recorder-backed events. Their
              // click target is native Home Assistant history context rather
              // than the operational action/navigation used by live items.
              if (historyTarget) {
                const deviceId =
                  item.dataset
                    .streamDevice;
                const entityId =
                  item.dataset
                    .streamEntity;

                if (historyTarget === 'device' && deviceId) {
                  window.history.pushState(
                    {},
                    '',
                    `/config/devices/device/${encodeURIComponent(deviceId)}`
                  );

                  this.dispatchEvent(
                    new Event(
                      'location-changed',
                      {
                        bubbles: true,
                        composed: true
                      }
                    )
                  );
                  return;
                }

                if (entityId) {
                  this.dispatchEvent(
                    new CustomEvent(
                      'hass-more-info',
                      {
                        bubbles: true,
                        composed: true,

                        detail: {
                          entityId
                        }
                      }
                    )
                  );
                  return;
                }
              }

              const path =
                item.dataset
                  .streamNavigation;

              if (path) {
                window.history.pushState(
                  {},
                  '',
                  path
                );

                this.dispatchEvent(
                  new Event(
                    'location-changed',
                    {
                      bubbles: true,
                      composed: true
                    }
                  )
                );
              } else if (
                item.dataset
                  .streamEntity
              ) {
                this.dispatchEvent(
                  new CustomEvent(
                    'hass-more-info',
                    {
                      bubbles: true,
                      composed: true,

                      detail: {
                        entityId:
                          item.dataset
                            .streamEntity
                      }
                    }
                  )
                );
              }
            }
          );
        }
      );
  }

  getCardSize() {
    const tickerOnly =
      this._config?.utility_header?.enabled === false &&
      this._config?.home_status_visibility?.left === false &&
      this._config?.home_status_visibility?.right === false &&
      this._config?.home_status_visibility?.bottom !== false;

    if (
      tickerOnly &&
      !this._drawerOpen
    ) {
      return 2;
    }

    const configured =
      Number(
        this._config?.card_size
      );

    const drawerRows =
      Math.max(
        2,
        Math.ceil(
          this._contextActions()
            .length / 5
        )
      );

    const baseCardSize =
      Number.isFinite(
        configured
      ) &&
      configured > 0
        ? configured
        : this._config?.profile ===
            'phone'
          ? 2
          : 4;

    return this._drawerOpen
      ? Math.max(
          baseCardSize,
          4 + drawerRows * 2
        )
      : baseCardSize;
  }

  getGridOptions() {
    const configured =
      homeStatusObject(
        this._rawConfig
          ?.grid_options
      );

    const tickerOnly =
      this._config?.utility_header?.enabled === false &&
      this._config?.home_status_visibility?.left === false &&
      this._config?.home_status_visibility?.right === false &&
      this._config?.home_status_visibility?.bottom !== false;

    return {
      columns:
        Number.isFinite(
          Number(
            configured.columns
          )
        )
          ? Math.max(
              3,
              Math.min(
                36,
                Number(
                  configured.columns
                )
              )
            )
          : 36,

      rows:
        tickerOnly
          ? 2
          : Number.isFinite(
          Number(
            configured.rows
          )
        )
          ? Math.max(
              2,
              Number(
                configured.rows
              )
            )
          : 7,

      min_columns: 3,
      min_rows: 2
    };
  }

  static async getConfigElement() {
    return document.createElement(
      'home-status-card-editor'
    );
  }

  static getStubConfig() {
    return {
      entity:
        'sensor.home_status',

      profile:
        'auto',

      layout:
        'responsive',

      presentation_mode:
        'classic',

      lane_mode:
        'slots',

      theme_mode:
        'dark',

      time_entity:
        '',

      recent_drawer_limit:
        10,

      rotation_seconds:
        4,

      utility_header: {
        enabled:
          false
      },

      left: {
        rotate:
          true,

        interval:
          7
      },

      right: {
        rotate:
          true
      },

      bottom: {
        rotate:
          false,

        speed:
          35
      },

      grid_options: {
        columns:
          36,

        rows:
          7
      },

      sizing: {
        max_width:
          0,

        min_height:
          0
      },

      animation: {
        level:
          'full'
      },

      display: {
        media_enabled:
          true
      },

      weather_effect:
        'auto',

      pause_on_hover:
        true,

      home_status_visibility: {
        left:
          true,

        right:
          true,

        bottom:
          true,

        phone_ticker:
          true,

        drawer:
          false
      }
    };
  }
}

class HomeStatusCardEditor extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({
      mode: 'open'
    });

    this._config =
      HomeStatusCard.getStubConfig();

    this._hass = null;

    this._pendingHassRender =
      false;

    this._formControlFocused =
      false;

    this._editorLevel =
      'recommended';

    this.shadowRoot.addEventListener(
      'focusin',
      event => {
        if (
          event.target?.matches?.(
            'input, select, textarea'
          )
        ) {
          this._formControlFocused =
            true;
        }
      }
    );

    this.shadowRoot.addEventListener(
      'focusout',
      () => {
        window.setTimeout(
          () => {
            this._formControlFocused =
              Boolean(
                this.shadowRoot?.activeElement?.matches?.(
                  'input, select, textarea'
                )
              );

            if (
              this._pendingHassRender &&
              !this._hasActiveFormControl()
            ) {
              this._pendingHassRender =
                false;

              this._render();
            }
          },
          0
        );
      }
    );
  }

  set hass(value) {
    this._hass = value;

    // Home Assistant refreshes hass frequently. Rebuilding this editor while
    // a native select, datalist, or text input owns focus closes its popup and
    // can discard an in-progress choice. Apply the newest hass snapshot after
    // the user leaves the control instead.
    if (
      this._hasActiveFormControl()
    ) {
      this._pendingHassRender =
        true;

      return;
    }

    this._render();
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    this._config =
      homeStatusClone(
        homeStatusObject(
          config
        )
      );

    if (
      !this._config.type
    ) {
      this._config.type =
        'custom:home-status-card';
    }

    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _hasActiveFormControl() {
    return (
      this._formControlFocused ||
      document.activeElement === this ||
      Boolean(
        this.shadowRoot?.activeElement
      )
    );
  }

  _escape(value) {
    const node =
      document.createElement(
        'span'
      );

    node.textContent =
      String(
        value ?? ''
      );

    return node.innerHTML;
  }

  _value(
    path,
    fallback = ''
  ) {
    const value = homeStatusGetPath(
      this._config,
      path,
      undefined
    );

    if (value !== undefined) {
      return value;
    }

    if (path === 'right.interval') {
      return homeStatusGetPath(
        this._config,
        'rotation_seconds',
        fallback
      );
    }

    return fallback;
  }
  _select(
    path,
    label,
    options,
    fallback,
    help = ''
  ) {
    const value =
      String(
        this._value(
          path,
          fallback
        )
      );

    return `<label><span>${this._escape(label)}</span><select data-path="${this._escape(path)}">${options.map(
      option => {
        const current =
          typeof option === 'string'
            ? {
                value:
                  option,

                label:
                  option
              }
            : option;

        return `<option value="${this._escape(current.value)}"${String(current.value) === value ? ' selected' : ''}>${this._escape(current.label)}</option>`;
      }
    ).join('')}</select>${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _text(
    path,
    label,
    fallback = '',
    help = '',
    list = ''
  ) {
    return `<label><span>${this._escape(label)}</span><input type="text" data-path="${this._escape(path)}" value="${this._escape(this._value(path, fallback))}"${list ? ` list="${this._escape(list)}"` : ''}>${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _number(
    path,
    label,
    fallback,
    min,
    max,
    help = ''
  ) {
    return `<label><span>${this._escape(label)}</span><input type="number" data-path="${this._escape(path)}" data-value-type="number" value="${this._escape(this._value(path, fallback))}" min="${min}" max="${max}">${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _toggle(
    path,
    label,
    fallback = true,
    help = ''
  ) {
    return `<label class="toggle"><input type="checkbox" data-path="${this._escape(path)}" data-value-type="boolean"${this._value(path, fallback) !== false ? ' checked' : ''}><span><strong>${this._escape(label)}</strong>${help ? `<small>${this._escape(help)}</small>` : ''}</span></label>`;
  }

  _entityList(
    id,
    domain = ''
  ) {
    const entities =
      Object.keys(
        this._hass?.states ||
        {}
      )
        .filter(
          entity =>
            !domain ||
            entity.startsWith(
              `${domain}.`
            )
        )
        .sort();

    return `<datalist id="${this._escape(id)}">${entities.map(
      entity =>
        `<option value="${this._escape(entity)}"></option>`
    ).join('')}</datalist>`;
  }

  _customNavigationActions() {
    const actions =
      this._config
        ?.context_actions
        ?.custom;

    return Array.isArray(actions)
      ? actions.map(homeStatusObject)
      : [];
  }

  _customNavigationEditor() {
    const actions =
      this._customNavigationActions();

    return `<div class="custom-navigation-editor"><div class="custom-navigation-heading"><strong>Custom drawer buttons</strong><small>Add any dashboard or Home Assistant path. These appear alongside the built-in drawer buttons.</small></div>${actions.map(
      (action, index) =>
        `<div class="custom-navigation-row"><label><span>Name</span><input type="text" data-custom-action-index="${index}" data-custom-action-field="name" value="${this._escape(action.name || '')}" placeholder="Micro-Air"></label><label><span>Icon</span><input type="text" data-custom-action-index="${index}" data-custom-action-field="icon" value="${this._escape(action.icon || '')}" placeholder="mdi:air-conditioner"></label><label><span>Path</span><input type="text" data-custom-action-index="${index}" data-custom-action-field="path" value="${this._escape(action.path || '')}" placeholder="/your-dashboard/0"></label><button type="button" class="custom-navigation-remove" data-remove-custom-action="${index}" aria-label="Remove ${this._escape(action.name || 'custom drawer button')}">Remove</button></div>`
    ).join('')}<button type="button" class="custom-navigation-add" data-add-custom-action>Add drawer button</button></div>`;
  }

  _unknownKeys() {
    return Object.keys(
      this._config
    ).filter(
      key =>
        !HOME_STATUS_KNOWN_TOP_LEVEL_KEYS
          .has(key)
    );
  }

  _validationWarnings() {
    const warnings = [];

    const entity =
      String(
        this._value(
          'entity',
          'sensor.home_status'
        )
      );

    if (
      !entity.includes('.')
    ) {
      warnings.push(
        'The Home Status sensor must be a valid entity ID.'
      );
    }

    const profile =
      String(
        this._value(
          'profile',
          'auto'
        )
      );

    const columns =
      Number(
        this._value(
          'grid_options.columns',
          36
        )
      );

    const rows =
      Number(
        this._value(
          'grid_options.rows',
          7
        )
      );

    const visibility =
      homeStatusObject(
        this._value(
          'home_status_visibility',
          {}
        )
      );

    const tickerOnly =
      this._value(
        'utility_header.enabled',
        true
      ) === false &&
      this._value(
        'home_status_visibility.left',
        true
      ) === false &&
      this._value(
        'home_status_visibility.right',
        true
      ) === false &&
      this._value(
        'home_status_visibility.bottom',
        true
      ) !== false;

    if (
      [
        'auto',
        'tablet',
        'desktop'
      ].includes(profile) &&
      Number.isFinite(
        columns
      ) &&
      columns < 24
    ) {
      warnings.push(
        'This width may force the compact phone presentation or clip the full Tablet/Desktop layout. Use 36 columns for the recommended Sections view.'
      );
    }

    if (
      [
        'auto',
        'tablet',
        'desktop'
      ].includes(profile) &&
      Number.isFinite(
        rows
      ) &&
      rows < 7 &&
      !tickerOnly
    ) {
      warnings.push(
        'The full layout needs at least 7 rows. A shorter grid can overlap the next dashboard section.'
      );
    }

    if (
      [
        this._value(
          'home_status_visibility.left',
          true
        ),

        this._value(
          'home_status_visibility.right',
          true
        ),

        this._value(
          'home_status_visibility.bottom',
          true
        ),

        visibility.phone_ticker
      ].every(
        value =>
          value === false
      )
    ) {
      warnings.push(
        'Every information area is hidden, so the card may appear empty. Enable at least one presentation area.'
      );
    }

    const configuredActions =
      Object.values(
        homeStatusObject(
          this._value(
            'context_actions',
            {}
          )
        )
      ).filter(
        action =>
          homeStatusObject(action)
            .path ||
          homeStatusObject(action)
            .type
      );

    const customActions =
      this._customNavigationActions()
        .filter(
          action =>
            String(
              action.path ||
              ''
            ).trim()
        );

    if (
      visibility.drawer !== false &&
      !configuredActions.length &&
      !customActions.length
    ) {
      warnings.push(
        'The drawer is enabled but has no navigation buttons. Add destinations in Advanced, or turn the drawer off.'
      );
    }

    const paths = [
      'utility_header.security_path',
      'utility_header.music_path',
      'context_actions.calendar.path',
      'context_actions.cameras.path',
      'context_actions.lighting.path'
    ];

    paths.forEach(
      path => {
        const value =
          String(
            this._value(
              path,
              ''
            ) || ''
          ).trim();

        if (
          value &&
          !value.startsWith(
            '/'
          ) &&
          !/^https?:\/\//i
            .test(value)
        ) {
          warnings.push(
            `${path.split('.').slice(-2, -1)[0].replaceAll('_', ' ')} page must begin with / or use a full web address.`
          );
        }
      }
    );

    customActions.forEach(
      action => {
        const value =
          String(
            action.path ||
            ''
          ).trim();

        if (
          !value.startsWith('/') &&
          !/^https?:\/\//i.test(value)
        ) {
          warnings.push(
            `${action.name || 'Custom drawer button'} path must begin with / or use a full web address.`
          );
        }
      }
    );

    return warnings;
  }

  _render() {
    if (
      !this.shadowRoot
    ) {
      return;
    }

    const hadEditor =
      Boolean(
        this.shadowRoot.querySelector(
          '.editor'
        )
      );

    const openSections =
      new Set(
        [
          ...this.shadowRoot.querySelectorAll(
            'details[data-section][open]'
          )
        ].map(
          section =>
            section.dataset.section
        )
      );

    const sectionOpen =
      (
        section,
        defaultOpen = false
      ) =>
        hadEditor
          ? openSections.has(
              section
            )
          : defaultOpen;

    const levelHidden =
      level =>
        this._editorLevel ===
        level
          ? ''
          : ' hidden';

    const entity =
      String(
        this._value(
          'entity',
          'sensor.home_status'
        )
      );

    const entityMissing =
      Boolean(
        this._hass &&
        !this._hass.states?.[
          entity
        ]
      );

    const unknown =
      this._unknownKeys();

    const validationWarnings =
      this._validationWarnings();

    const profiles = [
      {
        value: 'auto',
        label: 'Responsive (recommended)'
      },
      {
        value: 'phone',
        label: 'Phone'
      },
      {
        value: 'tablet',
        label: 'Tablet'
      },
      {
        value: 'desktop',
        label: 'Desktop'
      }
    ];

    const weatherEffects = [
      {
        value: 'auto',
        label: 'Automatic from Home Status'
      },
      {
        value: 'none',
        label: 'None'
      },
      {
        value: 'rain',
        label: 'Rain'
      },
      {
        value: 'clouds',
        label: 'Clouds'
      },
      {
        value: 'storm',
        label: 'Storm'
      },
      {
        value: 'wind',
        label: 'Wind'
      },
      {
        value: 'fog',
        label: 'Fog'
      },
      {
        value: 'night',
        label: 'Night'
      },
      {
        value: 'clear',
        label: 'Clear'
      }
    ];

    this.shadowRoot.innerHTML = `<style>
      :host { display:block; color:var(--primary-text-color); }
      .editor { display:grid; gap:12px; padding:4px 0 12px; }
      .intro,.warning,.preserved { padding:12px 14px; border-radius:12px; line-height:1.45; }
      .intro { background:var(--secondary-background-color); }
      .warning { border:1px solid var(--error-color,#db4437); background:color-mix(in srgb,var(--error-color,#db4437) 9%,transparent); }
      .preserved { border:1px solid var(--divider-color); color:var(--secondary-text-color); font-size:12px; }
      details { border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
      summary { padding:14px; cursor:pointer; font-weight:650; background:var(--secondary-background-color); }
      .section { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:14px; padding:14px; }
      .custom-navigation-editor { display:grid; gap:12px; padding:0 14px 14px; }
      .custom-navigation-heading { display:grid; gap:4px; }
      .custom-navigation-heading small { color:var(--secondary-text-color); }
      .custom-navigation-row { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)) auto; gap:10px; align-items:end; padding:12px; border:1px solid var(--divider-color); border-radius:10px; }
      .custom-navigation-row label { min-width:0; }
      .custom-navigation-remove { min-height:40px; background:var(--secondary-background-color); color:var(--primary-text-color); }
      .custom-navigation-add { justify-self:start; min-height:40px; }
      label:not(.toggle) { display:flex; flex-direction:column; gap:6px; min-width:0; }
      label > span { font-weight:600; }
      input,select { min-height:42px; box-sizing:border-box; padding:8px 10px; border:1px solid var(--divider-color); border-radius:8px; background:var(--card-background-color); color:var(--primary-text-color); font:inherit; }
      small { display:block; color:var(--secondary-text-color); font-weight:400; line-height:1.35; }
      .toggle { display:flex; align-items:flex-start; gap:10px; min-height:42px; }
      .toggle input { width:20px; min-height:20px; margin:2px 0 0; }
      .toggle span { display:block; }
      .toggle strong { display:block; }
      .profile-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
      button { padding:0 14px; border:0; border-radius:8px; background:var(--primary-color); color:var(--text-primary-color,#fff); font:inherit; font-weight:600; cursor:pointer; }
      [hidden] { display:none !important; }
      .level-nav { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; padding:5px; border-radius:12px; background:var(--secondary-background-color); }
      .level-nav button { min-height:42px; background:transparent; color:var(--secondary-text-color); }
      .level-nav button.active { background:var(--primary-color); color:var(--text-primary-color,#fff); }
      .recommended-card { display:grid; gap:12px; padding:16px; border:1px solid color-mix(in srgb,var(--primary-color) 42%,var(--divider-color)); border-radius:14px; background:color-mix(in srgb,var(--primary-color) 7%,var(--card-background-color)); }
      .recommended-card h3,.recommended-card p { margin:0; }
      .recommended-list { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:8px; }
      .recommended-item { display:flex; align-items:center; gap:8px; min-height:34px; color:var(--secondary-text-color); }
      .recommended-item ha-icon { color:var(--success-color,#43a047); }
      .recommended-actions { display:flex; justify-content:flex-start; }
      .recommended-actions button { min-height:42px; }
      .advanced-note { padding:12px 14px; border-left:4px solid var(--warning-color,#ff9800); border-radius:8px; background:color-mix(in srgb,var(--warning-color,#ff9800) 9%,transparent); }
      @media (max-width:520px) { .section,.custom-navigation-row { grid-template-columns:1fr; } .custom-navigation-remove { justify-self:start; } }
    </style><div class="editor">
      <div class="intro"><strong>Home Status presentation</strong><br><small>These settings control this card only. Integration discovery and notification rules remain in Settings → Devices & services → Home Status.</small></div>
      ${entityMissing ? `<div class="warning"><strong>Home Status sensor not found</strong><br><span>${this._escape(entity)}</span><small>Finish integration setup or choose an existing Home Status sensor below. The card will show an unavailable message until the entity exists.</small></div>` : ''}
      ${validationWarnings.length ? `<div class="warning"><strong>Check these settings</strong>${validationWarnings.map(message => `<small>${this._escape(message)}</small>`).join('')}</div>` : ''}
      <nav class="level-nav" aria-label="Editor level">${['recommended', 'customize', 'advanced'].map(level => `<button type="button" data-editor-level="${level}" class="${this._editorLevel === level ? 'active' : ''}">${level[0].toUpperCase()}${level.slice(1)}</button>`).join('')}</nav>
      <section class="recommended-card"${levelHidden('recommended')}>
        <h3>Recommended for most homes</h3>
        <p>Home Status automatically adapts between phone, tablet, and desktop while using a safe full-width Sections layout.</p>
        <div class="recommended-list">
          <span class="recommended-item"><ha-icon icon="mdi:check-circle"></ha-icon>Responsive layout</span>
          <span class="recommended-item"><ha-icon icon="mdi:check-circle"></ha-icon>36 x 7 Sections size</span>
          <span class="recommended-item"><ha-icon icon="mdi:check-circle"></ha-icon>Balanced animation</span>
          <span class="recommended-item"><ha-icon icon="mdi:check-circle"></ha-icon>Recommended visibility</span>
        </div>
        <div class="recommended-actions"><button type="button" data-restore-recommended>Restore Recommended</button></div>
        <small>Restores safe presentation defaults while preserving your sensor, navigation destinations, native Home Assistant visibility rules, and expert YAML options.</small>
      </section>
      <div class="advanced-note"${levelHidden('advanced')}><strong>Advanced controls</strong><br><small>These settings can create clipped, empty, or device-specific layouts. Restore Recommended recovers a safe presentation without removing expert YAML.</small></div>
      <details data-section="profile"${sectionOpen('profile', true) ? ' open' : ''}${levelHidden('advanced')}><summary>Layout & data source</summary><div class="section">
        <label><span>Presentation profile</span><div class="profile-row"><select data-profile-picker>${profiles.map(option => `<option value="${option.value}"${this._value('profile', 'auto') === option.value ? ' selected' : ''}>${option.label}</option>`).join('')}</select><button type="button" data-apply-profile>Apply</button></div><small>Applying a preset changes known presentation settings only. Custom YAML and unknown options are preserved.</small></label>
        ${this._text('entity', 'Home Status sensor', 'sensor.home_status', 'Usually sensor.home_status.', 'home-status-sensors')}
        ${this._select('layout', 'Layout style', [
          { value: 'responsive', label: 'Responsive' },
          { value: 'compact', label: 'Compact' },
          { value: 'tablet-default', label: 'Tablet default' },
          { value: 'desktop-wide', label: 'Desktop wide' }
        ], 'responsive')}
        ${this._select('presentation_mode', 'Presentation mode', [
          { value: 'classic', label: 'Classic Home Status' },
          { value: 'visual', label: 'Visual (preview)' }
        ], 'classic', 'Visual mode uses the same Home Status data but presents it as glanceable modules with less text.')}
        ${this._select('lane_mode', 'Side lane style', [
          { value: 'slots', label: 'Three independent slots' },
          { value: 'single', label: 'Single rotating item (original)' }
        ], 'slots', 'Choose the enhanced three-row lanes or the original one-item-per-side presentation.')}
        ${this._select('theme_mode', 'Appearance', [
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
          { value: 'auto', label: 'Auto (follow Home Assistant)' }
        ], 'dark', 'Dark preserves the existing Home Status look. Auto follows Home Assistant light/dark appearance.')}
      </div></details>
      <details data-section="visibility"${sectionOpen('visibility', true) ? ' open' : ''}${levelHidden('customize')}><summary>What appears</summary><div class="section">
        ${this._toggle('utility_header.enabled', 'Clock, security & music header', true)}
        ${this._toggle('home_status_visibility.left', 'Left area', true)}
        ${this._toggle('home_status_visibility.right', 'Right area', true)}
        ${this._toggle('home_status_visibility.bottom', 'Bottom ticker', true)}
        ${this._toggle('home_status_visibility.phone_ticker', 'Phone ticker', true)}
        ${this._toggle('home_status_visibility.drawer', 'Navigation drawer', false, 'Enable after adding destinations in Advanced. Opens configured navigation buttons when the main card is tapped.')}
      </div></details>
      <details data-section="ticker"${sectionOpen('ticker', true) ? ' open' : ''}${levelHidden('customize')}><summary>Motion & timing</summary><div class="section">
        ${this._number('bottom.speed', 'Bottom ticker speed', 35, 8, 120, 'Lower values move faster.')}
        ${this._number('phone_ticker.speed', 'Portrait phone ticker speed', 35, 8, 120, 'Seconds per loop in portrait. Lower values move faster. This does not affect the tablet or landscape ticker.')}
        ${this._number('right.interval', 'Right rotation time', 4, 1, 120)}
        ${this._number('left.interval', 'Left rotation time', 7, 2, 120)}
        ${this._toggle('left.rotate', 'Rotate left items', true)}
        ${this._toggle('right.rotate', 'Rotate right items', true)}
        ${this._toggle('pause_on_hover', 'Pause animation while hovering', true)}
        ${this._select('animation.level', 'Animation level', [
          { value: 'full', label: 'Full' },
          { value: 'reduced', label: 'Reduced' },
          { value: 'none', label: 'None' }
        ], 'full')}
      </div></details>
      <details data-section="media"${sectionOpen('media') ? ' open' : ''}${levelHidden('customize')}><summary>Media & weather effects</summary><div class="section">
        ${this._toggle('display.media_enabled', 'Show notification media', true)}
        ${this._select('weather_effect', 'Weather effect', weatherEffects, 'auto')}
      </div></details>
      <details data-section="limits"${sectionOpen('limits') ? ' open' : ''}${levelHidden('advanced')}><summary>Drawer settings</summary><div class="section">
        ${this._number('recent_drawer_limit', 'Drawer item limit', 10, 1, 50)}
      </div></details>
      <details data-section="entities"${sectionOpen('entities') ? ' open' : ''}${levelHidden('advanced')}><summary>Manual entities</summary><div class="section">
        ${this._text('utility_header.music_entity', 'Music player', '', 'Optional. Choose the player used by the card music controls.', 'home-status-media')}
        ${this._text('time_entity', 'Time sensor', '', 'Optional. Leave blank to use the browser clock.', 'home-status-sensors')}
        ${this._text('utility_header.security_entity', 'Security entity', '', 'Optional. Leave blank when no alarm panel is available.', 'home-status-alarms')}
      </div></details>
      <details data-section="navigation"${sectionOpen('navigation') ? ' open' : ''}${levelHidden('advanced')}><summary>Navigation destinations</summary><div class="section">
        ${this._text('utility_header.security_path', 'Security page', '', 'Optional. Navigation remains disabled until configured.')}
        ${this._text('utility_header.music_path', 'Music page', '', 'Optional. Navigation remains disabled until configured.')}
        ${this._text('context_actions.calendar.path', 'Calendar page', '', 'Optional. No dashboard path is assumed.')}
        ${this._text('context_actions.cameras.path', 'Cameras page', '', 'Optional. No dashboard path is assumed.')}
        ${this._text('context_actions.lighting.path', 'Lights page', '', 'Optional. No dashboard path is assumed.')}
      </div>${this._customNavigationEditor()}</details>
      <details data-section="sizing"${sectionOpen('sizing') ? ' open' : ''}${levelHidden('advanced')}><summary>Card sizing</summary><div class="section">
        ${this._select('grid_options.columns', 'Grid width', [
          { value: '36', label: 'Full width (36 columns)' },
          { value: '24', label: 'Two-thirds width (24 columns)' },
          { value: '18', label: 'Half width (18 columns)' },
          { value: '12', label: 'One-third width (12 columns)' }
        ], '36')}
        ${this._select('grid_options.rows', 'Grid height', [
          { value: '7', label: 'Recommended (7 rows)' },
          { value: '10', label: 'Extra drawer room (10 rows)' },
          { value: '4', label: 'Compact (4 rows)' },
          { value: '2', label: 'Minimal (2 rows)' }
        ], '7')}
        ${this._number('sizing.max_width', 'Maximum width (px)', 0, 0, 3000, '0 uses all available width.')}
        ${this._number('sizing.min_height', 'Minimum height (px)', 0, 0, 1600, '0 uses the card’s natural height.')}
        ${this._number('card_size', 'Dashboard card size', 4, 1, 12)}
      </div></details>
      <div class="preserved"><strong>Expert YAML is preserved.</strong> The visual editor updates only the fields you change.${unknown.length ? ` Unrecognized top-level options retained: ${this._escape(unknown.join(', '))}.` : ''} You can switch to the code editor at any time.</div>
      ${this._entityList('home-status-sensors', 'sensor')}
      ${this._entityList('home-status-media', 'media_player')}
      ${this._entityList('home-status-alarms', 'alarm_control_panel')}
    </div>`;

    this._bind();
  }

  _bind() {
    this.shadowRoot
      .querySelectorAll(
        '[data-editor-level]'
      )
      .forEach(
        button => {
          button.addEventListener(
            'click',
            () => {
              this._editorLevel =
                button.dataset
                  .editorLevel;

              this._render();
            }
          );
        }
      );

    this.shadowRoot
      .querySelector(
        '[data-restore-recommended]'
      )
      ?.addEventListener(
        'click',
        () => {
          this._config =
            homeStatusMerge(
              this._config,
              HomeStatusCard.getStubConfig()
            );

          this._emit();
          this._render();
        }
      );

    this.shadowRoot
      .querySelectorAll(
        '[data-path]'
      )
      .forEach(
        control => {
          control.addEventListener(
            'change',
            event => {
              const target =
                event.currentTarget;

              const path =
                target.dataset.path;

              let value =
                target.value;

              if (
                target.dataset
                  .valueType ===
                'boolean'
              ) {
                value =
                  target.checked;
              }

              if (
                target.dataset
                  .valueType ===
                'number'
              ) {
                value =
                  target.value ===
                  ''
                    ? undefined
                    : Number(
                        target.value
                      );
              }

              if (
                path.startsWith(
                  'grid_options.'
                ) &&
                ![
                  'full',
                  'auto'
                ].includes(value)
              ) {
                value =
                  Number(value);
              }

              if (
                path.startsWith(
                  'context_actions.'
                ) &&
                path.endsWith(
                  '.path'
                ) &&
                value
              ) {
                const actionPath =
                  path
                    .split('.')
                    .slice(
                      0,
                      -1
                    )
                    .join('.');

                this._config =
                  homeStatusSetPath(
                    this._config,
                    `${actionPath}.type`,
                    'navigate'
                  );
              }

              this._config =
                homeStatusSetPath(
                  this._config,
                  path,
                  value,
                  target.type ===
                    'text'
                );

              this._emit();
              this._render();
            }
          );
        }
      );

    this.shadowRoot
      .querySelectorAll(
        '[data-custom-action-index]'
      )
      .forEach(
        control => {
          control.addEventListener(
            'change',
            event => {
              const target =
                event.currentTarget;

              const index = Number(
                target.dataset
                  .customActionIndex
              );

              const field =
                target.dataset
                  .customActionField;

              const actions =
                this._customNavigationActions();

              if (
                !Number.isInteger(index) ||
                !actions[index] ||
                !['name', 'icon', 'path'].includes(field)
              ) {
                return;
              }

              actions[index] = {
                ...actions[index],
                [field]: target.value,
                type: 'navigate'
              };

              this._config = {
                ...this._config,
                context_actions: {
                  ...homeStatusObject(
                    this._config
                      .context_actions
                  ),
                  custom: actions
                }
              };

              this._emit();
              this._render();
            }
          );
        }
      );

    this.shadowRoot
      .querySelector(
        '[data-add-custom-action]'
      )
      ?.addEventListener(
        'click',
        () => {
          const actions =
            this._customNavigationActions();

          actions.push(
            {
              name: 'New destination',
              icon: 'mdi:open-in-new',
              path: '',
              type: 'navigate'
            }
          );

          this._config = {
            ...this._config,
            context_actions: {
              ...homeStatusObject(
                this._config
                  .context_actions
              ),
              custom: actions
            }
          };

          this._emit();
          this._render();
        }
      );

    this.shadowRoot
      .querySelectorAll(
        '[data-remove-custom-action]'
      )
      .forEach(
        button => {
          button.addEventListener(
            'click',
            () => {
              const index = Number(
                button.dataset
                  .removeCustomAction
              );

              const actions =
                this._customNavigationActions();

              if (!Number.isInteger(index)) {
                return;
              }

              actions.splice(index, 1);

              this._config = {
                ...this._config,
                context_actions: {
                  ...homeStatusObject(
                    this._config
                      .context_actions
                  ),
                  custom: actions
                }
              };

              this._emit();
              this._render();
            }
          );
        }
      );

    this.shadowRoot
      .querySelector(
        '[data-apply-profile]'
      )
      ?.addEventListener(
        'click',
        () => {
          const profile =
            this.shadowRoot.querySelector(
              '[data-profile-picker]'
            )?.value ||
            'auto';

          this._config =
            homeStatusApplyProfile(
              this._config,
              profile
            );

          this._emit();
          this._render();
        }
      );
  }

  _emit() {
    this.dispatchEvent(
      new CustomEvent(
        'config-changed',
        {
          detail: {
            config:
              homeStatusClone(
                this._config
              )
          },

          bubbles:
            true,

          composed:
            true
        }
      )
    );
  }
}

const CSS = `
.utility-header { display:grid; grid-template-columns:minmax(165px,.16fr) minmax(155px,.15fr) minmax(175px,.16fr) minmax(540px,.53fr); align-items:stretch; width:100%; height:122px; min-height:122px; margin:0; box-sizing:border-box; overflow:hidden; border:1px solid rgba(255,255,255,.085); border-radius:23px 23px 0 0; background:linear-gradient(135deg,rgba(31,37,44,.82),rgba(15,19,24,.78)); box-shadow:0 8px 24px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.035); }
.utility-header ~ .ticker { margin:0; border-top:0; border-radius:0 0 23px 23px; }
.utility-clock { display:flex; flex-direction:column; justify-content:center; min-width:0; padding:0 10px 0 18px; }
.utility-time { display:flex; align-items:flex-start; color:rgba(255,255,255,.96); line-height:1; white-space:nowrap; }
.utility-time strong { font-size:56px; font-weight:700; letter-spacing:-2px; }
.utility-time small { align-self:flex-end; margin:0 0 6px 6px; color:rgba(255,255,255,.7); font-size:18px; font-weight:700; }
.utility-date { margin-top:6px; color:rgba(220,226,229,.78); font-size:16px; font-weight:560; letter-spacing:.3px; }
.utility-security { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:5px; min-width:0; padding:8px 7px; border:0; border-left:1px solid rgba(255,255,255,.09); background:none; box-shadow:inset 0 0 0 1px transparent; color:inherit; font:inherit; cursor:pointer; text-align:center; transition:background-color 180ms ease,box-shadow 180ms ease; }
.utility-security:hover,.utility-security:focus-visible,.utility-music-summary:hover,.utility-music-summary:focus-visible { background:rgba(255,255,255,.045); outline:none; }
.utility-security ha-icon { flex:0 0 auto; width:38px; height:38px; }
.utility-security > span { display:flex; flex-direction:column; align-items:center; min-width:0; text-align:center; }
.utility-security strong { color:rgba(255,255,255,.96); font-size:19px; line-height:21px; }
.utility-security small { margin-top:2px; color:rgba(220,226,229,.82); font-size:16px; font-weight:760; line-height:18px; letter-spacing:.35px; text-transform:uppercase; }
.utility-security.tone-critical { background:linear-gradient(135deg,rgba(239,83,80,.24),rgba(239,83,80,.1)); box-shadow:inset 0 0 0 1px rgba(239,83,80,.28); animation:security-critical-pulse 1.35s ease-in-out infinite; }
.utility-security.tone-attention { background:linear-gradient(135deg,rgba(255,193,7,.22),rgba(255,152,0,.08)); box-shadow:inset 0 0 0 2px rgba(255,193,7,.24); }
.utility-security.tone-success { position:relative; isolation:isolate; background:none; box-shadow:none; }
.utility-security.tone-success::before { content:""; position:absolute; z-index:0; inset:0; pointer-events:none; background:linear-gradient(135deg,rgba(62,157,69,.32),rgba(43,112,49,.16)); box-shadow:inset 0 0 0 2px rgba(102,187,106,.42),inset 0 0 28px rgba(102,187,106,.08); opacity:1; animation:security-armed-pulse 3.2s ease-in-out infinite; }
.utility-security.tone-success > * { position:relative; z-index:1; }
.utility-security.tone-critical ha-icon { color:#ff5f5c; }
.utility-security.tone-attention ha-icon { color:#ffc107; }
.utility-security.tone-success ha-icon { color:#7ee787; filter:drop-shadow(0 0 8px rgba(102,187,106,.3)); }
.utility-security.tone-success small { color:#b9f6ca; text-shadow:0 1px 8px rgba(0,0,0,.35); }
.utility-security.tone-attention small { color:#ffe082; }
.utility-security.tone-neutral ha-icon { color:rgba(255,255,255,.6); }
.utility-weather { display:block; min-width:0; overflow:hidden; padding:0 9px; border-left:1px solid rgba(255,255,255,.09); }
.utility-weather-track { display:flex; flex-direction:column; width:100%; height:100%; }
.utility-weather-track.has-next-climate { height:200%; transform:translateY(0); transition:transform 380ms cubic-bezier(.22,.61,.36,1); }
.utility-weather-track.has-next-climate.is-advancing { transform:translateY(-50%); }
.utility-weather-frame { display:flex; flex:0 0 100%; flex-direction:column; align-items:center; justify-content:center; gap:4px; width:100%; min-width:0; height:100%; text-align:center; }
.utility-weather-track.has-next-climate .utility-weather-frame { flex-basis:50%; height:50%; }
.utility-weather-temp { flex:0 0 auto; color:rgba(255,255,255,.97); font-size:50px; font-weight:720; line-height:1; letter-spacing:-1.6px; }
.utility-weather-copy { display:flex; flex-direction:column; align-items:center; width:100%; min-width:0; }
.utility-weather-copy strong { display:block; overflow:hidden; width:100%; color:rgba(255,255,255,.92); font-size:15px; font-weight:650; line-height:18px; text-overflow:ellipsis; white-space:nowrap; }
.utility-weather-copy small { margin-top:2px; color:rgba(220,226,229,.72); font-size:14px; font-weight:600; line-height:17px; }
@keyframes security-critical-pulse { 0%,100% { background-color:rgba(239,83,80,.04); box-shadow:inset 0 0 0 1px rgba(239,83,80,.28); } 50% { background-color:rgba(239,83,80,.15); box-shadow:inset 0 0 0 1px rgba(255,112,109,.58),inset 0 0 20px rgba(239,83,80,.12); } }
@keyframes security-armed-pulse { 0%,100% { opacity:1; } 50% { opacity:0; } }
.utility-music { display:grid; grid-template-columns:minmax(240px,.9fr) minmax(300px,1.1fr); align-items:center; min-width:0; border-left:1px solid rgba(255,255,255,.09); }
.utility-music-summary { display:flex; align-items:center; gap:15px; min-width:0; height:100%; padding:0 18px; border:0; background:none; color:inherit; font:inherit; cursor:pointer; text-align:left; }
.utility-music-art { display:grid; flex:0 0 52px; place-items:center; width:52px; height:52px; overflow:hidden; border-radius:13px; background:rgba(255,255,255,.055); box-shadow:inset 0 0 0 1px rgba(255,255,255,.055); }
.utility-music-art img { width:100%; height:100%; object-fit:cover; }
.utility-music-art ha-icon { width:42px; height:42px; color:#ab47bc; }
.utility-music-art.has-art ha-icon { display:none; }
.utility-music.playing .utility-music-art ha-icon { color:#66bb6a; }
.utility-music-summary > span:not(.utility-music-art) { display:flex; flex-direction:column; min-width:0; }
.utility-music-summary small { color:rgba(220,226,229,.68); font-size:12px; font-style:normal; font-weight:700; letter-spacing:.8px; text-transform:uppercase; }
.utility-music-summary strong,.utility-music-summary em { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.utility-music-summary strong { margin-top:4px; color:rgba(255,255,255,.96); font-size:20px; font-weight:680; line-height:24px; }
.utility-music-summary em { margin-top:3px; color:rgba(220,226,229,.72); font-size:15px; font-style:normal; line-height:18px; }
.utility-music-controls { display:flex; flex-direction:column; justify-content:center; gap:9px; min-width:0; padding:0 20px 0 7px; }
.music-control-row { display:grid; grid-template-columns:40px 48px 40px 24px minmax(90px,1fr); align-items:center; gap:9px; min-width:0; }
.utility-music-controls button { display:grid; place-items:center; width:40px; height:40px; padding:0; border:0; border-radius:50%; background:rgba(255,255,255,.065); color:rgba(255,255,255,.88); cursor:pointer; }
.utility-music-controls button:hover,.utility-music-controls button:focus-visible { background:rgba(255,255,255,.13); color:#fff; outline:none; }
.utility-music-controls button:disabled { cursor:default; opacity:.35; }
.utility-music-controls button ha-icon { width:24px; height:24px; }
.utility-music-controls .music-play-toggle { width:48px; height:48px; background:rgba(102,187,106,.16); color:#66bb6a; }
.music-volume-icon { width:23px; height:23px; color:rgba(255,255,255,.68); }
.music-volume { width:100%; min-width:80px; accent-color:#66bb6a; cursor:pointer; }
.music-volume:disabled { cursor:default; opacity:.35; }
.music-source { display:grid; grid-template-columns:52px minmax(0,1fr); align-items:center; gap:8px; min-width:0; }
.music-source > span { color:rgba(220,226,229,.64); font-size:12px; font-weight:680; letter-spacing:.4px; }
.music-source select { width:100%; min-width:0; height:32px; padding:0 28px 0 10px; border:1px solid rgba(255,255,255,.09); border-radius:9px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.88); font:inherit; font-size:13px; outline:none; }
.music-source select:focus { border-color:rgba(102,187,106,.45); }
.music-source select:disabled { opacity:.4; }

.ticker { position:relative; }

@media (prefers-reduced-motion: reduce) {
  .drawer-host .context-bar,
  .drawer-host.drawer-active .context-bar {
    transition:none;
  }
}

:host {
  display:block;
  width:100%;
  container-type:inline-size;
}

/* Local appearance system. Dark is the default baseline; light can be
   forced independently or selected automatically from Home Assistant. */
:host([data-theme-mode="light"]) {
  --primary-text-color:#1f2933;
  --secondary-text-color:#66727e;
  --card-background-color:#f7f9fb;
  --secondary-background-color:#edf1f5;
  --divider-color:rgba(36,49,61,.14);
  color:#1f2933;
}

:host([data-theme-mode="light"]) ha-card {
  color:#1f2933;
}

:host([data-theme-mode="light"]) .utility-header,
:host([data-theme-mode="light"]) .ticker {
  border-color:rgba(36,49,61,.14);
  background:linear-gradient(135deg,rgba(250,252,254,.96),rgba(235,240,245,.94));
  box-shadow:0 8px 24px rgba(36,49,61,.12),inset 0 1px 0 rgba(255,255,255,.9);
}

:host([data-theme-mode="light"]) .ticker-zone {
  border-color:rgba(36,49,61,.11) !important;
  background:linear-gradient(180deg,rgba(255,255,255,.72),rgba(231,237,242,.48)) !important;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.88) !important;
}

:host([data-theme-mode="light"]) .secondary-zone,
:host([data-theme-mode="light"]) .utility-security,
:host([data-theme-mode="light"]) .utility-weather,
:host([data-theme-mode="light"]) .utility-music {
  border-color:rgba(36,49,61,.12) !important;
}

:host([data-theme-mode="light"]) .utility-time,
:host([data-theme-mode="light"]) .utility-security strong,
:host([data-theme-mode="light"]) .utility-weather-temp,
:host([data-theme-mode="light"]) .utility-weather-copy strong,
:host([data-theme-mode="light"]) .utility-music-summary strong {
  color:#18222c;
}

:host([data-theme-mode="light"]) .utility-time small,
:host([data-theme-mode="light"]) .utility-date,
:host([data-theme-mode="light"]) .utility-security small,
:host([data-theme-mode="light"]) .utility-weather-copy small,
:host([data-theme-mode="light"]) .utility-music-summary small,
:host([data-theme-mode="light"]) .utility-music-summary em,
:host([data-theme-mode="light"]) .music-source > span {
  color:#66727e;
}

:host([data-theme-mode="light"]) .utility-security:hover,
:host([data-theme-mode="light"]) .utility-security:focus-visible,
:host([data-theme-mode="light"]) .utility-music-summary:hover,
:host([data-theme-mode="light"]) .utility-music-summary:focus-visible {
  background:rgba(36,49,61,.055);
}

:host([data-theme-mode="light"]) .utility-music-art,
:host([data-theme-mode="light"]) .utility-music-controls button {
  background:rgba(36,49,61,.07);
  box-shadow:inset 0 0 0 1px rgba(36,49,61,.06);
}

:host([data-theme-mode="light"]) .utility-music-controls button { color:#44515e; }
:host([data-theme-mode="light"]) .utility-music-controls button:hover,
:host([data-theme-mode="light"]) .utility-music-controls button:focus-visible {
  background:rgba(36,49,61,.12);
  color:#18222c;
}
:host([data-theme-mode="light"]) .utility-music-controls .music-play-toggle {
  background:rgba(76,175,80,.14);
  color:#2e7d32;
}
:host([data-theme-mode="light"]) .music-volume-icon { color:#66727e; }
:host([data-theme-mode="light"]) .music-source select {
  border-color:rgba(36,49,61,.13);
  background:rgba(255,255,255,.72);
  color:#27333e;
}

:host([data-theme-mode="light"]) .visual-center {
  border-color:rgba(36,49,61,.14);
  background:rgba(218,225,231,.72);
}

/* Media overlays intentionally remain dark translucent scrims in both themes
   so titles remain readable over arbitrary photographs/video. */
:host([data-theme-mode="light"]) .semantic-white { color:#52606d; }

:host([data-theme-mode="light"]) .drawer-host,
:host([data-theme-mode="light"]) .context-bar,
:host([data-theme-mode="light"]) .drawer-panel {
  color:#1f2933;
}

:host([data-drawer-open]) {
  width:var(--home-status-drawer-inline-size) !important;
  min-width:var(--home-status-drawer-inline-size) !important;
  max-width:var(--home-status-drawer-inline-size) !important;
}

.home-status-unavailable { min-height:132px; }
.home-status-unavailable > div { display:flex; flex-direction:column; gap:7px; padding:22px; }
.home-status-unavailable strong { font-size:18px; }
.home-status-unavailable span,.home-status-unavailable code { color:var(--secondary-text-color); }

:host([data-animation="none"]) * {
  animation:none !important;
  transition:none !important;
}

:host([data-animation="reduced"]) .weather-renderer-layer,
:host([data-animation="reduced"]) .utility-security {
  animation:none !important;
}

:host, ha-card {
  display:block;
  overflow:hidden;
  color:var(--primary-text-color);
  font-family:var(--paper-font-body1_-_font-family, sans-serif);
}

.phone-status-host { display:none; }

.ticker {
  height:380px !important;
  min-height:380px !important;
}

.primary-zone:has(.has-hero-media) { height:176px; }
.hero-zone-item.has-hero-media { height:176px; }


.ticker-footer { min-height:80px !important; padding-top:6px !important; }
.footer-marquee { height:80px !important; }
.footer-marquee-item { gap:12px !important; }
.footer-marquee-item ha-icon { width:30px !important; height:30px !important; }
.footer-marquee-copy strong { line-height:1.2; }
.footer-marquee-copy small { margin-top:5px; }


.ticker {
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  width:100%;
  max-width:none;
  height:235px;
  min-height:235px;
  margin:0;
  padding:7px 8px 6px;
  box-sizing:border-box;
  border:1px solid rgba(255,255,255,.085);
  border-radius:23px;
  background:linear-gradient(135deg,rgba(31,37,44,.78),rgba(15,19,24,.72));
  color:var(--primary-text-color);
  box-shadow:0 8px 24px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.035);
  cursor:pointer;
  text-align:left;
}

.utility-header ~ .ticker {
  border-radius:0 0 23px 23px;
}

:host([data-drawer-open]) .ticker {
  border-bottom-left-radius:0;
  border-bottom-right-radius:0;
}

.footer-glyph {
  display:inline-flex;
  flex:0 0 auto;
  align-items:center;
  justify-content:center;
  width:27px;
  height:27px;
  font-size:24px;
  line-height:1;
}

.footer-marquee-item ha-icon {
  flex:0 0 auto;
  width:27px;
  height:27px;
}

.semantic-red { color:#ef5350; }
.semantic-cyan { color:#26c6da; }
.semantic-sky { color:#4fc3f7; }
.semantic-green { color:#66bb6a; }
.semantic-teal { color:#26a69a; }
.semantic-purple { color:#ab47bc; }
.semantic-orange { color:#ff9800; }
.semantic-amber { color:#ffc107; }
.semantic-yellow { color:#fdd835; }
.semantic-blue { color:#42a5f5; }
.semantic-lime { color:#cddc39; }
.semantic-white { color:rgba(255,255,255,.86); }

.ticker-footer { min-height:80px; }
.footer-marquee { height:80px; }

.ticker-head {
  display:flex;
  align-items:center;
  width:100%;
  min-height:0;
  flex:1;
}

.ticker-zones {
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1fr);
  gap:10px;
  align-items:center;
  width:100%;
  min-height:0;
  flex:1;
}

.ticker-zones.has-visual {
  grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) minmax(0,1fr);
}

.visual-center {
  position:relative;
  display:grid;
  place-items:center;
  align-self:stretch;
  min-width:0;
  min-height:0;
  height:100%;
  overflow:hidden;
  border:1px solid rgba(255,255,255,.1);
  border-radius:14px;
  background:rgba(0,0,0,.22);
}

.visual-center-media,
.visual-center-camera {
  display:block;
  width:100%;
  height:100%;
  object-fit:cover;
  border:0;
}

.visual-center-camera {
  min-width:0;
}

.visual-center-overlay {
  position:absolute;
  inset:0;
  z-index:2;
  pointer-events:none;
  display:flex;
  flex-direction:column;
  justify-content:space-between;
  align-items:flex-start;
  padding:14px;
  background:
    linear-gradient(
      to bottom,
      rgba(0,0,0,.28) 0%,
      rgba(0,0,0,0) 34%,
      rgba(0,0,0,0) 55%,
      rgba(0,0,0,.76) 100%
    );
}

.visual-center-event-badge {
  display:inline-flex;
  align-items:center;
  gap:7px;
  padding:7px 10px;
  border:1px solid rgba(255,255,255,.16);
  border-radius:10px;
  background:rgba(10,12,16,.72);
  box-shadow:0 4px 14px rgba(0,0,0,.2);
  backdrop-filter:blur(8px);
  color:#ce93d8;
  font-size:14px;
  font-weight:800;
  line-height:1;
  letter-spacing:.025em;
}

.visual-center-event-badge ha-icon {
  --mdc-icon-size:18px;
}

.visual-center-news-badge {
  display:inline-flex;
  align-items:center;
  gap:7px;
  padding:7px 10px;
  border:1px solid rgba(255,255,255,.16);
  border-radius:10px;
  background:rgba(10,12,16,.72);
  box-shadow:0 4px 14px rgba(0,0,0,.2);
  backdrop-filter:blur(8px);
  color:rgba(255,255,255,.94);
  font-size:14px;
  font-weight:800;
  line-height:1;
  letter-spacing:.025em;
}

.visual-center-news-badge ha-icon {
  --mdc-icon-size:18px;
}

.visual-center-event-title {
  display:-webkit-box;
  width:100%;
  overflow:hidden;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  color:rgba(255,255,255,.98);
  font-size:clamp(17px,1.55vw,23px);
  font-weight:800;
  line-height:1.12;
  text-shadow:0 2px 8px rgba(0,0,0,.8);
}

.visual-center.has-visual-overlay {
  cursor:pointer;
}

.visual-center-fallback {
  padding:14px;
  color:var(--secondary-text-color);
  font-size:13px;
  line-height:1.35;
  text-align:center;
}

/* Shared current-information lanes: three fixed vertical slots use the full side-column height before rotating. */
:host([data-profile="auto"]) .ticker-zone,
:host([data-profile="tablet"]) .ticker-zone,
:host([data-profile="desktop"]) .ticker-zone {
  align-self:stretch;
  height:100% !important;
  min-height:0 !important;
  overflow:hidden;
  border:1px solid rgba(255,255,255,.075);
  border-radius:16px;
  background:linear-gradient(180deg,rgba(20,27,34,.34),rgba(11,16,21,.18));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.025);
}

:host([data-profile="auto"]) .secondary-zone,
:host([data-profile="tablet"]) .secondary-zone,
:host([data-profile="desktop"]) .secondary-zone {
  padding-left:0;
  border-left:1px solid rgba(255,255,255,.075);
}

.zone-lane-viewport {
  display:block;
  width:100%;
  height:100%;
  min-height:0;
  overflow:hidden;
}

.zone-single {
  display:flex;
  align-items:center;
  width:100%;
  height:100%;
  min-height:0;
  overflow:hidden;
}

.zone-single .lane-item {
  display:grid !important;
  grid-template-columns:auto minmax(0,1fr);
  align-items:center;
  gap:14px;
  width:100%;
  height:100%;
  min-height:0;
  padding:14px 18px;
  box-sizing:border-box;
  overflow:hidden;
}

.zone-single .lane-icon {
  display:grid;
  place-items:center;
}

.primary-zone .zone-single .lane-icon,
.primary-zone .zone-single .lane-icon ha-icon {
  width:var(--hs-left-icon-size,60px) !important;
  height:var(--hs-left-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-left-icon-size,60px) !important;
}

.secondary-zone .zone-single .lane-icon,
.secondary-zone .zone-single .lane-icon ha-icon {
  width:var(--hs-right-icon-size,60px) !important;
  height:var(--hs-right-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-right-icon-size,60px) !important;
}

.zone-single .lane-copy {
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  overflow:hidden;
}

.zone-single .lane-title {
  display:-webkit-box;
  overflow:hidden;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  color:rgba(255,255,255,.96);
  font-weight:760;
  line-height:1.08;
}

.primary-zone .zone-single .lane-title { font-size:var(--hs-left-title-size,48px) !important; }
.secondary-zone .zone-single .lane-title { font-size:var(--hs-right-title-size,48px) !important; }
.primary-zone .zone-single .lane-item.is-measurement .lane-title { font-size:var(--hs-left-value-size,72px) !important; }
.secondary-zone .zone-single .lane-item.is-measurement .lane-title { font-size:var(--hs-right-value-size,72px) !important; }
.secondary-zone .zone-single .lane-item.is-current-weather .lane-title { font-size:var(--hs-right-weather-size,72px) !important; }

.zone-single .lane-summary {
  display:-webkit-box;
  margin-top:7px;
  overflow:hidden;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
  color:rgba(255,255,255,.72);
  font-weight:520;
  line-height:1.15;
}

.primary-zone .zone-single .lane-summary { font-size:var(--hs-left-summary-size,32px) !important; }
.secondary-zone .zone-single .lane-summary { font-size:var(--hs-right-summary-size,32px) !important; }

:host([data-lane-mode="single"]) .ticker-zone {
  border-color:transparent;
  background:transparent;
  box-shadow:none;
}

:host([data-lane-mode="single"]) .secondary-zone {
  border-left:1px solid rgba(255,255,255,.1);
}

.zone-lane {
  display:grid;
  /*
   * Three-slot mode means "up to three visible items", not three rigid
   * one-third-height boxes. Each row gets at least its natural content
   * height, then shares whatever vertical room remains.
   */
  grid-template-rows:repeat(3,minmax(min-content,1fr));
  align-content:stretch;
  width:100%;
  height:100%;
  min-height:0;
}

.lane-slot {
  position:relative;
  display:block;
  width:100%;
  min-width:0;
  min-height:min-content;
  overflow:hidden;
}

.lane-slot:not(:last-child) {
  border-bottom:1px solid rgba(255,255,255,.085);
}

.lane-slot-track {
  display:grid;
  grid-template-rows:minmax(0,1fr);
  width:100%;
  height:100%;
  min-height:0;
  transform:translateY(0);
}

.lane-slot-track.has-next-row {
  height:200%;
  grid-template-rows:repeat(2,50%);
  transition:transform 400ms cubic-bezier(.4,0,.2,1);
}

.lane-slot-track.has-next-row.is-advancing {
  transform:translateY(-50%);
}

.lane-slot.is-empty:first-child .zone-empty {
  display:flex;
  align-items:center;
  height:100%;
  padding:7px 12px;
}

.zone-lane .lane-item {
  position:relative;
  display:grid !important;
  grid-template-columns:38px minmax(0,1fr);
  align-items:center;
  width:100%;
  height:auto;
  min-height:100%;
  padding:7px 12px;
  box-sizing:border-box;
  overflow:hidden;
  border-bottom:0;
  opacity:1;
  background:transparent;
  transition:background 160ms ease;
}

.zone-lane .lane-item:hover {
  background:rgba(255,255,255,.025);
}

.zone-lane .lane-icon {
  display:grid;
  place-items:center;
  width:var(--hs-left-icon-size,60px);
  height:var(--hs-left-icon-size,60px);
}

.primary-zone .zone-lane .lane-icon,
.primary-zone .zone-lane .lane-icon ha-icon {
  width:var(--hs-left-icon-size,60px) !important;
  height:var(--hs-left-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-left-icon-size,60px) !important;
}

.secondary-zone .zone-lane .lane-icon,
.secondary-zone .zone-lane .lane-icon ha-icon {
  width:var(--hs-right-icon-size,60px) !important;
  height:var(--hs-right-icon-size,60px) !important;
  --mdc-icon-size:var(--hs-right-icon-size,60px) !important;
}

.zone-lane .lane-copy {
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  max-height:none;
  overflow:visible;
}

.zone-lane .lane-title {
  display:-webkit-box;
  overflow:hidden;
  -webkit-box-orient:vertical;
  /*
   * Let normal content wrap naturally. Four lines is only a guardrail for
   * malformed/novel-length payloads, not the normal row geometry.
   */
  -webkit-line-clamp:4;
  color:rgba(255,255,255,.96);
  font-weight:760;
  line-height:1.08;
  white-space:normal;
  overflow-wrap:anywhere;
}

.primary-zone .zone-lane .lane-title {
  font-size:var(--hs-left-title-size,48px) !important;
}

.secondary-zone .zone-lane .lane-title {
  font-size:var(--hs-right-title-size,48px) !important;
}

.primary-zone .zone-lane .lane-item.is-measurement .lane-title {
  font-size:var(--hs-left-value-size,72px) !important;
}

.secondary-zone .zone-lane .lane-item.is-measurement .lane-title {
  font-size:var(--hs-right-value-size,72px) !important;
}

.secondary-zone .zone-lane .lane-item.is-current-weather .lane-title {
  font-size:var(--hs-right-weather-size,72px) !important;
}

.zone-lane .lane-summary {
  display:-webkit-box;
  margin-top:4px;
  overflow:hidden;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:3;
  color:rgba(255,255,255,.66);
  font-weight:520;
  line-height:1.12;
  white-space:normal;
  overflow-wrap:anywhere;
}

.primary-zone .zone-lane .lane-summary {
  font-size:var(--hs-left-summary-size,32px) !important;
}

.secondary-zone .zone-lane .lane-summary {
  font-size:var(--hs-right-summary-size,32px) !important;
}

@media (prefers-reduced-motion: reduce) {
  .lane-slot-track.has-next-row {
    transition:none !important;
  }
}

.hero-zone-item {
  position:relative;
  overflow:hidden;
  isolation:isolate;
}

.hero-zone-item .hero-media-wrap,
.hero-zone-item .hero-content {
  position:relative;
  z-index:1;
}

.hero-zone-item .hero-media-wrap {
  position:absolute;
  inset:0;
  z-index:0;
  border-radius:14px;
  overflow:hidden;
  background:rgba(0,0,0,.28);
}

.hero-zone-item .hero-media {
  display:block;
  width:100%;
  height:100%;
  object-fit:cover;
}

.hero-zone-item .hero-media-overlay {
  position:absolute;
  inset:0;
  background:linear-gradient(90deg,rgba(0,0,0,.72),rgba(0,0,0,.22) 70%,rgba(0,0,0,.08));
}

.hero-zone-item:has(.hero-media) .hero-content {
  padding:12px 16px;
}

.hero-zone-item.has-hero-media {
  display:grid;
  grid-template-columns:minmax(0,45%) minmax(0,1fr);
  gap:16px;
  align-items:center;
  width:100%;
  height:140px;
  overflow:hidden;
}

.hero-zone-item.has-hero-media .hero-media-wrap {
  position:relative;
  inset:auto;
  width:100%;
  height:100%;
  min-height:0;
  border-radius:14px;
}

.hero-zone-item.has-hero-media .hero-media-overlay {
  display:none;
}

.hero-zone-item.has-hero-media .hero-content {
  padding:0;
  min-width:0;
}

.primary-zone:has(.has-hero-media) {
  height:140px;
}

.icon-tone-critical { color:#ef5350; }
.icon-tone-attention { color:#ff9800; }
.icon-tone-success { color:#66bb6a; }
.icon-tone-information { color:#42a5f5; }
.icon-tone-media { color:#ab47bc; }
.icon-tone-neutral { color:rgba(255,255,255,.72); }

.zone-item {
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  width:100%;
  cursor:pointer;
  opacity:1;
  transition:opacity 180ms ease, transform 180ms ease;
}

.zone-changing .zone-item {
  opacity:0;
  transform:translateY(4px);
}

.zone-title {
  display:flex;
  align-items:center;
  gap:8px;
  min-width:0;
  overflow:hidden;
  font-weight:650;
  line-height:1.2;
  white-space:nowrap;
}

.zone-title span {
  overflow:hidden;
  text-overflow:ellipsis;
}

.zone-title ha-icon {
  flex:0 0 auto;
  width:22px;
  height:22px;
}

.zone-summary {
  display:-webkit-box;
  margin-top:7px;
  overflow:hidden;
  color:rgba(255,255,255,.76);
  line-height:1.35;
  -webkit-box-orient:vertical;
  -webkit-line-clamp:2;
}

.zone-empty {
  color:var(--secondary-text-color);
  font-size:13px;
}

.ticker-zone {
  display:flex;
  align-items:center;
  min-width:0;
  height:150px;
}

.secondary-zone {
  padding-left:24px;
  border-left:1px solid rgba(255,255,255,.1);
}

.secondary-item {
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  width:100%;
  height:150px;
}

.secondary-empty {
  opacity:.65;
}

.ticker:focus-visible {
  outline:2px solid var(--focus-color,#42a5f5);
  outline-offset:3px;
}

.main-icon {
  display:grid;
  place-items:center;
  flex:0 0 40px;
  width:40px;
  height:40px;
  border-radius:12px;
  background:rgba(102,187,106,.12);
  color:#66bb6a;
}

.priority-critical .main-icon {
  color:#ef5350;
  background:rgba(239,83,80,.12);
}

.priority-attention .main-icon {
  color:#ff9800;
  background:rgba(255,152,0,.12);
}

.priority-activity .main-icon {
  color:#42a5f5;
  background:rgba(66,165,245,.12);
}

.primary-zone {
  padding-right:4px;
}


.bottom-stream {
  flex:1 1 auto;
  min-width:0;
  overflow:hidden;
}

.footer-marquee {
  position:relative;
  width:100%;
  overflow:hidden;
}

.footer-marquee-track {
  display:flex;
  width:max-content;
  animation:footer-marquee var(--marquee-duration,30s) linear infinite;
  will-change:transform;
}

.footer-sequence {
  display:flex;
  flex:0 0 auto;
  align-items:center;
}

.footer-marquee-item {
  display:inline-flex;
  align-items:center;
  gap:6px;
  margin-right:14px;
  font-size:13px;
  text-transform:uppercase;
  letter-spacing:.2px;
}

.footer-marquee-item ha-icon {
  width:17px;
  height:17px;
}

.footer-marquee-item small {
  margin-left:2px;
  color:var(--secondary-text-color);
  font-size:11px;
  text-transform:none;
  letter-spacing:0;
}

.footer-marquee-separator {
  margin:0 16px;
  color:var(--secondary-text-color);
  font-size:12px;
}

@keyframes footer-marquee {
  from { transform:translate3d(0,0,0); }
  to { transform:translate3d(calc(-1 * var(--marquee-distance)),0,0); }
}

.ticker-primary {
  overflow:hidden;
  font-size:25px;
  font-weight:650;
  line-height:30px;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.ticker-detail {
  display:block;
  max-width:100%;
  margin-top:8px;
  overflow:hidden;
  color:rgba(255,255,255,.82);
  font-size:15px;
  line-height:20px;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.ticker-secondary {
  overflow:hidden;
  margin-top:7px;
  color:var(--secondary-text-color);
  font-size:13px;
  line-height:17px;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.ticker-footer {
  min-height:68px;
  box-sizing:border-box;
}

.footer-marquee {
  height:68px;
}

.footer-marquee-track {
  height:100%;
  align-items:stretch;
}

.footer-sequence {
  height:100%;
}

.footer-marquee-item {
  position:relative;
  display:inline-flex;
  align-items:center;
  min-width:max-content;
  height:100%;
  padding:0 28px;
  margin-right:0;
  box-sizing:border-box;
  font-size:inherit;
  text-transform:none;
  letter-spacing:0;
}

.footer-marquee-item + .footer-marquee-item::before,
.footer-sequence + .footer-sequence .footer-marquee-item:first-child::before {
  content:"";
  position:absolute;
  left:0;
  width:1px;
  height:38px;
  background:rgba(255,255,255,.25);
}

.footer-marquee-item > [data-stream-id] {
  display:flex;
  align-items:center;
  gap:10px;
  min-width:0;
}

.footer-marquee-item ha-icon {
  flex:0 0 auto;
  width:27px;
  height:27px;
}

.footer-marquee-copy {
  display:flex;
  flex-direction:column;
  justify-content:center;
  min-width:0;
  line-height:1.15;
  white-space:nowrap;
}

.footer-marquee-copy strong {
  color:rgba(255,255,255,.94);
  font-size:16px;
  font-weight:600;
}

.footer-marquee-copy small {
  display:block;
  margin-top:3px;
  color:var(--secondary-text-color);
  font-size:13px;
  opacity:.7;
  text-transform:none;
  letter-spacing:0;
}

.footer-marquee-item.is-current-weather ha-icon,
.footer-marquee-item.is-indoor-temperature ha-icon {
  width:34px;
  height:34px;
  --mdc-icon-size:34px;
}

.footer-marquee-item.is-current-weather .footer-marquee-copy strong,
.footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong {
  font-size:25px;
  font-weight:720;
  line-height:1;
}

.footer-marquee-item.is-current-weather .footer-marquee-copy small,
.footer-marquee-item.is-indoor-temperature .footer-marquee-copy small {
  margin-top:4px;
  font-size:17px;
  line-height:1;
  opacity:.82;
}

.footer-marquee.single-item .footer-marquee-track {
  animation:none !important;
  transform:none !important;
}

.footer-marquee.group-details-open .footer-marquee-track {
  animation-play-state:paused;
  visibility:hidden;
}

.footer-group-detail {
  position:absolute;
  z-index:3;
  inset:0 18px;
  box-sizing:border-box;
  display:flex;
  align-items:center;
  justify-content:center;
  flex-direction:column;
  gap:7px;
  width:calc(100% - 36px);
  padding:8px 18px;
  border:0;
  background:rgba(17,22,28,.96);
  color:inherit;
  cursor:pointer;
  text-align:center;
}

.footer-group-detail strong {
  color:#90caf9;
  font-size:23px;
  font-weight:800;
  line-height:1.05;
}

.footer-group-detail small {
  color:rgba(255,255,255,.9);
  font-size:18px;
  font-weight:650;
  line-height:1.12;
}

[data-footer-group-labels] {
  cursor:pointer;
}

[data-footer-group-labels].footer-group-expanded .footer-marquee-copy strong {
  color:#90caf9;
}

.drawer {
  margin-top:0;
  max-height:min(58vh,560px);
  overflow:hidden;
  border:1px solid rgba(255,255,255,.085);
  border-top:0;
  border-radius:0 0 24px 24px;
  background:linear-gradient(145deg,rgba(31,37,44,.94),rgba(14,18,23,.94));
}

.drawer-host {
  width:100%;
  margin:0;
  overflow:hidden;
  box-sizing:border-box;
}

.drawer-host .context-bar {
  transform:translateY(-100%);
  transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0);
}

.drawer-host.drawer-active .context-bar {
  transform:translateY(0);
  transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0);
}

.context-bar {
  display:grid;
  grid-template-columns:repeat(5,minmax(0,1fr));
  grid-template-rows:repeat(var(--home-status-drawer-rows,2),58px);
  align-items:stretch;
  gap:10px;
  width:100%;
  height:var(--home-status-drawer-height,146px);
  min-height:var(--home-status-drawer-height,146px);
  margin:0;
  padding:10px 16px;
  box-sizing:border-box;
  overflow:hidden;
  border:1px solid rgba(255,255,255,.085);
  border-top:0;
  border-radius:0 0 23px 23px;
  background:rgba(18,23,28,.96);
}

.context-action {
  display:flex;
  grid-column:auto;
  align-items:center;
  justify-content:flex-start;
  gap:11px;
  min-width:0;
  height:58px;
  padding:0 14px;
  border:1px solid rgba(255,255,255,.08);
  border-radius:13px;
  background:rgba(255,255,255,.045);
  color:rgba(255,255,255,.8);
  font:inherit;
  cursor:pointer;
  transition:border-color 180ms ease,background 180ms ease,color 180ms ease;
}

.context-action:hover {
  background:rgba(255,255,255,.1);
  color:#fff;
}

.context-action ha-icon {
  flex:0 0 auto;
  width:24px;
  height:24px;
}

.context-action-copy {
  display:flex;
  flex-direction:column;
  min-width:0;
  text-align:left;
}

.context-action-copy strong,
.context-action-copy small {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.context-action-copy strong {
  color:rgba(255,255,255,.96);
  font-size:17px;
  font-weight:680;
  line-height:21px;
}

.context-action-copy small {
  margin-top:3px;
  color:rgba(220,226,229,.72);
  font-size:14px;
  font-weight:520;
  line-height:17px;
}

.context-action.tone-information {
  border-color:rgba(66,165,245,.3);
  background:linear-gradient(135deg,rgba(66,165,245,.15),rgba(255,255,255,.035));
}

.context-action.tone-information ha-icon {
  color:#42a5f5;
}

.context-action.tone-success {
  border-color:rgba(102,187,106,.3);
  background:linear-gradient(135deg,rgba(102,187,106,.15),rgba(255,255,255,.035));
}

.context-action.tone-success ha-icon {
  color:#66bb6a;
}

.context-action.tone-attention {
  border-color:rgba(255,193,7,.34);
  background:linear-gradient(135deg,rgba(255,193,7,.17),rgba(255,255,255,.035));
}

.context-action.tone-attention ha-icon {
  color:#ffc107;
}

.context-action.tone-critical {
  border-color:rgba(239,83,80,.38);
  background:linear-gradient(135deg,rgba(239,83,80,.19),rgba(255,255,255,.035));
}

.context-action.tone-critical ha-icon {
  color:#ef5350;
}

.context-action.active .context-action-copy small {
  color:rgba(255,255,255,.82);
}

.context-action[data-context-action="security"] ha-icon { color:#ef5350; }
.context-action[data-context-action="lighting"] ha-icon { color:#ffc107; }
.context-action[data-context-action="cameras"] ha-icon { color:#42a5f5; }
.context-action[data-context-action="calendar"] ha-icon { color:#ab47bc; }
.context-action[data-context-action="music"] ha-icon { color:#ec407a; }
.context-action[data-context-action="location"] ha-icon { color:#42a5f5; }
.context-action[data-context-action="movies"] ha-icon { color:#7e57c2; }
.context-action[data-context-action="sprinklers"] ha-icon { color:#26a69a; }
.context-action[data-context-action="energy"] ha-icon { color:#fdd835; }

.context-action.tone-information ha-icon { color:#42a5f5; }
.context-action.tone-success ha-icon { color:#66bb6a; }
.context-action.tone-attention ha-icon { color:#ffc107; }
.context-action.tone-critical ha-icon { color:#ef5350; }

.drawer h2 {
  display:flex;
  align-items:center;
  gap:8px;
  margin:0;
  padding:15px 20px 12px;
  font-size:22px;
}

.section-title {
  padding:9px 20px 7px;
  color:var(--secondary-text-color);
  font-size:10px;
  font-weight:650;
  letter-spacing:1px;
}

.recent-title {
  margin-top:12px;
  border-top:1px solid rgba(255,255,255,.07);
  padding-top:13px;
}

.active-list {
  padding:0 16px;
}

.recent-list {
  max-height:calc(min(58vh,560px) - 160px);
  overflow-y:auto;
  padding:0 16px 18px;
  scrollbar-width:thin;
  overscroll-behavior:contain;
  touch-action:pan-y;
}

.event {
  margin:0 0 7px;
  border:1px solid rgba(255,255,255,.055);
  border-left:3px solid var(--event-color);
  border-radius:16px;
  background:rgba(255,255,255,.025);
  overflow:hidden;
}

.event-head {
  display:grid;
  grid-template-columns:34px minmax(0,1fr) 20px;
  gap:10px;
  align-items:center;
  width:100%;
  min-height:52px;
  padding:8px 11px;
  border:0;
  background:none;
  color:inherit;
  cursor:pointer;
  text-align:left;
}

.event-icon {
  display:grid;
  place-items:center;
  width:30px;
  height:30px;
  border-radius:10px;
  color:var(--event-color);
  background:color-mix(in srgb,var(--event-color) 12%,transparent);
}

.event-copy {
  display:flex;
  flex-direction:column;
  min-width:0;
}

.event-copy strong,
.event-copy small {
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.event-copy strong {
  font-size:15px;
}

.event-copy small {
  color:var(--secondary-text-color);
  font-size:12px;
}

.chevron {
  transition:transform 180ms ease;
}

.expanded .chevron {
  transform:rotate(90deg);
}

.event-details {
  display:none;
  padding:0 14px 12px;
  border-top:1px solid rgba(255,255,255,.045);
}

.expanded .event-details {
  display:block;
}

.field {
  display:flex;
  flex-direction:column;
  margin-top:9px;
}

.field small {
  color:var(--secondary-text-color);
  font-size:10px;
  text-transform:uppercase;
  letter-spacing:.55px;
}

.field span {
  font-size:12px;
  line-height:16px;
}

.open-device {
  display:inline-flex;
  align-items:center;
  gap:7px;
  margin-top:12px;
  padding:7px 10px;
  border:1px solid rgba(255,255,255,.075);
  border-radius:11px;
  background:rgba(255,255,255,.035);
  color:inherit;
  cursor:pointer;
}

.empty {
  min-height:52px;
  padding:8px 11px;
  color:var(--secondary-text-color);
  font-size:13px;
}

@media (prefers-reduced-motion:reduce) {
  .zone-item { transition:none; }

  .utility-security.tone-critical,
  .utility-security.tone-success::before {
    animation:none;
  }
}

@container (max-width:760px) {
  .utility-header {
    grid-template-columns:1fr 1fr;
    grid-template-rows:72px 92px;
    height:164px;
    min-height:164px;
    border-radius:19px 19px 0 0;
  }

  .utility-clock { padding:0 16px; }
  .utility-time strong { font-size:35px; }
  .utility-clock-seconds { font-size:16px; }
  .utility-time small { font-size:13px; }
  .utility-date { margin-top:4px; font-size:11px; }

  .utility-security { padding:0 12px; }
  .utility-security ha-icon { width:28px; height:28px; }

  .utility-music {
    grid-column:1 / -1;
    grid-template-columns:minmax(150px,.8fr) minmax(230px,1.2fr);
    border-top:1px solid rgba(255,255,255,.09);
    border-left:0;
  }

  .utility-music-controls {
    padding-right:14px;
  }
}

@container (max-width:600px) {
  .ticker {
    width:100%;
    height:194px !important;
    min-height:194px !important;
    padding:13px 15px 11px;
    border-radius:19px;
  }

  .utility-header ~ .ticker {
    border-radius:0 0 19px 19px;
  }

  .ticker-zones {
    grid-template-columns:minmax(0,1fr) 30px;
    gap:8px;
  }

  .secondary-zone { display:none; }
  .ticker-zone { height:58px; }

  .primary-zone .zone-title { font-size:19px; }
  .primary-zone .zone-summary { font-size:12px; }
  .primary-zone .zone-title ha-icon { width:19px; height:19px; }

  .ticker-footer {
    padding-top:7px;
    font-size:9px;
    gap:7px;
  }

  .footer-action { display:none; }

  .context-bar {
    grid-template-columns:repeat(3,minmax(0,1fr));
    grid-template-rows:repeat(3,52px);
    height:176px;
    min-height:176px;
    padding:7px 9px;
    gap:6px;
  }

  .context-action,
  .context-action:nth-child(6) {
    grid-column:auto;
    height:52px;
    padding:0 9px;
    gap:7px;
  }

  .context-action ha-icon {
    width:20px;
    height:20px;
  }

  .context-action-copy strong {
    font-size:14px;
    line-height:17px;
  }

  .context-action-copy small {
    font-size:11px;
    line-height:13px;
  }
}


.zone-title {
  gap:10px;
}

.zone-title ha-icon {
  width:26px;
  height:26px;
}

.ticker-footer,
.footer-marquee {
  min-height:88px;
  height:88px;
}

.footer-marquee-item ha-icon {
  width:32px;
  height:32px;
}

.footer-marquee-copy strong {
  color:#fff;
  font-size:18px;
  font-weight:760;
  letter-spacing:.55px;
}

.footer-marquee-copy small {
  margin-top:4px;
  opacity:.78;
}

.context-bar {
  grid-template-rows:repeat(2,68px);
  height:166px;
  min-height:166px;
}

.context-action {
  height:68px;
}

.ticker {
  isolation:isolate;
  overflow:hidden;
  background:rgba(23,28,34,.82);
}

.ticker > :not(.weather-renderer-layer) {
  position:relative;
  z-index:1;
}

.ticker > .weather-renderer-layer {
  position:absolute;
  z-index:0;
  inset:-8% -10% 88px;
  border-radius:22px 22px 0 0;
  opacity:0;
  pointer-events:none;
  transition:none;
  background-repeat:repeat;
  will-change:transform,opacity,background-position;
}

.weather-renderer-layer.lottie-weather-layer {
  overflow:hidden;
  background:none;
}

.weather-renderer-layer.lottie-rain-layer {
  opacity:.32;
  overflow:hidden;
  background:none;
}

.weather-renderer-layer.lottie-rain-layer canvas {
  display:block;
  width:100% !important;
  height:100% !important;
}

.weather-renderer-layer.video-weather-layer {
  width:auto;
  height:auto;
  object-fit:cover;
  opacity:.22;
  mix-blend-mode:screen;
  filter:saturate(.72) brightness(.78);
  background:none;
}

.weather-renderer-layer.weather-effect-rain {
  opacity:.26;
  background-image:repeating-linear-gradient(105deg,transparent 0 24px,rgba(190,225,255,.76) 25px 27px,transparent 28px 52px);
  background-size:96px 120px;
  animation:ambient-rain 3.2s linear infinite;
}

.weather-renderer-layer.weather-effect-clouds {
  opacity:.25;
  mix-blend-mode:screen;
  background:radial-gradient(ellipse 40% 31% at 24% 38%,rgba(211,225,237,.68) 0 38%,transparent 70%),radial-gradient(ellipse 46% 34% at 74% 45%,rgba(178,199,217,.56) 0 38%,transparent 72%);
  filter:blur(6px);
  animation:ambient-clouds 18s ease-in-out infinite alternate;
}

.weather-renderer-layer.weather-effect-fog {
  opacity:.27;
  mix-blend-mode:screen;
  background:linear-gradient(180deg,transparent 16%,rgba(222,229,231,.44) 34%,transparent 52%),linear-gradient(180deg,transparent 48%,rgba(202,215,219,.48) 65%,transparent 82%);
  filter:blur(8px);
  animation:ambient-fog 20s ease-in-out infinite alternate;
}

.weather-renderer-layer.weather-effect-wind {
  opacity:.26;
  mix-blend-mode:screen;
  background:linear-gradient(174deg,transparent 28%,rgba(181,225,222,.62) 31% 34%,transparent 37% 58%,rgba(159,209,211,.52) 61% 64%,transparent 67%);
  filter:blur(3px);
  animation:ambient-wind 12s ease-in-out infinite alternate;
}

.weather-renderer-layer.weather-effect-storm {
  opacity:.32;
  background-image:radial-gradient(ellipse at center,rgba(215,221,255,.92),transparent 58%),linear-gradient(180deg,rgba(8,12,23,.44),rgba(29,34,52,.26));
  background-repeat:no-repeat;
  background-size:42% 100%,100% 100%;
  animation:ambient-storm 10s ease-in-out infinite;
}

.weather-renderer-layer.weather-effect-night {
  opacity:.3;
  mix-blend-mode:screen;
  background:radial-gradient(circle at 80% 22%,rgba(213,224,255,.72) 0 3%,rgba(155,179,236,.26) 4% 10%,transparent 20%),radial-gradient(ellipse at center,transparent 42%,rgba(2,6,18,.66) 100%);
  animation:ambient-night 28s ease-in-out infinite alternate;
}

.weather-renderer-layer.ambient-paused {
  animation-play-state:paused;
  visibility:hidden;
}

@keyframes ambient-rain {
  from { background-position:0 -120px; }
  to { background-position:0 120px; }
}

@keyframes ambient-clouds {
  from { transform:translate3d(-18%,0,0) scale(1.02); }
  to { transform:translate3d(18%,1%,0) scale(1.04); }
}

@keyframes ambient-fog {
  from { transform:translate3d(-24%,0,0) scale(1.06); }
  to { transform:translate3d(24%,0,0) scale(1.06); }
}

@keyframes ambient-wind {
  from { transform:translate3d(-30%,0,0); }
  to { transform:translate3d(30%,1%,0); }
}

@keyframes ambient-storm {
  0%,18% { background-position:-45% 0,0 0; opacity:.32; }
  38%,48% { background-position:40% 0,0 0; opacity:.58; }
  68%,100% { background-position:145% 0,0 0; opacity:.32; }
}

@keyframes ambient-night {
  from { transform:translate3d(-2%,0,0); }
  to { transform:translate3d(2%,1%,0); }
}

@media (prefers-reduced-motion:reduce) {
  .weather-renderer-layer {
    transition:none;
  }
}

@container (max-width:600px) {
  :host([data-profile="auto"]) .utility-header,
  :host([data-profile="auto"]) .ticker,
  :host([data-profile="auto"]) .drawer-host,
  :host([data-profile="phone"]) .utility-header,
  :host([data-profile="phone"]) .ticker,
  :host([data-profile="phone"]) .drawer-host {
    display:none !important;
  }

  .phone-status-host {
    display:block;
  }

  .phone-status-shell {
    overflow:hidden;
    border:1px solid rgba(255,255,255,.085);
    border-radius:18px;
    background:linear-gradient(135deg,rgba(31,37,44,.82),rgba(15,19,24,.78));
    box-shadow:0 6px 18px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.035);
  }

  .phone-status-current {
    display:grid;
    grid-template-columns:42px minmax(0,1fr) 22px;
    align-items:center;
    gap:10px;
    width:100%;
    min-height:78px;
    padding:10px 13px;
    border:0;
    background:none;
    color:inherit;
    font:inherit;
    text-align:left;
  }

  .phone-status-current:disabled {
    opacity:1;
  }

  .phone-status-current.is-actionable {
    cursor:pointer;
  }

  .phone-status-current.is-actionable:focus-visible {
    outline:2px solid var(--focus-color,#42a5f5);
    outline-offset:-3px;
  }

  .phone-status-icon {
    display:grid;
    place-items:center;
    width:38px;
    height:38px;
    border-radius:12px;
    background:rgba(66,165,245,.12);
    color:#42a5f5;
  }

  .phone-status-current.priority-critical .phone-status-icon {
    background:rgba(239,83,80,.14);
    color:#ef5350;
  }

  .phone-status-current.priority-attention .phone-status-icon {
    background:rgba(255,152,0,.14);
    color:#ff9800;
  }

  .phone-status-current.priority-normal .phone-status-icon {
    background:rgba(102,187,106,.13);
    color:#66bb6a;
  }

  .phone-status-icon ha-icon {
    width:24px;
    height:24px;
  }

  .phone-status-copy {
    display:flex;
    flex-direction:column;
    min-width:0;
  }

  .phone-status-copy small {
    color:var(--secondary-text-color);
    font-size:10px;
    font-weight:700;
    letter-spacing:.75px;
    text-transform:uppercase;
  }

  .phone-status-copy strong,
  .phone-status-copy span {
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }

  .phone-status-copy strong {
    margin-top:2px;
    color:rgba(255,255,255,.96);
    font-size:16px;
    line-height:20px;
  }

  .phone-status-copy span {
    margin-top:2px;
    color:rgba(220,226,229,.72);
    font-size:12px;
    line-height:15px;
  }

  .phone-status-chevron {
    width:20px;
    height:20px;
    color:var(--secondary-text-color);
  }

  .phone-status-ticker {
    height:52px;
    overflow:hidden;
    border-top:1px solid rgba(255,255,255,.075);
    white-space:nowrap;
  }

  .phone-status-ticker-track {
    display:flex;
    width:max-content;
    min-width:100%;
    height:100%;
    animation:phone-status-marquee var(--home-status-phone-ticker-seconds,32s) linear infinite;
    will-change:transform;
  }

  .phone-status-ticker-sequence {
    display:flex;
    flex:0 0 auto;
    align-items:stretch;
    height:100%;
  }

  .phone-status-ticker-item {
    position:relative;
    display:inline-flex;
    align-items:center;
    gap:8px;
    min-width:max-content;
    height:100%;
    padding:0 16px;
    box-sizing:border-box;
    color:inherit;
  }

  .phone-status-ticker-item + .phone-status-ticker-item::before,
  .phone-status-ticker-sequence + .phone-status-ticker-sequence .phone-status-ticker-item:first-child::before {
    content:"";
    position:absolute;
    left:0;
    width:1px;
    height:28px;
    background:rgba(255,255,255,.18);
  }

  .phone-status-ticker-item ha-icon {
    flex:0 0 auto;
    width:20px;
    height:20px;
  }

  .phone-status-ticker-copy {
    display:flex;
    flex-direction:column;
    justify-content:center;
    min-width:0;
    line-height:1.12;
  }

  .phone-status-ticker-copy strong {
    color:rgba(255,255,255,.92);
    font-size:12px;
    font-weight:600;
  }

  .phone-status-ticker-copy small {
    display:block;
    max-width:220px;
    margin-top:3px;
    overflow:hidden;
    color:var(--secondary-text-color);
    font-size:10px;
    opacity:.78;
    text-overflow:ellipsis;
    white-space:nowrap;
  }

  @keyframes phone-status-marquee {
    to { transform:translateX(-50%); }
  }
}

:host([data-profile="phone"]) .utility-header,
:host([data-profile="phone"]) .ticker,
:host([data-profile="phone"]) .drawer-host {
  display:none !important;
}

:host([data-profile="phone"]) .phone-status-host {
  display:block;
}

:host([data-profile="tablet"]) .phone-status-host,
:host([data-profile="desktop"]) .phone-status-host {
  display:none !important;
}

:host([data-profile="tablet"]) .utility-header,
:host([data-profile="desktop"]) .utility-header {
  display:grid;
}

:host([data-profile="tablet"]) .ticker,
:host([data-profile="desktop"]) .ticker {
  display:flex;
}

:host([data-profile="tablet"]) .drawer-host,
:host([data-profile="desktop"]) .drawer-host {
  display:block;
}

@media (prefers-reduced-motion:reduce) {
  .phone-status-ticker-track {
    animation:none;
  }

  .phone-status-ticker-sequence[aria-hidden="true"] {
    display:none;
  }
}

:host([data-profile="tablet"]) .ticker-footer,
:host([data-profile="tablet"]) .footer-marquee,
:host([data-profile="desktop"]) .ticker-footer,
:host([data-profile="desktop"]) .footer-marquee {
  min-height:80px !important;
  height:80px !important;
}

:host([data-profile="tablet"]) .footer-marquee-item ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item ha-icon {
  width:36px !important;
  height:36px !important;
  --mdc-icon-size:36px !important;
}

:host([data-profile="tablet"]) .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-copy strong {
  font-size:24px !important;
  font-weight:800 !important;
  line-height:1.02 !important;
  letter-spacing:.2px !important;
}

:host([data-profile="tablet"]) .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-copy small {
  margin-top:7px !important;
  font-size:20px !important;
  font-weight:650 !important;
  line-height:1.05 !important;
  opacity:.9 !important;
}

:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather ha-icon,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather ha-icon,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature ha-icon {
  width:42px !important;
  height:42px !important;
  --mdc-icon-size:42px !important;
}

:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather .footer-marquee-copy strong,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong {
  font-size:36px !important;
  font-weight:840 !important;
  line-height:.95 !important;
}

:host([data-profile="tablet"]) .footer-marquee-item.is-current-weather .footer-marquee-copy small,
:host([data-profile="tablet"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-item.is-current-weather .footer-marquee-copy small,
:host([data-profile="desktop"]) .footer-marquee-item.is-indoor-temperature .footer-marquee-copy small {
  font-size:21px !important;
  font-weight:680 !important;
}

/* Light-theme readability overrides.
   Keep these at the end of the card stylesheet so later tablet typography
   rules cannot restore dark-theme white text. Dark mode is untouched. */
:host([data-theme-mode="light"]) .zone-single .lane-title,
:host([data-theme-mode="light"]) .zone-lane .lane-title,
:host([data-theme-mode="light"]) .zone-empty,
:host([data-theme-mode="light"]) .footer-marquee-copy strong,
:host([data-theme-mode="light"]) .phone-status-ticker-copy strong {
  color:#1f2933 !important;
  text-shadow:none !important;
}

:host([data-theme-mode="light"]) .zone-single .lane-summary,
:host([data-theme-mode="light"]) .zone-lane .lane-summary,
:host([data-theme-mode="light"]) .footer-marquee-copy small,
:host([data-theme-mode="light"]) .phone-status-ticker-copy small {
  color:#66727e !important;
  opacity:1 !important;
  text-shadow:none !important;
}

:host([data-theme-mode="light"]) .lane-slot:not(:last-child) {
  border-bottom-color:rgba(36,49,61,.13) !important;
}

:host([data-theme-mode="light"][data-lane-mode="single"]) .secondary-zone {
  border-left-color:rgba(36,49,61,.13) !important;
}

:host([data-theme-mode="light"]) .zone-lane .lane-item:hover {
  background:rgba(36,49,61,.045) !important;
}

:host([data-theme-mode="light"]) .footer-marquee-item::after,
:host([data-theme-mode="light"]) .footer-sequence > .footer-marquee-item:not(:last-child)::after {
  border-color:rgba(36,49,61,.13) !important;
  background:rgba(36,49,61,.13) !important;
}


:host([data-presentation-mode="visual"]) { max-width:none !important; }
.visual-dashboard-card.visual-v5{position:relative;overflow:hidden;padding:12px;border-radius:22px;background:linear-gradient(150deg,rgba(10,16,23,.98),rgba(4,9,14,.99));}
.visual-v5-grid{position:relative;z-index:1;display:grid;grid-template-columns:1.02fr 1.34fr .98fr;grid-template-rows:278px 248px;grid-template-areas:"security media weather" "appliances centerlow glance";gap:10px;min-height:536px}
.visual-panel,.visual-center-lower{border:1px solid rgba(79,159,255,.24);border-radius:16px;background:linear-gradient(145deg,rgba(20,33,47,.9),rgba(9,19,29,.9));box-shadow:inset 0 1px 0 rgba(255,255,255,.035);overflow:hidden}
.visual-security-panel{grid-area:security}.visual-appliance-panel{grid-area:appliances}.visual-media-card{grid-area:media}.visual-weather-card{grid-area:weather}.visual-glance-panel{grid-area:glance}.visual-center-lower{min-width:0}
.visual-v5-grid::after{content:"";grid-area:centerlow;pointer-events:none}.visual-household-card{grid-column:2;grid-row:2;align-self:stretch;width:calc(50% - 5px);justify-self:start}.visual-music-card{grid-column:2;grid-row:2;align-self:stretch;width:calc(50% - 5px);justify-self:end}
.visual-panel-heading{display:flex;align-items:center;justify-content:space-between;height:42px;padding:0 12px;border-bottom:1px solid rgba(90,160,225,.16);font-size:12px;font-weight:900;letter-spacing:.055em;color:rgba(238,247,255,.92)}.visual-panel-heading>span{display:flex;align-items:center;gap:8px}.visual-panel-heading ha-icon{--mdc-icon-size:20px;color:#54b8ff}.visual-panel-heading>ha-icon:last-child{--mdc-icon-size:17px;color:rgba(255,255,255,.42)}
.visual-security-hero{display:grid;grid-template-columns:86px 1fr;align-items:center;gap:12px;padding:14px 14px 9px}.visual-security-hero>div:last-child{display:grid;gap:4px;min-width:0}.visual-security-hero strong{font-size:24px;line-height:1}.visual-security-hero small{font-size:11px;color:rgba(255,255,255,.58)}
.visual-security-ring{display:grid;place-items:center;width:68px;height:68px;border:8px solid rgba(92,232,132,.2);border-top-color:#5ce884;border-right-color:#5ce884;border-radius:50%}.visual-security-panel.has-alert .visual-security-ring{border-color:rgba(239,83,80,.2);border-top-color:#ef5350;border-right-color:#ef5350}.visual-security-ring ha-icon{--mdc-icon-size:34px;color:#5ce884}.visual-security-panel.has-alert .visual-security-ring ha-icon{color:#ef5350}
.visual-security-tile-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(76px,1fr));gap:7px;padding:6px 10px 10px}.visual-security-tile{position:relative;display:grid;grid-template-columns:32px 1fr;grid-template-rows:auto auto;align-items:center;column-gap:7px;min-width:0;min-height:65px;padding:8px;border:1px solid rgba(87,160,224,.15);border-radius:12px;background:rgba(54,91,125,.16);font:inherit;color:inherit;text-align:left}.visual-security-tile-icon{grid-row:1/3;display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:rgba(70,220,117,.14);color:#62df82}.visual-security-tile.has-alert .visual-security-tile-icon{background:rgba(239,83,80,.14);color:#ef5350}.visual-security-tile-icon ha-icon{--mdc-icon-size:19px}.visual-security-tile strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}.visual-security-tile small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:rgba(255,255,255,.55)}
.visual-mode-center{position:relative;height:calc(100% - 43px);min-height:234px;overflow:hidden;border-radius:0 0 15px 15px;background:rgba(0,0,0,.24)}.visual-mode-center .visual-center-media,.visual-mode-center .visual-center-camera{width:100%;height:100%;object-fit:cover}
.visual-weather-body{padding:11px 14px 7px}.visual-weather-main{display:flex;align-items:center;gap:8px}.visual-weather-icon{--mdc-icon-size:50px;color:#ffd43b}.visual-weather-temp{font-size:54px;font-weight:850;line-height:.88;letter-spacing:-3px}.visual-weather-body>strong{display:block;margin-top:4px;font-size:17px}.visual-weather-body>small{display:block;font-size:9px;color:rgba(255,255,255,.42)}.visual-weather-metrics{display:grid;grid-template-columns:82px 1fr;gap:10px;align-items:center;padding:2px 13px 13px}.visual-humidity-ring{display:grid;place-items:center;width:70px;height:70px;border-radius:50%;background:conic-gradient(#31a8ff var(--visual-humidity,0deg),rgba(49,168,255,.13) 0);position:relative}.visual-humidity-ring::after{content:"";position:absolute;inset:7px;border-radius:50%;background:#102131}.visual-humidity-ring span{position:relative;z-index:1;display:grid;text-align:center}.visual-humidity-ring b{font-size:15px}.visual-humidity-ring small{font-size:8px;color:rgba(255,255,255,.5)}.visual-weather-pulse{display:flex;align-items:end;gap:4px;height:64px;position:relative;padding-bottom:16px}.visual-weather-pulse i{flex:1;border-radius:3px 3px 1px 1px;background:linear-gradient(to top,rgba(72,166,255,.18),rgba(72,166,255,.75))}.visual-weather-pulse i:nth-child(1){height:22%}.visual-weather-pulse i:nth-child(2){height:38%}.visual-weather-pulse i:nth-child(3){height:28%}.visual-weather-pulse i:nth-child(4){height:46%}.visual-weather-pulse i:nth-child(5){height:34%}.visual-weather-pulse span{position:absolute;left:0;bottom:0;font-size:8px;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.05em}
.visual-appliance-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:9px}.visual-mini-item{position:relative;display:grid;grid-template-columns:39px 1fr;align-items:center;gap:8px;min-width:0;min-height:78px;padding:8px;border:1px solid rgba(71,153,225,.16);border-radius:12px;background:rgba(38,76,111,.16);font:inherit;color:inherit;text-align:left}.visual-mini-icon{display:grid;place-items:center;width:37px;height:37px;border-radius:11px;background:rgba(65,169,255,.15);color:#5bb7ff}.visual-mini-icon ha-icon{--mdc-icon-size:23px}.visual-mini-copy{display:grid;gap:3px;min-width:0;padding-right:13px}.visual-mini-copy strong,.visual-mini-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.visual-mini-copy strong{font-size:11px}.visual-mini-copy small{font-size:9px;color:rgba(255,255,255,.56)}.visual-mini-progress{display:block;height:5px;margin-top:4px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden}.visual-mini-progress i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#33a8ff,#65d4ff)}.visual-idle{grid-column:1/-1;display:grid;grid-template-columns:40px 1fr;grid-template-rows:auto auto;align-items:center;column-gap:10px;padding:18px;color:rgba(255,255,255,.62)}.visual-idle ha-icon{grid-row:1/3;--mdc-icon-size:31px;color:#66bb6a}.visual-idle strong{font-size:14px;color:rgba(255,255,255,.9)}.visual-idle span{font-size:10px}
.visual-household-primary,.visual-environment-primary{position:relative;display:grid;grid-template-columns:55px 1fr;align-items:center;gap:10px;width:100%;height:180px;padding:14px;border:0;background:none;font:inherit;color:inherit;text-align:left}.visual-household-primary>span:nth-child(2),.visual-environment-primary>span:nth-child(2){display:grid;gap:3px;min-width:0}.visual-household-primary small,.visual-environment-primary small{font-size:9px;font-weight:900;letter-spacing:.06em;color:rgba(255,255,255,.48)}.visual-household-primary strong,.visual-environment-primary strong{font-size:15px;line-height:1.15}.visual-household-primary em,.visual-environment-primary em{font-size:9px;font-style:normal;color:rgba(255,255,255,.5)}.visual-household-orb{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:rgba(48,169,255,.16);color:#45b6ff}.visual-household-orb ha-icon{--mdc-icon-size:31px}.visual-household-dots{position:absolute;left:14px;right:14px;bottom:16px;display:flex;gap:6px}.visual-household-dots i{width:10px;height:10px;border-radius:50%;background:#56c7ff}.visual-household-dots i:nth-child(2){background:#58df92}.visual-household-dots i:nth-child(3){background:#ffd14a}.visual-household-dots i:nth-child(4),.visual-household-dots i:nth-child(5){background:rgba(255,255,255,.18)}.visual-environment-ring{--visual-ring:180deg;display:grid;place-items:center;width:54px;height:54px;border-radius:50%;background:conic-gradient(#58d97c var(--visual-ring),rgba(88,217,124,.12) 0);position:relative}.visual-environment-ring::after{content:"";position:absolute;inset:7px;border-radius:50%;background:#102131}.visual-environment-ring ha-icon{position:relative;z-index:1;--mdc-icon-size:23px;color:#62dd82}
.visual-music-card{position:relative;background:linear-gradient(145deg,rgba(30,34,50,.94),rgba(10,20,30,.92))}.visual-music-shell{position:relative;display:grid;grid-template-columns:64px 1fr;grid-template-rows:auto 42px 31px 23px;gap:5px 10px;height:100%;padding:10px 12px;box-sizing:border-box;overflow:hidden}.visual-music-artwork{grid-row:1/3;width:64px;height:64px;border-radius:13px;object-fit:cover;background:rgba(89,105,255,.15)}.visual-music-artwork-fallback{display:grid;place-items:center;color:#8e9cff}.visual-music-artwork-fallback ha-icon{--mdc-icon-size:34px}.visual-music-copy{display:grid;align-content:center;gap:2px;min-width:0}.visual-music-copy small{font-size:8px;font-weight:900;letter-spacing:.08em;color:#9da7ff}.visual-music-copy strong,.visual-music-copy em{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.visual-music-copy strong{font-size:13px}.visual-music-copy em{font-size:9px;font-style:normal;color:rgba(255,255,255,.52)}.visual-music-controls{grid-column:2;display:flex;align-items:center;justify-content:flex-start;gap:7px}.visual-music-controls button{display:grid;place-items:center;width:34px;height:34px;padding:0;border:1px solid rgba(145,155,255,.18);border-radius:50%;background:rgba(110,122,255,.09);color:#d9ddff}.visual-music-controls button:active{transform:scale(.92)}.visual-music-controls ha-icon{--mdc-icon-size:19px}.visual-music-controls .visual-music-play{width:42px;height:42px;background:#7886ff;color:white}.visual-music-play ha-icon{--mdc-icon-size:24px}.visual-music-source{grid-column:1/3;position:relative;display:grid;grid-template-columns:19px 1fr 16px;align-items:center;gap:5px;height:29px;padding:0 7px;border:1px solid rgba(145,155,255,.16);border-radius:9px;background:rgba(110,122,255,.07);overflow:hidden}.visual-music-source>ha-icon{--mdc-icon-size:15px;color:#9da7ff}.visual-music-source>ha-icon:last-child{pointer-events:none;color:rgba(255,255,255,.36)}.visual-music-source select{width:100%;min-width:0;border:0;outline:0;background:transparent;color:rgba(255,255,255,.78);font:inherit;font-size:9px;appearance:none}.visual-music-source option{color:#111;background:#fff}.visual-music-volume{grid-column:1/3;display:grid;grid-template-columns:20px 1fr 28px;align-items:center;gap:6px}.visual-music-volume>ha-icon{--mdc-icon-size:16px;color:rgba(255,255,255,.55)}.visual-music-volume>span{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}.visual-music-volume>span i{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#7886ff,#52c7ff)}.visual-music-volume>b{font-size:8px;color:rgba(255,255,255,.5)}.visual-music-volume>input[type="range"]{width:100%;min-width:0;height:18px;margin:0;cursor:pointer;accent-color:#7886ff}.visual-music-volume>input[type="range"]::-webkit-slider-runnable-track{height:5px;border-radius:999px;background:rgba(255,255,255,.16)}.visual-music-volume>input[type="range"]::-webkit-slider-thumb{margin-top:-5px}
.visual-glance-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;padding:9px}.visual-glance-tile{position:relative;display:grid;grid-template-columns:40px 1fr;align-items:center;gap:8px;min-width:0;min-height:91px;padding:9px;border:1px solid rgba(72,154,223,.15);border-radius:13px;background:rgba(35,76,112,.17);font:inherit;color:inherit;text-align:left}.visual-glance-tile-icon{display:grid;place-items:center;width:39px;height:39px;border-radius:12px;background:rgba(48,168,255,.16);color:#45b7ff}.visual-glance-tile.water .visual-glance-tile-icon{color:#25c7d9;background:rgba(37,199,217,.14)}.visual-glance-tile.waste .visual-glance-tile-icon{color:#65dc76;background:rgba(101,220,118,.14)}.visual-glance-tile.traffic .visual-glance-tile-icon{color:#ffd04e;background:rgba(255,208,78,.14)}.visual-glance-tile.calendar .visual-glance-tile-icon{color:#75b9ff;background:rgba(117,185,255,.14)}.visual-glance-tile-icon ha-icon{--mdc-icon-size:24px}.visual-glance-tile-copy{display:grid;gap:2px;min-width:0;padding-right:13px}.visual-glance-tile-copy small{font-size:9px;font-weight:800;color:rgba(255,255,255,.65)}.visual-glance-tile-copy strong{font-size:12px;line-height:1.08;white-space:normal;overflow-wrap:anywhere}.visual-glance-tile-copy em{font-size:8px;font-style:normal;color:rgba(255,255,255,.48);white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.visual-tap-chevron{position:absolute;right:7px;top:50%;transform:translateY(-50%);--mdc-icon-size:14px;color:rgba(255,255,255,.3)}.visual-security-tile,.visual-mini-item,.visual-household-primary,.visual-environment-primary,.visual-glance-tile,[data-visual-entity]{cursor:pointer}.visual-security-tile:disabled,.visual-mini-item:disabled,.visual-household-primary:disabled,.visual-environment-primary:disabled,.visual-glance-tile:disabled{cursor:default;opacity:1}.visual-security-tile:not(:disabled):active,.visual-mini-item:not(:disabled):active,.visual-household-primary:not(:disabled):active,.visual-environment-primary:not(:disabled):active,.visual-glance-tile:not(:disabled):active,[data-visual-entity]:active{transform:scale(.985)}.visual-security-tile:focus-visible,.visual-mini-item:focus-visible,.visual-household-primary:focus-visible,.visual-environment-primary:focus-visible,.visual-glance-tile:focus-visible,[data-visual-entity]:focus-visible{outline:2px solid var(--primary-color);outline-offset:2px}
.visual-mode-fallback{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:9px;color:rgba(255,255,255,.42)}.visual-mode-fallback ha-icon{--mdc-icon-size:42px}.visual-dashboard-card>.weather-renderer-layer{position:absolute!important;inset:0!important;width:auto!important;height:auto!important;z-index:0!important;border-radius:22px!important;pointer-events:none!important;overflow:hidden!important}.visual-dashboard-card>:not(.weather-renderer-layer){position:relative;z-index:1}
:host([data-presentation-mode="visual"]) .visual-mode-ticker{position:relative;z-index:2;display:grid!important;grid-template-columns:190px 1fr;align-items:center;height:94px!important;min-height:94px!important;max-height:94px!important;margin-top:10px;padding:0 8px!important;border:1px solid rgba(65,151,225,.22);border-radius:16px;background:linear-gradient(90deg,rgba(19,47,72,.92),rgba(9,21,31,.94));overflow:hidden}:host([data-presentation-mode="visual"]) .visual-rail-label{display:flex;align-items:center;gap:10px;padding:0 14px;border-right:1px solid rgba(255,255,255,.12)}:host([data-presentation-mode="visual"]) .visual-rail-label>ha-icon{--mdc-icon-size:32px;color:#48b7ff}:host([data-presentation-mode="visual"]) .visual-rail-label>span{display:grid;text-align:left}:host([data-presentation-mode="visual"]) .visual-rail-label strong{font-size:13px}:host([data-presentation-mode="visual"]) .visual-rail-label small{font-size:9px;color:rgba(255,255,255,.48)}:host([data-presentation-mode="visual"]) .visual-mode-ticker .ticker-footer{min-height:94px!important;height:94px!important;padding-top:0!important;overflow:hidden}:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee{height:94px!important}

/* Visual Mode Preview 6: denser mock-fidelity refinement. */
.visual-v5-grid{grid-template-rows:250px 220px;min-height:480px}
.visual-security-hero{grid-template-columns:74px 1fr;padding:10px 12px 6px}.visual-security-ring{width:58px;height:58px;border-width:7px}.visual-security-ring ha-icon{--mdc-icon-size:29px}.visual-security-hero strong{font-size:21px}.visual-security-tile-row{padding:4px 9px 9px}.visual-security-tile{min-height:57px;padding:7px}.visual-mode-center{min-height:206px}
.visual-appliance-grid{height:calc(100% - 43px);align-content:start}.visual-idle{align-self:start;padding:13px}.visual-idle::after{content:"Ready for the next cycle";grid-column:2;font-size:9px;color:rgba(255,255,255,.38);margin-top:3px}.visual-mini-item{min-height:68px}
.visual-household-primary,.visual-environment-primary{height:112px;padding:12px}.visual-household-people{display:flex;flex-wrap:wrap;gap:5px;padding:0 11px 11px}.visual-person-chip{display:flex;align-items:center;gap:4px;min-width:0;padding:5px 7px;border-radius:999px;background:rgba(61,166,255,.11);color:#6bc1ff}.visual-person-chip ha-icon{--mdc-icon-size:14px}.visual-person-chip b{max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;color:rgba(255,255,255,.75)}
.visual-env-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;padding:0 9px 9px}.visual-env-metric{display:grid;grid-template-columns:18px 1fr;grid-template-rows:auto auto;align-items:center;column-gap:4px;padding:6px;border-radius:9px;background:rgba(88,217,124,.07)}.visual-env-metric ha-icon{grid-row:1/3;--mdc-icon-size:16px;color:#62dd82}.visual-env-metric b{font-size:9px}.visual-env-metric small{font-size:7px;color:rgba(255,255,255,.42)}
.visual-weather-body{padding:8px 12px 4px}.visual-weather-icon{--mdc-icon-size:44px}.visual-weather-temp{font-size:48px}.visual-weather-metrics{grid-template-columns:72px 1fr;padding:0 12px 10px}.visual-humidity-ring{width:62px;height:62px}.visual-weather-live{display:grid;grid-template-columns:32px 1fr;grid-template-rows:auto auto;align-items:center;column-gap:7px;padding:8px 10px;border-radius:12px;background:rgba(55,139,210,.11)}.visual-weather-live ha-icon{grid-row:1/3;--mdc-icon-size:27px;color:#55b8ff}.visual-weather-live strong{font-size:11px}.visual-weather-live small{font-size:8px;color:rgba(255,255,255,.45)}
.visual-glance-grid{gap:6px;padding:8px}.visual-glance-tile{min-height:78px;padding:8px}.visual-glance-tile-copy strong{font-size:11px}.visual-glance-tile-copy em{font-size:7.5px}
:host([data-presentation-mode="visual"]) .visual-mode-ticker{grid-template-columns:175px 1fr;height:76px!important;min-height:76px!important;max-height:76px!important;margin-top:9px;padding:0 7px!important}:host([data-presentation-mode="visual"]) .visual-mode-ticker .ticker-footer,:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee{height:76px!important;min-height:76px!important}:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-item{padding:0 20px!important}:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-item ha-icon{width:30px!important;height:30px!important;--mdc-icon-size:30px!important}:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy strong{font-size:19px!important}:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy small{margin-top:4px!important;font-size:14px!important}:host([data-presentation-mode="visual"]) .visual-rail-label{padding:0 11px}:host([data-presentation-mode="visual"]) .visual-rail-label>ha-icon{--mdc-icon-size:28px}:host([data-presentation-mode="visual"]) .visual-rail-label strong{font-size:12px}:host([data-presentation-mode="visual"]) .visual-rail-label small{font-size:7.5px}

.visual-weather-forecast{display:grid;grid-template-columns:repeat(5,1fr);gap:3px}.visual-forecast-day{display:grid;place-items:center;gap:2px;padding:5px 2px;border-radius:8px;background:rgba(55,139,210,.09)}.visual-forecast-day small{font-size:7px;color:rgba(255,255,255,.48)}.visual-forecast-day ha-icon{--mdc-icon-size:18px;color:#ffd43b}.visual-forecast-day strong{font-size:9px}.visual-forecast-day em{font-size:7px;font-style:normal;color:rgba(255,255,255,.42)}.visual-forecast-waiting{display:grid;place-items:center;grid-column:1/-1;font-size:8px;color:rgba(255,255,255,.4)}
.visual-music-source-wrap{grid-column:1/3;position:relative;z-index:8}.visual-music-source-trigger{display:grid;grid-template-columns:19px 1fr 16px;align-items:center;gap:5px;width:100%;height:29px;padding:0 7px;border:1px solid rgba(145,155,255,.16);border-radius:9px;background:rgba(110,122,255,.07);color:rgba(255,255,255,.78);font:inherit;text-align:left}.visual-music-source-trigger ha-icon{--mdc-icon-size:15px;color:#9da7ff}.visual-music-source-trigger span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.visual-music-source-menu{position:absolute;left:0;right:0;top:calc(100% + 6px);bottom:auto;max-height:min(440px,65vh);overflow-y:auto;overscroll-behavior:contain;padding:5px;border:1px solid rgba(145,155,255,.25);border-radius:10px;background:#111b2a;box-shadow:0 10px 28px rgba(0,0,0,.48)}.visual-music-source-menu[hidden]{display:none}.visual-music-source-menu button{display:grid;grid-template-columns:18px 1fr;align-items:center;gap:6px;width:100%;min-height:44px;padding:9px 10px;border:0;border-radius:7px;background:transparent;color:rgba(255,255,255,.9);font:inherit;text-align:left}.visual-music-source-menu button.is-selected{background:rgba(120,134,255,.16);color:white}.visual-music-source-menu button ha-icon{--mdc-icon-size:14px;color:#9da7ff}.visual-music-source-menu button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;line-height:1.3}
.visual-v5-grid.has-light-appliances{grid-template-columns:.82fr 1.54fr .98fr}.visual-v5-grid.has-light-appliances .visual-appliance-grid{grid-template-columns:1fr}.visual-v5-grid.has-light-appliances .visual-mini-item{min-height:74px}
.visual-household-summary{display:flex;align-items:center;gap:8px;padding:0 13px 12px;color:rgba(255,255,255,.48)}.visual-household-summary b{font-size:8px;font-weight:650}.visual-household-summary .visual-household-dots{position:static;display:flex;gap:5px}.visual-household-summary .visual-household-dots i{width:9px;height:9px;border-radius:50%;background:#56c7ff;box-shadow:0 0 0 3px rgba(86,199,255,.08)}

/* Visual Mode Preview 11 — mock fidelity pass. */
.visual-v11 .visual-v5-grid{
  display:grid;
  grid-template-columns:20fr 22fr 26fr 32fr !important;
  grid-template-rows:278px 248px !important;
  grid-template-areas:
    "security media media weather"
    "appliances household music glance" !important;
  gap:10px;
  min-height:536px;
}
.visual-v11 .visual-security-panel{grid-area:security}
.visual-v11 .visual-media-card{grid-area:media}
.visual-v11 .visual-weather-card{grid-area:weather}
.visual-v11 .visual-appliance-panel{grid-area:appliances}
.visual-v11 .visual-household-card{grid-area:household;grid-column:auto;grid-row:auto;width:auto;justify-self:stretch}
.visual-v11 .visual-music-card{grid-area:music;grid-column:auto;grid-row:auto;width:auto;justify-self:stretch}
.visual-v11 .visual-glance-panel{grid-area:glance}
.visual-v11 .visual-v5-grid::after{display:none}
.visual-v11 .visual-v5-grid.has-light-appliances{grid-template-columns:20fr 22fr 26fr 32fr !important}

.visual-v11 .visual-security-hero{grid-template-columns:78px 1fr;padding:13px 13px 8px}
.visual-v11 .visual-security-ring{width:62px;height:62px}
.visual-v11 .visual-security-tile-row{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:6px 8px 10px}
.visual-v11 .visual-security-tile{grid-template-columns:28px 1fr;min-height:72px;padding:7px;column-gap:6px}
.visual-v11 .visual-security-tile-icon{width:27px;height:27px}
.visual-v11 .visual-security-tile strong{white-space:normal;overflow:visible;text-overflow:clip;font-size:9px;line-height:1.05}
.visual-v11 .visual-security-tile small{font-size:8px}

.visual-v11 .visual-weather-body{display:grid;grid-template-rows:auto 1fr;height:calc(100% - 43px);padding:10px 12px 9px;box-sizing:border-box}
.visual-v11 .visual-weather-top{display:grid;grid-template-columns:1fr 66px;align-items:start;gap:8px}
.visual-v11 .visual-weather-current{min-width:0}
.visual-v11 .visual-weather-main{gap:7px}
.visual-v11 .visual-weather-icon{--mdc-icon-size:46px}
.visual-v11 .visual-weather-temp{font-size:50px}
.visual-v11 .visual-weather-current>strong{display:block;margin-top:4px;font-size:16px}
.visual-v11 .visual-weather-current>small{display:block;font-size:8px;color:rgba(255,255,255,.42)}
.visual-v11 .visual-humidity-ring{width:58px;height:58px;justify-self:end}
.visual-v11 .visual-humidity-ring::after{inset:6px}
.visual-v11 .visual-humidity-ring b{font-size:13px}
.visual-v11 .visual-weather-forecast{align-self:end;display:grid;grid-template-columns:repeat(5,1fr);gap:5px;width:100%;margin-top:7px}
.visual-v11 .visual-forecast-day{min-height:76px;padding:6px 3px;border-radius:9px;background:rgba(55,139,210,.11)}
.visual-v11 .visual-forecast-day small{font-size:7.5px}
.visual-v11 .visual-forecast-day ha-icon{--mdc-icon-size:22px}
.visual-v11 .visual-forecast-day strong{font-size:10px}
.visual-v11 .visual-forecast-day em{font-size:8px}

.visual-v11 .visual-appliance-grid{grid-template-columns:1fr !important;align-content:start;height:calc(100% - 43px);padding:9px}
.visual-v11 .visual-mini-item{min-height:78px}
.visual-v11 .visual-appliance-panel .visual-idle{align-self:start}

.visual-v11 .visual-household-card{position:relative}
.visual-v11 .visual-household-shell{height:100%;padding:13px;box-sizing:border-box;cursor:pointer}
.visual-v11 .visual-household-heading{position:relative;display:grid;grid-template-columns:55px 1fr;align-items:center;gap:10px}
.visual-v11 .visual-household-heading>span:nth-child(2){display:grid;gap:2px;min-width:0}
.visual-v11 .visual-household-heading small{font-size:8px;font-weight:900;letter-spacing:.06em;color:rgba(255,255,255,.48)}
.visual-v11 .visual-household-heading strong{font-size:15px}
.visual-v11 .visual-household-heading em{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;font-style:normal;color:rgba(255,255,255,.46)}
.visual-v11 .visual-household-people-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin-top:20px}
.visual-v11 .visual-household-person{display:grid;justify-items:center;gap:6px;min-width:0}
.visual-v11 .visual-household-person-orb{display:grid;place-items:center;width:42px;height:42px;border:1px solid rgba(78,183,255,.18);border-radius:50%;background:rgba(48,169,255,.12);color:#60c6ff}
.visual-v11 .visual-household-person-orb ha-icon{--mdc-icon-size:23px}
.visual-v11 .visual-household-person b{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;font-weight:650;color:rgba(255,255,255,.68)}
.visual-v11 .visual-household-summary{display:none}

.visual-v11 .visual-music-shell{grid-template-columns:78px 1fr;grid-template-rows:auto 45px 31px 23px;padding:11px 12px;gap:5px 11px}
.visual-v11 .visual-music-artwork{width:78px;height:78px;border-radius:13px}
.visual-v11 .visual-music-copy strong{font-size:14px}
.visual-v11 .visual-music-copy em{font-size:9px}

.visual-v11 .visual-glance-grid{gap:7px;padding:9px}
.visual-v11 .visual-glance-tile{min-height:91px}

@media(max-width:1000px){
  .visual-v11 .visual-v5-grid{grid-template-columns:1fr 1.2fr 1.25fr 1.45fr !important}
}

/* Preview 12 — Security becomes a distance-readable alarm beacon. */
.visual-v11 .visual-security-panel{position:relative;overflow:hidden;transition:border-color .2s ease,background .2s ease}
.visual-v11 .visual-security-panel::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.5;background:linear-gradient(135deg,var(--security-beacon-bg,transparent),transparent 62%)}
.visual-v11 .visual-security-hero{position:relative;z-index:1;grid-template-columns:92px 1fr;padding:12px 13px 8px}
.visual-v11 .visual-security-ring{position:relative;width:76px;height:76px;border-width:8px;border-color:var(--security-beacon-dim,#214d3e);border-color:var(--security-beacon,#58e980);box-shadow:0 0 0 1px rgba(255,255,255,.02),0 0 var(--security-glow,0px) var(--security-beacon-glow,transparent)}
.visual-v11 .visual-security-beacon-core{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;color:var(--security-beacon,#58e980)}
.visual-v11 .visual-security-ring ha-icon{--mdc-icon-size:36px}
.visual-v11 .visual-security-state-copy{display:grid;align-content:center;gap:3px;min-width:0}
.visual-v11 .visual-security-state-copy strong{font-size:22px;line-height:1}
.visual-v11 .visual-security-state-copy small{font-size:9px;line-height:1.25;color:rgba(255,255,255,.55)}
.visual-v11 .visual-security-warning{margin-top:4px;font-size:8px;line-height:1.15;letter-spacing:.04em;color:var(--security-beacon)}
.visual-v11 .visual-security-tile-row{position:relative;z-index:1;display:grid;grid-template-columns:1fr !important;gap:5px;padding:3px 9px 9px}
.visual-v11 .visual-security-tile{display:grid;grid-template-columns:31px 1fr auto 13px;grid-template-rows:1fr;align-items:center;min-height:38px;padding:4px 7px;column-gap:7px;border-radius:10px}
.visual-v11 .visual-security-tile-icon{grid-column:1;grid-row:1;width:29px;height:29px}
.visual-v11 .visual-security-tile strong{grid-column:2;grid-row:1;white-space:nowrap;font-size:9px}
.visual-v11 .visual-security-tile small{grid-column:3;grid-row:1;white-space:nowrap;font-size:8px;text-align:right}
.visual-v11 .visual-security-tile .visual-tap-chevron{grid-column:4;grid-row:1}
.visual-v11 .visual-security-panel.beacon-disarmed{--security-beacon:#59e982;--security-beacon-dim:#214d3e;--security-beacon-bg:rgba(50,210,112,.07);--security-beacon-glow:rgba(72,224,125,.18);--security-glow:10px;border-color:rgba(79,221,126,.24)}
.visual-v11 .visual-security-panel.beacon-armed-home{--security-beacon:#ffb52e;--security-beacon-dim:#624619;--security-beacon-bg:rgba(255,166,24,.16);--security-beacon-glow:rgba(255,169,29,.45);--security-glow:22px;border-color:rgba(255,177,43,.62);box-shadow:inset 0 0 26px rgba(255,154,20,.08)}
.visual-v11 .visual-security-panel.beacon-armed-away{--security-beacon:#ff6565;--security-beacon-dim:#653030;--security-beacon-bg:rgba(235,76,76,.09);--security-beacon-glow:rgba(235,76,76,.22);--security-glow:8px}
.visual-v11 .visual-security-panel.beacon-pending{--security-beacon:#ffb52e;--security-beacon-dim:#624619;--security-beacon-bg:rgba(255,166,24,.13);--security-beacon-glow:rgba(255,169,29,.38);--security-glow:18px;border-color:rgba(255,177,43,.48)}
.visual-v11 .visual-security-panel.beacon-triggered{--security-beacon:#ff5252;--security-beacon-dim:#642525;--security-beacon-bg:rgba(255,49,49,.2);--security-beacon-glow:rgba(255,55,55,.55);--security-glow:26px;border-color:rgba(255,76,76,.72)}
@media (prefers-reduced-motion:no-preference){
  .visual-v11 .visual-security-panel.beacon-pending .visual-security-ring{animation:visual-security-pulse 1.5s ease-in-out infinite}
  .visual-v11 .visual-security-panel.beacon-triggered .visual-security-ring{animation:visual-security-alert .8s ease-in-out infinite}
}
@keyframes visual-security-pulse{50%{filter:brightness(1.25);transform:scale(1.035)}}
@keyframes visual-security-alert{50%{filter:brightness(1.45);transform:scale(1.055)}}

/* Preview 13 — Home Status intelligence drives visual weight. */
.visual-v11 .visual-security-warning{display:none!important}
.visual-v11 .visual-security-panel.beacon-disarmed .visual-security-ring{box-shadow:none}
.visual-v11 .visual-security-panel.beacon-disarmed::before{opacity:.22}
.visual-v11 .visual-security-panel.beacon-armed-home::before{opacity:.78}
.visual-v11 .visual-security-panel.beacon-armed-home .visual-security-state-copy strong{color:#ffbd3f}
.visual-v11 .visual-security-panel.beacon-triggered .visual-security-state-copy strong{color:#ff6767}

/* Appliances are subordinate when Home Status has little or nothing active. */
.visual-v11 .visual-v5-grid.has-no-appliances,
.visual-v11 .visual-v5-grid.has-light-appliances{
  grid-template-columns:18fr 24fr 26fr 32fr !important;
}
.visual-v11 .visual-v5-grid.has-busy-appliances{
  grid-template-columns:22fr 22fr 25fr 31fr !important;
}
.visual-v11 .visual-appliance-quiet{
  display:grid;grid-template-columns:34px 1fr;align-items:center;align-content:center;
  min-height:66px;margin:9px;padding:9px 11px;border:1px solid rgba(89,233,130,.10);
  border-radius:11px;background:rgba(89,233,130,.035);text-align:left
}
.visual-v11 .visual-appliance-quiet ha-icon{--mdc-icon-size:25px;color:#59d98a}
.visual-v11 .visual-appliance-quiet span{display:grid;gap:2px}
.visual-v11 .visual-appliance-quiet strong{font-size:10px}
.visual-v11 .visual-appliance-quiet small{font-size:8px;color:rgba(255,255,255,.42)}

/* One active appliance gets one concise status row, not a giant pseudo-dashboard. */
.visual-v11 .has-light-appliances .visual-appliance-grid{align-content:start}
.visual-v11 .has-light-appliances .visual-mini-item{min-height:70px}

/* Let At a Glance breathe when there are only one or two meaningful items. */
.visual-v11 .has-light-glance .visual-glance-grid{grid-template-columns:1fr}
.visual-v11 .has-light-glance .visual-glance-tile{min-height:74px}
.visual-v11 .visual-glance-quiet{grid-column:1/-1;min-height:110px;margin:10px}

/* Household remains awareness, not a roster dashboard. Keep people visual but secondary. */
.visual-v11 .visual-household-heading strong{font-size:16px}
.visual-v11 .visual-household-people-grid{margin-top:15px}
.visual-v11 .visual-household-person-orb{width:38px;height:38px}
.visual-v11 .visual-household-person-orb ha-icon{--mdc-icon-size:21px}
.visual-v11 .visual-household-person b{font-size:7.5px}

/* Home Status rail is context, not the dominant headline. */
:host([data-presentation-mode="visual"]) .visual-mode-ticker{
  min-height:76px!important;height:76px!important
}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy strong{
  font-size:17px!important;line-height:1.05!important
}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy small{
  font-size:11px!important
}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy ha-icon{
  --mdc-icon-size:24px!important
}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-item{
  padding-inline:16px!important
}

/* Preview 14 — Visual Home Status: movement follows attention. */
.visual-dashboard-card{position:relative;overflow:hidden}
.visual-priority-layer{position:absolute;left:50%;bottom:88px;z-index:20;width:min(560px,52%);transform:translateX(-50%);pointer-events:none}
.visual-priority-spotlight{pointer-events:auto;display:grid;grid-template-columns:42px 1fr auto;align-items:center;gap:10px;min-height:58px;padding:8px 12px;border:1px solid rgba(255,178,48,.42);border-radius:14px;background:rgba(21,27,38,.94);box-shadow:0 12px 34px rgba(0,0,0,.35),inset 0 0 24px rgba(255,169,35,.06);backdrop-filter:blur(12px);animation:visual-priority-arrive .38s cubic-bezier(.2,.8,.2,1)}
.visual-priority-spotlight.is-critical{border-color:rgba(255,82,82,.65);box-shadow:0 12px 34px rgba(0,0,0,.4),inset 0 0 28px rgba(255,55,55,.12)}
.visual-priority-pulse{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:rgba(255,178,48,.14);color:#ffb83d}
.visual-priority-spotlight.is-critical .visual-priority-pulse{background:rgba(255,72,72,.16);color:#ff6262}
.visual-priority-pulse ha-icon{--mdc-icon-size:22px}
.visual-priority-copy{display:grid;gap:2px;min-width:0}
.visual-priority-copy small{font-size:7px;font-weight:900;letter-spacing:.08em;color:#ffb83d}
.visual-priority-spotlight.is-critical .visual-priority-copy small{color:#ff6a6a}
.visual-priority-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.visual-priority-copy em{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;font-style:normal;color:rgba(255,255,255,.5)}
.visual-priority-count{display:grid;place-items:center;min-width:26px;height:26px;border-radius:13px;background:rgba(255,255,255,.08);font-size:9px}
@keyframes visual-priority-arrive{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:no-preference){
  .visual-priority-spotlight.is-attention .visual-priority-pulse{animation:visual-attention-breathe 2.8s ease-in-out infinite}
  .visual-priority-spotlight.is-critical .visual-priority-pulse{animation:visual-critical-pulse 1s ease-in-out infinite}
  .visual-v11 .visual-media-card .visual-center img,.visual-v11 .visual-media-card .visual-center video{animation:visual-media-settle .6s ease-out}
  .visual-v11 .visual-music-artwork{transition:transform .45s ease,box-shadow .45s ease}
  .visual-v11 .visual-music-card:hover .visual-music-artwork{transform:scale(1.025)}
  .visual-v11 .visual-glance-tile.has-alert{animation:visual-tile-attention 3.2s ease-in-out infinite}
}
@keyframes visual-attention-breathe{50%{box-shadow:0 0 0 8px rgba(255,184,61,.05);filter:brightness(1.12)}}
@keyframes visual-critical-pulse{50%{box-shadow:0 0 0 10px rgba(255,82,82,.07);filter:brightness(1.3)}}
@keyframes visual-media-settle{from{opacity:.72;transform:scale(1.012)}to{opacity:1;transform:scale(1)}}
@keyframes visual-tile-attention{50%{border-color:rgba(255,184,61,.38);box-shadow:inset 0 0 18px rgba(255,184,61,.04)}}

/* Give state changes a short visual acknowledgment instead of leaving the page visually frozen. */
.visual-v11 .visual-security-tile,.visual-v11 .visual-glance-tile,.visual-v11 .visual-mini-item{transition:transform .2s ease,border-color .25s ease,background .25s ease}
.visual-v11 .visual-security-tile:active,.visual-v11 .visual-glance-tile:active,.visual-v11 .visual-mini-item:active{transform:scale(.975)}

/* Preview 15 — the lower-left slot is now a real Home Status priority zone. */
.visual-v11 .visual-adaptive-panel{position:relative;transition:border-color .28s ease,background .28s ease,box-shadow .28s ease}
.visual-v11 .visual-adaptive-body{display:grid;gap:7px;padding:9px;align-content:start;height:calc(100% - 43px);box-sizing:border-box}
.visual-v11 .visual-adaptive-panel.mode-attention{border-color:rgba(255,177,56,.46);background:linear-gradient(145deg,rgba(43,34,24,.94),rgba(16,24,34,.94));box-shadow:inset 0 0 28px rgba(255,167,40,.055)}
.visual-v11 .visual-adaptive-panel.mode-attention .visual-adaptive-heading ha-icon{color:#ffb63e}
.visual-v11 .visual-adaptive-panel.mode-attention .visual-adaptive-heading b{color:#ffd08a}
.visual-v11 .visual-adaptive-alert{position:relative;display:grid;grid-template-columns:38px 1fr;align-items:center;gap:9px;min-width:0;min-height:68px;padding:8px;border:1px solid rgba(255,178,61,.18);border-radius:12px;background:rgba(255,167,42,.055);font:inherit;color:inherit;text-align:left}
.visual-v11 .visual-adaptive-alert.is-critical{border-color:rgba(255,82,82,.32);background:rgba(255,70,70,.07)}
.visual-v11 .visual-adaptive-alert-icon{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;background:rgba(255,178,61,.13);color:#ffb63e}
.visual-v11 .visual-adaptive-alert.is-critical .visual-adaptive-alert-icon{background:rgba(255,82,82,.14);color:#ff6262}
.visual-v11 .visual-adaptive-alert-icon ha-icon{--mdc-icon-size:22px}
.visual-v11 .visual-adaptive-alert-copy{display:grid;gap:2px;min-width:0;padding-right:14px}
.visual-v11 .visual-adaptive-alert-copy small{font-size:7px;font-weight:900;letter-spacing:.06em;color:#ffb63e}
.visual-v11 .visual-adaptive-alert.is-critical .visual-adaptive-alert-copy small{color:#ff6a6a}
.visual-v11 .visual-adaptive-alert-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.visual-v11 .visual-adaptive-alert-copy em{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:8px;font-style:normal;line-height:1.25;color:rgba(255,255,255,.52)}
.visual-v11 .visual-adaptive-panel.mode-quiet{opacity:.82}
.visual-v11 .visual-adaptive-panel.mode-quiet .visual-adaptive-body{align-content:center}
.visual-v11 .visual-adaptive-quiet{display:grid;grid-template-columns:46px 1fr;align-items:center;gap:10px;padding:10px}
.visual-v11 .visual-quiet-orb{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:rgba(84,216,127,.10);color:#5adc84}
.visual-v11 .visual-quiet-orb ha-icon{--mdc-icon-size:25px}
.visual-v11 .visual-adaptive-quiet>span:last-child{display:grid;gap:3px}
.visual-v11 .visual-adaptive-quiet strong{font-size:11px}
.visual-v11 .visual-adaptive-quiet small{font-size:8px;color:rgba(255,255,255,.42)}

/* Attention earns space. The adaptive zone grows while quieter awareness yields some width. */
.visual-v11 .visual-v5-grid.has-priority-zone{grid-template-columns:25fr 21fr 24fr 30fr !important}
.visual-v11 .visual-v5-grid.has-priority-zone .visual-adaptive-panel{box-shadow:inset 0 0 30px rgba(255,169,45,.07),0 0 0 1px rgba(255,177,56,.05)}

@media (prefers-reduced-motion:no-preference){
  .visual-v11 .visual-adaptive-panel.is-changing{animation:visual-zone-role-change .46s cubic-bezier(.2,.8,.2,1)}
  .visual-v11 .visual-adaptive-panel.mode-attention .visual-adaptive-alert:first-child .visual-adaptive-alert-icon{animation:visual-attention-breathe 2.4s ease-in-out infinite}
}
@keyframes visual-zone-role-change{
  0%{opacity:.35;transform:translateY(9px) scale(.985)}
  100%{opacity:1;transform:none}
}

/* Preview 16 — stable anchors above, fluid Home Status modules below. */
.visual-v16-top{position:relative;z-index:1;display:grid;grid-template-columns:minmax(260px,20fr) minmax(520px,48fr) minmax(360px,32fr);gap:10px;height:330px}
.visual-v16-top>.visual-panel{min-width:0;height:100%}
.visual-v16-top .visual-security-panel{min-width:260px}
.visual-v16-top .visual-media-card{min-width:0}
.visual-v16-top .visual-weather-card{min-width:360px}
.visual-v16-top .visual-mode-center{height:calc(100% - 43px);min-height:0}

.visual-v16-flow{position:relative;z-index:1;display:grid;grid-template-columns:repeat(12,minmax(0,1fr));grid-auto-flow:row dense;grid-auto-rows:minmax(205px,auto);gap:10px;margin-top:10px;align-items:stretch}
.visual-v16-flow.is-reflowing{animation:visual-flow-reflow .38s cubic-bezier(.2,.8,.2,1)}
.visual-flow-card{min-width:0;min-height:205px;overflow:hidden}
.visual-flow-card.size-small{grid-column:span 3}
.visual-flow-card.size-medium{grid-column:span 4}
.visual-flow-card.size-large{grid-column:span 5}
.visual-flow-card.role-attention.size-large{grid-column:span 6}
.visual-flow-card.role-awareness.size-large{grid-column:span 4}
.visual-flow-card.role-music.size-large{grid-column:span 5}
.visual-flow-card.role-household{grid-column:span 3}
.visual-flow-card.role-traffic,.visual-flow-card.role-calendar,.visual-flow-card.role-sports{grid-column:span 3}

.visual-flow-card .visual-panel-heading{height:39px}
.visual-flow-household,.visual-flow-music{height:calc(100% - 39px)}
.visual-flow-household .visual-household-shell{height:100%;padding:12px}
.visual-flow-household .visual-household-heading small{display:none}
.visual-flow-household .visual-household-people-grid{margin-top:12px}
.visual-flow-music .visual-music-shell{height:100%;padding:10px 12px}
.visual-flow-music .visual-music-copy small{display:none}
.visual-flow-appliances{grid-template-columns:1fr!important;height:auto!important;align-content:start!important}

.visual-flow-list,.visual-flow-sports,.visual-flow-attention{display:grid;gap:7px;padding:9px}
.visual-flow-list-row,.visual-sports-row{display:grid;grid-template-columns:34px 1fr;align-items:center;gap:8px;min-height:52px;padding:7px;border:1px solid rgba(82,158,224,.12);border-radius:10px;background:rgba(40,78,112,.10)}
.visual-flow-list-row>ha-icon,.visual-sports-ball{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;background:rgba(63,166,255,.11);color:#61bdff;--mdc-icon-size:19px}
.visual-flow-list-row>span,.visual-sports-row>span:last-child{display:grid;gap:2px;min-width:0}
.visual-flow-list-row strong,.visual-sports-row strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
.visual-flow-list-row small,.visual-sports-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;color:rgba(255,255,255,.48)}
.visual-flow-card.role-traffic .visual-flow-list-row>ha-icon{color:#7ee06f;background:rgba(126,224,111,.10)}
.visual-flow-card.role-calendar .visual-flow-list-row>ha-icon{color:#77baff;background:rgba(119,186,255,.10)}
.visual-sports-ball{color:#f4b749;background:rgba(244,183,73,.11)}
.visual-sports-ball ha-icon{--mdc-icon-size:19px}

.visual-flow-attention-item{position:relative;display:grid;grid-template-columns:38px 1fr;align-items:center;gap:8px;min-height:62px;padding:8px;border:1px solid rgba(255,183,61,.18);border-radius:11px;background:rgba(255,174,48,.05);font:inherit;color:inherit;text-align:left}
.visual-flow-attention-item.is-critical{border-color:rgba(255,82,82,.32);background:rgba(255,70,70,.07)}
.visual-flow-attention-item>span:first-child{display:grid;place-items:center;width:35px;height:35px;border-radius:10px;background:rgba(255,183,61,.12);color:#ffb83d}
.visual-flow-attention-item.is-critical>span:first-child{background:rgba(255,82,82,.14);color:#ff6262}
.visual-flow-attention-item>span:first-child ha-icon{--mdc-icon-size:21px}
.visual-flow-attention-item>span:nth-child(2){display:grid;gap:2px;min-width:0}
.visual-flow-attention-item strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px}
.visual-flow-attention-item small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:8px;color:rgba(255,255,255,.48)}

.visual-flow-awareness{grid-template-columns:1fr 1fr!important;padding:8px!important}
.visual-flow-awareness .visual-glance-tile{min-height:72px!important}

@media (prefers-reduced-motion:no-preference){
  @keyframes visual-flow-reflow{0%{opacity:.45;transform:translateY(8px)}100%{opacity:1;transform:none}}
  .visual-flow-card.role-attention{animation:visual-priority-arrive .38s cubic-bezier(.2,.8,.2,1)}
  .visual-flow-card.role-sports .visual-sports-ball{animation:visual-attention-breathe 3.4s ease-in-out infinite}
}
@media(max-width:1200px){
  .visual-v16-top{grid-template-columns:minmax(240px,22fr) minmax(420px,45fr) minmax(330px,33fr)}
  .visual-flow-card.size-small,.visual-flow-card.role-household,.visual-flow-card.role-traffic,.visual-flow-card.role-calendar,.visual-flow-card.role-sports{grid-column:span 4}
  .visual-flow-card.size-medium{grid-column:span 4}.visual-flow-card.size-large{grid-column:span 6}
}
@media(max-width:850px){
  .visual-v16-top{grid-template-columns:1fr 1fr;height:auto}.visual-v16-top .visual-media-card{grid-column:1/-1;min-height:300px}.visual-v16-top .visual-weather-card{min-width:0}.visual-v16-top .visual-security-panel{min-width:0}
  .visual-v16-flow{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:auto}.visual-flow-card,.visual-flow-card.size-small,.visual-flow-card.size-medium,.visual-flow-card.size-large,.visual-flow-card.role-household,.visual-flow-card.role-traffic,.visual-flow-card.role-calendar,.visual-flow-card.role-sports{grid-column:span 1}.visual-flow-card.role-attention.size-large,.visual-flow-card.role-awareness.size-large{grid-column:span 2}
}

/* Preview 17 — repair stable anchors + true fluid lower flow. */
.visual-v16-top>.visual-security-panel,
.visual-v16-top>.visual-media-card,
.visual-v16-top>.visual-weather-card{
  grid-area:auto !important;
  grid-column:auto !important;
  grid-row:auto !important;
  width:auto !important;
  justify-self:stretch !important;
  align-self:stretch !important;
  display:block !important;
  visibility:visible !important;
  opacity:1 !important;
}
.visual-v16-top{overflow:visible}

/* Flex-wrap is a better fit for Home Status than rigid 12-column spans:
   every visible module grows to consume available space, then wraps only
   when there is not enough room. */
.visual-v16-flow{
  display:flex !important;
  flex-wrap:wrap;
  align-items:stretch;
  gap:10px;
  grid-template-columns:none !important;
  grid-auto-rows:unset !important;
}
.visual-v16-flow>.visual-flow-card{
  grid-column:auto !important;
  min-width:260px;
  min-height:205px;
  flex:1 1 280px;
}
.visual-v16-flow>.visual-flow-card.size-small{flex:1 1 260px}
.visual-v16-flow>.visual-flow-card.size-medium{flex:1.18 1 310px}
.visual-v16-flow>.visual-flow-card.size-large{flex:1.45 1 380px}
.visual-v16-flow>.visual-flow-card.role-attention{flex-grow:1.7}
.visual-v16-flow>.visual-flow-card.role-music{flex-grow:1.35}
.visual-v16-flow>.visual-flow-card.role-awareness{flex-grow:1.25}
.visual-v16-flow>.visual-flow-card.role-household{flex-grow:1.05}
.visual-v16-flow>.visual-flow-card.role-traffic,
.visual-v16-flow>.visual-flow-card.role-calendar,
.visual-v16-flow>.visual-flow-card.role-sports{flex-grow:1.05}

/* Keep a sensible maximum so one lonely low-priority module does not become absurdly wide. */
.visual-v16-flow>.visual-flow-card:only-child{max-width:560px}

@media(max-width:850px){
  .visual-v16-flow>.visual-flow-card{min-width:calc(50% - 5px);flex-basis:calc(50% - 5px)}
}
@media(max-width:560px){
  .visual-v16-flow>.visual-flow-card{min-width:100%;flex-basis:100%}
}

/* Preview 18 — weather must never clip at the right edge. */
.visual-v16-top{grid-template-columns:minmax(280px,21fr) minmax(0,45fr) minmax(410px,34fr)!important}
.visual-v16-top>.visual-weather-card{min-width:410px!important;overflow:hidden!important}
.visual-v16-top .visual-weather-body{min-width:0;overflow:hidden}
.visual-v16-top .visual-weather-top{grid-template-columns:minmax(0,1fr) 62px!important;gap:8px}
.visual-v16-top .visual-weather-current{min-width:0;overflow:hidden}
.visual-v16-top .visual-weather-main{min-width:0}
.visual-v16-top .visual-weather-temp{font-size:48px!important;letter-spacing:-2px!important;white-space:nowrap}
.visual-v16-top .visual-humidity-ring{width:54px!important;height:54px!important}
.visual-v16-top .visual-weather-forecast{grid-template-columns:repeat(5,minmax(0,1fr))!important;gap:4px!important;min-width:0;width:100%;overflow:hidden}
.visual-v16-top .visual-forecast-day{min-width:0!important;padding:5px 2px!important}
.visual-v16-top .visual-forecast-day small,.visual-v16-top .visual-forecast-day strong,.visual-v16-top .visual-forecast-day em{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
@media(max-width:1200px){
 .visual-v16-top{grid-template-columns:minmax(250px,23fr) minmax(0,43fr) minmax(370px,34fr)!important}
 .visual-v16-top>.visual-weather-card{min-width:370px!important}
 .visual-v16-top .visual-weather-temp{font-size:44px!important}
 .visual-v16-top .visual-humidity-ring{width:50px!important;height:50px!important}
}

/* Preview 19 — content controls both width and height; larger tablet text. */
.visual-v16-flow{
  display:grid!important;
  grid-template-columns:repeat(12,minmax(0,1fr))!important;
  grid-auto-flow:dense!important;
  grid-auto-rows:68px!important;
  gap:10px!important;
  align-items:stretch!important;
}
.visual-v16-flow>.visual-flow-card{min-width:0!important;min-height:0!important;max-width:none!important;flex:none!important}
.visual-v16-flow>.visual-flow-card.size-small{grid-column:span 3!important;grid-row:span 2!important}
.visual-v16-flow>.visual-flow-card.size-medium{grid-column:span 4!important;grid-row:span 3!important}
.visual-v16-flow>.visual-flow-card.size-large{grid-column:span 5!important;grid-row:span 4!important}
.visual-v16-flow>.visual-flow-card.role-household{grid-column:span 3!important;grid-row:span 3!important}
.visual-v16-flow>.visual-flow-card.role-music.size-medium{grid-column:span 4!important;grid-row:span 3!important}
.visual-v16-flow>.visual-flow-card.role-music.size-large{grid-column:span 5!important;grid-row:span 4!important}
.visual-v16-flow>.visual-flow-card.role-awareness.size-large{grid-column:span 4!important;grid-row:span 4!important}
.visual-v16-flow>.visual-flow-card.role-traffic.size-large{grid-column:span 4!important;grid-row:span 4!important}
.visual-v16-flow>.visual-flow-card.role-attention.size-large{grid-column:span 6!important;grid-row:span 4!important}

/* Larger labels and values across Visual Mode. */
.visual-dashboard-card .visual-panel-heading{font-size:14px!important;height:44px!important;padding:0 14px!important}
.visual-dashboard-card .visual-panel-heading ha-icon{--mdc-icon-size:22px!important}
.visual-v16-top .visual-security-state-copy strong{font-size:25px!important}
.visual-v16-top .visual-security-state-copy small{font-size:11px!important}
.visual-v16-top .visual-security-tile strong{font-size:10.5px!important}
.visual-v16-top .visual-security-tile small{font-size:9.5px!important}
.visual-v16-top .visual-weather-current>strong{font-size:18px!important}
.visual-v16-top .visual-weather-current>small{font-size:10px!important}
.visual-v16-top .visual-forecast-day small{font-size:9px!important}
.visual-v16-top .visual-forecast-day strong{font-size:12px!important}
.visual-v16-top .visual-forecast-day em{font-size:9px!important}

.visual-v16-flow .visual-mini-copy strong{font-size:13px!important}
.visual-v16-flow .visual-mini-copy small{font-size:10px!important}
.visual-v16-flow .visual-household-heading strong{font-size:18px!important}
.visual-v16-flow .visual-household-heading em{font-size:10px!important}
.visual-v16-flow .visual-household-person b{font-size:9px!important}
.visual-v16-flow .visual-music-copy strong{font-size:16px!important}
.visual-v16-flow .visual-music-copy em{font-size:10px!important}
.visual-v16-flow .visual-flow-list-row strong,.visual-v16-flow .visual-sports-row strong{font-size:12px!important}
.visual-v16-flow .visual-flow-list-row small,.visual-v16-flow .visual-sports-row small{font-size:9.5px!important}
.visual-v16-flow .visual-glance-tile-copy small{font-size:10px!important}
.visual-v16-flow .visual-glance-tile-copy strong{font-size:13px!important}
.visual-v16-flow .visual-glance-tile-copy em{font-size:9px!important}

/* Rich sports matchup uses Home Status's normalized sports metadata. */
.visual-sports-matchup{display:grid;gap:9px;padding:10px 11px;border:1px solid rgba(244,183,73,.18);border-radius:12px;background:linear-gradient(145deg,rgba(244,183,73,.07),rgba(35,47,62,.14))}
.visual-sports-matchup.is-live{border-color:rgba(239,83,80,.45);background:linear-gradient(145deg,rgba(239,83,80,.11),rgba(35,47,62,.16))}
.visual-sports-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:9px;font-weight:850;letter-spacing:.06em;color:rgba(255,255,255,.48)}
.visual-sports-meta b{padding:3px 6px;border-radius:999px;background:rgba(244,183,73,.12);color:#f4bd57;font-size:8px}
.visual-sports-matchup.is-live .visual-sports-meta b{background:rgba(239,83,80,.16);color:#ff6f6c}
.visual-sports-teams{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px}
.visual-sports-teams>span{display:flex;align-items:baseline;justify-content:space-between;gap:7px;min-width:0;padding:8px;border-radius:9px;background:rgba(255,255,255,.035)}
.visual-sports-teams strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px!important}
.visual-sports-teams b{font-size:20px;color:#fff}
.visual-sports-teams em{font-size:11px;font-style:normal;color:rgba(255,255,255,.35)}

/* Compact modules should visually end when their content ends. */
.visual-v16-flow>.size-small .visual-flow-list,
.visual-v16-flow>.size-small .visual-flow-sports,
.visual-v16-flow>.size-small .visual-flow-attention{padding:8px}
.visual-v16-flow>.size-small .visual-flow-list-row,
.visual-v16-flow>.size-small .visual-sports-row{min-height:50px}
.visual-v16-flow>.role-appliances.size-small .visual-flow-appliances{padding:8px!important}
.visual-v16-flow>.role-appliances.size-small .visual-mini-item{min-height:68px!important}

@media(max-width:1200px){
 .visual-v16-flow>.visual-flow-card.size-small{grid-column:span 4!important}
 .visual-v16-flow>.visual-flow-card.size-medium{grid-column:span 6!important}
 .visual-v16-flow>.visual-flow-card.size-large{grid-column:span 6!important}
 .visual-v16-flow>.visual-flow-card.role-household{grid-column:span 4!important}
}
@media(max-width:760px){
 .visual-v16-flow{grid-template-columns:1fr!important;grid-auto-rows:auto!important}
 .visual-v16-flow>.visual-flow-card{grid-column:1!important;grid-row:auto!important;min-height:140px!important}
}

/* Preview 20 — only Security, Visual Center, Weather and Music own permanent real estate. */
.visual-v20-shell{position:relative;z-index:1;display:grid;gap:10px}
.visual-v20-top{
  display:grid!important;
  grid-template-columns:minmax(285px,21fr) minmax(0,46fr) minmax(400px,33fr)!important;
  gap:10px;
  height:330px;
}
.visual-v20-top>.visual-panel{
  grid-area:auto!important;grid-column:auto!important;grid-row:auto!important;
  width:auto!important;min-width:0!important;height:100%!important;
  justify-self:stretch!important;align-self:stretch!important;
}
.visual-v20-top>.visual-security-panel{min-width:285px!important}
.visual-v20-top>.visual-weather-card{min-width:400px!important}
.visual-v20-top .visual-mode-center{height:calc(100% - 45px)!important;min-height:0!important}

.visual-v20-lower{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(330px,31%);
  gap:10px;
  align-items:start;
}
.visual-dynamic-home-status{
  min-width:0;
  border:1px solid rgba(79,159,255,.18);
  border-radius:16px;
  background:linear-gradient(145deg,rgba(12,24,35,.68),rgba(7,15,23,.72));
  overflow:hidden;
}
.visual-dynamic-heading{
  display:flex;align-items:center;justify-content:space-between;
  min-height:42px;padding:0 13px;border-bottom:1px solid rgba(90,160,225,.13)
}
.visual-dynamic-heading>span{display:flex;align-items:center;gap:8px}
.visual-dynamic-heading ha-icon{--mdc-icon-size:21px;color:#54b8ff}
.visual-dynamic-heading b{font-size:13px;letter-spacing:.055em}
.visual-dynamic-heading small{font-size:9px;color:rgba(255,255,255,.4)}

.visual-v20-flow{
  display:grid!important;
  grid-template-columns:repeat(12,minmax(0,1fr))!important;
  grid-auto-flow:dense!important;
  grid-auto-rows:62px!important;
  gap:8px!important;
  padding:9px;
}
.visual-v20-flow>.visual-flow-card{
  grid-area:auto!important;
  min-width:0!important;min-height:0!important;max-width:none!important;
  flex:none!important;
}
.visual-v20-flow>.visual-flow-card.size-small{grid-column:span 4!important;grid-row:span 2!important}
.visual-v20-flow>.visual-flow-card.size-medium{grid-column:span 6!important;grid-row:span 3!important}
.visual-v20-flow>.visual-flow-card.size-large{grid-column:span 8!important;grid-row:span 4!important}
.visual-v20-flow>.visual-flow-card.role-attention.size-large{grid-column:span 8!important}
.visual-v20-flow>.visual-flow-card.role-traffic.size-large{grid-column:span 6!important}
.visual-v20-flow>.visual-flow-card.role-calendar.size-large{grid-column:span 6!important}
.visual-v20-flow>.visual-flow-card.role-awareness.size-large{grid-column:span 6!important}
.visual-v20-flow>.visual-flow-card.role-household{grid-column:span 5!important;grid-row:span 3!important}
.visual-v20-flow>.visual-flow-card.role-sports.size-small{grid-column:span 4!important;grid-row:span 2!important}
.visual-v20-flow>.visual-flow-card.role-sports.size-medium{grid-column:span 5!important;grid-row:span 3!important}

.visual-music-dedicated{
  position:sticky;
  top:8px;
  min-width:330px;
  min-height:260px;
  overflow:visible!important;
}
.visual-music-dedicated .visual-music-shell{
  min-height:260px;
  padding:13px;
  grid-template-columns:88px 1fr!important;
  grid-template-rows:auto 48px 34px 26px!important;
}
.visual-music-dedicated .visual-music-artwork{width:88px!important;height:88px!important}
.visual-music-dedicated .visual-music-copy strong{font-size:17px!important}
.visual-music-dedicated .visual-music-copy em{font-size:11px!important}

/* Dynamic cards should feel like OG Home Status content entering/leaving a shared lane,
   not permanent dashboard departments. */
.visual-v20-flow .visual-flow-card{animation:none}
@media (prefers-reduced-motion:no-preference){
  .visual-v20-flow.is-reflowing .visual-flow-card{animation:visual-v20-enter .36s cubic-bezier(.2,.8,.2,1) both}
  .visual-v20-flow.is-reflowing .visual-flow-card:nth-child(2){animation-delay:.035s}
  .visual-v20-flow.is-reflowing .visual-flow-card:nth-child(3){animation-delay:.07s}
  .visual-v20-flow.is-reflowing .visual-flow-card:nth-child(4){animation-delay:.105s}
  .visual-v20-flow.is-reflowing .visual-flow-card:nth-child(5){animation-delay:.14s}
}
@keyframes visual-v20-enter{from{opacity:.25;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}

@media(max-width:1200px){
  .visual-v20-top{grid-template-columns:minmax(260px,23fr) minmax(0,43fr) minmax(370px,34fr)!important}
  .visual-v20-top>.visual-security-panel{min-width:260px!important}
  .visual-v20-top>.visual-weather-card{min-width:370px!important}
  .visual-v20-lower{grid-template-columns:minmax(0,1fr) minmax(300px,33%)}
  .visual-v20-flow>.visual-flow-card.size-small{grid-column:span 6!important}
  .visual-v20-flow>.visual-flow-card.size-medium{grid-column:span 6!important}
  .visual-v20-flow>.visual-flow-card.size-large{grid-column:span 12!important}
}
@media(max-width:850px){
  .visual-v20-top{grid-template-columns:1fr 1fr!important;height:auto}
  .visual-v20-top>.visual-media-card{grid-column:1/-1!important;min-height:300px}
  .visual-v20-top>.visual-security-panel,.visual-v20-top>.visual-weather-card{min-width:0!important}
  .visual-v20-lower{grid-template-columns:1fr}
  .visual-music-dedicated{position:relative;top:auto;min-width:0}
}

/* Preview 21 — tablet-distance typography pass. */
.visual-dashboard-card{font-size:16px!important}
.visual-dashboard-card .visual-panel-heading{
  font-size:16px!important;
  height:48px!important;
  padding:0 16px!important;
}
.visual-dashboard-card .visual-panel-heading b{
  font-size:16px!important;
}
.visual-dashboard-card .visual-panel-heading ha-icon{
  --mdc-icon-size:24px!important;
}

/* Security */
.visual-v20-top .visual-security-state-copy strong{font-size:30px!important}
.visual-v20-top .visual-security-state-copy small{font-size:13px!important}
.visual-v20-top .visual-security-tile strong{font-size:13px!important}
.visual-v20-top .visual-security-tile small{font-size:11px!important}
.visual-v20-top .visual-security-tile-icon ha-icon{--mdc-icon-size:21px!important}

/* Weather */
.visual-v20-top .visual-weather-temp{font-size:58px!important}
.visual-v20-top .visual-weather-current>strong{font-size:21px!important}
.visual-v20-top .visual-weather-current>small{font-size:12px!important}
.visual-v20-top .visual-humidity-ring b{font-size:15px!important}
.visual-v20-top .visual-humidity-ring small{font-size:9px!important}
.visual-v20-top .visual-forecast-day small{font-size:10px!important}
.visual-v20-top .visual-forecast-day strong{font-size:14px!important}
.visual-v20-top .visual-forecast-day em{font-size:10px!important}

/* Dynamic Home Status region */
.visual-dynamic-heading b{font-size:16px!important}
.visual-dynamic-heading small{font-size:11px!important}
.visual-v20-flow .visual-mini-copy strong{font-size:15px!important}
.visual-v20-flow .visual-mini-copy small{font-size:12px!important}
.visual-v20-flow .visual-household-heading strong{font-size:20px!important}
.visual-v20-flow .visual-household-heading em{font-size:12px!important}
.visual-v20-flow .visual-household-person b{font-size:10px!important}
.visual-v20-flow .visual-flow-list-row strong,
.visual-v20-flow .visual-sports-row strong{font-size:14px!important}
.visual-v20-flow .visual-flow-list-row small,
.visual-v20-flow .visual-sports-row small{font-size:11px!important}
.visual-v20-flow .visual-glance-tile-copy small{font-size:12px!important}
.visual-v20-flow .visual-glance-tile-copy strong{font-size:15px!important}
.visual-v20-flow .visual-glance-tile-copy em{font-size:11px!important}
.visual-v20-flow .visual-sports-meta{font-size:11px!important}
.visual-v20-flow .visual-sports-meta b{font-size:10px!important}
.visual-v20-flow .visual-sports-teams strong{font-size:17px!important}
.visual-v20-flow .visual-sports-teams b{font-size:22px!important}

/* Dedicated Music */
.visual-music-dedicated .visual-music-copy small{font-size:10px!important}
.visual-music-dedicated .visual-music-copy strong{font-size:20px!important}
.visual-music-dedicated .visual-music-copy em{font-size:13px!important}
.visual-music-dedicated .visual-music-source-trigger span{font-size:12px!important}
.visual-music-dedicated .visual-music-volume b{font-size:10px!important}

/* Recent rail */
:host([data-presentation-mode="visual"]) .visual-mode-ticker .visual-rail-label strong{font-size:14px!important}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .visual-rail-label small{font-size:10px!important}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy strong{font-size:20px!important}
:host([data-presentation-mode="visual"]) .visual-mode-ticker .footer-marquee-copy small{font-size:13px!important}
@media(max-width:1000px){.visual-v5-grid{grid-template-columns:1fr 1.35fr 1fr}.visual-security-tile-row{grid-template-columns:1fr 1fr}.visual-security-tile:nth-child(3){display:none}.visual-v5-grid{grid-template-rows:270px 240px}}@media(max-width:760px){.visual-v5-grid{grid-template-columns:1fr 1fr;grid-template-rows:auto;grid-template-areas:"security weather" "media media" "appliances glance"}.visual-household-card,.visual-music-card{display:none}.visual-mode-center{min-height:310px;height:310px}:host([data-presentation-mode="visual"]) .visual-mode-ticker{grid-template-columns:1fr}:host([data-presentation-mode="visual"]) .visual-rail-label{display:none}}@media(max-width:560px){.visual-v5-grid{grid-template-columns:1fr;grid-template-areas:"security" "weather" "media" "appliances" "glance"}.visual-mode-center{min-height:260px;height:260px}}


/* Preview 41 — fixed-region polish: weather fit, RECENT restore, security cleanup. */
.visual-clean-dashboard{position:relative;overflow:hidden;border-radius:22px!important;background:linear-gradient(145deg,rgba(5,13,20,.96),rgba(3,10,16,.97))!important}
.visual-clean-shell{position:relative;z-index:1;display:grid;grid-template-rows:320px 104px minmax(320px,1fr);gap:10px;padding:12px 12px 0}
.visual-clean-top{display:grid;grid-template-columns:minmax(285px,22fr) minmax(420px,46fr) minmax(360px,32fr);gap:10px;min-height:0}
.visual-clean-security,.visual-clean-center,.visual-clean-music,.visual-clean-weather,.visual-clean-content{min-width:0;border:1px solid rgba(78,155,225,.22);border-radius:16px;background:linear-gradient(145deg,rgba(14,29,42,.90),rgba(7,17,26,.92));overflow:hidden}
.visual-clean-security.beacon-disarmed{--security-beacon:#59e982;--security-beacon-dim:#214d3e}
.visual-clean-security.beacon-armed-home{--security-beacon:#ff5252;--security-beacon-dim:#642525}
.visual-clean-security.beacon-armed-away{--security-beacon:#ff5252;--security-beacon-dim:#642525}
.visual-clean-security.beacon-pending{--security-beacon:#ffb52e;--security-beacon-dim:#624619}
.visual-clean-security.beacon-triggered{--security-beacon:#ff5252;--security-beacon-dim:#642525}
.visual-clean-security.beacon-neutral{--security-beacon:#8796a8;--security-beacon-dim:#304052}
.visual-clean-security .visual-security-ring{border-color:var(--security-beacon,#8796a8)!important}
.visual-clean-security .visual-security-ring ha-icon{color:var(--security-beacon,#8796a8)!important}
.visual-clean-security .visual-security-state-copy strong{color:var(--security-beacon,#8796a8)}
@media (prefers-reduced-motion:no-preference){
  .visual-clean-security.beacon-pending .visual-security-ring{animation:visual-security-pulse 1.5s ease-in-out infinite}
  .visual-clean-security.beacon-armed-home .visual-security-ring,
  .visual-clean-security.beacon-armed-away .visual-security-ring{animation:visual-security-pulse 1.8s ease-in-out infinite}
  .visual-clean-security.beacon-triggered .visual-security-ring{animation:visual-security-alert .8s ease-in-out infinite}
}

.visual-clean-security .visual-security-shortcuts{display:flex;gap:9px;align-items:center;padding:4px 14px 10px}
.visual-clean-security .visual-security-shortcuts:empty{display:none}
.visual-clean-security .visual-security-shortcuts button{display:flex;align-items:center;justify-content:center;gap:7px;min-height:46px;min-width:0;flex:1;padding:8px 10px;border:1px solid rgba(115,170,215,.25);border-radius:12px;background:rgba(48,96,145,.12);color:#e6efff;font:600 14px/1.2 inherit;cursor:pointer}
.visual-clean-security .visual-security-shortcuts button ha-icon{--mdc-icon-size:23px;color:#8ebfff}
.visual-clean-security .visual-security-shortcuts button:active{transform:scale(.97);background:rgba(85,145,200,.24)}
.visual-clean-music .visual-music-source-wrap{z-index:30}
.visual-clean-music .visual-music-source-menu{max-height:min(440px,65vh);width:100%;box-sizing:border-box;z-index:31}
.visual-clean-security{display:flex;flex-direction:column;justify-content:flex-start}
.visual-clean-security .visual-security-hero{grid-template-columns:86px 1fr!important;padding:16px 15px 8px!important}
.visual-clean-security .visual-security-ring{width:72px!important;height:72px!important;border-width:8px!important}
.visual-clean-security .visual-security-ring ha-icon{--mdc-icon-size:34px!important}
.visual-clean-security .visual-security-state-copy strong{font-size:30px!important;line-height:1.05!important}
.visual-clean-security .visual-security-state-copy small{font-size:14px!important;margin-top:5px!important}
.visual-clean-security .visual-security-tile-row{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(130px,1fr))!important;padding:7px 10px 10px!important;gap:8px!important}
.visual-clean-security .visual-security-tile{min-height:58px!important;padding:9px 10px!important;min-width:0!important}
.visual-clean-center{position:relative;background:rgba(0,0,0,.34)}
.visual-clean-center .visual-mode-center{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;min-height:0!important;border-radius:15px!important;background:rgba(0,0,0,.28)!important}
.visual-clean-music{padding:0!important;overflow:visible!important}
.visual-clean-music>.visual-music-shell{height:100%!important;min-height:0!important;border:0!important;background:transparent!important}
.visual-clean-music .visual-music-shell.visual-music-idle{display:grid!important;grid-template-columns:52px minmax(0,1fr) 58px!important;align-items:center!important;gap:12px!important;padding:18px!important;height:auto!important;min-height:92px!important}
.visual-clean-music .visual-music-idle-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:14px;background:rgba(124,91,230,.20);color:#a88bff}
.visual-clean-music .visual-music-idle-icon ha-icon{--mdc-icon-size:30px}
.visual-clean-music .visual-music-idle-play{width:58px!important;height:58px!important;border-radius:14px!important}
.visual-clean-music .visual-music-source-trigger{height:48px!important;font-size:15px!important}
.visual-clean-music .visual-music-active{display:grid!important;grid-template-columns:102px minmax(0,1fr)!important;grid-template-rows:auto 54px 42px 28px!important;gap:8px 14px!important;padding:14px!important}
.visual-clean-music .visual-music-artwork{width:102px!important;height:102px!important;border-radius:18px!important}
.visual-clean-music .visual-music-copy{min-width:0!important;align-content:start!important;overflow:hidden!important}
.visual-clean-music .visual-music-copy strong{font-size:25px!important;line-height:1.08!important;white-space:normal!important;overflow:hidden!important;text-overflow:ellipsis!important;overflow-wrap:break-word!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:3!important;max-height:3.24em!important}
.visual-clean-music .visual-music-copy em{font-size:14px!important;line-height:1.2!important;white-space:normal!important;overflow:hidden!important;text-overflow:ellipsis!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:1!important;max-height:1.2em!important}
.visual-clean-music .visual-music-controls button{width:44px!important;height:44px!important}
.visual-clean-weather{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,.34fr);align-items:center;column-gap:24px;padding:8px 22px;box-sizing:border-box;background:linear-gradient(90deg,rgba(10,39,63,.96),rgba(5,25,42,.96))}
.visual-clean-weather-primary{display:flex;align-items:center;gap:14px;min-width:0;overflow:hidden}
.visual-clean-weather-primary>.visual-weather-icon{--mdc-icon-size:48px!important;color:#53b8ff;flex:0 0 auto}
.visual-clean-weather .visual-weather-temp{font-size:58px!important;line-height:.9!important;font-weight:800!important;color:#fff;flex:0 0 auto}
.visual-clean-weather-copy{display:grid;gap:3px;min-width:0}
.visual-clean-weather-copy strong{font-size:21px;line-height:1.05;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.visual-clean-weather-copy small,.visual-clean-weather-metric small{font-size:11px;line-height:1.1;color:rgba(255,255,255,.55)}
.visual-clean-weather-metric{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-width:0;padding-left:22px;border-left:1px solid rgba(255,255,255,.13)}
.visual-clean-weather-metric>ha-icon{--mdc-icon-size:28px;color:#42b7ff;flex:0 0 auto}
.visual-clean-weather-metric>span{display:grid}
.visual-clean-weather-metric b{font-size:25px;line-height:1}
.visual-clean-weather .visual-humidity-ring{display:none!important}
.visual-clean-content{padding:9px;overflow:hidden;background:linear-gradient(145deg,rgba(8,21,31,.86),rgba(6,15,23,.90))}
.visual-clean-content .visual-v20-flow{height:100%;padding:0!important;gap:8px!important;grid-auto-rows:58px!important;align-content:start}
.visual-clean-content .visual-flow-card{border-color:rgba(79,159,255,.16)!important;background:rgba(12,28,41,.72)!important}
.visual-clean-content .visual-flow-card>.visual-panel-heading{display:none!important}
.visual-clean-content .visual-flow-card.size-small{grid-row:span 2!important}
.visual-clean-content .visual-flow-card.size-medium{grid-row:span 3!important}
.visual-clean-content .visual-flow-card.size-large{grid-row:span 4!important}
.visual-clean-content .visual-mini-copy strong,.visual-clean-content .visual-flow-list-row strong,.visual-clean-content .visual-sports-row strong{font-size:17px!important}
.visual-clean-content .visual-mini-copy small,.visual-clean-content .visual-flow-list-row small,.visual-clean-content .visual-sports-row small{font-size:13px!important}
.visual-clean-content .visual-household-heading strong{font-size:24px!important}
.visual-clean-content .visual-household-heading em{font-size:14px!important}
.visual-clean-content .visual-glance-tile-copy strong{font-size:17px!important}
.visual-clean-content .visual-glance-tile-copy small{font-size:13px!important}
.visual-clean-dashboard>.weather-renderer-layer{position:absolute!important;inset:0!important;z-index:0!important;pointer-events:none!important}
.visual-clean-dashboard>:not(.weather-renderer-layer){position:relative;z-index:1}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker{margin:10px 12px 12px!important;width:calc(100% - 24px)!important;height:82px!important;min-height:82px!important;max-height:82px!important;grid-template-columns:180px 1fr!important}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker .ticker-footer,:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker .footer-marquee{height:82px!important;min-height:82px!important}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-rail-label strong{font-size:14px!important}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-rail-label small{font-size:10px!important}
@media(max-width:1100px){.visual-clean-shell{grid-template-rows:300px 96px minmax(300px,1fr)}.visual-clean-top{grid-template-columns:minmax(250px,22fr) minmax(360px,45fr) minmax(320px,33fr)}.visual-clean-music .visual-music-active{grid-template-columns:90px minmax(0,1fr)!important}.visual-clean-music .visual-music-artwork{width:90px!important;height:90px!important}.visual-clean-music .visual-music-copy strong{font-size:21px!important}}
@media(max-width:800px){.visual-clean-shell{grid-template-rows:auto auto auto}.visual-clean-top{grid-template-columns:1fr 1fr}.visual-clean-center{grid-column:1/-1;min-height:280px}.visual-clean-music{min-height:220px}.visual-clean-weather{grid-template-columns:1fr}.visual-clean-weather-metric{border-left:0;padding-left:0}.visual-clean-content{min-height:360px}}

/* Preview 42: approved mock is the layout specification. */
.visual-clean-shell{grid-template-rows:320px 112px 323px!important;gap:10px!important;padding:12px 12px 0!important}
.visual-clean-top{grid-template-columns:minmax(270px,26fr) minmax(430px,43fr) minmax(330px,31fr)!important;gap:10px!important}
.visual-clean-security,.visual-clean-center,.visual-clean-music,.visual-clean-weather,.visual-clean-content{border-color:rgba(78,155,225,.24)!important;background:linear-gradient(145deg,rgba(12,27,40,.94),rgba(6,16,25,.96))!important}
.visual-clean-security .visual-security-tile-row{grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important}
.visual-clean-security .visual-security-tile{min-width:0!important;min-height:64px!important}
.visual-clean-center{background:#02070b!important}
.visual-clean-music{overflow:hidden!important}
.visual-clean-weather{grid-template-columns:minmax(360px,32fr) minmax(130px,12fr) minmax(0,56fr)!important;gap:0!important;padding:8px 20px!important;background:linear-gradient(90deg,rgba(8,41,67,.98),rgba(5,26,44,.98))!important}
.visual-clean-weather-primary{padding-right:22px!important}
.visual-clean-weather-metric{height:68px!important;padding:0 22px!important;border-left:1px solid rgba(255,255,255,.13)!important;border-right:1px solid rgba(255,255,255,.13)!important}
.visual-clean-weather-forecast{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr))!important;align-items:center!important;height:100%!important;min-width:0!important;padding-left:12px!important}
.visual-clean-weather-forecast .visual-forecast-day{display:grid!important;grid-template-columns:1fr!important;justify-items:center!important;gap:1px!important;min-width:0!important;padding:0 8px!important;border-left:1px solid rgba(255,255,255,.08)!important}
.visual-clean-weather-forecast .visual-forecast-day:first-child{border-left:0!important}
.visual-clean-weather-forecast .visual-forecast-day small{font-size:10px!important;text-transform:uppercase!important;color:rgba(255,255,255,.72)!important}
.visual-clean-weather-forecast .visual-forecast-day ha-icon{--mdc-icon-size:25px!important;color:#ffd45a!important}
.visual-clean-weather-forecast .visual-forecast-day strong{font-size:15px!important;line-height:1!important}
.visual-clean-weather-forecast .visual-forecast-day em{font-size:10px!important;line-height:1!important;color:rgba(255,255,255,.55)!important;font-style:normal!important}
.visual-clean-weather-forecast .visual-forecast-waiting{display:grid!important;place-items:center!important;height:100%!important;font-size:12px!important;color:rgba(255,255,255,.46)!important}

.visual-clean-content{padding:0!important;overflow:hidden!important;background:rgba(4,12,18,.88)!important}
.visual-clean-content .visual-v20-flow{display:grid!important;grid-template-columns:20fr 20fr 20fr 12fr 12fr 16fr!important;grid-template-rows:1fr!important;grid-auto-rows:unset!important;grid-auto-flow:column!important;gap:8px!important;height:100%!important;min-height:0!important;padding:0!important;align-items:stretch!important;align-content:stretch!important}
.visual-clean-content .visual-v20-flow>.visual-flow-card{grid-column:auto!important;grid-row:1!important;width:auto!important;height:100%!important;min-width:0!important;min-height:0!important;max-height:none!important;overflow:hidden!important;border-radius:13px!important;border:1px solid rgba(74,142,201,.19)!important;background:linear-gradient(180deg,rgba(12,29,43,.90),rgba(8,21,32,.94))!important;padding:0!important}
.visual-clean-content .visual-flow-card>.visual-panel-heading{display:none!important}
.visual-clean-content .visual-flow-card.size-fixed{grid-column:auto!important;grid-row:1!important}
.visual-clean-content .visual-flow-card>div:not(.visual-panel-heading){height:100%!important;min-height:0!important}
.visual-clean-content .visual-flow-list,.visual-clean-content .visual-flow-sports,.visual-clean-content .visual-flow-attention,.visual-clean-content .visual-flow-appliances{display:flex!important;flex-direction:column!important;height:100%!important;min-height:0!important;padding:10px!important;gap:7px!important;box-sizing:border-box!important}
.visual-clean-content .visual-flow-list-row,.visual-clean-content .visual-mini-item,.visual-clean-content .visual-flow-attention-item,.visual-clean-content .visual-sports-row{flex:1 1 0!important;min-height:0!important;border-radius:10px!important;padding:9px 10px!important;box-sizing:border-box!important}
.visual-clean-content .visual-flow-list-row>span,.visual-clean-content .visual-mini-copy,.visual-clean-content .visual-sports-row>span:last-child{min-width:0!important}
.visual-clean-content .visual-flow-list-row strong,.visual-clean-content .visual-mini-copy strong,.visual-clean-content .visual-sports-row strong{font-size:15px!important;line-height:1.13!important;white-space:normal!important;overflow:hidden!important;display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important}
.visual-clean-content .visual-flow-list-row small,.visual-clean-content .visual-mini-copy small,.visual-clean-content .visual-sports-row small{font-size:11px!important;line-height:1.18!important;margin-top:4px!important}
.visual-clean-content .visual-flow-household{height:100%!important;padding:0!important}
.visual-clean-content .visual-household-shell{height:100%!important;display:flex!important;flex-direction:column!important;padding:12px!important;box-sizing:border-box!important}
.visual-clean-content .visual-household-heading{flex:0 0 auto!important;padding:7px 2px 14px!important}
.visual-clean-content .visual-household-heading small{display:none!important}
.visual-clean-content .visual-household-heading strong{font-size:20px!important;line-height:1.1!important}
.visual-clean-content .visual-household-heading em{font-size:11px!important;line-height:1.25!important;margin-top:5px!important;white-space:normal!important}
.visual-clean-content .visual-household-people-grid{display:grid!important;grid-template-columns:1fr!important;gap:7px!important;align-content:start!important;overflow:hidden!important}
.visual-clean-content .visual-household-person{display:flex!important;align-items:center!important;gap:8px!important;min-height:42px!important;padding:6px 8px!important;border-radius:9px!important;background:rgba(255,255,255,.025)!important}
.visual-clean-content .visual-household-person b{font-size:12px!important}
.visual-clean-content .visual-glance-grid{display:grid!important;grid-template-columns:1fr!important;grid-template-rows:repeat(4,minmax(0,1fr))!important;gap:7px!important;height:100%!important;padding:10px!important;box-sizing:border-box!important}
.visual-clean-content .visual-glance-tile{min-height:0!important;height:100%!important;padding:8px!important;border-radius:10px!important}
.visual-clean-content .visual-glance-tile-copy strong{font-size:14px!important;line-height:1.1!important}
.visual-clean-content .visual-glance-tile-copy small,.visual-clean-content .visual-glance-tile-copy em{font-size:10px!important}
.visual-clean-content .visual-sports-matchup{height:auto!important;min-height:150px!important;margin:10px!important;padding:10px!important;border-radius:12px!important}
.visual-clean-content .visual-sports-meta{font-size:10px!important}
.visual-clean-content .visual-sports-teams{gap:6px!important}
.visual-clean-content .visual-sports-teams strong{font-size:14px!important}
.visual-clean-content .visual-sports-teams b{font-size:19px!important}
.visual-clean-content .visual-adaptive-quiet{height:100%!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:10px!important;padding:14px!important;box-sizing:border-box!important}
.visual-clean-content .visual-adaptive-quiet strong{font-size:16px!important}
.visual-clean-content .visual-adaptive-quiet small{font-size:11px!important}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker{margin:10px 12px 12px!important;width:calc(100% - 24px)!important;height:86px!important;min-height:86px!important;max-height:86px!important;grid-template-columns:180px 1fr!important;background:linear-gradient(90deg,rgba(10,39,63,.98),rgba(5,26,44,.98))!important}
:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker .ticker-footer,:host([data-presentation-mode="visual"]) .visual-clean-dashboard .visual-mode-ticker .footer-marquee{height:86px!important;min-height:86px!important}
@media(max-width:1100px){.visual-clean-shell{grid-template-rows:300px 104px 300px!important}.visual-clean-top{grid-template-columns:minmax(245px,26fr) minmax(360px,43fr) minmax(300px,31fr)!important}.visual-clean-content .visual-v20-flow{grid-template-columns:repeat(3,minmax(0,1fr))!important}}

/* Preview 50: three fixed slots with compact internals sized for the 323px presentation row. */
.visual-clean-content .visual-v20-flow{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;gap:10px!important;height:100%!important;padding:0!important;align-items:stretch!important;overflow:hidden!important}
.visual-clean-content .visual-presentation-slot{min-width:0!important;height:100%!important;overflow:hidden!important;border:1px solid rgba(72,157,225,.28)!important;border-radius:15px!important;background:linear-gradient(155deg,rgba(10,28,42,.96),rgba(5,15,24,.98))!important;box-sizing:border-box!important;display:flex!important;align-items:stretch!important}

.visual-clean-content .visual-presentation-slot.is-tappable{cursor:pointer!important;transition:transform .12s ease,border-color .12s ease,filter .12s ease!important;touch-action:manipulation}.visual-clean-content .visual-presentation-slot.is-tappable:active{transform:scale(.985)!important;filter:brightness(1.14)!important;border-color:rgba(102,190,255,.72)!important}
.visual-clean-content .visual-presentation-inner{width:100%!important;height:100%!important;display:grid!important;grid-template-columns:86px minmax(0,1fr)!important;align-items:center!important;gap:16px!important;padding:18px!important;box-sizing:border-box!important}
.visual-clean-content .visual-presentation-icon{--mdc-icon-size:60px!important;width:86px!important;height:86px!important;display:grid!important;place-items:center!important;border-radius:22px!important;padding:12px!important;box-sizing:border-box!important;background:rgba(54,155,225,.13)!important;color:#52b9ff!important}
.visual-clean-content .visual-presentation-copy{min-width:0!important;max-height:100%!important;display:flex!important;flex-direction:column!important;justify-content:center!important;gap:7px!important;overflow:hidden!important}
.visual-clean-content .visual-presentation-copy strong{font-size:24px!important;line-height:1.08!important;font-weight:800!important;white-space:normal!important;overflow:hidden!important;display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important}
.visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:38px!important;line-height:1!important;font-weight:900!important;letter-spacing:-.02em!important;color:#fff!important;white-space:normal!important;overflow-wrap:anywhere!important}
.visual-clean-content .visual-presentation-copy .visual-presentation-value-small{font-size:29px!important;line-height:1.04!important}
.visual-clean-content .visual-presentation-copy b{font-size:16px!important;line-height:1.2!important;font-weight:500!important;color:rgba(255,255,255,.64)!important;white-space:normal!important;overflow:hidden!important;display:-webkit-box!important;-webkit-line-clamp:2!important;-webkit-box-orient:vertical!important}
.visual-clean-content .visual-presentation-slot.type-household{border-color:rgba(102,187,106,.45)!important;background:linear-gradient(155deg,rgba(8,42,25,.82),rgba(5,20,16,.96))!important}.visual-clean-content .type-household .visual-presentation-icon{color:#71db78!important;background:rgba(102,187,106,.15)!important}
.visual-clean-content .visual-presentation-slot.type-traffic{border-color:rgba(66,165,245,.48)!important}.visual-clean-content .type-traffic .visual-presentation-value{color:#55b8ff!important}
.visual-clean-content .visual-presentation-slot.type-sports{border-color:rgba(156,107,255,.48)!important;background:linear-gradient(155deg,rgba(26,18,50,.84),rgba(9,12,24,.98))!important}.visual-clean-content .type-sports .visual-presentation-icon{color:#aa7bff!important;background:rgba(156,107,255,.15)!important}
.visual-clean-content .visual-presentation-slot.type-calendar{border-color:rgba(255,193,7,.42)!important}.visual-clean-content .type-calendar .visual-presentation-icon{color:#ffd45a!important;background:rgba(255,193,7,.12)!important}
.visual-clean-content .visual-presentation-slot.type-appliance{border-color:rgba(139,195,74,.48)!important}.visual-clean-content .type-appliance .visual-presentation-icon{color:#9bdc58!important;background:rgba(139,195,74,.14)!important}
.visual-clean-content .visual-presentation-slot.type-glance{border-color:rgba(0,188,212,.42)!important}.visual-clean-content .type-glance .visual-presentation-icon{color:#48d6e9!important;background:rgba(0,188,212,.13)!important}
.visual-clean-content .visual-v20-flow.is-reflowing>.visual-presentation-slot{animation:none!important}
/* Preview 52: give the three rotating cards breathing room inside the fixed 323px presentation area. */
.visual-clean-content .visual-v20-flow{padding:6px!important;box-sizing:border-box!important;gap:10px!important}
.visual-clean-content .visual-presentation-slot{height:100%!important;min-height:0!important}
@media(max-width:1100px){.visual-clean-content .visual-presentation-inner{grid-template-columns:70px minmax(0,1fr)!important;gap:12px!important;padding:14px!important}.visual-clean-content .visual-presentation-icon{--mdc-icon-size:48px!important;width:70px!important;height:70px!important;padding:10px!important;border-radius:18px!important}.visual-clean-content .visual-presentation-copy strong{font-size:21px!important}.visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:34px!important}.visual-clean-content .visual-presentation-copy .visual-presentation-value-small{font-size:26px!important}.visual-clean-content .visual-presentation-copy b{font-size:15px!important}}

/* Preview 53: vertical-fit pass. Keep Preview 52 slot clearance and V1 rotation behavior unchanged. */
.visual-clean-shell{grid-template-rows:285px 100px 290px!important;gap:8px!important;padding:8px 12px 0!important}
.visual-clean-weather{padding:6px 16px!important}
.visual-clean-weather-primary{padding-right:16px!important}
.visual-clean-weather-metric{height:60px!important;padding:0 16px!important}
.visual-clean-weather-forecast{padding-left:8px!important}
.visual-clean-content .visual-v20-flow{padding:6px!important;gap:8px!important}
@media(max-width:1100px){.visual-clean-shell{grid-template-rows:270px 92px 275px!important;gap:8px!important;padding-top:8px!important}.visual-clean-weather{padding:5px 14px!important}.visual-clean-weather-metric{height:56px!important;padding:0 14px!important}}

/* Preview 55: weather has two stable faces and the strip navigates to Radar. */
.visual-clean-weather{cursor:pointer!important;overflow:hidden!important;touch-action:manipulation}
.visual-clean-weather:active{transform:scale(.996)}
.visual-weather-face{display:contents}
.visual-weather-outside{grid-column:1/-1;display:grid;grid-template-columns:minmax(300px,1fr) minmax(420px,1.3fr);align-items:center;width:100%;height:100%;padding:0 24px;box-sizing:border-box}
.visual-weather-outside-title{display:flex;align-items:center;gap:18px;min-width:0}
.visual-weather-outside-title>ha-icon{--mdc-icon-size:54px;color:#55c8ff}
.visual-weather-outside-title span{display:flex;flex-direction:column;gap:2px}
.visual-weather-outside-title strong{font-size:30px;line-height:1;font-weight:850}
.visual-weather-outside-title small{font-size:14px;color:rgba(255,255,255,.62)}
.visual-weather-outside-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));height:72%;border-left:1px solid rgba(255,255,255,.13)}
.visual-weather-outside-metrics>span{display:grid;grid-template-columns:auto auto;grid-template-rows:auto auto;align-content:center;justify-content:center;column-gap:12px;min-width:0;border-right:1px solid rgba(255,255,255,.08)}
.visual-weather-outside-metrics ha-icon{grid-row:1/3;--mdc-icon-size:34px;color:#55c8ff;align-self:center}
.visual-weather-outside-metrics b{font-size:34px;line-height:1;font-weight:900}
.visual-weather-outside-metrics small{font-size:12px;color:rgba(255,255,255,.6)}
@media(max-width:1100px){.visual-weather-outside{grid-template-columns:minmax(240px,1fr) minmax(360px,1.4fr);padding:0 18px}.visual-weather-outside-title>ha-icon{--mdc-icon-size:44px}.visual-weather-outside-title strong{font-size:25px}.visual-weather-outside-metrics b{font-size:29px}}

/* Presentation mode phone layouts. These rules are deliberately isolated from
 * Classic mode: phone portrait becomes a natural single-column story, while a
 * short landscape phone keeps the important at-a-glance regions on screen. */
:host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-dashboard{border-radius:18px!important}

@media (max-width:600px) and (orientation:portrait){
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-shell{display:grid!important;grid-template-columns:minmax(0,1fr)!important;grid-template-areas:"security" "music" "center" "weather" "content"!important;grid-template-rows:auto auto 170px auto 190px!important;gap:8px!important;padding:8px 8px 0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-top{display:contents!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security{grid-area:security;min-height:88px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music{grid-area:music;min-height:142px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-center{grid-area:center;min-height:170px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather{grid-area:weather;min-height:178px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content{grid-area:content;min-height:190px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-hero{grid-template-columns:62px minmax(0,1fr)!important;padding:11px 12px 5px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-ring{width:52px!important;height:52px!important;border-width:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-ring ha-icon{--mdc-icon-size:26px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy strong{font-size:23px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy small{font-size:12px!important;margin-top:3px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-tile-row{position:absolute;top:8px;right:8px;width:132px;grid-template-columns:repeat(2,minmax(0,1fr))!important;padding:0!important;gap:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-tile{min-height:70px!important;padding:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-active{grid-template-columns:88px minmax(0,1fr)!important;grid-template-rows:auto 34px 25px!important;gap:5px 11px!important;padding:11px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-artwork{width:88px!important;height:88px!important;border-radius:14px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-copy strong{font-size:20px!important;-webkit-line-clamp:2!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather{grid-template-columns:1fr!important;gap:8px!important;padding:12px 15px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-primary{padding:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather .visual-weather-temp{font-size:50px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-metric{padding:7px 0 0!important;border:0!important;border-top:1px solid rgba(255,255,255,.13)!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-forecast{padding:6px 0 0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-v20-flow{grid-template-columns:1fr!important;grid-template-rows:1fr!important;padding:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-slot:not(:first-child){display:none!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-inner{grid-template-columns:64px minmax(0,1fr)!important;gap:12px!important;padding:14px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-icon{width:64px!important;height:64px!important;--mdc-icon-size:42px!important;border-radius:16px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy strong{font-size:20px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:31px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker{margin:8px!important;width:calc(100% - 16px)!important;height:72px!important;min-height:72px!important;max-height:72px!important;grid-template-columns:1fr!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-rail-label{display:none!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .ticker-footer,:host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee{height:72px!important;min-height:72px!important}
}

@media (max-height:600px) and (orientation:landscape){
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-shell{display:grid!important;grid-template-columns:minmax(150px,.9fr) minmax(220px,1.25fr) minmax(220px,1.35fr)!important;grid-template-areas:"security music weather" "center center center" "content content content"!important;grid-template-rows:126px 122px 92px!important;gap:7px!important;padding:7px 7px 0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-top{display:contents!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security{grid-area:security;min-height:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music{grid-area:music;min-height:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-center{grid-area:center;min-height:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather{grid-area:weather;min-height:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content{grid-area:content;min-height:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-hero{grid-template-columns:56px minmax(0,1fr)!important;padding:10px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-ring{width:48px!important;height:48px!important;border-width:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy strong{font-size:20px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy small{font-size:11px!important;margin-top:2px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-tile-row{display:none!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-active{grid-template-columns:68px minmax(0,1fr)!important;grid-template-rows:auto 30px 22px!important;gap:4px 9px!important;padding:9px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-artwork{width:68px!important;height:68px!important;border-radius:12px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-copy strong{font-size:17px!important;-webkit-line-clamp:1!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather{grid-template-columns:minmax(0,1fr) minmax(80px,.35fr)!important;padding:9px 12px!important;gap:8px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-primary{gap:8px!important;padding:0!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-primary>.visual-weather-icon{--mdc-icon-size:38px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather .visual-weather-temp{font-size:43px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-copy strong{font-size:16px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-forecast{display:none!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-v20-flow{grid-template-columns:repeat(3,minmax(0,1fr))!important;grid-template-rows:1fr!important;padding:5px!important;gap:6px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-inner{grid-template-columns:42px minmax(0,1fr)!important;gap:7px!important;padding:8px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-icon{width:42px!important;height:42px!important;--mdc-icon-size:27px!important;border-radius:11px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy strong{font-size:14px!important;-webkit-line-clamp:1!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:21px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy b{font-size:10px!important;-webkit-line-clamp:1!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker{margin:7px!important;width:calc(100% - 14px)!important;height:58px!important;min-height:58px!important;max-height:58px!important;grid-template-columns:130px 1fr!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-rail-label{display:flex!important;padding:0 8px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-rail-label>ha-icon{--mdc-icon-size:24px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-rail-label small{display:none!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .ticker-footer,:host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee{height:58px!important;min-height:58px!important}
}

/* Text-only polish for the approved phone presentation layout. */
@media (max-width:600px) and (orientation:portrait){
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy strong{font-size:21px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy small{font-size:11px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-tile strong{font-size:11px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-tile small{font-size:9px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-copy strong{font-size:18px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-copy em{font-size:12px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-source-trigger{font-size:12px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-fallback{font-size:14px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather .visual-weather-temp{font-size:44px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-copy strong{font-size:16px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-copy small,:host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-metric small{font-size:9px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-metric b{font-size:20px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-forecast .visual-forecast-day small{font-size:8px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-forecast .visual-forecast-day strong{font-size:12px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-forecast .visual-forecast-day em{font-size:8px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy strong{font-size:18px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:28px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy .visual-presentation-value-small{font-size:22px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy b{font-size:12px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee-copy strong{font-size:16px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee-copy small{font-size:10px!important}
}

@media (max-height:600px) and (orientation:landscape){
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-security .visual-security-state-copy strong{font-size:18px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-music .visual-music-copy strong{font-size:16px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather .visual-weather-temp{font-size:39px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-copy strong{font-size:14px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-weather-metric b{font-size:18px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy strong{font-size:13px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy .visual-presentation-value{font-size:20px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-clean-content .visual-presentation-copy b{font-size:9px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee-copy strong{font-size:14px!important}
  :host([data-presentation-mode="visual"][data-profile="phone"]) .visual-mode-ticker .footer-marquee-copy small{font-size:9px!important}
}

`;

if (
  !customElements.get(
    'home-status-card-editor'
  )
) {
  customElements.define(
    'home-status-card-editor',
    HomeStatusCardEditor
  );
}

if (
  !customElements.get(
    'home-status-card'
  )
) {
  customElements.define(
    'home-status-card',
    HomeStatusCard
  );
}

window.customCards =
  window.customCards || [];

if (
  !window.customCards.some(
    card =>
      card.type ===
      'home-status-card'
  )
) {
  window.customCards.push({
    type:
      'home-status-card',

    name:
      'Home Status Card',

    description:
      'Home Status ticker with local notification drawer',

    preview:
      true
  });
}
