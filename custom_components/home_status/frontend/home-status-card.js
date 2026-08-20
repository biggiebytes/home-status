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
  'hero',
  'sidebar',
  'footer',
  'context_actions',
  'display',
  'visibility',
  'home_status_visibility',
  'sizing',
  'animation',
  'weather_effect',
  'time_entity',
  'recent_drawer_limit',
  'rotation_seconds',
  'lane_mode',
  'theme_mode',
  'footer_speed',
  'phone_ticker_speed'
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
    this._activeSlotClaims = new Map();

    // The six physical slots keep independent state, but share one scheduler.
    // Slots with the same interval therefore advance on the same visual beat.
    this._laneCycleTimer = null;
    this._laneCycleEpoch = performance.now();

    // Legacy single-item lanes remain a supported presentation mode. They
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
      homeStatusObject(
        config.left ?? config.sidebar
      );

    const rightConfig =
      homeStatusObject(
        config.right ?? config.hero
      );

    const bottomConfig =
      homeStatusObject(
        config.bottom ?? config.footer
      );

    const requestedBottomSpeed =
      Number(
        bottomConfig.speed ??
        bottomConfig.marquee_speed ??
        config.footer_speed
      );

    const phoneTickerConfig =
      homeStatusObject(
        config.phone_ticker
      );

    const requestedPhoneTickerSpeed =
      Number(
        phoneTickerConfig.speed ??
        config.phone_ticker_speed
      );

    const namespacedVisibility =
      homeStatusObject(
        config.home_status_visibility
      );

    const legacyVisibility =
      homeStatusObject(
        config.visibility
      );

    const visibility =
      Object.keys(namespacedVisibility).length
        ? namespacedVisibility
        : legacyVisibility;

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

    // Dark remains the compatibility default so upgrading an existing card
    // never changes its appearance merely because Home Assistant is light.
    // Users can explicitly choose Auto to follow HA's current appearance.
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
            // Existing cards used Bottom ticker speed for portrait as well.
            // Keep that behavior until a user explicitly chooses its new
            // independent portrait setting.
            : Number.isFinite(
                requestedBottomSpeed
              )
              ? Math.max(
                  1,
                  requestedBottomSpeed
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
          (
            visibility.left ??
            visibility.sidebar
          ) !== false,

        right:
          (
            visibility.right ??
            visibility.hero
          ) !== false,

        bottom:
          (
            visibility.bottom ??
            visibility.footer
          ) !== false,

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

    this.setAttribute(
      'data-profile',
      profile
    );

    this.setAttribute(
      'data-layout',
      this._config.layout
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

    // Home Assistant updates each entity separately. Refuse a mixed snapshot
    // and use the compatibility payload until every channel catches up.
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
      side_stream_available: Array.isArray(streams.side),
      left: resolveStream(streams.left),
      right: resolveStream(streams.right),
      bottom: resolveStream(streams.bottom),
      phone_primary: phonePrimary,
      active,
      recent,
      awareness,
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
    const source =
      this._state(
        this._config.entity
      );

    const attrs =
      source?.attributes || {};

    const display =
      attrs.display &&
      typeof attrs.display === 'object'
        ? attrs.display
        : {};

    const presentation =
      attrs.presentation &&
      typeof attrs.presentation === 'object'
        ? attrs.presentation
        : {};

    const native =
      attrs.native &&
      typeof attrs.native === 'object'
        ? attrs.native
        : null;

    const split = this._splitTransportData(
      attrs,
      source,
      display,
      presentation
    );

    if (split) {
      return split;
    }

    if (native) {
      const active = Array.isArray(native.current) ? native.current : [];
      const recent = Array.isArray(native.recent) ? native.recent : [];
      const awareness = Array.isArray(native.awareness) ? native.awareness : [];
      const streams = native.streams && typeof native.streams === 'object'
        ? native.streams
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
        (
          streams.phone_fallback &&
          typeof streams.phone_fallback === 'object'
            ? streams.phone_fallback
            : null
        );

      return {
        side:
          resolveStream(streams.side),

        side_stream_available:
          Array.isArray(streams.side),

        left:
          resolveStream(streams.left),

        right:
          resolveStream(streams.right),

        bottom:
          resolveStream(streams.bottom),

        phone_primary:
          phonePrimary,

        active,
        recent,
        awareness,

        priority:
          attrs.priority ||
          attrs.health ||
          'normal',

        count:
          Number(attrs.active_count) ||
          active.length,

        display,
        presentation,

        visual:
          attrs.visual &&
          typeof attrs.visual === 'object'
            ? attrs.visual
            : null,

        visual_queue:
          Array.isArray(attrs.visual_queue)
            ? attrs.visual_queue
            : [],

        visual_queue_active:
          attrs.visual_queue_active === true,

        weather_visual_effect:
          attrs.weather_visual_effect ||
          '',

        unavailable:
          !source ||
          [
            'unknown',
            'unavailable'
          ].includes(
            source.state
          )
      };
    }

    return {
      left: [],
      right: [],
      bottom: [],
      active: [],
      recent: [],
      awareness: [],
      phone_primary: null,
      priority: 'normal',
      count: 0,
      display,
      presentation,

      visual:
        attrs.visual &&
        typeof attrs.visual === 'object'
          ? attrs.visual
          : null,

      visual_queue:
        Array.isArray(attrs.visual_queue)
          ? attrs.visual_queue
          : [],

      visual_queue_active:
        attrs.visual_queue_active === true,

      weather_visual_effect:
        attrs.weather_visual_effect ||
        '',

      unavailable:
        !source ||
        [
          'unknown',
          'unavailable'
        ].includes(
          source.state
        )
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

    const url =
      typeof value.url === 'string'
        ? value.url.trim()
        : '';

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
        typeof value.article_url === 'string'
          ? value.article_url.trim()
          : '',

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
    const zones =
      this.shadowRoot.querySelector(
        '.ticker-zones'
      );

    if (!zones) return;

    const visual =
      this._visualFromData(value);

    let center =
      zones.querySelector(
        '[data-visual-center]'
      );

    zones.classList.toggle(
      'has-visual',
      Boolean(visual)
    );

    if (!visual) {
      this._destroyVisualHls(
        center
      );

      center?.remove();

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

      ticker_eligible:
        item.ticker_eligible === true,

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
    const hasSideStream = data?.side_stream_available === true;
    let normalCandidates = hasSideStream && Array.isArray(data.side)
      ? data.side.filter(item => this._sideLaneEligible(item))
      : [
          ...(Array.isArray(data.left) ? data.left : []),
          ...(Array.isArray(data.right) ? data.right : [])
        ].filter(item => this._sideLaneEligible(item));

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
      // Preserve the old lane movement semantics without restoring the old
      // one-carousel architecture. Normal candidates are still assigned across
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
      this._footerSignature
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
      this._headerClimateController
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
      this._headerClimateController
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
      const legacyRightInterval = zone === 'right'
        ? Number(data.display?.hero_rotation_seconds)
        : NaN;
      const configuredInterval = Number.isFinite(backendInterval) && backendInterval > 0
        ? backendInterval
        : Number.isFinite(legacyRightInterval) && legacyRightInterval > 0
          ? legacyRightInterval
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
    const legacy = Array.isArray(data?.[zone])
      ? data[zone].filter(item => this._sideLaneEligible(item))
      : [];

    if (legacy.length || data?.side_stream_available !== true) {
      return legacy;
    }

    // Compatibility fallback for a future backend that omits legacy lanes.
    // Preserve the historic alternating left/right distribution.
    const side = Array.isArray(data?.side)
      ? data.side.filter(item => this._sideLaneEligible(item))
      : [];
    const showLeft = this._config.home_status_visibility.left;
    const showRight = this._config.home_status_visibility.right;

    if (showLeft && !showRight) return side;
    if (showRight && !showLeft) return side;
    return zone === 'left' ? side.filter((_, index) => index % 2 === 0) : side.filter((_, index) => index % 2 === 1);
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
    // The slot scheduler/controllers are completely idle in legacy mode.
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
      const legacyRightInterval = zone === 'right' ? Number(data.display?.hero_rotation_seconds) : NaN;
      const configuredInterval = Number.isFinite(backendInterval) && backendInterval > 0
        ? backendInterval
        : Number.isFinite(legacyRightInterval) && legacyRightInterval > 0
          ? legacyRightInterval
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

    const legacyVisibility =
      homeStatusObject(
        this._config
          .visibility
      );

    const namespacedVisibility =
      homeStatusObject(
        this._config
          .home_status_visibility
      );

    if (
      Object.keys(
        legacyVisibility
      ).length &&
      !Object.keys(
        namespacedVisibility
      ).length
    ) {
      this._config
        .home_status_visibility =
        homeStatusClone(
          legacyVisibility
        );
    }

    if (
      this._config.visibility ===
      legacyVisibility
    ) {
      delete this._config.visibility;
    }

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
    const value =
      homeStatusGetPath(
        this._config,
        path,
        undefined
      );

    if (
      value !== undefined
    ) {
      return value;
    }

    const compatibilityPaths = {
      left:
        'sidebar',

      right:
        'hero',

      bottom:
        'footer',

      'home_status_visibility.left':
        'home_status_visibility.sidebar',

      'home_status_visibility.right':
        'home_status_visibility.hero',

      'home_status_visibility.bottom':
        'home_status_visibility.footer',

      'left.rotate':
        'sidebar.rotate',

      'left.interval':
        'sidebar.interval',

      'right.rotate':
        'hero.rotate',

      'right.interval':
        'hero.interval',

      'bottom.rotate':
        'footer.rotate',

      'bottom.speed':
        'footer.speed'
    };

    const legacyPath =
      compatibilityPaths[
        path
      ];

    if (legacyPath) {
      const legacyValue =
        homeStatusGetPath(
          this._config,
          legacyPath,
          undefined
        );

      if (
        legacyValue !==
        undefined
      ) {
        return legacyValue;
      }
    }

    if (
      path ===
      'right.interval'
    ) {
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
        ${this._number('phone_ticker.speed', 'Portrait phone ticker speed', this._value('bottom.speed', 35), 8, 120, 'Seconds per loop in portrait. Lower values move faster. This does not affect the tablet or landscape ticker.')}
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

/* Local appearance system. Dark is the compatibility baseline; light can be
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
