import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ESTIMATE_END_GRACE_MS,
  ESTIMATE_HOLD_MAX_MS,
  createEstimateSmoother,
  distanceM,
  estimateVehicles,
  pointAlong,
  positionOnTimeline,
  timelineStops,
} from './estimatedPositions.js';

const T0 = Date.UTC(2026, 9, 17, 10, 0, 0);
const s = (seconds) => T0 + seconds * 1000;

/** Three stations on a north-south line, ~1.1 km apart. */
const A = { stopId: 'A', name: 'Alpha', lat: 41.4, lon: 2.17 };
const B = { stopId: 'B', name: 'Bravo', lat: 41.39, lon: 2.17 };
const C = { stopId: 'C', name: 'Charlie', lat: 41.38, lon: 2.17 };

function metroTimeline(overrides = {}) {
  return {
    id: 'L3-307',
    routeId: 'L3',
    tripId: '307',
    label: '307',
    destination: 'Charlie',
    stops: [
      { ...A, arr: s(0), dep: s(20) },
      { ...B, arr: s(100), dep: s(120) },
      { ...C, arr: s(200), dep: s(200) },
    ],
    ...overrides,
  };
}

test('a vehicle stands at a stop between its arrival and departure', () => {
  const at = positionOnTimeline(metroTimeline(), s(110));
  assert.equal(at.status, 'STOPPED_AT');
  assert.equal(at.stopId, 'B');
  assert.equal(at.stopName, 'Bravo');
  assert.equal(at.lat, B.lat);
  // Facing where it goes next: south.
  assert.ok(Math.abs(at.bearing - 180) < 1);
});

test('between stops the vehicle is interpolated by time along the segment', () => {
  const half = positionOnTimeline(metroTimeline(), s(60));
  assert.equal(half.status, 'IN_TRANSIT_TO');
  assert.equal(half.stopId, 'B');
  assert.equal(half.fromStopId, 'A');
  assert.equal(half.toStopId, 'B');
  assert.ok(Math.abs(half.fraction - 0.5) < 1e-9);
  assert.ok(Math.abs(half.lat - 41.395) < 1e-6);
});

test('before the first departure it waits at the first stop; after the last it lingers, then ends', () => {
  assert.equal(positionOnTimeline(metroTimeline(), s(-300)).stopId, 'A');
  const end = positionOnTimeline(metroTimeline(), s(230));
  assert.equal(end.stopId, 'C');
  assert.equal(end.status, 'STOPPED_AT');
  assert.equal(
    positionOnTimeline(metroTimeline(), s(200) + ESTIMATE_END_GRACE_MS + 1),
    null,
  );
});

test('a segment path is followed instead of the straight line', () => {
  // A dog-leg east then south: halfway by distance is the corner.
  const corner = [2.18, 41.4];
  const path = () => [[A.lon, A.lat], corner, [B.lon, B.lat]];
  const legs =
    distanceM(A.lat, A.lon, corner[1], corner[0]) +
    distanceM(corner[1], corner[0], B.lat, B.lon);
  const atCornerFraction = distanceM(A.lat, A.lon, corner[1], corner[0]) / legs;
  const t = s(20) + atCornerFraction * 80_000;
  const p = positionOnTimeline(metroTimeline(), t, { segmentPath: path });
  assert.ok(Math.abs(p.lon - corner[0]) < 1e-5);
  assert.ok(Math.abs(p.lat - corner[1]) < 1e-5);
});

test('pointAlong clamps and survives a zero-length path', () => {
  const path = [
    [2, 41],
    [2, 41],
  ];
  assert.deepEqual(pointAlong(path, 0.5), { lat: 41, lon: 2, bearing: null });
  const p = pointAlong(
    [
      [2, 41],
      [2, 42],
    ],
    7,
  );
  assert.equal(p.lat, 42);
});

test('stops out of order or malformed are dropped, never reordered', () => {
  const stops = timelineStops({
    stops: [
      { ...A, arr: s(0), dep: s(10) },
      { ...B, arr: s(5), dep: s(6) },
      { ...C, arr: s(50), dep: s(40) },
      { stopId: 'D', lat: NaN, lon: 2, arr: s(60), dep: s(60) },
      { ...C, stopId: 'E', arr: s(70), dep: s(70) },
    ],
  });
  assert.deepEqual(
    stops.map((stop) => stop.stopId),
    ['A', 'E'],
  );
});

