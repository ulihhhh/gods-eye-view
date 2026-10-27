// Fork-local layers (`za`–`zz` tokens) in the short share codec: their own
// bitset in field FORK_LAYER_STATE_FIELD, so they stay a few bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_STATE_REGISTRY,
  createDefaultLayerState,
} from '../data/layerState.js';
import {
  FORK_LAYER_STATE_FIELD,
  decodeShareView,
  encodeShareView,
  layerTokenNumber,
} from './viewCodec.js';
import { decodeBase64Url } from './wire.js';

const NOW_MS = Date.UTC(2026, 9, 27, 12, 0, 0);
const FORK_LAYER_IDS = LAYER_STATE_REGISTRY.filter((entry) =>
  /^z[a-z]$/.test(entry.token),
).map((entry) => entry.id);

function layerState(enabledLayerIds) {
  const state = createDefaultLayerState();
  state.enabledLayerIds = enabledLayerIds;
  return state;
}

function roundTrip(enabledLayerIds) {
  const code = encodeShareView({ layerState: layerState(enabledLayerIds) });
  const decoded = decodeShareView(code, { nowMs: NOW_MS });
  assert.equal(decoded.ok, true, decoded.reason);
  return { code, ids: decoded.state.layerState.enabledLayerIds };
}

test('every fork layer token falls in the fork bitset block', () => {
  assert.ok(FORK_LAYER_IDS.length > 0);
  for (const entry of LAYER_STATE_REGISTRY) {
    if (!FORK_LAYER_IDS.includes(entry.id)) continue;
    assert.ok(layerTokenNumber(entry.token) >= layerTokenNumber('za'));
  }
});

test('fork layers survive the round trip next to upstream ones', () => {
  const enabled = ['flights', ...FORK_LAYER_IDS];
  const { ids } = roundTrip(enabled);
  assert.deepEqual([...ids].sort(), [...enabled].sort());
});

test('a fork layer costs a few characters, not a 164-byte bitset', () => {
  const base = roundTrip(['flights']).code.length;
  for (const id of FORK_LAYER_IDS) {
    const { code } = roundTrip(['flights', id]);
    assert.ok(code.length - base <= 8, `${id}: ${code.length} vs ${base}`);
  }
  const all = roundTrip(['flights', ...FORK_LAYER_IDS]).code;
  assert.ok(all.length - base <= 10, `${all.length} vs ${base}`);
});

test('fork layers never touch field 10’s upstream bitset', () => {
  const { code } = roundTrip(FORK_LAYER_IDS);
  const bytes = decodeBase64Url(code);
  // Version byte, then field 10 (tag 0x52) with an empty bitset.
  assert.deepEqual([...bytes.subarray(1, 3)], [0x52, 0]);
  const forkTag = FORK_LAYER_STATE_FIELD * 8 + 2;
  assert.deepEqual(
    [...bytes.subarray(3, 5)],
    [(forkTag & 0x7f) | 0x80, forkTag >> 7],
  );
});
