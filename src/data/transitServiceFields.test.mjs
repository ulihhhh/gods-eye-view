import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import { decodeTripUpdates } from './gtfsTripUpdates.js';
import {
  TRANSIT_MAX_NEXT_STOPS,
  applyServiceFields,
  indexTripUpdates,
} from './transitServiceFields.js';
import { nextStops, normalizeGeotrenRecord } from './fgcGeotren.js';
import { fgcTripStopKey } from './transitFeedsSpain.js';
import { getTransitFeed } from './transitFeeds.js';
import { buildTransitSnapshot } from './transitProxy.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';
import { transitClock } from '../layers/transit/serviceCopy.js';

const NOW = Date.parse('2026-10-14T09:12:00Z'); // 11:12 in Barcelona
const min = (m) => NOW + m * 60_000;

/**
 * Hand-made TripUpdates: trips with an optional trip delay, and stops with
 * a time and an optional (signed) delay. Not operator data.
 */
function encode(trips) {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (_, out) => {
      out.writeStringField(1, '2.0');
      out.writeVarintField(3, Math.round(NOW / 1000));
    },
    null,
  );
  for (const trip of trips)
    pbf.writeMessage(
      2,
      (t, out) => {
        out.writeStringField(1, t.tripId);
        out.writeMessage(
          3,
          (u, w) => {
            w.writeMessage(1, (d, x) => x.writeStringField(1, d.tripId), u);
            for (const stop of u.stops)
              w.writeMessage(
                2,
                (s, x) => {
                  x.writeMessage(
                    2,
                    (e, y) => {
                      if (Number.isFinite(e.delay))
                        y.writeVarintField(1, e.delay);
                      if (Number.isFinite(e.time))
                        y.writeVarintField(2, Math.round(e.time / 1000));
                    },
                    s,
                  );
                  x.writeStringField(4, s.stopId);
                },
                stop,
              );
            if (Number.isFinite(u.delay)) w.writeVarintField(5, u.delay);
          },
          t,
        );
      },
      trip,
    );
  return pbf.finish();
}

test('trip updates carry the trip delay, else the first stop delay, signed', () => {
  const { trips } = decodeTripUpdates(
    encode([
      { tripId: 'A', delay: 240, stops: [{ stopId: 'X1', time: min(2) }] },
      {
        tripId: 'B',
        stops: [
          { stopId: 'X1', time: min(1), delay: -90 },
          { stopId: 'Y1', time: min(3), delay: 30 },
        ],
      },
      { tripId: 'C', stops: [{ stopId: 'X1', time: min(1) }] },
    ]),
  );
  assert.deepEqual(
    trips.map((t) => [t.tripId, t.delaySec]),
    [
      ['A', 240],
      ['B', -90],
      ['C', null],
    ],
  );
});

test('Geotren records carry destination, every next stop, punctuality, loads and series', () => {
  assert.deepEqual(
    nextStops('{"parada": "GR"};{"parada": "x y"};{"parada": "PC"}'),
    ['GR', 'PC'],
  );
  const record = normalizeGeotrenRecord({
    fields: {
      id: 'T1',
      ut: 'U1',
      lin: 'S1',
      geo_point_2d: [41.4, 2.15],
      origen: 'NA',
      desti: 'PC',
      properes_parades: '{"parada": "GR"};{"parada": "PR"};{"parada": "PC"}',
      en_hora: 'False',
      ocupacio_mi_percent: '26',
      ocupacio_ri_percent: '22',
      ocupacio_m1_percent: '140',
      ocupacio_m2_percent: '24',
      tipus_unitat: '113',
    },
  });
  assert.equal(record.destinationStopId, 'PC');
  assert.equal(record.originStopId, 'NA');
  assert.deepEqual(record.nextStopIds, ['GR', 'PR', 'PC']);
  assert.equal(record.onTime, false);
  assert.deepEqual(record.carLoads, [26, 22, 24], 'out-of-range car dropped');
  assert.equal(record.vehicleType, '113');
  const bare = normalizeGeotrenRecord({
    fields: { id: 'T2', ut: 'U2', lin: 'S1', geo_point_2d: [41.4, 2.15] },
  });
  for (const field of [
    'destinationStopId',
    'nextStopIds',
    'onTime',
    'carLoads',
    'vehicleType',
  ])
    assert.equal(Object.hasOwn(bare, field), false, field);
});

test('FGC trip-update stops drop their platform digit', () => {
  assert.equal(fgcTripStopKey('PC1'), 'PC');
  assert.equal(fgcTripStopKey('M41'), 'M4');
  assert.equal(fgcTripStopKey('x'), 'x');
});

