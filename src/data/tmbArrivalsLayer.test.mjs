import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID,
  TMB_BUS_MAX_DISTANCE_M,
  TMB_CARD_REFRESH_MS,
  TMB_METRO_MAX_DISTANCE_M,
  createTmbArrivalsLayer,
  mergeArrivalPlaces,
  normalizeAmbStopsPayload,
  normalizeTmbCatalogPayload,
  parseTmbPlaceEntityId,
  tmbPlaceColorRgb,
  tmbPlaceEntityId,
} from './tmbArrivalsLayer.js';
import { isOwnedByOtherLayer } from './pickRegistry.js';

const STATION = Object.freeze({
  id: '6660100',
  name: 'Plaça Exemple',
  lat: 41.387,
  lon: 2.17,
  codes: [100, 300],
  lines: [
    { name: 'L1', color: 'CE1126' },
    { name: 'L3', color: '1EB53A' },
  ],
});
const STOP = Object.freeze({
  id: '108',
  name: 'Plaça B',
  lat: 41.37,
  lon: 2.15,
});
const CATALOG = { metro: [STATION], bus: [STOP], fetchedAt: 1 };

function fakeViewer() {
  const dataSources = [];
  return {
    dataSources: {
      add(source) {
        dataSources.push(source);
        return source;
      },
      remove() {
        return true;
      },
    },
    entities: new Cesium.EntityCollection(),
    _dataSources: dataSources,
  };
}

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** `amb` answers `/api/amb/stops`; `answer` everything else. */
function harness(answer, amb = json(200, { stops: [], fetchedAt: 1 })) {
  let clock = 100_000;
  const requests = [];
  const calls = [];
  const timers = [];
  const layer = createTmbArrivalsLayer({
    overlayHost: {
      setEntries: (...args) => calls.push(['entries', ...args]),
      setVisible: (...args) => calls.push(['visible', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return url === '/api/amb/stops' ? amb : answer(url);
    },
    now: () => clock,
    setIntervalImpl: (fn, ms) => timers.push({ fn, ms }) - 1,
    clearIntervalImpl: (id) => {
      timers[id] = null;
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  const lastCard = () =>
    calls.filter(([type]) => type === 'entries').at(-1)?.[2][0] ?? null;
  return {
    layer,
    viewer,
    requests,
    calls,
    timers,
    lastCard,
    advance(ms) {
      clock += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('entity ids round-trip and nothing else parses as a TMB place', () => {
  assert.equal(
    tmbPlaceEntityId('metro', '6660100'),
    'tmb-arrivals:metro:6660100',
  );
  assert.deepEqual(parseTmbPlaceEntityId('tmb-arrivals:bus:108'), {
    kind: 'bus',
    id: '108',
  });
  assert.equal(parseTmbPlaceEntityId('tmb-arrivals:tram:1'), null);
  assert.equal(parseTmbPlaceEntityId('aemet-beaches:1'), null);
  assert.equal(parseTmbPlaceEntityId(undefined), null);
});

test('interchanges are white, single-line stations take the line colour', () => {
  assert.deepEqual(tmbPlaceColorRgb('metro', STATION), [235, 235, 235]);
  assert.deepEqual(
    tmbPlaceColorRgb('metro', { lines: [{ color: 'CE1126' }] }),
    [206, 17, 38],
  );
  assert.deepEqual(
    tmbPlaceColorRgb('metro', { lines: [{ color: null }] }),
    [145, 164, 180],
  );
  assert.deepEqual(tmbPlaceColorRgb('bus', STOP), [218, 41, 28]);
});

test('catalogue payloads are validated row by row', () => {
  assert.equal(normalizeTmbCatalogPayload({ metro: [] }), null);
  const kept = normalizeTmbCatalogPayload({
    metro: [STATION, { ...STATION, lat: 'x' }],
    bus: [STOP, { ...STOP, id: 108 }, null],
  });
  assert.equal(kept.metro.length, 1);
  assert.equal(kept.bus.length, 1);
});

test('the catalogue draws metro stations from city scale and bus stops at street scale', async () => {
  const h = harness(() => json(200, CATALOG));
  try {
    assert.equal(await h.layer.update(), true);
    assert.deepEqual(h.requests.sort(), [
      '/api/amb/stops',
      '/api/tmb/stations',
    ]);
    const entities = h.viewer._dataSources[0].entities;
    const station = entities.getById('tmb-arrivals:metro:6660100');
    const stop = entities.getById('tmb-arrivals:bus:108');
    const far = (entity) =>
      entity.point.distanceDisplayCondition.getValue(Cesium.JulianDate.now())
        .far;
    assert.equal(far(station), TMB_METRO_MAX_DISTANCE_M);
    assert.equal(far(stop), TMB_BUS_MAX_DISTANCE_M);
    const depthTestOff = (entity) =>
      entity.point.disableDepthTestDistance.getValue(Cesium.JulianDate.now());
    assert.equal(
      depthTestOff(station),
      TMB_METRO_MAX_DISTANCE_M,
      'drawn over the 3D mesh for exactly as far as it is drawn',
    );
    assert.equal(depthTestOff(stop), TMB_BUS_MAX_DISTANCE_M);
    assert.deepEqual(h.layer.getStats().error, null);
    assert.equal(h.layer.getStats().count, 2);
    assert.equal(isOwnedByOtherLayer('transit', 'tmb-arrivals:bus:108'), true);
  } finally {
    h.layer.destroy(h.viewer);
  }
  assert.equal(isOwnedByOtherLayer('transit', 'tmb-arrivals:bus:108'), false);
});

test('with neither source the layer draws nothing and says where to add the key', async () => {
  const h = harness(
    () => json(503, { error: 'no_key' }),
    json(502, { error: 'unavailable' }),
  );
  try {
    assert.equal(await h.layer.update(), false);
    assert.match(h.layer.getStats().error, /POWER UP/);
    assert.equal(h.viewer._dataSources[0].entities.values.length, 0);
  } finally {
    h.layer.destroy(h.viewer);
  }
});

const AMB_STOPS = [
  { id: '000108', code: '108', name: 'Plaça B', lat: 41.37, lon: 2.15 },
  { id: '100005', code: '100005', name: 'Escola', lat: 41.36, lon: 2.09 },
];

test('without a TMB key every AMB stop is drawn, and the status says what is missing', async () => {
  const h = harness(
    () => json(503, { error: 'no_key' }),
    json(200, { stops: AMB_STOPS, fetchedAt: 1 }),
  );
  try {
    assert.equal(await h.layer.update(), true);
    const ids = h.viewer._dataSources[0].entities.values
      .map((e) => e.id)
      .sort();
    assert.deepEqual(ids, [
      'tmb-arrivals:amb:000108',
      'tmb-arrivals:amb:100005',
    ]);
    assert.match(h.layer.getStats().error, /AMB stops only.*TMB key/);
  } finally {
    h.layer.destroy(h.viewer);
  }
});

test('a stop both operators list is drawn once, as TMB (iBus includes AMB lines)', () => {
  const places = mergeArrivalPlaces(CATALOG, AMB_STOPS);
  assert.deepEqual([...places.keys()].sort(), [
    'tmb-arrivals:amb:100005',
    'tmb-arrivals:bus:108',
    'tmb-arrivals:metro:6660100',
  ]);
  assert.equal(mergeArrivalPlaces(null, AMB_STOPS).size, 2);
  assert.deepEqual(tmbPlaceColorRgb('amb', AMB_STOPS[1]), [255, 170, 0]);
  assert.deepEqual(parseTmbPlaceEntityId('tmb-arrivals:amb:100005'), {
    kind: 'amb',
    id: '100005',
  });
  assert.equal(
    normalizeAmbStopsPayload({
      stops: [{ ...AMB_STOPS[0], id: '108' }, AMB_STOPS[1]],
    }).length,
    1,
  );
  assert.equal(normalizeAmbStopsPayload({}), null);
});

test('clicking an AMB stop asks the AMB route and cites AMB', async () => {
  const fetchedAt = Date.UTC(2026, 9, 13, 10, 0, 0);
  const h = harness(
    (url) =>
      url === '/api/tmb/stations'
        ? json(503, { error: 'no_key' })
        : json(200, {
            kind: 'amb',
            id: '100005',
            fetchedAt,
            routes: [
              {
                line: 'L20',
                destination: 'St. Joan D.',
                arrivals: [100_000 + 125_000],
              },
            ],
          }),
    json(200, { stops: AMB_STOPS, fetchedAt: 1 }),
  );
  try {
    await h.layer.update();
    h.layer._selectPlaceForTest('tmb-arrivals:amb:100005');
    assert.deepEqual(h.lastCard().details, [
      'Bus stop 100005 · AMB',
      'Asking AMB for the next arrivals…',
    ]);
    await flush();
    assert.equal(h.requests.at(-1), '/api/amb/arrivals/100005');
    assert.deepEqual(h.lastCard().details, [
      'Bus stop 100005 · AMB',
      'L20 → St. Joan D. · 2 min',
      'Source: AMB Mobilitat · 12:00',
    ]);
  } finally {
    h.layer.destroy(h.viewer);
  }
});

test('clicking a station shows a loading card, then its arrivals, then counts down and refreshes', async () => {
  const fetchedAt = Date.UTC(2026, 9, 13, 10, 0, 0);
  let arrivalsAnswer = json(200, {
    kind: 'metro',
    id: STATION.id,
    fetchedAt,
    routes: [{ line: 'L1', destination: 'Nord', arrivals: [100_000 + 95_000] }],
  });
  const h = harness((url) =>
    url === '/api/tmb/stations' ? json(200, CATALOG) : arrivalsAnswer,
  );
  try {
    await h.layer.update();
    h.layer._selectPlaceForTest('tmb-arrivals:metro:6660100');
    const original = h.viewer._dataSources[0].entities.getById(
      'tmb-arrivals:metro:6660100',
    );
    assert.equal(original.point.show.getValue(Cesium.JulianDate.now()), false);
    assert.equal(h.viewer.entities.values.length, 1, 'one highlight point');
    assert.deepEqual(h.lastCard().details.slice(1), [
      'Asking TMB for the next arrivals…',
    ]);
    assert.equal(
      h.calls.filter(([t]) => t === 'entries').at(-1)[1],
      TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID,
    );
    await flush();
    assert.equal(h.requests.at(-1), '/api/tmb/arrivals/metro/6660100');
    assert.deepEqual(h.lastCard().details, [
      'Metro station · TMB · L1 L3',
      'L1 → Nord · 2 min',
      'Source: TMB iMetro · 12:00',
    ]);
    assert.equal(h.lastCard().title, '🚇 Plaça Exemple');

    // Countdown between refreshes, without asking TMB again.
    h.advance(14_000);
    h.layer._tickForTest();
    assert.equal(h.lastCard().details[1], 'L1 → Nord · 1 min');
    assert.equal(h.requests.length, 3);

    // A failed refresh keeps the last answer and says so.
    arrivalsAnswer = json(502, { error: 'unavailable' });
    h.advance(TMB_CARD_REFRESH_MS);
    h.layer._tickForTest();
    await flush();
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.lastCard().details.slice(1, 3), [
      'L1 → Nord · 1 min',
      'TMB unavailable · showing last answer',
    ]);

    h.layer._clearSelectionForTest();
    assert.equal(original.point.show.getValue(Cesium.JulianDate.now()), true);
    assert.equal(h.viewer.entities.values.length, 0);
    assert.deepEqual(h.calls.at(-1), [
      'clear',
      TMB_ARRIVALS_SELECTED_OVERLAY_SOURCE_ID,
    ]);
    assert.equal(
      h.timers.filter(Boolean).length,
      0,
      'the card timer stops with the card',
    );
  } finally {
    h.layer.destroy(h.viewer);
  }
});

test('an answer for a card already closed is dropped', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness((url) =>
    url === '/api/tmb/stations' ? json(200, CATALOG) : pending,
  );
  try {
    await h.layer.update();
    h.layer._selectPlaceForTest('tmb-arrivals:bus:108');
    h.layer._clearSelectionForTest();
    const published = h.calls.filter(([t]) => t === 'entries').length;
    release(json(200, { kind: 'bus', id: '108', fetchedAt: 1, routes: [] }));
    await flush();
    assert.equal(h.calls.filter(([t]) => t === 'entries').length, published);
    assert.equal(h.layer._selectionForTest(), null);
  } finally {
    h.layer.destroy(h.viewer);
  }
});

test('catalogue lines are validated; a server without them still works', () => {
  const line = {
    name: 'L1',
    color: 'CE1126',
    paths: [[2.17, 41.38, 2.18, 41.39]],
  };
  const kept = normalizeTmbCatalogPayload({
    ...CATALOG,
    lines: [line, { name: 'L2', paths: [[1, 2, 3]] }, null],
  });
  assert.deepEqual(kept.lines, [line]);
  assert.deepEqual(normalizeTmbCatalogPayload(CATALOG).lines, []);
});
