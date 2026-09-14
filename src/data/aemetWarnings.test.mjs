import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_OPTIONS,
  aemetWarningZoneAnchor,
  buildAemetWarningPhenomenonLine,
  buildAemetWarningSelectionCopy,
  createAemetWarningSelectedOverlayEntry,
  createAemetWarningsLayer,
  normalizeAemetWarningsPayload,
} from './aemetWarnings.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const SINGLE_RING_ZONE = Object.freeze({
  geocode: '659101',
  name: 'Lanzarote',
  level: 'amarillo',
  levelRank: 1,
  polygons: [[[28.85, -13.87], [28.89, -13.88], [28.89, -13.86], [28.85, -13.87]]],
  phenomena: [
    {
      code: 'AT', name: 'Temperaturas máximas', event: 'Aviso de temperaturas máximas de nivel amarillo',
      level: 'amarillo', description: 'Temperatura máxima: 34 ºC.', instruction: 'Esté atento.',
      probability: '40%-70%', onsetMs: 1_789_297_200_000, expiresMs: 1_789_325_999_000, inEffect: false,
    },
  ],
});

const MULTI_RING_ZONE = Object.freeze({
  geocode: '611101',
  name: 'Grazalema',
  level: 'naranja',
  levelRank: 2,
  polygons: [
    [[36.89, -5.53], [36.92, -5.55], [36.98, -5.47], [36.89, -5.53]],
    [[36.37, -5.58], [36.39, -5.59], [36.44, -5.57], [36.37, -5.58]],
  ],
  phenomena: [
    {
      code: 'VI', name: 'Vientos', event: 'Aviso de vientos de nivel naranja', level: 'naranja',
      description: 'Rachas máximas: 100 km/h.', instruction: 'Extreme atención.', probability: '>70%',
      onsetMs: 1_789_200_000_000, expiresMs: 1_789_336_799_000, inEffect: true,
    },
    {
      code: 'CO', name: 'Costeros', event: 'Aviso costero de nivel amarillo', level: 'amarillo',
      description: 'Fenómenos costeros.', instruction: 'Esté atento.', probability: '40%-70%',
      onsetMs: 1_789_200_000_000, expiresMs: 1_789_336_799_000, inEffect: true,
    },
  ],
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

test('phenomenon line names the level, event, probability, and the right side of the validity window', () => {
  const inEffect = buildAemetWarningPhenomenonLine(MULTI_RING_ZONE.phenomena[0]);
  assert.match(inEffect, /^Naranja Vientos \(>70%\) — until/);
  const upcoming = buildAemetWarningPhenomenonLine(SINGLE_RING_ZONE.phenomena[0]);
  assert.match(upcoming, /^Amarillo Temperaturas máximas \(40%-70%\) — from/, 'not yet in effect: "from", not "until"');
});

test('selection copy lists every phenomenon on its own line, nothing collapsed away', () => {
  const { title, details } = buildAemetWarningSelectionCopy(MULTI_RING_ZONE);
  assert.equal(title, 'Grazalema');
  assert.equal(details.length, 2);
  assert.match(details[0], /Vientos/);
  assert.match(details[1], /Costeros/);

  const empty = buildAemetWarningSelectionCopy({ geocode: 'X', phenomena: [] });
  assert.deepEqual(empty.details, ['No active warning']);
});

test('zone anchor is the centroid of the FIRST ring, not an average across disjoint rings', () => {
  const anchor = aemetWarningZoneAnchor(MULTI_RING_ZONE.polygons);
  const ring = MULTI_RING_ZONE.polygons[0];
  const expectedLat = ring.reduce((s, [lat]) => s + lat, 0) / ring.length;
  const expectedLon = ring.reduce((s, [, lon]) => s + lon, 0) / ring.length;
  assert.equal(anchor.lat, expectedLat);
  assert.equal(anchor.lon, expectedLon);
  assert.equal(aemetWarningZoneAnchor([]), null);
  assert.equal(aemetWarningZoneAnchor(undefined), null);
});

test('selected overlay entry mirrors the stations card contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(-13.87, 28.87);
  const entry = createAemetWarningSelectedOverlayEntry('659101', position, SINGLE_RING_ZONE);
  assert.equal(entry.id, '659101');
  assert.equal(entry.position, position);
  assert.equal(entry.title, 'Lanzarote');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(createAemetWarningSelectedOverlayEntry(null, position, SINGLE_RING_ZONE), null);
  assert.equal(createAemetWarningSelectedOverlayEntry('x', null, SINGLE_RING_ZONE), null);
});

test('payload normalization drops zones with no geocode or no valid ring, keeps valid multi-ring zones', () => {
  assert.equal(normalizeAemetWarningsPayload({}), null, 'no zones array at all');
  assert.equal(normalizeAemetWarningsPayload({ zones: 'nope' }), null);
  const rows = normalizeAemetWarningsPayload({
    zones: [
      SINGLE_RING_ZONE,
      MULTI_RING_ZONE,
      { ...SINGLE_RING_ZONE, geocode: '' }, // unplaceable: skipped
      { ...SINGLE_RING_ZONE, geocode: 'Z', polygons: [] }, // no rings: skipped
      { ...SINGLE_RING_ZONE, geocode: 'Y', polygons: [[[1, 1], [2, 2]]] }, // fewer than 3 points: skipped
      { ...SINGLE_RING_ZONE, geocode: 'W', polygons: [[[91, 1], [2, 2], [3, 3]]] }, // out-of-range lat: skipped
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].polygons.length, 2, 'both Grazalema rings kept');
});

test('a fresh update renders one polygon entity per ring, colored by level', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ zones: [SINGLE_RING_ZONE, MULTI_RING_ZONE] }),
    });
    assert.equal(await layer.update(viewer), true);
    const entities = viewer._dataSources[0].entities.values;
    assert.equal(entities.length, 3, '1 ring for Lanzarote + 2 rings for Grazalema');
    assert.ok(entities.every((e) => e.polygon), 'every entity is a polygon graphic');
    assert.ok(entities.some((e) => e.id === 'aemet-warning:659101:0'));
    assert.ok(entities.some((e) => e.id === 'aemet-warning:611101:0'));
    assert.ok(entities.some((e) => e.id === 'aemet-warning:611101:1'));
    const stats = layer.getStats();
    assert.equal(stats.count, 2, 'stats count zones, not rings');
    assert.equal(stats.error, null);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('clicking a zone highlights every one of its rings and publishes one card', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['entries', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
  };
  const layer = createAemetWarningsLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ zones: [MULTI_RING_ZONE] }) });
    await layer.update(viewer);

    layer._selectZoneForTest('611101');
    assert.equal(layer._selectedGeocodeForTest(), '611101');
    const ring0 = viewer._dataSources[0].entities.getById('aemet-warning:611101:0');
    const ring1 = viewer._dataSources[0].entities.getById('aemet-warning:611101:1');
    assert.equal(ring0.polygon.outlineWidth.getValue(Cesium.JulianDate.now()), 3, 'ring 0 highlighted');
    assert.equal(ring1.polygon.outlineWidth.getValue(Cesium.JulianDate.now()), 3, 'ring 1 highlighted too');

    const publication = calls.find(([type]) => type === 'entries');
    assert.equal(publication[1], 'aemet-warnings-selected');
    assert.equal(publication[2].length, 1, 'one card, not one per ring');
    assert.equal(publication[2][0].title, 'Grazalema');
    assert.deepEqual(publication[3], AEMET_WARNINGS_SELECTED_OVERLAY_SOURCE_OPTIONS);

    layer._clearSelectionForTest();
    assert.equal(layer._selectedGeocodeForTest(), null);
    assert.equal(ring0.polygon.outlineWidth.getValue(Cesium.JulianDate.now()), 1, 'restored');
    assert.deepEqual(calls.at(-1), ['clear', 'aemet-warnings-selected']);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a refresh re-resolves an open selection against fresh data, or clears it if the zone dropped out', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  const layer = createAemetWarningsLayer({ overlayHost });
  const respond = (zones) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ zones }) });
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond([SINGLE_RING_ZONE]);
    await layer.update(viewer);
    layer._selectZoneForTest('659101');
    assert.equal(layer._selectedGeocodeForTest(), '659101');

    respond([{ ...SINGLE_RING_ZONE, level: 'rojo' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedGeocodeForTest(), '659101', 'selection survives a refresh of the same zone');

    respond([{ ...MULTI_RING_ZONE, geocode: 'OTHER' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedGeocodeForTest(), null, 'selection clears when its zone disappears');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('missing key (503) and malformed payloads report failure without touching prior entities', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);

    globalThis.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await layer.update(viewer), false);
    assert.equal(layer.getStats().error, 'AEMET_API_KEY not configured');

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ zones: [SINGLE_RING_ZONE] }) });
    assert.equal(await layer.update(viewer), true);
    const count = viewer._dataSources[0].entities.values.length;

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ zones: 'not-an-array' }) });
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

