import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FGC_GEOTREN_MAX_RECORDS,
  decodeFgcGeotren,
  firstNextStop,
  normalizeGeotrenRecord,
} from './fgcGeotren.js';
import { fgcRouteMode } from './transitFeedsSpain.js';
import {
  getTransitFeed,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';
import {
  buildTransitSnapshot,
  transitFeedTtlMs,
  transitUpstreamHeaders,
} from './transitProxy.js';
import { createTransitService } from '../sources/transitService.js';

const STAMP = '2026-10-12T20:40:06.82Z';

/** Records from a live Geotren pull on 2026-10-12 (v1 search API). */
const RECORDS = [
  {
    fields: {
      id: '6c4bdae602747644e61684|6f2dc6e007',
      ut: '1f2cc4fd0373',
      lin: 'L6',
      geo_point_2d: [41.393170049523086, 2.157560398679001],
      dir: 'A',
      origen: 'PC',
      desti: 'SR',
      properes_parades:
        '{"parada": "GR"};{"parada": "SG"};{"parada": "MN"};{"parada": "BN"};{"parada": "TT"};{"parada": "SR"}',
      en_hora: 'True',
      tipus_unitat: '113',
      ocupacio_mi_tram: '1',
      ocupacio_ri_tram: '1',
      ocupacio_m1_tram: '1',
      ocupacio_m2_tram: '1',
    },
  },
  {
    fields: {
      id: '625cdae602743e|622dc6e60b',
      ut: '1c2cc4fd0374',
      lin: 'L8',
      geo_point_2d: [41.37447928817319, 2.148444870359527],
      dir: 'A',
      origen: 'PE',
      desti: 'ML',
      properes_parades: '{"parada": "MG"};{"parada": "IC"}',
      estacionat_a: 'PE',
      en_hora: 'True',
      tipus_unitat: '213',
    },
  },
  {
    fields: {
      id: '6c4bdae602747644e61684|6a2dc7ea07',
      ut: '1f2cc2fd0374',
      lin: 'S1',
      geo_point_2d: [41.505764491434064, 2.030948927069502],
      dir: 'A',
      origen: 'PC',
      desti: 'NA',
      properes_parades: '{"parada": "FN"};{"parada": "TR"}',
      en_hora: 'True',
      tipus_unitat: '115',
      // Crowding raised on one car to prove the busiest car decides.
      ocupacio_mi_tram: '1',
      ocupacio_m1_tram: '3',
    },
  },
  {
    fields: {
      id: '625cdae602743e|602dc0e001',
      ut: '1c2cc4fd0075',
      lin: 'R5',
      geo_point_2d: [41.60864527940674, 1.850629495904566],
      dir: 'A',
      origen: 'PE',
      desti: 'MB',
      properes_parades: '{"parada": "CB"};{"parada": "SV"}',
      estacionat_a: 'MO',
      en_hora: 'True',
      tipus_unitat: '213',
      ocupacio_mi_tram: '2',
    },
  },
].map((record) => ({ ...record, record_timestamp: STAMP }));

function answer(records = RECORDS, extra = {}) {
  return new TextEncoder().encode(
    JSON.stringify({ nhits: records.length, records, ...extra }),
  );
}

test('Geotren records become normalized vehicles keyed by unit', () => {
  const decoded = decodeFgcGeotren(answer());
  assert.equal(decoded.entityCount, 4);
  assert.equal(decoded.truncated, false);
  assert.equal(decoded.timestamp, Math.floor(Date.parse(STAMP) / 1000));
  const [l6, l8, s1, r5] = decoded.vehicles;
  assert.equal(l6.id, '1f2cc4fd0373', 'the unit, not the trip');
  assert.equal(l6.tripId, '6c4bdae602747644e61684|6f2dc6e007');
  assert.equal(l6.routeId, 'L6');
  assert.equal(l6.lat, 41.39317);
  assert.equal(l6.lon, 2.15756);
  assert.equal(l6.status, 'IN_TRANSIT_TO');
  assert.equal(l6.stopId, 'GR', 'the next stop Geotren lists first');
  assert.equal(l6.occupancy, 'MANY_SEATS_AVAILABLE');
  assert.equal(l6.timestamp, null, 'records carry no time of their own');
  assert.equal(l8.status, 'STOPPED_AT');
  assert.equal(l8.stopId, 'PE');
  assert.equal(l8.occupancy, null, 'no crowding data is no claim');
  assert.equal(s1.occupancy, 'STANDING_ROOM_ONLY', 'the busiest car decides');
  assert.equal(r5.occupancy, 'FEW_SEATS_AVAILABLE');
});

test('positions come from geo_point_2d, else the GeoJSON geometry', () => {
  const fromGeometry = normalizeGeotrenRecord({
    fields: { ut: 'u1', lin: 'S2' },
    geometry: { type: 'Point', coordinates: [2.0998, 41.5554] },
  });
  assert.equal(fromGeometry.lat, 41.5554);
  assert.equal(fromGeometry.lon, 2.0998);
  for (const record of [
    { fields: { ut: 'u2', lin: 'S1' } },
    { fields: { ut: 'u3', geo_point_2d: [0, 0] } },
    { fields: { ut: 'u4', geo_point_2d: ['x', 2] } },
    { fields: { geo_point_2d: [41.4, 2.1] } },
    { fields: null },
    null,
  ]) {
    assert.equal(normalizeGeotrenRecord(record), null, JSON.stringify(record));
  }
  // Without a unit the trip id still identifies the train.
  assert.equal(
    normalizeGeotrenRecord({ fields: { id: 't1', geo_point_2d: [41.4, 2.1] } })
      .id,
    't1',
  );
});

test('next stops are read from the semicolon-joined JSON Geotren publishes', () => {
  assert.equal(firstNextStop('{"parada": "FN"};{"parada": "TR"}'), 'FN');
  assert.equal(firstNextStop('{"parada":"NA"}'), 'NA');
  assert.equal(firstNextStop(''), null);
  assert.equal(firstNextStop(null), null);
  assert.equal(firstNextStop('{"parada": "' + 'X'.repeat(40) + '"}'), null);
});

test('a malformed answer is an error, never an empty fleet', () => {
  for (const body of ['<html>busy</html>', '{"error":"quota"}', 'null']) {
    assert.throws(() => decodeFgcGeotren(new TextEncoder().encode(body)));
  }
  const empty = decodeFgcGeotren(answer([]));
  assert.equal(empty.vehicles.length, 0, 'a real empty answer is empty');
  assert.equal(empty.timestamp, null);
});

test('one unit is one train, and the record count is bounded', () => {
  const twice = decodeFgcGeotren(answer([RECORDS[0], RECORDS[0]]));
  assert.equal(twice.vehicles.length, 1);
  const many = Array.from({ length: FGC_GEOTREN_MAX_RECORDS + 5 }, (_, i) => ({
    ...RECORDS[0],
    fields: { ...RECORDS[0].fields, ut: `u${i}` },
  }));
  const capped = decodeFgcGeotren(answer(many));
  assert.equal(capped.truncated, true);
  assert.equal(capped.vehicles.length, FGC_GEOTREN_MAX_RECORDS);
});

test('FGC metro lines are subway and every other line is resolved rail', () => {
  for (const line of ['L6', 'L7', 'L8', 'L12'])
    assert.equal(fgcRouteMode(line), 'subway', line);
  for (const line of ['S1', 'S2', 'R5', 'R6', 'R53', 'M1', null])
    assert.equal(fgcRouteMode(line), 'rail', String(line));
  const feed = getTransitFeed('fgc-geotren');
  assert.equal(transitModeFor(feed, 'L7'), 'subway');
  assert.equal(transitModeResolved(feed, 'M2'), true);
});

test('the FGC row is keyless JSON with a one-minute floor, covering the lines', () => {
  const feed = getTransitFeed('fgc-geotren');
  assert.ok(feed);
  assert.equal(feed.format, 'fgc-geotren');
  assert.equal(transitFeedTtlMs(feed), 60_000);
  assert.equal(transitUpstreamHeaders(feed).Accept, 'application/json');
  assert.match(feed.terms.quote, /cc-by 4\.0/i);
  for (const [name, lat, lon] of [
    ['Pl. Catalunya', 41.387, 2.17],
    ['Pl. Espanya', 41.3747, 2.1484],
    ['Terrassa', 41.5636, 2.0084],
    ['Sabadell', 41.5481, 2.1074],
    ['Manresa', 41.7247, 1.8266],
    ['Igualada', 41.5781, 1.6172],
  ]) {
    assert.ok(
      transitFeedsInRange(lat, lon)
        .map((f) => f.id)
        .includes('fgc-geotren'),
      name,
    );
  }
  assert.equal(
    transitFeedsInRange(40.4168, -3.7038)
      .map((f) => f.id)
      .includes('fgc-geotren'),
    false,
    'not polled from Madrid',
  );
  const snapshot = buildTransitSnapshot(
    feed,
    answer(),
    Date.parse(STAMP) + 30_000,
  );
  assert.equal(snapshot.count, 4);
  assert.ok(snapshot.vehicles.every((v) => v.timestampSource === 'header'));
});

test('the proxy asks Geotren at most once a minute, whatever the browsers poll', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(STAMP) });
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url, init) => {
      calls.push({ url, accept: init.headers.Accept });
      // The trip updates beside the positions: an empty FeedMessage.
      if (url.includes('trip-updates'))
        return new Response(new Uint8Array(0), { status: 200 });
      return new Response(answer(), { status: 200 });
    },
  });
  try {
    const get = async () => {
      const response = await service.handle({
        url: 'http://localhost/api/transit/vehicles/fgc-geotren',
        method: 'GET',
      });
      return { cache: response.headers.get('X-GEV-Cache'), response };
    };
    const first = await get();
    assert.equal(first.cache, 'MISS');
    assert.match(first.response.headers.get('Cache-Control'), /max-age=60/);
    assert.equal((await first.response.json()).count, 4);
    for (const step of [15_000, 15_000, 15_000, 14_000]) {
      t.mock.timers.tick(step);
      assert.equal((await get()).cache, 'HIT', 'within the minute');
    }
    t.mock.timers.tick(2_000);
    assert.equal((await get()).cache, 'MISS', 'after the minute');
    const positions = calls.filter((c) => c.url.includes('posicionament'));
    const tripUpdates = calls.filter((c) => c.url.includes('trip-updates'));
    assert.equal(positions.length, 2);
    assert.equal(positions[0].accept, 'application/json');
    assert.equal(tripUpdates.length, 2, 'trip updates once a minute too');
    assert.match(tripUpdates[0].accept, /protobuf/);
  } finally {
    service.close();
  }
});

