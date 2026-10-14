import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAmbArrivalsIndex,
  buildAmbLines,
  buildAmbRoutes,
  buildAmbStops,
  buildAmbTrips,
  decodeTripUpdates,
  parseCsv,
} from './ambArrivals.js';
import {
  ROUTES_CSV,
  SHAPES_CSV,
  STOPS_CSV,
  TRIPS_CSV,
  encodeTripUpdates,
} from './ambArrivalsFixtures.mjs';

test('CSV keeps quoted commas, doubled quotes, BOM and CRLF straight', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n'), [
    { a: 'x, y', b: 'say "hi"' },
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('stops keep in-service six-digit stops with a point', () => {
  assert.deepEqual(buildAmbStops(STOPS_CSV), [
    {
      id: '000108',
      code: '108',
      name: 'Plaça B',
      lat: 41.373762,
      lon: 2.147176,
    },
    {
      id: '100005',
      code: '100005',
      name: 'Escola, nord',
      lat: 41.362714,
      lon: 2.096331,
    },
  ]);
});

test('routes and trips name the line, its colour and the headsign', () => {
  const routes = buildAmbRoutes(ROUTES_CSV);
  assert.deepEqual(routes.get('129'), { name: '87', color: 'FFAA00' });
  const trips = buildAmbTrips(TRIPS_CSV);
  assert.deepEqual(trips.get('130.1'), {
    routeId: '130',
    headsign: 'Aeroport T1',
  });
});

const NOW = 1_800_000_000_000;
const at = (minutes) => Math.round(NOW / 1000 + minutes * 60);

test('trip updates decode to trips with stop times, skipping cancelled and skipped', () => {
  const decoded = decodeTripUpdates(
    encodeTripUpdates(NOW / 1000, [
      {
        tripId: '129.1',
        vehicle: '3357',
        stops: [
          { stopId: '100005', time: at(2) },
          { stopId: '000108', time: at(9), skipped: true },
        ],
      },
      {
        tripId: '130.1',
        canceled: true,
        stops: [{ stopId: '100005', time: at(4) }],
      },
    ]),
  );
  assert.equal(decoded.timestamp, NOW);
  assert.deepEqual(decoded.trips, [
    {
      tripId: '129.1',
      routeId: null,
      vehicleId: '3357',
      vehicleLabel: '#3357',
      delaySec: null,
      stops: [{ stopId: '100005', time: at(2) * 1000 }],
    },
  ]);
});

test('the index groups by line and destination, soonest first, and drops departed buses', () => {
  const { trips } = decodeTripUpdates(
    encodeTripUpdates(NOW / 1000, [
      { tripId: '129.2', stops: [{ stopId: '100005', time: at(12) }] },
      { tripId: '129.1', stops: [{ stopId: '100005', time: at(3) }] },
      { tripId: '130.1', stops: [{ stopId: '100005', time: at(1) }] },
      {
        tripId: 'gone',
        routeId: '130',
        stops: [{ stopId: '100005', time: at(-5) }],
      },
      { tripId: 'unknown', stops: [{ stopId: '100005', time: at(2) }] },
    ]),
  );
  const index = buildAmbArrivalsIndex(
    trips,
    { routes: buildAmbRoutes(ROUTES_CSV), trips: buildAmbTrips(TRIPS_CSV) },
    NOW,
  );
  assert.deepEqual(index.get('100005'), [
    {
      line: 'A1',
      color: '9FD6F6',
      destination: 'Aeroport T1',
      track: null,
      arrivals: [at(1) * 1000],
    },
    {
      line: '87',
      color: 'FFAA00',
      destination: 'Gràcia',
      track: null,
      arrivals: [at(3) * 1000, at(12) * 1000],
    },
  ]);
  assert.equal(index.has('000108'), false);
});

test('each line is drawn along the shape most of its trips follow, per direction', () => {
  const lines = buildAmbLines({
    shapesCsv: SHAPES_CSV,
    tripsCsv: TRIPS_CSV,
    routesCsv: ROUTES_CSV,
  });
  assert.deepEqual(lines, [
    {
      name: '87',
      desc: 'Horta-Gràcia',
      color: 'FFAA00',
      // `sh`, in point order; `sh2` (one trip) is not drawn.
      paths: [[2.16, 41.4, 2.1601, 41.4001, 2.1602, 41.4002]],
    },
    {
      name: 'A1',
      desc: 'Aerobús',
      color: '9FD6F6',
      paths: [[2.16, 41.4, 2.1601, 41.4001, 2.1602, 41.4002]],
    },
  ]);
  assert.deepEqual(
    buildAmbLines({
      shapesCsv: '',
      tripsCsv: TRIPS_CSV,
      routesCsv: ROUTES_CSV,
    }),
    [],
    'no shapes, no lines',
  );
});
