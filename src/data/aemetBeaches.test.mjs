import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_OPTIONS,
  WATER_TEMP_COLOR_STOPS,
  buildAemetBeachSelectionCopy,
  createAemetBeachesLayer,
  createAemetBeachSelectedOverlayEntry,
  normalizeAemetBeachesPayload,
  waterTempColorRgb,
} from './aemetBeaches.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const GOOD_BEACH = Object.freeze({
  id: '2906707',
  name: 'La Malagueta',
  lat: 36.719166666666666,
  lon: -4.4077777777777785,
  forecast: Object.freeze({
    municipioId: '29067',
    date: '20260913',
    sky: 'despejado',
    wind: 'flojo',
    waves: 'débil',
    waterTempC: 23,
    maxTempC: 30,
    uvMax: 7,
    thermalSensation: 'calor agradable',
  }),
});

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove() { return true; },
    },
    entities: new Cesium.EntityCollection(),
    _dataSources: dataSources,
  };
}

test('payload normalization rejects a wholesale malformed response but keeps individually bad rows out', () => {
  assert.equal(normalizeAemetBeachesPayload({}), null);
  assert.equal(normalizeAemetBeachesPayload({ beaches: 'nope' }), null);
  const rows = normalizeAemetBeachesPayload({
    beaches: [
      GOOD_BEACH,
      { ...GOOD_BEACH, id: '' }, // unusable: skipped, does not fail the batch
      { ...GOOD_BEACH, lat: 999 }, // out of range: skipped
      { ...GOOD_BEACH, name: '' }, // no name: skipped
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '2906707');
});

test('a fresh update populates one colored point per beach and reports stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fetchedAt: Date.now(), stale: false, count: 1, beaches: [GOOD_BEACH] }),
    });
    assert.equal(await layer.update(viewer), true);
    const entities = viewer._dataSources[0].entities.values;
    assert.equal(entities.length, 1);
    assert.equal(entities[0].id, 'aemet-beaches:2906707');
    assert.ok(entities[0].point, 'rendered as a point graphic');
    const stats = layer.getStats();
    assert.equal(stats.count, 1);
    assert.equal(stats.error, null);
    assert.ok(Number.isFinite(stats.lastUpdate));
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a stale payload still renders but surfaces the staleness in stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stale: true, beaches: [GOOD_BEACH] }),
    });
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer._dataSources[0].entities.values.length, 1, 'stale beats empty');
    assert.match(layer.getStats().error, /stale/i);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a stale payload from an active background sweep is not reported as degraded — it is still filling in, not stuck', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stale: true, sweeping: true, beaches: [GOOD_BEACH] }),
    });
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer._dataSources[0].entities.values.length, 1);
    assert.equal(layer.getStats().error, null, 'the unfinished first sweep is not an error condition');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('missing key (503) and malformed payloads report failure without touching prior entities', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);

    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'AEMET_API_KEY not configured');
    assert.equal(viewer._dataSources[0].entities.values.length, 0);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ beaches: [GOOD_BEACH] }),
    });
    assert.equal(await layer.update(viewer), true);
    const count = viewer._dataSources[0].entities.values.length;
    assert.equal(count, 1);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ beaches: 'not-an-array' }),
    });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'Malformed AEMET response');
    assert.equal(viewer._dataSources[0].entities.values.length, count, 'a malformed refresh must not clear prior data');

    globalThis.fetch = async () => { throw new Error('network down'); };
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'AEMET network error');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('getAnalystRecords returns [] while disabled, and plain JSON-safe rows once enabled', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'disabled layer exposes nothing');
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ beaches: [GOOD_BEACH] }),
    });
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, '2906707');
    assert.equal(records[0].forecast.waterTempC, 23);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'output is JSON-safe');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('destroy tears down the data source and resets stats', () => {
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  layer.init(viewer);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), { count: 0, lastUpdate: null, error: null });
});

test('water temperature gradient is continuous, not a small set of stepped bands, and clamps at both ends', () => {
  assert.equal(waterTempColorRgb(NaN), null);
  assert.equal(waterTempColorRgb(undefined), null);
  assert.deepEqual(waterTempColorRgb(-5), WATER_TEMP_COLOR_STOPS[0].rgb);
  assert.deepEqual(waterTempColorRgb(40), WATER_TEMP_COLOR_STOPS.at(-1).rgb);
  assert.deepEqual(waterTempColorRgb(14), WATER_TEMP_COLOR_STOPS.find((s) => s.c === 14).rgb);
  const a = waterTempColorRgb(22);
  const b = waterTempColorRgb(22.5);
  assert.notDeepEqual(a, b, 'a continuous gradient must distinguish nearby values');
});

