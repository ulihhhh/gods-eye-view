import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_OPTIONS,
  UV_INDEX_COLOR_STOPS,
  buildAemetUvIndexSelectionCopy,
  createAemetUvIndexLayer,
  createAemetUvIndexSelectedOverlayEntry,
  normalizeAemetUvIndexPayload,
  uvIndexCategory,
  uvIndexColorRgb,
} from './aemetUvIndex.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const GOOD_CITY = Object.freeze({
  municipioId: '28079',
  name: 'Madrid',
  uvIndex: 8,
  isCanaryIslands: false,
  lat: 40.4168,
  lon: -3.7038,
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
  assert.equal(normalizeAemetUvIndexPayload({}), null);
  assert.equal(normalizeAemetUvIndexPayload({ cities: 'nope' }), null);
  const rows = normalizeAemetUvIndexPayload({
    cities: [
      GOOD_CITY,
      { ...GOOD_CITY, municipioId: '' }, // unusable: skipped, does not fail the batch
      { ...GOOD_CITY, lat: 999 }, // out of range: skipped
      { ...GOOD_CITY, uvIndex: null }, // no value: skipped
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].municipioId, '28079');
});

test('a fresh update populates one colored point per city and reports stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetUvIndexLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fetchedAt: Date.now(), stale: false, count: 1, cities: [GOOD_CITY] }),
    });
    assert.equal(await layer.update(viewer), true);
    const entities = viewer._dataSources[0].entities.values;
    assert.equal(entities.length, 1);
    assert.equal(entities[0].id, 'aemet-uv-index:28079');
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
  const layer = createAemetUvIndexLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stale: true, cities: [GOOD_CITY] }),
    });
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer._dataSources[0].entities.values.length, 1, 'stale beats empty');
    assert.match(layer.getStats().error, /stale/i);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('missing key (503) and malformed payloads report failure without touching prior entities', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetUvIndexLayer();
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
      json: async () => ({ cities: [GOOD_CITY] }),
    });
    assert.equal(await layer.update(viewer), true);
    const count = viewer._dataSources[0].entities.values.length;
    assert.equal(count, 1);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cities: 'not-an-array' }),
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
  const layer = createAemetUvIndexLayer();
  try {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'disabled layer exposes nothing');
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cities: [GOOD_CITY] }),
    });
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].municipioId, '28079');
    assert.equal(records[0].uvIndex, 8);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'output is JSON-safe');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('destroy tears down the data source and resets stats', () => {
  const viewer = fakeViewer();
  const layer = createAemetUvIndexLayer();
  layer.init(viewer);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), { count: 0, lastUpdate: null, error: null });
});

test('UV color gradient is continuous, not a small set of stepped bands, and clamps at both ends', () => {
  assert.equal(uvIndexColorRgb(NaN), null);
  assert.equal(uvIndexColorRgb(undefined), null);
  assert.deepEqual(uvIndexColorRgb(-5), UV_INDEX_COLOR_STOPS[0].rgb);
  assert.deepEqual(uvIndexColorRgb(20), UV_INDEX_COLOR_STOPS.at(-1).rgb);
  assert.deepEqual(uvIndexColorRgb(0), UV_INDEX_COLOR_STOPS.find((s) => s.uv === 0).rgb);
  const a = uvIndexColorRgb(7);
  const b = uvIndexColorRgb(7.5);
  assert.notDeepEqual(a, b, 'a continuous gradient must distinguish nearby values');
});

test('uvIndexCategory follows the WHO scale boundaries', () => {
  assert.equal(uvIndexCategory(NaN), null);
  assert.equal(uvIndexCategory(0), 'Low');
  assert.equal(uvIndexCategory(2), 'Low');
  assert.equal(uvIndexCategory(3), 'Moderate');
  assert.equal(uvIndexCategory(5), 'Moderate');
  assert.equal(uvIndexCategory(6), 'High');
  assert.equal(uvIndexCategory(7), 'High');
  assert.equal(uvIndexCategory(8), 'Very High');
  assert.equal(uvIndexCategory(10), 'Very High');
  assert.equal(uvIndexCategory(11), 'Extreme');
  assert.equal(uvIndexCategory(15), 'Extreme');
});

