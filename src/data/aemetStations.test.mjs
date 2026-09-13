import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_OPTIONS,
  TEMPERATURE_COLOR_STOPS,
  buildAemetForecastSummaryLine,
  buildAemetStationDescription,
  buildAemetStationSelectionCopy,
  createAemetStationSelectedOverlayEntry,
  createAemetStationsLayer,
  normalizeAemetForecastPayload,
  normalizeAemetStationsPayload,
  temperatureColorRgb,
} from './aemetStations.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const GOOD_STATION = Object.freeze({
  id: '0002I',
  name: 'VANDELLÓS',
  lat: 40.95806,
  lon: 0.871385,
  altitudeM: 32,
  observedAtMs: 1_789_160_400_000,
  temperatureC: 24,
  temperatureMinC: 24,
  temperatureMaxC: 24.6,
  dewPointC: 19.1,
  humidityPct: 74,
  pressureHpa: 1017.4,
  pressureSeaLevelHpa: 1021.1,
  windSpeedMs: 1.1,
  windDirectionDeg: 202,
  windSpeedStdDevMs: 0.4,
  windDirectionStdDevDeg: 24,
  windGustMs: 3.9,
  windGustDirectionDeg: 230,
  precipitationMm: 0,
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

test('description table renders every field, including the newer ones, with a dash for unknowns', () => {
  const html = buildAemetStationDescription(GOOD_STATION);
  assert.match(html, /24\.0°C \(24\.0–24\.6°C\)/);
  assert.match(html, /19\.1°C/, 'dew point');
  assert.match(html, /74%/);
  assert.match(html, /1017\.4 hPa/);
  assert.match(html, /1021\.1 hPa/, 'sea-level pressure');
  assert.match(html, /1\.1 m\/s @ 202°/);
  assert.match(html, /σ 0\.4 m\/s @ 24°/, 'wind std-dev');
  assert.match(html, /3\.9 m\/s @ 230°/, 'gust with its own direction');
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
    assert.equal(records[0].dewPointC, 19.1);
    assert.equal(records[0].pressureSeaLevelHpa, 1021.1);
    assert.equal(records[0].windGustDirectionDeg, 230);
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

test('temperature gradient is continuous, not a small set of stepped bands', () => {
  assert.equal(temperatureColorRgb(NaN), null);
  assert.equal(temperatureColorRgb(undefined), null);
  // Clamps at both ends rather than extrapolating.
  assert.deepEqual(temperatureColorRgb(-50), TEMPERATURE_COLOR_STOPS[0].rgb);
  assert.deepEqual(temperatureColorRgb(80), TEMPERATURE_COLOR_STOPS.at(-1).rgb);
  // Exactly on a stop returns that stop's color.
  assert.deepEqual(temperatureColorRgb(0), TEMPERATURE_COLOR_STOPS.find((s) => s.c === 0).rgb);
  // Two nearby-but-different temperatures must render two DIFFERENT colors —
  // the whole point of replacing the stepped bands. 24.0 and 24.4 both fell
  // in the same stepped band before this change.
  const a = temperatureColorRgb(24.0);
  const b = temperatureColorRgb(24.4);
  assert.notDeepEqual(a, b, 'a continuous gradient must distinguish nearby temperatures');
  // Midpoint between two stops is the arithmetic mean of their colors.
  const lo = TEMPERATURE_COLOR_STOPS[0];
  const hi = TEMPERATURE_COLOR_STOPS[1];
  const mid = temperatureColorRgb((lo.c + hi.c) / 2);
  assert.deepEqual(mid, [
    Math.round((lo.rgb[0] + hi.rgb[0]) / 2),
    Math.round((lo.rgb[1] + hi.rgb[1]) / 2),
    Math.round((lo.rgb[2] + hi.rgb[2]) / 2),
  ]);
});

test('selection copy packs every field into four compact lines, omitting missing ones cleanly', () => {
  const { title, details } = buildAemetStationSelectionCopy(GOOD_STATION);
  assert.equal(title, 'VANDELLÓS');
  assert.equal(details.length, 4);
  assert.equal(details[0], '24.0°C (24.0–24.6) · dew 19.1°C · 74% RH');
  assert.equal(details[1], 'Wind 1.1 m/s @ 202° (σ0.4 m/s @ 24°) · gust 3.9 m/s @ 230°');
  assert.equal(details[2], '1017.4 hPa · MSL 1021.1 hPa');
  assert.equal(details[3], '0.0 mm precip · 32 m altitude');

  // A station missing every optional extra still reads cleanly — no dash
  // clutter, no dangling separators, no undefined/NaN leaking through.
  const sparse = buildAemetStationSelectionCopy({ id: 'X0001', temperatureC: 10, humidityPct: 50, windSpeedMs: 2, pressureHpa: 1000, precipitationMm: 0 });
  assert.equal(sparse.title, 'X0001');
  assert.equal(sparse.details[0], '10.0°C · 50% RH');
  assert.equal(sparse.details[1], 'Wind 2.0 m/s');
  assert.equal(sparse.details[2], '1000.0 hPa');
  assert.equal(sparse.details[3], '0.0 mm precip');
  assert.doesNotMatch(sparse.details.join(' '), /undefined|NaN|·\s*$/);

  const empty = buildAemetStationSelectionCopy({ id: 'X0002' });
  assert.doesNotMatch(empty.details.join(' '), /undefined|NaN/);
});

test('selected overlay entry mirrors the bikeshare card contract', () => {
  const position = Cesium.Cartesian3.fromDegrees(0.87, 40.96);
  const entry = createAemetStationSelectedOverlayEntry('0002I', position, GOOD_STATION);
  assert.equal(entry.id, '0002I');
  assert.equal(entry.position, position);
  assert.equal(entry.title, 'VANDELLÓS');
  assert.equal(entry.variant, 'selected');
  assert.equal(entry.selected, true);
  assert.equal(entry.protected, true);
  assert.equal(entry.paintLane, 'selected');
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(createAemetStationSelectedOverlayEntry(null, position, GOOD_STATION), null);
  assert.equal(createAemetStationSelectedOverlayEntry('x', null, GOOD_STATION), null);
});

test('selected overlay entry accent matches the point\'s own temperature color, not a fixed color', () => {
  const position = Cesium.Cartesian3.fromDegrees(0.87, 40.96);
  const hot = createAemetStationSelectedOverlayEntry('a', position, { ...GOOD_STATION, temperatureC: 33 });
  const cold = createAemetStationSelectedOverlayEntry('b', position, { ...GOOD_STATION, temperatureC: -10 });
  const [hr, hg, hb] = temperatureColorRgb(33);
  const toHex = (r, g, b) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  assert.equal(hot.accent, toHex(hr, hg, hb));
  assert.notEqual(hot.accent, cold.accent);

  const unknown = createAemetStationSelectedOverlayEntry('c', position, { ...GOOD_STATION, temperatureC: NaN });
  assert.equal(unknown.accent, '#91a4b4');
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
  const layer = createAemetStationsLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer); // no viewer.scene.canvas → click handler installs as a no-op, safely
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ stations: [GOOD_STATION] }),
    });
    await layer.update(viewer);
    const original = viewer._dataSources[0].entities.getById('aemet-station:0002I');
    // Never explicitly set in update(), so it's genuinely `undefined` (not
    // yet a wrapped Property) until _selectStation first assigns it — Cesium
    // treats an undefined show as default-visible.
    assert.equal(original.point.show, undefined, 'unset show defaults to visible');
    const showValue = () => original.point.show.getValue(Cesium.JulianDate.now());

    layer._selectStationForTest('0002I');
    assert.equal(showValue(), false, 'the base point hides while selected');
    assert.equal(viewer.entities.values.length, 1, 'exactly one highlight entity exists');
    assert.ok(viewer.entities.values[0].point);
    assert.equal(layer._selectedIdForTest(), '0002I');

    const publication = calls.find(([type]) => type === 'entries');
    assert.equal(publication[1], 'aemet-stations-selected');
    assert.equal(publication[2].length, 1);
    assert.equal(publication[2][0].title, 'VANDELLÓS');
    assert.deepEqual(publication[3], AEMET_STATIONS_SELECTED_OVERLAY_SOURCE_OPTIONS);

    layer._clearSelectionForTest();
    assert.equal(showValue(), true, 'clearing restores the base point');
    assert.equal(viewer.entities.values.length, 0, 'the highlight entity is removed');
    assert.equal(layer._selectedIdForTest(), null);
    assert.deepEqual(calls.at(-1), ['clear', 'aemet-stations-selected']);
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a refresh re-resolves an open selection against fresh data, or clears it if the station dropped out', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const overlayHost = { setEntries() {}, setVisible() {}, clearSource() {} };
  const layer = createAemetStationsLayer({ overlayHost });
  const respond = (stations) => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stations }) });
  };
  try {
    layer.init(viewer);
    layer.enable(viewer);
    respond([GOOD_STATION]);
    await layer.update(viewer);
    layer._selectStationForTest('0002I');
    assert.equal(layer._selectedIdForTest(), '0002I');

    // Same station, updated reading: selection survives and the highlight
    // reflects the NEW temperature, not a stale snapshot.
    respond([{ ...GOOD_STATION, temperatureC: 5 }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), '0002I', 'selection survives a refresh of the same station');

    // Station drops out of the feed entirely (e.g. went stale): selection
    // must not point at a destroyed entity.
    respond([{ ...GOOD_STATION, id: 'OTHER', name: 'ELSEWHERE' }]);
    await layer.update(viewer);
    assert.equal(layer._selectedIdForTest(), null, 'selection clears when its station disappears');
    assert.equal(viewer.entities.values.length, 0, 'no orphaned highlight entity remains');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('enable registers pick ownership for this layer only while enabled', () => {
  const viewer = fakeViewer();
  const layer = createAemetStationsLayer();
  try {
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-station:0002I'), false);
    layer.init(viewer);
    layer.enable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-station:0002I'), true);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-station:'), true, 'prefix match, not exact');
    assert.equal(isOwnedByOtherLayer('someone-else', 'not-a-station'), false);
    layer.disable(viewer);
    assert.equal(isOwnedByOtherLayer('someone-else', 'aemet-station:0002I'), false, 'unregistered on disable');
  } finally {
    layer.destroy(viewer);
  }
});

