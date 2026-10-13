import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  SPAIN_TRANSIT_FEEDS,
  renfeCercaniasRoute,
  renfeCercaniasStatus,
  renfeLdStatus,
} from './transitFeedsSpain.js';
import {
  TRANSIT_FEED_REGISTRY,
  getTransitFeed,
  haversineKm,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';
import {
  TRANSIT_DERIVED_CODE_MAX_CHARS,
  applyDerivedRoutes,
  applyStatusSemantics,
  applyStopPlaces,
  buildTransitSnapshot,
  excludeYieldedVehicles,
} from './transitProxy.js';
import { createTransitService } from '../sources/transitService.js';
import { MODE_MAX_SPEED_MPS } from '../layers/transit/movement.js';
import { buildTransitSelectionCopy } from '../layers/transit/policy.js';

function embed(writer, tag, build) {
  const inner = new PbfWriter();
  build(inner);
  writer.writeBytesField(tag, inner.finish());
}

/**
 * Encode a FeedMessage shaped like Renfe's: a header, then entities with a
 * trip id, position, status, stop and a vehicle descriptor — and no route id
 * or per-vehicle time when the real feed omits them. Values are taken from
 * live pulls of both feeds on 2026-10-12.
 */
function renfeFeed(entities, timestamp = 1_791_803_923) {
  const writer = new PbfWriter();
  embed(writer, 1, (header) => {
    header.writeStringField(1, '2.0');
    header.writeVarintField(2, 0);
    header.writeVarintField(3, timestamp);
  });
  for (const e of entities) {
    embed(writer, 2, (entity) => {
      entity.writeStringField(1, e.entityId);
      embed(entity, 4, (vehicle) => {
        embed(vehicle, 1, (trip) => {
          trip.writeStringField(1, e.tripId);
          if (e.routeId) trip.writeStringField(5, e.routeId);
        });
        embed(vehicle, 2, (position) => {
          position.writeFloatField(1, e.lat);
          position.writeFloatField(2, e.lon);
        });
        vehicle.writeVarintField(4, e.status);
        if (e.timestamp) vehicle.writeVarintField(5, e.timestamp);
        if (e.stopId) vehicle.writeStringField(7, e.stopId);
        embed(vehicle, 8, (descriptor) => {
          descriptor.writeStringField(1, e.vehicleId);
          descriptor.writeStringField(2, e.label);
        });
      });
    });
  }
  return writer.finish();
}

test('Cercanías labels give the line and, when published, the platform', () => {
  assert.deepEqual(renfeCercaniasRoute({ label: 'C4-23631-PLATF.(8)' }), {
    routeId: 'C4',
    platform: '8',
  });
  assert.deepEqual(renfeCercaniasRoute({ label: 'C2-23013' }), {
    routeId: 'C2',
  });
  // Branch letters and Rodalies lines are part of the line code.
  assert.deepEqual(renfeCercaniasRoute({ label: 'C8b-36643-PLATF.(11)' }), {
    routeId: 'C8b',
    platform: '11',
  });
  assert.deepEqual(renfeCercaniasRoute({ label: 'R2N-77105-PLATF.(3)' }), {
    routeId: 'R2N',
    platform: '3',
  });
  assert.deepEqual(renfeCercaniasRoute({ label: 'RL4-28703' }), {
    routeId: 'RL4',
  });
  // An unparsable label falls back to the trip id's own line suffix.
  assert.deepEqual(
    renfeCercaniasRoute({ label: '23631', tripId: '1083L27304C4a' }),
    { routeId: 'C4a' },
  );
  // Nothing is guessed when neither parses.
  assert.deepEqual(renfeCercaniasRoute({ label: 'x', tripId: 'y' }), {});
  assert.deepEqual(renfeCercaniasRoute({}), {});
  assert.deepEqual(renfeCercaniasRoute(null), {});
});

test('derived routes never override a published route and stay bounded', () => {
  const feed = { deriveRoute: () => ({ routeId: 'C1', platform: '2' }) };
  const [kept] = applyDerivedRoutes(feed, [{ id: 'a', routeId: 'Red' }]);
  assert.equal(kept.routeId, 'Red', 'the operator route wins');
  assert.equal(kept.platform, '2');
  const tooLong = 'X'.repeat(TRANSIT_DERIVED_CODE_MAX_CHARS + 1);
  const [plain] = applyDerivedRoutes(
    { deriveRoute: () => ({ routeId: tooLong, platform: 42 }) },
    [{ id: 'b', routeId: null }],
  );
  assert.equal(plain.routeId, null);
  assert.equal('platform' in plain, false);
  const vehicles = [{ id: 'c' }];
  assert.equal(
    applyDerivedRoutes({}, vehicles),
    vehicles,
    'a feed without the hook is untouched',
  );
});

test('a Cercanías snapshot carries line, platform and the feed time', () => {
  const bytes = renfeFeed([
    {
      entityId: 'VP_C4-23631',
      vehicleId: '23631',
      label: 'C4-23631-PLATF.(8)',
      tripId: '3083L23631C4',
      lat: 37.403599,
      lon: -5.936382,
      status: 0, // INCOMING_AT
      timestamp: 1_791_803_923,
      stopId: '51003',
    },
    {
      entityId: 'VP_R2N-77105',
      vehicleId: '77105',
      label: 'R2N-77105',
      tripId: '5161L77105R2N',
      lat: 41.388,
      lon: 2.141,
      status: 2, // IN_TRANSIT_TO
      timestamp: 1_791_803_923,
      stopId: '71801',
    },
  ]);
  const snapshot = buildTransitSnapshot(
    getTransitFeed('renfe-cercanias'),
    bytes,
    1_791_803_940_000,
  );
  assert.equal(snapshot.count, 2);
  const [sevilla, barcelona] = snapshot.vehicles;
  assert.equal(sevilla.routeId, 'C4');
  assert.equal(sevilla.platform, '8');
  assert.equal(sevilla.status, 'INCOMING_AT');
  assert.equal(sevilla.timestampSource, 'vehicle');
  assert.equal(barcelona.routeId, 'R2N');
  assert.equal('platform' in barcelona, false);
  // Renfe's own reading of the statuses travels with each train.
  assert.equal(sevilla.stopRelation, 'arriving');
  assert.equal(sevilla.positionUntrusted, true);
  assert.equal(barcelona.stopRelation, 'left');
  assert.equal('positionUntrusted' in barcelona, false);
});

test('each Renfe feed reads its statuses as measured; other feeds keep GTFS-Realtime', () => {
  assert.deepEqual(renfeCercaniasStatus({ status: 'IN_TRANSIT_TO' }), {
    stopRelation: 'left',
  });
  assert.deepEqual(renfeCercaniasStatus({ status: 'INCOMING_AT' }), {
    stopRelation: 'arriving',
    positionUntrusted: true,
  });
  assert.deepEqual(renfeCercaniasStatus({ status: 'STOPPED_AT' }), {});
  assert.deepEqual(renfeLdStatus({ status: 'STOPPED_AT' }), {
    stopRelation: 'last',
  });
  assert.deepEqual(renfeLdStatus({ status: 'IN_TRANSIT_TO' }), {});
  const records = [
    { id: 'a', stopId: 'S', status: 'STOPPED_AT' },
    { id: 'b', status: 'STOPPED_AT' },
  ];
  assert.equal(
    applyStatusSemantics({ id: 'plain' }, records),
    records,
    'a feed without the hook is left as it is',
  );
  const [stopped, noStop] = applyStatusSemantics(
    { interpretStatus: () => ({}) },
    records,
  );
  assert.equal(stopped.stopRelation, 'at', 'the standard reading fills in');
  assert.equal('stopRelation' in noStop, false, 'no stop, no relation');
  for (const feed of SPAIN_TRANSIT_FEEDS) {
    assert.equal(feed.staleRepeats, true, feed.id);
    assert.equal(feed.historyRetention, true, feed.id);
    assert.equal(typeof feed.stopPlaces, 'function', feed.id);
  }
});

test('stops are placed only from finite, in-range station positions', () => {
  const places = { A: [41.4, 2.1], B: [91, 2], C: 'x' };
  const placed = applyStopPlaces(
    [{ stopId: 'A' }, { stopId: 'B' }, { stopId: 'C' }, { stopId: 'Z' }, {}],
    places,
  );
  assert.deepEqual(placed[0], { stopId: 'A', stopLat: 41.4, stopLon: 2.1 });
  for (const vehicle of placed.slice(1))
    assert.equal('stopLat' in vehicle, false);
});

test('the card says where a train left, or the last stop it served', () => {
  const card = (record) =>
    buildTransitSelectionCopy(
      getTransitFeed('renfe-cercanias'),
      {
        id: '1',
        lat: 41.4,
        lon: 2.1,
        timestamp: 1_791_803_923,
        stopId: '71801',
        stopName: 'Barcelona-Sants',
        ...record,
      },
      'rail',
      1_791_803_938_000,
    ).details.join(' | ');
  assert.match(
    card({ status: 'IN_TRANSIT_TO', stopRelation: 'left' }),
    /Last report: left Barcelona-Sants/,
  );
  assert.match(
    card({ status: 'STOPPED_AT', stopRelation: 'last' }),
    /Last report: last stop Barcelona-Sants/,
  );
  assert.match(
    card({ status: 'IN_TRANSIT_TO' }),
    /Last report: next stop Barcelona-Sants/,
  );
});

test('a long-distance snapshot keeps the train number and uses the feed time', () => {
  const bytes = renfeFeed(
    [
      // The real feed repeats one train once per trip leg, at one position.
      {
        entityId: 'VP_00631',
        vehicleId: '00631',
        label: '00631',
        tripId: '0063112026-10-12',
        lat: 42.0183,
        lon: -1.5597,
        status: 1,
        stopId: '04040',
      },
      {
        entityId: 'VP_00631',
        vehicleId: '00631',
        label: '00631',
        tripId: '0063132026-10-12',
        lat: 42.0183,
        lon: -1.5597,
        status: 1,
        stopId: '04040',
      },
    ],
    1_791_803_930,
  );
  const snapshot = buildTransitSnapshot(
    getTransitFeed('renfe-ld'),
    bytes,
    1_791_803_940_000,
  );
  assert.equal(snapshot.count, 1, 'one physical train');
  const [train] = snapshot.vehicles;
  assert.equal(train.label, '00631');
  assert.equal(train.routeId, null);
  assert.equal(train.timestamp, 1_791_803_930);
  assert.equal(train.timestampSource, 'header');
});

test('Renfe feeds are registered, enabled, credited and keyless', () => {
  const ids = ['renfe-cercanias', 'renfe-ld'];
  for (const id of ids)
    assert.ok(
      SPAIN_TRANSIT_FEEDS.some((feed) => feed.id === id),
      id,
    );
  for (const id of ids) {
    const feed = getTransitFeed(id);
    assert.ok(feed, `${id} is routable`);
    assert.ok(TRANSIT_FEED_REGISTRY.includes(feed));
    assert.match(feed.url, /^https:\/\/gtfsrt\.renfe\.com\//);
    assert.match(feed.terms.quote, /fines comerciales y no comerciales/);
    assert.match(feed.attribution, /^Renfe Operadora/);
  }
  const catalog = publicTransitCatalog().filter((feed) =>
    ids.includes(feed.id),
  );
  assert.equal(catalog.length, 2);
  for (const entry of catalog) {
    assert.equal('url' in entry, false);
    assert.equal('deriveRoute' in entry, false);
  }
});

test('Renfe trains are resolved rail, so high-speed fixes are not refused', () => {
  for (const id of ['renfe-cercanias', 'renfe-ld']) {
    const feed = getTransitFeed(id);
    assert.equal(transitModeFor(feed, null), 'rail');
    assert.equal(transitModeFor(feed, 'C4'), 'rail');
    // A defaulted mode is held to the `unknown` ceiling (~200 km/h), below
    // an AVE at 300 km/h; a resolved rail mode is not.
    assert.equal(transitModeResolved(feed, null), true);
  }
  assert.ok(MODE_MAX_SPEED_MPS.rail * 3.6 > 300);
  assert.ok(MODE_MAX_SPEED_MPS.unknown * 3.6 < 300);
});

test('Renfe coverage holds every Cercanías network and stays out of next door', () => {
  const inSpain = {
    Madrid: [40.4168, -3.7038],
    Barcelona: [41.3874, 2.1686],
    Sevilla: [37.3891, -5.9845],
    Bilbao: [43.263, -2.935],
    'San Sebastián': [43.3183, -1.9812],
    Cádiz: [36.5297, -6.2925],
    Málaga: [36.7213, -4.4214],
    Murcia: [37.9922, -1.1307],
    Oviedo: [43.3603, -5.8448],
    Portbou: [42.4269, 3.1588],
  };
  for (const [city, [lat, lon]] of Object.entries(inSpain)) {
    const ids = transitFeedsInRange(lat, lon).map((feed) => feed.id);
    assert.ok(ids.includes('renfe-cercanias'), `${city} polls Cercanías`);
    assert.ok(ids.includes('renfe-ld'), `${city} polls AV/LD/MD`);
  }
  // A Coruña and Vigo have long-distance trains but no Cercanías network.
  assert.ok(
    transitFeedsInRange(43.3623, -8.4115)
      .map((feed) => feed.id)
      .includes('renfe-ld'),
  );
  for (const [lat, lon] of [
    [48.8566, 2.3522], // Paris
    [60.1699, 24.9384], // Helsinki
    [52.3676, 4.9041], // Amsterdam
  ]) {
    const ids = transitFeedsInRange(lat, lon, 25).map((feed) => feed.id);
    assert.equal(ids.includes('renfe-cercanias'), false);
    assert.equal(ids.includes('renfe-ld'), false);
  }
  // The documented overspill: Lisbon is inside the peninsular circle.
  const cercanias = getTransitFeed('renfe-cercanias');
  assert.ok(
    haversineKm(38.7223, -9.1393, cercanias.center.lat, cercanias.center.lon) <
      cercanias.loadRadiusKm,
  );
});

test('the vehicle card shows the platform next to the reported stop', () => {
  const copy = buildTransitSelectionCopy(
    getTransitFeed('renfe-cercanias'),
    {
      id: '23631',
      label: 'C4-23631-PLATF.(8)',
      routeId: 'C4',
      platform: '8',
      lat: 37.4,
      lon: -5.94,
      timestamp: 1_791_803_923,
      timestampSource: 'vehicle',
      stopId: '51003',
      status: 'INCOMING_AT',
    },
    'rail',
    1_791_803_938_000,
  );
  assert.equal(copy.title, '🚆 Route C4');
  assert.ok(
    copy.details.includes('Last report: arriving at stop 51003 · platform 8'),
    copy.details.join(' | '),
  );
});

test('a feed yields the vehicles its preferred feed already reports', () => {
  const snapshot = {
    count: 3,
    vehicles: [{ id: '15064' }, { id: '02101' }, { id: '18135' }],
  };
  const kept = excludeYieldedVehicles(snapshot, [
    { id: '15064' },
    { id: '18135' },
    { id: '99999' },
  ]);
  assert.deepEqual(
    kept.vehicles.map((v) => v.id),
    ['02101'],
  );
  assert.equal(kept.count, 1);
  assert.equal(kept.yielded, 2);
  const untouched = excludeYieldedVehicles(snapshot, null);
  assert.equal(untouched.count, 3);
  assert.equal(untouched.yielded, 0);
});

test('the long-distance feed drops trains Cercanías publishes under one number', async () => {
  const regional = {
    vehicleId: '15064',
    status: 2,
    stopId: '71801',
    lat: 41.29,
    lon: 1.25,
  };
  const cercanias = renfeFeed([
    {
      ...regional,
      entityId: 'VP_R17-15064',
      label: 'R17-15064',
      tripId: '5183L15064R17',
      timestamp: 1_791_803_923,
    },
  ]);
  const ld = renfeFeed([
    {
      ...regional,
      entityId: 'VP_15064',
      label: '15064',
      tripId: '1506412026-10-11',
      lat: 41.3,
    },
    {
      entityId: 'VP_02101',
      vehicleId: '02101',
      label: '02101',
      tripId: '0210112026-10-12',
      lat: 39.2,
      lon: -3.86,
      status: 2,
      stopId: '60000',
    },
  ]);
  const bodies = {
    'https://gtfsrt.renfe.com/vehicle_positions.pb': cercanias,
    'https://gtfsrt.renfe.com/vehicle_positions_LD.pb': ld,
  };
  const service = createTransitService({
    fetchImpl: async (url) => new Response(bodies[url], { status: 200 }),
  });
  try {
    const get = async (id) =>
      (
        await service.handle({
          url: `http://localhost/api/transit/vehicles/${id}`,
          method: 'GET',
        })
      ).json();
    const shared = await get('renfe-cercanias');
    assert.deepEqual(
      shared.vehicles.map((v) => [v.id, v.routeId]),
      [['15064', 'R17']],
    );
    const long = await get('renfe-ld');
    assert.deepEqual(
      long.vehicles.map((v) => v.id),
      ['02101'],
      'the regional train is shown once, by Cercanías',
    );
    assert.equal(long.yielded, 1);
  } finally {
    service.close();
  }
});

test('yieldsTo names a registered feed', () => {
  for (const feed of TRANSIT_FEED_REGISTRY) {
    if (!feed.yieldsTo) continue;
    assert.notEqual(feed.yieldsTo, feed.id);
    assert.ok(
      TRANSIT_FEED_REGISTRY.some((other) => other.id === feed.yieldsTo),
      `${feed.id} yields to a registered feed`,
    );
  }
  assert.equal(getTransitFeed('renfe-ld').yieldsTo, 'renfe-cercanias');
});

test('the card names the stop when the station pack knows it', () => {
  const record = {
    id: '23631',
    routeId: 'C4',
    lat: 37.4,
    lon: -5.94,
    timestamp: 1_791_803_923,
    timestampSource: 'vehicle',
    stopId: '51003',
    status: 'INCOMING_AT',
  };
  const feed = getTransitFeed('renfe-cercanias');
  const at = 1_791_803_938_000;
  const named = buildTransitSelectionCopy(
    feed,
    { ...record, stopName: 'Sevilla-Santa Justa' },
    'rail',
    at,
  );
  assert.ok(
    named.details.some((line) =>
      line.startsWith('Last report: arriving at Sevilla-Santa Justa'),
    ),
    named.details.join(' | '),
  );
  const bare = buildTransitSelectionCopy(feed, record, 'rail', at);
  assert.ok(
    bare.details.some((line) =>
      line.startsWith('Last report: arriving at stop 51003'),
    ),
    bare.details.join(' | '),
  );
  const next = buildTransitSelectionCopy(
    feed,
    { ...record, status: 'IN_TRANSIT_TO', stopName: 'Dos Hermanas' },
    'rail',
    at,
  );
  assert.ok(
    next.details.some((line) =>
      line.startsWith('Last report: next stop Dos Hermanas'),
    ),
  );
});

test('a train the server has seen before arrives with its recent stretch and its stop placed', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_791_803_940_000 });
  const train = (lat, timestamp) =>
    renfeFeed(
      [
        {
          entityId: 'VP_C1-23559',
          vehicleId: '23559',
          label: 'C1-23559',
          tripId: '3084M23559C1',
          lat,
          lon: -5.97,
          status: 2, // IN_TRANSIT_TO: the station it left
          timestamp,
          stopId: '51003',
        },
      ],
      timestamp,
    );
  let body = train(37.34, 1_791_803_930);
  const service = createTransitService({
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  try {
    const get = async () =>
      (
        await service.handle({
          url: 'http://localhost/api/transit/vehicles/renfe-cercanias',
          method: 'GET',
        })
      ).json();
    const first = (await get()).vehicles[0];
    assert.equal('recent' in first, false, 'nothing retained yet');
    assert.ok(Number.isFinite(first.stopLat), 'its stop is placed');
    t.mock.timers.tick(20_000);
    body = train(37.34, 1_791_803_950); // same place, newer time: no news
    await get();
    t.mock.timers.tick(20_000);
    body = train(37.35, 1_791_803_970);
    const moved = (await get()).vehicles[0];
    assert.deepEqual(moved.recent, [[1_791_803_930_000, first.lat, first.lon]]);
  } finally {
    service.close();
  }
});
