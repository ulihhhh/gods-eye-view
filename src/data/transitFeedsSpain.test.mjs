import test from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';
import {
  SPAIN_TRANSIT_FEEDS,
  renfeCercaniasRoute,
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
  buildTransitSnapshot,
} from './transitProxy.js';
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
  const ids = SPAIN_TRANSIT_FEEDS.map((feed) => feed.id);
  assert.deepEqual(ids, ['renfe-cercanias', 'renfe-ld']);
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
