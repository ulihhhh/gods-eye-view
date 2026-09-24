// Local ADS-B receiver tap proxy (issue #57) — pure mechanics. All network
// access is injected; no real dump1090/readsb instance is involved. This is
// the mocked stand-in for hardware we don't have on hand yet (see
// docs/plans/local-usb-sdr.md, Phase 0).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalAdsbTrace,
  DEFAULT_LOCAL_ADSB_BASE_URL,
  fetchLocalAdsbSnapshot,
  localReceiverPosition,
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

test('normalizeLocalAdsbAircraft keeps a readsb-shaped row and trims/lowercases identity', () => {
  const row = normalizeLocalAdsbAircraft(aircraftRow({ hex: 'A1B2C3' }));
  assert.deepEqual(row, {
    hex: 'a1b2c3',
    flight: 'UAL123',
    lat: 30.2672,
    lon: -97.7431,
    alt_baro: 35000,
    track: 271.5,
    gs: 420,
    seen: 1.2,
  });
});

test('normalizeLocalAdsbAircraft passes through whitelisted, type-checked extras only', () => {
  const row = normalizeLocalAdsbAircraft(
    aircraftRow({
      squawk: '7700',
      emergency: 'general',
      category: 'A3',
      baro_rate: -1408,
      nav_altitude_mcp: 36992,
      rssi: -21.2,
      seen_pos: 0.4,
      evil: '<script>',
      mlat: ['lat'],
    }),
  );
  assert.equal(row.squawk, '7700');
  assert.equal(row.emergency, 'general');
  assert.equal(row.category, 'A3');
  assert.equal(row.baro_rate, -1408);
  assert.equal(row.nav_altitude_mcp, 36992);
  assert.equal(row.rssi, -21.2);
  assert.equal(row.seen_pos, 0.4);
  assert.equal('evil' in row, false);
  assert.equal('mlat' in row, false);
  const junk = normalizeLocalAdsbAircraft(
    aircraftRow({ squawk: '9999', category: 'Z9', rssi: 'x' }),
  );
  assert.equal('squawk' in junk, false);
  assert.equal('category' in junk, false);
  assert.equal('rssi' in junk, false);
});

test('normalizeLocalAdsbAircraft keeps alt_baro "ground" for the shared readsb normalizer', () => {
  const row = normalizeLocalAdsbAircraft(aircraftRow({ alt_baro: 'ground' }));
  assert.equal(row.alt_baro, 'ground');
});

test('normalizeLocalAdsbAircraft falls back to legacy altitude/speed field names', () => {
  const row = normalizeLocalAdsbAircraft(
    aircraftRow({
      alt_baro: undefined,
      altitude: 12000,
      gs: undefined,
      speed: 200,
    }),
  );
  assert.equal(row.alt_baro, 12000);
  assert.equal(row.gs, 200);
});

test('normalizeLocalAdsbAircraft rejects a malformed or missing hex identity', () => {
  assert.equal(
    normalizeLocalAdsbAircraft(aircraftRow({ hex: 'not-hex' })),
    null,
  );
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ hex: '' })), null);
  assert.equal(
    normalizeLocalAdsbAircraft(aircraftRow({ hex: undefined })),
    null,
  );
});

test('normalizeLocalAdsbAircraft rejects an out-of-range, missing or non-numeric position', () => {
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lat: 91 })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lon: -181 })), null);
  assert.equal(normalizeLocalAdsbAircraft(aircraftRow({ lat: 'nope' })), null);
  assert.equal(
    normalizeLocalAdsbAircraft(aircraftRow({ lat: undefined, lon: undefined })),
    null,
  );
});

test('normalizeLocalAdsbAircraft rejects non-object input', () => {
  assert.equal(normalizeLocalAdsbAircraft(null), null);
  assert.equal(normalizeLocalAdsbAircraft('a1b2c3'), null);
});

// ---------------------------------------------------------------------------
// normalizeLocalAdsbSnapshot
// ---------------------------------------------------------------------------

test('normalizeLocalAdsbSnapshot plots positioned rows, counts every heard contact, keeps receiver clock', () => {
  const snapshot = normalizeLocalAdsbSnapshot({
    now: 1_700_000_000,
    aircraft: [
      aircraftRow(),
      aircraftRow({ hex: 'bad' }),
      aircraftRow({ hex: 'd4e5f6' }),
      { hex: '0a0b0c', alt_baro: 17175, squawk: '1000' }, // Mode-S only, no position
    ],
  });
  assert.equal(snapshot.receiverNowS, 1_700_000_000);
  assert.equal(snapshot.now, 1_700_000_000);
  assert.equal(snapshot.heard, 3);
  assert.deepEqual(
    snapshot.ac.map((a) => a.hex),
    ['a1b2c3', 'd4e5f6'],
  );
});

test('normalizeLocalAdsbSnapshot rejects a payload without an aircraft array', () => {
  assert.equal(normalizeLocalAdsbSnapshot({ now: 1 }), null);
  assert.equal(normalizeLocalAdsbSnapshot([aircraftRow()]), null);
  assert.equal(normalizeLocalAdsbSnapshot(null), null);
});

