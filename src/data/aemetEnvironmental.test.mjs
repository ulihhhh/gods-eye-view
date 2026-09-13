import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_OPTIONS,
  OZONE_COLOR_STOPS,
  RADIATION_COLOR_STOPS,
  buildAemetEnvironmentalSelectionCopy,
  createAemetEnvironmentalLayer,
  createAemetEnvironmentalSelectedOverlayEntry,
  environmentalStationColor,
  normalizeAemetEnvironmentalPayload,
  ozoneColorRgb,
  radiationColorRgb,
} from './aemetEnvironmental.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const OZONE_ONLY_STATION = Object.freeze({
  indicativo: '1387', name: 'A Coruña', lat: 43.365969, lon: -8.421517,
  ozoneDobson: 285, globalRadiationSum: null,
});
const RADIATION_ONLY_STATION = Object.freeze({
  indicativo: '8178D', name: 'Albacete', lat: 38.9479, lon: -1.856,
  ozoneDobson: null, globalRadiationSum: 2333,
});
const BOTH_STATION = Object.freeze({
  indicativo: '3194U', name: 'Madrid, Ciudad Universitaria', lat: 40.4517, lon: -3.7242,
  ozoneDobson: 301, globalRadiationSum: 2100,
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
  assert.equal(normalizeAemetEnvironmentalPayload({}), null);
  assert.equal(normalizeAemetEnvironmentalPayload({ stations: 'nope' }), null);
  const rows = normalizeAemetEnvironmentalPayload({
    stations: [
      OZONE_ONLY_STATION,
      { ...OZONE_ONLY_STATION, indicativo: '' }, // unusable: skipped, does not fail the batch
      { ...OZONE_ONLY_STATION, lat: 999 }, // out of range: skipped
      { ...OZONE_ONLY_STATION, name: '' }, // no name: skipped
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].indicativo, '1387');
});

test('ozone and radiation color gradients are continuous and clamp at both ends', () => {
  assert.equal(ozoneColorRgb(NaN), null);
  assert.deepEqual(ozoneColorRgb(0), OZONE_COLOR_STOPS[0].rgb);
  assert.deepEqual(ozoneColorRgb(9999), OZONE_COLOR_STOPS.at(-1).rgb);
  assert.notDeepEqual(ozoneColorRgb(290), ozoneColorRgb(295), 'a continuous gradient must distinguish nearby values');

  assert.equal(radiationColorRgb(NaN), null);
  assert.deepEqual(radiationColorRgb(0), RADIATION_COLOR_STOPS[0].rgb);
  assert.deepEqual(radiationColorRgb(9999), RADIATION_COLOR_STOPS.at(-1).rgb);
});

test('environmentalStationColor colors by the active network type and falls back to unknown gray when that station has no reading for it', () => {
  const ozoneColor = environmentalStationColor(OZONE_ONLY_STATION, 'ozone');
  assert.notEqual(ozoneColor.toCssColorString(), Cesium.Color.fromBytes(90, 100, 110).toCssColorString());
  const radiationOfOzoneOnly = environmentalStationColor(OZONE_ONLY_STATION, 'radiation');
  assert.equal(radiationOfOzoneOnly.red, Cesium.Color.fromBytes(90, 100, 110).red, 'no radiation data → the unknown-gray fallback');
});

test('selection copy always shows both metrics, labeling an absent one rather than omitting or faking it', () => {
  const both = buildAemetEnvironmentalSelectionCopy(BOTH_STATION);
  assert.equal(both.title, 'Madrid, Ciudad Universitaria');
  assert.deepEqual(both.details, ['Ozone 301 DU', 'Radiation 2100 (10·kJ/m²)']);

  const ozoneOnly = buildAemetEnvironmentalSelectionCopy(OZONE_ONLY_STATION);
  assert.equal(ozoneOnly.details[1], 'Radiation: no data');
  const radiationOnly = buildAemetEnvironmentalSelectionCopy(RADIATION_ONLY_STATION);
  assert.equal(radiationOnly.details[0], 'Ozone: no data');
});

test('selected overlay entry mirrors the UV-index card contract and colors by the active network type', () => {
  const position = Cesium.Cartesian3.fromDegrees(BOTH_STATION.lon, BOTH_STATION.lat);
  const entry = createAemetEnvironmentalSelectedOverlayEntry('3194U', position, BOTH_STATION, 'ozone');
  assert.equal(entry.id, '3194U');
  assert.equal(entry.position, position);
  assert.equal(entry.title, 'Madrid, Ciudad Universitaria');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(createAemetEnvironmentalSelectedOverlayEntry(null, position, BOTH_STATION, 'ozone'), null);
  assert.equal(createAemetEnvironmentalSelectedOverlayEntry('x', null, BOTH_STATION, 'ozone'), null);
});

test('a fresh update populates one colored point per station and reports stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetEnvironmentalLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fetchedAt: Date.now(), stale: false, count: 2, stations: [OZONE_ONLY_STATION, RADIATION_ONLY_STATION] }),
    });
    assert.equal(await layer.update(viewer), true);
    const entities = viewer._dataSources[0].entities.values;
    assert.equal(entities.length, 2);
    assert.ok(entities.every((e) => e.point));
    const stats = layer.getStats();
    assert.equal(stats.count, 2);
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
  const layer = createAemetEnvironmentalLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stale: true, stations: [OZONE_ONLY_STATION] }),
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
  const layer = createAemetEnvironmentalLayer();
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
      json: async () => ({ stations: [OZONE_ONLY_STATION] }),
    });
    assert.equal(await layer.update(viewer), true);
    const count = viewer._dataSources[0].entities.values.length;
    assert.equal(count, 1);

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stations: 'not-an-array' }),
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

