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