test('normalizeLocalAdsbSnapshot caps the plotted aircraft count', () => {
  const many = Array.from({ length: 600 }, (_, i) =>
    aircraftRow({
      hex: i.toString(16).padStart(6, '0'),
    }),
  );
  const snapshot = normalizeLocalAdsbSnapshot({ aircraft: many });
  assert.equal(snapshot.ac.length, 500);
  assert.equal(snapshot.heard, 600);
});

// ---------------------------------------------------------------------------
// buildLocalAdsbTrace / localReceiverPosition
// ---------------------------------------------------------------------------

test('buildLocalAdsbTrace orders history fixes oldest first as a readsb trace', () => {
  const bodies = [
    { now: 1000, aircraft: [aircraftRow({ lat: 41.3, seen_pos: 2 })] },
    {
      now: 940,
      aircraft: [
        aircraftRow({ lat: 41.1, alt_baro: 'ground' }),
        aircraftRow({ hex: 'ffffff' }),
      ],
    },
    { now: 970, aircraft: [aircraftRow({ hex: 'eeeeee' })] },
    { nope: true },
  ];
  assert.deepEqual(buildLocalAdsbTrace(bodies, 'A1B2C3'), {
    timestamp: 940,
    trace: [
      [0, 41.1, -97.7431, 'ground'],
      [58, 41.3, -97.7431, 35000],
    ],
  });
  assert.deepEqual(buildLocalAdsbTrace(bodies, '123456'), {
    timestamp: 0,
    trace: [],
  });
  assert.equal(buildLocalAdsbTrace(bodies, '../etc'), null);
});

test('localReceiverPosition reads dump1090 --lat/--lon from receiver.json', () => {
  assert.deepEqual(localReceiverPosition({ lat: 41.4, lon: 2.1, history: 3 }), {
    lat: 41.4,
    lon: 2.1,
  });
  assert.equal(localReceiverPosition({ history: 3 }), null);
  assert.equal(localReceiverPosition({ lat: 99, lon: 2 }), null);
});

// ---------------------------------------------------------------------------
// mockLocalAdsbSnapshot
// ---------------------------------------------------------------------------

test('mockLocalAdsbSnapshot is a valid raw aircraft.json body — every row survives normalization', () => {
  const raw = mockLocalAdsbSnapshot(() => 1_700_000_000_000);
  assert.equal(raw.now, 1_700_000_000);
  assert.ok(
    raw.aircraft.length >= 3,
    'demo fixture should show more than one aircraft',
  );
  const normalized = normalizeLocalAdsbSnapshot(raw);
  assert.ok(
    normalized,
    'mock fixture must be a recognizable aircraft.json payload',
  );
  assert.equal(
    normalized.ac.length,
    raw.aircraft.length,
    'every mock row must itself be valid',
  );
  assert.equal(normalized.receiverNowS, 1_700_000_000);
  assert.ok(normalized.ac.some((a) => a.alt_baro === 'ground'));
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
  assert.equal(snapshot.ac.length, 1);
});

test('fetchLocalAdsbSnapshot reports "unreachable" on a network/transport failure', async () => {
  await assert.rejects(
    fetchLocalAdsbSnapshot({
      baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
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
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
      }),
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
  const cache = new Map([
    [
      DEFAULT_LOCAL_ADSB_BASE_URL,
      { at: 1000, snapshot: { receiverNowS: 1, aircraft: [] } },
    ],
  ]);
  let fetchCount = 0;
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 1500,
    ttlMs: 2000,
    fetchSnapshot: async () => {
      fetchCount += 1;
      return { receiverNowS: 2, aircraft: [] };
    },
  });
  assert.equal(fetchCount, 0);
  assert.equal(result.status, 200);
  assert.equal(result.body.stale, false);
  assert.equal(result.body.receiverNowS, 1);
});

test('resolveLocalAdsbRequest refetches an expired entry and updates the cache', async () => {
  const cache = new Map([
    [
      DEFAULT_LOCAL_ADSB_BASE_URL,
      { at: 0, snapshot: { receiverNowS: 1, aircraft: [] } },
    ],
  ]);
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
  const cache = new Map([
    [
      DEFAULT_LOCAL_ADSB_BASE_URL,
      { at: 0, snapshot: { receiverNowS: 1, ac: [aircraftRow()] } },
    ],
  ]);
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 5000,
    ttlMs: 2000,
    fetchSnapshot: async () => {
      const e = new Error('down');
      e.reason = 'unreachable';
      throw e;
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.stale, true);
  assert.equal(result.body.ac.length, 1);
});

test('resolveLocalAdsbRequest reports failure honestly when there is no cache to fall back on', async () => {
  const cache = new Map();
  const result = await resolveLocalAdsbRequest({
    cache,
    baseUrl: DEFAULT_LOCAL_ADSB_BASE_URL,
    now: () => 5000,
    fetchSnapshot: async () => {
      const e = new Error('down');
      e.reason = 'unreachable';
      throw e;
    },
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'unreachable');
  assert.equal(result.body.baseUrl, DEFAULT_LOCAL_ADSB_BASE_URL);
});
