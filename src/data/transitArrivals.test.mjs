import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransitArrivals } from './transitArrivals.js';
import { indexTripUpdates } from './transitServiceFields.js';
import { encodeTripUpdates } from './tripUpdatesFixtures.mjs';
import { fgcTripStopKey, fgcTripStopPlatform } from './transitFeedsSpain.js';
import { resolveTransitRoute } from './transitProxy.js';
import { createTransitService } from '../sources/transitService.js';

const NOW = Date.parse('2026-10-16T09:40:00Z'); // 11:40 in Barcelona
const min = (m) => NOW + m * 60_000;

/** Hand-made FGC-shaped trips: station code + track digit. Not operator data. */
const TRIPS = [
  {
    tripId: 'S1-down',
    stops: [
      { stopId: 'SR2', time: min(-3) },
      { stopId: 'GR2', time: min(2) },
      { stopId: 'PC2', time: min(6) },
    ],
  },
  {
    tripId: 'L7-up',
    stops: [
      { stopId: 'GR3', time: min(4) },
      { stopId: 'TB1', time: min(9) },
    ],
  },
  {
    // Not yet running: no vehicle in the snapshot.
    tripId: 'S2-later',
    stops: [
      { stopId: 'GR1', time: min(20) },
      { stopId: 'SR1', time: min(24) },
      { stopId: 'PN1', time: min(50) },
    ],
  },
  {
    // Already left Gràcia (beyond the grace) and a time hours away.
    tripId: 'stale',
    stops: [
      { stopId: 'GR4', time: min(-2) },
      { stopId: 'PC4', time: min(400) },
    ],
  },
];

const VEHICLES = [
  {
    tripId: 'S1-down',
    routeId: 'S1',
    destination: 'Pl. Catalunya',
    origin: 'Terrassa Nacions Unides',
    onTime: true,
  },
  {
    tripId: 'L7-up',
    routeId: 'L7',
    destination: 'Av. Tibidabo',
    origin: 'Pl. Catalunya',
    onTime: false,
  },
];

const NAMES = Object.freeze({
  GR: 'Gràcia',
  PC: 'Pl. Catalunya',
  PN: 'Sabadell Parc Nord',
  SR: 'Sarrià',
  TB: 'Av. Tibidabo',
});

function board(stationId, extra = {}) {
  return buildTransitArrivals({
    stationId,
    tripUpdates: indexTripUpdates(encodeTripUpdates(TRIPS, NOW)),
    vehicles: VEHICLES,
    stopKey: fgcTripStopKey,
    stopPlatform: fgcTripStopPlatform,
    stopNames: NAMES,
    now: NOW,
    ...extra,
  });
}

test('a station lists the trains still to call there, soonest first', () => {
  const rows = board('GR');
  assert.deepEqual(
    rows.map((row) => row.tripId),
    ['S1-down', 'L7-up', 'S2-later'],
  );
  assert.deepEqual(rows[0], {
    tripId: 'S1-down',
    at: min(2),
    line: 'S1',
    destination: 'Pl. Catalunya',
    origin: 'Terrassa Nacions Unides',
    platform: '2',
    delaySec: null,
    onTime: true,
    terminates: false,
    running: true,
  });
  assert.equal(rows[1].onTime, false);
  assert.equal(rows[1].platform, '3');
});

test('a trip with no train yet is named from its last stop', () => {
  const later = board('GR').find((row) => row.tripId === 'S2-later');
  assert.equal(later.line, null);
  assert.equal(later.destination, 'Sabadell Parc Nord');
  assert.equal(later.running, false);
});

test('a train ending at the station is an arrival from its origin', () => {
  const [arrival] = board('PC');
  assert.equal(arrival.tripId, 'S1-down');
  assert.equal(arrival.terminates, true);
  assert.equal(arrival.origin, 'Terrassa Nacions Unides');
});