test('a Swiss-shaped timeline (full schedule, dwell, past midnight) fits the same engine', () => {
  // A night train scheduled at 24:50 → 25:20 service time, i.e. the next
  // calendar day: the source turns GTFS times into absolute ms, so the
  // engine never sees "25:20".
  const midnight = Date.UTC(2026, 9, 16, 22, 0, 0); // 00:00 Zurich (CEST)
  const at = (h, m) => midnight + (h * 60 + m) * 60_000;
  const timeline = {
    id: 'ch-ir-1234',
    routeId: 'IR 13',
    tripId: '.ojp-91-13-A.1.TA.101.j26',
    label: '1234',
    destination: 'Chur',
    stops: [
      {
        stopId: 'ZUE',
        name: 'Zürich HB',
        lat: 47.378,
        lon: 8.54,
        arr: at(24, 48),
        dep: at(24, 50),
      },
      {
        stopId: 'THW',
        name: 'Thalwil',
        lat: 47.296,
        lon: 8.565,
        arr: at(24, 58),
        dep: at(25, 0),
      },
      {
        stopId: 'PF',
        name: 'Pfäffikon SZ',
        lat: 47.202,
        lon: 8.778,
        arr: at(25, 18),
        dep: at(25, 20),
      },
    ],
  };
  const dwelling = positionOnTimeline(timeline, at(24, 59));
  assert.equal(dwelling.status, 'STOPPED_AT');
  assert.equal(dwelling.stopId, 'THW');
  const running = positionOnTimeline(timeline, at(25, 9));
  assert.equal(running.status, 'IN_TRANSIT_TO');
  assert.equal(running.stopId, 'PF');
  assert.ok(Math.abs(running.fraction - 0.5) < 1e-9);
  // A delay is the same timeline shifted: three minutes late is three
  // minutes further back.
  const late = {
    ...timeline,
    stops: timeline.stops.map((stop) => ({
      ...stop,
      arr: stop.arr + 180_000,
      dep: stop.dep + 180_000,
    })),
  };
  assert.equal(positionOnTimeline(late, at(25, 2)).stopId, 'THW');
  const [record] = estimateVehicles([late], at(25, 2), { source: 'schedule' });
  assert.equal(record.estimatedFrom, 'schedule');
  assert.equal(record.destination, 'Chur');
  assert.deepEqual(
    record.nextStops.map((stop) => stop.stopId),
    ['PF'],
  );
});

test('records carry the normalized shape, the next stops and the estimate flag', () => {
  const [record] = estimateVehicles([metroTimeline()], s(60));
  assert.equal(record.id, 'L3-307');
  assert.equal(record.estimated, true);
  assert.equal(record.estimatedFrom, 'predictions');
  assert.equal(record.status, 'IN_TRANSIT_TO');
  assert.equal(record.stopId, 'B');
  assert.equal(record.stopName, 'Bravo');
  assert.equal(record.timestamp, Math.floor(s(60) / 1000));
  assert.equal(record.routeId, 'L3');
  assert.deepEqual(
    record.nextStops.map((stop) => [stop.stopId, stop.name, stop.at]),
    [
      ['B', 'Bravo', s(100)],
      ['C', 'Charlie', s(200)],
    ],
  );
});

test('duplicate ids and finished timelines are skipped', () => {
  const vehicles = estimateVehicles(
    [metroTimeline(), metroTimeline(), metroTimeline({ id: 'gone' })],
    s(60),
  );
  assert.deepEqual(
    vehicles.map((v) => v.id),
    ['L3-307', 'gone'],
  );
  assert.equal(estimateVehicles([metroTimeline()], s(9999)).length, 0);
});

test('the smoother holds a backwards correction, then gives up', () => {
  const smoother = createEstimateSmoother();
  const first = positionOnTimeline(metroTimeline(), s(60));
  smoother.smooth('x', first, s(60));
  // The prediction slips 30 s: the raw estimate is further back.
  const slipped = positionOnTimeline(metroTimeline(), s(45));
  const held = smoother.smooth('x', slipped, s(75));
  assert.equal(held.lat, first.lat);
  const later = smoother.smooth('x', slipped, s(60) + ESTIMATE_HOLD_MAX_MS + 1);
  assert.equal(later.lat, slipped.lat);
});

test('the smoother holds a vehicle that would go back to the stop it left', () => {
  const smoother = createEstimateSmoother();
  const leaving = positionOnTimeline(metroTimeline(), s(30));
  smoother.smooth('x', leaving, s(30));
  const backAtA = positionOnTimeline(metroTimeline(), s(10));
  assert.equal(smoother.smooth('x', backAtA, s(45)).lat, leaving.lat);
});

test('the smoother spreads a forward jump at the speed limit', () => {
  const smoother = createEstimateSmoother({ maxSpeedMps: 25 });
  const start = positionOnTimeline(metroTimeline(), s(25));
  smoother.smooth('x', start, s(25));
  // The prediction moves 1 km ahead in 15 s (≈67 m/s).
  const ahead = positionOnTimeline(metroTimeline(), s(110));
  const eased = smoother.smooth('x', ahead, s(40));
  const moved = distanceM(start.lat, start.lon, eased.lat, eased.lon);
  assert.ok(Math.abs(moved - 25 * 15) < 1, `moved ${moved} m`);
  // Moving on normally is untouched.
  const normal = createEstimateSmoother();
  normal.smooth('y', start, s(25));
  const next = positionOnTimeline(metroTimeline(), s(40));
  assert.equal(normal.smooth('y', next, s(40)).lat, next.lat);
});

test('the smoother forgets vehicles it has not seen for a while', () => {
  const smoother = createEstimateSmoother();
  estimateVehicles([metroTimeline()], s(60), { smoother });
  assert.equal(smoother.size, 1);
  estimateVehicles([], s(60) + 6 * 60_000, { smoother });
  assert.equal(smoother.size, 0);
});

test('segmentPath is told which timeline it serves', () => {
  const seen = [];
  positionOnTimeline(metroTimeline(), s(60), {
    segmentPath: (from, to, timeline) => {
      seen.push([from.stopId, to.stopId, timeline.routeId]);
      return null;
    },
  });
  assert.ok(
    seen.some(([a, b, route]) => a === 'A' && b === 'B' && route === 'L3'),
  );
});
