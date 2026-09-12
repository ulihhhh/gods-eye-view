import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAemetStationDescription,
  createAemetStationsLayer,
  normalizeAemetStationsPayload,
} from './aemetStations.js';

const GOOD_STATION = Object.freeze({
  id: '0002I',
  name: 'VANDELLÓS',
  lat: 40.95806,
  lon: 0.871385,
  altitudeM: 32,
  observedAtMs: 1_789_160_400_000,
  temperatureC: 24,
  humidityPct: 74,
  pressureHpa: 1017.4,
  windSpeedMs: 1.1,
  windDirectionDeg: 202,
  windGustMs: 3.9,
  precipitationMm: 0,
});

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(source) { dataSources.push(source); return source; },
      remove() { return true; },
    },
    _dataSources: dataSources,
  };
}

test('description table renders every field, with a dash for unknowns', () => {
  const html = buildAemetStationDescription(GOOD_STATION);
  assert.match(html, /24\.0°C/);
  assert.match(html, /74%/);
  assert.match(html, /1017\.4 hPa/);
  assert.match(html, /1\.1 m\/s @ 202°/);
  assert.match(html, /0002I/);
  const sparse = buildAemetStationDescription({ id: 'X' });
  assert.match(sparse, /—/);
  assert.doesNotMatch(sparse, /undefined|NaN/);
});

test('payload normalization rejects a wholesale malformed response but keeps individually bad rows out', () => {
  assert.equal(normalizeAemetStationsPayload({}), null, 'no stations array at all');
  assert.equal(normalizeAemetStationsPayload({ stations: 'nope' }), null);
  const rows = normalizeAemetStationsPayload({
    stations: [
      GOOD_STATION,
      { ...GOOD_STATION, id: '' }, // unplaceable: skipped, does not fail the batch
      { ...GOOD_STATION, lat: 999 }, // out of range: skipped
      null,
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '0002I');
});

test('a fresh update populates one colored point per station and reports stats', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetStationsLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ fetchedAt: Date.now(), stale: false, ttlMs: 1200000, count: 1, stations: [GOOD_STATION] }),
    });
    assert.equal(await layer.update(viewer), true);
    const entities = viewer._dataSources[0].entities.values;
    assert.equal(entities.length, 1);
    assert.equal(entities[0].id, 'aemet-station:0002I');
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
  const layer = createAemetStationsLayer();
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stale: true, stations: [GOOD_STATION] }),
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
  const layer = createAemetStationsLayer();
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
      json: async () => ({ stations: [GOOD_STATION] }),
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

test('getAnalystRecords returns [] while disabled, and plain JSON-safe rows once enabled', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetStationsLayer();
  try {
    layer.init(viewer);
    assert.deepEqual(layer.getAnalystRecords(), [], 'disabled layer exposes nothing');
    layer.enable(viewer);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stations: [GOOD_STATION] }),
    });
    await layer.update(viewer);
    const records = layer.getAnalystRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].id, '0002I');
    assert.equal(records[0].temperatureC, 24);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), records, 'output is JSON-safe');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('destroy tears down the data source and resets stats', () => {
  const viewer = fakeViewer();
  const layer = createAemetStationsLayer();
  layer.init(viewer);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), { count: 0, lastUpdate: null, error: null });
});
