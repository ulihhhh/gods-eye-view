// Local ADS-B receiver tap proxy (issue #57) — pure mechanics. All network
// access is injected; no real dump1090/readsb instance is involved. This is
// the mocked stand-in for hardware we don't have on hand yet (see
// docs/plans/local-usb-sdr.md, Phase 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCAL_ADSB_BASE_URL,
  fetchLocalAdsbSnapshot,
  mockLocalAdsbSnapshot,
  normalizeLocalAdsbAircraft,
  normalizeLocalAdsbSnapshot,
  resolveLocalAdsbRequest,
} from './localAdsbProxy.js';

function aircraftRow(overrides = {}) {
  return {
    hex: 'a1b2c3',
    flight: 'UAL123  ',
    lat: 30.2672,
    lon: -97.7431,
    alt_baro: 35000,
    track: 271.5,
    gs: 420,
    seen: 1.2,
    ...overrides,
  };
}

function jsonResponse(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

// ---------------------------------------------------------------------------
// normalizeLocalAdsbAircraft
// ---------------------------------------------------------------------------

test('normalizeLocalAdsbAircraft accepts a well-formed row and trims/lowercases identity', () => {
  const row = normalizeLocalAdsbAircraft(aircraftRow());
  assert.deepEqual(row, {
    hex: 'a1b2c3',
    flight: 'UAL123',
    lat: 30.2672,
    lon: -97.7431,
    altitudeFt: 35000,
    trackDeg: 271.5,
    groundSpeedKt: 420,
    seenS: 1.2,
  });
});

test('normalizeLocalAdsbAircraft maps alt_baro "ground" to altitude 0', () => {
  const row = normalizeLocalAdsbAircraft(aircraftRow({ alt_baro: 'ground' }));
  assert.equal(row.altitudeFt, 0);
});

test('normalizeLocalAdsbAircraft falls back to legacy altitude/speed field names', () => {
  const row = normalizeLocalAdsbAircraft(aircraftRow({ alt_baro: undefined, altitude: 12000, gs: undefined, speed: 200 }));
  assert.equal(row.altitudeFt, 12000);
  assert.equal(row.groundSpeedKt, 200);
});

test('normalizeLocalAdsbAircraft rejects a malformed or missing hex identity', () => {
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ hex: 'not-hex' })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ hex: '' })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ hex: undefined })), null);
});

test('normalizeLocalAdsbAircraft rejects an out-of-range or non-numeric position', () => {
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lat: 91 })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lon: -181 })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lat: 'nope' })), null);
});

test('normalizeLocalAdsbAircraft rejects non-object input', () => {
  assert.equal(normalizeLocalAdsbAircraft(null), null);
  assert.equal(normalizeLocalAdsbAircraft('a1b2c3'), null);
});

// ---------------------------------------------------------------------------
// normalizeLocalAdsbSnapshot
// ---------------------------------------------------------------------------

test('normalizeLocalAdsbSnapshot keeps only the valid rows and preserves receiver clock', () => {
  const snapshot = normalizeLocalAdsbSnapshot({
    now: 1_700_000_000,
    aircraft: [aircraftRow(), aircraftRow({ hex: 'bad' }), aircraftRow({ hex: 'd4e5f6' })],
  });
  assert.equal(snapshot.receiverNowS, 1_700_000_000);
  assert.equal(snapshot.aircraft.length, 2);
  assert.deepEqual(snapshot.aircraft.map((a) => a.hex), ['a1b2c3', 'd4e5f6']);
});

test('normalizeLocalAdsbSnapshot rejects a payload without an aircraft array', () => {
  assert.equal(normalizeLocalAdsbSnapshot({ now: 1 }), null);
  assert.equal(normalizeLocalAdsbSnapshot([aircraftRow()]), null);
  assert.equal(normalizeLocalAdsbSnapshot(null), null);
});

test('normalizeLocalAdsbSnapshot caps the aircraft count', () => {
  const many = Array.from({ length: 600 }, (_, i) => aircraftRow({
    hex: i.toString(16).padStart(6, '0'),
  }));
  const snapshot = normalizeLocalAdsbSnapshot({ aircraft: many });
  assert.equal(snapshot.aircraft.length, 500);
});

// ---------------------------------------------------------------------------
// mockLocalAdsbSnapshot
// ---------------------------------------------------------------------------

