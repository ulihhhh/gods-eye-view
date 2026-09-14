// Local ADS-B tap layer (issue #57) — lifecycle against a fake viewer, with
// `fetch` monkeypatched the same way src/data/earthquakes.test.mjs mocks its
// upstream. No real Cesium scene or dump1090 instance is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  buildLocalAdsbEntityOptions,
  createLocalAdsbLayer,
  localAdsbEntityId,
} from './localAdsb.js';

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(dataSource) { dataSources.push(dataSource); return dataSource; },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
    _dataSources: dataSources,
  };
}

function proxyRow(overrides = {}) {
  return {
    hex: 'a1b2c3',
    flight: 'UAL123',
    lat: 30.2672,
    lon: -97.7431,
    altitudeFt: 35000,
    trackDeg: 271.5,
    groundSpeedKt: 420,
    seenS: 1.2,
    ...overrides,
  };
}

function withMockedFetch(response, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response;
  return fn().finally(() => { globalThis.fetch = original; });
}

// ---------------------------------------------------------------------------
// buildLocalAdsbEntityOptions
// ---------------------------------------------------------------------------

test('buildLocalAdsbEntityOptions renders a flight-labeled point, distinct from Flights colors', () => {
  const options = buildLocalAdsbEntityOptions(proxyRow());
  assert.equal(options.id, localAdsbEntityId('a1b2c3'));
  assert.equal(options.label.text, 'UAL123\n35000 ft');
  // Flights uses WHITE (civilian), the amber MIL_TINT, and CYAN (tracked
  // highlight) — this must not collide with any of those.
  const forbidden = [Cesium.Color.WHITE, Cesium.Color.CYAN, Cesium.Color.fromCssColorString('#FFB800')];
  assert.ok(forbidden.every((c) => !options.point.color.equals(c)));
});

test('buildLocalAdsbEntityOptions falls back to the hex when no callsign is decoded', () => {
  const options = buildLocalAdsbEntityOptions(proxyRow({ flight: null }));
  assert.match(options.label.text, /^A1B2C3\n/);
});

// ---------------------------------------------------------------------------
// createLocalAdsbLayer lifecycle
// ---------------------------------------------------------------------------

test('the layer starts hidden — off by default per issue #57', () => {
  const viewer = fakeViewer();
  const layer = createLocalAdsbLayer();
  layer.init(viewer);
  assert.equal(viewer._dataSources[0].show, false);
  assert.equal(layer.getStats().enabled, false);
  layer.destroy(viewer);
});

test('enable shows the data source; a successful poll plots the received aircraft', async () => {
  const viewer = fakeViewer();
  const layer = createLocalAdsbLayer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(viewer._dataSources[0].show, true);

  await withMockedFetch({
    ok: true,
    status: 200,
    json: async () => ({
      receiverNowS: 100,
      aircraft: [proxyRow(), proxyRow({ hex: 'd4e5f6', flight: null })],
      stale: false,
      baseUrl: 'http://localhost:8080',
    }),
  }, () => layer.update(viewer));

  const entities = viewer._dataSources[0].entities.values;
  assert.equal(entities.length, 2);
  assert.deepEqual(entities.map((e) => e.id).sort(), [
    localAdsbEntityId('a1b2c3'),
    localAdsbEntityId('d4e5f6'),
  ]);
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.stale, false);
  assert.equal(stats.baseUrl, 'http://localhost:8080');
  assert.equal(stats.error, null);

  layer.destroy(viewer);
});

test('a stale proxy response is surfaced in stats without being treated as an error', async () => {
  const viewer = fakeViewer();
  const layer = createLocalAdsbLayer();
  layer.init(viewer);
  layer.enable(viewer);

  await withMockedFetch({
    ok: true,
    status: 200,
    json: async () => ({ aircraft: [proxyRow()], stale: true, baseUrl: 'http://localhost:8080' }),
  }, () => layer.update(viewer));

  const stats = layer.getStats();
  assert.equal(stats.stale, true);
  assert.equal(stats.error, null);
  assert.equal(stats.count, 1);

  layer.destroy(viewer);
});

test('an unreachable receiver records the error and leaves prior entities untouched', async () => {
  const viewer = fakeViewer();
  const layer = createLocalAdsbLayer();
  layer.init(viewer);
  layer.enable(viewer);

  await withMockedFetch({
    ok: true,
    status: 200,
    json: async () => ({ aircraft: [proxyRow()], stale: false, baseUrl: 'http://localhost:8080' }),
  }, () => layer.update(viewer));
  assert.equal(viewer._dataSources[0].entities.values.length, 1);

  await withMockedFetch({
    ok: false,
    status: 502,
    json: async () => ({ error: 'unreachable', baseUrl: 'http://localhost:8080' }),
  }, () => layer.update(viewer));

  const stats = layer.getStats();
  assert.equal(stats.error, 'unreachable');
  // The last good snapshot is left in place rather than being blanked by one
  // failed poll — same contract as the earthquakes layer.
  assert.equal(viewer._dataSources[0].entities.values.length, 1);

  layer.destroy(viewer);
});

test('disable hides the layer; destroy removes the data source', async () => {
  const viewer = fakeViewer();
  const layer = createLocalAdsbLayer();
  layer.init(viewer);
  layer.enable(viewer);
  layer.disable(viewer);
  assert.equal(viewer._dataSources[0].show, false);
  layer.destroy(viewer);
  assert.equal(viewer._dataSources.length, 0);
});