test('selection copy reports water temp, air max, sky, wind, waves and UV when known', () => {
  const { title, details } = buildAemetBeachSelectionCopy(GOOD_BEACH);
  assert.equal(title, 'La Malagueta');
  assert.deepEqual(details, [
    'Water 23°C',
    'Air max 30°C',
    'despejado',
    'Wind: flojo',
    'Waves: débil',
    'UV max 7',
  ]);

  const unknownWater = buildAemetBeachSelectionCopy({ name: 'X', forecast: {} });
  assert.equal(unknownWater.details[0], 'Water temp unknown');
  assert.doesNotMatch(unknownWater.details.join(' '), /undefined|NaN/);
});

test('selected overlay entry mirrors the UV-index card contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(GOOD_BEACH.lon, GOOD_BEACH.lat);
  const entry = createAemetBeachSelectedOverlayEntry('2906707', position, GOOD_BEACH);
  assert.equal(entry.id, '2906707');
  assert.equal(entry.position, position);
  assert.equal(entry.title, 'La Malagueta');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(createAemetBeachSelectedOverlayEntry(null, position, GOOD_BEACH), null);
  assert.equal(createAemetBeachSelectedOverlayEntry('x', null, GOOD_BEACH), null);
});

test('clicking a beach hides its point, adds one highlight entity, and publishes one card', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const layer = createAemetBeachesLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer); // no viewer.scene.canvas → click handler installs as a no-op, safely
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ beaches: [GOOD_BEACH] }),
    });
    await layer.update(viewer);
    const original = viewer._dataSources[0].entities.getById('aemet-beaches:2906707');
    assert.equal(original.point.show, undefined, 'unset show defaults to visible');
    const showValue = () => original.point.show.getValue(Cesium.JulianDate.now());

    layer._selectBeachForTest('2906707');
    assert.equal(showValue(), false, 'the base point hides while selected');
    assert.equal(viewer.entities.values.length, 1, 'exactly one highlight entity exists');
    assert.ok(viewer.entities.values[0].point);
    assert.equal(layer._selectedIdForTest(), '2906707');

    const publication = calls.find(([type]) => type === 'entries');
    assert.equal(publication[1], 'aemet-beaches-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].title, 'La Malagueta');
    assert.deepEqual(publication[3], AEMET_BEACHES_SELECTED_OVERLAY_SOURCE_OPTIONS);

    layer._clearSelectionForTest();
    assert.equal(showValue(), true, 'clearing restores the base point');
    assert.equal(viewer.entities.values.length, 0, 'the highlight entity is removed');
    assert.equal(layer._selectedIdForTest(), null);
    assert.deepEqual(calls.at(-1), ['clear', 'aemet-beaches-selected']);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('enable registers pick ownership for this layer only while enabled', () => {
  const viewer = fakeViewer();
  const layer = createAemetBeachesLayer();
  try {
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-beaches:2906707'), false);
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-beaches:2906707'), true);
    assert.equal(isOwnedByOtherLayer('someone-else', 'not-a-beach'), false);
    layer.disable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-beaches:2906707'), false, 'unregistered on disable');
  } finally {
    layer.destroy(viewer);
  }
});

test('a refresh re-resolves an open selection against fresh data, or clears it if the beach dropped out', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  const layer = createAemetBeachesLayer({ overlayHost });
  const respond = (beaches) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ beaches }) });
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond([GOOD_BEACH]);
    await layer.update(viewer);
    layer._selectBeachForTest('2906707');
    assert.equal(layer._selectedIdForTest(), '2906707');

    respond([{ ...GOOD_BEACH, forecast: { ...GOOD_BEACH.forecast, waterTempC: 24 } }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), '2906707', 'selection survives a refresh of the same beach');

    respond([{ ...GOOD_BEACH, id: '1101503', name: 'La Barrosa' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), null, 'selection clears when its beach disappears');
    assert.equal(viewer.entities.values.length, 0, 'no orphaned highlight entity remains');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});
