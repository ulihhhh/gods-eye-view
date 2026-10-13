import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_BY_ID, GBFS_CITY_REGISTRY } from './registry.js';
import { SPAIN_GBFS_SYSTEMS } from './registrySpain.js';
import { isAllowedGbfsHost, isAllowedGbfsPath } from '../../data/gbfsSource.js';

test('Bicing and AMBici join the registry once each, after the existing systems', () => {
  const ids = GBFS_CITY_REGISTRY.map((city) => city.id);
  assert.deepEqual(ids.slice(-SPAIN_GBFS_SYSTEMS.length), [
    'barcelona-bicing',
    'barcelona-ambici',
  ]);
  assert.equal(new Set(ids).size, ids.length);
});

test('both Barcelona systems pass the proxy host and path allowlists', () => {
  for (const system of SPAIN_GBFS_SYSTEMS) {
    const city = CITY_BY_ID.get(system.id);
    assert.ok(city, system.id);
    for (const url of [city.stationInformationUrl, city.stationStatusUrl]) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:');
      assert.ok(isAllowedGbfsHost(parsed.hostname), parsed.hostname);
      assert.ok(isAllowedGbfsPath(parsed.pathname), parsed.pathname);
    }
  }
  assert.equal(CITY_BY_ID.get('barcelona-bicing').provider, 'Bicing');
  assert.equal(CITY_BY_ID.get('barcelona-ambici').provider, 'AMBici');
});

test('the nextbike allowance is exact, not a wildcard', () => {
  assert.equal(isAllowedGbfsHost('gbfs.nextbike.net'), true);
  assert.equal(isAllowedGbfsHost('evil.nextbike.net'), false);
  assert.equal(isAllowedGbfsHost('gbfs.nextbike.net.example'), false);
});
