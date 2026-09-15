// src/data/ringSmoothing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catmullRomSmoothRing } from './ringSmoothing.js';

// A closed square ring (GeoJSON convention: first point repeats as last).
const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

test('output stays closed (first point === last point)', () => {
  const out = catmullRomSmoothRing(SQUARE, 4);
  assert.deepEqual(out[0], out[out.length - 1]);
});

test('the curve passes exactly through every original vertex', () => {
  const subdivisions = 5;
  const out = catmullRomSmoothRing(SQUARE, subdivisions);
  // Each original vertex lands at index i*subdivisions in the output.
  const originals = SQUARE.slice(0, -1);
  for (let i = 0; i < originals.length; i++) {
    const [ox, oy] = originals[i];
    const [x, y] = out[i * subdivisions];
    assert.ok(Math.abs(x - ox) < 1e-9 && Math.abs(y - oy) < 1e-9, `vertex ${i} preserved exactly`);
  }
});

test('densifies by the requested subdivision factor', () => {
  const out4 = catmullRomSmoothRing(SQUARE, 4);
  const out8 = catmullRomSmoothRing(SQUARE, 8);
  // 4 original edges * subdivisions, plus the re-closing point.
  assert.equal(out4.length, 4 * 4 + 1);
  assert.equal(out8.length, 4 * 8 + 1);
});

test('rings with fewer than 4 distinct points are returned unchanged', () => {
  const triangle = [[0, 0], [1, 0], [0, 1], [0, 0]]; // 3 distinct points
  const out = catmullRomSmoothRing(triangle, 6);
  assert.equal(out, triangle);
});

test('non-array or degenerate input is returned unchanged rather than throwing', () => {
  assert.equal(catmullRomSmoothRing(null, 6), null);
  assert.equal(catmullRomSmoothRing(undefined, 6), undefined);
  assert.equal(catmullRomSmoothRing(SQUARE, 0), SQUARE);
});

test('an already-open ring (no repeated closing point) is still handled correctly', () => {
  const open = SQUARE.slice(0, -1); // no closing duplicate
  const out = catmullRomSmoothRing(open, 3);
  assert.deepEqual(out[0], out[out.length - 1]);
  assert.equal(out.length, 4 * 3 + 1);
});