test('mockLocalAdsbSnapshot is a valid raw aircraft.json body — every row survives normalization', () => {
  const raw = mockLocalAdsbSnapshot(() => 1_700_000_000_000);
  assert.equal(raw.now, 1_700_000_000);
  assert.ok(raw.aircraft.length >= 3, 'demo fixture should show more than one dot');
  const normalized = normalizeLocalAdsbSnapshot(raw);
  assert.ok(normalized, 'mock fixture must be a recognizable aircraft.json payload');
  assert.equal(normalized.aircraft.length, raw.aircraft.length, 'every mock row must itself be valid');
  assert.equal(normalized.receiverNowS, 1_700_000_000);
  // The 'ground' row exercises the same alt_baro:'ground' → 0 mapping a real
  // grounded aircraft would.
  assert.ok(normalized.aircraft.some((a) => a.altitudeFt === 0));
});

// ---------------------------------------------------------------------------
// fetchLocalAdsbSnapshot
// ---------------------------------------------------------------------------

test('fetchLocalAdsbSnapshot builds the tar1090/dump1090 aircraft.json URL and parses it', async () => {
  const calls = [];
  const snapshot = await fetchLocalAdsbSnapshot({
    baseUrl: 'http://192.168.1.50:8080/',
    fetchImpl: async (url, opts) => {
      calls.push([url, opts]);
      return jsonResponse({ now: 5, aircraft: [aircraftRow()] });
    },
    makeSignal: () => 'signal',
  });
  assert.equal(calls[0][0], 'http://192.168.1.50:8080/data/aircraft.json');
  assert.equal(snapshot.aircraft.length, 1);
});

test('fetchLocalAdsbSnapshot reports "unreachable" on a network/transport failure', async () => {
  await assert.rejects(
    fetchLocalAdsbSnapshot({
      baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    }),
    (error) => error.reason === 'unreachable',
  );
});

test('fetchLocalAdsbSnapshot reports "http_error" on a non-2xx response', async () => {
  await assert.rejects(
    fetchLocalAdsbSnapshot({
      baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
      fetchImpl: async () => jsonResponse({}, false, 404),
    }),
    (error) => error.reason === 'http_error',
  );
});

test('fetchLocalAdsbSnapshot reports "malformed" on invalid JSON or a non-aircraft.json body', async () => {
  await assert.rejects(
    fetchLocalAdsbSnapshot({
      baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    }),
    (error) => error.reason === 'malformed',
  );
  await assert.rejects(
    fetchLocalAdsbSnapshot({
      baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
      fetchImpl: async () => jsonResponse({ hello: 'world' }),
    }),
    (error) => error.reason === 'malformed',
  );
});

// ---------------------------------------------------------------------------
// resolveLocalAdsbRequest
// ---------------------------------------------------------------------------

test('resolveLocalAdsbRequest serves a fresh cache entry without refetching', async () => {
  const cache = new Map([[DEFAULT_LOCAL_ADSB_BASE_URL, { at: 1000, snapshot: { receiverNowS: 1, aircraft: [] } }]]);
  let fetchCount = 0;
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 1500,
    ttlMs: 2000,
    fetchSnapshot: async () => { fetchCount += 1; return { receiverNowS: 2, aircraft: [] }; },
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.status, 200);
  assert.equal(result.body.stale, false);
  assert.equal(result.body.receiverNowS, 1);
});

test('resolveLocalAdsbRequest refetches an expired entry and updates the cache', async () => {
  const cache = new Map([[DEFAULT_LOCAL_ADSB_BASE_URL, { at: 0, snapshot: { receiverNowS: 1, aircraft: [] } }]]);
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 5000,
    ttlMs: 2000,
    fetchSnapshot: async () => ({ receiverNowS: 9, aircraft: [aircraftRow()] }),
  });
  assert.equal(result.body.receiverNowS, 9);
  assert.equal(cache.get(DEFAULT_LOCAL_ADSB_BASE_URL).snapshot.receiverNowS, 9);
});

test('resolveLocalAdsbRequest falls back to a stale cached snapshot on fetch failure', async () => {
  const cache = new Map([[DEFAULT_LOCAL_ADSB_BASE_URL, { at: 0, snapshot: { receiverNowS: 1, aircraft: [aircraftRow()] } }]]);
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 5000,
    ttlMs: 2000,
    fetchSnapshot: async () => { const e = new Error('down'); e.reason = 'unreachable'; throw e; },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.stale, true);
  assert.equal(result.body.aircraft.length, 1);
});

test('resolveLocalAdsbRequest reports failure honestly when there is no cache to fall back on', async () => {
  const cache = new Map();
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 5000,
    fetchSnapshot: async () => { const e = new Error('down'); e.reason = 'unreachable'; throw e; },
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'unreachable');
  assert.equal(result.body.baseUrl, DEFAULT_LOCAL_ADSB_BASE_URL);
});
