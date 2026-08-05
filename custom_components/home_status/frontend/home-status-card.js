const DoorHandler = {
  isActive(state) {
    return state.available &&
      new Set(['on', 'open', 'opening']).has(String(state.state || '').toLowerCase());
  },

  buildItem(state) {
    const current = String(state.state || '').toLowerCase();
    const suffix = current === 'opening' ? 'Opening' : 'Open';

    return {
      id: `direct:${state.entity}`,
      entity_id: state.entity,
      message: `${state.name} ${suffix}`,
      category: state.group,
      detail: `${state.name} is open`,
      priority: 'attention',
      icon: 'mdi:door-open',
      created_at: state.last_changed,
      active: true,
      persistent: false
    };
  }
};

const LeakHandler = {
  isActive(state) {
    return state.available &&
      new Set(['on', 'wet', 'moisture', 'detected']).has(String(state.state || '').toLowerCase());
  },

  buildItem(state) {
    return {
      id: `direct:${state.entity}`,
      entity_id: state.entity,
      message: `${state.name || 'Water'} Leak`,
      category: state.group,
      detail: 'Water detected',
      priority: 'critical',
      icon: 'mdi:water-alert',
      created_at: state.last_changed,
      active: true,
      persistent: false
    };
  }
};

const LaundryHandler = {
  isActive(state) {
    return state.available &&
      new Set(['on', 'complete', 'completed', 'finished', 'done'])
        .has(String(state.state || '').toLowerCase());
  },

  buildItem(state) {
    const name = String(state.name || 'Laundry');
    const lowerName = name.toLowerCase();
    const icon = lowerName.includes('washer')
      ? 'mdi:washing-machine'
      : lowerName.includes('dryer')
        ? 'mdi:tumble-dryer'
        : 'mdi:washing-machine';

    return {
      id: `direct:${state.entity}`,
      entity_id: state.entity,
      message: `${name} Complete`,
      category: 'laundry',
      detail: `${name} cycle is complete`,
      priority: 'activity',
      icon,
      created_at: state.last_changed,
      active: true,
      persistent: false
    };
  }
};

const ENTITY_HANDLERS = {
  doors: DoorHandler,
  leaks: LeakHandler,
  laundry: LaundryHandler
};

const BACKEND_PROVIDER_ALIASES = Object.freeze({
  calendar: 'schedule',
  sprinklers: 'schedule',
  fault: 'maintenance'
});

const FRONTEND_ASSET_BASE = '/home_status';
const LOTTIE_PLAYER_URL = `${FRONTEND_ASSET_BASE}/vendor/lottie_light_canvas.min.js`;
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
      Object.freeze({ src: `${FRONTEND_ASSET_BASE}/assets/weather/sunny-ambient.webm`, type: 'video/webm' }),
      Object.freeze({ src: `${FRONTEND_ASSET_BASE}/assets/weather/sunny-ambient.mp4`, type: 'video/mp4' })
    ])
  })
});
let lottiePlayerPromise = null;

function loadLottiePlayer() {
  if (window.lottie?.loadAnimation) return Promise.resolve(window.lottie);
  if (lottiePlayerPromise) return lottiePlayerPromise;
  lottiePlayerPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-home-status-lottie]');
    const script = existing || document.createElement('script');
    const loaded = () => {
      if (window.lottie?.loadAnimation) resolve(window.lottie);
      else reject(new Error('Local Lottie player loaded without an animation API'));
    };
    const failed = () => {
      script.remove();
      lottiePlayerPromise = null;
      reject(new Error('Unable to load the local Lottie player'));
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
    if (this._container === container && this._layer?.isConnected) return;
    this._layer?.remove();
    this._container = container;
    this._layer = document.createElement('span');
    this._layer.className = 'weather-renderer-layer weather-effect-none';
    this._layer.setAttribute('aria-hidden', 'true');
    container.prepend(this._layer);
    this.setEffect(this._effect);
    this.setVisible(this._visible);
  }

  setEffect(effect) {
    const nextEffect = String(effect || 'none').trim().toLowerCase() || 'none';
    if (this._layer) {
      const nextClass = `weather-effect-${nextEffect}`;
      if (!this._layer.classList.contains(nextClass)) {
        this._layer.classList.remove(`weather-effect-${this._effect}`);
        this._layer.classList.add(nextClass);
      }
    }
    this._effect = nextEffect;
  }

  setVisible(visible) {
    this._visible = visible !== false;
    this._layer?.classList.toggle('ambient-paused', !this._visible);
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
    if (this._container === container && (this._layer?.isConnected || this._fallback)) return;
    this._clearRenderedState();
    this._container = container;
    this._layer = document.createElement('span');
    this._layer.className = `weather-renderer-layer lottie-weather-layer ${this._asset.className} lottie-weather-${this._effect}`;
    this._layer.setAttribute('aria-hidden', 'true');
    container.prepend(this._layer);
    this.setVisible(this._visible);
    this._load();
  }

  setEffect() {}

  setVisible(visible) {
    this._visible = visible !== false;
    this._layer?.classList.toggle('ambient-paused', !this._visible);
    this._fallback?.setVisible(this._visible);
    if (!this._animation) return;
    if (this._visible) this._animation.play();
    else this._animation.pause();
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
      if (generation !== this._loadGeneration || !this._layer?.isConnected) return;
      const animation = lottie.loadAnimation({
        container: this._layer,
        renderer: 'canvas',
        loop: true,
        autoplay: this._visible,
        path: this._asset.url,
        rendererSettings: {
          clearCanvas: true,
          dpr: 1,
          preserveAspectRatio: this._asset.preserveAspectRatio || 'xMidYMid meet',
          progressiveLoad: true,
          runExpressions: false
        }
      });
      this._animation = animation;
      animation.setSubframe(false);
      animation.addEventListener('data_failed', () => {
        if (generation === this._loadGeneration) this._showCssFallback();
      });
      if (!this._visible) animation.pause();
    } catch (error) {
      if (generation === this._loadGeneration) this._showCssFallback(error);
    }
  }

  _showCssFallback(error) {
    if (!this._container || this._fallback) return;
    if (error) console.warn(`[HomeStatusCard] Local ${this._effect} asset unavailable; using CSS fallback.`, error);
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
    if (this._container === container && (this._video?.isConnected || this._fallback)) return;
    this._clearRenderedState();
    this._container = container;
    const video = document.createElement('video');
    video.className = `weather-renderer-layer video-weather-layer video-weather-${this._effect}`;
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
    this._video?.classList.toggle('ambient-paused', !this._visible);
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
    this._video.removeEventListener('error', this._handleError);
    this._video.pause();
    this._video.querySelectorAll('source').forEach(source => source.remove());
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
        Object.entries(LOTTIE_WEATHER_ASSETS).map(([effect, asset]) => [
          `lottie-${effect}`,
          () => new LottieWeatherRenderer(effect, asset)
        ])
      ),
      ...Object.fromEntries(
        Object.entries(VIDEO_WEATHER_ASSETS).map(([effect, asset]) => [
          `video-${effect}`,
          () => new VideoWeatherRenderer(effect, asset)
        ])
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
    this._ensureRenderer(this._rendererType || 'css');
    this._renderer.mount(container);
  }

  setEffect(effect, options = {}) {
    this._effect = String(effect || 'none').trim().toLowerCase() || 'none';
    const rendererType = options.renderer || (
      VIDEO_WEATHER_ASSETS[this._effect]
        ? `video-${this._effect}`
        : LOTTIE_WEATHER_ASSETS[this._effect]
          ? `lottie-${this._effect}`
          : 'css'
    );
    this._ensureRenderer(rendererType);
    if (this._container) this._renderer.mount(this._container);
    this._renderer.setEffect(this._effect, options);
    this._renderer.setVisible(this._visible);
  }

  setVisible(visible) {
    this._visible = visible !== false;
    this._renderer?.setVisible(this._visible);
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
    if (this._renderer && this._rendererType === rendererType) return;
    this._renderer?.destroy();
    const createRenderer = this._rendererFactories[rendererType];
    if (!createRenderer) throw new Error(`Unknown weather renderer: ${rendererType}`);
    this._renderer = createRenderer();
    this._rendererType = rendererType;
  }
}

const HOME_STATUS_CARD_PROFILES = {
  auto: {
    profile: 'auto',
    layout: 'responsive',
    utility_header: { enabled: true },
    hero: { rotate: true },
    sidebar: { rotate: true, interval: 7 },
    footer: { rotate: false, speed: 35 },
    home_status_visibility: { hero: true, sidebar: true, footer: true, phone_ticker: true },
    sizing: { max_width: 0, min_height: 0 }
  },
  phone: {
    profile: 'phone',
    layout: 'compact',
    utility_header: { enabled: false },
    hero: { rotate: false },
    sidebar: { rotate: false },
    footer: { rotate: false, speed: 26 },
    home_status_visibility: { hero: false, sidebar: false, footer: false, phone_ticker: true },
    sizing: { max_width: 0, min_height: 0 }
  },
  tablet: {
    profile: 'tablet',
    layout: 'tablet-default',
    utility_header: { enabled: true },
    hero: { rotate: true },
    sidebar: { rotate: true, interval: 7 },
    footer: { rotate: false, speed: 35 },
    home_status_visibility: { hero: true, sidebar: true, footer: true, phone_ticker: true },
    sizing: { max_width: 0, min_height: 0 }
  },
  desktop: {
    profile: 'desktop',
    layout: 'desktop-wide',
    utility_header: { enabled: true },
    hero: { rotate: true },
    sidebar: { rotate: true, interval: 7 },
    footer: { rotate: false, speed: 40 },
    home_status_visibility: { hero: true, sidebar: true, footer: true, phone_ticker: true },
    sizing: { max_width: 1800, min_height: 0 }
  }
};

const HOME_STATUS_KNOWN_TOP_LEVEL_KEYS = new Set([
  'type', 'entity', 'profile', 'layout', 'grid_options', 'card_size',
  'show_active_count', 'show_normal_items', 'pause_on_hover',
  'utility_header', 'quick_status', 'hero', 'sidebar', 'footer',
  'context_actions', 'display', 'visibility', 'home_status_visibility', 'sizing', 'animation',
  'weather_effect', 'time_entity', 'recent_ticker_limit',
  'recent_drawer_limit', 'rotation_seconds', 'footer_speed', 'entities', 'mode'
]);

function homeStatusClone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function homeStatusObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function homeStatusMerge(base, overlay) {
  const output = homeStatusClone(homeStatusObject(base));
  Object.entries(homeStatusObject(overlay)).forEach(([key, value]) => {
    output[key] = homeStatusObject(value) === value
      ? homeStatusMerge(output[key], value)
      : homeStatusClone(value);
  });
  return output;
}

function homeStatusGetPath(config, path, fallback = undefined) {
  const value = String(path).split('.').reduce(
    (current, key) => homeStatusObject(current)[key],
    config
  );
  return value === undefined ? fallback : value;
}

function homeStatusSetPath(config, path, value, removeEmpty = false) {
  const output = homeStatusClone(homeStatusObject(config));
  const keys = String(path).split('.');
  let target = output;
  keys.slice(0, -1).forEach(key => {
    target[key] = homeStatusObject(target[key]) === target[key]
      ? homeStatusClone(target[key])
      : {};
    target = target[key];
  });
  const finalKey = keys[keys.length - 1];
  if (removeEmpty && (value === '' || value === undefined || value === null)) {
    delete target[finalKey];
  } else {
    target[finalKey] = value;
  }
  return output;
}

function homeStatusApplyProfile(config, profile) {
  const preset = HOME_STATUS_CARD_PROFILES[profile] || HOME_STATUS_CARD_PROFILES.auto;
  return homeStatusMerge(config, preset);
}

class HomeStatusCard extends HTMLElement {
  constructor() {
    super();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._drawerOpen = false;
    this._lastTime = null;
    this._zoneTimers = {};
    this._zoneRenderTimers = {};
    this._zoneRenderGenerations = { left: 0, right: 0 };
    this._zoneIndexes = { left: 0, right: 0 };
    this._zoneIds = { left: null, right: null };
    this._zoneSignatures = { left: '', right: '' };
    this._footerSignature = '';
    this._footerSignatureParts = [];
    this._footerResizeObserver = null;
    this._visibilityObserver = null;
    this._ambientVisible = true;
    this._weatherRenderer = new WeatherRenderer();
    this._mediaEnabled = true;
    this._drawerSignature = '';
    this._drawerCloseTimer = null;
    this._rotationPaused = false;
    this._expandedEventIds = new Set();
    this._domReady = false;
    this._clockTimer = null;
  }

  setConfig(config) {
    if (!config || typeof config !== 'object') {
      throw new Error('Invalid Home Status card configuration');
    }
    const utilityHeader = config.utility_header && typeof config.utility_header === 'object'
      ? config.utility_header
      : {};
    const footerConfig = config.footer && typeof config.footer === 'object'
      ? config.footer
      : {};
    const requestedFooterSpeed = Number(
      footerConfig.speed ?? footerConfig.marquee_speed ?? config.footer_speed
    );
    const namespacedVisibility = homeStatusObject(config.home_status_visibility);
    const legacyVisibility = homeStatusObject(config.visibility);
    const visibility = Object.keys(namespacedVisibility).length
      ? namespacedVisibility
      : legacyVisibility;
    const sizing = homeStatusObject(config.sizing);
    const animation = homeStatusObject(config.animation);
    const profile = ['auto', 'phone', 'tablet', 'desktop'].includes(config.profile)
      ? config.profile
      : 'auto';
    this._rawConfig = homeStatusClone(config);
    this._config = {
      ...homeStatusClone(config),
      entity: config.entity || 'sensor.home_status',
      context_actions: config.context_actions || {},
      layout: config.layout || 'tablet-default',
      profile,
      hero: config.hero || null,
      sidebar: config.sidebar || null,
      footer: config.footer || null,
      footer_speed: Number.isFinite(requestedFooterSpeed)
        ? Math.max(12, Math.min(80, requestedFooterSpeed))
        : 35,
      display: config.display || {},
      utility_header: {
        enabled: utilityHeader.enabled !== false,
        security_entity: utilityHeader.security_entity || '',
        security_path: utilityHeader.security_path || '',
        music_entity: utilityHeader.music_entity || '',
        music_path: utilityHeader.music_path || ''
      },
      home_status_visibility: {
        hero: visibility.hero !== false,
        sidebar: visibility.sidebar !== false,
        footer: visibility.footer !== false,
        phone_ticker: visibility.phone_ticker !== false,
        drawer: visibility.drawer !== false
      },
      sizing: {
        max_width: Number.isFinite(Number(sizing.max_width)) ? Math.max(0, Number(sizing.max_width)) : 0,
        min_height: Number.isFinite(Number(sizing.min_height)) ? Math.max(0, Number(sizing.min_height)) : 0
      },
      animation: {
        level: ['full', 'reduced', 'none'].includes(animation.level) ? animation.level : 'full'
      },
      weather_effect: String(config.weather_effect || 'auto').toLowerCase(),
      show_normal_items: config.show_normal_items === true,
      pause_on_hover: config.pause_on_hover !== false,
      time_entity: config.time_entity || '',
      recent_ticker_limit: Number.isFinite(Number(config.recent_ticker_limit)) ? Number(config.recent_ticker_limit) : 6,
      recent_drawer_limit: Number.isFinite(Number(config.recent_drawer_limit)) ? Number(config.recent_drawer_limit) : 10,
      rotation_seconds: Number.isFinite(Number(config.rotation_seconds)) ? Number(config.rotation_seconds) : 4
    };
    this._quickStatusEntities = Array.isArray(config.quick_status?.entities)
      ? config.quick_status.entities
          .map(item => typeof item === 'string' ? { entity: item } : item)
          .filter(item => item?.entity)
          .map(item => ({ ...item, group: item.group || 'status' }))
      : [];
    this._directEntities = this._normalizeDirectEntities(config.entities);
    this._mode = config.mode === 'direct' ? 'direct' : 'provider';
    this.setAttribute('data-profile', profile);
    this.setAttribute('data-layout', this._config.layout);
    this.setAttribute('data-animation', this._config.animation.level);
    this.style.maxWidth = this._config.sizing.max_width
      ? `${this._config.sizing.max_width}px`
      : profile === 'phone' ? '600px' : '';
    this.style.minHeight = this._config.sizing.min_height ? `${this._config.sizing.min_height}px` : '';
    this.style.setProperty(
      '--home-status-phone-ticker-seconds',
      `${Math.max(8, Math.min(120, this._config.footer_speed))}s`
    );
    this._stopZoneRotations();
    this._zoneSignatures = { left: '', right: '' };
    this._footerSignature = '';
    this._footerSignatureParts = [];
    this._drawerSignature = '';
    this._updateCard();
  }

  set hass(hass) {
    this._hass = hass;
    const time = hass?.states?.[this._config?.time_entity]?.state;
    if (time !== this._lastTime) this._lastTime = time;
    try {
      this._updateCard();
    } catch (error) {
      console.error('[HomeStatusCard] update failed', error);
      throw error;
    }
  }

  get hass() { return this._hass; }

  disconnectedCallback() {
    this._stopZoneRotations();
    if (this._clockTimer) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
    if (this._footerResizeObserver) {
      this._footerResizeObserver.disconnect();
      this._footerResizeObserver = null;
    }
    this._visibilityObserver?.disconnect();
    this._visibilityObserver = null;
    this._weatherRenderer.destroy();
    if (this._drawerCloseTimer) {
      clearTimeout(this._drawerCloseTimer);
      this._drawerCloseTimer = null;
    }
    Object.values(this._zoneRenderTimers).forEach(timer => clearTimeout(timer));
    this._zoneRenderTimers = {};
    this._zoneRenderGenerations = { left: 0, right: 0 };
  }

  _state(entity) { return this._hass?.states?.[entity]; }

  _buildQuickStatusSignature(hass) {
    return this._quickStatusEntities.map(config => {
      const state = hass?.states?.[config.entity];
      return [config.entity, state?.state ?? 'missing', state?.attributes?.friendly_name ?? ''].join('|');
    }).join('||');
  }

  _isQuickStatusActive(item, state) {
    if (!state || ['unknown', 'unavailable'].includes(String(state.state).toLowerCase())) return false;
    const value = String(state.state).toLowerCase();
    if (item.entity.startsWith('alarm_control_panel.')) {
      return ['armed_home', 'armed_away', 'armed_night', 'arming', 'pending', 'triggered'].includes(value);
    }
    return ['on', 'open', 'opening', 'triggered', 'wet', 'moisture', 'detected', 'unlocked'].includes(value);
  }

