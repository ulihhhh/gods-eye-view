import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_FORMATS,
  TRANSIT_MAX_MIN_INTERVAL_MS,
  TRANSIT_MAX_RETRY_AFTER_MS,
  TRANSIT_PROXY_TTL_MS,
  TransitFeedShapeError,
  applyStopNames,
  buildTransitSnapshot,
  transitCacheState,
  transitFeedTtlMs,
  transitFormatFor,
  transitResponseHeaders,
  transitRetryAfterMs,
  transitUpstreamHeaders,
} from './transitProxy.js';
import { TRANSIT_FEED_REGISTRY } from './transitFeeds.js';
import { decodeVehiclePositions } from './gtfsRealtime.js';
import { createTransitService } from '../sources/transitService.js';

test('a feed without a format is GTFS-Realtime, asked for protobuf', () => {
  assert.equal(transitFormatFor({}).decode, decodeVehiclePositions);
  assert.equal(transitFormatFor(null), TRANSIT_FORMATS['gtfs-rt']);
  assert.match(transitUpstreamHeaders({}).Accept, /x-protobuf/);
  assert.ok(Object.isFrozen(TRANSIT_FORMATS));
});

test('an unknown format is a shape fault, never a protobuf fallback', () => {
  for (const format of ['nope', 'toString', '__proto__', 'constructor']) {
    assert.throws(
      () => transitFormatFor({ format }),
      (error) =>
        error instanceof TransitFeedShapeError &&
        error.transitReason === 'format',
      format,
    );
    assert.throws(
      () => buildTransitSnapshot({ id: 'x', format }, new Uint8Array(), 1),
      TransitFeedShapeError,
    );
  }
});

test('every registered feed names a known format', () => {
  for (const feed of TRANSIT_FEED_REGISTRY) {
    assert.doesNotThrow(() => transitFormatFor(feed), feed.id);
  }
});

test('a feed minimum interval lengthens, and never shortens, its cache window', () => {
  assert.equal(transitFeedTtlMs({}), TRANSIT_PROXY_TTL_MS);
  assert.equal(
    transitFeedTtlMs({ minIntervalMs: 5_000 }),
    TRANSIT_PROXY_TTL_MS,
  );
  assert.equal(transitFeedTtlMs({ minIntervalMs: 60_000 }), 60_000);
  assert.equal(
    transitFeedTtlMs({ minIntervalMs: 24 * 3_600_000 }),
    TRANSIT_MAX_MIN_INTERVAL_MS,
  );
  for (const bad of [NaN, -1, '60000x', null]) {
    assert.equal(
      transitFeedTtlMs({ minIntervalMs: bad }),
      TRANSIT_PROXY_TTL_MS,
    );
  }
  const entry = { at: 1_000 };
  assert.equal(transitCacheState(entry, 1_000 + 30_000), 'stale');
  assert.equal(transitCacheState(entry, 1_000 + 30_000, 60_000), 'fresh');
  assert.equal(transitCacheState(entry, 1_000 + 61_000, 60_000), 'stale');
  assert.match(
    transitResponseHeaders('HIT', 'h', 1, 60_000)['Cache-Control'],
    /max-age=60$/,
  );
  assert.match(
    transitResponseHeaders('HIT')['Cache-Control'],
    new RegExp(`max-age=${TRANSIT_PROXY_TTL_MS / 1000}$`),
  );
});

test('Retry-After is read as seconds or a date, and capped', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  assert.equal(transitRetryAfterMs('120', now), 120_000);
  assert.equal(
    transitRetryAfterMs('Tue, 13 Oct 2026 10:02:00 GMT', now),
    120_000,
  );
  assert.equal(transitRetryAfterMs('999999', now), TRANSIT_MAX_RETRY_AFTER_MS);
  for (const bad of [null, '', 'soon', '-5', 'Mon, 12 Oct 2026 10:00:00 GMT']) {
    assert.equal(transitRetryAfterMs(bad, now), 0, String(bad));
  }
});

test('an operator answering 429 is left alone for at least a minute', async () => {
  const calls = [];
  const service = createTransitService({
    fetchImpl: async (url) => {
      calls.push(url);
      return new Response('slow down', {
        status: 429,
        headers: { 'Retry-After': '120' },
      });
    },
  });
  try {
    const get = () =>
      service.handle({
        url: 'http://localhost/api/transit/vehicles/renfe-ld',
        method: 'GET',
      });
    const first = await get();
    assert.equal(first.status, 502);
    const wait = Number(first.headers.get('Retry-After'));
    assert.ok(wait >= 119 && wait <= 120, `Retry-After ${wait}`);
    const second = await get();
    assert.equal(second.status, 503);
    assert.equal(second.headers.get('X-Transit-Backoff'), 'cooldown');
    assert.equal(calls.length, 1, 'the operator is not asked again');
  } finally {
    service.close();
  }
});

test('a station dictionary names known stops and leaves the rest as ids', () => {
  const names = Object.freeze({ PC: 'Pl. Catalunya', LONG: 'x'.repeat(121) });
  const vehicles = [
    { id: 'a', stopId: 'PC' },
    { id: 'b', stopId: 'ZZ' },
    { id: 'c', stopId: 'LONG' },
    { id: 'd', stopId: 'toString' },
    { id: 'e', stopId: '__proto__' },
    { id: 'f' },
  ];
  const named = applyStopNames(vehicles, names);
  assert.deepEqual(
    named.map((vehicle) => vehicle.stopName ?? null),
    ['Pl. Catalunya', null, null, null, null, null],
  );
  assert.equal(named[1], vehicles[1], 'an unnamed vehicle is passed through');
  assert.equal(applyStopNames(vehicles, null), vehicles);
});

test('a feed with stopNames loads its dictionary once and names every poll', async () => {
  const { SPAIN_TRANSIT_FEEDS } = await import('./transitFeedsSpain.js');
  for (const feed of SPAIN_TRANSIT_FEEDS) {
    assert.equal(typeof feed.stopNames, 'function', feed.id);
    const names = await feed.stopNames();
    assert.ok(Object.keys(names).length > 100, feed.id);
    assert.equal(await feed.stopNames(), names, 'loaded once, then shared');
  }
});