test('departed trains, far-off times, unknown stations and the limit', () => {
  assert.deepEqual(
    board('SR').map((row) => row.tripId),
    ['S2-later'],
    'S1 left Sarrià three minutes ago',
  );
  assert.deepEqual(board('XX'), []);
  assert.equal(board('GR', { limit: 1 }).length, 1);
  assert.deepEqual(board('GR', { tripUpdates: null }), []);
});

test('the platform hook reads FGC track digits only', () => {
  assert.equal(fgcTripStopPlatform('PC1'), '1');
  assert.equal(fgcTripStopPlatform('OL4'), '4');
  assert.equal(fgcTripStopPlatform('PC'), null);
  assert.equal(fgcTripStopPlatform('pc1'), null);
});

test('arrivals resolve only for feeds with trip updates and a safe station id', () => {
  const route = resolveTransitRoute('/arrivals/fgc-geotren/PC');
  assert.equal(route.route, 'arrivals');
  assert.equal(route.feed.id, 'fgc-geotren');
  assert.equal(route.stationId, 'PC');
  assert.equal(
    resolveTransitRoute('/arrivals/mbta/x'),
    null,
    'no trip updates',
  );
  assert.equal(resolveTransitRoute('/arrivals/fgc-geotren'), null);
  assert.equal(resolveTransitRoute('/arrivals/fgc-geotren/..'), null);
  assert.equal(resolveTransitRoute('/arrivals/nope/PC'), null);
});

/** One Geotren record per running trip of TRIPS. */
function geotren() {
  const records = [
    ['S1-down', 'S1', 'TR', 'PC', 'True', [41.4, 2.15]],
    ['L7-up', 'L7', 'PC', 'TB', 'False', [41.402, 2.15]],
  ].map(([id, lin, origen, desti, enHora, point], i) => ({
    record_timestamp: new Date(NOW).toISOString(),
    fields: {
      id,
      ut: `unit${i}`,
      lin,
      origen,
      desti,
      en_hora: enHora,
      geo_point_2d: point,
      dir: 'A',
      properes_parades: '{"parada": "GR"}',
    },
  }));
  return JSON.stringify({ nhits: records.length, records });
}

test('the service builds a board from the cached positions and trip updates', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes('trip-updates'))
        return new Response(encodeTripUpdates(TRIPS, NOW), { status: 200 });
      return new Response(geotren(), { status: 200 });
    },
  });
  const get = (path) =>
    service.handle({ url: `http://localhost${path}`, method: 'GET' });
  try {
    const response = await get('/api/transit/arrivals/fgc-geotren/GR');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.station, 'Gràcia');
    assert.equal(body.positions, true);
    assert.equal(body.fetchedAt, NOW);
    assert.deepEqual(
      body.arrivals.map((row) => [row.tripId, row.line, row.platform]),
      [
        ['S1-down', 'S1', '2'],
        ['L7-up', 'L7', '3'],
        ['S2-later', null, '1'],
      ],
    );
    assert.equal(body.arrivals[1].onTime, false);

    // A second board within the minute asks the operator nothing new.
    const before = calls.length;
    assert.equal(
      (await get('/api/transit/arrivals/fgc-geotren/PC')).status,
      200,
    );
    assert.equal(calls.length, before);

    const unknown = await get('/api/transit/arrivals/fgc-geotren/ZZ');
    assert.equal(unknown.status, 404, 'not a station in the pack');
  } finally {
    service.close();
  }
});

test('without trip updates the board says so instead of listing nothing', async () => {
  const service = createTransitService({
    fetchImpl: async (url) =>
      String(url).includes('trip-updates')
        ? new Response(null, { status: 500 })
        : new Response(geotren(), { status: 200 }),
  });
  try {
    const response = await service.handle({
      url: 'http://localhost/api/transit/arrivals/fgc-geotren/GR',
      method: 'GET',
    });
    assert.equal(response.status, 503);
  } finally {
    service.close();
  }
});