test('station points use a live ground clamp (RELATIVE_TO_GROUND), not a one-time terrain snapshot', async () => {
  // A one-time scene.sampleHeight() snapshot (tried first) only succeeds for
  // terrain tiles already loaded near wherever the camera CURRENTLY is —
  // fine for bikeshare's camera-gated per-city loading, wrong for ~850
  // stations nationwide regardless of camera position: most samples would
  // silently fail depending on what happened to be loaded during that poll,
  // and different polls landing on different loaded tiles is exactly what
  // looked like points drifting to "inexact positions" as the camera moved.
  // RELATIVE_TO_GROUND has Cesium re-clamp continuously against whatever
  // terrain is actually loaded at render time, so there's nothing to test
  // via a fake sampleHeight — this pins the CONFIGURATION, not a snapshot.
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const layer = createAemetStationsLayer();
  try {
    layer.init(viewer);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stations: [GOOD_STATION] }) });
    await layer.update(viewer);
    const entity = viewer._dataSources[0].entities.getById('aemet-station:0002I');
    assert.equal(
      entity.point.heightReference.getValue(Cesium.JulianDate.now()),
      Cesium.HeightReference.RELATIVE_TO_GROUND,
    );
    const position = entity.position.getValue(Cesium.JulianDate.now());
    assert.ok(
      Cesium.Cartesian3.equalsEpsilon(
        position,
        Cesium.Cartesian3.fromDegrees(GOOD_STATION.lon, GOOD_STATION.lat, 2.0),
        Cesium.Cartesian3.EPSILON7,
      ),
      'the raw position carries only the small offset — RELATIVE_TO_GROUND is what turns it into a real ground-relative height',
    );

    layer._selectStationForTest('0002I');
    const highlight = viewer.entities.values[0];
    assert.equal(
      highlight.point.heightReference.getValue(Cesium.JulianDate.now()),
      Cesium.HeightReference.RELATIVE_TO_GROUND,
      'the highlight marker must clamp the same way, or it floats/sinks relative to the base point it replaces',
    );
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