test('a stale payload still renders but surfaces the staleness in stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stale: true, zones: [SINGLE_RING_ZONE] }) });
    assert.equal(await layer.update(viewer), true);
    assert.equal(viewer._dataSources[0].entities.values.length, 1, 'stale beats empty');
    assert.match(layer.getStats().error, /stale/i);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('enable registers pick ownership for this layer only while enabled', () => {
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  try {
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-warning:659101:0'), false);
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-warning:659101:0'), true);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-warning:'), true, 'prefix match, not exact');
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-station:0002I'), false, 'distinct prefix from the stations layer');
    layer.disable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-warning:659101:0'), false, 'unregistered on disable');
  } finally {
    layer.destroy(viewer);
  }
});

test('getAnalystRecords returns one row per zone (not per ring), plain JSON-safe', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  try {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'disabled layer exposes nothing');
    layer.enable(viewer);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ zones: [MULTI_RING_ZONE] }) });
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 1, 'one row for Grazalema, despite 2 ring entities');
    assert.equal(records[0].geocode, '611101');
    assert.equal(records[0].phenomena.length, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'output is JSON-safe');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('destroy tears down the data source and resets stats', () => {
  const viewer = fakeViewer();
  const layer = createAemetWarningsLayer();
  layer.init(viewer);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), { count: 0, lastUpdate: null, error: null });
});
