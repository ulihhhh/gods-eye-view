import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACK_SNAP_MAX_M,
  courseAlongTrack,
  createTrackIndex,
  pathBetween,
} from './trackFollow.js';

// An L-shaped track near Barcelona: east along lat 41.40, then north along
// lon 2.17. ~1.7 km each leg.
const L_TRACK = [2.15, 41.4, 2.17, 41.4, 2.17, 41.415];
const M = 111_320;
const metres = (p, q) =>
  Math.hypot(
    (p.lon - q.lon) * Math.cos((41.4 * Math.PI) / 180),
    p.lat - q.lat,
  ) * M;

test('a segment across the corner follows the track, not the chord', () => {
  const index = createTrackIndex([{ routes: ['R2'], paths: [L_TRACK] }]);
  const a = { lat: 41.4, lon: 2.155 };
  const b = { lat: 41.41, lon: 2.17 };
  const path = pathBetween(index, a, b, 'R2');
  assert.ok(path, 'both fixes sit on the track');
  const corner = { lat: 41.4, lon: 2.17 };
  const legs = metres(a, corner) + metres(corner, b);
  assert.ok(Math.abs(path.lengthM - legs) < 5, `${path.lengthM} vs ${legs}`);
  // Exactly at the fixes at both ends.
  assert.ok(metres(path.at(0), a) < 0.01);
  assert.ok(metres(path.at(1), b) < 0.01);
  // Through the corner, where the straight chord would cut across the block.
  const atCorner = path.at(metres(a, corner) / legs);
  assert.ok(metres(atCorner, corner) < 5, `${metres(atCorner, corner)} m off`);
  // Running the other way gives the same track backwards.
  const back = pathBetween(index, b, a, 'R2');
  assert.ok(metres(back.at(1 - metres(a, corner) / legs), corner) < 5);
});

test('fixes slightly off the track still follow it, ending on the fixes', () => {
  const index = createTrackIndex([{ routes: null, paths: [L_TRACK] }]);
  const a = { lat: 41.4005, lon: 2.155 }; // ~55 m north of the track
  const b = { lat: 41.41, lon: 2.1705 };
  const path = pathBetween(index, a, b);
  assert.ok(path);
  assert.ok(metres(path.at(0), a) < 0.01);
  assert.ok(metres(path.at(1), b) < 0.01);
});

test('no track, a far fix, the wrong line or an implausible detour fall back to null', () => {
  const index = createTrackIndex([{ routes: ['R2'], paths: [L_TRACK] }]);
  const a = { lat: 41.4, lon: 2.155 };
  assert.equal(
    pathBetween(createTrackIndex([]), a, { lat: 41.41, lon: 2.17 }),
    null,
  );
  const far = { lat: 41.4 + (TRACK_SNAP_MAX_M * 2) / M, lon: 2.16 };
  assert.equal(pathBetween(index, a, far, 'R2'), null);
  // A line that names no indexed path falls back to any track.
  assert.ok(pathBetween(index, a, { lat: 41.41, lon: 2.17 }, 'R4'));
  // A loop: two points 40 m apart on either side of a long hairpin.
  const loop = [2.15, 41.4, 2.2, 41.4, 2.2, 41.4004, 2.15, 41.4004];
  const loopIndex = createTrackIndex([{ paths: [loop] }]);
  const p = { lat: 41.4, lon: 2.1501 };
  const q = { lat: 41.4004, lon: 2.1501 };
  const answer = pathBetween(loopIndex, p, q);
  assert.ok(
    answer === null || answer.lengthM < 600,
    'never the 8 km way round',
  );
  assert.equal(pathBetween(index, a, a), null, 'no movement, no path');
});

test('the course to a point follows the track, and falls back to the straight bearing', () => {
  // Track runs east, then turns north; the target is north-east of the start.
  const index = createTrackIndex([
    { routes: null, paths: [[0, 0, 0.01, 0, 0.01, 0.01]] },
  ]);
  const along = courseAlongTrack(
    index,
    { lat: 0, lon: 0 },
    { lat: 0.01, lon: 0.01 },
  );
  assert.ok(Math.abs(along - 90) < 1, `east along the track, got ${along}`);
  const straight = courseAlongTrack(
    null,
    { lat: 0, lon: 0 },
    { lat: 0.01, lon: 0.01 },
  );
  assert.ok(
    Math.abs(straight - 45) < 1,
    `straight north-east, got ${straight}`,
  );
  assert.ok(
    Number.isNaN(
      courseAlongTrack(index, { lat: 0, lon: 0 }, { lat: 0, lon: 0 }),
    ),
  );
});
