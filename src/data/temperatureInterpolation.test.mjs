// src/data/temperatureInterpolation.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdwGrid } from './temperatureInterpolation.js';

test('grid dimensions: cellsY preserves bbox aspect ratio when not given explicitly', () => {
  const bbox = [0, 0, 10, 5]; // 10 wide, 5 tall -> half as tall as wide
  const grid = buildIdwGrid([{ lat: 2.5, lon: 5, value: 20 }], bbox, { cellsX: 100 });
  assert.equal(grid.cellsX, 100);
  assert.equal(grid.cellsY, 50);
  assert.equal(grid.values.length, 100 * 50);
});

test('a single station value dominates every cell (constant field)', () => {
  const bbox = [-1, -1, 1, 1];
  const grid = buildIdwGrid([{ lat: 0, lon: 0, value: 25 }], bbox, { cellsX: 20 });
  for (const v of grid.values) assert.ok(Math.abs(v - 25) < 1e-4);
});

test('row 0 is the NORTH edge, matching a canvas top-to-bottom orientation', () => {
  const bbox = [-1, -1, 1, 1];
  const grid = buildIdwGrid([
    { lat: 0.99, lon: 0, value: 0 }, // near north edge
    { lat: -0.99, lon: 0, value: 100 }, // near south edge
  ], bbox, { cellsX: 3, cellsY: 40, maxNeighbors: 1 });
  const topRowMid = grid.values[0 * 3 + 1];
  const bottomRowMid = grid.values[(40 - 1) * 3 + 1];
  assert.ok(topRowMid < 50, `top row should be closer to the cold northern station (got ${topRowMid})`);
  assert.ok(bottomRowMid > 50, `bottom row should be closer to the hot southern station (got ${bottomRowMid})`);
});

test('IDW averages two equidistant stations of different values to their midpoint', () => {
  const bbox = [-2, -1, 2, 1];
  const grid = buildIdwGrid([
    { lat: 0, lon: -1, value: 10 },
    { lat: 0, lon: 1, value: 30 },
  ], bbox, { cellsX: 41, cellsY: 1, maxNeighbors: 2 });
  const centerIdx = 20; // lon ≈ 0, equidistant from both stations
  assert.ok(Math.abs(grid.values[centerIdx] - 20) < 1, `center cell ≈ 20 (got ${grid.values[centerIdx]})`);
});

test('no stations produces an all-NaN grid, not a crash', () => {
  const grid = buildIdwGrid([], [-1, -1, 1, 1], { cellsX: 10 });
  assert.ok([...grid.values].every((v) => Number.isNaN(v)));
});

test('non-finite point values (missing readings) are dropped before interpolating', () => {
  const bbox = [-1, -1, 1, 1];
  const grid = buildIdwGrid([
    { lat: 0, lon: 0, value: NaN },
    { lat: 0.5, lon: 0.5, value: 15 },
  ], bbox, { cellsX: 10 });
  assert.ok([...grid.values].some((v) => Number.isFinite(v)));
});

test('a query exactly at a station returns that station\'s own value (no divide-by-zero blowup)', () => {
  const bbox = [-1, -1, 1, 1];
  // Odd cell count so a cell center can land exactly on the station coordinate.
  const grid = buildIdwGrid([
    { lat: 0, lon: 0, value: 42 },
    { lat: 0.9, lon: 0.9, value: -5 },
  ], bbox, { cellsX: 11, cellsY: 11 });
  const centerIdx = 5 * 11 + 5; // row 5, col 5 -> lon=0, lat=0 for an 11x11 grid over [-1,1]
  assert.ok(Math.abs(grid.values[centerIdx] - 42) < 1e-4, `got ${grid.values[centerIdx]}`);
});
