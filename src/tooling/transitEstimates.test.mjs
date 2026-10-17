import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TMB_METRO_ESTIMATE_STALE_MS,
  TMB_METRO_ESTIMATE_TTL_MS,
  createTmbMetroEstimator,
  tmbMetroNetworkUrl,
} from '../../server/providers/tmb.js';
import { transitEstimatesEnabled } from '../../server/providers/transit.js';
import { createTransitService } from '../sources/transitService.js';
import { getTransitFeed } from '../data/transitFeeds.js';

const PAIR = { TMB_APP_ID: 'fixture-id', TMB_APP_KEY: 'fixture-secret' };
const T0 = Date.UTC(2026, 9, 17, 10, 12, 0);

/** Three L3 stations north to south. */
const NETWORK = {
  type: 'FeatureCollection',
  features: [
    [301, 1, 'Uno', 41.42],
    [302, 2, 'Dos', 41.41],
    [303, 3, 'Tres', 41.4],
  ].map(([code, order, name, lat]) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [2.17, lat] },
    properties: {
      CODI_ESTACIO: code,
      NOM_ESTACIO: name,
      NOM_LINIA: 'L3',
      ORDRE_ESTACIO: order,
    },
  })),
};

/** Train 307 due at Dos in 40 s and Tres in 130 s, southbound on track 1. */
function imetro(at) {
  const station = (code, eta) => ({
    codi_via: 1,
    codi_estacio: code,
    linies_trajectes: [
      {
        nom_linia: 'L3',
        desti_trajecte: 'Tres',
        propers_trens: [{ codi_servei: '307', temps_arribada: at + eta }],
      },
    ],
  });
  return {
    timestamp: at,
    linies: [
      {
        nom_linia: 'L3',
        estacions: [station(302, 40_000), station(303, 130_000)],
      },
    ],
  };
}

function fakeTmb({ clock, imetroStatus = () => 200 }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/transit/linies/metro/estacions'))
      return new Response(JSON.stringify(NETWORK), { status: 200 });
    const status = imetroStatus(calls.length);
    if (status === 'throw') throw new Error('network down');
    return new Response(JSON.stringify(imetro(clock.t)), { status });
  };
  return { fetchImpl, calls };
}

test('the network URL asks only the fields the estimator needs, with the key', () => {
  const url = new URL(
    tmbMetroNetworkUrl({ appId: 'fixture-id', appKey: 'fixture-secret' }),
  );
  assert.equal(url.pathname, '/v1/transit/linies/metro/estacions');
  assert.match(url.searchParams.get('propertyName'), /ORDRE_ESTACIO/);
  assert.equal(url.searchParams.get('app_key'), 'fixture-secret');
});

test('the estimator is unavailable without the key pair', async () => {
  const estimator = createTmbMetroEstimator({ env: {} });
  assert.equal(estimator.available(), false);
  await assert.rejects(estimator.estimate({ now: T0 }), { code: 'no_key' });
});

test('one iMetro request for the whole network, reused for the TTL', async () => {
  const clock = { t: T0 };
  const { fetchImpl, calls } = fakeTmb({ clock });
  const estimator = createTmbMetroEstimator({
    env: PAIR,
    fetchImpl,
    now: () => clock.t,
  });
  assert.equal(estimator.available(), true);
  const first = await estimator.estimate({ now: clock.t });
  assert.equal(first.vehicles.length, 1);
  const [train] = first.vehicles;
  assert.equal(train.id, 'L3-307');
  assert.equal(train.estimated, true);
  assert.equal(train.status, 'IN_TRANSIT_TO');
  assert.equal(train.stopName, 'Dos');
  assert.equal(train.destination, 'Tres');
  const imetroCalls = () =>
    calls.filter((call) => call.url.includes('/itransit/metro/estacions'));
  assert.equal(imetroCalls().length, 1);
  const codes = new URL(imetroCalls()[0].url).searchParams.get('estacions');
  assert.equal(codes, '301,302,303');
  assert.equal(imetroCalls()[0].init.redirect, 'error');
  // Within the TTL the same answer moves the train on, without asking.
  clock.t += 10_000;
  const later = await estimator.estimate({ now: clock.t });
  assert.equal(imetroCalls().length, 1);
  assert.ok(later.vehicles[0].lat < train.lat, 'moved south');
  clock.t += TMB_METRO_ESTIMATE_TTL_MS;
  await estimator.estimate({ now: clock.t });
  assert.equal(imetroCalls().length, 2);
});