test('selection copy reports the UV value and its category', () => {
  const { title, details } = buildAemetUvIndexSelectionCopy(GOOD_CITY);
  assert.equal(title, 'Madrid');
  assert.equal(details.length, 1);
  assert.equal(details[0], 'UV index 8 · Very High');

  const noCategory = buildAemetUvIndexSelectionCopy({ municipioId: 'X0001' });
  assert.doesNotMatch(noCategory.details.join(' '), /undefined|NaN/);
});

test('selected overlay entry mirrors the stations card contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(-3.7038, 40.4168);
  const entry = createAemetUvIndexSelectedOverlayEntry('28079', position, GOOD_CITY);
  assert.equal(entry.id, '28079');
  assert.equal(entry.position, position);
  assert.equal(entry.title, 'Madrid');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(createAemetUvIndexSelectedOverlayEntry(null, position, GOOD_CITY), null);
  assert.equal(createAemetUvIndexSelectedOverlayEntry('x', null, GOOD_CITY), null);
});

test('clicking a city hides its point, adds one highlight entity, and publishes one card', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const layer = createAemetUvIndexLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer); // no viewer.scene.canvas → click handler installs as a no-op, safely
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ cities: [GOOD_CITY] }),
    });
    await layer.update(viewer);
    const original = viewer._dataSources[0].entities.getById('aemet-uv-index:28079');
    assert.equal(original.point.show, undefined, 'unset show defaults to visible');
    const showValue = () => original.point.show.getValue(Cesium.JulianDate.now());

    layer._selectCityForTest('28079');
    assert.equal(showValue(), false, 'the base point hides while selected');
    assert.equal(viewer.entities.values.length, 1, 'exactly one highlight entity exists');
    assert.ok(viewer.entities.values[0].point);
    assert.equal(layer._selectedIdForTest(), '28079');

    const publication = calls.find(([type]) => type === 'entries');
    assert.equal(publication[1], 'aemet-uv-index-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].title, 'Madrid');
    assert.deepEqual(publication[3], AEMET_UV_INDEX_SELECTED_OVERLAY_SOURCE_OPTIONS);

    layer._clearSelectionForTest();
    assert.equal(showValue(), true, 'clearing restores the base point');
    assert.equal(viewer.entities.values.length, 0, 'the highlight entity is removed');
    assert.equal(layer._selectedIdForTest(), null);
    assert.deepEqual(calls.at(-1), ['clear', 'aemet-uv-index-selected']);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('enable registers pick ownership for this layer only while enabled', () => {
  const viewer = fakeViewer();
  const layer = createAemetUvIndexLayer();
  try {
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-uv-index:28079'), false);
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-uv-index:28079'), true);
    assert.equal(isOwnedByOtherLayer('someone-else', 'not-a-city'), false);
    layer.disable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-uv-index:28079'), false, 'unregistered on disable');
  } finally {
    layer.destroy(viewer);
  }
});

test('a refresh re-resolves an open selection against fresh data, or clears it if the city dropped out', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  const layer = createAemetUvIndexLayer({ overlayHost });
  const respond = (cities) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ cities }) });
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond([GOOD_CITY]);
    await layer.update(viewer);
    layer._selectCityForTest('28079');
    assert.equal(layer._selectedIdForTest(), '28079');

    respond([{ ...GOOD_CITY, uvIndex: 3 }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), '28079', 'selection survives a refresh of the same city');

    respond([{ ...GOOD_CITY, municipioId: '08019', name: 'Barcelona' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), null, 'selection clears when its city disappears');
    assert.equal(viewer.entities.values.length, 0, 'no orphaned highlight entity remains');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});