  _updateQuickStatus(previousHass, hass) {
    const signature = this._buildQuickStatusSignature(hass);
    if (signature === this._quickStatusSignature) return;
    this._quickStatusSignature = signature;
    const lane = this.shadowRoot.querySelector('.live-state-host');
    if (!lane) return;
    const ticker = this.shadowRoot.querySelector('.ticker');
    const markup = this._liveStateMarkup();
    ticker?.classList.toggle('has-live-state', Boolean(markup));
    if (!markup) {
      lane.classList.remove('active');
    } else {
      const wasActive = lane.classList.contains('active');
      if (!wasActive) lane.classList.remove('active');
      lane.innerHTML = markup;
      if (wasActive) {
        this._bindEventsOnly();
        return;
      }
      const panel = lane.querySelector('.live-state-banner');
      if (panel) void panel.offsetHeight;
      requestAnimationFrame(() => {
        if (this._buildQuickStatusSignature(this._hass) === this._quickStatusSignature) {
          lane.classList.add('active');
        }
      });
    }
    this._bindEventsOnly();
  }

  _plainEntityName(entity, value) {
    let raw = String(value || String(entity || '').split('.').pop() || 'Home item')
      .replace(/[_-]+/g, ' ')
      .replace(/^(?:alarm|alarmo|security)\s+(?:(?:door|window|contact|lock|leak|water|moisture|smoke|carbon monoxide|co)\s+)?sensors?\s+/i, '')
      .replace(/\s+(?:binary\s+)?sensor$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const contactContext = `${String(entity || '').replace(/[_.-]+/g, ' ')} ${raw}`;
    if (/\b(?:doors?|windows?|locks?|contacts?|openings?|garage)\b/i.test(contactContext)) {
      raw = raw.replace(/^(?:alarm|alarmo|security)\s+/i, '');
    }
    if (!raw) raw = 'Home item';
    const acronyms = { co: 'CO', hvac: 'HVAC', nws: 'NWS' };
    const minorWords = new Set(['and', 'of', 'the', 'in', 'at']);
    return raw.split(' ').map((word, index) => {
      const lower = word.toLowerCase();
      return acronyms[lower] || (index && minorWords.has(lower) ? lower : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`);
    }).join(' ');
  }

  _normalizeDirectEntities(groups) {
    if (groups === undefined || groups === null) return [];
    if (typeof groups !== 'object' || Array.isArray(groups)) {
      console.warn('[HomeStatusCard] entities must be grouped arrays');
      return [];
    }

    const normalized = [];

    Object.entries(groups).forEach(([group, entries]) => {
      if (!Array.isArray(entries)) {
        console.warn(`[HomeStatusCard] entities.${group} must be an array; skipped`);
        return;
      }

      entries.forEach((entry, index) => {
        const entity = typeof entry === 'string'
          ? entry.trim()
          : entry && typeof entry === 'object' && typeof entry.entity === 'string'
            ? entry.entity.trim()
            : '';

        if (!entity) {
          console.warn(`[HomeStatusCard] invalid entities.${group}[${index}]; skipped`);
          return;
        }

        const name = this._plainEntityName(
          entity,
          typeof entry === 'object' && entry.name ? entry.name : ''
        );

        normalized.push({ entity, name, group });
      });
    });

    return normalized;
  }

  _updateDirectState() {
    this._directState = this._directEntities.map(item => {
      const state = this._hass?.states?.[item.entity];
      const available = Boolean(
        state &&
        !['unknown', 'unavailable'].includes(state.state)
      );

      return {
        entity: item.entity,
        group: item.group,
        name: item.name,
        state: state?.state || 'unknown',
        last_changed: state?.last_changed || null,
        attributes: state?.attributes || {},
        available
      };
    });
    const nextActiveItems = this._buildDirectActiveItems();

    if (this._mode === 'direct' && this._directHistoryInitialized) {
      const currentByEntity = new Map(
        this._directState.map(state => [state.entity, state])
      );
      const activeIds = new Set(nextActiveItems.map(item => item.id));

      for (const previous of this._previousDirectActiveItems) {
        if (activeIds.has(previous.id)) continue;

        const current = currentByEntity.get(previous.entity_id);
        if (!current || !current.available) continue;

        const resolved = {
          ...previous,
          active: false,
          resolved_at: new Date().toISOString()
        };

        const duplicate = this._directRecentItems.some(item =>
          item.id === resolved.id &&
          item.created_at === resolved.created_at
        );

        if (!duplicate) this._directRecentItems.unshift(resolved);
      }

      const retention = Math.max(
        Number(this._config.recent_drawer_limit) || 10,
        Number(this._config.recent_ticker_limit) || 6
      );
      this._directRecentItems = this._directRecentItems.slice(0, retention);
    }

    this._directActiveItems = nextActiveItems;
    this._previousDirectActiveItems = nextActiveItems.map(item => ({ ...item }));
    this._directHistoryInitialized = true;
  }

  _buildDirectActiveItems() {
    if (this._mode !== 'direct') return [];

    const activeItems = [];

    for (const state of this._directState) {
      const handler = ENTITY_HANDLERS[state.group];

      if (!handler) {
        if (!this._warnedUnsupportedGroups.has(state.group)) {
          console.warn(`[HomeStatusCard] unsupported direct entity group: ${state.group}`);
          this._warnedUnsupportedGroups.add(state.group);
        }
        continue;
      }

      if (handler.isActive(state)) activeItems.push(handler.buildItem(state));
    }

    return activeItems;
  }

  _updateCard() {
    if (!this._config || !this._hass) return;
    if (this.shadowRoot.querySelector('.ticker')) this._update();
    else this.render();
  }

  _date(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  _time(value) {
    const date = this._date(value);
    if (!date) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  _relative(value) {
    const date = this._date(value);
    if (!date) return '';
    const now = new Date();
    const minutes = Math.max(0, Math.floor((now - date) / 60000));
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'}${rest ? ` ${rest} min` : ''} ago`;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const delta = Math.round((today - day) / 86400000);
    if (delta === 1) return `Yesterday ${this._time(date)}`;
    if (delta >= 0 && delta < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${this._time(date)}`;
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} • ${this._time(date)}`;
  }

  _unique(items) {
    const seen = new Set();
    return (Array.isArray(items) ? items : []).filter((item, index) => {
      const key = item?.id || `${item?.event_type || 'event'}|${item?.message || ''}|${item?.created_at || index}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _collapseRecentSequences(items) {
    const events = Array.isArray(items) ? items : [];
    const collapsed = [];
    let index = 0;

    const normalizeSource = value => String(value || '')
      .toLowerCase()
      .trim()
      .replace(/^[^.]+\./, '')
      .replace(/(?:^|[_\s-])(opened|closed|opening|closing|open|close)$/i, '')
      .replace(/[_\s-]+/g, '_');

    const sourceOf = item => normalizeSource(
      item?.entity_id ||
      item?.entity ||
      item?.device ||
      item?.event_type ||
      item?.message ||
      ''
    );

    const timestampOf = item => this._date(
      item?.resolved_at ||
      item?.created_at ||
      item?.timestamp
    )?.getTime() || null;

    while (index < events.length) {
      const source = sourceOf(events[index]);
      const run = [events[index]];
      index += 1;

      while (index < events.length && sourceOf(events[index]) === source) {
        run.push(events[index]);
        index += 1;
      }

      collapsed.push(run.reduce((newest, item) => {
        const newestTime = timestampOf(newest);
        const itemTime = timestampOf(item);
        return itemTime !== null && (newestTime === null || itemTime > newestTime)
          ? item
          : newest;
      }));
    }

    return collapsed;
  }

  _data() {
    const source = this._state(this._config.entity);
    const attrs = source?.attributes || {};
    const hero = Array.isArray(attrs.hero) ? attrs.hero : [];
    const active = Array.isArray(attrs.active) ? attrs.active : [];
    const recent = Array.isArray(attrs.recent) ? attrs.recent : [];
    const priority = attrs.priority || attrs.health || 'normal';
    const count = Number(attrs.active_count || 0);
    const display = attrs.display && typeof attrs.display === 'object' ? attrs.display : {};
    return { hero, sidebar: Array.isArray(attrs.sidebar) ? attrs.sidebar : [], footer: Array.isArray(attrs.footer) ? attrs.footer : [], active, recent, priority, count, display, weather_visual_effect: attrs.weather_visual_effect || '', unavailable: !source || ['unknown', 'unavailable'].includes(source.state) };
  }

  _getRuntimeData() {
    const data = this._data();
    return data;

    const active = this._directActiveItems;
    const priority = active.some(item => item.priority === 'critical')
      ? 'critical'
      : active.some(item => item.priority === 'attention')
        ? 'attention'
        : active.some(item => item.priority === 'activity')
          ? 'activity'
          : 'normal';

    return {
      active,
      ticker: active,
      recent: this._directRecentItems,
      current: active,
      upcoming: [],
      insights: this._directRecentItems,
      status: [],
      hero: [],
      sidebar: [],
      footer: [],
      count: active.length,
      priority,
      unavailable: false
    };
  }


  _label(item) {
    const customLabel = String(item?.display_name || '').trim();
    if (customLabel) return customLabel;
    const labels = {
      'Dryer Finished': 'Dryer Complete',
      'Washer Finished': 'Washer Complete',
      'Dishwasher Finished': 'Dishes Clean',
      'Dishwasher Complete': 'Dishes Clean',
      'Everything Looks Good': 'Home Normal'
    };
    const value = item?.message || item?.title || 'Home notification';
    return labels[value] || this._humanizeStatusText(value);
  }

  _humanizeStatusText(value) {
    return String(value || '')
      .replace(
        /^(?:alarm|alarmo|security)\s+(?:(?:door|window|contact|lock|leak|water|moisture|smoke|carbon monoxide|co)\s+)?sensors?\s+/i,
        ''
      )
      .replace(/\b(dishwasher|washer|dryer)\s+current\s+status\s+/i, '$1 ')
      .replace(/\s+/g, ' ')
      .trim() || 'Home notification';
  }

  _isNormalSecurityItem(item) {
    const provider = this._providerFor(item);
    const category = String(item?.category || '').toLowerCase();
    if (provider !== 'security' && !['security', 'contact'].includes(category)) return false;
    const entity = String(item?.entity_id || '').toLowerCase();
    const text = `${item?.title || ''} ${item?.message || ''} ${item?.state || ''}`.toLowerCase();
    if (
      entity
      && entity === String(this._config.utility_header.security_entity || '').toLowerCase()
      && /\b(?:disarmed|alarm off)\b/.test(text)
    ) {
      // The persistent Security header is authoritative for the disarmed
      // state, regardless of show_normal_items.
      return true;
    }
    if (category === 'contact' && /\b(closed|clear)\b/i.test(text)) return true;
    if (this._config.show_normal_items) return false;
    return String(item?.priority || 'normal').toLowerCase() === 'normal'
      || /\b(closed|clear|disarmed|alarm off|all monitored doors closed)\b/i.test(text);
  }

  _escape(value) {
    const node = document.createElement('span');
    node.textContent = String(value ?? '');
    return node.innerHTML;
  }

  _icon(priority) {
    return ({ critical: 'mdi:alert-circle', attention: 'mdi:alert', activity: 'mdi:information', normal: 'mdi:check-circle' })[priority] || 'mdi:home-heart';
  }

  _color(category) {
    return ({ security: '#ef5350', weather: '#42a5f5', hvac: '#ff9800', appliance: '#66bb6a', laundry: '#66bb6a', media: '#ab47bc', irrigation: '#26c6da' })[String(category || '').toLowerCase()] || '#90a4ae';
  }

  _iconTone(item) {
    const provider = this._providerFor(item);
    const priority = String(item?.priority || '').toLowerCase();
    const text = String(item?.title || item?.message || item?.summary || '').toLowerCase();
    if (priority === 'critical' || /alarm|leak|smoke|security|severe weather/.test(text)) return 'critical';
    if (priority === 'attention' || /warning|advisory|traffic delay|package/.test(text)) return 'attention';
    if (provider === 'media' || /music|tv|entertainment/.test(text)) return 'media';
    if (priority === 'activity' || /complete|completed|finished|resolved|healthy|normal/.test(text)) return 'success';
    if (['weather', 'schedule', 'climate', 'energy', 'maintenance'].includes(provider)) return 'information';
    return 'neutral';
  }

  _iconSemanticClass(item) {
    const provider = this._providerFor(item);
    const text = String(item?.title || item?.message || item?.summary || '').toLowerCase();
    const priority = String(item?.priority || '').toLowerCase();
    const state = String(item?.state || '').toLowerCase();
    const resolved = state === 'resolved'
      || (item?.active === false && Boolean(item?.resolved_at));
    // Resolution is a successful transition regardless of the provider that
    // raised the original alert. Evaluate it before security keywords so a
    // closed door or cleared smoke alarm cannot retain its alert color.
    if (resolved) return 'semantic-green';
    if (priority === 'critical' || /active leak|smoke|alarm|security|severe/.test(text)) return 'semantic-red';
    if (priority === 'attention' || /warning|advisory|delay|requires action/.test(text)) return 'semantic-orange';
    if (/complete|completed|finished|resolved|healthy/.test(text)) return 'semantic-green';
    if (provider === 'security' || /\b(?:door|lock|alarm)\b/.test(text)) return 'semantic-red';
    if (/leak|water|moisture/.test(text)) return 'semantic-cyan';
    if (provider === 'weather') return 'semantic-sky';
    if (/waste|garbage|recycl/.test(text)) return 'semantic-green';
    if (/sprinkler|irrigation|watering/.test(text)) return 'semantic-teal';
    if (/calendar|schedule|event/.test(text)) return 'semantic-purple';
    if (/package|delivery/.test(text)) return 'semantic-orange';
    if (/traffic|road/.test(text)) return 'semantic-amber';
    if (provider === 'energy' || /energy|power/.test(text)) return 'semantic-yellow';
    if (/climate|temperature|thermostat/.test(text)) return 'semantic-blue';
    if (provider === 'laundry' || /laundry|washer|dryer/.test(text)) return 'semantic-lime';
    if (/music|media|tv|entertainment/.test(text)) return 'semantic-purple';
    return 'semantic-white';
  }

  _timestamp(item, active) {
    return this._date(active ? (item?.created_at || item?.timestamp) : (item?.resolved_at || item?.created_at || item?.timestamp));
  }

  _streamAsTicker(item, fallback = 'No new information') {
    if (!item) return { id: `empty:${fallback}`, message: fallback, secondary: 'Tap for its actions', detail: '', priority: 'normal', category: 'Home Status' };
    let title = (item.title || item.message || 'Home Status').replace(/Alarmo/gi, 'Home Security');
    title = title.replace(/^(?:alarm|security)\s+(?:(?:door|window|contact|lock|leak|water|moisture|smoke|carbon monoxide|co)\s+)?sensors?\s+/i, '');
    if (/door/i.test(title)) {
      title = title.replace(/\s+Active$/i, ' Open');
    }
    if (/sprinklers rain delay active/i.test(title)) title = 'Rain Delay Active';
    let summary = this._humanizeStatusText(item.body || item.summary || item.detail || item.secondary || 'Tap for its actions');
    if (item.expires_at) summary = `${summary} • Until ${this._formatDateTime(item.expires_at)}`;
    return {
      id: item.id,
      message: title,
      subtitle: item.subtitle || '',
      body: item.body || summary,
      secondary: summary,
      detail: '',
      priority: item.priority || 'normal',
      category: item.category || 'Home Status',
      provider: item.provider,
      source: item.source,
      _provider: item._provider,
      entity_id: item.entity_id,
      created_at: item.created_at,
      resolved_at: item.resolved_at,
      timestamp: item.timestamp,
      navigation: item.action || item.navigation,
      icon: item.icon,
      media_url: item.media_url || item.media?.url || item.image_url || '',
      media_type: item.media_type || item.media?.type || (item.image_url ? 'image' : ''),
      visual_effect: item.visual_effect || '',
    };
  }

  _heroMedia(item) {
    if (!this._mediaEnabled) return null;
    const url = String(item?.media_url || item?.media?.url || item?.image_url || '').trim();
    const type = String(item?.media_type || item?.media?.type || (url ? 'image' : '')).toLowerCase();
    return url && (!type || type.startsWith('image')) ? { url, type: 'image' } : null;
  }

  _formatDateTime(value) {
    const date = this._date(value);
    return date ? date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : String(value || '');
  }

  _zoneItems(data) {
    // sensor.home_status remains authoritative for which items are available.
    // The card chooses presentation slots so verbose or urgent content is not
    // trapped in the narrower right-hand panel by its provider category.
    const sidebar = (this._config.home_status_visibility.sidebar && Array.isArray(data.sidebar) ? data.sidebar : [])
      .filter(item => !this._isNormalSecurityItem(item));
    const hero = (this._config.home_status_visibility.hero && Array.isArray(data.hero) ? data.hero : [])
      .filter(item => !this._isNormalSecurityItem(item));
    const seen = new Set();
    const items = [...sidebar, ...hero].filter(item => {
      const key = item?.id || item?.entity_id || `${this._label(item)}|${item?.summary || item?.secondary || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (items.length < 2) return { left: items, right: [] };

    const ranked = items
      .map((item, index) => ({ item, index, score: this._wideSlotScore(item) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const left = ranked.filter(entry => entry.score >= 90).map(entry => entry.item);
    const right = ranked.filter(entry => entry.score < 90).map(entry => entry.item);

    // Preserve the familiar two-panel balance when all content is compact.
    if (!left.length) {
      const preferred = sidebar[0] || ranked[0].item;
      left.push(preferred);
      const preferredKey = preferred?.id || preferred?.entity_id || preferred;
      const rightIndex = right.findIndex(item => (item?.id || item?.entity_id || item) === preferredKey);
      if (rightIndex >= 0) right.splice(rightIndex, 1);
    }
    // If everything qualifies for the wide slot, keep the shortest routine
    // item as supporting context unless every item is attention-worthy.
    if (!right.length && left.length > 1) {
      const candidate = [...left]
        .reverse()
        .find(item => !['critical', 'attention'].includes(String(item?.priority || 'normal').toLowerCase()));
      if (candidate) {
        left.splice(left.indexOf(candidate), 1);
        right.push(candidate);
      }
    }
    return { left, right };
  }

  _wideSlotScore(item) {
    const priority = String(item?.priority || 'normal').toLowerCase();
    const priorityScore = { critical: 1000, attention: 700, activity: 120, normal: 0 }[priority] || 0;
    const title = this._label(item);
    const summary = String(item?.summary || item?.secondary || item?.detail || '');
    const textScore = Math.min(180, title.length + summary.length);
    const mediaScore = this._heroMedia(item) ? 120 : 0;
    return priorityScore + textScore + mediaScore;
  }

  _buildFooterStream(data) {
    if (!this._config.home_status_visibility.footer) return [];
    const authoritativeFooter = Array.isArray(data.footer) ? data.footer : [];
    const items = authoritativeFooter
      .filter(item => !this._isRoutineFooterStatus(item))
      .filter(item => item?.source === 'direct_history' || !this._isNormalSecurityItem(item))
      .map(item => ({ ...this._streamAsTicker(item, 'Status update'), _provider: this._providerFor(item) }));
    return this._groupFooterContactClosures(items);
  }

  _phonePriorityRank(item) {
    return {
      critical: 0,
      attention: 1,
      activity: 2,
      normal: 3
    }[String(item?.priority || 'normal').toLowerCase()] ?? 3;
  }

  _phoneStatusItem(data) {
    const active = (Array.isArray(data?.active) ? data.active : [])
      .filter(item => item?.active !== false)
      .map((item, index) => ({ item, index }))
      .sort((left, right) =>
        this._phonePriorityRank(left.item) - this._phonePriorityRank(right.item)
        || left.index - right.index
      );
    if (active.length) return active[0].item;
    return {
      id: 'phone-home-normal',
      message: 'Home Normal',
      summary: 'No active alerts',
      icon: 'mdi:check-circle-outline',
      priority: 'normal',
      active: false
    };
  }

  _phoneStatusMarkup(data) {
    const item = this._phoneStatusItem(data);
    const title = this._label(item);
    const summary = item.summary || item.secondary || item.detail || 'Tap for details';
    const navigation = String(item.navigation || item.action || '');
    const entity = String(item.entity_id || item.entity || '');
    const footerItems = this._buildFooterStream(data).slice(0, 6);
    const phoneTickerItems = footerItems.length ? footerItems : [{
      id: 'phone-no-updates',
      message: 'No recent updates',
      summary: 'Home is quiet',
      icon: 'mdi:home-heart'
    }];
    const tickerText = phoneTickerItems.map(footerItem => this._label(footerItem)).filter(Boolean).join(' • ');
    const renderPhoneTickerSequence = () => phoneTickerItems.map(footerItem => {
      const display = this._formatFooterItem(footerItem);
      const relative = display.relativeStamp ? this._relative(display.relativeStamp) : '';
      const secondary = display.summary || relative
        ? `<small>${display.summary ? this._escape(display.summary) : ''}${display.summary && relative ? ' • ' : ''}${relative ? this._escape(relative) : ''}</small>`
        : '';
      return `<span class="phone-status-ticker-item" data-stream-id="${this._escape(footerItem.id || '')}" data-stream-navigation="${this._escape(footerItem.navigation || '')}" data-stream-entity="${this._escape(footerItem.entity_id || '')}"><ha-icon class="${this._iconSemanticClass(footerItem)}" icon="${this._escape(display.icon)}"></ha-icon><span class="phone-status-ticker-copy"><strong>${this._escape(display.title)}</strong>${secondary}</span></span>`;
    }).join('');
    const phoneTickerSequence = renderPhoneTickerSequence();
    const actionable = navigation || entity;
    return `<section class="phone-status-shell" aria-label="Current home status">
      <button class="phone-status-current priority-${this._escape(item.priority || 'normal')}${actionable ? ' is-actionable' : ''}" type="button" data-stream-navigation="${this._escape(navigation)}" data-stream-entity="${this._escape(entity)}"${actionable ? '' : ' disabled'}>
        <span class="phone-status-icon"><ha-icon icon="${this._escape(item.icon || 'mdi:home-heart')}"></ha-icon></span>
        <span class="phone-status-copy"><small>Home Status</small><strong>${this._escape(title)}</strong><span>${this._escape(summary)}</span></span>
        ${actionable ? '<ha-icon class="phone-status-chevron" icon="mdi:chevron-right"></ha-icon>' : ''}
      </button>
      ${this._config.home_status_visibility.phone_ticker ? `<div class="phone-status-ticker" aria-label="${this._escape(tickerText)}">
        <div class="phone-status-ticker-track"><div class="phone-status-ticker-sequence">${phoneTickerSequence}</div><div class="phone-status-ticker-sequence" aria-hidden="true">${phoneTickerSequence}</div></div>
      </div>` : ''}
    </section>`;
  }

  _renderPhoneStatus(data) {
    const host = this.shadowRoot?.querySelector('[data-phone-status-host]');
    if (!host) return;
    const markup = this._phoneStatusMarkup(data);
    if (host.dataset.signature === markup) return;
    host.dataset.signature = markup;
    host.innerHTML = markup;
    this._bindStreamItems();
  }

  _isRoutineFooterStatus(item) {
    if (item?.source !== 'status') return false;
    const entity = String(item.entity_id || '').toLowerCase();
    const text = `${item.title || ''} ${item.message || ''} ${item.summary || ''} ${item.state || ''}`.toLowerCase();
    if (entity && entity === String(this._config.utility_header.security_entity || '').toLowerCase()) {
      return /\b(?:alarm off|disarmed)\b/.test(text);
    }
    return false;
  }

  _groupFooterContactClosures(items) {
    const result = [];
    const consumed = new Set();
    const stampOf = item => this._date(item.resolved_at || item.created_at || item.timestamp)?.getTime() || 0;
    const contactSearchText = item =>
      `${String(item.entity_id || '').replace(/[_.-]+/g, ' ')} ${item.title || ''} ${item.message || ''}`.toLowerCase();
    const isClosure = item => {
      const text = contactSearchText(item);
      return item.source === 'direct_history'
        && item._provider === 'security'
        && /\bclosed\b/.test(text)
        && /\b(?:doors?|windows?|openings?|garage)\b/.test(text);
    };
    const contactName = item => {
      const raw = String(item.title || item.message || item.entity_id || '')
        .replace(/\s+(?:is\s+)?closed$/i, '')
        .replace(/\s+closed\b.*$/i, '');
      return this._plainEntityName(item.entity_id, raw);
    };
    items.forEach((item, index) => {
      if (consumed.has(index) || !isClosure(item)) {
        if (!consumed.has(index)) result.push(item);
        return;
      }
      const stamp = stampOf(item);
      const grouped = items
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) =>
          !consumed.has(candidateIndex)
          && isClosure(candidate)
          && Math.abs(stampOf(candidate) - stamp) <= 120000
        );
      if (grouped.length < 2) {
        result.push(item);
        return;
      }
      grouped.forEach(({ candidateIndex }) => consumed.add(candidateIndex));
      const labels = grouped.map(({ candidate }) => contactName(candidate));
      const windows = grouped.filter(({ candidate }) =>
        /\bwindow/i.test(contactSearchText(candidate))
      ).length;
      const doors = grouped.length - windows;
      const title = windows === grouped.length
        ? `${grouped.length} Windows Closed`
        : doors === grouped.length
          ? `${grouped.length} Doors Closed`
          : `${grouped.length} Doors and Windows Closed`;
      const newest = grouped.reduce((latest, entry) =>
        stampOf(entry.candidate) > stampOf(latest.candidate) ? entry : latest
      );
      result.push({
        ...newest.candidate,
        id: `grouped-contact-closures:${grouped.map(({ candidate }) => candidate.entity_id || candidate.id).sort().join('|')}:${Math.floor(stamp / 120000)}`,
        title,
        message: title,
        summary: '',
        icon: windows === grouped.length ? 'mdi:window-closed-variant' : 'mdi:door-closed',
        entity_id: '',
        navigation: '',
        grouped_contact_labels: labels
      });
    });
    const groups = result.filter(item =>
      Array.isArray(item.grouped_contact_labels)
      && item.grouped_contact_labels.length > 1
    );
    if (!groups.length) return result;
    const isAnyContactClosure = item => {
      const text = contactSearchText(item);
      return /\bclosed\b/.test(text)
        && /\b(?:doors?|windows?|openings?|garage)\b/.test(text);
    };
    return result.filter(item => {
      if (Array.isArray(item.grouped_contact_labels) || !isAnyContactClosure(item)) return true;
      const stamp = stampOf(item);
      const name = contactName(item).toLowerCase();
      return !groups.some(group => {
        if (Math.abs(stampOf(group) - stamp) > 120000) return false;
        return group.grouped_contact_labels.some(label =>
          String(label || '').toLowerCase() === name
        );
      });
    });
  }

  _formatFooterItem(item) {
    const provider = item._provider || this._providerFor(item);
    const id = String(item.id || '');
    let title = this._label(item);
    let summary = this._humanizeStatusText(item.summary || item.secondary || '');
    let icon = item.icon || 'mdi:information-outline';
    const currentWeather = provider === 'weather' && id.startsWith('current:weather:');
    const indoorTemperature = provider === 'climate'
      && (id.startsWith('current:climate:') || /^Indoor Temperature$/i.test(title));
    if (currentWeather) {
      const weatherSummary = String(summary).replace(/\s*(?:\u2022|\u00e2\u20ac\u00a2)\s*\d+\s*(?:min|hr|day)s?\s+ago\s*$/i, '');
      const parts = weatherSummary.split(/\s*(?:\u2022|\u00e2\u20ac\u00a2|\|)\s*/, 2);
      title = parts[0] || title;
      summary = this._friendlyWeatherCondition(parts[1] || item.state || '');
      icon = 'mdi:thermometer';
    } else if (indoorTemperature) {
      title = this._glanceableTemperature(summary);
      summary = 'Indoors';
      icon = item.icon || 'mdi:home-thermometer-outline';
    }
    const relativeStamp = !currentWeather && !indoorTemperature
      ? item.resolved_at || item.created_at || item.timestamp || ''
      : '';
    if (provider === 'weather' && (id.startsWith('upcoming:weather:') || /weather-alert/i.test(icon))) {
      title = String(title).replace(/^NT WEATHER\s*/i, '').replace(/\s+/g, ' ').trim();
      summary = item.expires_at ? `Until ${this._formatDateTime(item.expires_at)}` : '';
      icon = 'mdi:weather-alert';
    } else if (provider === 'security') {
      icon = item.icon || 'mdi:shield-check';
      const contactText = `${item.entity_id || ''} ${title}`;
      if (
        item.source === 'direct_history'
        && /\bclosed\b/i.test(contactText)
        && /\b(?:doors?|windows?|openings?|garage)\b/i.test(contactText)
      ) {
        const name = this._plainEntityName(
          item.entity_id,
          String(title).replace(/\s+(?:is\s+)?closed\b.*$/i, '')
        );
        title = `${name} Closed`;
        summary = '';
      }
    } else if (provider === 'laundry') {
      icon = item.icon || 'mdi:washing-machine';
    } else if (provider === 'cameras') {
      icon = item.icon || 'mdi:camera';
    }
    return {
      title: String(title).replace(/\s+/g, ' ').trim().slice(0, 60),
      summary: String(summary).replace(/\s+/g, ' ').trim().slice(0, 48),
      icon,
      relativeStamp,
      currentWeather,
      indoorTemperature
    };
  }

  _refreshFooterRelativeTimes() {
    this.shadowRoot.querySelectorAll('[data-footer-time]').forEach(element => {
      element.textContent = this._relative(element.dataset.footerTime);
    });
  }

  _renderFooterStream(items) {
    const target = this.shadowRoot.querySelector('.bottom-stream');
    if (!target) return;
    const signatureParts = items.map((item, index) => {
      const display = this._formatFooterItem(item);
      return {
        index,
        item: item.id || item.entity_id || item.message || `index:${index}`,
        title: display.title,
        summary: display.summary,
        icon: display.icon,
        value: `${index}|${display.title}|${display.summary}|${display.icon}|${display.relativeStamp}|${(item.grouped_contact_labels || []).join('|')}`
      };
    });
    const signature = signatureParts.map(part => part.value).join('||');
    if (signature === this._footerSignature) {
      this._refreshFooterRelativeTimes();
      return;
    }
    this._footerSignature = signature;
    this._footerSignatureParts = signatureParts;
    if (this._footerResizeObserver) {
      this._footerResizeObserver.disconnect();
      this._footerResizeObserver = null;
    }
    const renderSequence = () => items.map((item, index) => {
      const display = this._formatFooterItem(item);
      const relative = display.relativeStamp ? this._relative(display.relativeStamp) : '';
      const secondary = display.summary || relative
        ? `<small>${display.summary ? this._escape(display.summary) : ''}${display.summary && relative ? ' • ' : ''}${relative ? `<span data-footer-time="${this._escape(display.relativeStamp)}">${this._escape(relative)}</span>` : ''}</small>`
        : '';
      const groupedLabels = Array.isArray(item.grouped_contact_labels)
        ? ` data-footer-group-labels="${this._escape(JSON.stringify(item.grouped_contact_labels))}" data-footer-group-title="${this._escape(display.title)}"`
        : '';
      return `<span class="footer-marquee-item${display.currentWeather ? ' is-current-weather' : ''}${display.indoorTemperature ? ' is-indoor-temperature' : ''}"><span data-stream-id="${this._escape(item.id || '')}" data-stream-navigation="${this._escape(item.navigation || '')}" data-stream-entity="${this._escape(item.entity_id || '')}"${groupedLabels}><ha-icon class="${this._iconSemanticClass(item)}" icon="${this._escape(display.icon)}"></ha-icon><span class="footer-marquee-copy"><strong>${this._escape(display.title)}</strong>${secondary}</span></span></span>`;
    }).join('');
    const sequence = items.length ? renderSequence() : '';
    const duplicateSequence = sequence;
    target.innerHTML = sequence
      ? `<div class="footer-marquee"><div class="footer-marquee-track"><div class="footer-sequence">${sequence}</div><div class="footer-sequence" aria-hidden="true">${duplicateSequence}</div></div></div>`
      : '';
    const trackElement = target.querySelector('.footer-marquee-track');
    const firstSequence = target.querySelector('.footer-sequence');
    if (trackElement && firstSequence) {
      this._updateFooterMarqueeMetrics(target);
      if (typeof ResizeObserver !== 'undefined') {
        this._footerResizeObserver = new ResizeObserver(() => {
          this._updateFooterMarqueeMetrics(target);
        });
        this._footerResizeObserver.observe(firstSequence);
      }
    }
    this._refreshFooterRelativeTimes();
    this._bindStreamItems();
  }

  _updateFooterMarqueeMetrics(target) {
    const track = target?.querySelector('.footer-marquee-track');
    const firstSequence = target?.querySelector('.footer-sequence');
    if (!track || !firstSequence) return;
    const distance = firstSequence.getBoundingClientRect().width;
    if (!Number.isFinite(distance) || distance <= 0) return;
    const duration = Math.max(8, distance / this._config.footer_speed);
    track.style.setProperty('--marquee-distance', `${distance}px`);
    track.style.setProperty('--marquee-duration', `${duration}s`);
  }

  _providerFor(item) {
    const rawCategory = String(item?.provider || item?.category || item?.source || '').toLowerCase();
    const category = BACKEND_PROVIDER_ALIASES[rawCategory] || rawCategory;
    return category.includes('weather') ? 'weather'
      : category.includes('security') || category.includes('alarm') || category.includes('contact') ? 'security'
        : category.includes('fault') ? 'maintenance'
          : category.includes('schedule') ? 'schedule'
            : category.includes('maintenance') ? 'maintenance'
              : category.includes('laundry') ? 'laundry'
                : category.includes('climate') ? 'climate'
                  : 'activity';
  }

  _zoneMarkup(item, emptyLabel) {
    if (!item) return `<span class="zone-item zone-empty">${this._escape(emptyLabel)}</span>`;
    let title = this._label(item);
    let summary = this._humanizeStatusText(item.summary || item.secondary || item.detail || '');
    const provider = this._providerFor(item);
    const currentWeather = provider === 'weather'
      && (/^current:weather:/i.test(String(item.id || '')) || /^weather$/i.test(title));
    const indoorTemperature = provider === 'climate'
      && (/^current:climate:/i.test(String(item.id || '')) || /^Indoor Temperature$/i.test(title));
    if (currentWeather) {
      const parts = String(summary).split(/\s*(?:\u2022|\u00e2\u20ac\u00a2|\|)\s*/, 2);
      if (parts[0]) title = parts[0];
      summary = this._friendlyWeatherCondition(parts[1] || item.state || '');
    } else if (indoorTemperature) {
      title = this._glanceableTemperature(summary);
      summary = 'Indoors';
    }
    const relative = !currentWeather && !indoorTemperature
      ? this._relative(this._timestamp(item, item?.active !== false))
      : '';
    if (relative) {
      summary = [summary, relative].filter(Boolean).join(' — ');
    }
    const brief = `${title} ${summary}`.trim().length <= 42;
    const media = this._heroMedia(item);
    const mediaMarkup = media ? `<span class="hero-media-wrap"><img class="hero-media" src="${this._escape(media.url)}" alt="" loading="eager" data-hero-media="true"><span class="hero-media-overlay"></span></span>` : '';
    const content = `<span class="hero-content"><span class="zone-title"><ha-icon class="icon-tone-${this._iconTone(item)}" icon="${this._escape(item.icon || 'mdi:information-outline')}"></ha-icon><span>${this._escape(title)}</span></span><span class="zone-summary">${this._escape(summary)}</span></span>`;
    return `<span class="zone-item hero-zone-item${media ? ' has-hero-media' : ''}${brief ? ' is-brief' : ''}${currentWeather ? ' is-current-weather' : ''}${indoorTemperature ? ' is-indoor-temperature' : ''} priority-${this._escape(item.priority || 'normal')}" data-stream-id="${this._escape(item.id || '')}" data-stream-navigation="${this._escape(item.navigation || '')}" data-stream-entity="${this._escape(item.entity_id || '')}">${mediaMarkup}${content}</span>`;
  }

  _glanceableTemperature(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(-?\d+(?:\.\d+)?)\s*°?\s*[CF]?$/i);
    return match ? `${Math.round(Number(match[1]))}°` : text;
  }

  _friendlyWeatherCondition(value) {
    const condition = String(value || '').trim().toLowerCase();
    const labels = {
      'clear-night': 'Clear night',
      cloudy: 'Cloudy',
      fog: 'Foggy',
      hail: 'Hail',
      lightning: 'Lightning',
      'lightning-rainy': 'Thunderstorms',
      partlycloudy: 'Partly cloudy',
      pouring: 'Heavy rain',
      rainy: 'Rainy',
      snowy: 'Snowy',
      'snowy-rainy': 'Wintry mix',
      sunny: 'Sunny',
      windy: 'Windy',
      'windy-variant': 'Windy',
      exceptional: 'Exceptional weather'
    };
    return labels[condition] || condition.replace(/[-_]+/g, ' ').replace(/^./, character => character.toUpperCase());
  }

  _renderZone(zone, item, emptyLabel, animate = true) {
    const target = this.shadowRoot.querySelector(`[data-zone="${zone}"]`);
    if (!target) return;
    if (this._zoneRenderTimers[zone]) {
      clearTimeout(this._zoneRenderTimers[zone]);
      delete this._zoneRenderTimers[zone];
    }
    const generation = (this._zoneRenderGenerations[zone] || 0) + 1;
    this._zoneRenderGenerations[zone] = generation;
    const intendedId = item?.id || item?.entity_id || item?.message || null;
    const apply = () => {
      if (this._zoneRenderGenerations[zone] !== generation) return;
      const currentId = item?.id || item?.entity_id || item?.message || null;
      if (currentId !== intendedId) return;
      delete this._zoneRenderTimers[zone];
      target.innerHTML = this._zoneMarkup(item, emptyLabel);
      this._bindHeroMedia(target);
      target.classList.remove('zone-changing');
      this._bindStreamItems();
    };
    if (!animate || !target.firstElementChild) {
      apply();
      return;
    }
    target.classList.add('zone-changing');
    this._zoneRenderTimers[zone] = window.setTimeout(apply, 180);
  }

  _bindHeroMedia(target) {
    target.querySelectorAll('[data-hero-media]').forEach(image => {
      image.addEventListener('error', () => {
        const item = image.closest('.hero-zone-item');
        image.closest('.hero-media-wrap')?.remove();
        item?.classList.remove('has-hero-media');
      }, { once: true });
    });
  }

  _zoneItemSignature(item) {
    return [
      item?.id || '',
      item?.entity_id || '',
      item?.title || item?.message || '',
      item?.summary || item?.secondary || item?.detail || '',
      item?.priority || '',
      item?.icon || '',
      item?.media_url || item?.media?.url || item?.image_url || '',
      item?.provider || '',
      item?.state || ''
    ].join('|');
  }

  _startZoneRotations(data) {
    this._rotationPaused = Boolean(this._drawerOpen);
    const zones = this._zoneItems(data);
    const signatures = Object.fromEntries(
      Object.entries(zones).map(([zone, items]) => {
        const area = zone === 'left' ? 'sidebar' : 'hero';
        const config = this._config[area] || {};
        const interval = zone === 'right'
          ? Number(data.display?.hero_rotation_seconds) || this._config.rotation_seconds
          : Number(config.interval) || (zone === 'left' ? 5 : 7);
        return [
          zone,
          `${items.map(item => this._zoneItemSignature(item)).join('||')}::${config.rotate !== false}|${interval}`
        ];
      })
    );
    ['left', 'right'].forEach((zone, index) => {
      if (signatures[zone] === this._zoneSignatures[zone]) return;
      if (this._zoneTimers[zone]) {
        clearInterval(this._zoneTimers[zone]);
        delete this._zoneTimers[zone];
      }
      this._zoneSignatures[zone] = signatures[zone];
      const ids = zones[zone].map(item => item.id || item.entity_id || item.message);
      if (!zones[zone].length) {
        this._zoneIndexes[zone] = 0;
        this._zoneIds[zone] = null;
        this._renderZone(zone, null, zone === 'right' ? 'No current events' : 'No upcoming information');
        return;
      }
      const previousId = this._zoneIds[zone];
      const previous = previousId && ids.indexOf(previousId) >= 0 ? ids.indexOf(previousId) : this._zoneIndexes[zone];
      this._zoneIndexes[zone] = Math.min(previous, Math.max(0, zones[zone].length - 1));
      this._zoneIds[zone] = ids[this._zoneIndexes[zone]] || null;
      const area = zone === 'left' ? 'sidebar' : zone === 'right' ? 'hero' : 'footer';
      const config = this._config[area] || {};
      const item = zones[zone][this._zoneIndexes[zone]];
      this._renderZone(zone, item, zone === 'right' ? 'No current events' : 'No upcoming information');
      if (config.rotate === false || zones[zone].length < 2) return;
      const backendHeroInterval = Number(data.display?.hero_rotation_seconds);
      const interval = zone === 'right'
        ? Math.max(1, Number.isFinite(backendHeroInterval) && backendHeroInterval > 0 ? backendHeroInterval : this._config.rotation_seconds)
        : Math.max(2, Number(config.interval) || (5 + index * 2));
      this._zoneTimers[zone] = setInterval(() => {
        if (this._rotationPaused) return;
        this._zoneIndexes[zone] = (this._zoneIndexes[zone] + 1) % zones[zone].length;
        this._zoneIds[zone] = ids[this._zoneIndexes[zone]] || null;
        const item = zones[zone][this._zoneIndexes[zone]];
        this._renderZone(zone, item, zone === 'right' ? 'No current events' : 'No upcoming information');
      }, interval * 1000);
    });
  }

  _utilitySecurityState() {
    const entity = this._config.utility_header.security_entity;
    const value = String(this._state(entity)?.state || 'unavailable').toLowerCase();
    const states = {
      disarmed: ['Disarmed', 'mdi:shield-off-outline', 'neutral'],
      armed_home: ['Armed Home', 'mdi:shield-home', 'success'],
      armed_away: ['Armed Away', 'mdi:shield-lock', 'success'],
      armed_night: ['Armed Night', 'mdi:shield-moon', 'success'],
      arming: ['Arming', 'mdi:shield-sync', 'attention'],
      pending: ['Entry Delay', 'mdi:shield-alert', 'critical'],
      triggered: ['Triggered', 'mdi:shield-alert', 'critical']
    };
    const [state, icon, tone] = states[value] || ['Unavailable', 'mdi:shield-off-outline', 'neutral'];
    return { entity, state, icon, tone };
  }

  _utilityMusicState() {
    const entity = this._config.utility_header.music_entity;
    const player = this._state(entity);
    const value = String(player?.state || 'unavailable').toLowerCase();
    const attributes = player?.attributes || {};
    const available = Boolean(player && !['unknown', 'unavailable'].includes(value));
    const playing = value === 'playing';
    const paused = value === 'paused';
    const title = attributes.media_title
      || (playing ? 'Playing' : paused ? 'Paused' : available ? 'Nothing Playing' : 'Music Unavailable');
    const secondary = attributes.media_artist
      || attributes.media_album_name
      || attributes.source
      || (available ? 'Speakers and playback' : 'Player is unavailable');
    const volumeAvailable = Number.isFinite(Number(attributes.volume_level));
    const volume = volumeAvailable
      ? Math.max(0, Math.min(1, Number(attributes.volume_level)))
      : 0;
    const sources = Array.isArray(attributes.source_list)
      ? [...new Set(attributes.source_list.map(source => String(source || '').trim()).filter(Boolean))]
      : [];
    const artwork = String(
      attributes.entity_picture
      || attributes.media_image_url
      || attributes.media_album_cover_url
      || ''
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
      source: attributes.source || '',
      artwork,
      icon: playing ? 'mdi:music-circle' : paused ? 'mdi:pause-circle' : 'mdi:music-circle-outline'
    };
  }

  _utilityHeaderMarkup() {
    if (!this._config.utility_header.enabled) return '';
    const security = this._utilitySecurityState();
    const music = this._utilityMusicState();
    const securityNavigation = this._config.context_actions.security?.type === 'navigate'
      ? this._config.context_actions.security.path
      : this._config.utility_header.security_path;
    const musicNavigation = this._config.context_actions.music?.type === 'navigate'
      ? this._config.context_actions.music.path
      : this._config.utility_header.music_path;
    const securityNavigationDisabled = securityNavigation ? '' : ' disabled';
    const musicNavigationDisabled = musicNavigation ? '' : ' disabled';
    const disabled = music.available ? '' : ' disabled';
    const volumeDisabled = music.available && music.volumeAvailable ? '' : ' disabled';
    const sourceOptions = music.sources.map(source =>
      `<option value="${this._escape(source)}"${source === music.source ? ' selected' : ''}>${this._escape(source)}</option>`
    ).join('');
    return `<section class="utility-header" aria-label="Home controls">
      <div class="utility-clock" aria-label="Current time"><span class="utility-time"><strong data-clock-hour></strong><span class="utility-clock-seconds" data-clock-seconds></span><small data-clock-period></small></span><span class="utility-date" data-clock-date></span></div>
      <button class="utility-security tone-${this._escape(security.tone)}" type="button" data-utility-security aria-label="${this._escape(`Security: ${security.state}`)}"${securityNavigationDisabled}><ha-icon icon="${this._escape(security.icon)}"></ha-icon><span><strong>Security</strong><small>${this._escape(security.state)}</small></span></button>
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
    const header = this.shadowRoot?.querySelector('.utility-header');
    if (!header) return;
    const now = new Date();
    const parts = new Intl.DateTimeFormat([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).formatToParts(now);
    const part = type => parts.find(value => value.type === type)?.value || '';
    const hour = part('hour');
    const minute = part('minute');
    const second = part('second');
    const period = part('dayPeriod');
    const time = header.querySelector('[data-clock-hour]');
    const seconds = header.querySelector('[data-clock-seconds]');
    const dayPeriod = header.querySelector('[data-clock-period]');
    const date = header.querySelector('[data-clock-date]');
    if (time) time.textContent = `${hour}:${minute}`;
    if (seconds) seconds.textContent = second;
    if (dayPeriod) dayPeriod.textContent = period;
    if (date) date.textContent = new Intl.DateTimeFormat([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(now);
  }

  _startUtilityClock() {
    if (!this._config.utility_header.enabled) return;
    this._refreshUtilityClock();
    if (this._clockTimer) return;
    this._clockTimer = setInterval(() => this._refreshUtilityClock(), 1000);
  }

  _updateUtilityHeader() {
    const header = this.shadowRoot?.querySelector('.utility-header');
    if (!header) return;
    const security = this._utilitySecurityState();
    const securityButton = header.querySelector('[data-utility-security]');
    if (securityButton) {
      securityButton.className = `utility-security tone-${security.tone}`;
      securityButton.setAttribute('aria-label', `Security: ${security.state}`);
      securityButton.querySelector('ha-icon')?.setAttribute('icon', security.icon);
      const state = securityButton.querySelector('small');
      if (state && state.textContent !== security.state) state.textContent = security.state;
    }

    const music = this._utilityMusicState();
    const musicPanel = header.querySelector('.utility-music');
    musicPanel?.classList.toggle('playing', music.playing);
    const summary = header.querySelector('[data-utility-music-nav]');
    summary?.setAttribute('aria-label', `Music: ${music.title}`);
    summary?.querySelector('[data-music-icon]')?.setAttribute('icon', music.icon);
    const artworkFrame = summary?.querySelector('.utility-music-art');
    const artwork = summary?.querySelector('[data-music-art]');
    if (artworkFrame && artwork && artwork.dataset.url !== music.artwork) {
      artwork.dataset.url = music.artwork;
      artworkFrame.classList.toggle('has-art', Boolean(music.artwork));
      artwork.hidden = !music.artwork;
      if (music.artwork) artwork.setAttribute('src', music.artwork);
      else artwork.removeAttribute('src');
    }
    const title = header.querySelector('[data-music-title]');
    const secondary = header.querySelector('[data-music-secondary]');
    if (title && title.textContent !== music.title) title.textContent = music.title;
    if (secondary && secondary.textContent !== music.secondary) secondary.textContent = music.secondary;
    const controls = [...header.querySelectorAll('[data-music-command]')];
    controls.forEach(control => { control.disabled = !music.available; });
    const play = header.querySelector('.music-play-toggle');
    if (play) {
      play.dataset.musicCommand = music.playing ? 'media_pause' : 'media_play';
      play.setAttribute('aria-label', music.playing ? 'Pause' : 'Play');
      play.querySelector('ha-icon')?.setAttribute('icon', music.playing ? 'mdi:pause' : 'mdi:play');
    }
    const volume = header.querySelector('.music-volume');
    if (volume) {
      volume.disabled = !music.available || !music.volumeAvailable;
      if (this.shadowRoot.activeElement !== volume) volume.value = String(music.volume);
      volume.setAttribute('aria-valuetext', `${Math.round(music.volume * 100)} percent`);
    }
    header.querySelector('.music-volume-icon')?.setAttribute(
      'icon',
      music.volume === 0 ? 'mdi:volume-off' : music.volume < .5 ? 'mdi:volume-medium' : 'mdi:volume-high'
    );
    const source = header.querySelector('[data-music-source]');
    if (source) {
      const sourceSignature = music.sources.join('|');
      if (source.dataset.sources !== sourceSignature) {
        source.dataset.sources = sourceSignature;
        source.innerHTML = `<option value="">Choose speaker</option>${music.sources.map(item =>
          `<option value="${this._escape(item)}">${this._escape(item)}</option>`
        ).join('')}`;
      }
      source.disabled = !music.available || !music.sources.length;
      if (this.shadowRoot.activeElement !== source) source.value = music.source;
    }
  }

  _navigateUtility(path) {
    if (!path) return;
    if (/^https?:\/\//i.test(path)) {
      window.open(path, '_blank', 'noopener,noreferrer');
      return;
    }
    window.history.pushState({}, '', path);
    this.dispatchEvent(new Event('location-changed', { bubbles: true, composed: true }));
  }

  _contextActions(data = this._getRuntimeData()) {
    return [
      ['security', 'mdi:shield-home', 'Security'],
      ['lighting', 'mdi:home-lightbulb', 'Lighting'],
      ['cameras', 'mdi:cctv', 'Cameras'],
      ['calendar', 'mdi:calendar', 'Calendar'],
      ['music', 'mdi:music', 'Music'],
      ['location', 'mdi:map-marker', 'Location'],
      ['movies', 'mdi:movie-open', 'Movies'],
      ['sprinklers', 'mdi:sprinkler', 'Sprinklers'],
      ['energy', 'mdi:lightning-bolt', 'Energy']
    ].map(([id, icon, label]) => {
      const configured = homeStatusObject(this._config.context_actions[id]);
      const config = !configured.type && configured.path
        ? { ...configured, type: 'navigate' }
        : configured;
      return {
        id,
        label,
        ...this._contextActionState(id, icon, data),
        config
      };
    }).filter(action => action.config.type);
  }

  _contextActionState(id, defaultIcon, data) {
    const neutral = (state, icon = defaultIcon) => ({ state, icon, tone: 'neutral', active: false });
    if (id === 'security') {
      const entity = this._config.context_actions?.security?.entity
        || this._config.utility_header.security_entity;
      const value = String(this._state(entity)?.state || 'unavailable').toLowerCase();
      const states = {
        disarmed: ['Disarmed', 'mdi:shield-off-outline', 'neutral'],
        armed_home: ['Armed Home', 'mdi:shield-home', 'success'],
        armed_away: ['Armed Away', 'mdi:shield-lock', 'success'],
        armed_night: ['Armed Night', 'mdi:shield-moon', 'success'],
        arming: ['Arming', 'mdi:shield-sync', 'attention'],
        pending: ['Entry Delay', 'mdi:shield-alert', 'critical'],
        triggered: ['Triggered', 'mdi:shield-alert', 'critical']
      };
      const [state, icon, tone] = states[value] || ['Unavailable', 'mdi:shield-off-outline', 'neutral'];
      return { state, icon, tone, active: tone !== 'neutral' };
    }
    if (id === 'lighting') {
      const configured = this._config.context_actions?.lighting?.entities;
      const entities = Array.isArray(configured) ? configured : [];
      if (!entities.length) return neutral('Not configured');
      const count = entities.filter(entity => this._state(entity)?.state === 'on').length;
      return {
        state: count ? `${count} Light${count === 1 ? '' : 's'} On` : 'All Lights Off',
        icon: count ? 'mdi:lightbulb-group' : 'mdi:lightbulb-group-outline',
        tone: count ? 'attention' : 'neutral',
        active: count > 0
      };
    }
    if (id === 'cameras') {
      const item = (data?.active || []).find(candidate =>
        candidate?.provider === 'cameras' || candidate?.event_type === 'camera_offline'
      );
      return item
        ? { state: item.message || item.title || 'Camera Offline', icon: 'mdi:cctv-off', tone: 'critical', active: true }
        : neutral('All Online', 'mdi:cctv');
    }
    if (id === 'calendar') {
      const item = [...(data?.sidebar || []), ...(data?.footer || [])].find(candidate => {
        const entity = String(candidate?.entity_id || '');
        return candidate?.provider === 'schedule'
          && !/sprinkler|watering|garbage|recycl|waste/i.test(`${entity} ${candidate?.title || ''}`);
      });
      const state = item?.title || item?.message || 'Open Calendar';
      return item
        ? { state, icon: 'mdi:calendar-clock', tone: 'information', active: true }
        : neutral(state);
    }
    if (id === 'music') {
      const entity = this._config.context_actions?.music?.entity
        || this._config.utility_header.music_entity;
      const player = this._state(entity);
      const value = String(player?.state || 'unavailable').toLowerCase();
      if (value === 'playing') {
        return {
          state: player?.attributes?.media_title || 'Playing',
          icon: 'mdi:music-circle',
          tone: 'success',
          active: true
        };
      }
      if (value === 'paused') return { state: 'Paused', icon: 'mdi:pause-circle', tone: 'information', active: true };
      return neutral(value === 'unavailable' ? 'Unavailable' : 'Idle');
    }
    if (id === 'location') {
      const people = Object.values(this._hass?.states || {}).filter(state =>
        state?.entity_id?.startsWith('person.') && !['unknown', 'unavailable'].includes(state.state)
      );
      if (!people.length) return neutral('Unavailable');
      const home = people.filter(state => state.state === 'home').length;
      return {
        state: home === people.length
          ? 'Everyone Home'
          : home === 0
            ? 'Everyone Away'
            : `${home} of ${people.length} Home`,
        icon: home === people.length ? 'mdi:home-account' : 'mdi:map-marker-account',
        tone: home === people.length ? 'neutral' : 'information',
        active: home !== people.length
      };
    }
    if (id === 'sprinklers') {
      const configured = this._config.context_actions?.sprinklers?.entities;
      const entities = Array.isArray(configured) ? configured : [];
      if (!entities.length) return neutral('Not configured');
      const watering = entities.filter(entity =>
        ['open', 'opening', 'on'].includes(String(this._state(entity)?.state || '').toLowerCase())
      );
      if (watering.length) {
        return {
          state: watering.length === 1 ? 'Watering' : `Watering ${watering.length} Zones`,
          icon: 'mdi:sprinkler-variant',
          tone: 'information',
          active: true
        };
      }
      const rainDelay = this._config.context_actions?.sprinklers?.rain_delay_entity;
      if (rainDelay && this._state(rainDelay)?.state === 'on') {
        return { state: 'Rain Delay', icon: 'mdi:weather-rainy', tone: 'attention', active: true };
      }
      return neutral('Idle');
    }
    if (id === 'energy') return neutral('Open Energy');
    if (id === 'movies') return neutral('Browse');
    return neutral('Open');
  }

  _event(item, active) {
    const category = item?.category || 'Unknown';
    const stamp = this._timestamp(item, active);
    const id = item?.id || `${item?.event_type || 'event'}|${item?.message || ''}|${item?.created_at || ''}`;
    const expanded = this._expandedEventIds.has(id);
    const status = item?.active === true ? 'Active' : item?.active === false ? 'Resolved' : '';
    const detail = item?.detail || item?.details || item?.description || '';
    const entityId = item?.entity_id || item?.entity || '';
    const fields = [
      ['Time', stamp ? `${active ? 'Detected' : 'Resolved'} ${this._time(stamp)}` : ''],
      ['Relative', stamp ? this._relative(stamp) : ''],
      ['Status', status], ['Category', category], ['Device', item?.device || ''], ['Area', item?.area || ''], ['Details', detail]
    ].filter(([, value]) => value !== '');
    return `<article class="event ${expanded ? 'expanded' : ''}" data-id="${this._escape(id)}" style="--event-color:${this._color(category)}">
      <button class="event-head" type="button" aria-expanded="${expanded}"><span class="event-icon"><ha-icon icon="${this._escape(item?.icon || 'mdi:bell-outline')}"></ha-icon></span><span class="event-copy"><strong>${this._escape(this._label(item))}</strong><small>${this._escape(category)}${stamp ? ` • ${this._escape(this._relative(stamp))}` : ''}</small></span><ha-icon class="chevron" icon="mdi:chevron-right"></ha-icon></button>
      <div class="event-details">${fields.map(([label, value]) => `<div class="field"><small>${this._escape(label)}</small><span>${this._escape(value)}</span></div>`).join('')}${entityId ? `<button class="open-device" type="button" data-entity="${this._escape(entityId)}"><ha-icon icon="mdi:open-in-new"></ha-icon>Open Device</button>` : ''}</div>
    </article>`;
  }

  _styles() {
    return `<style>${CSS}</style>`;
  }

  _stopZoneRotations() {
    Object.values(this._zoneTimers).forEach(timer => clearInterval(timer));
    this._zoneTimers = {};
    Object.values(this._zoneRenderTimers).forEach(timer => clearTimeout(timer));
    this._zoneRenderTimers = {};
    this._zoneRenderGenerations = { left: 0, right: 0 };
  }

  _renderProviderLayout(data) {
    this._ensureVisibilityObserver();
    const configuredMedia = this._config.display?.media_enabled;
    this._mediaEnabled = configuredMedia === undefined
      ? data.display?.media_enabled !== false
      : configuredMedia !== false;
    if (data.unavailable) {
      this.shadowRoot.innerHTML = `${this._styles()}<ha-card class="home-status-unavailable"><div><strong>Home Status is unavailable</strong><span>Choose a valid Home Status sensor in the card editor, or finish setting up the integration.</span><code>${this._escape(this._config.entity)}</code></div></ha-card>`;
      return;
    }
    const utilityMarkup = this._utilityHeaderMarkup();
    const visualEffect = this._weatherVisualEffect(data);
    this.shadowRoot.innerHTML = `${this._styles()}${utilityMarkup}<div class="phone-status-host" data-phone-status-host></div><button class="ticker priority-${this._escape(data.priority)}" type="button" aria-expanded="${this._drawerOpen}"><span class="ticker-zones"><span class="ticker-zone primary-zone" data-zone="left"></span><span class="ticker-zone secondary-zone" data-zone="right"></span></span><span class="ticker-footer"><span class="bottom-stream" data-zone="bottom"></span></span></button><div class="drawer-host"></div>`;
    this._renderPhoneStatus(data);
    this._weatherRenderer.mount(this.shadowRoot.querySelector('.ticker'));
    this._weatherRenderer.setEffect(visualEffect);
    this._weatherRenderer.setVisible(this._ambientVisible);
    this._startZoneRotations(data);
    this._renderFooterStream(this._buildFooterStream(data));
    this._updateDrawer(data);
    this._bind();
    this._startUtilityClock();
  }

  _ensureVisibilityObserver() {
    if (this._visibilityObserver || typeof IntersectionObserver === 'undefined') return;
    this._visibilityObserver = new IntersectionObserver(entries => {
      this._ambientVisible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
      this._weatherRenderer.setVisible(this._ambientVisible);
    }, { threshold: 0 });
    this._visibilityObserver.observe(this);
  }

  _weatherVisualEffect(data) {
    if (this._config.animation.level === 'none') return 'none';
    if (this._config.weather_effect !== 'auto') return this._config.weather_effect;
    const items = [...(data.hero || []), ...(data.sidebar || []), ...(data.footer || [])];
    const weather = items.find(item => item?.provider === 'weather' && item?.visual_effect);
    return data.weather_visual_effect || weather?.visual_effect || 'none';
  }

  _liveStateMarkup() {
    const activeStates = this._quickStatusEntities.map(item => {
      const state = this._state(item.entity);
      const active = this._isQuickStatusActive(item, state);
      return active ? { item, state } : null;
    }).filter(Boolean);
    if (!activeStates.length) return '';
    const groups = new Map();
    activeStates.forEach(({ item, state }) => {
      const name = this._plainEntityName(
        item.entity,
        item.name || state.attributes?.friendly_name
      );
      const groupText = `${item.group} ${name} ${item.entity}`;
      const key = /window/i.test(groupText)
        ? 'windows'
        : /leak|water|moisture/i.test(groupText)
          ? 'leaks'
          : item.entity;
      const existing = groups.get(key);
      if (existing) existing.entities.push(item.entity);
      else groups.set(key, { item, state, name, entities: [item.entity] });
    });
    const order = value => {
      const text = `${value.item.group} ${value.name} ${value.item.entity}`.toLowerCase();
      if (value.item.entity.startsWith('alarm_control_panel.') || /smoke|carbon|co\b/.test(text)) return 0;
      if (/leak|water|moisture/.test(text)) return 2;
      if (/door/.test(text)) return 3;
      if (/window/.test(text)) return 4;
      if (/lock/.test(text)) return 5;
      return 6;
    };
    const cards = [...groups.values()].sort((a, b) => order(a) - order(b)).map(({ item, state, name, entities }) => {
      const stateValue = String(state.state).toLowerCase();
      const text = `${item.group} ${name} ${item.entity}`.toLowerCase();
      const isAlarm = item.entity.startsWith('alarm_control_panel.');
      const severity = isAlarm || /smoke|carbon|co\b|leak|water|moisture/.test(text) ? 'critical' : /door|window|lock/.test(text) ? 'attention' : 'activity';
      const icon = isAlarm ? 'mdi:shield-alert' : /smoke|carbon|co\b/.test(text) ? 'mdi:smoke-detector-alert' : /leak|water|moisture/.test(text) ? 'mdi:water-alert' : /window/.test(text) ? 'mdi:window-open-variant' : /lock/.test(text) ? 'mdi:lock-open-alert' : 'mdi:door-open';
      const alarmState = stateValue.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
      const title = entities.length > 1
        ? (/leak|water|moisture/.test(text)
          ? `${entities.length} Water Leaks`
          : `${entities.length} Windows Open`)
        : isAlarm
          ? `${name} ${alarmState}`
          : /leak|water|moisture/.test(text)
            ? (/leak$/i.test(name) ? name : `${name} Leak`)
            : /smoke|carbon|co\b/.test(text)
              ? `${name} Detected`
              : /lock/.test(text)
                ? `${name} Unlocked`
                : `${name} ${stateValue === 'opening' ? 'Opening' : 'Open'}`;
      return { title, icon, severity, entities, secondary: severity === 'critical' ? 'Immediate attention required' : 'Tap to view details' };
    });
    const summaryCards = cards.length > 3
      ? [
          ...cards.slice(0, 2),
          {
            title: `${cards.length - 2} More Alerts`,
            entities: cards.flatMap(card => card.entities),
            summary: true
          }
        ]
      : cards;
    const summary = summaryCards.map(card => {
      const entityData = card.entities.length === 1 && !card.summary
        ? `data-entity="${this._escape(card.entities[0])}"`
        : `data-entities="${this._escape(JSON.stringify(card.entities))}"`;
      return `<span class="live-banner-condition" role="button" tabindex="0" ${entityData}>${this._escape(card.title)}</span>`;
    }).join('<span class="live-banner-separator" aria-hidden="true"> • </span>');
    const details = cards.map(card => card.entities.map(entity => {
      const config = this._quickStatusEntities.find(item => item.entity === entity);
      const state = this._state(entity);
      const name = this._plainEntityName(entity, config?.name || state?.attributes?.friendly_name);
      const text = `${config?.group || ''} ${name} ${entity}`.toLowerCase();
      const title = card.entities.length > 1
        ? (/leak|water|moisture/.test(text)
          ? (/leak$/i.test(name) ? name : `${name} Leak`)
          : `${name} Open`)
        : card.title;
      return `<span class="live-banner-detail" role="button" tabindex="0" data-entity="${this._escape(entity)}"><ha-icon icon="${this._escape(card.icon)}"></ha-icon><span>${this._escape(title)}</span></span>`;
    }).join('')).join('');
    const bannerSeverity = cards.some(card => card.severity === 'critical')
      ? 'critical'
      : cards.some(card => card.severity === 'attention')
        ? 'attention'
        : 'activity';
    return `<section class="live-state-banner severity-${bannerSeverity}" aria-label="Live home alerts"><div class="live-banner-summary">${summary}</div><div class="live-banner-details" hidden>${details}</div></section>`;
  }

  _updateDrawer(data = this._getRuntimeData()) {
    const host = this.shadowRoot.querySelector('.drawer-host');
    const ticker = this.shadowRoot.querySelector('.ticker');
    if (!host || !ticker) return;
    ticker.setAttribute('aria-expanded', String(this._drawerOpen));
    if (!this._drawerOpen) {
      host.classList.remove('drawer-active');
      if (!host.querySelector('.context-bar') && !this.hasAttribute('data-drawer-open')) return;
      let finished = false;
      const finishClose = () => {
        if (finished || this._drawerOpen) return;
        finished = true;
        if (this._drawerCloseTimer) {
          clearTimeout(this._drawerCloseTimer);
          this._drawerCloseTimer = null;
        }
        if (this._drawerOpen) return;
        host.innerHTML = '';
        this._drawerSignature = '';
        this.removeAttribute('data-drawer-open');
        this.style.removeProperty('--home-status-drawer-inline-size');
      };
      host.addEventListener('transitionend', finishClose, { once: true });
      this._drawerCloseTimer = setTimeout(finishClose, 620);
      return;
    }
    const actions = this._contextActions(data);
    const signature = actions.map(action => `${action.id}|${action.label}`).join('||');
    if (signature === this._drawerSignature && host.querySelector('.context-bar')) {
      this._updateContextActionStates(actions);
      if (!host.classList.contains('drawer-active')) {
        const panel = host.querySelector('.context-bar');
        if (panel) void panel.offsetHeight;
        requestAnimationFrame(() => {
          if (this._drawerOpen) host.classList.add('drawer-active');
        });
      }
      return;
    }
    this._drawerSignature = signature;
    host.classList.remove('drawer-active');
    host.innerHTML = `<section class="context-bar" aria-label="Home controls">${actions.map(action => this._contextActionMarkup(action)).join('')}</section>`;
    const panel = host.querySelector('.context-bar');
    if (panel) void panel.offsetHeight;
    requestAnimationFrame(() => {
      if (this._drawerOpen) host.classList.add('drawer-active');
    });
    this._bindEventsOnly();
  }

  _contextActionMarkup(action) {
    return `<button class="context-action tone-${this._escape(action.tone)}${action.active ? ' active' : ''}" type="button" data-context-action="${this._escape(action.id)}" aria-label="${this._escape(`${action.label}: ${action.state}`)}"><ha-icon icon="${this._escape(action.icon)}"></ha-icon><span class="context-action-copy"><strong>${this._escape(action.label)}</strong><small>${this._escape(action.state)}</small></span></button>`;
  }

  _updateContextActionStates(actions) {
    actions.forEach(action => {
      const button = [...this.shadowRoot.querySelectorAll('.context-action')]
        .find(candidate => candidate.dataset.contextAction === action.id);
      if (!button) return;
      const className = `context-action tone-${action.tone}${action.active ? ' active' : ''}`;
      if (button.className !== className) button.className = className;
      const icon = button.querySelector('ha-icon');
      if (icon?.getAttribute('icon') !== action.icon) icon?.setAttribute('icon', action.icon);
      const label = button.querySelector('.context-action-copy strong');
      if (label && label.textContent !== action.label) label.textContent = action.label;
      const state = button.querySelector('.context-action-copy small');
      if (state && state.textContent !== action.state) state.textContent = action.state;
      button.setAttribute('aria-label', `${action.label}: ${action.state}`);
    });
  }

  _toggleDrawer() {
    const opening = !this._drawerOpen;
    if (opening) {
      if (this._drawerCloseTimer) {
        clearTimeout(this._drawerCloseTimer);
        this._drawerCloseTimer = null;
      }
      const inlineSize = this.getBoundingClientRect().width;
      if (inlineSize > 0) {
        this.style.setProperty('--home-status-drawer-inline-size', `${inlineSize}px`);
        this.setAttribute('data-drawer-open', '');
      }
    }
    this._drawerOpen = opening;
    this._rotationPaused = this._drawerOpen;
    this._updateDrawer();
  }

  render() {
    if (!this._config || !this._hass) return;
    const data = this._getRuntimeData();
    this._renderProviderLayout(data);
  }

  _update() {
    const data = this._getRuntimeData();
    if (!this.shadowRoot.querySelector('.ticker')) return this.render();
    this._renderPhoneStatus(data);
    const tickerButton = this.shadowRoot.querySelector('.ticker');
    const configuredMedia = this._config.display?.media_enabled;
    const mediaEnabled = configuredMedia === undefined
      ? data.display?.media_enabled !== false
      : configuredMedia !== false;
    if (mediaEnabled !== this._mediaEnabled) this._zoneSignatures = { left: '', right: '' };
    this._mediaEnabled = mediaEnabled;
    const visualEffect = this._weatherVisualEffect(data);
    tickerButton.className = `ticker priority-${this._escape(data.priority)}`;
    this._weatherRenderer.mount(tickerButton);
    this._weatherRenderer.setEffect(visualEffect);
    this._weatherRenderer.setVisible(this._ambientVisible);
    this._updateUtilityHeader();
    this._startZoneRotations(data);
    this._renderFooterStream(this._buildFooterStream(data));

    this._updateDrawer(data);
  }

  _setFooterDebug(changes = {}) {
    return;
    this._footerDebugState = { ...this._footerDebugState, ...changes };
    const panel = this.shadowRoot?.querySelector('.footer-debug-panel');
    if (!panel) return;
    const state = this._footerDebugState;
    const last = this._footerLastRebuild;
    const lastMarkup = last
      ? `<div class="footer-debug-last"><strong>Last Footer Rebuild</strong><span>${this._escape(last.timestamp)} · ${this._escape(last.item)}.${this._escape(last.field)}: ${this._escape(last.previousValue)} → ${this._escape(last.newValue)}</span><span>DOM ${last.domRebuilds} · Animation ${last.animationInits} · Width ${this._escape(last.widthBefore)} → ${this._escape(last.widthAfter)}</span><span>Previous signature: ${this._escape(last.previousSignature)}</span><span>New signature: ${this._escape(last.newSignature)}</span></div>`
      : '<div class="footer-debug-last"><strong>Last Footer Rebuild</strong><span>none recorded</span></div>';
    panel.innerHTML = `<div class="footer-debug-live"><strong>Footer diagnostic</strong><span>Reason: ${this._escape(state.reason)}</span><span>Signature: ${this._escape(state.signature)}</span><span>Width: ${this._escape(state.width)} (${this._escape(state.widthChange)})</span><span>Animation: ${this._escape(state.animation)}</span><span>DOM rebuilds: ${state.domRebuilds} · Animation inits: ${state.animationRestarts}</span></div>${lastMarkup}`;
  }

  _bind() {
    this._bindEventsOnly();
  }

  _bindEventsOnly() {
    const security = this.shadowRoot.querySelector('[data-utility-security]');
    if (security && !security.dataset.bound) {
      security.dataset.bound = 'true';
      security.addEventListener('click', event => {
        event.stopPropagation();
        const configured = this._config.context_actions.security;
        this._navigateUtility(
          configured?.type === 'navigate' && configured.path
            ? configured.path
            : this._config.utility_header.security_path
        );
      });
    }
    const musicSummary = this.shadowRoot.querySelector('[data-utility-music-nav]');
    if (musicSummary && !musicSummary.dataset.bound) {
      musicSummary.dataset.bound = 'true';
      musicSummary.addEventListener('click', event => {
        event.stopPropagation();
        const configured = this._config.context_actions.music;
        this._navigateUtility(
          configured?.type === 'navigate' && configured.path
            ? configured.path
            : this._config.utility_header.music_path
        );
      });
    }
    const musicArtwork = musicSummary?.querySelector('[data-music-art]');
    if (musicArtwork && !musicArtwork.dataset.bound) {
      musicArtwork.dataset.bound = 'true';
      musicArtwork.addEventListener('error', () => {
        musicArtwork.hidden = true;
        musicArtwork.closest('.utility-music-art')?.classList.remove('has-art');
      });
    }
    this.shadowRoot.querySelectorAll('[data-music-command]').forEach(button => {
      if (button.dataset.bound) return;
      button.dataset.bound = 'true';
      button.addEventListener('click', event => {
        event.stopPropagation();
        const service = button.dataset.musicCommand;
        const entityId = this._config.utility_header.music_entity;
        if (service && entityId) {
          this._hass?.callService('media_player', service, { entity_id: entityId });
        }
      });
    });
    const volume = this.shadowRoot.querySelector('.music-volume');
    if (volume && !volume.dataset.bound) {
      volume.dataset.bound = 'true';
      volume.addEventListener('input', event => {
        event.stopPropagation();
        const value = Number(volume.value);
        this.shadowRoot.querySelector('.music-volume-icon')?.setAttribute(
          'icon',
          value === 0 ? 'mdi:volume-off' : value < .5 ? 'mdi:volume-medium' : 'mdi:volume-high'
        );
        volume.setAttribute('aria-valuetext', `${Math.round(value * 100)} percent`);
      });
      volume.addEventListener('change', event => {
        event.stopPropagation();
        this._hass?.callService('media_player', 'volume_set', {
          entity_id: this._config.utility_header.music_entity,
          volume_level: Number(volume.value)
        });
      });
      volume.addEventListener('click', event => event.stopPropagation());
    }
    const source = this.shadowRoot.querySelector('[data-music-source]');
    if (source && !source.dataset.bound) {
      source.dataset.bound = 'true';
      source.addEventListener('click', event => event.stopPropagation());
      source.addEventListener('change', event => {
        event.stopPropagation();
        if (!source.value) return;
        this._hass?.callService('media_player', 'select_source', {
          entity_id: this._config.utility_header.music_entity,
          source: source.value
        });
      });
    }
    this.shadowRoot.querySelectorAll('.live-banner-condition, .live-banner-detail').forEach(button => {
      if (button.dataset.bound) return;
      button.dataset.bound = 'true';
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (button.dataset.entities) {
          const details = button.closest('.live-state-banner')?.querySelector('.live-banner-details');
          if (details) details.hidden = !details.hidden;
          return;
        }
        this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: button.dataset.entity } }));
      });
      button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        button.click();
      });
    });
    const ticker = this.shadowRoot.querySelector('.ticker');
    if (ticker && !ticker.dataset.bound) {
      ticker.dataset.bound = 'true';
      ticker.addEventListener('mouseenter', () => {
        if (this._config.pause_on_hover) this._rotationPaused = true;
      });
      ticker.addEventListener('mouseleave', () => { this._rotationPaused = false; });
      ticker.addEventListener('focusin', () => { this._rotationPaused = this._drawerOpen; });
      ticker.addEventListener('focusout', () => { this._rotationPaused = false; });
      ticker.addEventListener('touchstart', () => { this._rotationPaused = true; }, { passive: true });
      ticker.addEventListener('touchend', () => { this._rotationPaused = false; }, { passive: true });
      ticker.addEventListener('click', () => {
        if (this._config.home_status_visibility.drawer) this._toggleDrawer();
      });
      ticker.addEventListener('keydown', event => {
        if (this._config.home_status_visibility.drawer && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          this._toggleDrawer();
        }
      });
    }
    this.shadowRoot.querySelectorAll('.event-head').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const article = button.closest('.event');
      const id = article.dataset.id;
      const isExpanded = this._expandedEventIds.has(id);
      isExpanded ? this._expandedEventIds.delete(id) : this._expandedEventIds.add(id);
      article.classList.toggle('expanded', !isExpanded);
      button.setAttribute('aria-expanded', String(!isExpanded));
    }));
    this.shadowRoot.querySelectorAll('.open-device').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: button.dataset.entity } })); }));
    this.shadowRoot.querySelectorAll('.context-action').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      if (button.dataset.entity) {
        this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: button.dataset.entity } }));
      } else {
        const action = button.dataset.contextAction;
        const configured = this._config.context_actions[action]
          || this._contextActions(null).find(candidate => candidate.id === action)?.config;
        const config = configured && !configured.type && configured.path
          ? { ...configured, type: 'navigate' }
          : configured;
        if (!config?.type) {
          this.dispatchEvent(new CustomEvent('home-status-action', { bubbles: true, composed: true, detail: { action, config: config || {} } }));
          return;
        }
        if (config.confirmation?.text && !window.confirm(config.confirmation.text)) return;
        if (config.type === 'navigate' && config.path) {
          const path = String(config.path);
          if (/^https?:\/\//i.test(path)) {
            window.open(path, '_blank', 'noopener,noreferrer');
          } else {
            window.history.pushState({}, '', path);
            this.dispatchEvent(new Event('location-changed', { bubbles: true, composed: true }));
          }
        } else if (config.type === 'service' && config.service) {
          const [domain, service] = String(config.service).split('.', 2);
          if (domain && service) this._hass?.callService(domain, service, config.target || {});
        } else {
          this.dispatchEvent(new CustomEvent('home-status-action', { bubbles: true, composed: true, detail: { action, config } }));
        }
      }
    }));
    this._bindStreamItems();
  }

  _bindStreamItems() {
    this.shadowRoot.querySelectorAll('.zone-item, .phone-status-current, .phone-status-ticker-item, [data-footer-group-labels], [data-stream-navigation], [data-stream-entity]').forEach(item => {
      if (item.dataset.bound) return;
      item.dataset.bound = 'true';
      item.addEventListener('click', event => {
        event.stopPropagation();
        if (item.dataset.footerGroupLabels) {
          const marquee = item.closest('.footer-marquee');
          const expanded = !item.classList.contains('footer-group-expanded');
          const streamId = item.dataset.streamId || '';
          marquee?.classList.add('group-details-open');
          marquee?.querySelectorAll('[data-footer-group-labels]').forEach(copy => {
            if ((copy.dataset.streamId || '') === streamId) {
              copy.classList.toggle('footer-group-expanded', expanded);
            }
          });
          const title = item.querySelector('.footer-marquee-copy strong');
          if (title) {
            let labels = [];
            try {
              labels = JSON.parse(item.dataset.footerGroupLabels);
            } catch (_error) {
              labels = [];
            }
            title.textContent = expanded && labels.length
              ? labels.join(' • ')
              : item.dataset.footerGroupTitle || title.textContent;
          }
          marquee?.querySelectorAll('[data-footer-group-labels]').forEach(copy => {
            if ((copy.dataset.streamId || '') !== streamId || copy === item) return;
            const copyTitle = copy.querySelector('.footer-marquee-copy strong');
            if (copyTitle && title) copyTitle.textContent = title.textContent;
          });
          item.closest('.footer-marquee')?.classList.toggle(
            'group-details-open',
            Boolean(item.closest('.footer-marquee')?.querySelector('.footer-group-expanded'))
          );
          return;
        }
        const path = item.dataset.streamNavigation;
        if (path) {
          window.history.pushState({}, '', path);
          this.dispatchEvent(new Event('location-changed', { bubbles: true, composed: true }));
        } else if (item.dataset.streamEntity) {
          this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId: item.dataset.streamEntity } }));
        }
      });
    });
  }

  getCardSize() {
    const configured = Number(this._config?.card_size);
    return Number.isFinite(configured) && configured > 0
      ? configured
      : this._drawerOpen ? 8 : this._config?.profile === 'phone' ? 2 : 4;
  }

  getGridOptions() {
    const configured = homeStatusObject(this._rawConfig?.grid_options);
    return {
      // Sections expects numeric grid dimensions. Values such as "full" and
      // "auto" are valid in some card configs but break HA's section layout
      // renderer when this card is re-created after switching views.
      columns: Number.isFinite(Number(configured.columns))
        ? Math.max(3, Math.min(36, Number(configured.columns)))
        : 36,
      rows: Number.isFinite(Number(configured.rows))
        ? Math.max(2, Number(configured.rows))
        : 7,
      min_columns: 3,
      min_rows: 2
    };
  }

  static async getConfigElement() {
    return document.createElement('home-status-card-editor');
  }

  static getStubConfig() {
    return {
      entity: 'sensor.home_status',
      profile: 'auto',
      layout: 'responsive',
      time_entity: '',
      recent_ticker_limit: 6,
      recent_drawer_limit: 10,
      rotation_seconds: 4,
      utility_header: { enabled: false },
      hero: { rotate: true },
      sidebar: { rotate: true, interval: 7 },
      footer: { rotate: false, speed: 35 },
      grid_options: { columns: 36, rows: 7 },
      sizing: { max_width: 0, min_height: 0 },
      animation: { level: 'full' },
      display: { media_enabled: true },
      weather_effect: 'auto',
      pause_on_hover: true,
      show_normal_items: false,
      home_status_visibility: {
        hero: true,
        sidebar: true,
        footer: true,
        phone_ticker: true,
        drawer: false
      }
    };
  }
}

class HomeStatusCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = HomeStatusCard.getStubConfig();
    this._hass = null;
    this._editorLevel = 'recommended';
  }

  set hass(value) {
    this._hass = value;
    this._render();
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    this._config = homeStatusClone(homeStatusObject(config));
    const legacyVisibility = homeStatusObject(this._config.visibility);
    const namespacedVisibility = homeStatusObject(this._config.home_status_visibility);
    if (Object.keys(legacyVisibility).length && !Object.keys(namespacedVisibility).length) {
      this._config.home_status_visibility = homeStatusClone(legacyVisibility);
    }
    if (this._config.visibility === legacyVisibility) delete this._config.visibility;
    if (!this._config.type) this._config.type = 'custom:home-status-card';
    this._render();
  }

  connectedCallback() {
    this._render();
  }

  _escape(value) {
    const node = document.createElement('span');
    node.textContent = String(value ?? '');
    return node.innerHTML;
  }

  _value(path, fallback = '') {
    return homeStatusGetPath(this._config, path, fallback);
  }

  _select(path, label, options, fallback, help = '') {
    const value = String(this._value(path, fallback));
    return `<label><span>${this._escape(label)}</span><select data-path="${this._escape(path)}">${options.map(
      option => {
        const current = typeof option === 'string' ? { value: option, label: option } : option;
        return `<option value="${this._escape(current.value)}"${String(current.value) === value ? ' selected' : ''}>${this._escape(current.label)}</option>`;
      }
    ).join('')}</select>${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _text(path, label, fallback = '', help = '', list = '') {
    return `<label><span>${this._escape(label)}</span><input type="text" data-path="${this._escape(path)}" value="${this._escape(this._value(path, fallback))}"${list ? ` list="${this._escape(list)}"` : ''}>${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _number(path, label, fallback, min, max, help = '') {
    return `<label><span>${this._escape(label)}</span><input type="number" data-path="${this._escape(path)}" data-value-type="number" value="${this._escape(this._value(path, fallback))}" min="${min}" max="${max}">${help ? `<small>${this._escape(help)}</small>` : ''}</label>`;
  }

  _toggle(path, label, fallback = true, help = '') {
    return `<label class="toggle"><input type="checkbox" data-path="${this._escape(path)}" data-value-type="boolean"${this._value(path, fallback) !== false ? ' checked' : ''}><span><strong>${this._escape(label)}</strong>${help ? `<small>${this._escape(help)}</small>` : ''}</span></label>`;
  }

  _entityList(id, domain = '') {
    const entities = Object.keys(this._hass?.states || {})
      .filter(entity => !domain || entity.startsWith(`${domain}.`))
      .sort();
    return `<datalist id="${this._escape(id)}">${entities.map(
      entity => `<option value="${this._escape(entity)}"></option>`
    ).join('')}</datalist>`;
  }

  _unknownKeys() {
    return Object.keys(this._config).filter(key => !HOME_STATUS_KNOWN_TOP_LEVEL_KEYS.has(key));
  }

  _validationWarnings() {
    const warnings = [];
    const entity = String(this._value('entity', 'sensor.home_status'));
    if (!entity.includes('.')) warnings.push('The Home Status sensor must be a valid entity ID.');
    const profile = String(this._value('profile', 'auto'));
    const columns = Number(this._value('grid_options.columns', 36));
    const rows = Number(this._value('grid_options.rows', 7));
    if (['auto', 'tablet', 'desktop'].includes(profile) && Number.isFinite(columns) && columns < 24) {
      warnings.push('This width may force the compact phone presentation or clip the full Tablet/Desktop layout. Use 36 columns for the recommended Sections view.');
    }
    if (['auto', 'tablet', 'desktop'].includes(profile) && Number.isFinite(rows) && rows < 7) {
      warnings.push('The full layout needs at least 7 rows. A shorter grid can overlap the next dashboard section.');
    }
    const visibility = homeStatusObject(this._value('home_status_visibility', {}));
    if ([visibility.hero, visibility.sidebar, visibility.footer, visibility.phone_ticker].every(value => value === false)) {
      warnings.push('Every information area is hidden, so the card may appear empty. Enable at least one presentation area.');
    }
    const configuredActions = Object.values(homeStatusObject(this._value('context_actions', {})))
      .filter(action => homeStatusObject(action).path || homeStatusObject(action).type);
    if (visibility.drawer !== false && !configuredActions.length) {
      warnings.push('The drawer is enabled but has no navigation buttons. Add destinations in Advanced, or turn the drawer off.');
    }
    const paths = [
      'utility_header.security_path',
      'utility_header.music_path',
      'context_actions.calendar.path',
      'context_actions.cameras.path',
      'context_actions.lighting.path'
    ];
    paths.forEach(path => {
      const value = String(this._value(path, '') || '').trim();
      if (value && !value.startsWith('/') && !/^https?:\/\//i.test(value)) {
        warnings.push(`${path.split('.').slice(-2, -1)[0].replaceAll('_', ' ')} page must begin with / or use a full web address.`);
      }
    });
    return warnings;
  }

 _render() {
   if (!this.shadowRoot) return;
    const hadEditor = Boolean(this.shadowRoot.querySelector('.editor'));
    const openSections = new Set(
      [...this.shadowRoot.querySelectorAll('details[data-section][open]')]
        .map(section => section.dataset.section)
    );
    const sectionOpen = (section, defaultOpen = false) => hadEditor
      ? openSections.has(section)
      : defaultOpen;
    const levelHidden = level => this._editorLevel === level ? '' : ' hidden';
   const entity = String(this._value('entity', 'sensor.home_status'));
    const entityMissing = Boolean(this._hass && !this._hass.states?.[entity]);
    const unknown = this._unknownKeys();
    const validationWarnings = this._validationWarnings();
    const profiles = [
      { value: 'auto', label: 'Responsive (recommended)' },
      { value: 'phone', label: 'Phone' },
      { value: 'tablet', label: 'Tablet' },
      { value: 'desktop', label: 'Desktop' }
    ];
    const weatherEffects = [
      { value: 'auto', label: 'Automatic from Home Status' },
      { value: 'none', label: 'None' },
      { value: 'rain', label: 'Rain' },
      { value: 'clouds', label: 'Clouds' },
      { value: 'storm', label: 'Storm' },
      { value: 'wind', label: 'Wind' },
      { value: 'fog', label: 'Fog' },
      { value: 'night', label: 'Night' },
      { value: 'clear', label: 'Clear' }
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
      @media (max-width:520px) { .section { grid-template-columns:1fr; } }
    </style><div class="editor">
      <div class="intro"><strong>Home Status presentation</strong><br><small>These settings control this card only. Integration providers and notification rules remain in Settings → Devices & services → Home Status.</small></div>
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
      </div></details>
      <details data-section="visibility"${sectionOpen('visibility', true) ? ' open' : ''}${levelHidden('customize')}><summary>What appears</summary><div class="section">
        ${this._toggle('utility_header.enabled', 'Clock, security & music header', true)}
        ${this._toggle('home_status_visibility.hero', 'Main notification area', true)}
        ${this._toggle('home_status_visibility.sidebar', 'Details panel', true)}
        ${this._toggle('home_status_visibility.footer', 'Footer ticker', true)}
        ${this._toggle('home_status_visibility.phone_ticker', 'Phone ticker', true)}
        ${this._toggle('home_status_visibility.drawer', 'Navigation drawer', false, 'Enable after adding destinations in Advanced. Opens configured navigation buttons when the main card is tapped.')}
        ${this._toggle('show_normal_items', 'Include normal-status items', false)}
      </div></details>
      <details data-section="ticker"${sectionOpen('ticker', true) ? ' open' : ''}${levelHidden('customize')}><summary>Motion & timing</summary><div class="section">
        ${this._number('footer.speed', 'Ticker speed', 35, 8, 120, 'Lower values move faster.')}
        ${this._number('rotation_seconds', 'Default rotation time', 4, 1, 120)}
        ${this._number('sidebar.interval', 'Side rotation time', 7, 2, 120)}
        ${this._toggle('hero.rotate', 'Rotate main items', true)}
        ${this._toggle('sidebar.rotate', 'Rotate side items', true)}
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
      <details data-section="limits"${sectionOpen('limits') ? ' open' : ''}${levelHidden('advanced')}><summary>Item limits</summary><div class="section">
        ${this._number('recent_ticker_limit', 'Ticker item limit', 6, 1, 30)}
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
      </div></details>
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
    this.shadowRoot.querySelectorAll('[data-editor-level]').forEach(button => {
      button.addEventListener('click', () => {
        this._editorLevel = button.dataset.editorLevel;
        this._render();
      });
    });
    this.shadowRoot.querySelector('[data-restore-recommended]')?.addEventListener('click', () => {
      this._config = homeStatusMerge(this._config, HomeStatusCard.getStubConfig());
      this._emit();
      this._render();
    });
    this.shadowRoot.querySelectorAll('[data-path]').forEach(control => {
      control.addEventListener('change', event => {
        const target = event.currentTarget;
        const path = target.dataset.path;
        let value = target.value;
        if (target.dataset.valueType === 'boolean') value = target.checked;
        if (target.dataset.valueType === 'number') {
          value = target.value === '' ? undefined : Number(target.value);
        }
        if (path.startsWith('grid_options.') && !['full', 'auto'].includes(value)) {
          value = Number(value);
        }
        if (path.startsWith('context_actions.') && path.endsWith('.path') && value) {
          const actionPath = path.split('.').slice(0, -1).join('.');
          this._config = homeStatusSetPath(this._config, `${actionPath}.type`, 'navigate');
        }
        this._config = homeStatusSetPath(this._config, path, value, target.type === 'text');
        this._emit();
        this._render();
      });
    });
    this.shadowRoot.querySelector('[data-apply-profile]')?.addEventListener('click', () => {
      const profile = this.shadowRoot.querySelector('[data-profile-picker]')?.value || 'auto';
      this._config = homeStatusApplyProfile(this._config, profile);
      this._emit();
      this._render();
    });
  }

  _emit() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: homeStatusClone(this._config) },
      bubbles: true,
      composed: true
    }));
  }
}

const CSS = `
.utility-header { display:grid; grid-template-columns:minmax(220px,.2fr) minmax(230px,.22fr) minmax(540px,.58fr); align-items:stretch; width:100%; height:122px; min-height:122px; box-sizing:border-box; overflow:hidden; border:1px solid rgba(255,255,255,.085); border-radius:23px 23px 0 0; background:linear-gradient(135deg,rgba(31,37,44,.82),rgba(15,19,24,.78)); box-shadow:0 8px 24px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.035); }
.utility-header + .ticker { border-top:0; border-radius:0 0 23px 23px; }
.utility-clock { display:flex; flex-direction:column; justify-content:center; min-width:0; padding:0 24px; }
.utility-time { display:flex; align-items:flex-start; color:rgba(255,255,255,.96); line-height:1; white-space:nowrap; }
.utility-time strong { font-size:56px; font-weight:700; letter-spacing:-2px; }
.utility-clock-seconds { margin:2px 0 0 9px; color:rgba(255,255,255,.66); font-size:24px; font-weight:680; }
.utility-time small { align-self:flex-end; margin:0 0 6px 6px; color:rgba(255,255,255,.7); font-size:18px; font-weight:700; }
.utility-date { margin-top:6px; color:rgba(220,226,229,.78); font-size:16px; font-weight:560; letter-spacing:.3px; }
.utility-security { display:flex; align-items:center; justify-content:center; gap:13px; min-width:0; padding:0 20px; border:0; border-left:1px solid rgba(255,255,255,.09); background:none; box-shadow:inset 0 0 0 1px transparent; color:inherit; font:inherit; cursor:pointer; transition:background-color 180ms ease,box-shadow 180ms ease; }
.utility-security:hover,.utility-security:focus-visible,.utility-music-summary:hover,.utility-music-summary:focus-visible { background:rgba(255,255,255,.045); outline:none; }
.utility-security ha-icon { flex:0 0 auto; width:50px; height:50px; }
.utility-security > span { display:flex; flex-direction:column; min-width:0; text-align:left; }
.utility-security strong { color:rgba(255,255,255,.96); font-size:22px; line-height:26px; }
.utility-security small { margin-top:5px; color:rgba(220,226,229,.82); font-size:18px; font-weight:760; line-height:21px; letter-spacing:.45px; text-transform:uppercase; }
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
@keyframes security-critical-pulse { 0%,100% { background-color:rgba(239,83,80,.04); box-shadow:inset 0 0 0 1px rgba(239,83,80,.28); } 50% { background-color:rgba(239,83,80,.15); box-shadow:inset 0 0 0 1px rgba(255,112,109,.58),inset 0 0 20px rgba(239,83,80,.12); } }
@keyframes security-armed-pulse { 0%,100% { opacity:1; } 50% { opacity:0; } }
.utility-music { display:grid; grid-template-columns:minmax(240px,.9fr) minmax(300px,1.1fr); align-items:center; min-width:0; border-left:1px solid rgba(255,255,255,.09); }
.utility-music-summary { display:flex; align-items:center; gap:15px; min-width:0; height:100%; padding:0 20px; border:0; background:none; color:inherit; font:inherit; cursor:pointer; text-align:left; }
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
.utility-music-controls { display:flex; flex-direction:column; justify-content:center; gap:9px; min-width:0; padding:0 22px 0 7px; }
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
.live-state-host { position:absolute; z-index:5; top:0; left:0; right:0; overflow:hidden; pointer-events:none; }
.ticker { position:relative; }
.live-state-host.active { pointer-events:auto; }
.live-state-banner { transform:translateY(-100%); opacity:1; transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0); border-radius:0 0 16px 16px; background:rgba(20,24,29,.93); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,.1); border-top:0; box-shadow:0 8px 20px rgba(0,0,0,.34), 0 2px 0 rgba(255,255,255,.08); overflow:hidden; }
.live-state-host.active .live-state-banner { transform:translateY(0); opacity:1; transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0); }
.live-state-banner.severity-critical { border-bottom-color:rgba(239,83,80,.55); box-shadow:0 8px 20px rgba(0,0,0,.34),0 2px 0 rgba(239,83,80,.18); }
.live-state-banner.severity-attention { border-bottom-color:rgba(255,152,0,.5); box-shadow:0 8px 20px rgba(0,0,0,.34),0 2px 0 rgba(255,152,0,.16); }
.live-state-banner.severity-activity { border-bottom-color:rgba(66,165,245,.42); box-shadow:0 8px 20px rgba(0,0,0,.34),0 2px 0 rgba(66,165,245,.14); }
.live-banner-summary { display:flex; flex-wrap:nowrap; align-items:center; min-height:42px; gap:0; padding:0 18px; box-sizing:border-box; overflow:hidden; color:rgba(255,255,255,.9); font-size:14px; font-weight:600; white-space:nowrap; }
.live-banner-condition,.live-banner-detail { cursor:pointer; }
.live-banner-condition:hover,.live-banner-condition:focus-visible,.live-banner-detail:hover,.live-banner-detail:focus-visible { color:#fff; text-decoration:underline; outline:none; }
.live-banner-separator { padding:0 7px; color:var(--secondary-text-color); }
.live-banner-details { display:flex; align-items:center; min-height:42px; gap:18px; padding:0 18px; box-sizing:border-box; overflow-x:auto; border-top:1px solid rgba(255,255,255,.08); scrollbar-width:none; }
.live-banner-details::-webkit-scrollbar { display:none; }
.live-banner-detail { display:flex; flex:0 0 auto; align-items:center; gap:7px; color:rgba(255,255,255,.78); font-size:12px; white-space:nowrap; }
.live-banner-detail ha-icon { width:17px; height:17px; color:#ffb74d; }
@media (prefers-reduced-motion: reduce) { .live-state-banner, .drawer-host .context-bar, .drawer-host.drawer-active .context-bar { transition:none; } }
:host { display:block; width:100%; container-type:inline-size; }
:host([data-drawer-open]) { width:var(--home-status-drawer-inline-size) !important; min-width:var(--home-status-drawer-inline-size) !important; max-width:var(--home-status-drawer-inline-size) !important; }
.home-status-unavailable { min-height:132px; }
.home-status-unavailable > div { display:flex; flex-direction:column; gap:7px; padding:22px; }
.home-status-unavailable strong { font-size:18px; }
.home-status-unavailable span,.home-status-unavailable code { color:var(--secondary-text-color); }
:host([data-animation="none"]) * { animation:none !important; transition:none !important; }
:host([data-animation="reduced"]) .weather-renderer-layer,
:host([data-animation="reduced"]) .utility-security { animation:none !important; }
:host, ha-card { display:block; overflow:hidden; color:var(--primary-text-color); font-family:var(--paper-font-body1_-_font-family, sans-serif); }
.phone-status-host { display:none; }
.ticker { height:310px !important; min-height:310px !important; }
.ticker.has-live-state .ticker-zones { padding-top:44px; box-sizing:border-box; }
.ticker:has(.live-banner-details:not([hidden])) { height:354px !important; min-height:354px !important; }
.ticker:has(.live-banner-details:not([hidden])) .ticker-zones { padding-top:88px; }
.primary-zone:has(.has-hero-media) { height:176px; } .hero-zone-item.has-hero-media { height:176px; } .primary-zone .zone-title { font-size:31px !important; } .primary-zone .zone-summary { font-size:18px !important; line-height:1.45; }
.primary-zone .zone-title ha-icon { width:31px !important; height:31px !important; } .secondary-zone .zone-title ha-icon { width:31px !important; height:31px !important; }
.primary-zone .zone-title ha-icon, .secondary-zone .zone-title ha-icon { width:34px !important; height:34px !important; }
.ticker-footer { min-height:80px !important; padding-top:16px !important; } .footer-marquee { height:80px !important; } .footer-marquee-item { gap:12px !important; } .footer-marquee-item ha-icon { width:30px !important; height:30px !important; } .footer-marquee-copy strong { line-height:1.2; } .footer-marquee-copy small { margin-top:5px; } .primary-zone .zone-title ha-icon { width:26px !important; height:26px !important; } .primary-zone .zone-title { font-size:28px !important; } .primary-zone .zone-summary { font-size:17px !important; } .secondary-zone .zone-title ha-icon { width:26px !important; height:26px !important; } .secondary-zone .zone-title { font-size:21px !important; } .secondary-zone .zone-summary { font-size:15px !important; }
.ticker { display:flex; flex-direction:column; justify-content:space-between; width:100%; max-width:none; height:235px; min-height:235px; padding:20px 22px 16px; box-sizing:border-box; border:1px solid rgba(255,255,255,.085); border-radius:23px; background:linear-gradient(135deg,rgba(31,37,44,.78),rgba(15,19,24,.72)); color:var(--primary-text-color); box-shadow:0 8px 24px rgba(0,0,0,.26),inset 0 1px 0 rgba(255,255,255,.035); cursor:pointer; text-align:left; }
.footer-glyph { display:inline-flex; flex:0 0 auto; align-items:center; justify-content:center; width:27px; height:27px; font-size:24px; line-height:1; }
.footer-marquee-item ha-icon { flex:0 0 auto; width:27px; height:27px; } .semantic-red { color:#ef5350; } .semantic-cyan { color:#26c6da; } .semantic-sky { color:#4fc3f7; } .semantic-green { color:#66bb6a; } .semantic-teal { color:#26a69a; } .semantic-purple { color:#ab47bc; } .semantic-orange { color:#ff9800; } .semantic-amber { color:#ffc107; } .semantic-yellow { color:#fdd835; } .semantic-blue { color:#42a5f5; } .semantic-lime { color:#cddc39; } .semantic-white { color:rgba(255,255,255,.86); }
.ticker-footer { min-height:80px; } .footer-marquee { height:80px; }
.ticker-head { display:flex; align-items:center; width:100%; min-height:0; flex:1; }
.ticker-zones { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(260px,.75fr) 30px; gap:28px; align-items:center; width:100%; min-height:0; flex:1; }
.hero-zone-item { position:relative; overflow:hidden; isolation:isolate; } .hero-zone-item .hero-media-wrap,.hero-zone-item .hero-content { position:relative; z-index:1; } .hero-zone-item .hero-media-wrap { position:absolute; inset:0; z-index:0; border-radius:14px; overflow:hidden; background:rgba(0,0,0,.28); } .hero-zone-item .hero-media { display:block; width:100%; height:100%; object-fit:cover; } .hero-zone-item .hero-media-overlay { position:absolute; inset:0; background:linear-gradient(90deg,rgba(0,0,0,.72),rgba(0,0,0,.22) 70%,rgba(0,0,0,.08)); } .hero-zone-item:has(.hero-media) .hero-content { padding:12px 16px; }
.hero-zone-item.has-hero-media { display:grid; grid-template-columns:minmax(0,45%) minmax(0,1fr); gap:16px; align-items:center; width:100%; height:140px; overflow:hidden; } .hero-zone-item.has-hero-media .hero-media-wrap { position:relative; inset:auto; width:100%; height:100%; min-height:0; border-radius:14px; } .hero-zone-item.has-hero-media .hero-media-overlay { display:none; } .hero-zone-item.has-hero-media .hero-content { padding:0; min-width:0; } .primary-zone:has(.has-hero-media) { height:140px; }
 .icon-tone-critical { color:#ef5350; } .icon-tone-attention { color:#ff9800; } .icon-tone-success { color:#66bb6a; } .icon-tone-information { color:#42a5f5; } .icon-tone-media { color:#ab47bc; } .icon-tone-neutral { color:rgba(255,255,255,.72); }
 .zone-item { display:flex; flex-direction:column; justify-content:center; min-width:0; width:100%; cursor:pointer; opacity:1; transition:opacity 180ms ease, transform 180ms ease; } .zone-changing .zone-item { opacity:0; transform:translateY(4px); } .zone-title { display:flex; align-items:center; gap:8px; min-width:0; overflow:hidden; font-weight:650; line-height:1.2; white-space:nowrap; } .zone-title span { overflow:hidden; text-overflow:ellipsis; } .zone-title ha-icon { flex:0 0 auto; width:22px; height:22px; } .zone-summary { display:-webkit-box; margin-top:7px; overflow:hidden; color:rgba(255,255,255,.76); line-height:1.35; -webkit-box-orient:vertical; -webkit-line-clamp:2; } .zone-empty { color:var(--secondary-text-color); font-size:13px; }
.secondary-zone .zone-item.is-brief .zone-title { font-size:28px !important; } .secondary-zone .zone-item.is-brief .zone-summary { font-size:18px !important; } .secondary-zone .zone-item.is-brief .zone-title ha-icon { width:30px !important; height:30px !important; }
.secondary-zone .zone-item.is-current-weather .zone-title,.secondary-zone .zone-item.is-indoor-temperature .zone-title { font-size:52px !important; font-weight:740; line-height:1.05; } .secondary-zone .zone-item.is-current-weather .zone-summary,.secondary-zone .zone-item.is-indoor-temperature .zone-summary { margin-top:6px; font-size:25px !important; line-height:1.2; color:rgba(255,255,255,.84); } .secondary-zone .zone-item.is-current-weather .zone-title ha-icon,.secondary-zone .zone-item.is-indoor-temperature .zone-title ha-icon { width:42px !important; height:42px !important; --mdc-icon-size:42px; }
.ticker-zone { display:flex; align-items:center; min-width:0; height:104px; }
.secondary-zone { padding-left:24px; border-left:1px solid rgba(255,255,255,.1); }
.secondary-item { display:flex; flex-direction:column; justify-content:center; min-width:0; width:100%; height:104px; }
.secondary-empty { opacity:.65; }
.ticker:focus-visible { outline:2px solid var(--focus-color,#42a5f5); outline-offset:3px; }
.main-icon { display:grid; place-items:center; flex:0 0 40px; width:40px; height:40px; border-radius:12px; background:rgba(102,187,106,.12); color:#66bb6a; }
.priority-critical .main-icon { color:#ef5350; background:rgba(239,83,80,.12); } .priority-attention .main-icon { color:#ff9800; background:rgba(255,152,0,.12); } .priority-activity .main-icon { color:#42a5f5; background:rgba(66,165,245,.12); }
 .primary-zone { padding-right:4px; } .primary-zone .zone-title { font-size:25px; } .primary-zone .zone-summary { font-size:15px; } .secondary-zone .zone-title { font-size:18px; } .secondary-zone .zone-summary { font-size:13px; } .bottom-stream { flex:1 1 auto; min-width:0; overflow:hidden; } .footer-marquee { width:100%; overflow:hidden; } .footer-marquee-track { display:flex; width:max-content; animation:footer-marquee var(--marquee-duration,30s) linear infinite; will-change:transform; } .footer-sequence { display:flex; flex:0 0 auto; align-items:center; } .footer-marquee-item { display:inline-flex; align-items:center; gap:6px; margin-right:14px; font-size:13px; text-transform:uppercase; letter-spacing:.2px; } .footer-marquee-item ha-icon { width:17px; height:17px; } .footer-marquee-item small { margin-left:2px; color:var(--secondary-text-color); font-size:11px; text-transform:none; letter-spacing:0; } .footer-marquee-separator { margin:0 16px; color:var(--secondary-text-color); font-size:12px; } @keyframes footer-marquee { from { transform:translate3d(0,0,0); } to { transform:translate3d(calc(-1 * var(--marquee-distance)),0,0); } }
.ticker-primary { overflow:hidden; font-size:25px; font-weight:650; line-height:30px; text-overflow:ellipsis; white-space:nowrap; } .ticker-detail { display:block; max-width:100%; margin-top:8px; overflow:hidden; color:rgba(255,255,255,.82); font-size:15px; line-height:20px; text-overflow:ellipsis; white-space:nowrap; } .ticker-secondary { overflow:hidden; margin-top:7px; color:var(--secondary-text-color); font-size:13px; line-height:17px; text-overflow:ellipsis; white-space:nowrap; }
 .ticker-footer { min-height:68px; box-sizing:border-box; } .footer-marquee { height:68px; } .footer-marquee-track { height:100%; align-items:stretch; } .footer-sequence { height:100%; } .footer-marquee-item { position:relative; display:inline-flex; align-items:center; min-width:max-content; height:100%; padding:0 28px; margin-right:0; box-sizing:border-box; font-size:inherit; text-transform:none; letter-spacing:0; } .footer-marquee-item + .footer-marquee-item::before,.footer-sequence + .footer-sequence .footer-marquee-item:first-child::before { content:""; position:absolute; left:0; width:1px; height:38px; background:rgba(255,255,255,.25); } .footer-marquee-item > [data-stream-id] { display:flex; align-items:center; gap:10px; min-width:0; } .footer-marquee-item ha-icon { flex:0 0 auto; width:27px; height:27px; } .footer-marquee-copy { display:flex; flex-direction:column; justify-content:center; min-width:0; line-height:1.15; white-space:nowrap; } .footer-marquee-copy strong { color:rgba(255,255,255,.94); font-size:16px; font-weight:600; } .footer-marquee-copy small { display:block; margin-top:3px; color:var(--secondary-text-color); font-size:13px; opacity:.7; text-transform:none; letter-spacing:0; }
.footer-marquee-item.is-current-weather ha-icon,.footer-marquee-item.is-indoor-temperature ha-icon { width:34px; height:34px; --mdc-icon-size:34px; } .footer-marquee-item.is-current-weather .footer-marquee-copy strong,.footer-marquee-item.is-indoor-temperature .footer-marquee-copy strong { font-size:25px; font-weight:720; line-height:1; } .footer-marquee-item.is-current-weather .footer-marquee-copy small,.footer-marquee-item.is-indoor-temperature .footer-marquee-copy small { margin-top:4px; font-size:17px; line-height:1; opacity:.82; }
.footer-marquee.group-details-open .footer-marquee-track { animation-play-state:paused; } [data-footer-group-labels] { cursor:pointer; } [data-footer-group-labels].footer-group-expanded .footer-marquee-copy strong { color:#90caf9; }
.drawer { margin-top:0; max-height:min(58vh,560px); overflow:hidden; border:1px solid rgba(255,255,255,.085); border-top:0; border-radius:0 0 24px 24px; background:linear-gradient(145deg,rgba(31,37,44,.94),rgba(14,18,23,.94)); }
.drawer-host { overflow:hidden; }
.drawer-host .context-bar { transform:translateY(-100%); transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0); }
.drawer-host.drawer-active .context-bar { transform:translateY(0); transition:transform 560ms cubic-bezier(0.32, 0, 0.67, 0); }
.context-bar { display:grid; grid-template-columns:repeat(10,minmax(0,1fr)); grid-template-rows:repeat(2,58px); align-items:stretch; gap:10px; width:100%; height:146px; min-height:146px; padding:10px 16px; box-sizing:border-box; overflow:hidden; border:1px solid rgba(255,255,255,.085); border-top:0; border-radius:0 0 18px 18px; background:rgba(18,23,28,.96); }
.context-action { display:flex; grid-column:span 2; align-items:center; justify-content:flex-start; gap:11px; min-width:0; height:58px; padding:0 14px; border:1px solid rgba(255,255,255,.08); border-radius:13px; background:rgba(255,255,255,.045); color:rgba(255,255,255,.8); font:inherit; cursor:pointer; transition:border-color 180ms ease,background 180ms ease,color 180ms ease; } .context-action:nth-child(6) { grid-column:2 / span 2; } .context-action:hover { background:rgba(255,255,255,.1); color:#fff; } .context-action ha-icon { flex:0 0 auto; width:24px; height:24px; } .context-action-copy { display:flex; flex-direction:column; min-width:0; text-align:left; } .context-action-copy strong,.context-action-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .context-action-copy strong { color:rgba(255,255,255,.96); font-size:17px; font-weight:680; line-height:21px; } .context-action-copy small { margin-top:3px; color:rgba(220,226,229,.72); font-size:14px; font-weight:520; line-height:17px; }
.context-action.tone-information { border-color:rgba(66,165,245,.3); background:linear-gradient(135deg,rgba(66,165,245,.15),rgba(255,255,255,.035)); } .context-action.tone-information ha-icon { color:#42a5f5; }
.context-action.tone-success { border-color:rgba(102,187,106,.3); background:linear-gradient(135deg,rgba(102,187,106,.15),rgba(255,255,255,.035)); } .context-action.tone-success ha-icon { color:#66bb6a; }
.context-action.tone-attention { border-color:rgba(255,193,7,.34); background:linear-gradient(135deg,rgba(255,193,7,.17),rgba(255,255,255,.035)); } .context-action.tone-attention ha-icon { color:#ffc107; }
.context-action.tone-critical { border-color:rgba(239,83,80,.38); background:linear-gradient(135deg,rgba(239,83,80,.19),rgba(255,255,255,.035)); } .context-action.tone-critical ha-icon { color:#ef5350; }
.context-action.active .context-action-copy small { color:rgba(255,255,255,.82); }
.context-action[data-context-action="security"] ha-icon { color:#ef5350; }
.context-action[data-context-action="lighting"] ha-icon { color:#ffc107; }
.context-action[data-context-action="cameras"] ha-icon { color:#42a5f5; }
.context-action[data-context-action="calendar"] ha-icon { color:#ab47bc; }
.context-action[data-context-action="music"] ha-icon { color:#ec407a; }
.context-action[data-context-action="location"] ha-icon { color:#42a5f5; }
.context-action[data-context-action="movies"] ha-icon { color:#7e57c2; }
.context-action[data-context-action="sprinklers"] ha-icon { color:#26a69a; }
.context-action[data-context-action="energy"] ha-icon { color:#fdd835; }
.context-action.tone-information ha-icon { color:#42a5f5; } .context-action.tone-success ha-icon { color:#66bb6a; } .context-action.tone-attention ha-icon { color:#ffc107; } .context-action.tone-critical ha-icon { color:#ef5350; }
.drawer h2 { display:flex; align-items:center; gap:8px; margin:0; padding:15px 20px 12px; font-size:22px; } .section-title { padding:9px 20px 7px; color:var(--secondary-text-color); font-size:10px; font-weight:650; letter-spacing:1px; } .recent-title { margin-top:12px; border-top:1px solid rgba(255,255,255,.07); padding-top:13px; }
.active-list { padding:0 16px; } .recent-list { max-height:calc(min(58vh,560px) - 160px); overflow-y:auto; padding:0 16px 18px; scrollbar-width:thin; overscroll-behavior:contain; touch-action:pan-y; }
.event { margin:0 0 7px; border:1px solid rgba(255,255,255,.055); border-left:3px solid var(--event-color); border-radius:16px; background:rgba(255,255,255,.025); overflow:hidden; } .event-head { display:grid; grid-template-columns:34px minmax(0,1fr) 20px; gap:10px; align-items:center; width:100%; min-height:52px; padding:8px 11px; border:0; background:none; color:inherit; cursor:pointer; text-align:left; } .event-icon { display:grid; place-items:center; width:30px; height:30px; border-radius:10px; color:var(--event-color); background:color-mix(in srgb,var(--event-color) 12%,transparent); } .event-copy { display:flex; flex-direction:column; min-width:0; } .event-copy strong,.event-copy small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .event-copy strong { font-size:15px; } .event-copy small { color:var(--secondary-text-color); font-size:12px; } .chevron { transition:transform 180ms ease; } .expanded .chevron { transform:rotate(90deg); } .event-details { display:none; padding:0 14px 12px; border-top:1px solid rgba(255,255,255,.045); } .expanded .event-details { display:block; } .field { display:flex; flex-direction:column; margin-top:9px; } .field small { color:var(--secondary-text-color); font-size:10px; text-transform:uppercase; letter-spacing:.55px; } .field span { font-size:12px; line-height:16px; } .open-device { display:inline-flex; align-items:center; gap:7px; margin-top:12px; padding:7px 10px; border:1px solid rgba(255,255,255,.075); border-radius:11px; background:rgba(255,255,255,.035); color:inherit; cursor:pointer; } .empty { min-height:52px; padding:8px 11px; color:var(--secondary-text-color); font-size:13px; }
 @media (prefers-reduced-motion:reduce) { .zone-item { transition:none; } .utility-security.tone-critical,.utility-security.tone-success::before { animation:none; } } @container (max-width:760px) { .utility-header { grid-template-columns:1fr 1fr; grid-template-rows:72px 92px; height:164px; min-height:164px; border-radius:19px 19px 0 0; } .utility-clock { padding:0 16px; } .utility-time strong { font-size:35px; } .utility-clock-seconds { font-size:16px; } .utility-time small { font-size:13px; } .utility-date { margin-top:4px; font-size:11px; } .utility-security { padding:0 12px; } .utility-security ha-icon { width:28px; height:28px; } .utility-music { grid-column:1 / -1; grid-template-columns:minmax(150px,.8fr) minmax(230px,1.2fr); border-top:1px solid rgba(255,255,255,.09); border-left:0; } .utility-music-controls { padding-right:14px; } } @container (max-width:600px) { .ticker,.ticker:has(.live-banner-details:not([hidden])) { width:100%; height:194px !important; min-height:194px !important; padding:13px 15px 11px; border-radius:19px; } .utility-header + .ticker,.utility-header + .ticker:has(.live-banner-details:not([hidden])) { border-radius:0 0 19px 19px; } .ticker.has-live-state .ticker-zones { padding-top:42px; } .ticker:has(.live-banner-details:not([hidden])) .ticker-zones { padding-top:84px; } .ticker-zones { grid-template-columns:minmax(0,1fr) 30px; gap:8px; } .secondary-zone { display:none; } .ticker-zone { height:58px; } .primary-zone .zone-title { font-size:19px; } .primary-zone .zone-summary { font-size:12px; } .primary-zone .zone-title ha-icon { width:19px; height:19px; } .ticker-footer { padding-top:7px; font-size:9px; gap:7px; } .footer-action { display:none; } .context-bar { grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:repeat(3,52px); height:176px; min-height:176px; padding:7px 9px; gap:6px; } .context-action,.context-action:nth-child(6) { grid-column:auto; height:52px; padding:0 9px; gap:7px; } .context-action ha-icon { width:20px; height:20px; } .context-action-copy strong { font-size:14px; line-height:17px; } .context-action-copy small { font-size:11px; line-height:13px; } }
.primary-zone .zone-title, .secondary-zone .zone-title { font-size:23px; font-weight:700; }
.primary-zone .zone-summary, .secondary-zone .zone-summary { font-size:15px; }
.zone-title { gap:10px; }
.zone-title ha-icon { width:26px; height:26px; }
.ticker-footer, .footer-marquee { min-height:88px; height:88px; }
.footer-marquee-item ha-icon { width:32px; height:32px; }
.footer-marquee-copy strong { color:#fff; font-size:18px; font-weight:760; letter-spacing:.55px; }
.footer-marquee-copy small { margin-top:4px; opacity:.78; }
.context-bar { grid-template-rows:repeat(2,68px); height:166px; min-height:166px; }
.context-action { height:68px; }
.ticker { isolation:isolate; overflow:hidden; background:rgba(23,28,34,.82); }
.ticker > :not(.weather-renderer-layer) { position:relative; z-index:1; }
.ticker > .weather-renderer-layer { position:absolute; z-index:0; inset:-8% -10% 88px; border-radius:22px 22px 0 0; opacity:0; pointer-events:none; transition:none; background-repeat:repeat; will-change:transform,opacity,background-position; }
.weather-renderer-layer.lottie-weather-layer { overflow:hidden; background:none; }
.weather-renderer-layer.lottie-rain-layer { opacity:.32; overflow:hidden; background:none; }
.weather-renderer-layer.lottie-rain-layer canvas { display:block; width:100% !important; height:100% !important; }
.weather-renderer-layer.video-weather-layer { width:auto; height:auto; object-fit:cover; opacity:.22; mix-blend-mode:screen; filter:saturate(.72) brightness(.78); background:none; }
.weather-renderer-layer.weather-effect-rain { opacity:.26; background-image:repeating-linear-gradient(105deg,transparent 0 24px,rgba(190,225,255,.76) 25px 27px,transparent 28px 52px); background-size:96px 120px; animation:ambient-rain 3.2s linear infinite; }
.weather-renderer-layer.weather-effect-clouds { opacity:.25; mix-blend-mode:screen; background:radial-gradient(ellipse 40% 31% at 24% 38%,rgba(211,225,237,.68) 0 38%,transparent 70%),radial-gradient(ellipse 46% 34% at 74% 45%,rgba(178,199,217,.56) 0 38%,transparent 72%); filter:blur(6px); animation:ambient-clouds 18s ease-in-out infinite alternate; }
.weather-renderer-layer.weather-effect-fog { opacity:.27; mix-blend-mode:screen; background:linear-gradient(180deg,transparent 16%,rgba(222,229,231,.44) 34%,transparent 52%),linear-gradient(180deg,transparent 48%,rgba(202,215,219,.48) 65%,transparent 82%); filter:blur(8px); animation:ambient-fog 20s ease-in-out infinite alternate; }
.weather-renderer-layer.weather-effect-wind { opacity:.26; mix-blend-mode:screen; background:linear-gradient(174deg,transparent 28%,rgba(181,225,222,.62) 31% 34%,transparent 37% 58%,rgba(159,209,211,.52) 61% 64%,transparent 67%); filter:blur(3px); animation:ambient-wind 12s ease-in-out infinite alternate; }
.weather-renderer-layer.weather-effect-storm { opacity:.32; background-image:radial-gradient(ellipse at center,rgba(215,221,255,.92),transparent 58%),linear-gradient(180deg,rgba(8,12,23,.44),rgba(29,34,52,.26)); background-repeat:no-repeat; background-size:42% 100%,100% 100%; animation:ambient-storm 10s ease-in-out infinite; }
.weather-renderer-layer.weather-effect-night { opacity:.3; mix-blend-mode:screen; background:radial-gradient(circle at 80% 22%,rgba(213,224,255,.72) 0 3%,rgba(155,179,236,.26) 4% 10%,transparent 20%),radial-gradient(ellipse at center,transparent 42%,rgba(2,6,18,.66) 100%); animation:ambient-night 28s ease-in-out infinite alternate; }
.weather-renderer-layer.ambient-paused { animation-play-state:paused; visibility:hidden; }
@keyframes ambient-rain { from { background-position:0 -120px; } to { background-position:0 120px; } }
@keyframes ambient-clouds { from { transform:translate3d(-18%,0,0) scale(1.02); } to { transform:translate3d(18%,1%,0) scale(1.04); } }
@keyframes ambient-fog { from { transform:translate3d(-24%,0,0) scale(1.06); } to { transform:translate3d(24%,0,0) scale(1.06); } }
@keyframes ambient-wind { from { transform:translate3d(-30%,0,0); } to { transform:translate3d(30%,1%,0); } }
@keyframes ambient-storm { 0%,18% { background-position:-45% 0,0 0; opacity:.32; } 38%,48% { background-position:40% 0,0 0; opacity:.58; } 68%,100% { background-position:145% 0,0 0; opacity:.32; } }
@keyframes ambient-night { from { transform:translate3d(-2%,0,0); } to { transform:translate3d(2%,1%,0); } }
@media (prefers-reduced-motion:reduce) { .weather-renderer-layer { transition:none; } }
@container (max-width:600px) {
  :host([data-profile="auto"]) .utility-header,
  :host([data-profile="auto"]) .ticker,
  :host([data-profile="auto"]) .drawer-host,
  :host([data-profile="phone"]) .utility-header,
  :host([data-profile="phone"]) .ticker,
  :host([data-profile="phone"]) .drawer-host { display:none !important; }
  .phone-status-host { display:block; }
  .phone-status-shell { overflow:hidden; border:1px solid rgba(255,255,255,.085); border-radius:18px; background:linear-gradient(135deg,rgba(31,37,44,.82),rgba(15,19,24,.78)); box-shadow:0 6px 18px rgba(0,0,0,.22),inset 0 1px 0 rgba(255,255,255,.035); }
  .phone-status-current { display:grid; grid-template-columns:42px minmax(0,1fr) 22px; align-items:center; gap:10px; width:100%; min-height:78px; padding:10px 13px; border:0; background:none; color:inherit; font:inherit; text-align:left; }
  .phone-status-current:disabled { opacity:1; }
  .phone-status-current.is-actionable { cursor:pointer; }
  .phone-status-current.is-actionable:focus-visible { outline:2px solid var(--focus-color,#42a5f5); outline-offset:-3px; }
  .phone-status-icon { display:grid; place-items:center; width:38px; height:38px; border-radius:12px; background:rgba(66,165,245,.12); color:#42a5f5; }
  .phone-status-current.priority-critical .phone-status-icon { background:rgba(239,83,80,.14); color:#ef5350; }
  .phone-status-current.priority-attention .phone-status-icon { background:rgba(255,152,0,.14); color:#ff9800; }
  .phone-status-current.priority-normal .phone-status-icon { background:rgba(102,187,106,.13); color:#66bb6a; }
  .phone-status-icon ha-icon { width:24px; height:24px; }
  .phone-status-copy { display:flex; flex-direction:column; min-width:0; }
  .phone-status-copy small { color:var(--secondary-text-color); font-size:10px; font-weight:700; letter-spacing:.75px; text-transform:uppercase; }
  .phone-status-copy strong,.phone-status-copy span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .phone-status-copy strong { margin-top:2px; color:rgba(255,255,255,.96); font-size:16px; line-height:20px; }
  .phone-status-copy span { margin-top:2px; color:rgba(220,226,229,.72); font-size:12px; line-height:15px; }
  .phone-status-chevron { width:20px; height:20px; color:var(--secondary-text-color); }
  .phone-status-ticker { height:52px; overflow:hidden; border-top:1px solid rgba(255,255,255,.075); white-space:nowrap; }
  .phone-status-ticker-track { display:flex; width:max-content; min-width:100%; height:100%; animation:phone-status-marquee var(--home-status-phone-ticker-seconds,32s) linear infinite; will-change:transform; }
  .phone-status-ticker-sequence { display:flex; flex:0 0 auto; align-items:stretch; height:100%; }
  .phone-status-ticker-item { position:relative; display:inline-flex; align-items:center; gap:8px; min-width:max-content; height:100%; padding:0 16px; box-sizing:border-box; color:inherit; }
  .phone-status-ticker-item + .phone-status-ticker-item::before,.phone-status-ticker-sequence + .phone-status-ticker-sequence .phone-status-ticker-item:first-child::before { content:""; position:absolute; left:0; width:1px; height:28px; background:rgba(255,255,255,.18); }
  .phone-status-ticker-item ha-icon { flex:0 0 auto; width:20px; height:20px; }
  .phone-status-ticker-copy { display:flex; flex-direction:column; justify-content:center; min-width:0; line-height:1.12; }
  .phone-status-ticker-copy strong { color:rgba(255,255,255,.92); font-size:12px; font-weight:600; }
  .phone-status-ticker-copy small { display:block; max-width:220px; margin-top:3px; overflow:hidden; color:var(--secondary-text-color); font-size:10px; opacity:.78; text-overflow:ellipsis; white-space:nowrap; }
  @keyframes phone-status-marquee { to { transform:translateX(-50%); } }
}
:host([data-profile="phone"]) .utility-header,
:host([data-profile="phone"]) .ticker,
:host([data-profile="phone"]) .drawer-host { display:none !important; }
:host([data-profile="phone"]) .phone-status-host { display:block; }
:host([data-profile="tablet"]) .phone-status-host,
:host([data-profile="desktop"]) .phone-status-host { display:none !important; }
:host([data-profile="tablet"]) .utility-header,
:host([data-profile="desktop"]) .utility-header { display:grid; }
:host([data-profile="tablet"]) .ticker,
:host([data-profile="desktop"]) .ticker { display:flex; }
:host([data-profile="tablet"]) .drawer-host,
:host([data-profile="desktop"]) .drawer-host { display:block; }
@media (prefers-reduced-motion:reduce) {
  .phone-status-ticker-track { animation:none; }
  .phone-status-ticker-sequence[aria-hidden="true"] { display:none; }
}
`;

if (!customElements.get('home-status-card-editor')) customElements.define('home-status-card-editor', HomeStatusCardEditor);
if (!customElements.get('home-status-card')) customElements.define('home-status-card', HomeStatusCard);
window.customCards = window.customCards || [];
if (!window.customCards.some(card => card.type === 'home-status-card')) window.customCards.push({ type: 'home-status-card', name: 'Home Status Card', description: 'Home Status ticker with local notification drawer', preview: true });