// ---------------------------------------------------------------------------
// Phase A2 — "next hours" forecast, fetched on selection and appended to the
// already-rendered card once it arrives.
// ---------------------------------------------------------------------------

test('buildAemetForecastSummaryLine formats a compact "Next hours" line and caps at `take`', () => {
  const hours = [
    { hour: 14, temperatureC: 23 },
    { hour: 15, temperatureC: 25.4 },
    { hour: 16, temperatureC: 27 },
    { hour: 17, temperatureC: 28 },
    { hour: 18, temperatureC: 26 },
  ];
  assert.equal(buildAemetForecastSummaryLine(hours), 'Next hours: 14:00 23°C · 15:00 25°C · 16:00 27°C · 17:00 28°C');
  assert.equal(buildAemetForecastSummaryLine(hours, 2), 'Next hours: 14:00 23°C · 15:00 25°C');
});

test('buildAemetForecastSummaryLine returns null for empty/missing input', () => {
  assert.equal(buildAemetForecastSummaryLine([]), null);
  assert.equal(buildAemetForecastSummaryLine(null), null);
  assert.equal(buildAemetForecastSummaryLine(undefined), null);
});

test('normalizeAemetForecastPayload requires an `hours` array', () => {
  assert.deepEqual(normalizeAemetForecastPayload({ hours: [{ hour: 1 }] }), [{ hour: 1 }]);
  assert.equal(normalizeAemetForecastPayload({ hours: 'nope' }), null);
  assert.equal(normalizeAemetForecastPayload(null), null);
});