test('setParams({networkType}) switches the chip label, rejects invalid values, and recolors existing points', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetEnvironmentalLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ stations: [RADIATION_ONLY_STATION] }),
    });
    await layer.update(viewer);

    assert.equal(layer._networkTypeForTest(), 'ozone', 'ozone is the default mode');
    assert.equal(layer.getRowControls().chips[0].label, 'OZONE');
    const entity = viewer._dataSources[0].entities.getById('aemet-environmental:8178D');
    const grayBefore = entity.point.color.getValue(Cesium.JulianDate.now());
    assert.equal(grayBefore.red, Cesium.Color.fromBytes(90, 100, 110).red, 'a radiation-only station is gray under the ozone chip');

    assert.equal(layer.setParams({ networkType: 'radiation' }), true);
    assert.equal(layer._networkTypeForTest(), 'radiation');
    assert.equal(layer.getRowControls().chips[0].label, 'RADIATION');
    assert.equal(layer.getRowControls().chips[0].params.networkType, 'ozone', 'the chip always offers the OTHER mode next');
    const coloredAfter = entity.point.color.getValue(Cesium.JulianDate.now());
    assert.notEqual(coloredAfter.red, grayBefore.red, 'switching to radiation mode recolors the radiation-only station');

    assert.equal(layer.setParams({ networkType: 'bogus' }), false, 'an invalid network type is rejected');
    assert.equal(layer._networkTypeForTest(), 'radiation', 'a rejected setParams must not change state');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('getAnalystRecords returns [] while disabled, and plain JSON-safe rows once enabled', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetEnvironmentalLayer();
  try {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'disabled layer exposes nothing');
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stations: [BOTH_STATION] }),
    });
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].indicativo, '3194U');
    assert.equal(records[0].ozoneDobson, 301);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'output is JSON-safe');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('destroy tears down the data source and resets stats', () => {
  const viewer = fakeViewer();
  const layer = createAemetEnvironmentalLayer();
  layer.init(viewer);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), { count: 0, lastUpdate: null, error: null });
});

test('clicking a station hides its point, adds one highlight entity, and publishes one card', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const layer = createAemetEnvironmentalLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer); // no viewer.scene.canvas → click handler installs as a no-op, safely
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stations: [BOTH_STATION] }),
    });
    await layer.update(viewer);
    const original = viewer._dataSources[0].entities.getById('aemet-environmental:3194U');
    assert.equal(original.point.show, undefined, 'unset show defaults to visible');
    const showValue = () => original.point.show.getValue(Cesium.JulianDate.now());

    layer._selectStationForTest('3194U');
    assert.equal(showValue(), false, 'the base point hides while selected');
    assert.equal(viewer.entities.values.length, 1, 'exactly one highlight entity exists');
    assert.ok(viewer.entities.values[0].point);
    assert.equal(layer._selectedIdForTest(), '3194U');

    const publication = calls.find(([type]) => type === 'entries');
    assert.equal(publication[1], 'aemet-environmental-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].title, 'Madrid, Ciudad Universitaria');
    assert.deepEqual(publication[3], AEMET_ENVIRONMENTAL_SELECTED_OVERLAY_SOURCE_OPTIONS);

    layer._clearSelectionForTest();
    assert.equal(showValue(), true, 'clearing restores the base point');
    assert.equal(viewer.entities.values.length, 0, 'the highlight entity is removed');
    assert.equal(layer._selectedIdForTest(), null);
    assert.deepEqual(calls.at(-1), ['clear', 'aemet-environmental-selected']);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('enable registers pick ownership for this layer only while enabled', () => {
  const viewer = fakeViewer();
  const layer = createAemetEnvironmentalLayer();
  try {
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-environmental:3194U'), false);
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-environmental:3194U'), true);
    assert.equal(isOwnedByOtherLayer('someone-else', 'not-a-station'), false);
    layer.disable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-environmental:3194U'), false, 'unregistered on disable');
  } finally {
    layer.destroy(viewer);
  }
});

test('a refresh re-resolves an open selection against fresh data, or clears it if the station dropped out', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  const layer = createAemetEnvironmentalLayer({ overlayHost });
  const respond = (stations) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stations }) });
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond([BOTH_STATION]);
    await layer.update(viewer);
    layer._selectStationForTest('3194U');
    assert.equal(layer._selectedIdForTest(), '3194U');

    respond([{ ...BOTH_STATION, ozoneDobson: 310 }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), '3194U', 'selection survives a refresh of the same station');

    respond([{ ...BOTH_STATION, indicativo: '9443V', name: 'Zaragoza' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), null, 'selection clears when its station disappears');
    assert.equal(viewer.entities.values.length, 0, 'no orphaned highlight entity remains');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});