test('a sparse feed plays further behind instead of stalling', async () => {
  const { transitFeedTiming } = await import('../layers/transit/policy.js');
  const { MOTION_UNKNOWN_AFTER_MS, displayMotion, initializePlayback } =
    await import('../layers/transit/movement.js');
  const { PLAYBACK_MAX_DELAY_MS, createLagReservoir, createTrack, insertFix } =
    await import('./contactPlayback.js');

  const fgc = transitFeedTiming(getTransitFeed('fgc-geotren'));
  // Two-minute batches + one-minute proxy floor + one 15 s poll = 195 s.
  assert.deepEqual(fgc, { staleMs: 315_000, maxDelayMs: 225_000 });
  assert.deepEqual(transitFeedTiming(getTransitFeed('mbta')), {
    staleMs: MOTION_UNKNOWN_AFTER_MS,
    maxDelayMs: PLAYBACK_MAX_DELAY_MS,
  });

  // A first fix received 150 s after it was made: the default track is held
  // to two minutes behind, the FGC track waits for it.
  const firstFix = (policy) => {
    const track = createTrack({
      policy: { feedLag: createLagReservoir(), accept: () => true, ...policy },
    });
    insertFix(
      track,
      { t: 1_000_000, lat: 41.4, lon: 2.15 },
      {
        receivedAt: 1_150_000,
      },
    );
    return track.targetDelayMs;
  };
  assert.equal(firstFix({}), PLAYBACK_MAX_DELAY_MS);
  assert.equal(firstFix({ maxDelayMs: fgc.maxDelayMs }), 170_000);

  // A 200 s old report is NO FIX for an ordinary feed, not for FGC.
  const motionAt = (timing) => {
    const entry = { mode: 'rail', modeInferred: false };
    initializePlayback(entry, null, createLagReservoir(), timing);
    entry.sample.latestReportAgeMs = 200_000;
    entry.sample.phase = 'playing';
    entry.sample.motion = 'moving';
    return displayMotion(entry, 0).word;
  };
  assert.equal(motionAt({}), 'NO FIX');
  assert.equal(motionAt(fgc), 'EN ROUTE');
});

test('FGC trains name their stop from the bundled station pack', async () => {
  const service = createTransitService({
    fetchImpl: async () => new Response(answer(), { status: 200 }),
  });
  try {
    const response = await service.handle({
      url: 'http://localhost/api/transit/vehicles/fgc-geotren',
      method: 'GET',
    });
    const { vehicles } = await response.json();
    const l8 = vehicles.find((vehicle) => vehicle.routeId === 'L8');
    assert.equal(l8.stopId, 'PE');
    assert.equal(l8.stopName, 'Pl. Espanya');
    assert.ok(
      vehicles.every((vehicle) => !vehicle.stopId || vehicle.stopName),
      'every Geotren initial in the fixture is in the pack',
    );
  } finally {
    service.close();
  }
});