test('selecting a station fetches its "next hours" forecast by lat/lon and appends it to the card', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(args),
    setVisible() {},
    clearSource() {},
  };
  const layer = createAemetStationsLayer({ overlayHost });
  const forecastCalls = [];
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/aemet/stations')) {
        return { ok: true, status: 200, json: async () => ({ stations: [GOOD_STATION] }) };
      }
      forecastCalls.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ hours: [{ hour: 15, temperatureC: 26 }, { hour: 16, temperatureC: 27 }] }),
      };
    };
    await layer.update(viewer);

    await layer._selectStationForTest('0002I');

    assert.equal(forecastCalls.length, 1);
    assert.ok(forecastCalls[0].includes(`lat=${GOOD_STATION.lat}`), "forecast request carries the station's lat");
    assert.ok(forecastCalls[0].includes(`lon=${GOOD_STATION.lon}`), "forecast request carries the station's lon");

    const lastPublication = calls.at(-1);
    assert.equal(lastPublication[0], 'aemet-stations-selected');
    assert.equal(lastPublication[1].length, 1);
    assert.equal(
      lastPublication[1][0].details.at(-1),
      'Next hours: 15:00 26°C · 16:00 27°C',
      'the forecast line is appended after the base reading details',
    );
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a forecast that resolves after the user has selected a different station is dropped, not applied', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(args),
    setVisible() {},
    clearSource() {},
  };
  const layer = createAemetStationsLayer({ overlayHost });
  const OTHER_STATION = { ...GOOD_STATION, id: 'OTHER', name: 'ELSEWHERE', lat: 41, lon: 1 };
  let resolveFirstForecast;
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/aemet/stations')) {
        return { ok: true, status: 200, json: async () => ({ stations: [GOOD_STATION, OTHER_STATION] }) };
      }
      if (String(url).includes(`lat=${GOOD_STATION.lat}`)) {
        // First station's forecast deliberately hangs until released below.
        return new Promise((resolve) => {
          resolveFirstForecast = () => resolve({
            ok: true, status: 200, json: async () => ({ hours: [{ hour: 9, temperatureC: 99 }] }),
          });
        });
      }
      return { ok: true, status: 200, json: async () => ({ hours: [{ hour: 10, temperatureC: 20 }] }) };
    };
    await layer.update(viewer);

    const firstSelection = layer._selectStationForTest('0002I'); // forecast fetch in flight, not yet resolved
    await layer._selectStationForTest('OTHER'); // second selection completes fully, including its own forecast

    const beforeStaleResolution = calls.length;
    resolveFirstForecast();
    await firstSelection;
    await Promise.resolve(); // let the stale .then chain finish settling

    assert.equal(calls.length, beforeStaleResolution, 'the stale forecast must not publish anything at all');
    assert.equal(layer._selectedIdForTest(), 'OTHER', 'the second selection remains current');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('a failed or malformed forecast response leaves the already-rendered card untouched', async () => {
  const originalFetch = globalThis.fetch;
  const viewer = fakeViewer();
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(args),
    setVisible() {},
    clearSource() {},
  };
  const layer = createAemetStationsLayer({ overlayHost });
  try {
    layer.init(viewer);
    layer.enable(viewer);
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('/api/aemet/stations')) {
        return { ok: true, status: 200, json: async () => ({ stations: [GOOD_STATION] }) };
      }
      return { ok: false, status: 500 };
    };
    await layer.update(viewer);
    await layer._selectStationForTest('0002I');

    assert.equal(calls.length, 1, 'only the synchronous base-card publication happened — no second, no crash');
    assert.equal(calls[0][1][0].details.length, 4, 'no forecast line was appended');
  } finally {
    globalThis.fetch = originalFetch;
    layer.destroy(viewer);
  }
});

test('only the single selected highlight skips depth testing — every other station point stays occludable by the globe', () => {
  const source = readFileSync(new URL('./aemetStations.js', import.meta.url), 'utf8');
  // A colon-suffixed match is an actual property assignment, not a comment
  // mentioning the property by name (update() explains why it's absent).
  const occurrences = source.match(/disableDepthTestDistance:/g) || [];
  assert.equal(
    occurrences.length,
    1,
    'exactly one use (the selected highlight in _selectStation) — a second one on the per-station points would make them render through the globe again',
  );
});
