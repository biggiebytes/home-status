'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const frontendPath = path.join(
  __dirname,
  '..',
  'custom_components',
  'home_status',
  'frontend',
  'home-status-card.js'
);
const source = fs.readFileSync(frontendPath, 'utf8');

function methodSource(name) {
  const start = source.indexOf(`  ${name}(`);
  assert.notEqual(start, -1, `Missing frontend method ${name}`);
  const next = source.indexOf('\n  _', start + 3);
  assert.notEqual(next, -1, `Could not find end of frontend method ${name}`);
  return source.slice(start, next).trim();
}

const homeStatusObject = value => value || {};
const dashboardMethods = new Function(
  'homeStatusObject',
  `return ({
    ${methodSource('_splitTransportData')},
    ${methodSource('_visualModeCurrentItems')},
    ${methodSource('_visualModeHay')},
    ${methodSource('_visualModeDashboardModel')}
  });`
)(homeStatusObject);

const card = {
  ...dashboardMethods,
  _state: entityId => transportStates[entityId],
  _laneItemId: item => item?.id || '',
  _visualModeDetail: item => item?.detail || item?.summary || '',
  _visualModeFriendlyWhen: value => value,
  _visualModeNamedTile: () => null,
  _visualModeNavigationPath: () => '',
  _hass: { states: {} },
  _config: { context_actions: {} }
};

// Model the actual split-transport payload contract. The household item is
// read from sensor.home_status_household and merged by _splitTransportData().
const householdItem = {
    id: 'home_status:household_presence:awareness',
    source: 'household_presence',
    category: 'location',
    title: '1 of 2 Home',
    message: '1 of 2 Home',
    summary: 'Alex home · Jordan away',
    detail: 'Alex home · Jordan away',
    state: 'mixed',
    active: false
};
const channels = ['now', 'recent', 'household', 'weather', 'calendar', 'news', 'visual'];
const revision = 41;
const transportStates = Object.fromEntries(channels.map(channel => [
  `sensor.home_status_${channel}`,
  { attributes: { transport: {
    kind: 'channel', channel, revision,
    items: channel === 'household' ? [householdItem] : [],
    ...(channel === 'visual' ? { visual: {}, visual_queue: [] } : {})
  } } }
]));
const manifest = {
  kind: 'manifest',
  revision,
  channels: Object.fromEntries(channels.map(channel => [channel, {
    entity_id: `sensor.home_status_${channel}`
  }]))
};
const data = card._splitTransportData(
  { transport: manifest },
  { state: 'ok' },
  {},
  {}
);
assert.ok(data, 'Expected the complete household transport snapshot to parse');
assert.equal(data.household[0].title, '1 of 2 Home');
assert.equal(data.awareness[0].summary, 'Alex home · Jordan away');

const model = card._visualModeDashboardModel(data);
assert.equal(model.presence.value, '1 of 2 Home');
assert.equal(model.presence.detail, 'Alex home · Jordan away');
process.stdout.write('Household dashboard renders mixed presence from the transport item.\n');
