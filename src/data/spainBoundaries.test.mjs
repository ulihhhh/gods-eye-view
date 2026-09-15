// src/data/spainBoundaries.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCcaaFeatures, getSpainBbox } from './spainBoundaries.js';

test('loads all 19 CCAA/ciudad-autónoma features with id, name, and ring geometry', async () => {
  const features = await getCcaaFeatures();
  assert.equal(features.length, 19);
  for (const feature of features) {
    assert.equal(typeof feature.id, 'string');
    assert.ok(feature.id.length > 0);
    assert.equal(typeof feature.name, 'string');
    assert.ok(Array.isArray(feature.rings) && feature.rings.length > 0);
    for (const ring of feature.rings) {
      assert.ok(ring.length >= 3, `${feature.id} ring has at least 3 points`);
      for (const [lon, lat] of ring) {
        assert.ok(Number.isFinite(lon) && Math.abs(lon) <= 180);
        assert.ok(Number.isFinite(lat) && Math.abs(lat) <= 90);
      }
    }
  }
  const ids = features.map((f) => f.id);
  assert.ok(ids.includes('madrid'));
  assert.ok(ids.includes('canarias'));
  assert.ok(ids.includes('ceuta'));
  assert.ok(ids.includes('melilla'));
  // no duplicate ids
  assert.equal(new Set(ids).size, ids.length);
});

test('bbox covers mainland Spain, the Canaries, and stays within real-world bounds', async () => {
  const [west, south, east, north] = await getSpainBbox();
  // Canarias pulls the west edge out past -18°; mainland's east edge is a bit past 4°.
  assert.ok(west < -17 && west > -19, `west ≈ -18 (got ${west})`);
  assert.ok(east > 3 && east < 5, `east ≈ 4 (got ${east})`);
  assert.ok(south > 27 && south < 29, `south ≈ 28 (got ${south})`);
  assert.ok(north > 43 && north < 45, `north ≈ 44 (got ${north})`);
});

test('repeated calls return the same cached array (loaded once)', async () => {
  const a = await getCcaaFeatures();
  const b = await getCcaaFeatures();
  assert.equal(a, b);
});
