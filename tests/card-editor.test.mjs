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
  assert.equal(registration.editorTag, 'HOME-STATUS-CARD-EDITOR');

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
  assert.equal(preset.visibility.hero, false);
  assert.deepEqual(preset.mystery_option, { nested: 'keep me' });

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
  const tablet = await renderAt(1024);
  assert.equal(tablet.phone, 'none');
  assert.notEqual(tablet.ticker, 'none');
  const desktop = await renderAt(1440, 'desktop');
  assert.equal(desktop.phone, 'none');
  assert.notEqual(desktop.ticker, 'none');
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
