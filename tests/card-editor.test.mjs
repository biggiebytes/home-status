import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = normalize(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const relative = pathname === '/' ? 'tests/browser-harness.html' : pathname.slice(1);
    const target = normalize(join(root, relative));
    if (!target.startsWith(root) || !(await stat(target)).isFile()) throw new Error('not found');
    response.writeHead(200, { 'content-type': types[extname(target)] || 'application/octet-stream' });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const systemBrowsers = process.platform === 'win32'
  ? [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ]
  : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
let executablePath;
for (const candidate of systemBrowsers) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Keep looking. Playwright's bundled browser remains the final fallback.
  }
}
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => customElements.get('home-status-card') && customElements.get('home-status-card-editor'));

  const registration = await page.evaluate(async () => ({
    picker: window.customCards.some(card => card.type === 'home-status-card'),
    stub: customElements.get('home-status-card').getStubConfig(),
    editorTag: (await customElements.get('home-status-card').getConfigElement()).tagName
  }));
  assert.equal(registration.picker, true, 'card is registered in the Lovelace picker');
  assert.equal(registration.stub.entity, 'sensor.home_status');
  assert.equal(registration.stub.utility_header.enabled, false);
  assert.equal(registration.stub.utility_header.security_entity, undefined);
  assert.equal(registration.stub.utility_header.music_entity, undefined);
 assert.equal(registration.stub.context_actions, undefined);
  assert.equal(registration.stub.time_entity, '');
  assert.equal(registration.stub.visibility, undefined);
  assert.equal(registration.stub.home_status_visibility.drawer, false);
  assert.deepEqual(registration.stub.grid_options, { columns: 36, rows: 7 });
  assert.equal(registration.editorTag, 'HOME-STATUS-CARD-EDITOR');

  const portraitTickerSpeed = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      bottom: { speed: 48 },
      phone_ticker: { speed: 18 }
    });
    return {
      bottom: card._config.bottom_speed,
      portrait: card._config.phone_ticker.speed,
      css: card.style.getPropertyValue('--home-status-phone-ticker-seconds')
    };
  });
  assert.deepEqual(portraitTickerSpeed, { bottom: 48, portrait: 18, css: '18s' });

  const transportContract = await page.evaluate(() => {
    const item = (id, title, category = 'activity') => ({
      id, title, message: title, summary: '', category,
      icon: 'mdi:information-outline', priority: 'normal', active: false
    });
    const fallback = item('legacy', 'Legacy payload');
    const manifest = {
      version: 1, kind: 'manifest', revision: 7,
      channels: Object.fromEntries(
        ['now', 'recent', 'household', 'weather', 'calendar', 'news', 'visual']
          .map(channel => [channel, { entity_id: `sensor.home_status_${channel}` }])
      ),
      streams: {
        left: ['now'], right: ['household'], bottom: ['recent'],
        phone_primary_id: 'now', phone_fallback: item('fallback', 'Fallback')
      }
    };
    const channel = (name, items = [], revision = 7) => ({
      state: String(items.length),
      attributes: { transport: { version: 1, kind: 'channel', channel: name, revision, items } }
    });
    const states = {
      'sensor.home_status': {
        state: 'normal',
        attributes: {
          priority: 'normal', active_count: 1, transport: manifest,
          native: { current: [fallback], recent: [], awareness: [], streams: { left: ['legacy'] } }
        }
      },
      'sensor.home_status_now': channel('now', [item('now', 'Now')]),
      'sensor.home_status_recent': channel('recent', [item('recent', 'Recent')]),
      'sensor.home_status_household': channel('household', [item('household', 'Household', 'location')]),
      'sensor.home_status_weather': channel('weather'),
      'sensor.home_status_calendar': channel('calendar'),
      'sensor.home_status_news': channel('news'),
      'sensor.home_status_visual': {
        state: 'available',
        attributes: { transport: { version: 1, kind: 'channel', channel: 'visual', revision: 7, visual: { type: 'image', url: 'https://example.test/visual.jpg' } } }
      }
    };
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    card.hass = { ...window.testHass, states };
    const split = card._data();
    states['sensor.home_status_news'].attributes.transport.revision = 6;
    card.hass = { ...window.testHass, states };
    const fallbackData = card._data();
    return {
      split: {
        left: split.left.map(entry => entry.title),
        right: split.right.map(entry => entry.title),
        bottom: split.bottom.map(entry => entry.title),
        visual: split.visual?.url
      },
      fallback: fallbackData.left.map(entry => entry.title)
    };
  });
  assert.deepEqual(transportContract.split, {
    left: ['Now'], right: ['Household'], bottom: ['Recent'],
    visual: 'https://example.test/visual.jpg'
  });
  assert.deepEqual(transportContract.fallback, ['Legacy payload']);

  const editorRefreshSafety = await page.evaluate(async () => {
    const editor = document.createElement('home-status-card-editor');
    editor.hass = window.testHass;
    editor.setConfig(customElements.get('home-status-card').getStubConfig());
    document.querySelector('#editor-host').replaceChildren(editor);
    const select = editor.shadowRoot.querySelector('[data-profile-picker]');
    select.dispatchEvent(new FocusEvent('focusin', { bubbles: true, composed: true }));
    editor.hass = {
      ...window.testHass,
      states: { ...window.testHass.states }
    };
    const retainedWhileFocused =
      editor.shadowRoot.querySelector('[data-profile-picker]') === select;
    select.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    const refreshedAfterBlur =
      editor.shadowRoot.querySelector('[data-profile-picker]') !== select;
    return { retainedWhileFocused, refreshedAfterBlur };
  });
  assert.deepEqual(editorRefreshSafety, {
    retainedWhileFocused: true,
    refreshedAfterBlur: true
  });

  const visualCenterTransitions = await page.evaluate(() => {
    const attributes = {
      ...window.testHass.states['sensor.home_status'].attributes,
      visual: null
    };
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status', profile: 'tablet' });
    const setVisual = visual => {
      card.hass = {
        ...window.testHass,
        states: {
        ...window.testHass.states,
          'sensor.home_status': { state: 'normal', attributes: { ...attributes, visual } },
          'camera.front_door': { entity_id: 'camera.front_door', state: 'idle', attributes: {} }
        }
      };
    };
    setVisual(null);
    document.querySelector('#card-host').replaceChildren(card);
    const zones = card.shadowRoot.querySelector('.ticker-zones');
    const initial = {
      visual: zones.querySelector('[data-visual-center]') !== null,
      hasVisual: zones.classList.contains('has-visual'),
      zoneCount: zones.querySelectorAll('[data-zone]').length
    };

    setVisual({ type: 'image', url: 'https://example.test/visual.jpg', priority: 'normal', live: false, resumable: true });
    const center = zones.querySelector('[data-visual-center]');
    const appeared = {
      hasVisual: zones.classList.contains('has-visual'),
      image: center?.firstElementChild?.tagName,
      src: center?.firstElementChild?.getAttribute('src')
    };

    setVisual({ type: 'video', url: 'https://example.test/visual.mp4', priority: 'attention', live: true, resumable: true });
    const changed = {
      sameCenter: center === zones.querySelector('[data-visual-center]'),
      video: center?.firstElementChild?.tagName,
      muted: center?.firstElementChild?.muted === true,
      controls: center?.firstElementChild?.controls === false
    };

    setVisual({ type: 'camera', entity_id: 'camera.front_door', priority: 'critical', live: true, resumable: true });
    const camera = center?.firstElementChild;
    const cameraResult = {
      tag: camera?.tagName,
      entity: camera?.getAttribute('camera-entity'),
      stateObject: camera?.stateObj?.entity_id
    };

    setVisual({ type: 'map', url: 'https://example.test/visual-map', priority: 'attention', live: false, resumable: true });
    const fallback = center?.textContent;

    setVisual(null);
    const disappeared = {
      visual: zones.querySelector('[data-visual-center]') !== null,
      hasVisual: zones.classList.contains('has-visual'),
      zoneCount: zones.querySelectorAll('[data-zone]').length
    };
    return { initial, appeared, changed, cameraResult, fallback, disappeared };
  });
  assert.deepEqual(visualCenterTransitions.initial, { visual: false, hasVisual: false, zoneCount: 2 });
  assert.deepEqual(visualCenterTransitions.appeared, { hasVisual: true, image: 'IMG', src: 'https://example.test/visual.jpg' });
  assert.deepEqual(visualCenterTransitions.changed, { sameCenter: true, video: 'VIDEO', muted: true, controls: true });
  assert.deepEqual(visualCenterTransitions.cameraResult, { tag: 'HA-CAMERA-STREAM', entity: 'camera.front_door', stateObject: 'camera.front_door' });
  assert.match(visualCenterTransitions.fallback, /not supported yet/);
  assert.deepEqual(visualCenterTransitions.disappeared, { visual: false, hasVisual: false, zoneCount: 2 });

  const hlsLifecycle = await page.evaluate(async () => {
    const instances = [];
    class FakeHls {
      static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed' };
      static isSupported() { return true; }
      constructor() { this.destroyed = false; instances.push(this); }
      on(event, callback) { if (event === FakeHls.Events.MANIFEST_PARSED) this.manifest = callback; }
      loadSource(url) { this.url = url; }
      attachMedia(video) { this.video = video; this.manifest?.(); }
      destroy() { this.destroyed = true; }
    }
    window.Hls = FakeHls;
    const originalCanPlayType = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = () => '';
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    card.hass = {
      ...window.testHass,
      states: { ...window.testHass.states, 'sensor.home_status': { state: 'normal', attributes: {
        ...window.testHass.states['sensor.home_status'].attributes,
        visual: { type: 'video', transport: 'hls', url: 'https://example.test/live.m3u8', live: true, priority: 'normal', mute: true }
      } } }
    };
    document.querySelector('#card-host').replaceChildren(card);
    await Promise.resolve();
    const instance = instances[0];
    const video = card.shadowRoot.querySelector('[data-visual-center] video');
    card.hass = { ...card.hass, states: { ...card.hass.states, 'sensor.home_status': { state: 'normal', attributes: { ...card.hass.states['sensor.home_status'].attributes, visual: null } } } };
    HTMLMediaElement.prototype.canPlayType = originalCanPlayType;
    return { source: instance?.url, muted: video?.muted, destroyed: instance?.destroyed };
  });
  assert.deepEqual(hlsLifecycle, { source: 'https://example.test/live.m3u8', muted: true, destroyed: true });

  const resolvedIconColors = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    return {
      closedDoor: card._iconSemanticClass({
        provider: 'security', message: 'Door Closed', state: 'resolved',
        active: false, resolved_at: '2026-08-05T06:00:00-04:00'
      }),
      clearedSmoke: card._iconSemanticClass({
        provider: 'security', message: 'Smoke Cleared', state: 'resolved',
        active: false, resolved_at: '2026-08-05T06:00:00-04:00'
      }),
      openDoor: card._iconSemanticClass({
        provider: 'security', message: 'Door Open', state: 'active',
        active: true, priority: 'attention'
      })
    };
  });
  assert.equal(resolvedIconColors.closedDoor, 'semantic-green');
  assert.equal(resolvedIconColors.clearedSmoke, 'semantic-green');
  assert.equal(resolvedIconColors.openDoor, 'semantic-orange');

  const cleanDefaults = await page.evaluate(() => {
    const editor = document.createElement('home-status-card-editor');
    editor.hass = window.testHass;
    editor.setConfig(customElements.get('home-status-card').getStubConfig());
    document.querySelector('#editor-host').replaceChildren(editor);
    const value = path => editor.shadowRoot.querySelector(`[data-path="${path}"]`)?.value;
    const card = document.createElement('home-status-card');
    card.setConfig(customElements.get('home-status-card').getStubConfig());
    return {
      securityEntity: value('utility_header.security_entity'),
      musicEntity: value('utility_header.music_entity'),
      securityPath: value('utility_header.security_path'),
      musicPath: value('utility_header.music_path'),
      calendarPath: value('context_actions.calendar.path'),
      camerasPath: value('context_actions.cameras.path'),
      lightsPath: value('context_actions.lighting.path'),
      timeEntity: value('time_entity'),
      runtimeSecurityEntity: card._config.utility_header.security_entity,
      runtimeMusicEntity: card._config.utility_header.music_entity,
      runtimeTimeEntity: card._config.time_entity,
      runtimeActions: card._contextActions({}).length
    };
  });
  assert.deepEqual(cleanDefaults, {
    securityEntity: '',
    musicEntity: '',
    securityPath: '',
    musicPath: '',
    calendarPath: '',
    camerasPath: '',
    lightsPath: '',
    timeEntity: '',
    runtimeSecurityEntity: '',
    runtimeMusicEntity: '',
    runtimeTimeEntity: '',
    runtimeActions: 0
  });

  const cardRegressionCoverage = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      grid_options: { columns: 'full', rows: 'auto' }
    });
    card.hass = window.testHass;
    document.querySelector('#card-host').replaceChildren(card);

    const automaticGrid = card.getGridOptions();
    card.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      grid_options: { columns: '8', rows: '6' }
    });
    const numericGrid = card.getGridOptions();

    const streamItem = document.createElement('button');
    streamItem.dataset.streamNavigation = '/details';
    card.shadowRoot.append(streamItem);
    let activated = false;
    card.addEventListener('location-changed', () => {
      activated = true;
    });
    card._bindStreamItems();
    streamItem.click();

    return {
      automaticGrid,
      numericGrid,
      streamBound: streamItem.dataset.bound,
      streamActivated: activated,
      streamPath: window.location.pathname
    };
  });
  assert.deepEqual(cardRegressionCoverage.automaticGrid, {
    columns: 36,
    rows: 7,
    min_columns: 3,
    min_rows: 2
  });
  assert.deepEqual(cardRegressionCoverage.numericGrid, {
    columns: 8,
    rows: 6,
    min_columns: 3,
    min_rows: 2
  });
  assert.equal(cardRegressionCoverage.streamBound, 'true');
  assert.equal(cardRegressionCoverage.streamActivated, true);
  assert.equal(cardRegressionCoverage.streamPath, '/details');

  const adaptiveZonePlacement = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      home_status_visibility: { hero: true, sidebar: true, footer: true, phone_ticker: true }
    });
    const compactHousehold = {
      id: 'presence',
      title: 'Everyone Away',
      summary: 'Tester: Away',
      provider: 'presence',
      priority: 'normal'
    };
    const verboseNews = {
      id: 'nhc-news',
      title: 'Atlantic Tropical Weather Outlook',
      summary: 'Tropical Weather Outlook from the National Hurricane Center with a detailed regional forecast and conditions.',
      provider: 'news',
      priority: 'normal'
    };
    const urgentHousehold = {
      id: 'leak',
      title: 'Water Leak Detected',
      summary: 'Kitchen sink moisture sensor is wet',
      provider: 'maintenance',
      priority: 'critical'
    };
    const flexible = card._zoneItems({ sidebar: [compactHousehold], hero: [verboseNews] });
    const priorityFirst = card._zoneItems({ sidebar: [compactHousehold], hero: [verboseNews, urgentHousehold] });
    const single = card._zoneItems({ sidebar: [], hero: [verboseNews] });
    return {
      flexibleLeft: flexible.left.map(item => item.id),
      flexibleRight: flexible.right.map(item => item.id),
      priorityLeft: priorityFirst.left.map(item => item.id),
      singleLeft: single.left.map(item => item.id),
      singleRight: single.right.map(item => item.id)
    };
  });
  assert.deepEqual(adaptiveZonePlacement.flexibleLeft, ['nhc-news']);
  assert.deepEqual(adaptiveZonePlacement.flexibleRight, ['presence']);
  assert.deepEqual(adaptiveZonePlacement.priorityLeft.slice(0, 2), ['leak', 'nhc-news']);
  assert.deepEqual(adaptiveZonePlacement.singleLeft, ['nhc-news']);
  assert.deepEqual(adaptiveZonePlacement.singleRight, []);

  const glanceableWeather = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    const markup = card._zoneMarkup({
      id: 'current:weather:weather.home',
      title: 'Weather',
      summary: '75° • Partlycloudy',
      provider: 'weather',
      icon: 'mdi:weather-partly-cloudy'
    }, '');
    return {
      markup,
      friendlyKnown: card._friendlyWeatherCondition('partlycloudy'),
      friendlyFallback: card._friendlyWeatherCondition('mostly-sunny')
    };
  });
  assert.match(glanceableWeather.markup, /is-brief is-current-weather/);
  assert.match(glanceableWeather.markup, />75°<\/span>/);
  assert.match(glanceableWeather.markup, />Partly cloudy<\/span>/);
  assert.doesNotMatch(glanceableWeather.markup, />Weather<\/span>/);
  assert.equal(glanceableWeather.friendlyKnown, 'Partly cloudy');
  assert.equal(glanceableWeather.friendlyFallback, 'Mostly sunny');

  const footerWeather = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    const item = {
      id: 'current:weather:weather.home',
      title: 'Weather',
      summary: '75° • Partlycloudy',
      provider: 'weather',
      icon: 'mdi:weather-partly-cloudy'
    };
    const display = card._formatFooterItem(item);
    card.shadowRoot.innerHTML = '<div class="bottom-stream"></div>';
    card._renderFooterStream([item]);
    return { display, markup: card.shadowRoot.innerHTML };
  });
  assert.equal(footerWeather.display.title, '75°');
  assert.equal(footerWeather.display.summary, 'Partly cloudy');
  assert.equal(footerWeather.display.currentWeather, true);
  assert.match(footerWeather.markup, /footer-marquee-item is-current-weather/);
  assert.doesNotMatch(footerWeather.markup, />Weather<\/strong>/);

  const glanceableIndoorTemperature = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    const item = {
      id: 'current:climate:sensor.indoor_temperature',
      title: 'Indoor Temperature',
      summary: '78.0°F',
      provider: 'climate',
      icon: 'mdi:home-thermometer-outline'
    };
    const display = card._formatFooterItem(item);
    const markup = card._zoneMarkup(item, '');
    card.shadowRoot.innerHTML = '<div class="bottom-stream"></div>';
    card._renderFooterStream([item]);
    return { display, markup, footerMarkup: card.shadowRoot.innerHTML };
  });
  assert.equal(glanceableIndoorTemperature.display.title, '78°');
  assert.equal(glanceableIndoorTemperature.display.summary, 'Indoors');
  assert.equal(glanceableIndoorTemperature.display.indoorTemperature, true);
  assert.match(glanceableIndoorTemperature.markup, /is-indoor-temperature/);
  assert.match(glanceableIndoorTemperature.markup, />78°<\/span>/);
  assert.match(glanceableIndoorTemperature.markup, />Indoors<\/span>/);
  assert.doesNotMatch(glanceableIndoorTemperature.markup, />Indoor Temperature<\/span>/);
  assert.match(glanceableIndoorTemperature.footerMarkup, /footer-marquee-item is-indoor-temperature/);

  const weatherIconSizing = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status' });
    document.querySelector('#card-host').replaceChildren(card);
    const styles = card._styles();
    return {
      large: styles.includes('--mdc-icon-size:42px'),
      footer: styles.includes('--mdc-icon-size:34px')
    };
  });
  assert.deepEqual(weatherIconSizing, { large: true, footer: true });

  const original = {
    type: 'custom:home-status-card',
    entity: 'sensor.home_status',
    profile: 'auto',
    mystery_option: { nested: 'keep me' },
    context_actions: { custom: { type: 'navigate', path: '/custom' } }
  };
  const edited = await page.evaluate(async config => {
    const editor = document.createElement('home-status-card-editor');
    document.querySelector('#editor-host').append(editor);
    editor.hass = window.testHass;
    editor.setConfig(config);
    const changed = new Promise(resolve => editor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    const input = editor.shadowRoot.querySelector('[data-path="footer.speed"]');
    input.value = '44';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return changed;
  }, original);
  assert.equal(edited.footer.speed, 44);
  assert.deepEqual(edited.mystery_option, { nested: 'keep me' });
  assert.equal(edited.context_actions.custom.path, '/custom');

  const reopened = await page.evaluate(config => {
    const editor = document.createElement('home-status-card-editor');
    editor.hass = window.testHass;
    editor.setConfig(config);
    document.querySelector('#editor-host').replaceChildren(editor);
    return {
      speed: editor.shadowRoot.querySelector('[data-path="footer.speed"]').value,
      preserved: editor.shadowRoot.textContent.includes('mystery_option')
    };
  }, edited);
  assert.equal(reopened.speed, '44');
  assert.equal(reopened.preserved, true);

  const guidedEditor = await page.evaluate(async () => {
    const editor = document.querySelector('home-status-card-editor');
    editor.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      profile: 'desktop',
      grid_options: { columns: 12, rows: 2 },
      home_status_visibility: {
        hero: false,
        sidebar: false,
        footer: false,
        phone_ticker: false,
        drawer: true
      },
      context_actions: {},
      visibility: [{ condition: 'screen', media_query: '(min-width: 600px)' }],
      mystery_option: { keep: true }
    });
    const recommendedInitially = !editor.shadowRoot.querySelector('.recommended-card').hidden;
    const customizeInitially = editor.shadowRoot.querySelector('details[data-section="visibility"]').hidden;
    const advancedInitially = editor.shadowRoot.querySelector('details[data-section="sizing"]').hidden;
    const warningText = editor.shadowRoot.querySelector('.warning')?.textContent || '';

    editor.shadowRoot.querySelector('[data-editor-level="customize"]').click();
    const customizeVisible = !editor.shadowRoot.querySelector('details[data-section="visibility"]').hidden;
    const advancedHiddenInCustomize = editor.shadowRoot.querySelector('details[data-section="sizing"]').hidden;
    const visibilitySection = editor.shadowRoot.querySelector('details[data-section="visibility"]');
    visibilitySection.open = true;
    const normalToggle = editor.shadowRoot.querySelector('[data-path="show_normal_items"]');
    const changed = new Promise(resolve => editor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    normalToggle.checked = true;
    normalToggle.dispatchEvent(new Event('change', { bubbles: true }));
    const changedConfig = await changed;
    const stayedOpen = editor.shadowRoot.querySelector('details[data-section="visibility"]').open;

    editor.shadowRoot.querySelector('[data-editor-level="advanced"]').click();
    const advancedVisible = !editor.shadowRoot.querySelector('details[data-section="sizing"]').hidden;
    const restoreChanged = new Promise(resolve => editor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    editor.shadowRoot.querySelector('[data-editor-level="recommended"]').click();
    editor.shadowRoot.querySelector('[data-restore-recommended]').click();
    const restored = await restoreChanged;
    return {
      recommendedInitially,
      customizeInitially,
      advancedInitially,
      customizeVisible,
      advancedHiddenInCustomize,
      advancedVisible,
      stayedOpen,
      changedNormalItems: changedConfig.show_normal_items,
      warningText,
      restored
    };
  });
  assert.equal(guidedEditor.recommendedInitially, true);
  assert.equal(guidedEditor.customizeInitially, true);
  assert.equal(guidedEditor.advancedInitially, true);
  assert.equal(guidedEditor.customizeVisible, true);
  assert.equal(guidedEditor.advancedHiddenInCustomize, true);
  assert.equal(guidedEditor.advancedVisible, true);
  assert.equal(guidedEditor.stayedOpen, true, 'open editor section remains open after a field change');
  assert.equal(guidedEditor.changedNormalItems, true);
  assert.match(guidedEditor.warningText, /36 columns/);
  assert.match(guidedEditor.warningText, /at least 7 rows/);
  assert.match(guidedEditor.warningText, /appear empty/);
  assert.match(guidedEditor.warningText, /no navigation buttons/);
  assert.equal(guidedEditor.restored.profile, 'auto');
  assert.deepEqual(guidedEditor.restored.grid_options, { columns: 36, rows: 7 });
  assert.equal(guidedEditor.restored.home_status_visibility.hero, true);
  assert.deepEqual(guidedEditor.restored.visibility, [
    { condition: 'screen', media_query: '(min-width: 600px)' }
  ]);
  assert.deepEqual(guidedEditor.restored.mystery_option, { keep: true });

  const sectionState = await page.evaluate(async config => {
    const editor = document.querySelector('home-status-card-editor');
    editor.setConfig(config);
    const profile = editor.shadowRoot.querySelector('details[data-section="profile"]');
    const navigation = editor.shadowRoot.querySelector('details[data-section="navigation"]');
    profile.open = false;
    navigation.open = true;
    const changed = new Promise(resolve => editor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    const input = editor.shadowRoot.querySelector('[data-path="utility_header.security_path"]');
    input.value = '/security';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const updated = await changed;
    editor.setConfig(updated);
    return {
      profile: editor.shadowRoot.querySelector('details[data-section="profile"]').open,
      navigation: editor.shadowRoot.querySelector('details[data-section="navigation"]').open
    };
  }, edited);
  assert.deepEqual(sectionState, { profile: false, navigation: true });

 const preset = await page.evaluate(async config => {
    const editor = document.querySelector('home-status-card-editor');
    editor.setConfig(config);
    const changed = new Promise(resolve => editor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    const picker = editor.shadowRoot.querySelector('[data-profile-picker]');
    picker.value = 'phone';
    editor.shadowRoot.querySelector('[data-apply-profile]').click();
    return changed;
  }, edited);
  assert.equal(preset.profile, 'phone');
  assert.equal(preset.home_status_visibility.hero, false);
  assert.deepEqual(preset.mystery_option, { nested: 'keep me' });

  const presetPreviews = await page.evaluate(async () => {
    const results = {};
    const expectedProfiles = ['auto', 'phone', 'tablet', 'desktop'];
    for (const profile of expectedProfiles) {
      const editor = document.createElement('home-status-card-editor');
      editor.hass = window.testHass;
      editor.setConfig(customElements.get('home-status-card').getStubConfig());
      document.querySelector('#editor-host').replaceChildren(editor);
      const changed = new Promise(resolve => editor.addEventListener(
        'config-changed', event => resolve(event.detail.config), { once: true }
      ));
      editor.shadowRoot.querySelector('[data-profile-picker]').value = profile;
      editor.shadowRoot.querySelector('[data-apply-profile]').click();
      const config = await changed;
      const card = document.createElement('home-status-card');
      card.setConfig(config);
      card.hass = window.testHass;
      document.querySelector('#card-host').replaceChildren(card);
      await new Promise(resolve => requestAnimationFrame(resolve));
      results[profile] = {
        profile: card.getAttribute('data-profile'),
        layout: card.getAttribute('data-layout'),
        phone: getComputedStyle(card.shadowRoot.querySelector('.phone-status-host')).display,
        ticker: getComputedStyle(card.shadowRoot.querySelector('.ticker')).display
      };
    }
    return results;
  });
  assert.equal(presetPreviews.auto.layout, 'responsive');
  assert.equal(presetPreviews.phone.layout, 'compact');
  assert.notEqual(presetPreviews.phone.phone, 'none');
  assert.equal(presetPreviews.phone.ticker, 'none');
  assert.equal(presetPreviews.tablet.layout, 'tablet-default');
  assert.equal(presetPreviews.tablet.phone, 'none');
  assert.notEqual(presetPreviews.tablet.ticker, 'none');
  assert.equal(presetPreviews.desktop.layout, 'desktop-wide');
  assert.equal(presetPreviews.desktop.phone, 'none');
  assert.notEqual(presetPreviews.desktop.ticker, 'none');

  const missingWarning = await page.evaluate(() => {
    const editor = document.querySelector('home-status-card-editor');
    editor.setConfig({ type: 'custom:home-status-card', entity: 'sensor.missing' });
    return editor.shadowRoot.textContent.includes('Home Status sensor not found');
  });
  assert.equal(missingWarning, true);

  const renderAt = async (width, profile = 'auto') => {
    await page.setViewportSize({ width, height: 900 });
    return page.evaluate(({ profile }) => {
      const card = document.createElement('home-status-card');
      card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.home_status', profile });
      card.hass = window.testHass;
      document.querySelector('#card-host').replaceChildren(card);
      const style = selector => getComputedStyle(card.shadowRoot.querySelector(selector)).display;
      return {
        phone: style('.phone-status-host'),
        ticker: style('.ticker'),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      };
    }, { profile });
  };
  for (const width of [360, 390, 430]) {
    const result = await renderAt(width);
    assert.notEqual(result.phone, 'none', `phone status visible at ${width}px`);
    assert.equal(result.ticker, 'none', `tablet ticker hidden at ${width}px`);
    assert.equal(result.overflow, false, `no horizontal overflow at ${width}px`);
  }
  for (const profile of ['desktop', 'tablet']) {
    const result = await renderAt(430, profile);
    assert.equal(result.phone, 'none', `phone status hidden for forced ${profile} profile`);
    assert.notEqual(result.ticker, 'none', `full card visible for forced ${profile} profile in a narrow container`);
  }
  const tablet = await renderAt(1024);
  assert.equal(tablet.phone, 'none');
  assert.notEqual(tablet.ticker, 'none');
  const desktop = await renderAt(1440, 'desktop');
  assert.equal(desktop.phone, 'none');
  assert.notEqual(desktop.ticker, 'none');

  await page.setViewportSize({ width: 1024, height: 520 });
  const drawerLayoutStability = await page.evaluate(async () => {
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const card = document.createElement('home-status-card');
    card.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      profile: 'desktop',
      utility_header: {
        enabled: true,
        music_entity: 'media_player.living_room'
      },
      context_actions: {
        calendar: { type: 'navigate', path: '/calendar' }
      },
      home_status_visibility: { drawer: true }
    });
    card.hass = window.testHass;
    document.querySelector('#card-host').replaceChildren(card);
    await nextFrame();

    const measure = () => {
      const header = card.shadowRoot.querySelector('.utility-header');
      const music = card.shadowRoot.querySelector('.utility-music');
      const controls = card.shadowRoot.querySelector('.music-control-row');
      const slider = card.shadowRoot.querySelector('.music-volume');
      const roundedWidth = element => Math.round(element.getBoundingClientRect().width * 100) / 100;
      return {
        cardWidth: roundedWidth(card),
        headerWidth: roundedWidth(header),
        headerColumns: getComputedStyle(header).gridTemplateColumns,
        headerRows: getComputedStyle(header).gridTemplateRows,
        musicColumns: getComputedStyle(music).gridTemplateColumns,
        controlsColumns: getComputedStyle(controls).gridTemplateColumns,
        sliderWidth: roundedWidth(slider)
      };
    };

    const closed = measure();
    card.shadowRoot.querySelector('.ticker').click();
    await nextFrame();
    await nextFrame();
    const open = measure();
    return {
      closed,
      open,
      locked: card.hasAttribute('data-drawer-open'),
      lockedWidth: card.style.getPropertyValue('--home-status-drawer-inline-size')
    };
  });
  assert.deepEqual(drawerLayoutStability.open, drawerLayoutStability.closed);
  assert.equal(drawerLayoutStability.locked, true);
  assert.equal(
    drawerLayoutStability.lockedWidth,
    `${drawerLayoutStability.closed.cardWidth}px`
  );

  const drawerRegressionCoverage = await page.evaluate(async () => {
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const mount = config => {
      const card = document.createElement('home-status-card');
      card.setConfig({
        type: 'custom:home-status-card',
        entity: 'sensor.home_status',
        profile: 'desktop',
        ...config
      });
      card.hass = window.testHass;
      document.querySelector('#card-host').replaceChildren(card);
      return card;
    };

    const emptyCard = mount({
      context_actions: {},
      home_status_visibility: { drawer: true }
    });
    emptyCard.shadowRoot.querySelector('.ticker').click();
    await nextFrame();
    await nextFrame();
    const emptyHost = emptyCard.shadowRoot.querySelector('.drawer-host');
    const emptyDrawer = {
      expanded: emptyCard.shadowRoot.querySelector('.ticker').getAttribute('aria-expanded'),
      active: emptyHost.classList.contains('drawer-active'),
      panel: Boolean(emptyHost.querySelector('.context-bar')),
      actions: emptyHost.querySelectorAll('.context-action').length
    };

    window.history.replaceState({}, '', '/');
    const legacyCard = mount({
      context_actions: { cameras: { path: '/legacy-cameras' } },
      home_status_visibility: { drawer: true }
    });
    legacyCard.shadowRoot.querySelector('.ticker').click();
    await nextFrame();
    await nextFrame();
    const legacyAction = legacyCard.shadowRoot.querySelector('[data-context-action="cameras"]');
    legacyAction?.click();
    return {
      emptyDrawer,
      legacyRendered: Boolean(legacyAction),
      legacyPath: window.location.pathname
    };
  });
  assert.deepEqual(drawerRegressionCoverage.emptyDrawer, {
    expanded: 'true',
    active: true,
    panel: true,
    actions: 0
  });
  assert.equal(drawerRegressionCoverage.legacyRendered, true);
  assert.equal(drawerRegressionCoverage.legacyPath, '/legacy-cameras');

  const visibilityCompatibility = await page.evaluate(async () => {
    const nativeRules = [{ condition: 'screen', media_query: '(min-width: 600px)' }];
    const nativeEditor = document.createElement('home-status-card-editor');
    nativeEditor.hass = window.testHass;
    nativeEditor.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      visibility: nativeRules,
      home_status_visibility: { drawer: false }
    });
    const nativeChanged = new Promise(resolve => nativeEditor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    const nativeToggle = nativeEditor.shadowRoot.querySelector('[data-path="home_status_visibility.drawer"]');
    nativeToggle.checked = true;
    nativeToggle.dispatchEvent(new Event('change', { bubbles: true }));

    const legacyEditor = document.createElement('home-status-card-editor');
    legacyEditor.hass = window.testHass;
    legacyEditor.setConfig({
      type: 'custom:home-status-card',
      entity: 'sensor.home_status',
      visibility: { hero: false, drawer: true }
    });
    const legacyChanged = new Promise(resolve => legacyEditor.addEventListener('config-changed', event => resolve(event.detail.config), { once: true }));
    const legacyToggle = legacyEditor.shadowRoot.querySelector('[data-path="home_status_visibility.hero"]');
    legacyToggle.checked = true;
    legacyToggle.dispatchEvent(new Event('change', { bubbles: true }));
    return { nativeConfig: await nativeChanged, legacyConfig: await legacyChanged };
  });
  assert.deepEqual(visibilityCompatibility.nativeConfig.visibility, [
    { condition: 'screen', media_query: '(min-width: 600px)' }
  ]);
  assert.equal(visibilityCompatibility.nativeConfig.home_status_visibility.drawer, true);
  assert.equal(visibilityCompatibility.legacyConfig.visibility, undefined);
  assert.equal(visibilityCompatibility.legacyConfig.home_status_visibility.hero, true);
  assert.equal(visibilityCompatibility.legacyConfig.home_status_visibility.drawer, true);
  const forcedPhone = await renderAt(1440, 'phone');
  assert.notEqual(forcedPhone.phone, 'none');
  assert.equal(forcedPhone.ticker, 'none');

  const missingCard = await page.evaluate(() => {
    const card = document.createElement('home-status-card');
    card.setConfig({ type: 'custom:home-status-card', entity: 'sensor.missing' });
    card.hass = window.testHass;
    document.querySelector('#card-host').replaceChildren(card);
    return card.shadowRoot.textContent.includes('Home Status is unavailable');
  });
  assert.equal(missingCard, true);

  console.log('Home Status card editor and responsive tests passed.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