test('a failed refresh keeps estimating from the last answer for a while', async () => {
  const clock = { t: T0 };
  let failing = false;
  const { fetchImpl } = fakeTmb({
    clock,
    imetroStatus: () => (failing ? 'throw' : 200),
  });
  const estimator = createTmbMetroEstimator({
    env: PAIR,
    fetchImpl,
    now: () => clock.t,
  });
  const first = await estimator.estimate({ now: clock.t });
  failing = true;
  clock.t += TMB_METRO_ESTIMATE_TTL_MS + 1;
  const stale = await estimator.estimate({ now: clock.t });
  assert.equal(stale.sourceFetchedAt, first.sourceFetchedAt);
  clock.t = T0 + TMB_METRO_ESTIMATE_STALE_MS + 1;
  await assert.rejects(estimator.estimate({ now: clock.t }));
});

test('a refused key is never covered by the last answer', async () => {
  const clock = { t: T0 };
  let refused = false;
  const { fetchImpl } = fakeTmb({
    clock,
    imetroStatus: () => (refused ? 401 : 200),
  });
  const estimator = createTmbMetroEstimator({
    env: PAIR,
    fetchImpl,
    now: () => clock.t,
  });
  await estimator.estimate({ now: clock.t });
  refused = true;
  clock.t += TMB_METRO_ESTIMATE_TTL_MS + 1;
  await assert.rejects(estimator.estimate({ now: clock.t }), {
    code: 'rejected',
  });
});

test('estimates can be switched off as a whole', () => {
  assert.equal(transitEstimatesEnabled({}), true);
  assert.equal(
    transitEstimatesEnabled({ TRANSIT_ESTIMATED_POSITIONS: ' OFF ' }),
    false,
  );
});

function serviceWith(estimator) {
  return createTransitService({
    fetchImpl: async () => {
      throw new Error('an estimated feed must never be fetched');
    },
    estimators: estimator ? { 'tmb-metro': estimator } : {},
  });
}

async function get(service, path) {
  return service.handle(new Request(`http://localhost/api/transit${path}`));
}

test('the estimated row is offered only while its estimator is available', async () => {
  const feed = getTransitFeed('tmb-metro-estimated');
  assert.equal(feed.estimate, 'tmb-metro');
  let available = false;
  const service = serviceWith({
    available: () => available,
    estimate: async () => ({ timestamp: null, vehicles: [] }),
  });
  const ids = async () =>
    (await (await get(service, '/feeds')).json()).feeds.map((row) => row.id);
  assert.equal((await ids()).includes('tmb-metro-estimated'), false);
  assert.equal(
    (await get(service, '/vehicles/tmb-metro-estimated')).status,
    404,
  );
  available = true;
  assert.equal((await ids()).includes('tmb-metro-estimated'), true);
  assert.equal((await ids()).includes('mbta'), true, 'other feeds untouched');
  service.close();
  // Without any estimator wired (another server), the row never appears.
  const bare = serviceWith(null);
  assert.equal(
    (await (await get(bare, '/feeds')).json()).feeds.some(
      (row) => row.id === 'tmb-metro-estimated',
    ),
    false,
  );
  bare.close();
});

test('an estimated snapshot goes through the same cache and shape as a fetched one', async () => {
  let calls = 0;
  const service = serviceWith({
    available: () => true,
    host: 'api.tmb.cat',
    estimate: async ({ now }) => {
      calls += 1;
      return {
        timestamp: Math.floor(now / 1000),
        sourceFetchedAt: now - 5_000,
        vehicles: [
          {
            id: 'L3-307',
            lat: 41.405,
            lon: 2.17,
            bearing: 180,
            speedMps: null,
            timestamp: Math.floor(now / 1000),
            routeId: 'L3',
            tripId: '307',
            directionId: null,
            label: '307',
            stopId: '303',
            status: 'IN_TRANSIT_TO',
            occupancy: null,
            stopName: 'Tres',
            estimated: true,
            estimatedFrom: 'predictions',
          },
        ],
      };
    },
  });
  const response = await get(service, '/vehicles/tmb-metro-estimated');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.feedId, 'tmb-metro-estimated');
  assert.equal(body.count, 1);
  assert.equal(body.vehicles[0].estimated, true);
  assert.equal(body.vehicles[0].timestampSource, 'vehicle');
  await get(service, '/vehicles/tmb-metro-estimated');
  assert.equal(calls, 1, 'the second request is served from cache');
  // The history keeps estimates like any fix, so the trail route works.
  const trail = await get(service, '/trail/tmb-metro-estimated/L3-307');
  assert.equal(trail.status, 200);
  service.close();
});

test('a failing estimator is an unavailable feed, with backoff', async () => {
  const service = serviceWith({
    available: () => true,
    estimate: async () => {
      throw new Error('TMB unavailable');
    },
  });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const response = await get(service, '/vehicles/tmb-metro-estimated');
    assert.ok(response.status >= 500);
    const again = await get(service, '/vehicles/tmb-metro-estimated');
    assert.equal(again.headers.get('X-Transit-Backoff'), 'cooldown');
  } finally {
    console.warn = warn;
    service.close();
  }
});