const NAMES = Object.freeze({
  GR: 'Gràcia',
  PR: 'Provença',
  PC: 'Pl. Catalunya',
  NA: 'Terrassa Nacions Unides',
});

test('next stops come from the trip update, with times, passed stops dropped', () => {
  const tripUpdates = indexTripUpdates(
    encode([
      {
        tripId: 'T1',
        delay: 180,
        stops: [
          { stopId: 'SG1', time: min(-2) },
          { stopId: 'GR1', time: min(1) },
          { stopId: 'PR2', time: min(3) },
          { stopId: 'PC1', time: min(5) },
        ],
      },
    ]),
  );
  const [train] = applyServiceFields(
    [
      {
        id: 'U1',
        tripId: 'T1',
        destinationStopId: 'PC',
        originStopId: 'NA',
        nextStopIds: ['SG', 'GR'],
      },
    ],
    { stopNames: NAMES, tripUpdates, stopKey: fgcTripStopKey, now: NOW },
  );
  assert.equal(train.destination, 'Pl. Catalunya');
  assert.equal(train.origin, 'Terrassa Nacions Unides');
  assert.equal(train.delaySec, 180);
  assert.deepEqual(train.nextStops, [
    { stopId: 'GR', at: min(1), name: 'Gràcia' },
    { stopId: 'PR', at: min(3), name: 'Provença' },
    { stopId: 'PC', at: min(5), name: 'Pl. Catalunya' },
  ]);
  assert.equal(Object.hasOwn(train, 'nextStopIds'), false);
});

test('without a trip update, next stops are the feed’s own list, capped', () => {
  const ids = Array.from({ length: 12 }, (_, i) => `S${i}`);
  const [train] = applyServiceFields([{ id: 'U1', nextStopIds: ids }], {
    now: NOW,
  });
  assert.equal(train.nextStops.length, TRANSIT_MAX_NEXT_STOPS);
  assert.deepEqual(train.nextStops[0], { stopId: 'S0' });
  assert.equal(train.nextStopsMore, 12 - TRANSIT_MAX_NEXT_STOPS);
  const plain = { id: 'bus', lat: 1, lon: 2 };
  assert.equal(applyServiceFields([plain])[0], plain, 'untouched');
});

test('an FGC card says where the train goes, when it calls next, and how full it is', () => {
  const feed = getTransitFeed('fgc-geotren');
  const tripUpdates = indexTripUpdates(
    encode([
      {
        tripId: 'T1',
        stops: [
          { stopId: 'GR1', time: min(1) },
          { stopId: 'PR2', time: min(3) },
          { stopId: 'PC1', time: min(5) },
          { stopId: 'NA1', time: min(40) },
          { stopId: 'SR1', time: min(41) },
        ],
      },
    ]),
  );
  const snapshot = buildTransitSnapshot(
    feed,
    new TextEncoder().encode(
      JSON.stringify({
        records: [
          {
            record_timestamp: new Date(NOW).toISOString(),
            fields: {
              id: 'T1',
              ut: 'U1',
              lin: 'S1',
              geo_point_2d: [41.4, 2.15],
              origen: 'NA',
              desti: 'PC',
              properes_parades: '{"parada": "GR"}',
              en_hora: 'True',
              ocupacio_mi_percent: '5',
              ocupacio_ri_percent: '7',
              tipus_unitat: '112',
            },
          },
        ],
      }),
    ),
    NOW,
    { stopNames: NAMES, tripUpdates },
  );
  const [record] = snapshot.vehicles;
  const { title, details } = buildTransitSelectionCopy(
    feed,
    record,
    'rail',
    NOW,
    NOW,
  );
  assert.equal(title, '🚆 Route S1 → Pl. Catalunya');
  assert.ok(
    details.includes('On time · from Terrassa Nacions Unides'),
    details,
  );
  assert.ok(
    details.includes(
      'Next: Gràcia 11:13 · Provença 11:15 · Pl. Catalunya 11:17 · Terrassa Nacions Unides 11:52 · +1',
    ),
    details,
  );
  assert.ok(details.includes('Load by car: 5% · 7%'), details);
  assert.ok(
    details.some((line) => line.endsWith('· series 112')),
    details,
  );
});

test('a card without service fields stays as it was', () => {
  const { title, details } = buildTransitSelectionCopy(
    { name: 'MBTA', region: 'Boston, MA' },
    { id: 'y1', routeId: '39', timestamp: NOW / 1000 },
    'bus',
    NOW,
    NOW,
  );
  assert.ok(!title.includes('→'));
  assert.ok(!details.some((line) => /^(Next|Load|On time)/.test(line)));
  assert.equal(transitClock(min(0), 'Europe/Madrid'), '11:12');
});
